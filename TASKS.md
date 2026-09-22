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
- [x] `src/render/canvas.ts` — court/paddle/ball/score drawing + HUD/log/status DOM hooks
- [x] `index.html` (repo root, not `public/` — see deviation note) + `public/styles.css`
- [x] `src/main.ts` (v1) — wires loop + render, both paddles planner-controlled
- [x] Manual check: `npm run dev`, confirmed via headless-browser screenshots that a
      planner-vs-planner rally renders and paddles track the ball, no console errors

## Milestone 2 — Laya local server + client (build first: local, no rate limits)

- [x] `server/requirements.txt`, `server/.python-version`, `server/pyproject.toml` (ruff config)
- [x] `server/laya_server.py` — FastAPI wrapper around `laya` (typed-decisions checkpoint), `/decide` + `/health`, CORS for the Vite origin
- [x] `src/decisions/types.ts` — shared `DecisionResult`/`DecisionClient`/etc. types (committed earlier)
- [x] `src/decisions/layaClient.ts` — browser client for the local Laya server
- [x] **CONFIRMED & VERIFIED**: real `/decide` round trip against a running local Laya server.
      `pip install -r server/requirements.txt` in `server/.venv`, downloaded the `typed-decisions`
      checkpoint from Hugging Face, started uvicorn, and curled `/decide` with a synthetic Pong
      state — got back `{"choice":"down","confidence":0.0123,"probabilities":{...}}`. Low
      confidence is expected: this checkpoint was fine-tuned on ticket-routing/invoice/security
      workflows, not Pong, so it's honestly uncertain on a novel domain rather than confidently
      wrong. Server stopped after verification (not left running).

## Milestone 3 — Jev client (real hosted API)

- [x] `src/decisions/jevClient.ts` — browser client calling the local `/api/jev/decide` proxy
- [x] Wire the Jev proxy plugin into `vite.config.ts` (server-side key handling)
- [x] **CONFIRMED & VERIFIED**: real Jev API call through the local proxy. User added a real
      `TYPESAFE_API_KEY` to `.env` (gitignored, never committed); `npm run dev:web` + curling
      `/api/jev/decide` with a synthetic Pong state returned a real `jev-1.13.0` response —
      `{"choice":"up","confidence":0.68,"probabilities":{"up":0.79,"down":0.1,"stay":0.11}}` — a
      sensible answer for a ball well above paddle center. Test server stopped after verification.

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
- `index.html` lives at the repo root, not `public/index.html` as CLAUDE.md §3
  lists it — Vite requires the app entry HTML at the project root; `public/`
  is reserved for static assets copied verbatim (styles.css lives there).
- `jevClient.ts` does **not** call `api.typesafe.ai` directly from the
  browser. Since `render`/`main` run client-side (canvas + Vite), a bearer
  token used from browser JS would ship inside the bundle. Instead, a Vite
  dev-server middleware (`vite.config.ts`) holds the real key server-side and
  exposes `/api/jev/decide` locally; the browser client only ever talks to
  that. Documented in `docs/INTEGRATION.md` once written.
