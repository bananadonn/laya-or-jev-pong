import { step, type PaddleCommands, type StepResult } from "./physics";
import type { GameState } from "./state";

export type TickHandler = (result: StepResult, dtSeconds: number) => void;

/**
 * Fixed-tick game loop, decoupled from rendering and from decision logic.
 * `getCommands` is a synchronous read of whatever the caller currently has
 * committed for each paddle — how those commands get produced (planner,
 * shielded model decisions, ...) is none of this loop's business.
 */
export class GameLoop {
  private state: GameState;
  private running = false;
  private rafId: number | null = null;
  private lastTime = 0;
  private accumulator = 0;
  private readonly tickSeconds: number;

  constructor(
    initialState: GameState,
    private readonly getCommands: () => PaddleCommands,
    private readonly onTick: TickHandler,
    tickMs = 1000 / 60,
  ) {
    this.state = initialState;
    this.tickSeconds = tickMs / 1000;
  }

  getState(): GameState {
    return this.state;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastTime = performance.now();
    this.rafId = requestAnimationFrame(this.frame);
  }

  stop(): void {
    this.running = false;
    if (this.rafId !== null) cancelAnimationFrame(this.rafId);
    this.rafId = null;
  }

  reset(state: GameState): void {
    this.state = state;
    this.accumulator = 0;
  }

  private readonly frame = (now: number): void => {
    if (!this.running) return;
    // clamp so a stalled tab / breakpoint doesn't spiral into a huge catch-up burst
    const elapsedSeconds = Math.min(0.25, (now - this.lastTime) / 1000);
    this.lastTime = now;
    this.accumulator += elapsedSeconds;

    while (this.accumulator >= this.tickSeconds) {
      const result = step(this.state, this.getCommands(), this.tickSeconds);
      this.state = result.state;
      this.onTick(result, this.tickSeconds);
      this.accumulator -= this.tickSeconds;
    }

    this.rafId = requestAnimationFrame(this.frame);
  };
}
