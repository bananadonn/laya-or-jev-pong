import {
  MOVE_CHOICES,
  type DecisionClient,
  type DecisionOutcome,
  type Move,
  type PongState,
} from "./types";

const PORT = import.meta.env.VITE_LAYA_PORT ?? "8787";
const ENDPOINT = `http://localhost:${PORT}/decide`;
const HEALTH_ENDPOINT = `http://localhost:${PORT}/health`;
const CONNECT_CHECK_TIMEOUT_MS = 1000;

const MOVE_CRITERIA: Move[] = [...MOVE_CHOICES];

interface RawChoiceAnswer {
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
}

function isMove(value: string): value is Move {
  return (MOVE_CHOICES as readonly string[]).includes(value);
}

/** Calls the local Laya inference server (server/laya_server.py) — CLAUDE.md §6. */
export class LayaClient implements DecisionClient {
  readonly source = "laya" as const;

  async decide(state: PongState, signal: AbortSignal): Promise<DecisionOutcome> {
    const started = performance.now();
    try {
      const res = await fetch(ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal,
        body: JSON.stringify({
          state,
          questions: {
            move: {
              type: "choice",
              instructions:
                "Given the ball's position/velocity and this paddle's position, should the paddle move up, down, or stay still right now?",
              criteria: MOVE_CRITERIA,
            },
          },
        }),
      });
      const latencyMs = performance.now() - started;

      if (!res.ok) {
        return { ok: false, reason: "error", detail: `laya server returned HTTP ${res.status}` };
      }

      const payload = (await res.json()) as { answers: { move: RawChoiceAnswer } };
      const answer = payload.answers.move;
      if (!isMove(answer.choice)) {
        return {
          ok: false,
          reason: "error",
          detail: `unrecognized choice from Laya: ${answer.choice}`,
        };
      }

      return {
        ok: true,
        result: { choice: answer.choice, confidence: answer.confidence, latencyMs, source: "laya" },
      };
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        return { ok: false, reason: "timeout", detail: "aborted by shield deadline" };
      }
      return {
        ok: false,
        reason: "disconnected",
        detail: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async checkConnection(): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), CONNECT_CHECK_TIMEOUT_MS);
      const res = await fetch(HEALTH_ENDPOINT, { signal: controller.signal }).finally(() =>
        clearTimeout(timer),
      );
      return res.ok;
    } catch {
      return false;
    }
  }
}
