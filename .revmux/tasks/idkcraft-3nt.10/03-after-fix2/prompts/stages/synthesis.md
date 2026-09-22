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
    "line": 119,
    "end_line": 124,
    "severity": "minor",
    "confidence": 85,
    "title": "No ticker test covers the stale-latch guard; if it regresses, a latched mob that dies freezes the tick loop permanently",
    "body": "The new latch block is ordered so that the `!isFightTarget(latched, ...)` guard at index.js:121 runs before index.js:125 dereferences `latched.position`. That guard is the only thing standing between the bot and a permanent freeze: `ctx.fightGivenUpId` holds a raw entity id, and when that mob dies or despawns `bot.entities[id]` is `undefined`. If the guard is ever removed, reordered, or narrowed (e.g. someone decides `isFightTarget` is redundant because perception already filtered), line 125 throws a TypeError, the `catch` at index.js:174 swallows it and returns before `applyDecision`, and the latch is never cleared — because the code that clears it is inside the block that throws. Every subsequent tick throws again: the bot holds whatever pathfinder goal it had, dispatches no behaviour, and logs `tick error:` once a second forever. A hostile dying mid-pursuit after give-up is completely ordinary (another player kills it, it burns at dawn, it despawns).\n\nI ran the real `createTicker` with the test-suite mocks through this sequence (Steve at 10, zombie at 6, 25 ticks to set the latch, then `delete bot.entities[1]`): the current code recovers correctly — `follow,follow,follow,follow`, no error. So the code is right today; what is missing is the assertion that keeps it right. Nothing in bot/test/ exercises it: fight.test.js:381 deletes the zombie before any latch is set, and the three ticker tests added by this change (fight.test.js:401, :421, :442) all keep the latched mob alive in `bot.entities` for the whole run.\n\nPre-existing code is not at fault here — the guard and the failure mode are both introduced by this diff.",
    "fix": "Add a ticker test next to fight.test.js:442: tick ~25 times with a stalled zombie at 6 blocks so the latch is set, then `delete bot.entities[1]`, and assert the next tick still returns a decision (`follow`) rather than `null`, so the stale-latch clear is pinned.",
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
    "line": 126,
    "end_line": 130,
    "severity": "minor",
    "confidence": 85,
    "title": "Melee-override comment claims keeping the latch avoids re-issuing a pursuit goal, but fight.js clears the latch and the goal is re-issued on the very next tick",
    "body": "index.js:128-129 justifies leaving `ctx.fightGivenUpId` set with: \"The latch stays set — clearing here would re-issue a pursuit goal at a mob already in reach.\" That holds for exactly one tick. On the override tick the brain answers fight, fight.js takes the given-up branch (fight.js:47-50), swings, and clears the latch itself. On the *next* tick the latch is `null`, so fight.js falls through to fight.js:56, finds `key !== ctx.lastGoalKey` (the key is still `fight-shadow:\u003cplayer\u003e` from the shadow ticks) and calls `bot.pathfinder.setGoal(new goals.GoalFollow(hostile, 2), true)` plus `equipSword` — the exact pursuit goal the comment says the design avoids, one tick later.\n\nMeasured on the real ticker with the test mocks (Steve at 30, zombie stalls at 6, latch set, zombie then parks at 1 block for 40 ticks): 40 attacks over 40 ticks, and exactly 1 `setGoal` — a fresh `GoalFollow` at a mob already inside `SWING_RANGE`. Runtime cost is one redundant A* search at an unreachable target, not a behaviour break, and the swings are correct throughout — so this is a comment that misstates its own rationale rather than a logic defect. In a project whose profile asks that changes explain themselves, the next reader will believe a guarantee the code does not give.",
    "fix": "Reword to what actually happens, e.g. \"The latch stays set so fight.js takes its given-up branch and swings this tick instead of opening a fresh pursuit; it clears the latch itself, and normal pursuit resumes next tick.\"",
    "sources": [
      "loop+goal"
    ],
    "lenses": [
      "bot-loop"
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

Prior rounds for this task: /Users/iv/Projects/idkcraft/.revmux/tasks/idkcraft-3nt.10/
  01-initial    2026-09-22T02:09Z  2 findings (0 critical, 1 major, 1 minor)  sources 2/2
  02-after-fix  2026-09-22T02:14Z  1 findings (0 critical, 1 major, 0 minor)  sources 2/2

Each round holds report.md (rendered) and findings.json (machine shape). Read the rounds you judge relevant.

Re-evaluate everything independently. A prior round reporting an issue is not evidence that it is real,
and a prior round missing one is not evidence that it is absent.

As you work, narrate what you are doing. This is a running commentary read live by a human watching the run, and it is separate from your answer, which goes only in the structured output.

- Before each group of related tool calls, write one short line saying what you are about to check and why: "checking whether the stagger gate can still open on a fork".
- When something turns out to matter, say so in one line as you find it.
- Keep going for the whole review. Do not narrate the opening few steps and then fall silent for the rest of it — a reader who stops seeing lines cannot tell you apart from a hung process.
- One line at a time, under a dozen words, and never a summary of what you already said.
