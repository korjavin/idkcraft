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
- contract (lenses: contract) reported no findings

Treat that list as fact. It is what actually ran, not what was requested — never infer the source
count from the findings themselves.

## Findings

[
  {
    "id": "loop+goal-1",
    "file": "bot/src/index.js",
    "line": 119,
    "end_line": 137,
    "severity": "major",
    "confidence": 90,
    "title": "A written-off mob that walks into melee range is ignored for up to 30 ticks — the brain keeps answering follow and fight.js's swing-on-range branch never runs",
    "body": "The latch now drives the brain, but nothing re-evaluates it against distance. `buildState` sets `hostile_reachable` purely by id equality (bot/src/perception.js:102), and the ticker's latch block only clears the latch when the mob stops being a fight candidate (index.js:121) or after 30 ticks (index.js:127). So a latched mob standing 1 block from the bot still reads `hostile_reachable=false`, the stub answers `follow` (it is not near the player), and `fight()` is never dispatched — which means fight.js:47-50 (\"swing if the mob wandered into range\", the documented local safety net) is unreachable on exactly the path the bead makes the main path.\n\nTraced through the real `createTicker` with the test-suite mocks (bot at x=0, Steve at x=30, zombie at x=6, `pathfinder.isMoving()` false throughout):\n- t0-t19: fight, pursuit stalls, latch set on the zombie at t19.\n- t20-t21: brain yields follow. Correct, this is the bead.\n- t22: the zombie walks to x=1 (1 block from the bot, 29 from Steve). `hostile_near_player` stays false, `hostile_reachable` stays false, decision stays `follow`.\n- t22-t48: 27 consecutive ticks at melee range, `bot.calls.attack === 0`. The bot paths toward the player while being hit and never swings.\n- t49: the 30-tick re-probe clears the latch, `fight` returns, first swing lands.\n\nThe same sequence on `origin/master` swings at t22 and every tick after (38 attacks over the window vs 0 here), so this is a behaviour regression introduced by the change, not a pre-existing gap. At Minecraft melee rates that is ~18 zombie hits taken without retaliating; the bot can die.\n\nA realistic trigger does not even need a trapped mob: whenever the *bot* is the thing pathfinder cannot move (stuck in a 1-block hole, in water, on a ledge), every hostile gets written off after 18 ticks and the bot then refuses to fight anything that walks up to it.\n\nNo test in bot/test/ fails on this. bot/test/fight.test.js:251 (\"swings if a given-up mob walks into range\") still passes because it calls `fight()` directly with `ctx.fightGivenUpId` set — a ctx state the ticker now only produces when `hostile_near_player` is true — so it passes by construction and hides the regression. The two ticker-level tests (fight.test.js:401, :421) both keep the mob out of swing range for the whole run.",
    "fix": "In the index.js latch block, treat \"latched mob within swing range\" the same as stale: at line 121 also clear `ctx.fightGivenUpId` (and reset `ctx.fightUnreachableTicks`, setting `state.hostile_reachable = true`) when `latched.position.distanceTo(bot.entity.position) \u003c= 3` — a mob you can hit is reachable by definition. Add a ticker-level test that gives up on a mob, moves it to 1 block with the player far away, and asserts `bot.calls.attack \u003e 0` on the next tick.",
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
  01-initial  2026-09-22T02:09Z  2 findings (0 critical, 1 major, 1 minor)  sources 2/2

Each round holds report.md (rendered) and findings.json (machine shape). Read the rounds you judge relevant.

Re-evaluate everything independently. A prior round reporting an issue is not evidence that it is real,
and a prior round missing one is not evidence that it is absent.

As you work, narrate what you are doing. This is a running commentary read live by a human watching the run, and it is separate from your answer, which goes only in the structured output.

- Before each group of related tool calls, write one short line saying what you are about to check and why: "checking whether the stagger gate can still open on a fork".
- When something turns out to matter, say so in one line as you find it.
- Keep going for the whole review. Do not narrate the opening few steps and then fall silent for the rest of it — a reader who stops seeing lines cannot tell you apart from a hung process.
- One line at a time, under a dozen words, and never a summary of what you already said.
