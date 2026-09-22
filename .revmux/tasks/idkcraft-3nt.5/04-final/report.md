# Review: idkcraft-3nt.5 / 04-final

scope: `/Users/iv/Projects/idkcraft/.revmux/tasks/idkcraft-3nt.5/04-final/input/scope.md`

## Major

### Bead acceptance criterion unmet: no smoke table, so the four-choice question the bead exists to answer is undecided

`laya/smoke.py:28-45`

The bead's acceptance criteria are "npm test green; ... smoke table with four choices pasted in PR; fallback path recorded on the bead if taken", and the Why section states the specific risk being tested: "adding a fourth choice is a risk for LAYA (cne.4 showed it collapses to one answer when criteria are vague)". The bead's fallback instruction is conditional on that evidence: "if the smoke table shows LAYA now answers roam or idle where it should fight/follow, drop roam from the brain question and make it a local rule instead".

The PR body (#28) says under "Smoke table: pending (no sidecar locally)": "`smoke.py` could not run here — no sidecar is listening on this machine. Please run it where the sidecar lives and paste the quality table here before merge." `gh pr view 28 --json comments` returns no comments, so no table was ever attached. The fallback section then records "Path taken: the four-choice brain question stays. There is no local evidence of collapse" — i.e. the decision the bead asked to be made *from* the table was made from its absence.

Concrete consequence, not hypothetical: nothing in the code forces the deployed path to work. `index.js:136` dispatches `decision.action` from whatever the remote brain answered, and the default `BRAIN_URL` is the laya sidecar. `smoke.py check()` (laya/smoke.py:58-70) validates shape only — it accepts `idle` for every state — so a model that collapses to `idle` on the eight rows passes the smoke gate silently. If laya collapses, the deployed bot behaves exactly as before the bead (freezes next to a standing player), one `brain disagree ... model=idle stub=roam` line is logged, the decision is then cached, and the in-game acceptance criterion ("within ~10 s the bot starts strolling") fails on the real stack while all 113 unit tests stay green. The bead also asks for the fallback outcome to be recorded on the bead itself; it is recorded only in the PR body.

The code under review is sound — the four-choice question, the criteria and the stub all check out. What is missing is the one piece of evidence that distinguishes the primary path from the fallback path, which is the owner's stated experiment.

Fix: Run `python laya/smoke.py` where the sidecar lives, paste the 8-row table into PR #28, and confirm `fight`/`follow` still win on `dist 12 moving`, `dist 5`, `hostile 4`; if they do not, take the bead's fallback (drop the `roam` criterion, idle-streak rule in the ticker). Mirror the outcome onto the bead with `bd update idkcraft-3nt.5 --notes=...`.

_confidence: 95 | sources: loop+goal | lenses: goal-and-tests | verdict: confirmed_

## Minor

### Smoke row "dist 1 still" repeats the "dist 1" state byte-for-byte with nothing in the file saying it is deliberate

`laya/smoke.py:37-38`

`STATES` has 8 rows but only 7 distinct state strings: row 4 (`"dist 1 still"`, laya/smoke.py:37-38) is byte-identical to row 2 (`"dist 1"`, laya/smoke.py:33-34) — `distance_to_player=1.0 player_visible=true player_moving=false ... hostile_distance=none hostile_near_player=false`. Parsing `STATES` gives 8 rows / 7 distinct, and `diff` on the two literal lines reports no difference.

The bead asked for a row `"dist 1 still"`, evidently assuming the existing `"dist 1"` row was the moving case; it was already `player_moving=false`, so the new row landed on top of it. PR #28 reframes this as intentional: "the new `dist 1 still` row duplicates the existing `dist 1` state on purpose, so the table also probes whether the model answers the same state deterministically." That is a legitimate thing to test, so the row should not simply be deleted.

What remains is real all the same. Nothing in `smoke.py` records the intent — the docstring says "8 canned states", and `main()` (laya/smoke.py:97-105) posts one request per row for `STATES[1:]`, so each run spends an extra CPU inference and prints two differently-labelled rows that can only diverge through nondeterminism. The table is the artifact pasted in the PR for the owner's four-choice experiment; a reader seeing `dist 1` answer `roam` and `dist 1 still` answer `idle` would naturally read that as a state-dependent difference rather than model jitter, which is the wrong conclusion to draw from the very experiment the bead exists to run. The PR body explains it today, but the PR is transient and the file is not.

Fix: Keep the probe and make it self-describing: relabel the row (e.g. `"dist 1 repeat"`) and add a one-line comment above it saying it intentionally repeats row 2 to check answer determinism; fix the docstring's "8 canned states" to say 7 distinct states plus a repeat. If determinism is not actually being measured, drop the row and rename `"dist 1"` to `"dist 1 still"` instead.

_confidence: 90 | sources: contract | lenses: contract | verdict: refined_

### Roam neutralises the stationary-player brain-call dedup: ~1 brain call per tick while a player stands still

`bot/src/behaviours/roam.js:36-41`

The mechanism is real and I verified every step of it. `stateKey` (bot/src/perception.js:29-39) rounds `distance_to_player` to whole blocks and the ticker reuses `lastDecision` only while that key is unchanged (bot/src/index.js:111-124), a deliberate guard with its own test (bot/test/tick.test.js:143-160) and its own README paragraph (bot/README.md:39-43). Before this change a still player within 3 blocks yielded `idle`, neither body moved, the key was constant, and the brain was called exactly once for the whole episode. With roam the bot walks continuously — roam.js:35 immediately picks a new GoalNear as soon as the pathfinder stops, and `sprint:false` means ~4.3 blocks of travel per 1000 ms tick — so the rounded distance flips nearly every tick. The diff's own tests show it: roam.test.js:129-134 walks out through 4 and 5.5 blocks and the brain answers freshly each time. So an AFK or building player next to the bot now drives a POST to the laya sidecar every second, indefinitely, where it previously drove one.

Two corrections to the framing, which is why this is minor rather than major. First, this is the inherent cost of the feature, not a side effect of it: the bead's acceptance criterion is 'player stands still -> the bot starts strolling', a moving bot is a changing perception state, and re-deciding on changed state is what the loop is for. A bot following a moving player already costs one call per tick; the new thing is only that this state can now persist indefinitely. Second, the default `BRAIN_URL` is the local laya sidecar, so the cost is sidecar CPU on a private hobby server, not money — the profile's 'spams the remote brain' failure is scoped to nobody being online, and that guard (index.js:92-105) is untouched.

The fix the finding proposes — teaching the ticker to keep reusing `lastDecision` across roam distance changes — is the wrong trade and I would not take it. It directly contradicts the rationale recorded in roam.js:22-26 and re-opens the exact wedge round 03 fixed as MAJOR (a stroll resting past 6 blocks replaying a stale cached roam), and it would require rewriting the new wedge test at roam.test.js:144-171. Risking a just-fixed wedge to save CPU on a private sidecar is a worse outcome than the problem. The `inFlight` degradation angle is plausible but unmeasured — laya's smoke.py reports p50/p95 but no number is recorded in the repo — so I would not lean on it.

Fix: Prefer a change inside roam.js over one in the ticker: dwell a few ticks between strolls (pick a new GoalNear only every Nth idle tick) so the bot rests part of the time, which restores cache hits and also looks more natural than pacing nonstop. At minimum, correct the cost-guard paragraph at bot/README.md:39-43, which now overstates the guard, and note the new AFK cost envelope on the bead. Do not special-case roam in the ticker's cache — that re-opens the round-03 hand-back wedge.

_confidence: 85 | sources: contract | lenses: contract | verdict: refined_

## Immaterial

### bot/README.md still documents three brain actions and the pre-change 3-block thresholds, which this diff falsifies

`bot/README.md:52-63`

This change moved the stub/criteria thresholds: follow now triggers at >3 blocks only while the player is moving and at >6 while standing still (bot/src/brain.js:38-42), and a still player inside 6 blocks yields `roam` (brain.js:47). bot/README.md was not updated, so three statements are now factually wrong for the code in this diff: `:50-52` enumerates the exclusive actions as `fight` / `follow` / `idle` with "`idle`: Player is close (<= 3 blocks)"; the behaviours table at `:61` says `follow` triggers at "Player > 3 blocks away"; `:63` says `idle` triggers at "Player within 3 blocks". There is no `roam` row at all. The incremental point is that the two existing rows are now actively wrong, not merely missing a sibling.

Failure case is a reader, not the runtime: the bead's in-game acceptance is checked against this table ("Log lines show action=roam"), and an owner following the README to verify the deployed bot finds no documented `action=roam` and an `idle` trigger that states the opposite of what the bot does at 1-3 blocks while standing still. Nothing at runtime reads the README — both reviewers confirmed no code path depends on it.

Pre-flagged and deferred: the round-04 scope defers this to the docs track because bot/README.md is edited in parallel and is outside this bead's file list. Reported so the merge decision is made knowingly; if the docs track owns it, a follow-up bead is enough.

Fix: Either add the `roam` bullet/table row and correct the follow/idle triggers to the moving/still split (>3 moving, >6 still), or file a follow-up bead against the docs track so the drift is not lost at merge.

_confidence: 99 | sources: loop+goal, contract | lenses: goal-and-tests, contract | verdict: immaterial_

## Sources

| agent | executor | model | effort | tokens | raised | status |
| --- | --- | --- | --- | --- | --- | --- |
| loop+goal | claude | claude-opus-5 (requested opus) | high | 1323024 | 2 | ok |
| contract | claude | claude-opus-5 (requested opus) | high | 779829 | 4 | ok |
