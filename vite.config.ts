import {
  APIConnectionError,
  APIError,
  APITimeoutError,
  APIUserAbortError,
  TypeSafeClient,
} from "@typesafe-ai/sdk";
import type { IncomingMessage, ServerResponse } from "node:http";
import { defineConfig, loadEnv, type Plugin } from "vite";

interface ProxyRequestBody {
  state?: unknown;
  questions?: Record<string, unknown>;
  timeoutMs?: number;
}

// @typesafe-ai/sdk's own `timeout` option has a real bug: it sets an
// internal timer that isn't always cleaned up once a request settles, and
// when that stale timer later fires and tries to abort an
// already-completed request, it throws *inside that raw timer callback* -
// outside any promise chain a try/catch can reach. Verified directly: this
// crashed the whole Vite dev server (a genuine native libuv assertion
// failure, not just an uncaught JS exception - no try/catch or even
// process.on('uncaughtException') can stop that once it happens).
//
// The fix is to never pass `timeout` to the SDK at all, and drive
// cancellation ourselves with a plain AbortController + setTimeout instead
// - the same well-tested mechanism this repo's own clients already use.
// The SDK accepts an external `signal` for exactly this purpose.
const DEFAULT_PROXY_TIMEOUT_MS = 2000;

async function handleDecide(
  client: TypeSafeClient,
  model: string,
  rawBody: string,
  res: ServerResponse,
): Promise<void> {
  const parsed = JSON.parse(rawBody) as ProxyRequestBody;
  const timeoutMs =
    typeof parsed.timeoutMs === "number" && parsed.timeoutMs > 0
      ? parsed.timeoutMs
      : DEFAULT_PROXY_TIMEOUT_MS;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const result = await client.systemOne(
      { state: parsed.state, questions: parsed.questions, model } as Parameters<
        TypeSafeClient["systemOne"]
      >[0],
      { signal: controller.signal },
    );
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(result));
  } catch (err) {
    res.setHeader("content-type", "application/json");
    if (err instanceof APITimeoutError || err instanceof APIUserAbortError) {
      // APIUserAbortError is what we expect from our own controller.abort()
      // firing (see the timer above) - same "timeout" shape jevClient.ts
      // already handles, since from the caller's perspective it's the same
      // thing: no answer arrived in time.
      res.statusCode = 504;
      res.end(JSON.stringify({ error: "timeout", detail: err.message }));
    } else if (err instanceof APIConnectionError) {
      res.statusCode = 502;
      res.end(JSON.stringify({ error: "disconnected", detail: err.message }));
    } else if (err instanceof APIError) {
      res.statusCode = err.status ?? 502;
      res.end(JSON.stringify({ error: "api_error", detail: err.message }));
    } else {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: "error", detail: String(err) }));
    }
  } finally {
    // always clear our own timer once the request settles - an abort()
    // fired against a signal nobody's listening to anymore is a defined,
    // harmless no-op (unlike whatever the SDK's own internal timer was
    // doing), but there's no reason to leave it pending regardless.
    clearTimeout(timer);
  }
}

/**
 * The Jev bearer token must never reach browser JS (CLAUDE.md §12: secrets
 * are the highest-priority item). This plugin runs the TypeSafe SDK
 * server-side, inside the Vite dev server process, and exposes a single
 * local-only JSON endpoint. `src/decisions/jevClient.ts` calls that endpoint
 * instead of the TypeSafe API directly — the key stays out of the bundle.
 */
function jevProxyPlugin(apiKey: string | undefined, model: string): Plugin {
  const client = apiKey ? new TypeSafeClient({ apiKey }) : null;

  return {
    name: "jev-proxy",
    configureServer(server) {
      server.middlewares.use("/api/jev/decide", (req: IncomingMessage, res: ServerResponse) => {
        if (req.method !== "POST") {
          res.statusCode = 405;
          res.end();
          return;
        }
        if (!client) {
          res.statusCode = 503;
          res.setHeader("content-type", "application/json");
          res.end(
            JSON.stringify({ error: "missing_api_key", detail: "TYPESAFE_API_KEY is not set" }),
          );
          return;
        }
        const activeClient = client;

        let body = "";
        req.on("data", (chunk: Buffer) => (body += chunk.toString()));
        req.on("end", () => {
          void handleDecide(activeClient, model, body, res);
        });
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  return {
    plugins: [jevProxyPlugin(env.TYPESAFE_API_KEY, env.JEV_MODEL || "jev-latest")],
    server: { port: 5173 },
  };
});
