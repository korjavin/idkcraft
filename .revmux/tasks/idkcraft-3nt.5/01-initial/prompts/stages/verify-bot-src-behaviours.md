You are verifying findings another reviewer produced. You see only the findings assigned to you.
There is no wider set to compare against, and you must not go looking for new problems.

This review is **read-only**. You may read files and run read-only commands such as `git diff`,
`git log` and `rg`. Do not modify, delete, move, stage or commit anything, and do not write a file
through a shell redirect. Report what you find; changing it is the caller's job, never yours.
Do not run tests, builds or the linter - all of that was done before the review and passed.

## Where the context lives

Each item below is a **path**, not the text it names.

- `/Users/iv/Projects/idkcraft/.revmux/tasks/idkcraft-3nt.5/01-initial/input/scope.md` — what was under review and the command that produces the diff.
- `/Users/iv/Projects/idkcraft/.revmux/tasks/idkcraft-3nt.5/01-initial/prompts/input-profile.md` — the project's own conventions. A finding that contradicts them is wrong, not right.
- `/Users/iv/Projects/idkcraft-muse-1` — run every command from here.

## Findings to verify

[
  {
    "id": "contract-1",
    "file": "bot/src/behaviours/roam.js",
    "line": 30,
    "end_line": 31,
    "severity": "major",
    "confidence": 99,
    "title": "Roaming busts the decision cache, so a standing player now costs one brain call per tick instead of one total",
    "body": "`perception.js:27-29` states the cost guard in writing: \"Dedup key: distance rounded to 1 block + same flags =\u003e reuse last decision, skip the JEV call\", and `index.js:106` only reuses `lastDecision` while `stateKey(state)` is unchanged. `distance_to_player` is part of that key.\n\nBefore this change, a player standing within 3 blocks was the cheapest possible state: the stub answered idle, `applyDecision` stopped the pathfinder, the bot did not move, the rounded distance stayed constant, and the brain was called exactly once and then cached for as long as the player stood still.\n\nRoam moves the bot. `setGoal` sends it up to 6 blocks away at pathfinder speed (~4.3 blocks/s against the default `BRAIN_TICK_MS=1000`), so `Math.round(distance_to_player)` changes on nearly every tick and the cache misses on nearly every tick. Worse, the stub flips to `follow` as soon as the bot crosses 3 blocks, so the bot yo-yos out and back, guaranteeing the key keeps changing.\n\nOne reviewer ran the real `createTicker` with a mock pathfinder walking 4.3 blocks per tick toward the goal, player motionless at 1 block:\n- this branch: `roam, roam, roam, follow, roam, roam, follow, ...` — 10 brain calls in 12 ticks\n- master's behaviour (idle at d\u003c=3): 1 brain call in 12 ticks\n\nSo an AFK or building player — the single most common state on this server — now drives a continuous ~1 req/s stream at `BRAIN_URL`. On the default `laya` sidecar that is a permanent CPU inference load (~127 ms p50 per the CI note) where there was previously none; if `BRAIN_URL` points at JEV it is paid traffic for as long as someone stands still. Nothing crashes — `inFlight` serialises the calls — but a slow answer over `BRAIN_TIMEOUT_MS` yields a stub fallback that is deliberately not cached (`index.js:113`), so a timing-out sidecar produces one call plus one console.error per tick forever.",
    "fix": "Drop `distance_to_player` out of the dedup key while the last decision was `roam` (or key roam ticks on the goal instead of the distance), so a motionless player yields one brain call and the roam goal simply runs to completion. Cheapest version: in `index.js`, reuse `lastDecision` when `lastDecision.action === 'roam' \u0026\u0026 bot.pathfinder.isMoving()` and only the distance component of the key changed.",
    "sources": [
      "contract",
      "loop+goal"
    ],
    "lenses": [
      "contract",
      "bot-loop"
    ],
    "verdict": ""
  },
  {
    "id": "loop+goal-1",
    "file": "bot/src/behaviours/roam.js",
    "line": 12,
    "end_line": 30,
    "severity": "major",
    "confidence": 75,
    "title": "follow preempts roam at 3 blocks, so the stroll yo-yos and never reaches the 6-block radius",
    "body": "roam picks a point up to ROAM_RADIUS=6 blocks from the player and hands the body back only past HAND_BACK_DIST=6 (roam.js:12-13, :23). But the arbitration that dispatches roam switches to follow at 3 blocks — stubBrain `if (d \u003e 3) return follow` (brain.js:32), and the remote question says the same (\"follow when the player is more than 3 blocks away\", brain.js:90/93). Tick trace with a standing player: tick N, d≈1, brain says roam, roam sets GoalNear at a point ~5 blocks out, bot starts walking. Tick N+1 (1 s later, walking speed ~4.3 b/s) the bot is at d≈4, so stateKey changed and the fresh decision is follow; follow.js sees key `follow:Steve` !== ctx.lastGoalKey (`roam:…`) and calls setGoal(GoalFollow(target,3),true), which replaces the roam goal. The bot reverses mid-stroll and walks back to 3. Tick N+2: d\u003c=3, roam again, new random point. Observable result is a yo-yo between ~1 and ~4.5 blocks, not the \"strolling in a radius of ~6 blocks\" the bead's acceptance criterion asks for, and the ore-scan widening that motivates the bead is roughly halved. Corollary: the `distToPlayer \u003e HAND_BACK_DIST` branch (roam.js:23) is unreachable under the shipped policy — nothing ever dispatches roam at d\u003e3, let alone d\u003e6 — so the 6-block geometry in this file and the 3-block threshold in the brain never agree. No test in bot/test/ covers the roam→follow crossover; a test that ticks the ticker with the real stub while the bot sits at d=4 and asserts the roam goal survives (or is deliberately dropped) would have caught this.",
    "fix": "Make the two thresholds agree. Smallest version: let the stub hold roam while the player is still — `if (d \u003e 3 \u0026\u0026 (state.player_moving || d \u003e HAND_BACK_DIST)) return follow` (and the matching sentence in the question/criteria text plus request.json), so an in-flight stroll runs out to 6 before follow takes the body back. Alternatively drop ROAM_RADIUS/HAND_BACK_DIST to 3 and accept a smaller stroll, and say so on the bead.",
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
and most of what is raised about one cites no line of code. Where `/Users/iv/Projects/idkcraft/.revmux/tasks/idkcraft-3nt.5/01-initial/input/scope.md` describes such an item,
a finding whose `file` is empty is that kind of claim rather than a finding that lost its location,
and everything in this section applies to it alone.

A finding that names a file is judged exactly as above, and so is one that names none while
`/Users/iv/Projects/idkcraft/.revmux/tasks/idkcraft-3nt.5/01-initial/input/scope.md` describes a change and the command that diffs it. Nothing in this section reaches that
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
