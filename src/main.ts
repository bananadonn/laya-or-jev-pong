import { plannerMove } from "./decisions/planner";
import { GameLoop } from "./game/loop";
import type { PaddleCommands } from "./game/physics";
import { createInitialGameState, toPongState, type GameState } from "./game/state";
import { Renderer, type HudSideData, type RenderFrame } from "./render/canvas";

/**
 * v1: both paddles are driven directly by the deterministic planner, with
 * no decision clients in the loop at all — this validates the game core
 * (physics/state/loop/render) on its own before any model is wired in,
 * per CLAUDE.md §9 milestone 1.
 */

const canvas = document.getElementById("court") as HTMLCanvasElement;
const renderer = new Renderer(canvas);

let game: GameState = createInitialGameState();
const loop = new GameLoop(
  game,
  (): PaddleCommands => ({
    left: plannerMove(toPongState(loop.getState(), "left")),
    right: plannerMove(toPongState(loop.getState(), "right")),
  }),
  () => {
    game = loop.getState();
    render();
  },
);

function placeholderHud(label: string): HudSideData {
  return {
    label,
    connected: false,
    connectionDetail: "not wired up yet (milestone 1: planner-only)",
    lastMove: "—",
    lastConfidence: null,
    lastLatencyMs: null,
    agreementPct: null,
    shieldInterventions: 0,
    requestsInFlight: 0,
    latencyP50: null,
    latencyP95: null,
    feed: [],
  };
}

function render(): void {
  const frame: RenderFrame = {
    court: game.court,
    ball: game.ball,
    paddles: game.paddles,
    score: game.score,
    hud: { left: placeholderHud("Laya"), right: placeholderHud("Jev") },
  };
  renderer.draw(frame);
}

document.getElementById("restart-btn")?.addEventListener("click", () => {
  loop.reset(createInitialGameState());
  game = loop.getState();
  render();
});

render();
loop.start();
