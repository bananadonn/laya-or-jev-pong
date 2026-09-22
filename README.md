# Laya vs. Jev: Pong

A head-to-head benchmark where two real "typed-decision" inference APIs each control
one paddle in a game of Pong: **Laya** (Convai Innovations' local, open-weights
decision model) on the left, **Jev** (TypeSafe AI's hosted "System One" model) on the
right. Same task, same tick rate, same physics — the match is the benchmark.

> Does Jev's judgment quality offset its far higher hosted latency, or does Laya just
> win on reaction time alone regardless of accuracy? The repo is built to let the
> match answer that, not to assume one.

Both integrations are real — a real hosted API call to TypeSafe, a real local
`laya` model inference — with a safety shield covering either side when its answer
doesn't arrive in time. See `docs/METHODOLOGY.md` for exactly what's measured and how.

## Quick start

```sh
cp .env.example .env   # fill in TYPESAFE_API_KEY
npm install
python -m venv server/.venv && server/.venv/bin/pip install -r server/requirements.txt
npm run dev
```

Full setup (including Windows venv activation, CORS, and troubleshooting) is in
[`docs/INTEGRATION.md`](docs/INTEGRATION.md).

## Docs

- [`docs/PONG_DEMO.md`](docs/PONG_DEMO.md) — what the UI shows and how to read it
- [`docs/METHODOLOGY.md`](docs/METHODOLOGY.md) — precise definitions for every metric
- [`docs/INTEGRATION.md`](docs/INTEGRATION.md) — real setup steps, plus every place
  the implementation had to diverge from the original spec once checked against the
  live API/package, and why

## Architecture

```
src/
├── game/        # physics, state, fixed-tick loop — no idea a "model" exists
├── decisions/   # planner, shield, and the Jev/Laya clients
├── stats/       # agreement/latency/intervention metrics — no idea how a decision was produced
├── render/      # canvas + HUD drawing — no idea decisions/ exists
└── main.ts      # the only file that wires all four together
server/
└── laya_server.py   # small FastAPI wrapper around the real `laya` package
```

`game/`, `decisions/`, `stats/`, and `render/` are strictly separated — enforced by an
ESLint rule that blocks `render/` from importing anything out of `decisions/`. The
game doesn't care which model (or none) is answering, and the stats layer doesn't
care how an answer was produced.

## Status

Both real integrations (Laya local server, Jev hosted API) are wired up and verified
end-to-end. See `TASKS.md` for the full build log, including two real bugs found and
fixed while testing the Laya server under sustained load.

## License

MIT — see [`LICENSE`](LICENSE). This is an original implementation of Pong, not a
clone of any existing codebase.
