# Review: idkcraft-3nt.9 / 03-post-merge

scope: `/Users/iv/Projects/idkcraft/.revmux/tasks/idkcraft-3nt.9/03-post-merge/input/scope.md`

No findings.

## Pre-existing

### stopOnce() still latches stopPathing on the moving branch, so the ~6 s fight freeze stays reachable

`bot/src/index.js:36-37`

`stopOnce()` guards only the empty-path case. When `isMoving()` is true it still calls `bot.pathfinder.stop()`, which in mineflayer-pathfinder 2.4.5 only sets `stopPathing = true` (node_modules/mineflayer-pathfinder/index.js:162-164). That flag is consumed in exactly two places: node arrival in `monitorMovement` (index.js:581-584) and any `resetPath` (index.js:139 `if (stopPathing) return stop()`). Usually the bot reaches the next node in well under a tick, so the latch is gone before the next brain decision and this is harmless.

It is not harmless when the next path node takes longer than one tick. Concrete sequence, `BRAIN_TICK_MS=1000`: the bot is following Steve and the next node has `toBreak` entries, so it is digging through stone. Steve stands still, so the dynamic `GoalFollow.hasChanged()` never fires and no `resetPath` runs. Tick N: the brain returns `idle` -> `applyDecision` -> `stopOnce()` -> `isMoving()` is true -> `stop()` sets the latch, `lastGoalKey='idle'`. The dig is still running, so no node arrival consumes it. Tick N+1: a zombie spawns, the brain returns `fight` -> fight.js:63-66 `key !== ctx.lastGoalKey` -> `setGoal(new GoalFollow(hostile, 2), true)` -> `resetPath('goal_updated')` -> `if (stopPathing) return stop()` -> `stateGoal = null`, the goal is swallowed. fight.js has already set `ctx.lastGoalKey = 'fight:<id>'` and `ctx.fightPursuit = 0`. Ticks N+2..N+6: `key === ctx.lastGoalKey`, `!inRange`, `isMoving()` false -> `fightPursuit` increments, and the re-issue only happens at `fightPursuit % RETRY_EVERY_TICKS === 0` (fight.js:81-83, `RETRY_EVERY_TICKS = 6`). The bot stands still for ~6 s before pathing to the mob.

Why the change under review did not introduce it: all five call sites did an unconditional `stop()` before the diff, and the change does not make the moving branch newly reachable. `follow` also self-heals in one tick because follow.js:13 re-issues whenever `!isMoving()`; only fight's deliberately spaced retries turn it into a multi-second stall. The reporting source judged all merge-gate criteria met and would not block the merge on this, suggesting a follow-up bead instead.

Fix: Follow-up, not this diff: `setGoal(null)` is a strictly stronger halt than `stop()` — `resetPath` empties `path` and calls `bot.clearControlStates()` immediately, and it never sets `stopPathing` — so `stopOnce()` could drop the branch entirely and always cancel via `setGoal(null)` when `bot.pathfinder.goal || bot.pathfinder.isMoving()`. Tradeoff: `stop()` lets the bot finish walking to the current node, while `setGoal(null)` halts mid-step. It also needs the two `calls.stop === 1` assertions (bot/test/tick.test.js:65 and 217) rewritten.

_confidence: 65 | sources: loop+goal | lenses: bot-loop, goal-and-tests_

## Sources

| agent | executor | model | effort | tokens | raised | status |
| --- | --- | --- | --- | --- | --- | --- |
| loop+goal | claude | claude-opus-5 (requested opus) | high | 617330 | 1 | ok |
| contract | claude | claude-opus-5 (requested opus) | high | 563721 | 0 | ok, nothing raised |
