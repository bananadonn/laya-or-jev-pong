/**
 * Pure ball-trajectory prediction, no dependency on any other module in
 * the repo (deliberately - both game/physics.ts's execution logic and
 * decisions/planner.ts's ground truth need this, and state.ts/physics.ts
 * already have a one-way relationship that a naive import here would turn
 * into a cycle).
 */

const NEAR_TERM_PROJECTION_SECONDS = 0.05;

/**
 * Predicts the ball's y-position by the time it reaches `targetX`,
 * including however many top/bottom wall bounces happen along the way
 * (closed-form reflection, not a simulation loop). Falls back to a small
 * near-term smoothing projection when the ball isn't currently heading
 * toward `targetX` (moving away, or already past it) - there's no
 * meaningful "arrival" to predict in that case.
 */
export function projectBallY(
  ball: { x: number; y: number; vx: number; vy: number },
  targetX: number,
  courtHeight: number,
): number {
  const approaching = ball.vx < 0 && ball.x > targetX;
  if (!approaching) {
    return ball.y + ball.vy * NEAR_TERM_PROJECTION_SECONDS;
  }
  const timeToReach = (ball.x - targetX) / -ball.vx;
  const unfolded = ball.y + ball.vy * timeToReach;
  return reflectIntoRange(unfolded, courtHeight);
}

/** Seconds until the ball reaches `targetX`, or null if it isn't heading there. */
export function timeToReachX(ball: { x: number; vx: number }, targetX: number): number | null {
  const approaching = ball.vx < 0 && ball.x > targetX;
  return approaching ? (ball.x - targetX) / -ball.vx : null;
}

function reflectIntoRange(y: number, max: number): number {
  const period = 2 * max;
  let folded = y % period;
  if (folded < 0) folded += period;
  return folded <= max ? folded : period - folded;
}
