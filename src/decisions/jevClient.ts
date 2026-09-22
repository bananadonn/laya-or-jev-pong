import {
  MOVE_CHOICES,
  normalizeProbabilities,
  type DecisionClient,
  type DecisionOutcome,
  type Move,
  type PongState,
} from "./types";

const ENDPOINT = "/api/jev/decide";
const CONNECT_CHECK_TIMEOUT_MS = 2000;

const MOVE_CRITERIA: Record<Move, string> = {
  up: "the paddle should move up",
  down: "the paddle should move down",
  stay: "the paddle should not move",
};

interface RawChoiceAnswer {
  type: "choice";
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
}

function isMove(value: string): value is Move {
  return (MOVE_CHOICES as readonly string[]).includes(value);
}

/**
 * Talks to the local Vite dev-server proxy (vite.config.ts), which holds the
 * real TYPESAFE_API_KEY server-side and forwards to TypeSafe's hosted Jev
 * API — the browser bundle never sees the bearer token (CLAUDE.md §12).
 */
export class JevClient implements DecisionClient {
  readonly source = "jev" as const;

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
          // give the proxy a little headroom over the shield's own deadline so
          // *it* is the one that reports the timeout, not a generic abort.
          timeoutMs: 2000,
        }),
      });
      const latencyMs = performance.now() - started;

      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string; detail?: string };
        if (body.error === "timeout") {
          return {
            ok: false,
            reason: "timeout",
            detail: body.detail ?? "jev proxy reported a timeout",
          };
        }
        if (body.error === "missing_api_key" || body.error === "disconnected") {
          return { ok: false, reason: "disconnected", detail: body.detail ?? `HTTP ${res.status}` };
        }
        return { ok: false, reason: "error", detail: body.detail ?? `HTTP ${res.status}` };
      }

      const payload = (await res.json()) as { answers: { move: RawChoiceAnswer } };
      const answer = payload.answers.move;
      if (!isMove(answer.choice)) {
        return {
          ok: false,
          reason: "error",
          detail: `unrecognized choice from Jev: ${answer.choice}`,
        };
      }

      return {
        ok: true,
        result: {
          choice: answer.choice,
          confidence: answer.confidence,
          probabilities: normalizeProbabilities(answer.probabilities),
          latencyMs,
          source: "jev",
        },
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
      const res = await fetch(ENDPOINT, {
        method: "POST",
        signal: controller.signal,
        body: "{}",
      }).finally(() => clearTimeout(timer));
      // any response (even a 4xx from a malformed probe body) means the proxy
      // + upstream key are wired up; only a network failure means "down".
      return res.status !== 503;
    } catch {
      return false;
    }
  }
}
