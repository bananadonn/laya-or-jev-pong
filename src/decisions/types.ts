/**
 * State sent to a decision model every tick — extends CLAUDE.md §5's
 * original shape with `paddle.x`. Without it, a model has ball velocity
 * but no way to know its own position on the court's x-axis, so it can't
 * compute distance or time-to-intercept even though it technically has
 * the pieces (§2/§7's reactive judgment needs the paddle's own frame to
 * be complete, not just the ball's).
 */
export interface PongState {
  ball: { x: number; y: number; vx: number; vy: number };
  paddle: { x: number; y: number; height: number };
  court: { width: number; height: number };
  speed_tier: number;
}

export type Move = "up" | "down" | "stay";

export const MOVE_CHOICES: readonly Move[] = ["up", "down", "stay"];

/** Normalizes a loosely-typed API response's probability map into a strict, complete one. */
export function normalizeProbabilities(
  raw: Record<string, number> | undefined,
): Record<Move, number> {
  return {
    up: raw?.up ?? 0,
    down: raw?.down ?? 0,
    stay: raw?.stay ?? 0,
  };
}

export type Source = "jev" | "laya";

/** Normalized response shape both clients resolve to — CLAUDE.md §5. */
export interface DecisionResult {
  choice: Move;
  confidence: number; // 0-1
  /** the full distribution both real APIs return alongside the winning choice */
  probabilities: Record<Move, number>;
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
