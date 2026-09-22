import type { Move } from "../decisions/types";
import {
  MAX_SPEED_TIER,
  PADDLE_MARGIN,
  serveBall,
  type Ball,
  type Court,
  type GameState,
  type Paddle,
  type Side,
} from "./state";

const PADDLE_SPEED = 340; // px/s
const SPEED_TIER_BOOST = 1.06;

export interface PaddleCommands {
  left: Move;
  right: Move;
}

export interface StepResult {
  state: GameState;
  /** which side, if any, conceded a point this tick */
  scored: Side | null;
}

export function clampPaddle(paddle: Paddle, court: Court): Paddle {
  const half = paddle.height / 2;
  return { ...paddle, y: Math.min(court.height - half, Math.max(half, paddle.y)) };
}

export function movePaddle(paddle: Paddle, move: Move, dt: number, court: Court): Paddle {
  const dir = move === "up" ? -1 : move === "down" ? 1 : 0;
  return clampPaddle({ ...paddle, y: paddle.y + dir * PADDLE_SPEED * dt }, court);
}

function reflectOffPaddle(ball: Ball, paddle: Paddle): Ball {
  // offset in [-1, 1] from paddle center -> outgoing angle, classic Pong feel
  const offset = (ball.y - paddle.y) / (paddle.height / 2);
  const angle = offset * (Math.PI / 3); // max 60deg off horizontal
  const speed = Math.hypot(ball.vx, ball.vy) * SPEED_TIER_BOOST;
  const direction = ball.vx > 0 ? 1 : -1;
  return {
    ...ball,
    vx: -direction * Math.cos(angle) * speed,
    vy: Math.sin(angle) * speed,
  };
}

/** Pure single-tick physics step: no rendering, no decision logic. */
export function step(game: GameState, commands: PaddleCommands, dt: number): StepResult {
  const court = game.court;
  let ball = {
    ...game.ball,
    x: game.ball.x + game.ball.vx * dt,
    y: game.ball.y + game.ball.vy * dt,
  };

  // top/bottom wall bounce
  if (ball.y - ball.radius < 0) {
    ball = { ...ball, y: ball.radius, vy: Math.abs(ball.vy) };
  } else if (ball.y + ball.radius > court.height) {
    ball = { ...ball, y: court.height - ball.radius, vy: -Math.abs(ball.vy) };
  }

  const left = movePaddle(game.paddles.left, commands.left, dt, court);
  const right = movePaddle(game.paddles.right, commands.right, dt, court);

  let speedTier = game.speedTier;
  let rallyLength = game.rallyLength;

  const leftPaddleX = PADDLE_MARGIN;
  const rightPaddleX = court.width - PADDLE_MARGIN;

  if (
    ball.vx < 0 &&
    ball.x - ball.radius <= leftPaddleX &&
    ball.x - ball.radius >= leftPaddleX - Math.abs(ball.vx * dt) - 1 &&
    Math.abs(ball.y - left.y) <= left.height / 2 + ball.radius
  ) {
    ball = reflectOffPaddle({ ...ball, x: leftPaddleX + ball.radius }, left);
    speedTier = Math.min(MAX_SPEED_TIER, speedTier + 1);
    rallyLength += 1;
  } else if (
    ball.vx > 0 &&
    ball.x + ball.radius >= rightPaddleX &&
    ball.x + ball.radius <= rightPaddleX + Math.abs(ball.vx * dt) + 1 &&
    Math.abs(ball.y - right.y) <= right.height / 2 + ball.radius
  ) {
    ball = reflectOffPaddle({ ...ball, x: rightPaddleX - ball.radius }, right);
    speedTier = Math.min(MAX_SPEED_TIER, speedTier + 1);
    rallyLength += 1;
  }

  let score = game.score;
  let scored: Side | null = null;
  if (ball.x + ball.radius < 0) {
    score = { ...score, right: score.right + 1 };
    scored = "left"; // left conceded
    ball = serveBall(court, 0);
    speedTier = 0;
    rallyLength = 0;
  } else if (ball.x - ball.radius > court.width) {
    score = { ...score, left: score.left + 1 };
    scored = "right"; // right conceded
    ball = serveBall(court, 0);
    speedTier = 0;
    rallyLength = 0;
  }

  return {
    state: { ...game, ball, paddles: { left, right }, score, speedTier, rallyLength },
    scored,
  };
}
