import type { PongState } from "../decisions/types";

export type Side = "left" | "right";

export interface Ball {
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
}

export interface Paddle {
  /** vertical center of the paddle */
  y: number;
  height: number;
  width: number;
}

export interface Court {
  width: number;
  height: number;
}

export interface Score {
  left: number;
  right: number;
}

export interface GameState {
  ball: Ball;
  paddles: { left: Paddle; right: Paddle };
  court: Court;
  score: Score;
  /** increments on every paddle hit, drives the capped speed ramp */
  speedTier: number;
  /** paddle hits since the ball was last served */
  rallyLength: number;
}

export const DEFAULT_COURT: Court = { width: 800, height: 500 };
export const PADDLE_HEIGHT = 90;
export const PADDLE_WIDTH = 12;
export const PADDLE_MARGIN = 24;
export const BALL_RADIUS = 7;
export const BASE_BALL_SPEED = 260; // px/s
export const MAX_SPEED_TIER = 8;

export function createInitialGameState(court: Court = DEFAULT_COURT): GameState {
  return {
    ball: serveBall(court, 0),
    paddles: {
      left: { y: court.height / 2, height: PADDLE_HEIGHT, width: PADDLE_WIDTH },
      right: { y: court.height / 2, height: PADDLE_HEIGHT, width: PADDLE_WIDTH },
    },
    court,
    score: { left: 0, right: 0 },
    speedTier: 0,
    rallyLength: 0,
  };
}

export function serveBall(court: Court, speedTier: number): Ball {
  const speed = BASE_BALL_SPEED + speedTier * 18;
  const angle = (Math.random() * 0.5 - 0.25) * Math.PI; // +/- 45deg
  const direction = Math.random() < 0.5 ? -1 : 1;
  return {
    x: court.width / 2,
    y: court.height / 2,
    vx: Math.cos(angle) * speed * direction,
    vy: Math.sin(angle) * speed,
    radius: BALL_RADIUS,
  };
}

/**
 * State as sent to a decision model: always framed as if `side` were the
 * left paddle defending against a ball moving in from the right, per
 * CLAUDE.md §5 ("only mirrored in x for the side they're on"). This keeps
 * the up/down/stay question identically shaped for both models regardless
 * of which physical side they're playing.
 */
export function toPongState(game: GameState, side: Side): PongState {
  const { ball, court, paddles, speedTier } = game;
  const paddle = paddles[side];
  const mirrored = side === "right";

  return {
    ball: {
      x: mirrored ? court.width - ball.x : ball.x,
      y: ball.y,
      vx: mirrored ? -ball.vx : ball.vx,
      vy: ball.vy,
    },
    paddle: { y: paddle.y, height: paddle.height },
    court: { width: court.width, height: court.height },
    speed_tier: speedTier,
  };
}
