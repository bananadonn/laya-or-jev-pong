import { APIConnectionError, APIError, APITimeoutError, TypeSafeClient } from "@typesafe-ai/sdk";
import type { IncomingMessage, ServerResponse } from "node:http";
import { defineConfig, loadEnv, type Plugin } from "vite";

interface ProxyRequestBody {
  state: unknown;
  questions: Record<string, unknown>;
  timeoutMs: number;
}

async function handleDecide(
  client: TypeSafeClient,
  model: string,
  rawBody: string,
  res: ServerResponse,
): Promise<void> {
  try {
    const { state, questions, timeoutMs } = JSON.parse(rawBody) as ProxyRequestBody;
    const result = await client.systemOne(
      { state, questions, model } as Parameters<TypeSafeClient["systemOne"]>[0],
      { timeout: timeoutMs },
    );
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(result));
  } catch (err) {
    res.setHeader("content-type", "application/json");
    if (err instanceof APITimeoutError) {
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
