# Review: idkcraft-3nt.10 / 03-after-fix2

scope: `/Users/iv/Projects/idkcraft/.revmux/tasks/idkcraft-3nt.10/03-after-fix2/input/scope.md`

## Minor

### No ticker test covers the stale-latch clear, the only guard between a dead latched mob and a permanently non-dispatching tick loop

`bot/src/index.js:119-124`

The latch block at index.js:119-143 is entirely new in this change (`git diff origin/master...HEAD -- bot/src/index.js` shows it added wholesale). Its first branch is the stale-latch clear: `ctx.fightGivenUpId` holds a raw entity id, so when that mob dies or despawns `bot.entities[id]` is `undefined`, `isFightTarget(undefined, ...)` returns false at perception.js:20, and index.js:122-124 clears the latch and reports `hostile_reachable = true`. That guard is also the only thing keeping index.js:125 from dereferencing `latched.position` on an `undefined`. If it is ever removed, reordered or narrowed (someone deciding `isFightTarget` is redundant because perception already filtered), line 125 throws a TypeError, the catch at index.js:174 logs `tick error:` and returns before `applyDecision`, and the latch is never cleared — the code that clears it is inside the block that throws. The loop itself keeps running (the `finally` still calls `scheduleNext`), but every tick throws again: no behaviour is dispatched, the bot holds whatever pathfinder goal it last had, and it logs one error per tick indefinitely. A hostile dying mid-pursuit after give-up is completely ordinary (another player kills it, it burns at dawn, it despawns).

The code is correct today: with `latched` undefined the guard clears the latch and the brain falls back to follow. What is missing is the assertion that keeps it correct. `rg 'fightGivenUpId|delete bot.entities' bot/test/` finds only fight.test.js:294 (a direct `fight()` call exercising stickyTarget's despawn path, not the ticker) and fight.test.js:391 (zombie deleted before any latch is set). The three ticker tests added here (fight.test.js:401, :421, :442) all keep the latched mob alive in `bot.entities` for the whole run. The project profile states plainly that a missing assertion for new branching logic is a finding.

Fix: Add a ticker test next to fight.test.js:442: tick ~25 times with a stalled zombie at 6 blocks so the latch is set, then `delete bot.entities[1]`, and assert the next tick still returns a decision (`follow`) rather than `null`, pinning the stale-latch clear.

_confidence: 85 | sources: loop+goal | lenses: goal-and-tests, bot-loop | verdict: refined_

## Immaterial

### Melee-override comment claims keeping the latch avoids re-issuing a pursuit goal, but fight.js clears the latch and the goal is re-issued on the very next tick

`bot/src/index.js:126-130`

index.js:128-129 justifies leaving `ctx.fightGivenUpId` set with: "The latch stays set — clearing here would re-issue a pursuit goal at a mob already in reach." That holds for exactly one tick. On the override tick the brain answers fight, fight.js takes the given-up branch (fight.js:47-50), swings, and clears the latch itself. On the *next* tick the latch is `null`, so fight.js falls through to fight.js:56, finds `key !== ctx.lastGoalKey` (the key is still `fight-shadow:<player>` from the shadow ticks) and calls `bot.pathfinder.setGoal(new goals.GoalFollow(hostile, 2), true)` plus `equipSword` — the exact pursuit goal the comment says the design avoids, one tick later.

Measured on the real ticker with the test mocks (Steve at 30, zombie stalls at 6, latch set, zombie then parks at 1 block for 40 ticks): 40 attacks over 40 ticks, and exactly 1 `setGoal` — a fresh `GoalFollow` at a mob already inside `SWING_RANGE`. Runtime cost is one redundant A* search at an unreachable target, not a behaviour break, and the swings are correct throughout — so this is a comment that misstates its own rationale rather than a logic defect. In a project whose profile asks that changes explain themselves, the next reader will believe a guarantee the code does not give.

Fix: Reword to what actually happens, e.g. "The latch stays set so fight.js takes its given-up branch and swings this tick instead of opening a fresh pursuit; it clears the latch itself, and normal pursuit resumes next tick."

_confidence: 85 | sources: loop+goal | lenses: bot-loop | verdict: immaterial_

## Sources

| agent | executor | model | effort | tokens | raised | status |
| --- | --- | --- | --- | --- | --- | --- |
| loop+goal | claude | claude-opus-5 (requested opus) | high | 1211724 | 2 | ok |
| contract | claude | claude-opus-5 (requested opus) | high | 1133390 | 0 | ok, nothing raised |
