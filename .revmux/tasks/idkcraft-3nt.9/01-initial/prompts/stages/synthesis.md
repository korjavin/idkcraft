You are merging a review panel's findings into one set. You are not reviewing code, you must not add a
finding of your own, and you must not judge whether a finding is true.

**Work from the findings text below and nothing else. Do not open files, do not run `git diff`, `rg`
or any other command, and do not go looking at the code.** Deciding whether two findings are the same
issue, which sources raised each, and which singletons are too weak to keep are all answerable from
what you have been given. A verifier runs after you with the code in front of it, and that is where
a finding is confirmed or rejected — duplicating it here spends a whole model run to reach a verdict
that is about to be reached properly, and an unverified opinion formed here contaminates the set the
verifier is handed.

Nothing you do writes anything. Do not modify, delete, move, stage or commit, and do not write a file
through a shell redirect.

## Sources that ran

2 sources ran, 2 reported.
- loop+goal (lenses: bot-loop, goal-and-tests) reported 2 findings: loop+goal-1, loop+goal-2
- contract (lenses: contract) reported 1 findings: contract-1

Treat that list as fact. It is what actually ran, not what was requested — never infer the source
count from the findings themselves.

## Findings

[
  {
    "id": "loop+goal-1",
    "file": "bot/src/index.js",
    "line": 32,
    "end_line": 37,
    "severity": "major",
    "confidence": 80,
    "title": "stopOnce() leaves a stale pathfinder goal, so a parked bot resumes following when the player walks away",
    "body": "`stopOnce()` only calls `bot.pathfinder.stop()` when `isMoving()`, but it still flips `ctx.lastGoalKey` to `'idle'` unconditionally. `isMoving()` in mineflayer-pathfinder is `path.length \u003e 0` (node_modules/mineflayer-pathfinder/index.js:154) — it is false in the exact steady state follow reaches: the bot is standing next to the player, path is empty, and a *dynamic* `GoalFollow` is still installed as `stateGoal`.\n\nTrace: player is within range 3, so `monitorMovement` hits the `path.length === 0` branch (index.js:456-473), `stateGoal.isEnd()` is true and `dynamicGoal` is true, so the goal is kept and nothing happens. Player types `stop` → `handleChat` → `ticker.stop()` → `ctx.paused = true` and `stopOnce()`: `isMoving()` is false, so `pathfinder.stop()` is never called, the `GoalFollow` stays installed, and `lastGoalKey` becomes `'idle'`. Player now walks away → `stateGoal.hasChanged()` → `resetPath('goal_moved', false)` → the empty-path branch recomputes a path → the bot follows, despite being parked. Every subsequent paused tick calls `stopOnce()`, but the `lastGoalKey !== 'idle'` guard returns immediately, so the ticker never re-checks `isMoving()` and never cancels the goal: the bot follows the player forever until `follow me` or a restart.\n\nBefore this change the same sequence worked: `pathfinder.stop()` latched `stopPathing`, and the `goal_moved` `resetPath` ended in `if (stopPathing) return stop()` (index.js:139), which nulls `stateGoal` and calls `fullStop()`. So this is a regression introduced by the diff, not pre-existing, and it contradicts the bead's merge gate line \"no behaviour change otherwise\". The same holds for the brain deciding `idle` while the bot rests next to the player, and for the in-flight-park branch at bot/src/index.js:124.",
    "fix": "Cancel the goal instead of latching a stop: in `stopOnce()`, replace `if (bot.pathfinder.isMoving()) bot.pathfinder.stop()` with `bot.pathfinder.setGoal(null)`. `setGoal(null)` nulls `stateGoal`, empties `path` and calls `clearControlStates()` via `resetPath`, and never sets `stopPathing`, so it both halts a moving bot and clears an at-rest dynamic goal without the swallow the bead is fixing. Add a tick test: park while `isMoving()` is false and assert the goal is cleared (`setGoal` called with `null`).",
    "sources": [
      "loop+goal"
    ],
    "lenses": [
      "bot-loop",
      "goal-and-tests"
    ],
    "verdict": ""
  },
  {
    "id": "loop+goal-2",
    "file": "bot/test/tick.test.js",
    "line": 320,
    "end_line": 321,
    "severity": "minor",
    "confidence": 85,
    "title": "Existing chat-stop test now asserts 0 === 0 and its comment states the opposite of what happens",
    "body": "`mockBot()`'s default is `isMoving: () =\u003e false` (bot/test/tick.test.js:31), and this test never overrides it. After the change `ticker.stop()` no longer calls `pathfinder.stop()`, so `stopsBefore` is 0 and the assertion `assert.equal(bot.calls.stop, stopsBefore)` is `0 === 0` — it passes by construction. The comment above it, \"idle dispatched once: the park stopped already, paused ticks add no more stops\", is now factually wrong: the park stopped nothing.\n\nConcretely, the defect this assertion used to catch is no longer caught: drop the `ctx.lastGoalKey !== 'idle'` guard from `stopOnce()` so every paused tick stops, and this test still goes green, because with `isMoving()` false no call is counted either way. The stop-once-while-parked property is now only covered indirectly by the two tests that force `isMoving = () =\u003e true`, neither of which exercises the `ticker.stop()` chat path.",
    "fix": "Set `bot.pathfinder.isMoving = () =\u003e true` before the `ticker.stop()` call in this test so `stopsBefore` is 1 and the \"paused ticks add no more stops\" assertion has teeth again, and fix the comment.",
    "sources": [
      "loop+goal"
    ],
    "lenses": [
      "goal-and-tests"
    ],
    "verdict": ""
  },
  {
    "id": "contract-1",
    "file": "bot/src/index.js",
    "line": 32,
    "end_line": 37,
    "severity": "major",
    "confidence": 80,
    "title": "stopOnce() skips goal cancellation entirely when not moving, so chat `stop` no longer stops a parked follow",
    "body": "Found while reading during the contract pass; the contract lens itself is clean (see note below). Not raised by `contract` — flagging it because it is a confirmed runtime regression.\n\n`stopOnce()` replaces `stop()` with a no-op whenever `isMoving()` is false. But in mineflayer-pathfinder 2.4.5 `isMoving()` is `path.length \u003e 0`, while the goal lives in a separate `stateGoal`. `setGoal(new goals.GoalFollow(target, 3), true)` (bot/src/behaviours/follow.js:14) is dynamic, and once the bot arrives within range `monitorMovement` shifts the last node, sees `path.length === 0`, and — because `dynamicGoal` is true — deliberately does NOT clear `stateGoal` (node_modules/mineflayer-pathfinder/index.js:589-597, 455-463). So the normal parked state is: live dynamic follow goal, empty path, `isMoving() === false`.\n\nConcrete failure: the bot is following Steve and is standing 2 blocks away. Steve types `stop` in chat. `handleChat` -\u003e `ticker.setFollow('')` (sets `ctx.lastGoalKey = ''`) -\u003e `ticker.stop()` -\u003e `stopOnce()`: `lastGoalKey` is `''` so the branch is entered, `isMoving()` is false so `bot.pathfinder.stop()` is never called, and `lastGoalKey` flips to `'idle'`. `stateGoal` is still the GoalFollow. Steve walks away -\u003e `monitorMovement` sees `stateGoal.hasChanged()` -\u003e `resetPath('goal_moved', false)` -\u003e `getPathTo` -\u003e the bot walks after Steve again. Every subsequent paused tick calls `stopOnce()` and short-circuits on `lastGoalKey === 'idle'`, so nothing ever cancels it. `stop` is now advisory only.\n\nBefore this change the same sequence worked: `stop()` set `stopPathing = true`, and the latch was consumed by the very next `resetPath('goal_moved')` (index.js:138 `if (stopPathing) return stop()`), which cleared `stateGoal`, the path and the control states. The latch the bead calls a bug was also the thing that cancelled a pending goal. `GoalFollow` inherits the default `isValid() =\u003e true` (lib/goals.js:325), so a logged-out player does not clear it either — the same hole applies to the `!target` branch at bot/src/index.js:91.\n\nThis breaks goal.md's \"no behaviour change otherwise\" and the `stop` chat command, which is exactly the kind of runtime break the bead was not supposed to introduce.",
    "fix": "Cancel the goal instead of doing nothing on an empty path — `setGoal(null)` clears `stateGoal` and the path via `resetPath('goal_updated')` without setting `stopPathing`, so it cannot latch:\n\n```js\nfunction stopOnce() {\n  if (ctx.lastGoalKey !== 'idle') {\n    if (bot.pathfinder.isMoving()) bot.pathfinder.stop()\n    else bot.pathfinder.setGoal(null)\n    ctx.lastGoalKey = 'idle'\n  }\n}\n```\n\nThe new guard test (bot/test/tick.test.js:69-99) then needs its `calls.setGoal` expectation bumped, since the idle tick issues a `setGoal(null)`; `calls.effectiveGoals` and the no-latch assertion still hold. A ticker test that a parked dynamic follow goal is cleared by `ticker.stop()` would cover the regression directly.",
    "sources": [
      "contract"
    ],
    "lenses": [
      "contract"
    ],
    "verdict": ""
  }
]

