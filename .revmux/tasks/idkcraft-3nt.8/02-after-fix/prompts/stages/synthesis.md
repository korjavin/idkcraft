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
- contract (lenses: contract) reported no findings

Treat that list as fact. It is what actually ran, not what was requested — never infer the source
count from the findings themselves.

## Findings

[
  {
    "id": "loop+goal-1",
    "file": "bot/src/index.js",
    "line": 116,
    "end_line": 116,
    "severity": "minor",
    "confidence": 80,
    "title": "'stop' said during the brain await still issues one follow goal",
    "body": "The new `ctx.paused` guard is checked only once, at the top of `tick()` (line 50). The unpaused path awaits `brain.decide(state)` at line 107 and then calls `applyDecision(decision, target, state)` at line 116 without re-checking `ctx.paused`.\n\nTrigger (one tick): a player is nearby, the tick reaches `await brain.decide(state)` — the await window is up to `BRAIN_TIMEOUT_MS`, defaulting to `BRAIN_TICK_MS` (1000 ms) and set to 3000 ms in the compose contract. During that await the event loop delivers a `chat` packet; `handleChat` (line 176-180) runs `ticker.setFollow('')` + `ticker.stop()`, setting `ctx.paused = true`, calling `bot.pathfinder.stop()` and `ctx.lastGoalKey = 'idle'`. The brain promise then resolves, and the in-flight tick runs `applyDecision` on the `target` entity it captured before the await: `follow()` sees `key !== ctx.lastGoalKey` ('idle') and calls `bot.pathfinder.setGoal(new goals.GoalFollow(target, 3), true)`, and line 37 logs `decision source=jev action=follow ...`.\n\nSo after `stop` the bot is handed a fresh dynamic follow goal and walks toward the player. It self-corrects on the next tick — the paused branch sees `ctx.lastGoalKey === 'follow:\u003cname\u003e'` and calls `pathfinder.stop()` — but `pathfinder.stop()` only sets `stopPathing`, so the bot keeps walking to the next path node before halting. Net effect: `stop` costs an extra step or two, plus one `action=follow` log line, which is exactly what the merge gate says must not happen (\"no setGoal and no follow decision with a player nearby until 'follow me'\").\n\nThe race existed in form before this change (the old `setFollow('')` was equally ignored mid-await), but the bead's whole point is that the paused flag now makes `stop` authoritative, and this path escapes it. The sequential `await ticker.tick()` calls in the new test cannot hit the window.",
    "fix": "Re-check the flag after the await, before acting: at line 116, `if (ctx.paused) return { decision: { action: 'idle', sprint: false, source: 'local-idle' }, calledBrain }` ahead of `applyDecision(...)`.",
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
    "line": 296,
    "end_line": 313,
    "severity": "minor",
    "confidence": 90,
    "title": "'parked with nobody online scans nothing' passes by construction — the scout throttle, not the guard, makes it green",
    "body": "This test is the regression guard for the merge-gate criterion \"scans nothing with nobody online\" and for round 01's fix (moving the scout seam inside the `if (target)` arm of the paused branch, `bot/src/index.js:57-61`). It does not actually pin it.\n\nSequence: tick 1 runs the unpaused path with Steve online, creates `ctx.scout` and scans once — `makeScout` records `lastScan = Date.now()` (`bot/src/behaviours/scout.js:125,128-130`, `everyMs = 5000`). The test then calls `setFollow('')`, `stop()`, empties `bot.players`, and ticks again immediately — milliseconds later on the real clock, since unlike the first test (lines 266-277) this one never mocks `Date.now`.\n\nNow delete the `if (target)` guard so the paused branch ticks the scout unconditionally, as it did in round 01. `ctx.scout.tick()` runs, computes `t - lastScan` of a few milliseconds, sees `\u003c 5000` and returns before touching `bot.findBlocks`. `bot.findCalls` is still 1, and `assert.equal(bot.findCalls, before)` at line 313 passes anyway. The reverted bug — parked bot scanning and chatting ore into an empty server — ships with the suite green.\n\n(The neighbouring `scout seam` test at line 220 is sound for the unpaused path: there no scout is ever created, so `findCalls` is 0 from a fresh ticker. The first paused test is also sound — it freezes `Date.now` at `t0 + 6000`, so `findCalls \u003e 1` genuinely fails if the paused scout seam is deleted.)",
    "fix": "Mock the clock past the throttle before the nobody-online paused tick, the way the first test does: `const realNow = Date.now; const t0 = realNow(); Date.now = () =\u003e t0 + 6000` around line 312's `await ticker.tick()`, restoring in a `finally`. Then a scan would fire if the `if (target)` guard were removed, and the assertion becomes real.",
    "sources": [
      "loop+goal"
    ],
    "lenses": [
      "goal-and-tests"
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

Prior rounds for this task: /Users/iv/Projects/idkcraft/.revmux/tasks/idkcraft-3nt.8/
  01-initial  2026-09-21T23:42Z  2 findings (0 critical, 0 major, 2 minor)  sources 2/2

Each round holds report.md (rendered) and findings.json (machine shape). Read the rounds you judge relevant.

Re-evaluate everything independently. A prior round reporting an issue is not evidence that it is real,
and a prior round missing one is not evidence that it is absent.

As you work, narrate what you are doing. This is a running commentary read live by a human watching the run, and it is separate from your answer, which goes only in the structured output.

- Before each group of related tool calls, write one short line saying what you are about to check and why: "checking whether the stagger gate can still open on a fork".
- When something turns out to matter, say so in one line as you find it.
- Keep going for the whole review. Do not narrate the opening few steps and then fall silent for the rest of it — a reader who stops seeing lines cannot tell you apart from a hung process.
- One line at a time, under a dozen words, and never a summary of what you already said.
