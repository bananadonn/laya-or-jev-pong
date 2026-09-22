import { JevClient } from "./decisions/jevClient";
import { LayaClient } from "./decisions/layaClient";
import { DEFAULT_ACT_DEADLINE_MS, Shield, type ShieldEvent } from "./decisions/shield";
import type { DecisionClient, Move } from "./decisions/types";
import { GameLoop } from "./game/loop";
import type { PaddleCommands } from "./game/physics";
import { createInitialGameState, toPongState, type GameState, type Side } from "./game/state";
import { Renderer, type HudSideData, type RenderFrame } from "./render/canvas";
import { DecisionLog, type DecisionRecord } from "./stats/log";
import { MetricsTracker } from "./stats/metrics";

/**
 * v3: same shielded Laya/Jev control as milestone 4, now with real
 * aggregate stats (CLAUDE.md §7/§8) wired in. Each ShieldEvent is turned
 * into a plain DecisionRecord here and handed to stats/log.ts +
 * stats/metrics.ts — those modules never import anything from decisions/,
 * this is the one place that bridges the two.
 */

const canvas = document.getElementById("court") as HTMLCanvasElement;
const renderer = new Renderer(canvas);

let game: GameState = createInitialGameState();
const decisionLog = new DecisionLog();
const metrics = new MetricsTracker();
const labels: Record<Side, string> = { left: "Laya", right: "Jev" };
const FEED_LENGTH = 8;

interface DisplayState {
  connected: boolean;
  connectionDetail: string;
  lastMove: Move | null;
  lastConfidence: number | null;
  lastLatencyMs: number | null;
}

function initialDisplay(): DisplayState {
  return {
    connected: false,
    connectionDetail: "checking…",
    lastMove: null,
    lastConfidence: null,
    lastLatencyMs: null,
  };
}

const display: Record<Side, DisplayState> = { left: initialDisplay(), right: initialDisplay() };
const inFlightCounts: Record<Side, number> = { left: 0, right: 0 };

function onShieldEvent(side: Side, event: ShieldEvent): void {
  inFlightCounts[side] = Math.max(0, inFlightCounts[side] - 1);
  metrics.setRequestsInFlight(side, inFlightCounts[side]);

  const record: DecisionRecord = {
    side,
    source: event.source,
    timestamp: event.timestamp,
    move: event.committedMove,
    confidence: event.decision?.confidence ?? null,
    latencyMs: event.decision?.latencyMs ?? null,
    shieldIntervened: event.shieldIntervened,
    agreedWithPlanner: event.committedMove === event.plannerMove,
  };
  decisionLog.add(record);
  metrics.record(record);

  display[side].lastMove = event.committedMove;
  if (event.decision) {
    display[side].lastConfidence = event.decision.confidence;
    display[side].lastLatencyMs = event.decision.latencyMs;
  }
  render();
}

function onRequestStart(side: Side): void {
  inFlightCounts[side] += 1;
  metrics.setRequestsInFlight(side, inFlightCounts[side]);
}

function makeShield(side: Side, client: DecisionClient): Shield {
  return new Shield(
    client,
    () => toPongState(game, side),
    (event) => onShieldEvent(side, event),
    true,
    DEFAULT_ACT_DEADLINE_MS,
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
  const d = display[side];
  const m = metrics.getSideMetrics(side);
  const feed = decisionLog
    .recent(side, FEED_LENGTH)
    .slice()
    .reverse()
    .map((r) => ({
      timestamp: r.timestamp,
      move: r.move,
      confidence: r.confidence,
      latencyMs: r.latencyMs,
      shieldIntervened: r.shieldIntervened,
    }));

  return {
    label: labels[side],
    connected: d.connected,
    connectionDetail: d.connectionDetail,
    lastMove: d.lastMove ?? "—",
    lastConfidence: d.lastConfidence,
    lastLatencyMs: d.lastLatencyMs,
    agreementPct: m.agreementPct,
    shieldInterventions: m.shieldInterventions,
    requestsInFlight: m.requestsInFlight,
    latencyP50: m.latencyP50,
    latencyP95: m.latencyP95,
    feed,
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
  display[side].connected = connected;
  display[side].connectionDetail = connected
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

document.getElementById("reset-stats-btn")?.addEventListener("click", () => {
  decisionLog.reset();
  metrics.reset();
  display.left = {
    ...initialDisplay(),
    connected: display.left.connected,
    connectionDetail: display.left.connectionDetail,
  };
  display.right = {
    ...initialDisplay(),
    connected: display.right.connected,
    connectionDetail: display.right.connectionDetail,
  };
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
