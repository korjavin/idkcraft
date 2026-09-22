# Review: idkcraft-3nt.10 / 01-initial

scope: `/Users/iv/Projects/idkcraft/.revmux/tasks/idkcraft-3nt.10/01-initial/input/scope.md`

## Major

### Ticker nulls the give-up latch whenever another hostile is nearest, so the brain never sees hostile_reachable=false and the unreachable mob keeps the body

`bot/src/index.js:115-118`

`buildState` computes `hostile_reachable` against `state.hostile` (perception's *nearest* candidate), but `fight.js` pursues `ctx.fightId` — the *sticky* incumbent, which `stickyTarget` keeps until a newcomer is nearer by `STICKY_MARGIN_BLOCKS = 2` (bot/src/behaviours/fight.js:90-102). When those two differ, index.js:115 reads the mismatch as "stale: mob gone, or a new mob is nearest" and nulls `ctx.fightGivenUpId` before `applyDecision` dispatches fight.

Tick sequence (bot at x=0, player Steve at x=30, zombie A at x=6 unreachable, zombie B at x=5 appearing at tick 5):
- ticks 1-19: fight pursues A, pathfinder stalls, `fightPursuit` climbs.
- tick 5: B appears. `state.hostile` = B (nearest). `stickyTarget` keeps A (5 + 2 = 7 > 6).
- tick 20: `fightPursuit > GIVE_UP_TICKS` → `ctx.fightGivenUpId = A.id`, shadowPlayer.
- tick 21: index.js:115 sees `state.hostile.id` (B) !== `A.id` → latch nulled, `hostile_reachable = true`. The brain answers fight. `stickyTarget` line 93's escape (`ctx.fightGivenUpId === ctx.fightId`) is now false because the ticker just cleared it, so A is returned again and pursuit restarts from scratch.
- ticks 22-40: same, forever.

I ran this through `createTicker` with the test-suite mock shape: 60 ticks, `follow` count **0**, goals alternating only between entity 1 (unreachable A) and entity 7 (the player); B is never pathed to and never attacked. The single-mob control yields follow at tick 20 as intended, and a second mob *farther* than A also works — the trigger is specifically a second hostile nearer than the written-off incumbent but inside the 2-block sticky margin, which is ordinary night-time Minecraft.

Two consequences: (a) the bead's core behaviour (`hostile_reachable=false` → follow) is unreachable in the multi-mob case; (b) this is a regression of pre-existing behaviour — loading `origin/master:bot/src/behaviours/fight.js` against the same sequence, the bot switches its goal to entity 2, the reachable mob. The latch used to be owned end-to-end by fight.js, so the escape fired.

The two unit tests that cover the escape (bot/test/fight.test.js:300 "engages a new mob instead of resurrecting a given-up one" and :315 "swings at a new mob in range while the incumbent is given up") call `fight()` directly with `ctx.fightGivenUpId` still set — a ctx state the ticker can no longer produce — so they pass by construction and hid this. The new end-to-end test at bot/test/fight.test.js:401 uses a single mob, so nothing in `bot/test/` fails on it.

Fix: Key the latch bookkeeping on the latched entity itself, not on `state.hostile`. In index.js:115, clear `ctx.fightGivenUpId` only when the latched mob is actually gone or no longer a fight candidate (`!bot.entities[ctx.fightGivenUpId]` / `!isFightTarget(...)`), leaving it set while another hostile happens to rank nearest. `stickyTarget`'s line-93 escape then fires and fight.js engages the reachable newcomer (and nulls the latch itself at line 60 when it sets the new goal). Add a ticker-level test with two hostiles 1 block apart that asserts the goal moves to the newcomer after give-up.

_confidence: 90 | sources: loop+goal | lenses: bot-loop, goal-and-tests | verdict: confirmed_

## Minor

### New smoke label is longer than the table column, shifting that row in CI output

`laya/smoke.py:48-49`

The added canned state is labelled "hostile 4 unreach" (17 characters), but the quality table is printed with `print("%-14s %-8s %-8.3f %.0f" % ...)` at laya/smoke.py:120 and the header uses the same `%-14s` at line 118. Every pre-existing label fits the column ("dist 12 moving" and "hostile 4 weak" are both exactly 14). The new one overflows, so in the CI smoke output the action/sprint/ms columns for that single row are pushed three characters right and no longer line up with the header — the table exists purely for a human quality check, so the misalignment is the whole cost. Nothing is asserted on the label, so CI still passes.

Fix: Shorten the label to <=14 chars (e.g. "hostile 4 far" or "h4 unreachable"), or widen both format strings to %-18s.

_confidence: 95 | sources: contract | lenses: contract | verdict: refined_

## Sources

| agent | executor | model | effort | tokens | raised | status |
| --- | --- | --- | --- | --- | --- | --- |
| loop+goal | claude | claude-opus-5 (requested opus) | high | 774412 | 1 | ok |
| contract | claude | claude-opus-5 (requested opus) | high | 556196 | 1 | ok |
