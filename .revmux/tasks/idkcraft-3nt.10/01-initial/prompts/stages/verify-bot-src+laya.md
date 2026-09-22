You are verifying findings another reviewer produced. You see only the findings assigned to you.
There is no wider set to compare against, and you must not go looking for new problems.

This review is **read-only**. You may read files and run read-only commands such as `git diff`,
`git log` and `rg`. Do not modify, delete, move, stage or commit anything, and do not write a file
through a shell redirect. Report what you find; changing it is the caller's job, never yours.
Do not run tests, builds or the linter - all of that was done before the review and passed.

## Where the context lives

Each item below is a **path**, not the text it names.

- `/Users/iv/Projects/idkcraft/.revmux/tasks/idkcraft-3nt.10/01-initial/input/scope.md` — what was under review and the command that produces the diff.
- `/Users/iv/Projects/idkcraft/.revmux/tasks/idkcraft-3nt.10/01-initial/prompts/input-profile.md` — the project's own conventions. A finding that contradicts them is wrong, not right.
- `/Users/iv/Projects/idkcraft-muse-1` — run every command from here.

## Findings to verify

[
  {
    "id": "loop+goal-1",
    "file": "bot/src/index.js",
    "line": 115,
    "end_line": 118,
    "severity": "major",
    "confidence": 90,
    "title": "Ticker nulls the give-up latch whenever another hostile is nearest, so the brain never sees hostile_reachable=false and the unreachable mob keeps the body",
    "body": "`buildState` computes `hostile_reachable` against `state.hostile` (perception's *nearest* candidate), but `fight.js` pursues `ctx.fightId` — the *sticky* incumbent, which `stickyTarget` keeps until a newcomer is nearer by `STICKY_MARGIN_BLOCKS = 2` (bot/src/behaviours/fight.js:90-102). When those two differ, index.js:115 reads the mismatch as \"stale: mob gone, or a new mob is nearest\" and nulls `ctx.fightGivenUpId` before `applyDecision` dispatches fight.\n\nTick sequence (bot at x=0, player Steve at x=30, zombie A at x=6 unreachable, zombie B at x=5 appearing at tick 5):\n- ticks 1-19: fight pursues A, pathfinder stalls, `fightPursuit` climbs.\n- tick 5: B appears. `state.hostile` = B (nearest). `stickyTarget` keeps A (5 + 2 = 7 \u003e 6).\n- tick 20: `fightPursuit \u003e GIVE_UP_TICKS` → `ctx.fightGivenUpId = A.id`, shadowPlayer.\n- tick 21: index.js:115 sees `state.hostile.id` (B) !== `A.id` → latch nulled, `hostile_reachable = true`. The brain answers fight. `stickyTarget` line 93's escape (`ctx.fightGivenUpId === ctx.fightId`) is now false because the ticker just cleared it, so A is returned again and pursuit restarts from scratch.\n- ticks 22-40: same, forever.\n\nI ran this through `createTicker` with the test-suite mock shape: 60 ticks, `follow` count **0**, goals alternating only between entity 1 (unreachable A) and entity 7 (the player); B is never pathed to and never attacked. The single-mob control yields follow at tick 20 as intended, and a second mob *farther* than A also works — the trigger is specifically a second hostile nearer than the written-off incumbent but inside the 2-block sticky margin, which is ordinary night-time Minecraft.\n\nTwo consequences: (a) the bead's core behaviour (`hostile_reachable=false` → follow) is unreachable in the multi-mob case; (b) this is a regression of pre-existing behaviour — loading `origin/master:bot/src/behaviours/fight.js` against the same sequence, the bot switches its goal to entity 2, the reachable mob. The latch used to be owned end-to-end by fight.js, so the escape fired.\n\nThe two unit tests that cover the escape (bot/test/fight.test.js:300 \"engages a new mob instead of resurrecting a given-up one\" and :315 \"swings at a new mob in range while the incumbent is given up\") call `fight()` directly with `ctx.fightGivenUpId` still set — a ctx state the ticker can no longer produce — so they pass by construction and hid this. The new end-to-end test at bot/test/fight.test.js:401 uses a single mob, so nothing in `bot/test/` fails on it.",
    "fix": "Key the latch bookkeeping on the latched entity itself, not on `state.hostile`. In index.js:115, clear `ctx.fightGivenUpId` only when the latched mob is actually gone or no longer a fight candidate (`!bot.entities[ctx.fightGivenUpId]` / `!isFightTarget(...)`), leaving it set while another hostile happens to rank nearest. `stickyTarget`'s line-93 escape then fires and fight.js engages the reachable newcomer (and nulls the latch itself at line 60 when it sets the new goal). Add a ticker-level test with two hostiles 1 block apart that asserts the goal moves to the newcomer after give-up.",
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
    "id": "contract-1",
    "file": "laya/smoke.py",
    "line": 48,
    "end_line": 49,
    "severity": "minor",
    "confidence": 85,
    "title": "New smoke label is longer than the table column, shifting that row in CI output",
    "body": "The added canned state is labelled \"hostile 4 unreach\" (17 characters), but the quality table is printed with `print(\"%-14s %-8s %-8.3f %.0f\" % ...)` at laya/smoke.py:120 and the header uses the same `%-14s` at line 118. Every pre-existing label fits the column (\"dist 12 moving\" and \"hostile 4 weak\" are both exactly 14). The new one overflows, so in the CI smoke output the action/sprint/ms columns for that single row are pushed three characters right and no longer line up with the header — the table exists purely for a human quality check, so the misalignment is the whole cost. Nothing is asserted on the label, so CI still passes.",
    "fix": "Shorten the label to \u003c=14 chars (e.g. \"hostile 4 far\" or \"h4 unreachable\"), or widen both format strings to %-18s.",
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
and most of what is raised about one cites no line of code. Where `/Users/iv/Projects/idkcraft/.revmux/tasks/idkcraft-3nt.10/01-initial/input/scope.md` describes such an item,
a finding whose `file` is empty is that kind of claim rather than a finding that lost its location,
and everything in this section applies to it alone.

A finding that names a file is judged exactly as above, and so is one that names none while
`/Users/iv/Projects/idkcraft/.revmux/tasks/idkcraft-3nt.10/01-initial/input/scope.md` describes a change and the command that diffs it. Nothing in this section reaches that
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
