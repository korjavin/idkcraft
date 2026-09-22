You are verifying findings another reviewer produced. You see only the findings assigned to you.
There is no wider set to compare against, and you must not go looking for new problems.

This review is **read-only**. You may read files and run read-only commands such as `git diff`,
`git log` and `rg`. Do not modify, delete, move, stage or commit anything, and do not write a file
through a shell redirect. Report what you find; changing it is the caller's job, never yours.
Do not run tests, builds or the linter - all of that was done before the review and passed.

## Where the context lives

Each item below is a **path**, not the text it names.

- `/Users/iv/Projects/idkcraft/.revmux/tasks/idkcraft-3nt.1/01-initial/input/scope.md` — what was under review and the command that produces the diff.
- `/Users/iv/Projects/idkcraft/.revmux/tasks/idkcraft-3nt.1/01-initial/prompts/input-profile.md` — the project's own conventions. A finding that contradicts them is wrong, not right.
- `/Users/iv/Projects/idkcraft-review` — run every command from here.

## Findings to verify

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

## For each finding

Open the file at the line named and read enough around it to judge — or, when the finding names no
file, read what it does cite; see below. Then return exactly one verdict, quoting the finding's `id`
unchanged:

- **confirmed** — the problem is real as described.
- **refined** — the problem is real but the description, location, severity or confidence is wrong.
  Return the corrected values alongside the verdict; every field you omit keeps its original value.
- **rejected** — the problem is not real. The code already handles it, the reviewer misread it, or the
  claimed trigger cannot occur.
- **immaterial** — accurate, and still not worth acting on.
- **pre_existing** — real, but present in code the change under review did not touch.

Judge the finding, not the reviewer. A confident description is not evidence, and a hedged one is not
a reason to reject. Where the code contradicts the finding, say so and reject it.

## When a finding names no file

A review can be judging a filed item — an issue, a defect report, a proposal — rather than a change,
and most of what is raised about one cites no line of code. Where `/Users/iv/Projects/idkcraft/.revmux/tasks/idkcraft-3nt.1/01-initial/input/scope.md` describes such an item,
a finding whose `file` is empty is that kind of claim rather than a finding that lost its location,
and everything in this section applies to it alone.

A finding that names a file is judged exactly as above, and so is one that names none while
`/Users/iv/Projects/idkcraft/.revmux/tasks/idkcraft-3nt.1/01-initial/input/scope.md` describes a change and the command that diffs it. Nothing in this section reaches that
finding: the missing location is its defect, not its shape. Find what it points at and refine it with
the location, or reject it when the code supports none.

Judge it against what it does cite: the comment in the thread and who wrote it, the comparable item
and how it was answered, the rule in the project's own documents. Read that the way you would open a
file for a finding that names a line, and check it — a claim about how something was decided before
is as checkable as a claim about a function. A claim citing nothing at all is what rejection is for.

Two verdicts read differently here:

- **pre_existing does not apply.** It marks a defect the change under review did not introduce, and
  there is no change for anything to pre-date. Never send a claim about existing code there because
  the code was already that way — that it already is is usually the claim's whole point.
- **immaterial** means the point does not bear on the decision being asked for, not that a defect is
  not worth fixing. An accurate point that leaves the answer where it was is immaterial; one that
  would change it is not, however small the thing it names.

## The materiality test

A finding is material when acting on it changes something a person would notice. Apply the test only
after you have confirmed the problem is real — immaterial is not a softer rejection, and a wrong
finding is rejected rather than dismissed as minor.

Answer three questions:

1. **Can it happen?** Name the input or state that triggers it. A path no caller can reach, a branch
   guarded upstream, or a condition the type system already excludes is immaterial.
2. **Does it matter when it happens?** Name the consequence — wrong output, data loss, a crash, a
   security hole, a maintainer misled. An outcome nobody would observe is immaterial.
3. **Is the fix worth it?** Severity measures the value of fixing; the fix's blast radius measures what
   fixing costs and risks. Weigh the two against each other — you are better placed to than the reviewer
   was, having read the surrounding code he never saw.

   Name the fix, then say how far it reaches: does it stay at the finding's own site, or does it edit
   shared code, alter a signature, restructure control flow, or change what callers elsewhere see? Set
   that against the consequence question 2 already made you name. A restructuring larger than the
   problem it removes is immaterial at any severity. A minor whose fix reaches well beyond its own site
   is immaterial too — touching working code across a package to correct something barely anyone
   suffers from is how a nit becomes a regression.

   **This is a comparison, not a checklist, and reach alone never decides it.** Most real fixes add a
   branch: an error that was dropped is now checked, a nil is now guarded, a boundary is now correct.
   Those change control flow and are exactly what a minor finding usually is — confirm them. Question 2
   has already established that someone suffers the consequence, so a fix proportionate to it is worth
   making however small the defect. Dismiss only when the cost genuinely outweighs what question 2
   named, and say what the cost was.

A finding that survives all three is confirmed or refined. Style preferences, hypothetical futures and
restatements of the code as written are immaterial by definition.

**A finding the section above covers answers the first two questions only** — read as whether the claim
holds and whether its holding bears on the decision. Skip the third: there is no fix, so its blast
radius has nothing to measure, and applying it anyway dismisses every such finding for a cost that
does not exist. One that can hold and matters when it does is confirmed or refined.

Return one entry per finding you were given, and no entry for a finding you were not given.

As you work, narrate what you are doing. This is a running commentary read live by a human watching the run, and it is separate from your answer, which goes only in the structured output.

- Before each group of related tool calls, write one short line saying what you are about to check and why: "checking whether the stagger gate can still open on a fork".
- When something turns out to matter, say so in one line as you find it.
- Keep going for the whole review. Do not narrate the opening few steps and then fall silent for the rest of it — a reader who stops seeing lines cannot tell you apart from a hung process.
- One line at a time, under a dozen words, and never a summary of what you already said.
