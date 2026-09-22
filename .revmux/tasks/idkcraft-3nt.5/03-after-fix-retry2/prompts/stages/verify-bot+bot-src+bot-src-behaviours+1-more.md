You are verifying findings another reviewer produced. You see only the findings assigned to you.
There is no wider set to compare against, and you must not go looking for new problems.

This review is **read-only**. You may read files and run read-only commands such as `git diff`,
`git log` and `rg`. Do not modify, delete, move, stage or commit anything, and do not write a file
through a shell redirect. Report what you find; changing it is the caller's job, never yours.
Do not run tests, builds or the linter - all of that was done before the review and passed.

## Where the context lives

Each item below is a **path**, not the text it names.

- `/Users/iv/Projects/idkcraft/.revmux/tasks/idkcraft-3nt.5/03-after-fix-retry2/input/scope.md` — what was under review and the command that produces the diff.
- `/Users/iv/Projects/idkcraft/.revmux/tasks/idkcraft-3nt.5/03-after-fix-retry2/prompts/input-profile.md` — the project's own conventions. A finding that contradicts them is wrong, not right.
- `/Users/iv/Projects/idkcraft-muse-1` — run every command from here.

## Findings to verify

[
  {
    "id": "loop+goal-4",
    "file": "bot/README.md",
    "line": 53,
    "end_line": 63,
    "severity": "minor",
    "confidence": 99,
    "title": "bot/README.md still documents three brain actions and the old 3-block follow/idle thresholds",
    "body": "`bot/README.md:50-54` enumerates the brain's exclusive actions as `fight` / `follow` / `idle` with \"`idle`: Player is close (\u003c= 3 blocks)\", and the behaviours table at `:61-63` says `follow` triggers at \"\u003e 3 blocks away\" and `idle` at \"Player within 3 blocks\". After this change a still player at 1-6 blocks yields `roam`, and follow triggers at \u003e3 only while the player is moving, \u003e6 while standing still. All three lines are now wrong and `roam` has no row at all.\n\nThe README is the document the in-game acceptance check is read against — the bead says \"log lines show action=roam\", and an owner reading this README to run that check finds no documented `action=roam` and an idle trigger that states the opposite of what the bot does. The table is also the observation guide for the deployed bot, so the drift lands on a reader diagnosing the live server. Prose only — nothing breaks at runtime, and the bead's Files list does not name bot/README.md, so this is arguably deferrable.",
    "fix": "Add a `roam` bullet and table row (trigger: player within 6 blocks and standing still, no hostile near; observe: stand still, bot strolls and never leaves ~8) and correct the `follow` and `idle` triggers to the moving/still split (\u003e3 moving, \u003e6 still).",
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
    "file": "bot/src/brain.js",
    "line": 102,
    "end_line": 103,
    "severity": "major",
    "confidence": 90,
    "title": "The `idle` criterion sent to laya was not updated for the new distance split, so the central roam state is ambiguous and the hostile-caution retreat has no criterion at all",
    "body": "The stub gained a still/moving split (brain.js:38-47) and the `instructions` + `follow` + new `roam` criteria were rewritten to match, but the `idle` criterion at brain.js:102 (and the byte-identical laya/test/request.json:11) still reads verbatim \"The player is already within 3 blocks: the bot should stand still and wait.\" The bot only ever runs the *model's* answer (`index.js:136` dispatches `decision.action`, and the deployed default `BRAIN_URL` is the laya sidecar; `laya/shim.py:66` passes `body.questions` straight to `agent.predict`), so the criteria text is what actually drives the body; the stub is only a reference for the disagree log at brain.js:123.\n\nTwo concrete states now diverge:\n\n1. **The central roam state is ambiguous.** `distance_to_player=1.0 player_moving=false`, no hostile (literally the smoke row `dist 1` at smoke.py:33-34). The stub answers `roam` (pinned by brain.test.js:8-10). Against the criteria, *both* `roam` (\"within 6 blocks and is not moving, and no hostile mob is near\") and `idle` (\"already within 3 blocks\") match word for word. Nothing in the criteria dict breaks the tie — only the ordering sentence in `instructions` does. The bead's stated risk for this model is exactly \"it collapses to one answer when criteria are vague\" (cne.4), and this is the vaguest possible overlap on the one state the feature exists for: if the model picks `idle`, roam never fires on the deployed stack, the bot freezes next to a standing player exactly as before the bead, one `brain disagree source=… model=idle stub=roam` line is logged, and then the decision is cached so even the log goes quiet. `smoke.py` `check()` accepts `idle`, so the CI gate passes.\n\n2. **The hostile-caution retreat has no criterion at all.** `distance_to_player=5.0 player_moving=false hostile_distance=4.0 bot_health=5`. The stub answers `follow` — walk back to the player because the bot is too hurt to fight (brain.js:32-36, pinned by brain.test.js:38-39). Against the criteria: `fight` needs health\u003e=6 (no), `follow` needs \"more than 6 blocks while standing still\" (no, d=5), `roam` needs \"no hostile mob is near\" (no, one at 4 blocks), `idle` needs \"within 3 blocks\" (no, d=5). Zero criteria match, so the model's answer is arbitrary in the one state where being wrong is dangerous. Before this change that state matched `follow` cleanly (\"more than 3 blocks\"), so the gap is introduced here. No smoke row covers it either — `hostile 4` (smoke.py:35-36) runs at `bot_health=20`, i.e. the fight path.\n\nThe round-03 goal explicitly makes \"question text matches the stub\" a merge condition, and it does not.",
    "fix": "Update the `idle` criterion in both brain.js:102 and laya/test/request.json:11 to the state the stub actually idles in, e.g. \"The player is within 3 blocks and is moving, or a hostile mob is near but the bot has less than 6 health and the player is close: stand still and wait.\", and extend the `follow` criterion with the caution case: \"…or a hostile mob is near, the bot has less than 6 health and the player is more than 3 blocks away: walk back to the player.\" Optionally add a `dist 5 hurt hostile` row to smoke.py STATES so the table shows the caution case.",
    "sources": [
      "contract",
      "loop+goal"
    ],
    "lenses": [
      "contract",
      "goal-and-tests",
      "bot-loop"
    ],
    "verdict": ""
  },
  {
    "id": "loop+goal-1",
    "file": "bot/src/behaviours/roam.js",
    "line": 23,
    "end_line": 25,
    "severity": "major",
    "confidence": 85,
    "title": "Roam's hand-back wedges the tick: the bot freezes for good when a stroll ends just past 6 blocks",
    "body": "`roam.js:23` returns without touching the pathfinder when the bot is more than `HAND_BACK_DIST` (6) from the player, on the comment's assumption that \"the next tick's brain answer will be follow\". There is no next brain answer: `index.js:113` reuses `lastDecision` while `stateKey` is unchanged, and `perception.js:33` rounds `distance_to_player` to whole blocks. A stationary bot with a stationary player produces a byte-identical key forever, so the cached `roam` is re-dispatched every tick and `roam.js:23` hands the body back every tick. Nothing moves, so nothing changes the key.\n\nTrigger (run against the real `createTicker` + real `stubBrain`, mock pathfinder):\n```\nd=1    action=roam calledBrain=true  setGoals=1   (GoalNear picked, r close to 6)\nd=3    action=roam calledBrain=true  setGoals=1   (walking)\nd=5.6  action=roam calledBrain=true  setGoals=1   (key \"6\", roam cached)\nd=6.4  action=roam calledBrain=false setGoals=1   (goal reached, isMoving false, hand-back)\nd=6.4  action=roam calledBrain=false setGoals=1\nd=6.4  action=roam calledBrain=false setGoals=1   ... forever\n```\nA fresh `stubBrain.decide({distance_to_player: 6.4, player_moving: false})` returns `follow` — the bot is frozen only because the stale `roam` is never re-evaluated.\n\nReachability: `GoalNear(x, pp.y, z, 1)` lets the bot come to rest up to ~1 block beyond a point picked at `r` up to `ROAM_RADIUS=6`, so any stroll with `r \u003e 5` that arrives from the far side of an obstacle, or on a block a step above the player's y (the distance at `roam.js:20` is 3-D), rests at 6.0-6.9. The arrival tick is exactly where consecutive distances are closest, so the previous tick's key is usually also \"6\" and the cache hits. The bot then stands still until the player moves, a hostile appears, or health/food changes — which is precisely the \"bot looks dead\" symptom the bead exists to remove, and it violates the acceptance criterion \"player stands still -\u003e the bot strolls\".\n\nThe same wedge fires whenever the remote brain answers `roam` at any distance past 6 (the case round 01 defended this branch as a guard for): the guard itself is what stops the loop.\n\nNo test covers it. `roam.test.js:75-82` calls `roam()` directly at d=20 with a fresh ctx, so it never sees the cache; the new crossover test at `roam.test.js:94-119` jumps 5.5 -\u003e 7, straddling the (6, 6.5) window where the rounded key stays 6.",
    "fix": "Never let roam return without either moving the body or changing the state: raise `HAND_BACK_DIST` to 8 (the bead's own \"never leaves 8\"), so a bot resting at 6.4 picks a fresh GoalNear inside the envelope and walks back in, changing the key and letting the brain re-decide. Add a ticker-level test that runs three ticks with the bot parked at 6.4 after a cached roam and asserts either a second setGoal or a follow decision.",
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
    "id": "loop+goal-5",
    "file": "bot/test/brain.test.js",
    "line": 32,
    "end_line": 34,
    "severity": "minor",
    "confidence": 95,
    "title": "Duplicate stub test case: 'follows back once the stroll leaves the envelope' repeats lines 23-25 verbatim",
    "body": "`brain.test.js:32-34` asserts `stubBrain.decide({ distance_to_player: 7, player_moving: false })` equals follow — character-for-character the same call and expectation as `brain.test.js:23-25` ('follow wins over roam once the player is beyond the envelope (dist 7, still)'). It adds no coverage: deleting either one leaves the same set of mutants killed. (`:11-13` d=1 moving and `:35-37` d=2 moving are likewise near-duplicates, though those at least differ in distance.)\n\nAgainst the project's smallest-diff rule this is test noise in a diff that is otherwise tightly scoped; it also makes the suite read as if two distinct envelope boundaries were pinned when only one is.",
    "fix": "Delete `brain.test.js:32-34`, or repoint it at the boundary that is genuinely untested — a still player at d=6.4, the distance at which the cached-roam wedge in roam.js bites.",
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
and most of what is raised about one cites no line of code. Where `/Users/iv/Projects/idkcraft/.revmux/tasks/idkcraft-3nt.5/03-after-fix-retry2/input/scope.md` describes such an item,
a finding whose `file` is empty is that kind of claim rather than a finding that lost its location,
and everything in this section applies to it alone.

A finding that names a file is judged exactly as above, and so is one that names none while
`/Users/iv/Projects/idkcraft/.revmux/tasks/idkcraft-3nt.5/03-after-fix-retry2/input/scope.md` describes a change and the command that diffs it. Nothing in this section reaches that
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
  01-initial  2026-09-22T00:46Z  3 findings (0 critical, 1 major, 2 minor)  sources 2/2

Each round holds report.md (rendered) and findings.json (machine shape). Read the rounds you judge relevant.

Re-evaluate everything independently. A prior round reporting an issue is not evidence that it is real,
and a prior round missing one is not evidence that it is absent.

As you work, narrate what you are doing. This is a running commentary read live by a human watching the run, and it is separate from your answer, which goes only in the structured output.

- Before each group of related tool calls, write one short line saying what you are about to check and why: "checking whether the stagger gate can still open on a fork".
- When something turns out to matter, say so in one line as you find it.
- Keep going for the whole review. Do not narrate the opening few steps and then fall silent for the rest of it — a reader who stops seeing lines cannot tell you apart from a hung process.
- One line at a time, under a dozen words, and never a summary of what you already said.
