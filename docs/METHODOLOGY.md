# Methodology

Precise definitions for every number this demo shows, so a result is reproducible and
legible to someone who didn't build it. Mirrors the split this repo's spec (CLAUDE.md
§7) borrows from the `laya-vs-jev` T-Rex/Snake benchmark: raw judgment vs.
real-world-safe outcome.

## The question

Every tick, each paddle's controller is asked one `choice` question over its own
(side-mirrored) view of the ball and paddle state — see `src/decisions/types.ts` for
the exact `PongState` shape and `src/game/state.ts#toPongState` for the mirroring.
Both models answer the identical question shape; only which side of the court they're
defending differs.

## The deterministic planner (`src/decisions/planner.ts`)

The ground truth a decision is judged against: purely reactive, comparing the paddle's
center to the ball's y-position projected 50ms ahead (just enough to smooth reactive
jitter — not lookahead in the sense CLAUDE.md §2 rules out, since it never reasons
about future paddle _positioning_, only the immediate next move). It has no access to
either model's answer and no knowledge of confidence — it's a pure function of the
current tick's state.

## The safety shield (`src/decisions/shield.ts`)

Each paddle runs a continuous cycle: ask its client for a decision, race it against an
**act-deadline** (`DEFAULT_ACT_DEADLINE_MS`, 1000ms by default — see
`docs/INTEGRATION.md` for why that number and how hardware changes what's realistic).

- **Assisted (default):** if the deadline passes with no answer, or the client
  reports an error, the shield substitutes the deterministic planner's move and logs
  it as a **shield intervention** — never as a model decision. Critically, this
  fallback is _live_: while the shield is covering for a model that hasn't answered
  yet, the committed move tracks the planner's judgment of the _current_ tick, not a
  stale snapshot from whenever the last decision cycle happened to resolve — the
  planner is a free local computation, so there's no reason it should lag behind the
  physics loop just because the network/inference call it's covering for does. The
  paddle always moves; it just isn't always the model choosing.
- **Unassisted** (per-side toggle in the UI): a late/failed decision gets **no**
  fallback — the paddle holds its last committed move until the model actually
  answers. This exposes a model's raw, unprotected latency: if it's consistently
  slow, the paddle visibly lags or stalls, with nothing masking that fact.

## Metrics (`src/stats/metrics.ts`)

All four are tracked **independently per side** (Laya vs. Jev never share a
denominator):

- **Best-move agreement %** — of the decisions that _arrived in time_ (i.e. the
  shield did not intervene that cycle), the percentage whose committed move matched
  the planner's move for that same tick. Interventions are excluded from both the
  numerator and denominator: this is a measure of the model's own judgment, not of
  how often the shield had to cover for it. A side with a 100% intervention rate
  reports agreement as "—" (undefined, not zero) — see `docs/INTEGRATION.md`'s note
  on CPU-only Laya hardware for a real example of this happening.
- **Shield intervention rate** — interventions ÷ total cycles, per side. This is the
  headline "real-world" number: how often the safety net had to catch this side.
- **Latency distribution (p50 / p95)** — computed only from decisions that arrived
  in time (a timed-out request has no meaningful "latency" to contribute — it
  contributes to the intervention rate instead). Reported as p50/p95, not a mean,
  because a mean hides exactly the tail behavior ("does it usually keep up but
  occasionally blow the deadline?") this benchmark cares about.
- **Requests in flight** — a live gauge, incremented when a `decide()` call goes out
  and decremented when its cycle settles (success, timeout, or error). At most 1 per
  side under normal operation, since each `Shield` is strictly single-flight — a
  reading above 1 would indicate the single-flight guard has broken.

## Assisted vs. unassisted outcome

The **assisted** score, rally length, and points-per-side reflect real gameplay with
the shield active — this is what CLAUDE.md §7 calls the "real-world-safe" number,
directly comparable between a fast-but-uncertain model and a slow-but-accurate one,
because the shield ensures neither side is simply penalized for network latency it
can't control.

The **unassisted** toggle (per side, independent of the other side's setting) turns
that safety net off for whichever side you flip it on for, so you can watch that
side's raw capability — including whatever visible lag or missed returns its real
latency produces — without the shield's fallback smoothing it over.

## Reproducibility notes

- The act-deadline is a chosen parameter, not a law of physics — a tighter deadline
  will show more interventions for _both_ sides; a looser one, fewer. Two runs with
  different deadlines are not directly comparable. `docs/INTEGRATION.md` documents
  the current default and the reasoning behind it.
- Laya's local inference speed depends entirely on the hardware it's run on (CPU vs.
  GPU vs. MLX) — this is not something the software can normalize away, and is
  itself part of what this benchmark is measuring (a slower model has to be that
  much more accurate to offset the shield stepping in more often).
- The full per-tick decision history is available via `DecisionLog#exportJSON()`
  (`src/stats/log.ts`) for anyone who wants to re-derive these numbers independently
  rather than trust the live HUD.
- `stay` is a real, fully offered criterion in every request to both models (verified
  directly against the live Jev API: it answers `stay` with 90%+ confidence when the
  ball is already level with the paddle). If it looks rare during a live match, that's
  a property of live gameplay, not a missing option — a paddle that's continuously
  tracking the ball rarely sits at an exact standstill relative to it for long, so by
  the time a fresh decision is asked for, `stay` is less often the top answer. Query
  the API directly with a near-zero ball/paddle delta if you want to see it land.
