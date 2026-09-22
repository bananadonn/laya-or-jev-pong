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
defending differs. `PongState.paddle` includes the paddle's own `x` (always the same
constant in the mirrored frame, per `PADDLE_MARGIN`) alongside the ball's `x`/`vx` -
without it a model has the ball's velocity but no way to know its own distance from
it, which meant it structurally couldn't reason about time-to-intercept even if
capable of the math.

The `instructions` text itself is deliberately short - "Given the ball's
position/velocity and this paddle's position, should the paddle move up, down, or
stay still right now?" See "Two real findings from actually testing both models"
below for why a more detailed, physics-explaining version was tried and reverted.

## The deterministic planner (`src/decisions/planner.ts`)

The ground truth a decision is judged against. Projects the ball's actual trajectory
forward to the moment it reaches the paddle's x-plane, including however many
top/bottom wall bounces happen along the way (a closed-form reflection, not a
simulation loop), then compares that arrival y to the paddle's current position. This
is still a single-tick reactive judgment, not the "predicting where to position well
in advance of a return" lookahead CLAUDE.md §2 rules out — it's recomputed from
scratch every tick with no memory of past answers, and reasons about nothing beyond
this one incoming ball. CLAUDE.md groups Pong with "reactive games" like Space
Invaders precisely because trajectory-aware reaction _is_ the reactive judgment the
task calls for. It has no access to either model's answer and no knowledge of
confidence — it's a pure function of the current tick's state.

An earlier version of the planner only smoothed the ball's current y by a fixed 50ms,
regardless of the paddle's actual distance from it or any wall bounces in between -
correspondingly easier to agree with. **Best-move agreement % is not comparable
across this change**: the same model logic will show a lower agreement rate against
the trajectory-aware planner than it did against the old one, because the bar for
"correct" genuinely got higher, not because the models got worse.

## Two real findings from actually testing both models

Reported by the user after noticing both paddles seemed to be missing the ball
consistently in a specific way - Laya only ever moving down, Jev only ever moving up.
Investigated directly against both real APIs (not just watching the game) to separate
"is this our schema/prompt" from "is this the model."

**Jev: the longer, more explicit `instructions` text measurably hurt it.** While
adding `paddle.x` (above), the instructions were also expanded to explicitly describe
wall bounces and ask the model to anticipate the ball's arrival point. Queried the
real API with identical states under both versions: for a ball clearly well above the
paddle (an unambiguous "move up" case), the short instructions gave `up` at 68-77%
confidence across repeated calls; the long version gave `stay` at 60-99% confidence -
confidently wrong, repeatably, not just noisy. A medium-length version (one added
sentence, no bounce explanation) still degraded it to a near-coinflip. TypeSafe's Jev
is a "System One" model optimized for fast, calibrated decisions from structured
state, not chain-of-thought reasoning over a paragraph of physics - stuffing more
verbal explanation into `instructions` didn't give it more to work with, it diluted
the signal. Reverted to the original short instructions; `paddle.x` itself stayed,
since it's structured data the model can just use as another feature, not something
it has to parse and reason about from prose.

