import { JevClient } from "./decisions/jevClient";
import { LayaClient } from "./decisions/layaClient";
import { Shield, type ShieldEvent } from "./decisions/shield";
import type { DecisionClient } from "./decisions/types";
import { GameLoop } from "./game/loop";
import type { PaddleCommands } from "./game/physics";
import { createInitialGameState, toPongState, type GameState, type Side } from "./game/state";
import { Renderer, type HudSideData, type RenderFrame } from "./render/canvas";

/**
 * v2: both paddles are now driven by real shielded decision clients (Laya
 * on the left, Jev on the right) instead of the bare planner. Per-tick
 * agreement %, latency percentiles, and the full decision feed are wired
 * in milestone 5 once stats/metrics.ts and stats/log.ts exist — for now
 * the HUD shows what's directly available off each ShieldEvent (CLAUDE.md
 * §9 milestone 4).
 */

const canvas = document.getElementById("court") as HTMLCanvasElement;
const renderer = new Renderer(canvas);

let game: GameState = createInitialGameState();

interface LiveHud {
  connected: boolean;
  connectionDetail: string;
  lastMove: string;
  lastConfidence: number | null;
  lastLatencyMs: number | null;
  shieldInterventions: number;
  requestsInFlight: number;
}

function initialHud(): LiveHud {
  return {
    connected: false,
    connectionDetail: "checking…",
    lastMove: "—",
    lastConfidence: null,
    lastLatencyMs: null,
    shieldInterventions: 0,
    requestsInFlight: 0,
  };
}

const hud: Record<Side, LiveHud> = { left: initialHud(), right: initialHud() };
const labels: Record<Side, string> = { left: "Laya", right: "Jev" };

function onShieldEvent(side: Side, event: ShieldEvent): void {
  const h = hud[side];
  h.requestsInFlight = Math.max(0, h.requestsInFlight - 1);
  h.lastMove = event.committedMove;
  if (event.decision) {
    h.lastConfidence = event.decision.confidence;
    h.lastLatencyMs = event.decision.latencyMs;
  }
  if (event.shieldIntervened) {
    h.shieldInterventions += 1;
  }
  render();
}

function onRequestStart(side: Side): void {
  hud[side].requestsInFlight += 1;
}

function makeShield(side: Side, client: DecisionClient): Shield {
  return new Shield(
    client,
    () => toPongState(game, side),
    (event) => onShieldEvent(side, event),
    true,
    150,
    () => onRequestStart(side),
  );
}

const clients: Record<Side, DecisionClient> = {
  left: new LayaClient(),
  right: new JevClient(),
};

const shields: Record<Side, Shield> = {
  left: makeShield("left", clients.left),
  right: makeShield("right", clients.right),
};

const loop = new GameLoop(
  game,
  (): PaddleCommands => ({ left: shields.left.getMove(), right: shields.right.getMove() }),
  () => {
    game = loop.getState();
    render();
  },
);

function toHudSideData(side: Side): HudSideData {
  const h = hud[side];
  return {
    label: labels[side],
    connected: h.connected,
    connectionDetail: h.connectionDetail,
    lastMove: h.lastMove,
    lastConfidence: h.lastConfidence,
    lastLatencyMs: h.lastLatencyMs,
    agreementPct: null, // wired in milestone 5 (stats/metrics.ts)
    shieldInterventions: h.shieldInterventions,
    requestsInFlight: h.requestsInFlight,
    latencyP50: null,
    latencyP95: null,
    feed: [], // wired in milestone 5 (stats/log.ts)
  };
}

function render(): void {
  const frame: RenderFrame = {
    court: game.court,
    ball: game.ball,
    paddles: game.paddles,
    score: game.score,
    hud: { left: toHudSideData("left"), right: toHudSideData("right") },
  };
  renderer.draw(frame);
}

async function refreshConnection(side: Side, client: DecisionClient): Promise<void> {
  const connected = await client.checkConnection();
  hud[side].connected = connected;
  hud[side].connectionDetail = connected
    ? ""
    : side === "left"
      ? "local Laya server not reachable (see docs/INTEGRATION.md)"
      : "Jev proxy unreachable or TYPESAFE_API_KEY missing (see docs/INTEGRATION.md)";
  render();
}

document.getElementById("restart-btn")?.addEventListener("click", () => {
  loop.reset(createInitialGameState());
  game = loop.getState();
  render();
});

document.getElementById("left-unassisted")?.addEventListener("change", (e) => {
  shields.left.setAssisted(!(e.target as HTMLInputElement).checked);
});
document.getElementById("right-unassisted")?.addEventListener("change", (e) => {
  shields.right.setAssisted(!(e.target as HTMLInputElement).checked);
});

render();
loop.start();
shields.left.start();
shields.right.start();

void refreshConnection("left", clients.left);
void refreshConnection("right", clients.right);
setInterval(() => {
  void refreshConnection("left", clients.left);
  void refreshConnection("right", clients.right);
}, 5000);
