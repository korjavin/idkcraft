# Review: idkcraft-3nt.1 / 01-initial

scope: `/Users/iv/Projects/idkcraft/.revmux/tasks/idkcraft-3nt.1/01-initial/input/scope.md`

## Major

### Dispatch table is decorative: action is still hardcoded to 'follow', so BEHAVIOURS.fight will never run

`bot/src/index.js:28-33`

`applyDecision` looks up `const handler = BEHAVIOURS[decision.action]` (line 27) but then gates it behind `decision.action === 'follow'` (line 28). The table is never actually dispatched through — the action name is still hardcoded, and `typeof handler === 'function'` is dead code because the only key that can pass the first clause is `follow`, which is always a function.

Runtime today is identical to master, which is what this bead required, so nothing is broken on the current server. The failure lands on the dependent beads. idkcraft-3nt.3 (fight) is specified to wire itself in as "one entry to BEHAVIOURS" and the epic says fight/scout "touch bot/src/index.js by one line each (a dispatch-table entry)". goal.md likewise asks for "a `BEHAVIOURS` dispatch table" replacing the if-chain.

I ran this: with `BEHAVIOURS.fight` registered in memory and a brain returning `{action:'fight'}`, one tick gave `fight handler ran: 0 | setGoal: 0 | stop: 1`. The brain picks fight, the bot falls into the idle branch and calls `pathfinder.stop()`. The fight developer adds their one line, sees the bot stand still while a zombie hits it, and has to come back and edit this condition — exactly the index.js collision the bead exists to prevent.

(Today no brain can emit a non-follow/idle action — `brain.js:parseAction` filters to those two — so this is latent, not a live bug.)

Fix: Drop the hardcoded action name and dispatch on the table: `if (handler && target) { handler(bot, ctx, target) } else { ... }`. That keeps today's behaviour identical (only `follow` is registered) and makes a new entry a genuine one-line change.

_confidence: 95 | sources: loop+goal | lenses: goal-and-tests, bot-loop | verdict: confirmed_

## Minor

### Cross-tick target-position threading has no test; dropping one line silently kills player_moving and sprinting

`bot/src/index.js:69`

`lastTargetPos` used to be a closure variable that `buildState` wrote to directly — it was structurally impossible to lose. The split turns it into an explicit two-part hand-off: `perception.js:64` attaches `state._lastTargetPos`, and `index.js:69` reads it back. goal.md names this as a correctness condition ("`player_moving` still computed from the previous target position across ticks (state threaded, not lost)"), and the code gets it right.

Nothing tests it. No test in `bot/test/` asserts `player_moving` through the ticker at all (the only occurrences are hand-supplied literals in the `stateKey` and brain tests, which never exercise `buildState`). Delete or mistype line 69 and all 20 tests still pass.

The defect that would slip through: with the threading broken, `lastTargetPos` stays `null` forever, so `buildState` takes the `if (lastTargetPos)` branch never and `player_moving` is permanently `false`. I ran `buildState` twice with a target moving 10 -> 14 blocks: threaded gives `player_moving = true`, unthreaded gives `false`. Downstream, `stateToText` feeds `player_moving=false` to the sprint noul question ("more than 8 blocks away and moving"), so the bot stops sprinting to catch up with a running player, and the dedup `stateKey` loses one of the flags that forces a fresh brain call.

Fix: Add one ticker test alongside the dispatch test: tick once with the player at x=10, move the mock player entity to x=14, tick again, and assert the state handed to the brain has `player_moving === true` (the mock brain can capture its `state` argument).

_confidence: 90 | sources: loop+goal | lenses: goal-and-tests | verdict: confirmed_

## Sources

| agent | executor | model | effort | tokens | raised | status |
| --- | --- | --- | --- | --- | --- | --- |
| loop+goal | claude | claude-opus-5 (requested opus) | high | 373271 | 2 | ok |
| contract | claude | claude-opus-5 (requested opus) | high | 311056 | 0 | ok, nothing raised |
