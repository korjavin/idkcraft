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
- contract (lenses: contract) reported 2 findings: contract-1, contract-2

Treat that list as fact. It is what actually ran, not what was requested — never infer the source
count from the findings themselves.

## Findings

[
  {
    "id": "loop+goal-1",
    "file": "bot/src/behaviours/fight.js",
    "line": 77,
    "end_line": 82,
    "severity": "major",
    "confidence": 90,
    "title": "After give-up the written-off mob stays sticky, so the bot never fights any other hostile",
    "body": "`stickyTarget` (fight.js:76-82) keeps `ctx.fightId` as the target whenever the old entity is still a fight candidate, and it does not exclude a target that has already been given up. Since the give-up branch (fight.js:34-43) returns early for that id, the bot is locked into shadowing the player and never engages anything else.\n\nTick sequence (I ran it against a mock of the same shape as bot/test/fight.test.js): zombie A sealed behind glass 6 blocks from the bot, player at 9. Ticks 1-19 pursue, `bot.pathfinder.isMoving()` stays false, `ctx.fightPursuit` passes GIVE_UP_TICKS, so `ctx.fightGivenUpId = 1`, `ctx.fightId = 1`, goal becomes `fight-shadow:Steve`. Zombie B then spawns 4 blocks from the bot, reachable, and perception correctly reports it as `state.hostile`. Every subsequent tick: `stickyTarget` sees `fresh.id (2) !== ctx.fightId (1)`, looks up A in `bot.entities`, `isFightTarget(A, ...)` is still true (A is 6 \u003c= FIGHT_RANGE_BOT), so it returns A; the given-up branch fires and shadows the player again. Measured over 10 ticks with B nearest: 0 attacks, 0 goals on B, `ctx.fightId` still 1. It recovers only if A dies, despawns, or leaves the 8-from-bot / 6-from-player window — a sealed stationary mob does none of those while the player stays near it.\n\nWorse variant on the same path: if B walks adjacent and starts hitting the bot, `inRange` is still evaluated against A (6 blocks), so the bot shadows instead of swinging at the mob eating it.\n\nNo test in bot/test/fight.test.js covers a second hostile appearing after give-up; 'stays on target when the nearest rank flip-flops' only exercises the despawn escape, so this branch can lock fight out entirely without failing the suite.",
    "fix": "Do not stick to a target that has been written off: `if (ctx.fightId != null \u0026\u0026 ctx.fightGivenUpId !== ctx.fightId \u0026\u0026 (!fresh || fresh.id !== ctx.fightId))`. Add a fight.test.js case: give up on a mob at 6 blocks, then pass a second reachable zombie as `state.hostile` and assert a `GoalFollow` on it is issued (or a swing lands when it is at 2 blocks).",
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
    "id": "loop+goal-2",
    "file": "bot/src/behaviours/fight.js",
    "line": 79,
    "end_line": 79,
    "severity": "major",
    "confidence": 88,
    "title": "Stickiness has no nearness margin: a mob attacking the bot at 1 block is ignored while it chases one at 7",
    "body": "`stickyTarget` returns the incumbent whenever it is still any fight candidate (fight.js:79) — there is no distance hysteresis, so perception's nearest ranking is discarded outright rather than damped. Round 2 asked for stickiness to stop the retry/give-up/equip budgets being reset on a crossover; this implementation switches target *only* when the old one stops being a candidate.\n\nTick sequence (run against the same mock): bot pursues zombie A at 7 blocks, pathfinder moving so `ctx.fightPursuit` never stalls and give-up never fires. Zombie B spawns 1 block from the bot and starts hitting it; perception reports B as `state.hostile`. Over the next 10 ticks the bot issues no new goal and lands 0 swings — `ctx.fightId` stays 1 and `inRange` is computed against A, so the swing gate at fight.js:68 never opens. This holds until A dies or leaves the window; with A moving away at walking pace that is tens of seconds of the bot taking free hits from an adjacent mob. Before this round the bot would have retargeted B on the next tick.\n\nNo test exercises fight() with a much-nearer second hostile, so inverting or widening the stickiness rule does not fail the suite.",
    "fix": "Add the margin the round-2 fix described: keep the incumbent only while the new candidate is not meaningfully nearer, e.g. in `stickyTarget`, `if (prev is a fight target \u0026\u0026 (!fresh || prevDist - freshDist \u003c 2)) return prev`. Cover it with a fight.test.js case: chase a mob at 7, then supply one at 1 and assert the goal/swing moves to the near one.",
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
    "id": "loop+goal-3",
    "file": "bot/src/behaviours/fight.js",
    "line": 34,
    "end_line": 43,
    "severity": "minor",
    "confidence": 80,
    "title": "The give-up latch never expires: a written-off mob is only ever re-engaged by coming within 3 blocks",
    "body": "`ctx.fightGivenUpId` is cleared only when the mob becomes invalid/absent (fight.js:24-29), when the target actually changes (fight.js:49), or when it is within SWING_RANGE (fight.js:36-39). Nothing expires it on the passage of time or on the world changing, and (per the first finding) stickiness prevents the target-change escape from firing.\n\nConcrete case: a skeleton on the far side of a ravine 7 blocks from the bot. The path is unavailable for 19 ticks, `ctx.fightGivenUpId` latches. The player then bridges across, or the skeleton walks onto open ground 5 blocks away and keeps shooting the player — the bot shadows the player at distance 3 and never re-pursues, because a ranged mob has no reason to close to 3 blocks. The write-off is permanent for the life of that entity even after the reason for it has gone. The latch also survives the `stop` chat command and a player logout (index.js:56-59, 105-108 reset only `ctx.lastGoalKey`), so it is still in force when the player returns.\n\nThe suite asserts re-engagement only via the 2-block walk-in case ('swings if a given-up mob walks into range'), so an unbounded latch passes.",
    "fix": "Give the latch a ceiling instead of making it permanent — e.g. store the tick count at give-up and clear `ctx.fightGivenUpId` after a few GIVE_UP_TICKS' worth of ticks so pursuit is re-attempted once, and clear the fight state alongside `ctx.lastGoalKey = 'idle'` in the ticker's no-player and `stop()` paths.",
    "sources": [
      "loop+goal"
    ],
    "lenses": [
      "bot-loop"
    ],
    "verdict": ""
  },
  {
    "id": "contract-1",
    "file": "bot/src/behaviours/fight.js",
    "line": 34,
    "end_line": 44,
    "severity": "major",
    "confidence": 85,
    "title": "A given-up hostile permanently blocks fighting any other mob, because stickyTarget keeps resurrecting it",
    "body": "`stickyTarget` (fight.js:76-82) re-selects the previous target whenever it is still a fight candidate, and the give-up branch (fight.js:34-44) returns before the `key !== ctx.lastGoalKey` branch that would clear `ctx.fightGivenUpId`. Together they latch the bot onto a mob it has already abandoned.\n\nConcrete sequence, all within the ranges the bead defines: zombie A sits behind glass 5 blocks from the bot; the bot pursues, stalls, and after 18 stationary ticks sets `ctx.fightGivenUpId = A.id` and shadows the player. Zombie B then spawns 4 blocks away, reachable. Perception ranks nearest by bot distance, so `state.hostile` = B. In `fight`, `stickyTarget` sees `ctx.fightId === A.id` and `fresh.id !== A.id`, looks A up in `bot.entities`, and `isFightTarget(A, ...)` is still true (A is 5 blocks away, inside FIGHT_RANGE_BOT) — so it returns A. `ctx.fightGivenUpId === A.id` matches, A is not within SWING_RANGE, so the bot calls `shadowPlayer` and returns. B is never targeted, never equipped against, never swung at.\n\nNothing inside that branch can break the loop: `fightGivenUpId` is only cleared when the hostile goes invalid/missing (fight.js:28), when the given-up mob itself comes within 3 blocks (fight.js:37), or in the new-key branch (fight.js:49) which is unreachable here. The stub brain keeps returning `fight` the whole time (A is within 8 blocks), so the bot shadows the player and refuses to fight for as long as the player stands near the trapped mob — exactly the \"hostile near the player\" case the bead exists for. It only clears once the bot and player both drift out of A's candidate ranges.\n\nThis is a regression introduced by round 3. The round-2 code keyed give-up off `ctx.lastGoalKey === 'fight-giveup:\u003cid\u003e'` and re-read `state.hostile` each tick, so a newly-picked B produced a different give-up key and got engaged. No test covers give-up plus a second reachable hostile: the new flip-flop test (fight.test.js:221-239) exercises stickiness without give-up, and the give-up tests use a single mob.",
    "fix": "Scope stickiness to targets the bot has not abandoned: in `stickyTarget`, skip the resurrection when `ctx.fightGivenUpId === ctx.fightId` and `fresh` is a different valid candidate — i.e. `if (ctx.fightId != null \u0026\u0026 ctx.fightGivenUpId !== ctx.fightId \u0026\u0026 (!fresh || fresh.id !== ctx.fightId))`. Add a test: give up on A behind glass, introduce reachable B, assert a `fight:B` goal and a swing.",
    "sources": [
      "contract"
    ],
    "lenses": [
      "contract"
    ],
    "verdict": ""
  },
  {
    "id": "contract-2",
    "file": "bot/src/index.js",
    "line": 57,
    "end_line": 57,
    "severity": "minor",
    "confidence": 75,
    "title": "index.js still calls pathfinder.stop() on an empty path, and fight's spaced retries turn the swallowed goal into a ~6 s freeze",
    "body": "fight.js:93-96 now guards `pathfinder.stop()` behind `isMoving()`, with a comment stating the rule: never stop an empty path. `index.js` still breaks that rule at three sites (index.js:33, index.js:57, index.js:106), and the new fight behaviour is the one consumer that cannot self-heal from it in a single tick.\n\nI confirmed the mechanism in node_modules/mineflayer-pathfinder/index.js: `stop()` only sets `stopPathing = true` (line 162). `monitorMovement` consumes the latch at line 582, but only after `if (path.length === 0) return` at line 476 — so with an empty path the latch is never consumed by physics ticks and persists indefinitely. The next `setGoal` calls `resetPath`, which hits `if (stopPathing) return stop()` (line 139), and that `stop()` sets `stateGoal = null` — wiping the goal that was just set.\n\nSequence: the bot is standing within 3 blocks of the player, so `follow` has an empty path and `isMoving()` is false. The player logs off; index.js:57 runs with `lastGoalKey === 'follow:Bob'` and latches `stopPathing`. The player rejoins next to a zombie, the stub returns `fight`, and fight.js:46 sets `GoalFollow(zombie, 2)` — swallowed. `ctx.lastGoalKey` is now `fight:\u003cid\u003e`, so subsequent ticks take the `else if (!inRange)` branch and only re-issue on `fightPursuit % 6 === 0`. The bot stands still and takes hits for about six ticks (~6 s at the default BRAIN_TICK_MS) before the retry lands, and those stalled ticks are charged against the 18-tick give-up budget. `follow` and `shadowPlayer` both re-issue on every stationary tick and so recover in one tick; only the spaced fight pursuit pays the full penalty.\n\nThe stop() calls are pre-existing lines this change did not touch, but before the fight bead nothing consumed the latch with spaced retries, so the visible stall is new.",
    "fix": "Apply the same guard at the three index.js sites, e.g. `if (ctx.lastGoalKey !== 'idle' \u0026\u0026 bot.pathfinder.isMoving()) bot.pathfinder.stop()` — or export fight.js's `stopMoving` and call it from index.js so the rule lives in one place.",
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

Prior rounds for this task: /Users/iv/Projects/idkcraft/.revmux/tasks/idkcraft-3nt.3/
  01-initial    2026-09-21T23:24Z  3 findings (0 critical, 1 major, 2 minor)  sources 2/2
  02-after-fix  2026-09-21T23:35Z  3 findings (0 critical, 1 major, 2 minor)  sources 2/2

Each round holds report.md (rendered) and findings.json (machine shape). Read the rounds you judge relevant.

Re-evaluate everything independently. A prior round reporting an issue is not evidence that it is real,
and a prior round missing one is not evidence that it is absent.

As you work, narrate what you are doing. This is a running commentary read live by a human watching the run, and it is separate from your answer, which goes only in the structured output.

- Before each group of related tool calls, write one short line saying what you are about to check and why: "checking whether the stagger gate can still open on a fork".
- When something turns out to matter, say so in one line as you find it.
- Keep going for the whole review. Do not narrate the opening few steps and then fall silent for the rest of it — a reader who stops seeing lines cannot tell you apart from a hung process.
- One line at a time, under a dozen words, and never a summary of what you already said.
