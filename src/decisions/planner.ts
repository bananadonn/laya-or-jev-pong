import type { Move, PongState } from "./types";

/**
 * Deterministic ground-truth "correct move" for a given (already
 * side-mirrored) PongState — CLAUDE.md §7. Purely reactive: compares the
 * paddle center to the ball's current y and a one-tick-ahead projection.
 * No lookahead beyond that, matching the "no lookahead requirement" in §2.
 */
export function plannerMove(state: PongState, deadZone = 4): Move {
  const { ball, paddle } = state;
  const targetY = ball.y + ball.vy * PROJECTION_SECONDS;
  const delta = targetY - paddle.y;

  if (Math.abs(delta) <= deadZone) return "stay";
  return delta < 0 ? "up" : "down";
}

/** Small fixed lookahead used only to smooth reactive jitter, not to plan positioning. */
const PROJECTION_SECONDS = 0.05;
