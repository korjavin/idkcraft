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
    "line": 28,
    "end_line": 33,
    "severity": "major",
    "confidence": 95,
    "title": "Dispatch table is decorative: action is still hardcoded to 'follow', so BEHAVIOURS.fight will never run",
    "body": "`applyDecision` looks up `const handler = BEHAVIOURS[decision.action]` (line 27) but then gates it behind `decision.action === 'follow'` (line 28). The table is never actually dispatched through — the action name is still hardcoded, and `typeof handler === 'function'` is dead code because the only key that can pass the first clause is `follow`, which is always a function.\n\nRuntime today is identical to master, which is what this bead required, so nothing is broken on the current server. The failure lands on the dependent beads. idkcraft-3nt.3 (fight) is specified to wire itself in as \"one entry to BEHAVIOURS\" and the epic says fight/scout \"touch bot/src/index.js by one line each (a dispatch-table entry)\". goal.md likewise asks for \"a `BEHAVIOURS` dispatch table\" replacing the if-chain.\n\nI ran this: with `BEHAVIOURS.fight` registered in memory and a brain returning `{action:'fight'}`, one tick gave `fight handler ran: 0 | setGoal: 0 | stop: 1`. The brain picks fight, the bot falls into the idle branch and calls `pathfinder.stop()`. The fight developer adds their one line, sees the bot stand still while a zombie hits it, and has to come back and edit this condition — exactly the index.js collision the bead exists to prevent.\n\n(Today no brain can emit a non-follow/idle action — `brain.js:parseAction` filters to those two — so this is latent, not a live bug.)",
    "fix": "Drop the hardcoded action name and dispatch on the table: `if (handler \u0026\u0026 target) { handler(bot, ctx, target) } else { ... }`. That keeps today's behaviour identical (only `follow` is registered) and makes a new entry a genuine one-line change.",
    "sources": [
      "loop+goal"
    ],
    "lenses": [
      "goal-and-tests",
      "bot-loop"
    ],
    "verdict": ""
  },
  {
    "id": "loop+goal-2",
    "file": "bot/src/index.js",
    "line": 69,
    "end_line": 69,
    "severity": "minor",
    "confidence": 90,
    "title": "Cross-tick target-position threading has no test; dropping one line silently kills player_moving and sprinting",
    "body": "`lastTargetPos` used to be a closure variable that `buildState` wrote to directly — it was structurally impossible to lose. The split turns it into an explicit two-part hand-off: `perception.js:64` attaches `state._lastTargetPos`, and `index.js:69` reads it back. goal.md names this as a correctness condition (\"`player_moving` still computed from the previous target position across ticks (state threaded, not lost)\"), and the code gets it right.\n\nNothing tests it. No test in `bot/test/` asserts `player_moving` through the ticker at all (the only occurrences are hand-supplied literals in the `stateKey` and brain tests, which never exercise `buildState`). Delete or mistype line 69 and all 20 tests still pass.\n\nThe defect that would slip through: with the threading broken, `lastTargetPos` stays `null` forever, so `buildState` takes the `if (lastTargetPos)` branch never and `player_moving` is permanently `false`. I ran `buildState` twice with a target moving 10 -\u003e 14 blocks: threaded gives `player_moving = true`, unthreaded gives `false`. Downstream, `stateToText` feeds `player_moving=false` to the sprint noul question (\"more than 8 blocks away and moving\"), so the bot stops sprinting to catch up with a running player, and the dedup `stateKey` loses one of the flags that forces a fresh brain call.",
    "fix": "Add one ticker test alongside the dispatch test: tick once with the player at x=10, move the mock player entity to x=14, tick again, and assert the state handed to the brain has `player_moving === true` (the mock brain can capture its `state` argument).",
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

As you work, narrate what you are doing. This is a running commentary read live by a human watching the run, and it is separate from your answer, which goes only in the structured output.

- Before each group of related tool calls, write one short line saying what you are about to check and why: "checking whether the stagger gate can still open on a fork".
- When something turns out to matter, say so in one line as you find it.
- Keep going for the whole review. Do not narrate the opening few steps and then fall silent for the rest of it — a reader who stops seeing lines cannot tell you apart from a hung process.
- One line at a time, under a dozen words, and never a summary of what you already said.
