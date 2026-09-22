import { projectBallY, timeToReachX } from "../game/trajectory";
import { plannerMove } from "./planner";
import type {
  DecisionClient,
  DecisionOutcome,
  DecisionResult,
  Move,
  PongState,
  Source,
} from "./types";

const DEAD_ZONE = 4;

export interface ShieldEvent {
  source: Source;
  timestamp: number;
  /** the direction actually committed for this rally leg */
  committedMove: Move;
  /** the planner's own judgment at the same moment the model was asked, for agreement tracking */
  plannerMove: Move;
  /** present only when a real model decision arrived before the ball reached the paddle */
  decision: DecisionResult | null;
  /** true when the ball reached the paddle before an answer landed, and the shield covered instead */
  shieldIntervened: boolean;
  outcome: DecisionOutcome | { ok: false; reason: "unassisted-late"; detail: string };
}

export type ShieldListener = (event: ShieldEvent) => void;

/**
 * Asks its client **once per rally leg** - the instant the ball starts
 * heading toward this paddle (right after the opponent's hit, or a new
 * serve) - rather than continuously polling every tick. Between hits, the
 * ball's trajectory is fully determined by physics (position + velocity,
 * including wall bounces), so re-asking the same question every ~150ms
 * while nothing new has happened is redundant network/inference cost, not
 * more information.
 *
 * The model's answer is executed literally, direction and all: if it says
 * "up", the paddle moves up for the rest of the leg, full stop - even if
 * that's the wrong call and the paddle ends up pinned against a wall. The
 * only thing physics decides is *when to stop*: once the paddle reaches
 * the ball's live-projected arrival y (which only changes if the ball
 * bounces off a wall), it holds there rather than overshooting forever.
 * Physics never overrides *which way* to go - only a correct direction
 * ever reaches alignment and gets to stop early; a wrong one just runs
 * out of court.
 *
 * The "act deadline" is no longer an arbitrary constant - it's the ball's
 * actual real time-to-arrival, computed fresh each leg. If the deadline
 * passes with no answer (assisted mode), the shield covers with the
 * planner's live judgment, same as before.
 */
export class Shield {
  /** the model's chosen direction for the current leg, or null before it's answered */
  private modelDirection: Move | null = null;
  /** true while there's no committed model direction yet this leg - live-track via the planner */
  private covering = true;
  private wasApproaching = false;
  private running = false;
  /** held while unassisted and the leg's deadline has passed with no answer - the paddle just stops */
  private unassistedHold: Move = "stay";
  /**
   * Incremented every new leg. A resolving request only gets to affect
   * state if its own legId still matches - otherwise a slow response from
   * an *earlier* leg could land after a *later* leg has already started
   * and clobber its direction with stale information. A plain boolean
   * "request in flight" flag isn't enough for this: leg N+1 starting
   * would flip it back to true before leg N's own slow response arrives,
   * making it look "still active" when it's actually two legs stale.
   */
  private legId = 0;

  constructor(
    private readonly client: DecisionClient,
    private readonly getState: () => PongState,
    private readonly onEvent: ShieldListener,
    private assisted = true,
    /** fired the instant a decide() request goes out, for a live "requests in flight" gauge */
    private readonly onRequestStart?: (source: Source) => void,
  ) {}

  getMove(): Move {
    const state = this.getState();
    const approaching = state.ball.vx < 0 && state.ball.x > state.paddle.x;

    if (approaching && !this.wasApproaching) {
      this.beginLeg(state);
    } else if (!approaching && this.wasApproaching) {
      this.endLeg();
    }
    this.wasApproaching = approaching;

    // nothing incoming right now (opponent's turn) - no reason to move
    if (!approaching) return "stay";

    if (this.modelDirection !== null) {
      return this.chase(state);
    }
    if (this.covering && this.assisted) {
      return plannerMove(state);
    }
    return this.unassistedHold;
  }

  setAssisted(assisted: boolean): void {
    this.assisted = assisted;
  }

  start(): void {
    this.running = true;
  }

  stop(): void {
    this.running = false;
  }

  /** Moves in the model's committed direction until physics says the paddle has arrived. */
  private chase(state: PongState): Move {
    const direction = this.modelDirection;
    if (direction === null || direction === "stay") return "stay";
    const targetY = projectBallY(state.ball, state.paddle.x, state.court.height);
    if (Math.abs(targetY - state.paddle.y) <= DEAD_ZONE) return "stay";
    return direction;
  }

  private endLeg(): void {
    this.modelDirection = null;
    this.covering = true;
    this.unassistedHold = "stay";
  }

  private beginLeg(state: PongState): void {
    if (!this.running) return;
    this.legId += 1;
    this.covering = true;
    void this.requestDecisionForLeg(state, this.legId);
  }

  private async requestDecisionForLeg(legStartState: PongState, myLegId: number): Promise<void> {
    if (!this.running) return;
    const ground = plannerMove(legStartState);
    // null shouldn't happen here - beginLeg only fires when `approaching` is
    // already true, so the ball is by definition heading toward paddle.x -
    // but fall back to "act now" rather than a nonsensical negative/NaN
    // deadline if that invariant is ever violated.
    const timeToReachSeconds = timeToReachX(legStartState.ball, legStartState.paddle.x) ?? 0;
    const deadlineMs = Math.max(0, timeToReachSeconds * 1000);

    const controller = new AbortController();
    const deadline = new Promise<"deadline">((resolve) => {
      setTimeout(() => resolve("deadline"), deadlineMs);
    });

    this.onRequestStart?.(this.client.source);
    const decidePromise = this.client.decide(legStartState, controller.signal);
    const race = await Promise.race([decidePromise, deadline]);

    // the leg may have already ended, or a newer leg may have already
    // begun, by the time this resolves - still record the event for
    // stats, but only let it mutate live paddle-control state if it's
    // still the current leg (see the `legId` field comment).
    const stillCurrentLeg = this.legId === myLegId;

    if (race === "deadline") {
      if (this.assisted) {
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
            detail: `no decision within ${deadlineMs.toFixed(0)}ms (ball arrival)`,
          },
        });
      } else {
        if (stillCurrentLeg) this.unassistedHold = "stay";
        this.emit({
          source: this.client.source,
          timestamp: Date.now(),
          committedMove: stillCurrentLeg ? this.unassistedHold : "stay",
          plannerMove: ground,
          decision: null,
          shieldIntervened: false,
          outcome: {
            ok: false,
            reason: "unassisted-late",
            detail: "ball reached the paddle with no answer - holding, no shield fallback",
          },
        });
      }
      controller.abort();
      await decidePromise.catch(() => undefined);
      return;
    }

    const outcome = race;
    if (outcome.ok) {
      if (stillCurrentLeg) {
        this.modelDirection = outcome.result.choice;
        this.covering = false;
      }
      this.emit({
        source: this.client.source,
        timestamp: Date.now(),
        committedMove: outcome.result.choice,
        plannerMove: ground,
        decision: outcome.result,
        shieldIntervened: false,
        outcome,
      });
    } else if (this.assisted) {
      this.emit({
        source: this.client.source,
        timestamp: Date.now(),
        committedMove: ground,
        plannerMove: ground,
        decision: null,
        shieldIntervened: true,
        outcome,
      });
    } else {
      this.emit({
        source: this.client.source,
        timestamp: Date.now(),
        committedMove: stillCurrentLeg ? this.unassistedHold : "stay",
        plannerMove: ground,
        decision: null,
        shieldIntervened: false,
        outcome,
      });
    }
  }

  private emit(event: ShieldEvent): void {
    this.onEvent(event);
  }
}
