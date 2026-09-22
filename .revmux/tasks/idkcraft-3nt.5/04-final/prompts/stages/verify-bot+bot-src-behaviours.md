You are verifying findings another reviewer produced. You see only the findings assigned to you.
There is no wider set to compare against, and you must not go looking for new problems.

This review is **read-only**. You may read files and run read-only commands such as `git diff`,
`git log` and `rg`. Do not modify, delete, move, stage or commit anything, and do not write a file
through a shell redirect. Report what you find; changing it is the caller's job, never yours.
Do not run tests, builds or the linter - all of that was done before the review and passed.

## Where the context lives

Each item below is a **path**, not the text it names.

- `/Users/iv/Projects/idkcraft/.revmux/tasks/idkcraft-3nt.5/04-final/input/scope.md` — what was under review and the command that produces the diff.
- `/Users/iv/Projects/idkcraft/.revmux/tasks/idkcraft-3nt.5/04-final/prompts/input-profile.md` — the project's own conventions. A finding that contradicts them is wrong, not right.
- `/Users/iv/Projects/idkcraft-muse-1` — run every command from here.

## Findings to verify

[
  {
    "id": "loop+goal-2",
    "file": "bot/README.md",
    "line": 52,
    "end_line": 63,
    "severity": "minor",
    "confidence": 99,
    "title": "bot/README.md still documents three brain actions and the pre-change 3-block thresholds, which this diff falsifies",
    "body": "This change moved the stub/criteria thresholds: follow now triggers at \u003e3 blocks only while the player is moving and at \u003e6 while standing still (bot/src/brain.js:38-42), and a still player inside 6 blocks yields `roam` (brain.js:47). bot/README.md was not updated, so three statements are now factually wrong for the code in this diff: `:50-52` enumerates the exclusive actions as `fight` / `follow` / `idle` with \"`idle`: Player is close (\u003c= 3 blocks)\"; the behaviours table at `:61` says `follow` triggers at \"Player \u003e 3 blocks away\"; `:63` says `idle` triggers at \"Player within 3 blocks\". There is no `roam` row at all. The incremental point is that the two existing rows are now actively wrong, not merely missing a sibling.\n\nFailure case is a reader, not the runtime: the bead's in-game acceptance is checked against this table (\"Log lines show action=roam\"), and an owner following the README to verify the deployed bot finds no documented `action=roam` and an `idle` trigger that states the opposite of what the bot does at 1-3 blocks while standing still. Nothing at runtime reads the README — both reviewers confirmed no code path depends on it.\n\nPre-flagged and deferred: the round-04 scope defers this to the docs track because bot/README.md is edited in parallel and is outside this bead's file list. Reported so the merge decision is made knowingly; if the docs track owns it, a follow-up bead is enough.",
    "fix": "Either add the `roam` bullet/table row and correct the follow/idle triggers to the moving/still split (\u003e3 moving, \u003e6 still), or file a follow-up bead against the docs track so the drift is not lost at merge.",
    "sources": [
      "loop+goal",
      "contract"
    ],
    "lenses": [
      "goal-and-tests",
      "contract"
    ],
    "verdict": ""
  },
  {
    "id": "contract-1",
    "file": "bot/src/behaviours/roam.js",
    "line": 36,
    "end_line": 41,
    "severity": "major",
    "confidence": 90,
    "title": "Roaming defeats the ticker's brain-call dedup cache: ~1 brain call per tick while a player stands still",
    "body": "`stateKey` (bot/src/perception.js:33) rounds `distance_to_player` to whole blocks, and the ticker reuses `lastDecision` only while that key is unchanged (bot/src/index.js:113-124) — the deliberate \"skip the JEV call\" guard.\n\nBefore this change, a still player near the bot produced `idle`, the bot did not move, the rounded distance was constant, and the brain was called once and then cached indefinitely. With roam the bot now walks ~4 blocks per 1000 ms tick between random points 0-6 blocks from the player, so the rounded distance flips almost every tick and the cache almost never hits.\n\nI ran the real ticker against the real `stubBrain` with a mock bot that walks toward each issued GoalNear at ~4 blocks/tick, player stationary, 30 ticks:\n- old path (idle, bot stationary): **1** brain call\n- new path (roam): **27** brain calls, 20 goals set\n\nConcretely: one AFK or building player standing next to the bot now drives a POST to `http://laya:8000/v1/systemone` every second, indefinitely, where it previously drove one call for the whole episode. On the deployed stack that is the CPU sidecar (`LAYA_MEM_LIMIT` 3g) running a System-1 inference every second for as long as anyone stands still — the most common state on a hobby server. If a LAYA answer takes longer than `BRAIN_TICK_MS`, the `inFlight` guard also starts dropping ticks, so fight/follow reaction time degrades exactly while roaming.\n\nThis is a side effect of the bead, not its point: the bead asks for strolling, nothing in it asks for the dedup cache to stop working.",
    "fix": "Give roam its own cheap re-entry so the brain is not re-asked for every block of stroll travel — e.g. include the bot's own motion in the cache decision, or let the ticker keep reusing `lastDecision` while the previous action was `roam` and only the rounded `distance_to_player` changed (hostile fields, `player_moving` and `player_visible` unchanged). Alternatively round `distance_to_player` more coarsely inside the roam envelope.",
    "sources": [
      "contract"
    ],
    "lenses": [
      "contract"
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
and most of what is raised about one cites no line of code. Where `/Users/iv/Projects/idkcraft/.revmux/tasks/idkcraft-3nt.5/04-final/input/scope.md` describes such an item,
a finding whose `file` is empty is that kind of claim rather than a finding that lost its location,
and everything in this section applies to it alone.

A finding that names a file is judged exactly as above, and so is one that names none while
`/Users/iv/Projects/idkcraft/.revmux/tasks/idkcraft-3nt.5/04-final/input/scope.md` describes a change and the command that diffs it. Nothing in this section reaches that
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

Prior rounds for this task: /Users/iv/Projects/idkcraft/.revmux/tasks/idkcraft-3nt.5/
  01-initial           2026-09-22T00:46Z  3 findings (0 critical, 1 major, 2 minor)  sources 2/2
  03-after-fix-retry2  2026-09-22T01:25Z  4 findings (0 critical, 2 major, 2 minor)  sources 2/2

Each round holds report.md (rendered) and findings.json (machine shape). Read the rounds you judge relevant.

Re-evaluate everything independently. A prior round reporting an issue is not evidence that it is real,
and a prior round missing one is not evidence that it is absent.

As you work, narrate what you are doing. This is a running commentary read live by a human watching the run, and it is separate from your answer, which goes only in the structured output.

- Before each group of related tool calls, write one short line saying what you are about to check and why: "checking whether the stagger gate can still open on a fork".
- When something turns out to matter, say so in one line as you find it.
- Keep going for the whole review. Do not narrate the opening few steps and then fall silent for the rest of it — a reader who stops seeing lines cannot tell you apart from a hung process.
- One line at a time, under a dozen words, and never a summary of what you already said.