## What to produce

1. Split out what is not a defect in the change under review. A question the reviewer could not
   answer from the code goes to **open questions**; a defect in code the change did not touch goes to
   **pre-existing**. Move both out first: neither is deduped, boosted or dropped.

2. Deduplicate. Two findings are the same when they name the same file within two lines of each other
   and describe the same problem. Merge them into one, keeping the clearest title and body.

3. Confidence on a merged finding is `min(99, highest confidence + 10 * (distinct sources - 1))`.
   A source is a process. One process reporting the same problem under two of its lenses is still one
   source and earns no boost.

4. Severity is the highest severity any input claimed.

5. Drop a finding that has a single source, confidence below 80, and nothing corroborating it.
   Never drop a critical or a major this way — a single source is not evidence against a serious
   defect, and only one reviewer looking in the right place is the normal case for the worst bugs.
   Keep it and route it to the verifier, which is the authority on whether it is real.
   When the source list above shows the run was degraded, drop nothing: keep every would-be-drop and
   route it to the verifier instead. Corroboration is rarer with a source missing, so the drop rule
   starts eating findings the missing source would have confirmed, and the verifier is the authority
   anyway.

Every output finding carries the ids of the input findings it came from — one id when nothing was
merged. Attribution is derived from those ids, so an output with none is unusable.

As you work, narrate what you are doing. This is a running commentary read live by a human watching the run, and it is separate from your answer, which goes only in the structured output.

- Before each group of related tool calls, write one short line saying what you are about to check and why: "checking whether the stagger gate can still open on a fork".
- When something turns out to matter, say so in one line as you find it.
- Keep going for the whole review. Do not narrate the opening few steps and then fall silent for the rest of it — a reader who stops seeing lines cannot tell you apart from a hung process.
- One line at a time, under a dozen words, and never a summary of what you already said.
