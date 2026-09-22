# Review: idkcraft-3nt.8 / 03-after-fix2

scope: `/Users/iv/Projects/idkcraft/.revmux/tasks/idkcraft-3nt.8/03-after-fix2/input/scope.md`

No findings.

## Pre-existing

### First `setGoal` after `follow me` is swallowed by pathfinder's latched `stopPathing`, costing one tick on resume

`bot/src/index.js:146-150`

`ticker.stop()` calls `bot.pathfinder.stop()`, which in mineflayer-pathfinder only sets `stopPathing = true` (node_modules/mineflayer-pathfinder/index.js:162-164). That flag is cleared by the internal `stop()` (line 390-395), which only runs when the bot arrives at the next path node (line 581-584) or when `resetPath` finds it set (line 138).

If the bot has no active path when `stop` is said, nothing clears the flag. Concrete sequence: the player stands within 3 blocks, so the brain returns `idle` and `applyDecision`'s else-arm has already drained the path; the player then types `stop` -> `handleChat` runs `setFollow('')` (lastGoalKey = '') then `ticker.stop()` -> `bot.pathfinder.stop()` fires with `path.length === 0`, so `stopPathing` stays true for the whole parked period. The new paused branch never calls it again (lastGoalKey is already 'idle'), so the flag just sits latched.

On `follow me`: `setFollow('Steve')` clears `paused` and `lastGoalKey`; the next tick reaches `follow()` and calls `bot.pathfinder.setGoal(new goals.GoalFollow(target, 3), true)`. `setGoal` (line 142-147) assigns `stateGoal` and then calls `resetPath('goal_updated')`, whose last line `if (stopPathing) return stop()` immediately nulls `stateGoal` and empties `path`. The bot does not move. It self-heals on the following tick because follow.js re-issues the goal when `!bot.pathfinder.isMoving()`, so the cost is bounded at one `BRAIN_TICK_MS` (1 s by default).

The merge gate lists "resume works" as a criterion, and the new test cannot see this: `mockBot().pathfinder.setGoal` only increments a counter, so `assert.ok(bot.calls.setGoal > goalsBefore)` at bot/test/tick.test.js:293 passes while the real pathfinder discards the goal.

Why this is routed as pre-existing: the reviewer states the offending call — `ticker.stop()`'s `bot.pathfinder.stop()` — is unchanged by this diff. What the paused flag changes is only the likelihood: the bot now reliably sits with no path for the whole park, so the latched-flag state is the normal condition at resume rather than an occasional one.

Fix: In `setFollow`, when resuming, clear the latch before the next goal is issued — e.g. `setFollow: (name) => { followName = name; ctx.lastGoalKey = ''; if (name) { ctx.paused = false; bot.pathfinder.setGoal(null) } }`, since `setGoal(null)` runs `resetPath` and consumes `stopPathing`. Alternatively use `bot.pathfinder.setGoal(null)` instead of `bot.pathfinder.stop()` in `stop()` so the park never latches the flag.

_confidence: 70 | sources: loop+goal | lenses: bot-loop, goal-and-tests_

## Sources

| agent | executor | model | effort | tokens | raised | status |
| --- | --- | --- | --- | --- | --- | --- |
| loop+goal | claude | claude-opus-5 (requested opus) | high | 635909 | 1 | ok |
| contract | claude | claude-opus-5 (requested opus) | high | 238642 | 0 | ok, nothing raised |
