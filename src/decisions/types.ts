/** State sent to a decision model every tick — CLAUDE.md §5. */
export interface PongState {
  ball: { x: number; y: number; vx: number; vy: number };
  paddle: { y: number; height: number };
  court: { width: number; height: number };
  speed_tier: number;
}

export type Move = "up" | "down" | "stay";

export const MOVE_CHOICES: readonly Move[] = ["up", "down", "stay"];

export type Source = "jev" | "laya";

/** Normalized response shape both clients resolve to — CLAUDE.md §5. */
export interface DecisionResult {
  choice: Move;
  confidence: number; // 0-1
  latencyMs: number;
  source: Source;
}

/**
 * A client either resolves with a real decision, or explicitly reports
 * that it couldn't produce one in time (timeout, disconnect, error). The
 * shield treats both `null` and a rejected promise as "no decision" —
 * this type exists so callers aren't tempted to fabricate a DecisionResult
 * for a failure path (CLAUDE.md §2, §6: fail loudly, never invent numbers).
 */
export type DecisionOutcome =
  | { ok: true; result: DecisionResult }
  | { ok: false; reason: "timeout" | "disconnected" | "error"; detail: string };

export interface DecisionClient {
  readonly source: Source;
  decide(state: PongState, signal: AbortSignal): Promise<DecisionOutcome>;
  /** Best-effort connectivity check for the UI's connection status indicator. */
  checkConnection(): Promise<boolean>;
}
