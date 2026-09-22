# Review: idkcraft-3nt.9 / 01-initial

scope: `/Users/iv/Projects/idkcraft/.revmux/tasks/idkcraft-3nt.9/01-initial/input/scope.md`

## Major

### stopOnce() skips goal cancellation when not moving, so chat `stop` no longer stops a parked follow

`bot/src/index.js:32-37`

`stopOnce()` only calls `bot.pathfinder.stop()` when `isMoving()`, but it flips `ctx.lastGoalKey` to `'idle'` unconditionally. In mineflayer-pathfinder `isMoving()` is `path.length > 0` (bot/node_modules/mineflayer-pathfinder/index.js:154), while the goal lives in a separate `stateGoal`. `setGoal(new goals.GoalFollow(target, 3), true)` (bot/src/behaviours/follow.js:14) is dynamic, so once the bot is within range `monitorMovement` sees `path.length === 0` and — because `dynamicGoal` is true — deliberately does NOT clear `stateGoal` (index.js:460-470). The normal parked state is therefore: live dynamic follow goal, empty path, `isMoving() === false`.

Concrete failure: the bot is following Steve, standing 2 blocks away. Steve types `stop` → `handleChat` → `ticker.setFollow('')` → `ticker.stop()` → `ctx.paused = true` and `stopOnce()`: `isMoving()` is false, so `pathfinder.stop()` is never called, the `GoalFollow` stays installed, and `lastGoalKey` becomes `'idle'`. Steve walks out of range → `GoalFollow.hasChanged()` (lib/goals.js:349) → `resetPath('goal_moved', false)` → `pathUpdated = false` → `getPathTo` → the bot follows again, despite being parked. Every subsequent paused tick calls `stopOnce()` but short-circuits on the `lastGoalKey === 'idle'` guard, so nothing ever cancels the goal: `stop` is advisory only until `follow me` or a restart.

Before this change the same sequence worked: `stop()` latched `stopPathing`, and the latch was consumed by the very next `resetPath('goal_moved')` (index.js:138 `if (stopPathing) return stop()`), which nulled `stateGoal`, the path and the control states. The latch the bead calls a bug was also the thing that cancelled a pending goal, so this is a regression introduced by the diff.

The same hole applies to the `idle` branch of `applyDecision` (bot/src/index.js:44) — the brain deciding `idle` while the bot rests next to the player leaves the follow goal live, so the bot resumes following on the player's next step — and to the in-flight-park branch at bot/src/index.js:124. Correction to the original report: `GoalFollow` does override `isValid()` (`this.entity != null`, lib/goals.js:361), but mineflayer only deletes the entity from `bot.entities`; the captured object reference stays non-null, so a logged-out player still does not invalidate the goal. In that case the stale entity position also stops changing, so `hasChanged()` stays false and the `!target` branch at bot/src/index.js:91 has no visible consequence — the live cases are the paused-with-player-present and brain-said-idle ones.

Fix: Cancel the goal instead of doing nothing on an empty path — `setGoal(null)` clears `stateGoal` and the path via `resetPath('goal_updated')` without setting `stopPathing`, so it cannot latch:

```js
function stopOnce() {
  if (ctx.lastGoalKey !== 'idle') {
    if (bot.pathfinder.isMoving()) bot.pathfinder.stop()
    else bot.pathfinder.setGoal(null)
    ctx.lastGoalKey = 'idle'
  }
}
```

The new guard test (bot/test/tick.test.js:69-99) then needs both counters bumped, not just one: the idle tick issues an un-swallowed `setGoal(null)`, so the sequence becomes `calls.setGoal === 3` and `calls.effectiveGoals === 3`; `calls.stop === 0` and the no-latch property still hold. Add a ticker test that a parked dynamic follow goal is cleared by `ticker.stop()` when `isMoving()` is false.

_confidence: 92 | sources: loop+goal, contract | lenses: bot-loop, goal-and-tests, contract | verdict: refined_

## Minor

### Existing chat-stop test now asserts 0 === 0 and its comment states the opposite of what happens

`bot/test/tick.test.js:320-321`

`mockBot()`'s default is `isMoving: () => false` (bot/test/tick.test.js:31), and this test never overrides it. After the change `ticker.stop()` no longer calls `pathfinder.stop()`, so `stopsBefore` is 0 and the assertion `assert.equal(bot.calls.stop, stopsBefore)` is `0 === 0` — it passes by construction. The comment above it, "idle dispatched once: the park stopped already, paused ticks add no more stops", is now factually wrong: the park stopped nothing.

Concretely, the defect this assertion used to catch is no longer caught: drop the `ctx.lastGoalKey !== 'idle'` guard from `stopOnce()` so every paused tick stops, and this test still goes green, because with `isMoving()` false no call is counted either way. The stop-once-while-parked property is now only covered indirectly by the two tests that force `isMoving = () => true`, neither of which exercises the `ticker.stop()` chat path.

Fix: Set `bot.pathfinder.isMoving = () => true` before the `ticker.stop()` call in this test so `stopsBefore` is 1 and the "paused ticks add no more stops" assertion has teeth again, and fix the comment.

_confidence: 85 | sources: loop+goal | lenses: goal-and-tests | verdict: confirmed_

## Sources

| agent | executor | model | effort | tokens | raised | status |
| --- | --- | --- | --- | --- | --- | --- |
| loop+goal | claude | claude-opus-5 (requested opus) | high | 342717 | 2 | ok |
| contract | claude | claude-opus-5 (requested opus) | high | 348521 | 1 | ok |
