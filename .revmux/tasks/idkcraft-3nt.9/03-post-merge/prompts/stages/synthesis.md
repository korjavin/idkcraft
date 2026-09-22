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
- loop+goal (lenses: bot-loop, goal-and-tests) reported 1 findings: loop+goal-1
- contract (lenses: contract) reported no findings

Treat that list as fact. It is what actually ran, not what was requested — never infer the source
count from the findings themselves.

## Findings

[
  {
    "id": "loop+goal-1",
    "file": "bot/src/index.js",
    "line": 36,
    "end_line": 37,
    "severity": "minor",
    "confidence": 65,
    "title": "stopOnce() still latches stopPathing on the moving branch, so the ~6 s fight freeze the bead targets stays reachable",
    "body": "`stopOnce()` guards only the empty-path case. When `isMoving()` is true it still calls `bot.pathfinder.stop()`, which in mineflayer-pathfinder 2.4.5 only sets `stopPathing = true` (node_modules/mineflayer-pathfinder/index.js:162-164). That flag is consumed in exactly two places: node arrival in `monitorMovement` (index.js:581-584) and any `resetPath` (index.js:139 `if (stopPathing) return stop()`). Usually the bot reaches the next node in well under a tick, so the latch is gone before the next brain decision and this is harmless.\n\nIt is not harmless when the next path node takes longer than one tick. Concrete sequence, `BRAIN_TICK_MS=1000`: the bot is following Steve and the next node has `toBreak` entries, so it is digging through stone. Steve stands still watching, so the dynamic `GoalFollow.hasChanged()` never fires and no `resetPath` runs. Tick N: the brain returns `idle` -\u003e `applyDecision` -\u003e `stopOnce()` -\u003e `isMoving()` is true (path non-empty) -\u003e `stop()` sets the latch, `lastGoalKey='idle'`. The dig is still running, so no node arrival consumes it. Tick N+1: a zombie spawns, the brain returns `fight` -\u003e fight.js:63-66 `key !== ctx.lastGoalKey` -\u003e `setGoal(new GoalFollow(hostile, 2), true)` -\u003e `resetPath('goal_updated')` -\u003e `if (stopPathing) return stop()` -\u003e `stateGoal = null`, the goal is swallowed. fight.js has already set `ctx.lastGoalKey = 'fight:\u003cid\u003e'` and `ctx.fightPursuit = 0`. Ticks N+2..N+6: `key === ctx.lastGoalKey`, `!inRange`, `isMoving()` false -\u003e `fightPursuit` increments, and the re-issue only happens at `fightPursuit % RETRY_EVERY_TICKS === 0` (fight.js:81-83, `RETRY_EVERY_TICKS = 6`). The bot stands still for ~6 s before pathing to the mob — the exact symptom the bead's Why section describes.\n\nThis is pre-existing, not introduced here: all five call sites did an unconditional `stop()` before the diff, and the change does not make the moving branch newly reachable. `follow` also self-heals in one tick because follow.js:13 re-issues whenever `!isMoving()`; only fight's deliberately spaced retries turn it into a multi-second stall. All four merge-gate criteria are met and I would not block the merge on this — it is the residual half of the same bug, worth a follow-up bead rather than a fix in this diff.",
    "fix": "Follow-up, not this diff: `setGoal(null)` is a strictly stronger halt than `stop()` — `resetPath` empties `path` and calls `bot.clearControlStates()` immediately, and it never sets `stopPathing` — so `stopOnce()` could drop the branch entirely and always cancel via `setGoal(null)` when `bot.pathfinder.goal || bot.pathfinder.isMoving()`. Tradeoff to weigh: `stop()` lets the bot finish walking to the current node, while `setGoal(null)` halts mid-step. It also needs the two `calls.stop === 1` assertions (bot/test/tick.test.js:65 and 217) rewritten, which is why it does not belong in this bead's budget.",
    "sources": [
      "loop+goal"
    ],
    "lenses": [
      "bot-loop",
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

Prior rounds for this task: /Users/iv/Projects/idkcraft/.revmux/tasks/idkcraft-3nt.9/
  01-initial    2026-09-22T00:38Z  2 findings (0 critical, 1 major, 1 minor)  sources 2/2
  02-after-fix  2026-09-22T00:43Z  0 findings (0 critical, 0 major, 0 minor)  sources 2/2

Each round holds report.md (rendered) and findings.json (machine shape). Read the rounds you judge relevant.

Re-evaluate everything independently. A prior round reporting an issue is not evidence that it is real,
and a prior round missing one is not evidence that it is absent.

As you work, narrate what you are doing. This is a running commentary read live by a human watching the run, and it is separate from your answer, which goes only in the structured output.

- Before each group of related tool calls, write one short line saying what you are about to check and why: "checking whether the stagger gate can still open on a fork".
- When something turns out to matter, say so in one line as you find it.
- Keep going for the whole review. Do not narrate the opening few steps and then fall silent for the rest of it — a reader who stops seeing lines cannot tell you apart from a hung process.
- One line at a time, under a dozen words, and never a summary of what you already said.
