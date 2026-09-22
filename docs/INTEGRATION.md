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

`dev:laya` runs through `scripts/dev-laya.mjs`, which locates `server/.venv`'s
Python directly (Windows or POSIX) — you don't need to activate the venv in your
shell first.

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
call was measured at a consistent **~900-970ms** during this build — roughly 20x
slower. The act-deadline is no longer a fixed constant (see `docs/METHODOLOGY.md`'s
safety shield section) — it's the ball's real time-to-arrival for the current rally
leg, so on a short leg even a fast model can get squeezed, and on a long one a slow
one gets real breathing room. Expect Laya's HUD panel to show real decisions landing
often but not always on CPU-only hardware, with honestly very low confidence
(single-digit to low-double-digit %) — the `typed-decisions` checkpoint wasn't
fine-tuned on anything Pong-shaped, and its temperature is clamped in a way that
further distorts confidence on out-of-distribution inputs (a warning to this effect
prints at server startup). Low confidence here is real, measured uncertainty (§2:
don't fabricate numbers), not a bug. If you have GPU or MLX hardware, Laya should be
fast enough that leg length barely matters. If you don't have compatible GPU hardware
locally, see "Running Laya on a real GPU (Colab)" below — that's a genuine ~20x win,
unlike thread-count tuning (tried and measured: forcing all logical cores via
`torch.set_num_threads()` looked like a ~40% win on one lucky sample pair, but didn't
hold up under a proper randomized, repeated comparison on a 6-core/12-thread Ryzen 5
2600 — not worth adding).

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

## Running Laya on a real GPU (Colab)

No CUDA (NVIDIA) or MLX (Apple Silicon) hardware locally? An AMD GPU on Windows, for
instance, has no supported path — `laya`'s own device selection only recognizes
`"cuda"` and `"mps"`, falling back to CPU for anything else, and there's no clean way
to plug DirectML or ROCm into it without forking the library.

`colab/laya_gpu_server.ipynb` runs the exact same model on a free Colab Tesla T4 GPU
instead — close to the ~40ms Laya's own docs cite, vs. ~900-970ms measured CPU-only.
Open it in [Google Colab](https://colab.research.google.com/), set the runtime to a
T4 GPU, and run the cells top to bottom. It needs a free
[ngrok](https://dashboard.ngrok.com/signup) account (Colab has no public IP of its
own, so ngrok tunnels the server out to a real HTTPS URL). The last cell prints a
`VITE_LAYA_BASE_URL` line — paste that into your local `.env` and restart
`npm run dev:web`. You no longer need `server/laya_server.py` running locally at all;
`layaClient.ts` talks straight to the tunnel.

Two things specific to this path:

- Free ngrok URLs serve an HTML interstitial to any request with a real browser
  User-Agent unless it carries an `ngrok-skip-browser-warning` header — `layaClient.ts`
  already sends this on every request, so it's transparent, but worth knowing if you
  ever hit the endpoint from `curl` without that header and get HTML back instead of
  JSON.
- The tunnel only exists while the Colab notebook cell is running — closing the tab
  or an idle disconnect kills it, and free-tier ngrok URLs change on every rerun.
  Fine for active development, not something to leave running unattended.

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
