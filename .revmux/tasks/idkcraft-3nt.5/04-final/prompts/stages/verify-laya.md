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
    "id": "loop+goal-1",
    "file": "laya/smoke.py",
    "line": 28,
    "end_line": 45,
    "severity": "major",
    "confidence": 95,
    "title": "Bead acceptance criterion unmet: no smoke table, so the four-choice question the bead exists to answer is undecided",
    "body": "The bead's acceptance criteria are \"npm test green; ... smoke table with four choices pasted in PR; fallback path recorded on the bead if taken\", and the Why section states the specific risk being tested: \"adding a fourth choice is a risk for LAYA (cne.4 showed it collapses to one answer when criteria are vague)\". The bead's fallback instruction is conditional on that evidence: \"if the smoke table shows LAYA now answers roam or idle where it should fight/follow, drop roam from the brain question and make it a local rule instead\".\n\nThe PR body (#28) says under \"Smoke table: pending (no sidecar locally)\": \"`smoke.py` could not run here — no sidecar is listening on this machine. Please run it where the sidecar lives and paste the quality table here before merge.\" `gh pr view 28 --json comments` returns no comments, so no table was ever attached. The fallback section then records \"Path taken: the four-choice brain question stays. There is no local evidence of collapse\" — i.e. the decision the bead asked to be made *from* the table was made from its absence.\n\nConcrete consequence, not hypothetical: nothing in the code forces the deployed path to work. `index.js:136` dispatches `decision.action` from whatever the remote brain answered, and the default `BRAIN_URL` is the laya sidecar. `smoke.py check()` (laya/smoke.py:58-70) validates shape only — it accepts `idle` for every state — so a model that collapses to `idle` on the eight rows passes the smoke gate silently. If laya collapses, the deployed bot behaves exactly as before the bead (freezes next to a standing player), one `brain disagree ... model=idle stub=roam` line is logged, the decision is then cached, and the in-game acceptance criterion (\"within ~10 s the bot starts strolling\") fails on the real stack while all 113 unit tests stay green. The bead also asks for the fallback outcome to be recorded on the bead itself; it is recorded only in the PR body.\n\nThe code under review is sound — the four-choice question, the criteria and the stub all check out. What is missing is the one piece of evidence that distinguishes the primary path from the fallback path, which is the owner's stated experiment.",
    "fix": "Run `python laya/smoke.py` where the sidecar lives, paste the 8-row table into PR #28, and confirm `fight`/`follow` still win on `dist 12 moving`, `dist 5`, `hostile 4`; if they do not, take the bead's fallback (drop the `roam` criterion, idle-streak rule in the ticker). Mirror the outcome onto the bead with `bd update idkcraft-3nt.5 --notes=...`.",
    "sources": [
      "loop+goal"
    ],
    "lenses": [
      "goal-and-tests"
    ],
    "verdict": ""
  },
  {
    "id": "contract-2",
    "file": "laya/smoke.py",
    "line": 37,
    "end_line": 38,
    "severity": "minor",
    "confidence": 95,
    "title": "New smoke row \"dist 1 still\" is byte-identical to the existing \"dist 1\" row",
    "body": "`STATES` now has 8 rows but only 7 distinct state strings: row 4 (`\"dist 1 still\"`, laya/smoke.py:37-38) carries exactly the same state text as row 2 (`\"dist 1\"`, laya/smoke.py:33-34) — `distance_to_player=1.0 player_visible=true player_moving=false ... hostile_distance=none hostile_near_player=false`. I parsed `STATES` and confirmed the strings compare equal.\n\n`main()` posts one request per row for `STATES[1:]` (laya/smoke.py:97-103), so every smoke run spends an extra CPU inference on a state it already tested and prints two table rows that can only ever differ through model nondeterminism. The quality table the bead asks to be pasted in the PR therefore advertises 8 states while covering 7 — and the duplicate pair is the very state the bead singled out (\"dist 1 still\").",
    "fix": "Drop the new `\"dist 1 still\"` row and rename the existing `\"dist 1\"` row to `\"dist 1 still\"`, keeping the table at 7 distinct states.",
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
