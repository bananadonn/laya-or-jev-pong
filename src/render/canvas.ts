/**
 * All drawing lives here. This module knows nothing about decision logic —
 * it only ever sees plain display data (strings/numbers), never a
 * DecisionResult or a Shield. See CLAUDE.md §3: render/ must not depend on
 * decisions/, enforced by the no-restricted-imports ESLint rule.
 */

export interface DecisionFeedEntry {
  timestamp: number;
  move: string;
  confidence: number | null;
  latencyMs: number | null;
  shieldIntervened: boolean;
}

export interface HudSideData {
  label: string;
  connected: boolean;
  connectionDetail: string;
  lastMove: string;
  lastConfidence: number | null;
  lastLatencyMs: number | null;
  agreementPct: number | null;
  shieldInterventions: number;
  requestsInFlight: number;
  latencyP50: number | null;
  latencyP95: number | null;
  feed: readonly DecisionFeedEntry[];
}

export interface RenderFrame {
  court: { width: number; height: number };
  ball: { x: number; y: number; radius: number };
  paddles: {
    left: { y: number; height: number; width: number };
    right: { y: number; height: number; width: number };
  };
  score: { left: number; right: number };
  hud: { left: HudSideData; right: HudSideData };
}

const PADDLE_MARGIN = 24;
const COLORS = {
  bg: "#0b0f17",
  court: "#131a26",
  net: "#2a3444",
  ball: "#f4f4f4",
  laya: "#4fd1c5",
  jev: "#f6ad55",
  text: "#e2e8f0",
};

function fmtMs(ms: number | null): string {
  return ms === null ? "—" : `${ms.toFixed(0)}ms`;
}

function fmtPct(pct: number | null): string {
  return pct === null ? "—" : `${pct.toFixed(0)}%`;
}

function fmtConfidence(c: number | null): string {
  return c === null ? "—" : `${(c * 100).toFixed(0)}%`;
}

export class Renderer {
  private readonly ctx: CanvasRenderingContext2D;
  private readonly sideEls: Record<"left" | "right", HudElements>;

  constructor(private readonly canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2D canvas context unavailable");
    this.ctx = ctx;
    this.sideEls = {
      left: queryHudElements("left"),
      right: queryHudElements("right"),
    };
  }

  draw(frame: RenderFrame): void {
    this.drawCourt(frame);
    this.updateHud("left", frame.hud.left);
    this.updateHud("right", frame.hud.right);
    this.updateScore(frame.score);
  }

  private drawCourt(frame: RenderFrame): void {
    const { ctx, canvas } = this;
    const scaleX = canvas.width / frame.court.width;
    const scaleY = canvas.height / frame.court.height;

    ctx.fillStyle = COLORS.bg;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = COLORS.court;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.strokeStyle = COLORS.net;
    ctx.setLineDash([8, 10]);
    ctx.beginPath();
    ctx.moveTo(canvas.width / 2, 0);
    ctx.lineTo(canvas.width / 2, canvas.height);
    ctx.stroke();
    ctx.setLineDash([]);

    this.drawPaddle(PADDLE_MARGIN * scaleX, frame.paddles.left, COLORS.laya, scaleX, scaleY);
    this.drawPaddle(
      canvas.width - PADDLE_MARGIN * scaleX,
      frame.paddles.right,
      COLORS.jev,
      scaleX,
      scaleY,
    );

    ctx.fillStyle = COLORS.ball;
    ctx.beginPath();
    ctx.arc(
      frame.ball.x * scaleX,
      frame.ball.y * scaleY,
      frame.ball.radius * scaleX,
      0,
      Math.PI * 2,
    );
    ctx.fill();
  }

  private drawPaddle(
    x: number,
    paddle: { y: number; height: number; width: number },
    color: string,
    scaleX: number,
    scaleY: number,
  ): void {
    const { ctx } = this;
    ctx.fillStyle = color;
    ctx.fillRect(
      x - (paddle.width * scaleX) / 2,
      paddle.y * scaleY - (paddle.height * scaleY) / 2,
      paddle.width * scaleX,
      paddle.height * scaleY,
    );
  }

  private updateScore(score: { left: number; right: number }): void {
    const el = document.getElementById("score");
    if (el) el.textContent = `${score.left} – ${score.right}`;
  }

  private updateHud(side: "left" | "right", data: HudSideData): void {
    const el = this.sideEls[side];
    el.status.textContent = data.connected
      ? "connected"
      : `disconnected — ${data.connectionDetail}`;
    el.status.classList.toggle("connected", data.connected);
    el.status.classList.toggle("disconnected", !data.connected);

    el.move.textContent = data.lastMove;
    el.confidence.textContent = fmtConfidence(data.lastConfidence);
    el.latency.textContent = fmtMs(data.lastLatencyMs);
    el.agreement.textContent = fmtPct(data.agreementPct);
    el.interventions.textContent = String(data.shieldInterventions);
    el.inFlight.textContent = String(data.requestsInFlight);
    el.p50.textContent = fmtMs(data.latencyP50);
    el.p95.textContent = fmtMs(data.latencyP95);

    el.feed.innerHTML = "";
    for (const entry of data.feed) {
      const li = document.createElement("li");
      li.className = entry.shieldIntervened ? "feed-entry shield" : "feed-entry";
      const time = new Date(entry.timestamp).toLocaleTimeString(undefined, {
        hour12: false,
        minute: "2-digit",
        second: "2-digit",
      });
      li.textContent = entry.shieldIntervened
        ? `${time}  shield -> ${entry.move}`
        : `${time}  ${entry.move}  (${fmtConfidence(entry.confidence)}, ${fmtMs(entry.latencyMs)})`;
      el.feed.appendChild(li);
    }
  }
}

interface HudElements {
  status: HTMLElement;
  move: HTMLElement;
  confidence: HTMLElement;
  latency: HTMLElement;
  agreement: HTMLElement;
  interventions: HTMLElement;
  inFlight: HTMLElement;
  p50: HTMLElement;
  p95: HTMLElement;
  feed: HTMLElement;
}

function must(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing required element #${id}`);
  return el;
}

function queryHudElements(side: "left" | "right"): HudElements {
  return {
    status: must(`${side}-status`),
    move: must(`${side}-move`),
    confidence: must(`${side}-confidence`),
    latency: must(`${side}-latency`),
    agreement: must(`${side}-agreement`),
    interventions: must(`${side}-interventions`),
    inFlight: must(`${side}-inflight`),
    p50: must(`${side}-p50`),
    p95: must(`${side}-p95`),
    feed: must(`${side}-feed`),
  };
}
