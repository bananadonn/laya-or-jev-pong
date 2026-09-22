# Laya vs. Jev: Pong

A head-to-head benchmark where two "typed-decision" inference APIs — TypeSafe's **Jev**
(hosted) and **Laya** (local/fast) — each control one paddle in a game of Pong. The
match is the benchmark: same task, same tick rate, same physics, two different
latency/accuracy profiles fighting it out in real time.

This doc is the spec for the repo. Read it before writing code. It follows the shape
of the `laya-vs-jev` T-Rex/Snake benchmark repo (planner + safety shield + assisted vs.
unassisted scoring) — same methodology, new game.

---

## 1. What we're actually testing

Both models answer the same question every tick, from the same state, in parallel:

> "Given the ball's position and velocity and this paddle's position, should the
> paddle move UP, DOWN, or STAY?"

That's a `choice` primitive over three options — no lookahead required, no
multi-step planning, just a fast reactive judgment. This keeps both models inside
their strong zone (see: PlayJev scoring near-teacher on Pong-adjacent reactive games
like Space Invaders/Racer, and poorly on lookahead-heavy games like Tetris/2048 — we
are deliberately _not_ building the lookahead-heavy version of this problem).

The interesting variable isn't "which model is smarter." It's:

> **Does Jev's (claimed) judgment quality offset its far higher hosted latency, or
> does Laya just win on reaction time alone regardless of accuracy?**

That's an open question. The repo should be built to let the match answer it, not to
assume an answer.

---

## 2. Ground rules (read this before building anything)

- **Both clients are real integrations, not mocks.** A Jev API key is available
  (TypeSafe hosted API), and Laya is being integrated as a real local model (the
  `laya` package — ModernBERT-based checkpoints, run via MLX or transformers,
  per its published docs). There is no mock phase in this build — §6 covers real
  integration for both from the start. Secrets (the Jev API key) must never be
  committed; load from an env var / `.env` (git-ignored) and document the
  expected var name in `docs/INTEGRATION.md`.
- **Be honest about what's measured vs. estimated.** Every number the demo
  displays should come from an actual response (real latency, real returned
  probability/choice). If something genuinely can't be measured live yet (say,
  Laya isn't running on a given machine), the UI should say so plainly rather
  than silently falling back to invented numbers.
- **No lookahead requirement.** If a feature request would require either model to
  plan more than one tick ahead (e.g. predicting where to _position_ well in advance
  of a return), push back on it — that changes what's being tested and breaks the
  comparison to the published reactive-game benchmarks this project is built on.
- **Handle real-world API failure paths.** A real Jev call can fail, rate-limit,
  or simply be slow in ways a mock never was — the safety shield (§7) is no longer
  a demo flourish, it's load-bearing. Build and test it against real timeouts, not
  assumed ones.

---

## 3. Repo structure

```
laya-vs-jev-pong/
├── CLAUDE.md                  # this file
├── README.md                  # public-facing summary, screenshots/gif, how to run
├── LICENSE                    # MIT (this is our own code, our own Pong — no clone to license)
├── package.json
├── tsconfig.json
├── .eslintrc.cjs
├── .prettierrc
├── .gitignore                 # must include .env from the first commit
├── .env.example                # documents JEV_API_KEY + Laya server port, no real values
├── .pre-commit-config.yaml     # gitleaks + tsc --noEmit + lint, see §12
├── src/
│   ├── game/
│   │   ├── physics.ts         # ball + paddle physics, pure functions, no rendering
│   │   ├── state.ts           # game state type + the state->JSON serializer sent to each model
│   │   └── loop.ts            # fixed-tick game loop, decoupled from render
│   ├── decisions/
│   │   ├── types.ts           # shared Decision / DecisionRequest / DecisionResult types
│   │   ├── planner.ts         # deterministic ground-truth "correct move" function
│   │   ├── shield.ts          # safety-shield fallback: what happens when a decision is late/missing
│   │   ├── jevClient.ts       # Jev decision client — real TypeSafe API call
│   │   └── layaClient.ts      # Laya decision client — calls the local Laya server
│   ├── stats/
│   │   ├── metrics.ts         # agreement rate, latency stats, shield-intervention rate, per §7
│   │   └── log.ts             # structured per-tick decision log (for replay/export)
│   ├── render/
│   │   └── canvas.ts          # all drawing; knows nothing about decision logic
│   └── main.ts                # wires game loop + both clients + render + stats together
├── server/
│   ├── laya_server.py         # small FastAPI/Flask wrapper around the laya package
│   ├── requirements.txt       # pinned deps, see §12
│   └── .python-version
├── public/
│   └── index.html
└── docs/
    ├── PONG_DEMO.md            # how this benchmark works, mirrors T-Rex/Snake demo docs
    ├── METHODOLOGY.md          # scoring definitions, what "agreement" and "assisted" mean here
    └── INTEGRATION.md          # exact steps to configure real Jev + run the real Laya server
```

