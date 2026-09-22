# Build checklist

Tracks the implementation of CLAUDE.md, broken into commit-sized units along
the repo's module boundaries. Check items off as they're committed — see
"Staged Commit Workflow" in CLAUDE.md for the process.

## Milestone 0 — scaffold & tooling

- [x] `package.json`, `tsconfig.json`, `.eslintrc.cjs`, `.prettierrc`
- [x] `.gitignore`, `.env.example`, `.pre-commit-config.yaml`
- [x] `LICENSE`
- [x] `vite.config.ts` (incl. the Jev proxy middleware — see decisions below)

## Milestone 1 — game core (no decision logic; planner drives both paddles)

- [x] `src/game/state.ts` — `GameState`, `PongState` serializer/mirroring
- [x] `src/game/physics.ts` — pure ball/paddle physics, capped speed ramp
- [x] `src/game/loop.ts` — fixed-tick loop, decoupled from render/decisions
- [ ] `src/render/canvas.ts` — court/paddle/ball/score drawing + HUD/log/status DOM hooks
- [ ] `public/index.html` — canvas + HUD/status/log markup
- [ ] `src/main.ts` (v1) — wires loop + render, both paddles planner-controlled
- [ ] Manual check: `npm run dev`, confirm a planner-vs-planner rally renders correctly

## Milestone 2 — Laya local server + client (build first: local, no rate limits)

- [ ] `server/requirements.txt`, `server/.python-version`
- [ ] `server/laya_server.py` — FastAPI wrapper around `laya` (typed-decisions checkpoint), `/decide` + `/health`
- [ ] `src/decisions/types.ts` — shared `DecisionResult`/`DecisionClient`/etc. types
- [ ] `src/decisions/layaClient.ts` — browser client for the local Laya server
- [ ] **STOP for confirmation**: first successful real `/decide` round trip against a running local Laya server

## Milestone 3 — Jev client (real hosted API)

- [ ] `src/decisions/jevClient.ts` — browser client calling the local `/api/jev/decide` proxy
- [ ] Wire the Jev proxy plugin into `vite.config.ts` (server-side key handling)
- [ ] **STOP for confirmation**: before wiring a real `TYPESAFE_API_KEY` and making the first live call

## Milestone 4 — shield + planner

- [x] `src/decisions/planner.ts` — deterministic ground-truth move
- [x] `src/decisions/shield.ts` — act-deadline race, assisted/unassisted modes, intervention logging
- [ ] `src/main.ts` (v2) — swap planner-only control for shielded Laya + Jev clients per side

## Milestone 5 — stats + docs

- [ ] `src/stats/metrics.ts` — agreement rate, latency p50/p95, shield-intervention rate, requests-in-flight
- [ ] `src/stats/log.ts` — structured per-tick decision log + export
- [ ] `src/main.ts` (v3) — wire stats into HUD + decision feed
- [ ] `docs/METHODOLOGY.md`
- [ ] `docs/PONG_DEMO.md`
- [ ] `docs/INTEGRATION.md` (incl. the Jev-proxy-for-secrecy deviation from §6's literal "client calls API directly")
- [ ] `README.md` — real write-up, how to run both servers

## Notes / deviations from the literal CLAUDE.md text (flag if you disagree)

- Real Jev env var is `TYPESAFE_API_KEY` (the actual SDK's default), not
  `JEV_API_KEY` as originally guessed in CLAUDE.md §6/§12 — confirmed against
  the live `@typesafe-ai/sdk` docs.
- `jevClient.ts` does **not** call `api.typesafe.ai` directly from the
  browser. Since `render`/`main` run client-side (canvas + Vite), a bearer
  token used from browser JS would ship inside the bundle. Instead, a Vite
  dev-server middleware (`vite.config.ts`) holds the real key server-side and
  exposes `/api/jev/decide` locally; the browser client only ever talks to
  that. Documented in `docs/INTEGRATION.md` once written.
