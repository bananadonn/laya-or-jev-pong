# The Pong demo

How this benchmark works, end to end. Mirrors the shape of the `laya-vs-jev`
T-Rex/Snake demo docs this repo is modeled on — same methodology, new game.

## What you're looking at

Classic 2-paddle Pong, but neither paddle is played by a human. **Laya** (local,
teal, left) and **Jev** (hosted, orange, right) each control one paddle, answering
the same reactive question — up, down, or stay — every tick, from their own
side-mirrored view of the ball. See `docs/METHODOLOGY.md` for exactly how that
question is asked and judged.

The ball speeds up slightly (capped) on every paddle hit, so later in a long rally
both sides are under more time pressure to react — without an artificial difficulty
ramp bolted on separately.

## Reading the HUD

Each side panel (left = Laya, right = Jev) shows, top to bottom:

- **Connection status** — a live "connected" / "not reachable" indicator per side
  (§8's explicit requirement: a dead local server or a missing API key should be
  obvious at a glance, not silently produce fabricated numbers).
- **Last move** — the move actually committed to the paddle this cycle, whether it
  came from the model or the shield.
- **Confidence / Last latency** — only populated when a real decision arrived in
  time; stays at "—" through shield interventions rather than showing a stale or
  invented number.
- **p50 / p95** — this side's latency distribution so far (`docs/METHODOLOGY.md`).
- **Agreement** — this side's best-move agreement % so far, excluding interventions.
- **Shield interventions** — a running count of cycles the shield had to cover for
  this side.
- **In flight** — how many decision requests are currently outstanding for this side
  (normally 0 or 1).
- **Decision feed** — the most recent decisions for this side, newest first; a
  shield intervention is visually distinct (`shield -> <move>`) from a real answer
  (`<move> (confidence%, latency)`).

## Controls

- **Laya unassisted / Jev unassisted** — per-side toggle that disables the shield
  for that side only, so you can watch a model's raw, unprotected performance
  (`docs/METHODOLOGY.md`).
- **Restart match** — resets the ball, paddles, and score. Does **not** touch
  cumulative stats (agreement, interventions, latency history) — this is a fresh
  game against the same running totals.
- **Reset stats** — clears cumulative stats (log + metrics) without touching the
  live match in progress. The two are deliberately independent, per CLAUDE.md §8.

## What's real vs. what isn't

Everything on screen comes from an actual response or an actual timeout — there is
no mock phase in this build (CLAUDE.md §2, §6). If a number can't currently be
measured (a side is disconnected, or hasn't produced a non-intervened decision yet),
the UI shows "—" rather than a placeholder value. `docs/INTEGRATION.md` documents
real operational behavior worth knowing before you draw conclusions from a run — in
particular, that Laya's local inference speed is highly hardware-dependent, and that
a tight act-deadline on slow hardware will produce a very different-looking match
than the same deadline on fast hardware.

## Running it yourself

See `docs/INTEGRATION.md` for exact setup (API key, local server, env vars) and
`README.md` for the quick version.