Keep `game/`, `decisions/`, `stats/`, and `render/` strictly separated — the whole
point of the architecture is that the game doesn't care which model (or the mock) is
answering, and the stats layer doesn't care how the answer was produced. If a change
requires touching more than one of these to add a feature, that's a sign the
boundary is leaking.

---

## 4. Game design

- Classic 2-paddle Pong. Fixed-size court, ball bounces off top/bottom walls and
  paddles, resets to center (with randomized initial angle) after a point.
- **Left paddle = Laya. Right paddle = Jev.** Visually distinct colors, each
  labeled clearly on screen (not just in a legend) so it's obvious at a glance
  which side is which.
- Ball speed increases slightly after each paddle hit (small, capped increment) —
  this is what stresses the latency comparison over the course of a rally without
  needing an artificial difficulty ramp bolted on separately.
- No player-controlled paddle in v1. This is model vs. model. (A "play against
  Jev yourself" mode is a reasonable v2 idea — don't build it now.)

---

## 5. State + decision schema

State sent to each model, every tick (both models see identical state, only
mirrored in x for the side they're on):

```ts
type PongState = {
  ball: { x: number; y: number; vx: number; vy: number };
  paddle: { y: number; height: number };
  court: { width: number; height: number };
  speed_tier: number; // increments as the rally continues
};
```

Question asked (typed `choice`, three options):

```json
{
  "move": {
    "type": "choice",
    "instructions": "Given the ball and paddle state, should the paddle move up, down, or stay still right now?",
    "criteria": ["up", "down", "stay"]
  }
}
```

Response shape both mock clients (and, later, real clients) must normalize to:

```ts
type DecisionResult = {
  choice: "up" | "down" | "stay";
  confidence: number; // 0–1
  latencyMs: number;
  source: "jev" | "laya";
};
```

---

## 6. Real clients — Jev (hosted) + Laya (local)

Each client is its own file (`jevClient.ts`, `layaClient.ts`) exposing the same
async signature, e.g. `decide(state: PongState): Promise<DecisionResult>`, so the
game/stats layers never know or care which one they're talking to.

**`jevClient.ts` (real, TypeSafe hosted API)**

- `POST` to TypeSafe's `/v1/decide`-style endpoint (confirm exact path/shape
  against current TypeSafe docs — it may have changed since we last checked),
  auth via bearer token read from an env var (e.g. `JEV_API_KEY`), never hardcoded.
- Request body: `{ state, questions: { move: { type: "choice", instructions: "...", criteria: ["up","down","stay"] } } }`
  matching the schema in §5.
- Normalize the response into `DecisionResult`: pull the winning choice + its
  probability out of `answers.move`, and measure real round-trip latency
  client-side (timestamp before the call, timestamp on response) rather than
  trusting any latency figure the API itself might report.
- Timeouts: set an explicit fetch timeout (don't rely on the browser/Node
  default) so a hung request can't silently starve the shield logic — a timeout
  should resolve as "no decision," same as a dropped request.

**`layaClient.ts` (real, local model)**

- Because Laya is a Python package (`laya`, ModernBERT-based, MLX/transformers
  runtime) and this repo's game/UI layer is TypeScript, the cleanest integration
  is a **small local inference server**: a minimal Python process (FastAPI/Flask,
  whatever's lightest) that loads the Laya router once at startup and exposes one
  endpoint accepting `{ state, questions }` and returning the same shape Jev
  returns. `layaClient.ts` then just calls `http://localhost:<port>/decide` —
  same interface as Jev from the game's point of view, different backend.
- Document exact local setup in `docs/INTEGRATION.md`: `pip install laya`,
  which checkpoint to load (`convaiinnovations/laya` vs. the `typed-decisions`
  checkpoint — the typed-decisions one is likely the better fit given this is
  literally a typed `choice` decision), and how to run the local server
  alongside the main app (a `dev` script that starts both).
- Measure real local latency the same way as Jev — timestamp-based, not
  self-reported — so the two sides are compared on equal footing.

**Both clients must fail loudly, not silently.** If Laya's local server isn't
running, or the Jev key is missing/invalid, that side of the UI should show a
clear "not connected" state rather than quietly producing fabricated numbers.

---

## 7. Safety shield + scoring methodology

Mirror the T-Rex repo's split between raw judgment and real-world-safe outcome:

- **Shield**: if a tick's act-deadline arrives and a model's decision hasn't
  resolved yet, the shield acts on that paddle's behalf using the deterministic
  planner, and this is logged as a shield intervention for that side, not as a
  model decision.
- **Best-move agreement** (raw capability metric): of the decisions that _did_
  arrive in time, what fraction matched the deterministic planner's correct move?
  Tracked **independently per model**, unaffected by the shield.
- **Assisted outcome** (real-world metric): the actual match score, rally length,
  and point-per-model — this reflects the shield's influence, same as the T-Rex
  repo's "assisted score" vs. "unassisted" distinction. Support an `--unassisted`
  style flag/toggle that disables the shield for a given side, so you can watch a
  model's raw, unprotected performance if you want it.
- Track **latency distribution** (p50/p95, not just an average) and **requests
  in flight** per side, same as the Jev Reflex demo, so the "does speed or
  accuracy win" question has real numbers behind it, not just a final score.

`docs/METHODOLOGY.md` should define all of the above precisely, so results are
reproducible and legible to someone who didn't build this.

---

## 8. UI / demo requirements

- Live court view (canvas), both paddles moving, ball in motion, score display.
- Per-side HUD panel: current decision + confidence, last latency, running
  best-move agreement %, shield intervention count — mirrored left (Laya) and
  right (Jev) so the comparison is visually symmetric.
- A **connection status indicator** per side (e.g. "Jev: connected" / "Laya:
  local server not running") — since both clients are real, the failure mode to
  design for is a dead connection, not an unlabeled mock.
- Decision feed log (recent N decisions per side), same pattern as the Jev Reflex
  demo, for the "watch it work" visual feedback quality you specifically wanted
  out of a game-based demo.
- Reset/restart controls, and a way to reset cumulative stats separately from
  restarting the current match.

---

## 9. Milestones

1. **Game core** — physics, fixed-tick loop, rendering, no decision logic yet
   (paddles planner-controlled to validate the game itself works before any
   API is in the loop).
2. **Laya local server + client** — stand up the local Python inference
   server, confirm `layaClient.ts` gets real, sane responses with real
   measured latency. Easiest to get fully working first since there's no
   external rate limit or network dependency to fight.
3. **Jev client** — wire in the real API key, confirm real responses/latency
   against the live endpoint. Build the timeout/failure handling here deliberately
   (§2, §6) rather than discovering it later mid-match.
4. **Shield + planner** — the deterministic ground-truth function and the
   safety-shield fallback, now tested against real (not simulated) latency and
   failure behavior from both clients.
5. **Stats + methodology docs** — metrics.ts, log.ts, docs/METHODOLOGY.md,
   docs/PONG_DEMO.md, using real logged data from actual runs, not estimated
   figures.

Get one client (Laya, since it's local and has no waitlist/rate-limit
friction) fully working end-to-end before wiring up the second — easier to
debug the game/shield/stats architecture against one real, fast, reliable
source before adding Jev's network variability into the mix.

---

## 10. Explicit non-goals (don't build these unless asked)

- Player-controlled paddle / "play against the AI" mode
- Any multi-step lookahead or predictive positioning ahead of the current tick
- Tournament/multi-round meta-game structure
- Any UI chrome beyond what's needed to read the live match and the stats
  described above

---

## 12. Tooling & lint rules

Set these up as part of the initial scaffold, not as a later pass — they exist
specifically to protect the parts of this project most likely to go wrong
(silent async failures, leaked secrets, architecture boundary erosion).

**TypeScript / `tsconfig.json`**

- `"strict": true` — with two async clients returning normalized types, the
  compiler should catch a missed `null`/undefined latency or a malformed
  `DecisionResult` before it's a runtime surprise mid-match.
- `noUncheckedIndexedAccess` — forces the decision log / stats arrays to handle
  "what if this is empty" explicitly.
- `noUnusedLocals`, `noUnusedParameters` — keeps the repo clean for anyone
  reading it.

**ESLint**

- `@typescript-eslint/no-floating-promises` — the important one here. Both
  clients fire an async call every tick; an unhandled rejected promise is
  exactly how a real failure sneaks past the shield instead of triggering it.
- `eslint-plugin-promise` — flags missing `.catch()` and similar, same reasoning.
- `import/no-cycle` — catches accidental coupling between `game/`, `decisions/`,
  and `stats/` before it erodes the layer separation this plan depends on.
- A custom `no-restricted-imports` rule stopping `render/` from importing
  anything out of `decisions/` — enforces that boundary directly rather than
  relying on convention.

**Prettier**

- Checked-in `.prettierrc`, plus an import-sorting plugin — low effort, keeps
  the client/game/stats files consistent as they grow.

**Secrets — the highest-priority item given the real Jev key**

- `.gitignore` must include `.env` from the very first commit, not added later.
- `gitleaks` (or `git-secrets`) as a pre-commit hook, scanning for anything
  that looks like an API key before it's committed.
- `.env.example` committed (no real values) documenting `JEV_API_KEY` and the
  Laya server port var, so the repo is self-documenting for a clone-and-run.

**Python (`server/`)**

- `ruff` for lint + format in one tool — minimal config overhead for a small
  FastAPI/Flask wrapper.
- Pinned `requirements.txt` (or `uv`/`pip-compile`) so the Laya checkpoint and
  MLX/transformers versions are reproducible across machines.

**Enforcement**

- A pre-commit hook (`.pre-commit-config.yaml`) running `tsc --noEmit`, the
  linter, and `gitleaks` before any commit is allowed — since this repo is
  meant to be largely self-driven by Claude Code across iterations, enforcing
  these automatically matters more than it would on a hand-written project.

---

## 13. Staged Commit Workflow

The build is tracked in `TASKS.md` as a checklist broken into commit-sized
units along this file's module boundaries (`game/`, `decisions/`, `server/`,
`stats/`, `render/`, `docs/`, config). Nothing gets committed as one large
blob — each checklist item is its own commit. The process, for the rest of
this build:

- For each unchecked item in `TASKS.md`: implement it, run `tsc --noEmit`
  and the linter, and only if both pass, stage just the files that item
  touched, commit with a message describing what changed and why, check the
  box in `TASKS.md`, then move to the next item.
- If a check (typecheck, lint, or the gitleaks pre-commit hook) fails twice
  in a row on the same task, stop and flag it rather than continuing to the
  next task.
- Pause and wait for explicit confirmation before proceeding past any task
  that involves real credentials or external services — specifically:
  wiring up the real Jev API client, and first getting the Laya local server
  running successfully. Everything else in the checklist runs through
  automatically without stopping for approval.
- Commit locally after each task; push once per completed milestone (§9)
  rather than after every individual commit, so pushes represent a coherent,
  working chunk.

---

## 14. Open questions for whoever picks this up in Claude Code

- Should ball speed increases be uncapped over a long rally (stress-testing both
  latency profiles harder over time), or capped at a fixed ceiling? Leaning
  capped, to keep matches comparable across runs — flag if you disagree.
- Framework choice for `src/`: plain TS + Canvas (matches the dependency-free
  spirit of the Jev Reflex HTML demo and the T-Rex repo's own minimal footprint)
  vs. a lightweight framework — default to plain TS + Canvas unless there's a
  concrete reason to add a dependency.
- Should the Laya local server be checked into this repo (a `server/` folder,
  Python + requirements.txt) or treated as a separate sibling project this repo
  just points at? Leaning toward checking it in, since a one-repo "clone and
  run" experience matters for a portfolio piece — flag if that's wrong.
- Confirm the current TypeSafe API request/response shape against their live
  docs before writing `jevClient.ts` — the shape in §5/§6 is our best
  understanding from what we've read, not a verified spec.
