# Review: idkcraft-3nt.3 / 01-initial

scope: `/Users/iv/Projects/idkcraft/.revmux/tasks/idkcraft-3nt.3/01-initial/input/scope.md`

## Major

### An unreachable hostile pins the bot in fight and restarts the path search every tick

`bot/src/behaviours/fight.js:16-20`

`fight()` re-enters the setGoal branch whenever `key !== ctx.lastGoalKey || !bot.pathfinder.isMoving()`. `isMoving()` is `path.length > 0` (bot/node_modules/mineflayer-pathfinder/index.js:154), so "not moving" is the steady state both at melee range and when no path could be found. `setGoal` calls `resetPath('goal_updated')` (index.js:142-147), which nulls `astarContext`, sets `pathUpdated = false` and calls `bot.clearControlStates()`.

The key point is what that defeats. Upstream, an unreachable static goal is searched **once**: `monitorMovement` runs A* only `if (!pathUpdated)` and then latches `pathUpdated = true` (index.js:465-471), so after one `thinkTimeout` (5000 ms) burst of 40 ms-per-physics-tick search the pathfinder goes quiet. Re-issuing the goal once per brain tick (`BRAIN_TICK_MS` default 1000) clears that latch every second, so the search never gets to finish and never gets to stay finished: a path that legitimately needs more than ~0.8 s of search (20 physics ticks × `tickTimeout` 40 ms between two brain ticks, against an allowance of 5 s) is torn down and restarted forever, and the bot burns up to 40 ms of every 50 ms physics tick for as long as the target is in range.

Cleanest trigger is a *stationary* unreachable hostile — a zombie sealed in a cave 6 blocks below, or one behind glass/a fence, or across a ravine. Perception picks it (within 8 of the bot, creeper is the only exclusion), the stub answers `fight` (hd ≤ 8, health ≥ 6), `GoalFollow(mob, 2)` can never be satisfied, the bot never reaches swing range, and it stands still ignoring the player until the mob despawns or leaves the window. For a mob that moves, upstream's `goal_moved` reset already re-paths, so the added churn there is smaller — but the standstill is the same. There is no give-up timer and no test covering an unreachable target. The profile names "a behaviour steals the tick from another one (… fight never yields)" as a real failure.

Fix: Bound the fight: keep a per-target tick counter on `ctx` and drop the target (return without a goal, letting the brain fall through to follow) once it has gone N ticks without reaching swing range, or clear it when `path_update` reports `noPath`. Re-issue the goal on target change only, so the one-shot `pathUpdated` latch is left to do its job, and add a test for a hostile that never comes into range.

_confidence: 80 | sources: loop+goal | lenses: bot-loop, goal-and-tests | verdict: refined_

## Minor

### equipSword runs every tick in melee range; the "once per target" test passes by construction

`bot/src/behaviours/fight.js:19`

`equipSword(bot)` sits inside the `key !== ctx.lastGoalKey || !bot.pathfinder.isMoving()` branch. At melee range the GoalFollow(mob, 2) goal is satisfied, the path is empty and `isMoving()` returns false (node_modules/mineflayer-pathfinder/index.js:154), so the branch runs on every tick and `bot.equip` is called once per second for the whole fight — not "before the first swing on a new target" as the bead asks.

Runtime damage is small because mineflayer's `equip` early-returns when `sourceSlot === destSlot` (node_modules/mineflayer/lib/plugins/simple_inventory.js:99-103), so after the first equip it is a no-op. The test problem is real though: bot/test/fight.test.js:154 sets `bot._moving = true` before asserting `bot.calls.equip === 1`, and `_moving = true` is exactly the state that never holds while the bot is standing next to the mob swinging. The assertion therefore certifies a property the code does not have in the only situation it matters; inverting or removing the equip guard would not fail any test.

Fix: Equip on target change only — hoist `equipSword` under a `key !== ctx.lastGoalKey` check separate from the `!isMoving()` re-path retry — and drop the `_moving = true` setup from the test so it exercises the melee case.

_confidence: 80 | sources: loop+goal | lenses: goal-and-tests, bot-loop | verdict: confirmed_

### The "within 6 blocks of the player" half of the fight-candidate filter is never exercised by a test

`bot/src/perception.js:77`

`if (dBot > FIGHT_RANGE_BOT && dPlayer > FIGHT_RANGE_PLAYER) continue` (perception.js:77) admits a hostile that is far from the bot but close to the player — the case the bead's headline behaviour (defend the player) depends on, and the case the stub then resolves to `fight` via `near` alone (brain.js: `(hd <= 8 || near) && health >= 6`). No test reaches it.

Every `buildState` call in the suite is in bot/test/fight.test.js (62, 71, 79, 90, 98); tick.test.js runs with `entities: {}` and e2e-follow.js is not in the `npm test` script. At fight.test.js:68-74 the zombie is at x=8 with the bot at x=0, so `dBot > 8` is false and the `&&` short-circuits on the bot-range arm; in the out-of-range test (fight.test.js:95-102) the skeleton is 20 from the bot and 10 from the player, so both arms are true and the mob is rejected either way.

Mutation check (static, not run): deleting `&& dPlayer > FIGHT_RANGE_PLAYER` — i.e. leaving `if (dBot > FIGHT_RANGE_BOT) continue` — leaves all 14 tests in fight.test.js green. Note the original finding also claimed flipping `&&` to `||` survives; it does not — with `||`, the zombie at x=2 with the player at x=10 (fight.test.js:58-66) has `dPlayer = 8 > 6` and would be dropped, failing the `hostile_distance === 2` assertion.

Defect that would slip through the surviving mutation: a zombie 12 blocks from the bot and 2 blocks from the player is dropped from the scan, `hostile_distance` comes back null and `hostile_near_player` false, the stub answers `follow`, and the bot walks to the player while the mob hits them.

Fix: Add one perception case to fight.test.js: bot at 0, zombie at 12, player at 14 — assert `hostile_distance === 12` and `hostile_near_player === true`. Self-contained, no production code touched.

_confidence: 90 | sources: loop+goal | lenses: goal-and-tests | verdict: refined_

## Sources

| agent | executor | model | effort | tokens | raised | status |
| --- | --- | --- | --- | --- | --- | --- |
| loop+goal | claude | claude-opus-5 (requested opus) | high | 1148579 | 4 | ok |
| contract | claude | claude-opus-5 (requested opus) | high | 716076 | 0 | ok, nothing raised |
