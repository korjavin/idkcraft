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
- loop+goal (lenses: bot-loop, goal-and-tests) reported 6 findings: loop+goal-1, loop+goal-2, loop+goal-3, loop+goal-4, loop+goal-5, loop+goal-6
- contract (lenses: contract) reported no findings

Treat that list as fact. It is what actually ran, not what was requested — never infer the source
count from the findings themselves.

## Findings

[
  {
    "id": "loop+goal-1",
    "file": "bot/README.md",
    "line": 49,
    "end_line": 49,
    "severity": "minor",
    "confidence": 90,
    "title": "perception.js credited with ore scanning it does not do",
    "body": "The arbitration bullet says \"**Perception is local and always-on (`src/perception.js`):** Every tick, the bot computes distances, hostile mob proximity, and loaded ore chunks.\" `bot/src/perception.js` (read in full, 103 lines) exports only `findTarget`, `buildState`, `stateKey`, `isFightTarget` — distances, hostile ranges, health/food, nearby-hostile count. It never calls `findBlocks` and knows nothing about ore. Ore scanning lives in `bot/src/behaviours/scout.js:127` and runs on a 5 s gate, not every tick. On a learning project where the README is the discoverability deliverable, this points a reader at the wrong file for the scout logic and contradicts the same document's own Scout bullet two sections below (`src/behaviours/scout.js`, every 5 s).",
    "fix": "Drop \"and loaded ore chunks\" from the perception bullet; the Execution bullet already credits scouting to `src/behaviours/scout.js`.",
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
    "file": "bot/README.md",
    "line": 54,
    "end_line": 54,
    "severity": "minor",
    "confidence": 85,
    "title": "README documents `roam`, which exists nowhere in the tree",
    "body": "Two places describe a `roam` behaviour: line 54 \"*(roam is currently being added as a fourth choice to stroll near a stationary player)*\" and lines 80-81 \"**Roam (upcoming):** A fourth brain choice...\". `rg -ni roam` across the worktree matches `bot/README.md` only — no code, no test, no brain criterion. `bd search roam` shows idkcraft-3nt.5 still `in_progress` and unmerged, and this bead explicitly says \"do not wait for it\". The project already rejected this exact pattern: commit 051cb76 (\"review round 1 fixes (comment de-futuring...)\") removed the word \"future\" from a scout.js comment for the `find me` command. A reader who tries to observe roam finds the brain only ever answers fight/follow/idle (`bot/src/brain.js:39` rejects any other choice), and if 3nt.5 lands with different numbers the README is already wrong.",
    "fix": "Delete the parenthetical on line 54 and the \"Roam (upcoming)\" bullet; document roam in the PR that actually adds it.",
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
    "confidence": 85,
    "title": "\"Scouting runs every tick\" is false with nobody online",
    "body": "Line 56 says \"Scouting has zero body cost and runs every tick alongside whatever decision is executing\", and the Behaviours table (line 65) repeats \"runs every tick\". In `bot/src/index.js:79-97`, when `findTarget` returns no target the tick returns at line 96 — before the scout seam at lines 101-102 — so no scan happens at all, and the loop also drops to the 10 s `IDLE_TICK_MS` cadence. The code comment at index.js:54-55 states this deliberately: \"same cost guard as 'no player online', including no scans with nobody online.\" The README's Cost guards paragraph (lines 39-43) mentions only brain calls, so nothing in the document tells the owner that a bot left alone on the server stops scouting. Concrete case: owner logs out, leaves the bot running, later greps the container log for `scout ` lines and finds none — and the README says there should be one every 5 s.",
    "fix": "Qualify as \"runs every tick while a player is visible\" and add the no-scans-with-nobody-online clause to the Cost guards paragraph.",
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
    "id": "loop+goal-4",
    "file": "bot/README.md",
    "line": 55,
    "end_line": 55,
    "severity": "minor",
    "confidence": 85,
    "title": "Sprint documented as requiring a moving player; the default stub ignores that",
    "body": "Line 55 says the brain decides sprint \"when player is \u003e 8 blocks away and moving\", and the follow row (line 62) repeats \"`sprint` if \u003e 8 blocks and moving\". The remote-model prompt does carry the moving clause (`bot/src/brain.js:93`), but `stubBrain.decide` at `bot/src/brain.js:32` returns `{ action: 'follow', sprint: d \u003e 8 }` with no reference to `state.player_moving`. The stub is the default path whenever `BRAIN_URL` and `TYPESAFE_API_KEY` are both absent (`makeBrain`, brain.js:124-137) and is also the fallback on every remote error (brain.js:116). So with the documented stub configuration, a player standing still 10 blocks away still gets `sprint=true` in the `decision source=stub` log line — the opposite of what the README tells the reader to expect from the same log.",
    "fix": "Say the moving condition applies to the remote classifier and that the stub sprints on distance alone, or just state \"sprint when the player is more than 8 blocks away\".",
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
    "file": "bot/README.md",
    "line": 65,
    "end_line": 65,
    "severity": "minor",
    "confidence": 75,
    "title": "Scout observation recipe lost its \"stand next to the bot\" precondition",
    "body": "The table's How-to-observe cell is now just \"`/setblock ~2 ~ ~ diamond_ore`; bot announces vein in chat within 5 s\". The deleted \"## Scouting\" section it replaces said \"stand next to the bot as op and run `/setblock ~2 ~ ~ diamond_ore`\". `~` is relative to the command sender (the player), while the scan is centred on the bot: `bot.findBlocks({ matching: oreIds, maxDistance: radius })` in `bot/src/behaviours/scout.js:133` defaults its origin to `bot.entity.position`, with `radius = 16`. A player who runs the command from 30 blocks away places the ore outside the bot's scan sphere and sees no chat line, then concludes scouting is broken. The bead lists \"how to observe\" as an acceptance item, so the recipe needs to stay reproducible.",
    "fix": "Restore the precondition in the cell: \"stand next to the bot as op, `/setblock ~2 ~ ~ diamond_ore`\".",
    "sources": [
      "loop+goal"
    ],
    "lenses": [
      "goal-and-tests"
    ],
    "verdict": ""
  },
  {
    "id": "loop+goal-6",
    "file": "bot/README.md",
    "line": 78,
    "end_line": 78,
    "severity": "minor",
    "confidence": 75,
    "title": "\"Up to 3 new veins per scan\" understates the cap, which is 3 lines",
    "body": "Line 78 says \"Reports up to 3 new veins per scan in chat as `\u003core\u003e x\u003ccount\u003e at \u003cx\u003e \u003cy\u003e \u003cz\u003e`\". `bot/src/behaviours/scout.js:156` slices to 3 after grouping by *base ore name* (`fresh` is a Map keyed by base name, lines 137-153), and each line reports `x${spots.length}` for every new position of that ore. So a scan that turns up 12 new diamond blocks and 5 iron emits 2 lines covering 17 positions — far more than \"3 veins\". The deleted text said \"at most 3 lines per scan\", which matches the code, and the bead's own acceptance wording is \"max 3 lines\". The mis-stated cap matters for the noise measurement the epic asks for.",
    "fix": "Restore the original phrasing: at most 3 chat lines per scan, one per ore type, highest value first.",
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