**Laya: the `typed-decisions` checkpoint doesn't discriminate on this task at all.**
Swept `paddle.y` across the full court (50 / 150 / 250 / 450) with `ball.y` held fixed
at 250, querying the real model directly: every single response was `down` at
essentially the same probability (~22-27% up / ~50-53% down / ~24-27% stay) regardless
of whether the paddle was already above, level with, or below the ball - including the
paddle.y=450 case, where the ball is far above the paddle and "down" is physically
nonsensical (there's no more "down" to move into). Retested with all coordinates
normalized to 0-1 instead of raw pixels, in case a 421M-parameter model just handles
large integers poorly - same near-constant "down" bias, just slightly less extreme
(41% instead of 50%). This isn't a schema or prompt problem: the model is essentially
outputting a fixed prior, independent of the actual geometric input. Since this
checkpoint was fine-tuned only on ticket-routing/invoice/security-incident
classification (never anything spatial or Pong-shaped), it appears not to generalize
to this task at all - it isn't reasoning about the ball's position, it's returning
something closer to its training-set default. **This is left as-is.** Hand-correcting
or overriding Laya's real output to look smarter than it actually is would fabricate
the exact thing CLAUDE.md §2 says not to: an invented number standing in for a real
one. A near-constant, wrong, low-confidence "down" is Laya's genuine, measured
performance on this out-of-distribution task, and that's the finding.

**Jev: correct per-query, but visibly stale by the time it's applied.** After the
above fix, the user reported Jev's paddle would line up correctly with the ball, then
move away again right after - as if chasing something that had already moved on.
Swept `paddle.y` the same way as Laya's test (50/150/250/350/450, `ball.y` fixed at
250): Jev's answers tracked the true direction correctly at every point - `down` 83%
when the paddle was above the ball, `stay` 96% when level, `up` 60-62% when below - so
this isn't a constant-output bias like Laya's. The cause is round-trip latency: a
`decide()` call captures the ball's position at the _start_ of the request, and a real
measured round trip took 440ms in one test. At a plausible vertical speed (~300px/s,
well within this game's range), the ball can move 130+ px - more than the paddle's own
height - in that window. An answer that was completely correct when asked can be
stale by the time it's actually committed, and the shield's immediate-retry-on-success
means it self-corrects within one more round trip, but in an 800x500 court that's
still enough to visibly overshoot. This is not a bug to fix - it's real network
latency imposing a real cost on a fast-moving game, which is exactly the tradeoff
CLAUDE.md §1 asks this benchmark to measure ("does Jev's judgment quality offset its
far higher hosted latency"). Artificially compensating for it (e.g. discarding a
stale-but-on-time answer, or extrapolating it forward) would hide the very thing the
match is supposed to show.

## The safety shield (`src/decisions/shield.ts`)

**Asks once per rally leg, not once per tick.** A leg begins the instant the ball
starts heading toward a given paddle (right after the opponent's hit, or a new serve),
and the shield fires exactly one `decide()` request for it. Between hits, the ball's
trajectory is fully determined by physics (position + velocity, including wall
bounces), so re-asking the same question every ~150ms while nothing new has happened
is redundant network/inference cost, not new information. This was a deliberate
redesign (see git history) from an earlier version that polled continuously against a
fixed constant deadline - that constant had to be guessed without knowing either
model's real latency, and re-committing a fresh (often stale) directional answer every
cycle caused visible overshoot as the paddle chased information that was already out
of date by the time it landed.

**The act-deadline is the ball's actual time-to-arrival, computed fresh per leg** -
not an arbitrary constant. If a leg starts with the ball 400px away at 300px/s, the
model has ~1.3s to answer; if it starts 100px away, it has ~0.33s. A slow model
naturally gets squeezed hardest on short legs and has the most room on long ones,
which is a more honest test than a single fixed number could ever be.

**The model's answer is executed literally - direction and all.** If it says "up",
the paddle moves up for the rest of the leg, full stop, even if that's the wrong
call and the paddle ends up pinned against a wall. The only thing physics decides is
_when to stop_: once the paddle reaches the ball's live-projected arrival y (which
only changes if the ball bounces off a wall), it holds there rather than overshooting
past a correct answer. Physics never overrides _which way_ to go - only a genuinely
correct direction ever reaches alignment and gets to stop early; a wrong one just
runs out of court and sits at the wall for the rest of the leg. That's deliberate:
silently correcting a wrong answer would hide exactly the kind of mistake this
benchmark exists to surface.

- **Assisted (default):** if the deadline (ball arrival) passes with no answer, or
  the client reports an error, the shield substitutes the deterministic planner's
  move and logs it as a **shield intervention** — never as a model decision. While
  waiting for the leg's answer, the paddle live-tracks the ball via the planner (a
  free, instant local computation, refreshed every physics tick) rather than sitting
  frozen - the paddle always moves; it just isn't always the model choosing.
- **Unassisted** (per-side toggle in the UI): the paddle doesn't even live-track
  while waiting - it sits completely still until the model actually answers, or holds
  still forever if the ball arrives first. This exposes a model's raw, unprotected
  latency with nothing masking it at all.

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

- The act-deadline is now derived from the court itself (ball distance ÷ speed at
  the moment a leg begins) rather than a chosen constant, so it's consistent across
  runs on the same build - but it does still depend on ball speed, which increases
  slightly per rally hit (a capped ramp - see `src/game/physics.ts`). A long rally
  gives _shorter_ deadlines on both sides as it goes, another real, physical source
  of increasing pressure alongside the ball simply being harder to track.
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
