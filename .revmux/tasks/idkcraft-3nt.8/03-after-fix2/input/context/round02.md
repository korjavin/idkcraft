# Round 02 findings (both addressed)

## loop+goal-1 [minor] 'stop' said during the brain await still issues one follow goal
The new `ctx.paused` guard is checked only once, at the top of `tick()` (line 50). The unpaused path awaits `brain.decide(state)` at line 107 and then calls `applyDecision(decision, target, state)` at line 116 without re-checking `ctx.paused`.

Trigger (one tick): a player is nearby, the tick reaches `await brain.decide(state)` — the await window is up to `BRAIN_TIMEOUT_MS`, defaulting to `BRAIN_TICK_MS` (1000 ms) and set to 3000 ms in the compose contract. During that await the event loop delivers a `chat` packet; `handleChat` (line 176-180) runs `ticker.setFollow('')` + `ticker.stop()`, setting `ctx.paused = true`, calling `bot.pathfinder.stop()` and `ctx.lastGoalKey = 'idle'`. The brain promise then resolves, and the in-flight tick runs `applyDecision` on the `target` entity it captured before the await: `follow()` sees `key !== ctx.lastGoalKey` ('idle') and calls `bot.pathfinder.setGoal(new goals.GoalFollow(target, 3), true)`, and line 37 logs `decision source=jev action=follow ...`.

So after `stop` the bot is handed a fresh dynamic follow goal and walks toward the player. It self-corrects on the next tick — the paused branch sees `ctx.lastGoalKey === 'follow:<name>'` and calls `pathfinder.stop()` — but `pathfinder.stop()` only sets `stopPathing`, so the bot keeps walking to the next path node before halting. Net effect: `stop` costs an extra step or two, plus one `action=follow` log line, which is exactly what the merge gate says must not happen ("no setGoal and no follow decision with a player nearby until 'follow me'").

The race existed in form before this change (the old `setFollow('')` was equally ignored mid-await), but the bead's whole point is that the paused flag now makes `stop` authoritative, and this path escapes it. The sequential `await ticker.tick()` calls in the new test cannot hit the window.
FIX: Re-check the flag after the await, before acting: at line 116, `if (ctx.paused) return { decision: { action: 'idle', sprint: false, source: 'local-idle' }, calledBrain }` ahead of `applyDecision(...)`.

## loop+goal-2 [minor] 'parked with nobody online scans nothing' passes by construction — the scout throttle, not the guard, makes it green
This test is the regression guard for the merge-gate criterion "scans nothing with nobody online" and for round 01's fix (moving the scout seam inside the `if (target)` arm of the paused branch, `bot/src/index.js:57-61`). It does not actually pin it.

Sequence: tick 1 runs the unpaused path with Steve online, creates `ctx.scout` and scans once — `makeScout` records `lastScan = Date.now()` (`bot/src/behaviours/scout.js:125,128-130`, `everyMs = 5000`). The test then calls `setFollow('')`, `stop()`, empties `bot.players`, and ticks again immediately — milliseconds later on the real clock, since unlike the first test (lines 266-277) this one never mocks `Date.now`.

Now delete the `if (target)` guard so the paused branch ticks the scout unconditionally, as it did in round 01. `ctx.scout.tick()` runs, computes `t - lastScan` of a few milliseconds, sees `< 5000` and returns before touching `bot.findBlocks`. `bot.findCalls` is still 1, and `assert.equal(bot.findCalls, before)` at line 313 passes anyway. The reverted bug — parked bot scanning and chatting ore into an empty server — ships with the suite green.

(The neighbouring `scout seam` test at line 220 is sound for the unpaused path: there no scout is ever created, so `findCalls` is 0 from a fresh ticker. The first paused test is also sound — it freezes `Date.now` at `t0 + 6000`, so `findCalls > 1` genuinely fails if the paused scout seam is deleted.)
FIX: Mock the clock past the throttle before the nobody-online paused tick, the way the first test does: `const realNow = Date.now; const t0 = realNow(); Date.now = () => t0 + 6000` around line 312's `await ticker.tick()`, restoring in a `finally`. Then a scan would fire if the `if (target)` guard were removed, and the assertion becomes real.
