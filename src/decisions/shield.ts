import { plannerMove } from "./planner";
import type {
  DecisionClient,
  DecisionOutcome,
  DecisionResult,
  Move,
  PongState,
  Source,
} from "./types";

/**
 * 1000ms. Earlier this was 400ms on the (wrong) assumption that a tighter
 * deadline just meant "more shield interventions, still honest." It
 * doesn't - CPU-only Laya inference measured a consistent ~900-940ms per
 * call, so 400ms didn't make Laya's real answers *rare*, it made them
 * *mathematically impossible*: 900ms never fits inside a 400ms window, on
 * any run, ever. That's not the speed/accuracy tradeoff this benchmark
 * exists to show - it's a config value that silently made one whole side
 * of the comparison unobservable.
 *
 * Since getMove() now tracks the ball live while "covering" (see the
 * `covering` field below) regardless of how long the deadline is, the
 * deadline no longer controls how smooth gameplay looks - only how often a
 * *real* decision gets a chance to land before the shield covers for it.
 * That means it's safe to set this loose enough for typical hardware:
 * ~150-500ms measured for Jev's real hosted latency, ~900-940ms for
 * CPU-only Laya. 1000ms gives Jev room to basically always land a real
 * answer, and Laya just enough headroom to land one often (not always -
 * still genuinely tight on CPU, which is itself the honest finding: local
 * inference is close but not free of real latency cost without GPU/MLX
 * acceleration). Lower this back down if you want to see interventions
 * happen more, or raise it further on slower hardware.
 */
export const DEFAULT_ACT_DEADLINE_MS = 1000;

export interface ShieldEvent {
  source: Source;
  timestamp: number;
  /** the move actually committed to the paddle this cycle */
  committedMove: Move;
  /** the move the deterministic planner would have made, for agreement tracking */
  plannerMove: Move;
  /** present only when a real model decision arrived in time */
  decision: DecisionResult | null;
  /** true when the shield (or, unassisted, a stale hold) supplied the move instead of the model */
  shieldIntervened: boolean;
  outcome: DecisionOutcome | { ok: false; reason: "unassisted-late"; detail: string };
}

export type ShieldListener = (event: ShieldEvent) => void;

/**
 * Runs one paddle's continuous decide -> commit cycle: fire a decision
 * request, race it against an act-deadline, and either commit the model's
 * move or (assisted mode) fall back to the deterministic planner — logged
 * as a shield intervention, never as a model decision (CLAUDE.md §7).
 *
 * The network/inference call is rate-limited (single-flight, paced retries
 * on failure - see waitOutCyclePacing) since it costs something real to
 * make. The *paddle*, in assisted mode, is not: getMove() is called every
 * physics tick and, while "covering" for a model that hasn't answered yet,
 * recomputes the planner's move fresh each time against the current ball
 * position rather than replaying a stale snapshot from whenever the last
 * cycle happened to resolve. Conflating those two paces was a real bug
 * caught by actually playing the game - it made even the "safe" fallback
 * look laggy, for no reason, since the planner has no real latency to pace.
 *
 * In unassisted mode a late decision does NOT get a planner fallback: the
 * paddle simply holds its last committed move until the model actually
 * answers, exposing the model's raw, unprotected latency/accuracy.
 */
export class Shield {
  private currentMove: Move = "stay";
  /**
   * True whenever there's no fresh-enough real decision to act on (still
   * waiting on the first one ever, or the last cycle missed its deadline).
   * While covering, getMove() recomputes the planner's move live against
   * the *current* state on every call, not a stale snapshot from whenever
   * the cycle last resolved - the planner is a synchronous, free local
   * computation, so there's no reason its answer should be any less fresh
   * than the physics tick calling getMove(). Only real model decisions are
   * inherently rate-limited by network/inference latency.
   */
  private covering = true;
  private running = false;
  private cycleActive = false;

  constructor(
    private readonly client: DecisionClient,
    private readonly getState: () => PongState,
    private readonly onEvent: ShieldListener,
    private assisted = true,
    private actDeadlineMs = DEFAULT_ACT_DEADLINE_MS,
    /** fired the instant a decide() request goes out, for a live "requests in flight" gauge */
    private readonly onRequestStart?: (source: Source) => void,
  ) {}

