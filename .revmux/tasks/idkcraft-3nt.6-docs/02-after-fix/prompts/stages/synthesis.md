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
- loop+goal (lenses: bot-loop, goal-and-tests) reported 3 findings: loop+goal-1, loop+goal-2, loop+goal-3
- contract (lenses: contract) reported no findings

Treat that list as fact. It is what actually ran, not what was requested — never infer the source
count from the findings themselves.

## Findings

[
  {
    "id": "loop+goal-1",
    "file": "bot/README.md",
    "line": 54,
    "end_line": 54,
    "severity": "minor",
    "confidence": 90,
    "title": "README still documents `roam`, which exists nowhere in the tree",
    "body": "Line 54 reads \"*(roam is being added as a fourth choice in a follow-up).*\" inside the list of actions the brain chooses. `rg -ni roam` over the whole worktree matches this line and nothing else — no code, no test, and `git grep -ni roam origin/master -- bot/` is empty too. `bot/src/brain.js:39` accepts only fight/follow/idle and `stubBrain.decide` has no roam branch, so nothing a reader can run produces it. `bd show idkcraft-3nt.5` confirms roam is still IN_PROGRESS and unmerged, and 3nt.6's own Notes say not to wait for it.\n\nThis is a carry-over: round 1 raised the same line, and this round's scope.md claims \"Removed speculative roam details from documentation\" — the surrounding detail was removed but the forward-looking bullet survived in reworded form, so the claimed fix is incomplete. Impact is contained (the line is labelled as future work, so no reader is misled about today's behaviour), but the README of a learning project now lists a fourth choice that 3nt.5 may land differently.",
    "fix": "Delete line 54; document roam in the PR that adds it.",
    "sources": [
      "loop+goal"
    ],
    "lenses": [
      "goal-and-tests"
    ],
    "verdict": ""
  },
  {
    "id": "loop+goal-2",
    "file": "bot/README.md",
    "line": 78,
    "end_line": 78,
    "severity": "minor",
    "confidence": 85,
    "title": "Scout cap described as \"3 new veins per scan\" when it is 3 lines, one per ore type",
    "body": "Line 78 says \"Reports up to 3 new veins per scan in chat as `\u003core\u003e x\u003ccount\u003e at \u003cx\u003e \u003cy\u003e \u003cz\u003e`\". In `bot/src/behaviours/scout.js:137-169` the new positions are grouped into `fresh` keyed by **base ore name**, `names` is that key set sorted by rank and `.slice(0, 3)`, and one chat line is emitted per name with `x${spots.length}` (total new blocks of that ore) at the nearest of them. So the cap is three ore *types*, and a single line can merge several distinct veins: two separate diamond veins found in one scan produce one line `diamond_ore x\u003ctotal\u003e at \u003cnearest\u003e`, with the second vein's coordinates never reported. Conversely a scan turning up four ore types drops the lowest-ranked one entirely, which \"3 new veins\" does not convey either.\n\nThis is a regression in accuracy introduced by the rewrite — `origin/master:bot/README.md:54` said \"at most 3 lines per scan\", which was correct, and goal.md's own criterion asks for \"max 3 lines\". A reader who runs `/setblock` on two separate veins and sees one line would read it as the scout missing a vein.",
    "fix": "Restore the earlier wording: \"at most 3 lines per scan, one per ore type, highest value first\".",
    "sources": [
      "loop+goal"
    ],
    "lenses": [
      "goal-and-tests"
    ],
    "verdict": ""
  },
  {
    "id": "loop+goal-3",
    "file": "bot/README.md",
    "line": 56,
    "end_line": 56,
    "severity": "minor",
    "confidence": 75,
    "title": "`idle` is listed as a behaviour dispatched via `BEHAVIOURS`, but it has no module",
    "body": "Line 56 says \"The selected action is dispatched to the corresponding behaviour module via `BEHAVIOURS` in `src/index.js`\", and the behaviours table (line 64) lists `idle` alongside follow/fight/scout. `BEHAVIOURS` at `bot/src/index.js:9-12` holds only `fight` and `follow`; `applyDecision` (index.js:29-35) takes the `else` branch for `idle` and just calls `bot.pathfinder.stop()` once. `ls bot/src/behaviours` is fight.js, follow.js, scout.js — there is no idle.js, and scout.js is not in `BEHAVIOURS` either (it runs at the every-tick seam, index.js:101-102, which the same bullet does describe correctly).\n\nThe behaviour a reader ends up with is right — the table's idle row says \"bot stops pathfinding and waits quietly\" — but on a project where this README is the discoverability deliverable, the sentence sends someone looking for `src/behaviours/idle.js`. `CLAUDE.md:97` inherits the same phrasing (\"execution dispatches via `BEHAVIOURS` (`bot/src/behaviours/*.js`)\").",
    "fix": "Add a half-clause to line 56: \"...via `BEHAVIOURS` in `src/index.js` (`fight` and `follow`; `idle` has no module — the dispatcher just stops the pathfinder once).\"",
    "sources": [
      "loop+goal"
    ],
    "lenses": [
      "goal-and-tests",
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

Prior rounds for this task: /Users/iv/Projects/idkcraft/.revmux/tasks/idkcraft-3nt.6-docs/
  01-initial  2026-09-22T00:36Z  4 findings (0 critical, 0 major, 4 minor)  sources 2/2

Each round holds report.md (rendered) and findings.json (machine shape). Read the rounds you judge relevant.

Re-evaluate everything independently. A prior round reporting an issue is not evidence that it is real,
and a prior round missing one is not evidence that it is absent.

As you work, narrate what you are doing. This is a running commentary read live by a human watching the run, and it is separate from your answer, which goes only in the structured output.

- Before each group of related tool calls, write one short line saying what you are about to check and why: "checking whether the stagger gate can still open on a fork".
- When something turns out to matter, say so in one line as you find it.
- Keep going for the whole review. Do not narrate the opening few steps and then fall silent for the rest of it — a reader who stops seeing lines cannot tell you apart from a hung process.
- One line at a time, under a dozen words, and never a summary of what you already said.
