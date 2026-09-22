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
 * 400ms: loose enough that Jev's real hosted latency (70-500ms per
 * TypeSafe's own docs) lands inside it often, not just at the lucky edge -
 * a tighter deadline (150ms, tried during development) meant the shield
 * intervened for both sides almost every single cycle, which technically
 * "works" but defeats the point of a demo meant to show real decisions
 * landing (CLAUDE.md §8). Still tight enough to matter: CPU-only Laya
 * inference measured ~900ms locally during development, so it will still
 * miss this deadline often on modest hardware - which is itself a real,
 * honest finding about the speed/accuracy tradeoff this benchmark exists
 * to surface, not something to hide by inflating the deadline further.
 */
export const DEFAULT_ACT_DEADLINE_MS = 400;

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
 * In unassisted mode a late decision does NOT get a planner fallback: the
 * paddle simply holds its last committed move until the model actually
 * answers, exposing the model's raw, unprotected latency/accuracy.
 */
export class Shield {
  private currentMove: Move = "stay";
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
        this.currentMove = ground;
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
      this.currentMove = ground;
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
