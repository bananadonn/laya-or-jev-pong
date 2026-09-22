import type { Move, PongState } from "./types";

/**
 * Deterministic ground-truth "correct move" for a given (already
 * side-mirrored) PongState — CLAUDE.md §7. Projects the ball's actual
 * trajectory (including top/bottom wall bounces) forward to the moment it
 * reaches the paddle's own x-plane, then compares that to the paddle's
 * current y.
 *
 * This is still a single-tick reactive judgment, not the "predicting
 * where to position well in advance of a return" lookahead CLAUDE.md §2
 * rules out: it's recomputed fresh every tick from scratch, has no memory
 * of past answers, and never reasons about anything beyond this one
 * incoming ball. CLAUDE.md itself groups Pong with "reactive games" like
 * Space Invaders precisely because trajectory-aware reaction *is* the
 * reactive judgment the task calls for - a Pong agent that only looks at
 * the ball's current position and ignores where it's headed isn't playing
 * reactively, it's playing blind.
 */
export function plannerMove(state: PongState, deadZone = 4): Move {
  const { ball, paddle, court } = state;
  const approaching = ball.vx < 0 && ball.x > paddle.x;

  const targetY = approaching
    ? projectArrivalY(ball, paddle.x, court.height)
    : ball.y + ball.vy * NEAR_TERM_PROJECTION_SECONDS;

  const delta = targetY - paddle.y;
  if (Math.abs(delta) <= deadZone) return "stay";
  return delta < 0 ? "up" : "down";
}

/**
 * Where the ball will cross `paddleX`, accounting for however many times
 * it reflects off the top/bottom walls between now and then. Unfolds the
 * straight-line projection past the court's edges and folds it back in
 * with a triangle wave - equivalent to simulating each bounce, but O(1).
 */
function projectArrivalY(ball: PongState["ball"], paddleX: number, courtHeight: number): number {
  const timeToReach = (ball.x - paddleX) / -ball.vx;
  const unfolded = ball.y + ball.vy * timeToReach;
  return reflectIntoRange(unfolded, courtHeight);
}

function reflectIntoRange(y: number, max: number): number {
  const period = 2 * max;
  let folded = y % period;
  if (folded < 0) folded += period;
  return folded <= max ? folded : period - folded;
}

/** Used only when the ball isn't approaching (moving away, or already past) - just smooths reactive jitter. */
const NEAR_TERM_PROJECTION_SECONDS = 0.05;