  getMove(): Move {
    if (this.covering && this.assisted) {
      return plannerMove(this.getState());
    }
    return this.currentMove;
  }

  setAssisted(assisted: boolean): void {
    this.assisted = assisted;
  }

  setActDeadlineMs(ms: number): void {
    this.actDeadlineMs = ms;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.runLoop();
  }

  stop(): void {
    this.running = false;
  }

  private async runLoop(): Promise<void> {
    while (this.running) {
      await this.runOneCycle();
    }
  }

  private async runOneCycle(): Promise<void> {
    if (this.cycleActive) return;
    this.cycleActive = true;
    const cycleStart = performance.now();
    const state = this.getState();
    const ground = plannerMove(state);
    const controller = new AbortController();
    const deadline = new Promise<"deadline">((resolve) => {
      setTimeout(() => resolve("deadline"), this.actDeadlineMs);
    });

    this.onRequestStart?.(this.client.source);
    const decidePromise = this.client.decide(state, controller.signal);
    const race = await Promise.race([decidePromise, deadline]);

    if (race === "deadline") {
      if (this.assisted) {
        this.covering = true;
        this.emit({
          source: this.client.source,
          timestamp: Date.now(),
          committedMove: ground,
          plannerMove: ground,
          decision: null,
          shieldIntervened: true,
          outcome: {
            ok: false,
            reason: "timeout",
            detail: `no decision within ${this.actDeadlineMs}ms`,
          },
        });
      } else {
        this.emit({
          source: this.client.source,
          timestamp: Date.now(),
          committedMove: this.currentMove,
          plannerMove: ground,
          decision: null,
          shieldIntervened: false,
          outcome: {
            ok: false,
            reason: "unassisted-late",
            detail: "holding last move, no shield fallback",
          },
        });
      }
      // wait for the aborted request to actually settle before allowing the
      // next cycle, so we never have two in-flight decides for one paddle.
      controller.abort();
      await decidePromise.catch(() => undefined);
      await this.waitOutCyclePacing(cycleStart);
      this.cycleActive = false;
      return;
    }

    const outcome = race;
    if (outcome.ok) {
      this.currentMove = outcome.result.choice;
      this.covering = false;
      this.emit({
        source: this.client.source,
        timestamp: Date.now(),
        committedMove: outcome.result.choice,
        plannerMove: ground,
        decision: outcome.result,
        shieldIntervened: false,
        outcome,
      });
      // a real answer arrived - loop again immediately, no pacing floor,
      // so a fast model gets polled as fast as it can genuinely answer.
    } else if (this.assisted) {
      this.covering = true;
      this.emit({
        source: this.client.source,
        timestamp: Date.now(),
        committedMove: ground,
        plannerMove: ground,
        decision: null,
        shieldIntervened: true,
        outcome,
      });
      await this.waitOutCyclePacing(cycleStart);
    } else {
      this.emit({
        source: this.client.source,
        timestamp: Date.now(),
        committedMove: this.currentMove,
        plannerMove: ground,
        decision: null,
        shieldIntervened: false,
        outcome,
      });
      await this.waitOutCyclePacing(cycleStart);
    }
    this.cycleActive = false;
  }

  /**
   * A failed cycle (deadline miss, or an error that happened to settle
   * fast - e.g. an instant connection refusal or a fast-rejecting server)
   * must not free the next cycle to fire immediately: without this floor,
   * a backend that's fast to *fail* turns the retry loop into a busy-spin
   * hammering it hundreds of times a second while it's still working
   * through the real, slow request that's actually in flight. Pace failures
   * to roughly the act-deadline; successes are exempt (see call site).
   */
  private async waitOutCyclePacing(cycleStart: number): Promise<void> {
    const remaining = this.actDeadlineMs - (performance.now() - cycleStart);
    if (remaining > 0) {
      await new Promise((resolve) => setTimeout(resolve, remaining));
    }
  }

  private emit(event: ShieldEvent): void {
    this.onEvent(event);
  }
}
