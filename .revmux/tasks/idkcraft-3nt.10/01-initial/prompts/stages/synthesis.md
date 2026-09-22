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
- contract (lenses: contract) reported 1 findings: contract-1

Treat that list as fact. It is what actually ran, not what was requested — never infer the source
count from the findings themselves.

## Findings

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
