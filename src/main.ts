import { JevClient } from "./decisions/jevClient";
import { LayaClient } from "./decisions/layaClient";
import { Shield, type ShieldEvent } from "./decisions/shield";
import type { DecisionClient, Move } from "./decisions/types";
import { GameLoop } from "./game/loop";
import type { PaddleCommands } from "./game/physics";
import { createInitialGameState, toPongState, type GameState, type Side } from "./game/state";
import { Renderer, type HudSideData, type RenderFrame } from "./render/canvas";
import { DecisionLog, type DecisionRecord } from "./stats/log";
import { MetricsTracker } from "./stats/metrics";

/**
 * v4: same shielded Laya/Jev control as before, now also surfacing the
 * full move-probability distribution (3-bar display), per-move latency
 * history (chart), and a disclosed handicap dial per side. Each
 * ShieldEvent is turned into a plain DecisionRecord here and handed to
 * stats/log.ts + stats/metrics.ts — those modules never import anything
 * from decisions/, this is the one place that bridges the two.
 */

const canvas = document.getElementById("court") as HTMLCanvasElement;
const renderer = new Renderer(canvas);

let game: GameState = createInitialGameState();
const decisionLog = new DecisionLog();
const metrics = new MetricsTracker();
const labels: Record<Side, string> = { left: "Laya", right: "Jev" };
const FEED_LENGTH = 8;
const CHART_POINTS = 40;

interface DisplayState {
  connected: boolean;
  connectionDetail: string;
  /** what actually happened to the paddle - may be handicap-substituted */
  lastMove: Move | null;
  /** the model's own real pick, for the probability-bar highlight - never handicap-substituted */
  lastRealChoice: Move | null;
  lastConfidence: number | null;
  lastLatencyMs: number | null;
  lastProbabilities: Record<Move, number> | null;
  handicapPct: number;
}

function initialDisplay(): DisplayState {
  return {
    connected: false,
    connectionDetail: "checking…",
    lastMove: null,
    lastRealChoice: null,
    lastConfidence: null,
    lastLatencyMs: null,
    lastProbabilities: null,
    handicapPct: 0,
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
    probabilities: event.decision?.probabilities ?? null,
    latencyMs: event.decision?.latencyMs ?? null,
    shieldIntervened: event.shieldIntervened,
    agreedWithPlanner: event.committedMove === event.plannerMove,
    handicapped: event.handicapped,
  };
  decisionLog.add(record);
  metrics.record(record);

  display[side].lastMove = event.committedMove;
  if (event.decision) {
    display[side].lastRealChoice = event.decision.choice;
    display[side].lastConfidence = event.decision.confidence;
    display[side].lastLatencyMs = event.decision.latencyMs;
    display[side].lastProbabilities = event.decision.probabilities;
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
      handicapped: r.handicapped,
    }));

  return {
    label: labels[side],
    connected: d.connected,
    connectionDetail: d.connectionDetail,
    lastMove: d.lastMove ?? "—",
    lastRealChoice: d.lastRealChoice,
    lastConfidence: d.lastConfidence,
    lastLatencyMs: d.lastLatencyMs,
    lastProbabilities: d.lastProbabilities,
    agreementPct: m.agreementPct,
    shieldInterventions: m.shieldInterventions,
    requestsInFlight: m.requestsInFlight,
    handicapPct: d.handicapPct,
    handicappedCount: m.handicappedCount,
    latencyP50: m.latencyP50,
    latencyP95: m.latencyP95,
    feed,
  };
}

function latencySeries(side: Side) {
  return decisionLog
    .recent(side, CHART_POINTS)
    .filter((r) => r.latencyMs !== null)
    .map((r) => ({ timestamp: r.timestamp, latencyMs: r.latencyMs as number }));
}

function render(): void {
  const frame: RenderFrame = {
    court: game.court,
    ball: game.ball,
    paddles: game.paddles,
    score: game.score,
    hud: { left: toHudSideData("left"), right: toHudSideData("right") },
    latencyChart: { left: latencySeries("left"), right: latencySeries("right") },
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
    handicapPct: display.left.handicapPct,
  };
  display.right = {
    ...initialDisplay(),
    connected: display.right.connected,
    connectionDetail: display.right.connectionDetail,
    handicapPct: display.right.handicapPct,
  };
  render();
});

let paused = false;
document.getElementById("pause-btn")?.addEventListener("click", (e) => {
  paused = !paused;
  const btn = e.currentTarget as HTMLButtonElement;
  if (paused) {
    // stop the physics loop *and* both shields - pausing should also stop
    // burning real API calls/inference while nobody's watching, not just
    // freeze the picture.
    loop.stop();
    shields.left.stop();
    shields.right.stop();
    btn.textContent = "Resume";
  } else {
    loop.start();
    shields.left.start();
    shields.right.start();
    btn.textContent = "Pause";
  }
});

document.getElementById("left-unassisted")?.addEventListener("change", (e) => {
  shields.left.setAssisted(!(e.target as HTMLInputElement).checked);
});
document.getElementById("right-unassisted")?.addEventListener("change", (e) => {
  shields.right.setAssisted(!(e.target as HTMLInputElement).checked);
});

function wireHandicapControl(side: Side): void {
  const input = document.getElementById(`${side}-handicap`) as HTMLInputElement | null;
  input?.addEventListener("input", () => {
    const pct = Number(input.value);
    shields[side].setHandicapPct(pct);
    display[side].handicapPct = pct;
    render();
  });
}
wireHandicapControl("left");
wireHandicapControl("right");

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
