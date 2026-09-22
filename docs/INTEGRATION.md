# Integration guide

Exact steps to run both real clients — TypeSafe's hosted **Jev** API and a local
**Laya** inference server — plus the handful of places this repo's real implementation
diverges from CLAUDE.md's original spec, and why.

## Prerequisites

- Node.js 18+
- Python 3.11 (pinned in `server/.python-version`)
- A TypeSafe (Jev) API key. Jev is in early access behind a waitlist — get one at
  [console.typesafe.ai](https://console.typesafe.ai).

## 1. Configure environment variables

```sh
cp .env.example .env
```

Edit `.env`:

| Var                | Meaning                                                                  |
| ------------------ | ------------------------------------------------------------------------ |
| `TYPESAFE_API_KEY` | Your real Jev key. Read server-side only — see "Why a proxy" below.      |
| `LAYA_PORT`        | Port the Python server binds to.                                         |
| `VITE_LAYA_PORT`   | Same port, re-exposed to the browser bundle. **Keep these two in sync.** |
| `JEV_MODEL`        | Optional, defaults to `jev-latest`.                                      |

`.env` is gitignored from the repo's first commit — never commit it.

## 2. Install dependencies

```sh
npm install

python -m venv server/.venv
# Windows:
server\.venv\Scripts\pip install -r server\requirements.txt
# macOS/Linux:
server/.venv/bin/pip install -r server/requirements.txt
```

The first install downloads the `laya` package's `typed-decisions` checkpoint
(~800MB) from Hugging Face on first server startup, not at `pip install` time.

## 3. Run

```sh
npm run dev
```

Starts Vite (port 5173, configurable) and the Laya server (`LAYA_PORT`, default 8787)
together via `concurrently`. To run them separately (e.g. to watch each log on its
own):

```sh
npm run dev:web    # vite only
npm run dev:laya   # uvicorn only
```

Open the printed `localhost:5173` URL. Both HUD panels should say "connected" within
a few seconds.

## Real-world deviations from CLAUDE.md's original spec

The spec was written before this repo's build against docs and a live API. A few
things turned out different once verified against the real thing — flagged here
rather than silently diverging.

**Env var name.** §6/§12 named it `JEV_API_KEY`. The real `@typesafe-ai/sdk` reads
`TYPESAFE_API_KEY` by default, so that's what's used here.

**`jevClient.ts` doesn't call TypeSafe's API directly from the browser.** §6 describes
the client making the API call itself. But `render/`/`main.ts` run client-side (canvas

- Vite), and a bearer token used from browser JS ships inside the bundle for anyone to
  read — a real secret-exposure bug, not a style nit, given §12 calls secrets the
  highest-priority concern. Instead, `vite.config.ts` adds a dev-server middleware that
  holds the real `TypeSafeClient` (and the key) **server-side**, inside the Vite process,
  and exposes it at `/api/jev/decide`. `jevClient.ts` posts there instead — same
  per-request timeout/latency-measurement behavior the spec asks for, just proxied
  through a boundary the browser can't read past. This only works under `npm run dev`
  (Vite's dev server); there's no production build path in this repo, matching §10's
  non-goals (no deployment story was asked for).

**`index.html` lives at the repo root, not `public/index.html`.** Vite requires its
app entry HTML at the project root; `public/` is for static assets served verbatim
(this repo's `styles.css` lives there instead).

## Known operational quirks (found by actually running it)

**Laya inference speed is extremely hardware-dependent.** Laya's own docs cite ~40ms
on a Tesla T4 GPU. On CPU-only hardware (no MLX, no CUDA), a single real `/decide`
call was measured at **~880-930ms** during this build — roughly 20x slower. The
default `DEFAULT_ACT_DEADLINE_MS` (400ms, see `src/decisions/shield.ts`) is tuned for
Jev's documented 70-500ms hosted latency, not CPU-bound Laya. On CPU-only hardware,
expect Laya's HUD panel to show mostly shield interventions with "—" for
confidence/latency/agreement — that's an honest result (§2: don't fabricate numbers),
not a bug. If you have GPU or MLX hardware, real Laya decisions should land far more
often; if you're on CPU only, either accept the mostly-shield behavior as the real
finding, or raise the act-deadline (see `Shield`'s constructor / `setActDeadlineMs`)
to see Laya's raw accuracy independent of its local hardware's raw speed.

**The reference `laya_server.py` doesn't cancel in-flight inference.** `agent.predict()`
is a blocking call with no cooperative cancellation; if the shield's client-side abort
fires before it finishes, the Python-side computation keeps running regardless. Under
sustained load this caused a real problem during development — abandoned inference
calls piled up, memory climbed to multiple GB, and the server became fully
unresponsive. The server now rejects (`503`) any `/decide` request that arrives while
one is already in flight rather than queuing unboundedly (see `_predict_lock` in
`server/laya_server.py`), and `shield.ts` paces its retry loop so a fast failure (like
that 503) can't turn into a busy-loop hammering the server. If you see repeated 503s
in the browser console, that's this guard working as intended under real latency
pressure, not a malfunction.

## Troubleshooting

- **"Laya: local server not reachable"** — `server/laya_server.py` isn't running, or
  `VITE_LAYA_PORT` in `.env` doesn't match `LAYA_PORT`. Check `npm run dev:laya`'s
  output; the first startup can take a while while the checkpoint downloads.
- **"Jev proxy unreachable or TYPESAFE_API_KEY missing"** — either Vite isn't running,
  or `.env`'s `TYPESAFE_API_KEY` is empty/missing. Restart `npm run dev:web` after
  editing `.env` — Vite only reads it at startup.
- **CORS errors from the Laya server** — `LAYA_CORS_ORIGIN` (env var read by
  `server/laya_server.py`, default `http://localhost:5173`) must match the origin
  Vite actually serves from.
