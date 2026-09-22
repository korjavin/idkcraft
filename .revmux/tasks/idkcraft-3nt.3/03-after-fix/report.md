# Review: idkcraft-3nt.3 / 03-after-fix

scope: `/Users/iv/Projects/idkcraft/.revmux/tasks/idkcraft-3nt.3/03-after-fix/input/scope.md`

## Major

### A given-up hostile permanently blocks fighting any other mob, because stickyTarget keeps resurrecting it

`bot/src/behaviours/fight.js:77-82`

`stickyTarget` (fight.js:76-82) re-selects the previous target whenever it is still a fight candidate, and it does not exclude a target that has already been written off. The give-up branch (fight.js:34-44) returns early for that id, before the `key !== ctx.lastGoalKey` branch that would clear `ctx.fightGivenUpId`. Together they latch the bot onto a mob it has already abandoned, so it shadows the player and never engages anything else.

Concrete sequence, all within the ranges the bead defines: zombie A sits behind glass 5-6 blocks from the bot, player at 9. The bot pursues, `bot.pathfinder.isMoving()` stays false, and after the GIVE_UP_TICKS budget `ctx.fightGivenUpId = A.id`, `ctx.fightId = A.id`, goal becomes `fight-shadow:<player>`. Zombie B then spawns 4 blocks from the bot, reachable; perception ranks nearest by bot distance, so `state.hostile` = B. In `fight`, `stickyTarget` sees `fresh.id !== ctx.fightId`, looks A up in `bot.entities`, and `isFightTarget(A, ...)` is still true (A is inside FIGHT_RANGE_BOT) — so it returns A. `ctx.fightGivenUpId === A.id` matches, A is not within SWING_RANGE, so the bot calls `shadowPlayer` and returns. Measured over 10 ticks with B nearest: 0 attacks, 0 goals on B, `ctx.fightId` still A.

Nothing inside that branch can break the loop: `fightGivenUpId` is only cleared when the hostile goes invalid/missing (fight.js:24-29), when the given-up mob itself comes within SWING_RANGE (fight.js:36-39), or in the new-key branch (fight.js:49) which is unreachable here. The stub brain keeps returning `fight` the whole time, so the bot refuses to fight for as long as the player stands near the trapped mob — exactly the "hostile near the player" case the bead exists for. Worse variant on the same path: if B walks adjacent and starts hitting the bot, `inRange` is still evaluated against A, so the bot shadows instead of swinging at the mob eating it.

This reads as a regression introduced by round 3: the round-2 code keyed give-up off `ctx.lastGoalKey === 'fight-giveup:<id>'` and re-read `state.hostile` each tick, so a newly-picked B produced a different give-up key and got engaged. No test covers give-up plus a second reachable hostile — the new flip-flop test (fight.test.js:221-239) exercises stickiness without give-up, and the give-up tests use a single mob — so this branch can lock fight out entirely without failing the suite.

Fix: Scope stickiness to targets the bot has not abandoned: in `stickyTarget`, `if (ctx.fightId != null && ctx.fightGivenUpId !== ctx.fightId && (!fresh || fresh.id !== ctx.fightId))`. Add a fight.test.js case: give up on A behind glass, introduce reachable B, assert a `fight:B` goal (or a swing when B is at 2 blocks).

_confidence: 99 | sources: contract, loop+goal | lenses: contract, bot-loop, goal-and-tests | verdict: confirmed_

## Minor

### Stickiness has no nearness margin, so a much nearer mob attacking the bot is ignored while it closes on the incumbent

`bot/src/behaviours/fight.js:79`

Confirmed as written at the code level: `stickyTarget` (fight.js:77-79) returns the incumbent whenever `isFightTarget(prev, ...)` still holds, with no distance comparison, so perception's nearest ranking is discarded rather than damped. With A at 7 blocks and the pathfinder moving, `ctx.fightId` stays A, `inRange` is computed against A, and the swing gate at fight.js:68 never opens for B at 1 block even while B is hitting the bot. Round 2 asked for exactly this margin ("only switch ... if the new candidate is meaningfully nearer (e.g. 2 blocks)"); the implementation took absolute stickiness instead, so this is an incomplete fix, not a misreading.

Two corrections to the impact. The common case is bounded, not open-ended: while `bot.pathfinder.isMoving()` is true the bot is closing on A at walking pace, and once A dies or goes invalid the top branch (fight.js:24-29) or the key-change branch releases the target, so the window is the time to reach and kill A — seconds, not tens of seconds. The unbounded case is narrower but real: an incumbent that keeps the pathfinder moving without ever being reached (a kiting skeleton, a mob on a ledge causing repeated recalculation) never trips give-up either, since `ctx.fightPursuit` is reset on every moving tick, so the lock on A can persist indefinitely while B melees the bot. Consequence is avoidable damage and possible bot death, not a loss of the fight behaviour itself — hence minor rather than major. Fix is one line in the same function the contract-1 fix already touches.

Fix: Add the margin round 2 described: in `stickyTarget`, keep the incumbent only while the fresh candidate is not meaningfully nearer, e.g. return `prev` only when `prevDist - freshDist < 2`. Cover it with a fight.test.js case: chase a mob at 7, supply one at 1, assert the goal/swing moves to the near one.

_confidence: 90 | sources: loop+goal | lenses: bot-loop, goal-and-tests | verdict: refined_

### The give-up latch has no time ceiling: a written-off mob is re-engaged only by coming within 3 blocks

`bot/src/behaviours/fight.js:34-43`

Confirmed in substance. `ctx.fightGivenUpId` is cleared only at fight.js:28 (hostile gone/invalid), fight.js:37 (mob within SWING_RANGE) and fight.js:49 (new goal key), and nothing expires it on elapsed time or on the world changing. The ravine case holds: a skeleton latched at 7 blocks that later becomes reachable — the player bridges across, or it steps onto open ground at 5 blocks and keeps shooting — is never re-pursued, because a ranged mob has no reason to close to 3. The suite only asserts the 2-block walk-in re-engagement, so an unbounded latch passes. The index.js claim also checks out: the no-player path (index.js:56-59) and `stop()` (index.js:105-108) reset `ctx.lastGoalKey` only, leaving `fightId`/`fightGivenUpId` in force across a `stop` command or a logout.

One correction: the latch is not "permanent for the life of that entity". Once the given-up mob stops being a fight candidate — it leaves the 8-block bot window and the 6-block player window, or dies — `stickyTarget` returns the fresh candidate and either the null branch (fight.js:27-28) or the new-key branch (fight.js:49) clears it. The accurate statement is that it is permanent for as long as the mob stays inside the fight window without entering swing range, which is precisely the trapped/ranged-mob case give-up exists for.

Fix: Give the latch a ceiling instead of making it open-ended: record the tick at give-up and clear `ctx.fightGivenUpId` after a few GIVE_UP_TICKS so pursuit is re-attempted once, and clear `fightId`/`fightGivenUpId` alongside `ctx.lastGoalKey = 'idle'` in the ticker's no-player and `stop()` paths.

_confidence: 85 | sources: loop+goal | lenses: bot-loop | verdict: refined_

## Pre-existing

### index.js still calls pathfinder.stop() on an empty path, and fight's spaced retries turn the swallowed goal into a ~6 s freeze

`bot/src/index.js:57`

The reviewer states explicitly that the three `pathfinder.stop()` call sites in index.js (index.js:33, index.js:57, index.js:106) are pre-existing lines this change did not touch — the change under review only added the `isMoving()` guard on the fight.js side (fight.js:93-96, with a comment stating the rule: never stop an empty path). What is new is the visibility: before the fight bead nothing consumed the latch with spaced retries.

Mechanism, confirmed by the reviewer in node_modules/mineflayer-pathfinder/index.js: `stop()` only sets `stopPathing = true` (line 162). `monitorMovement` consumes the latch at line 582, but only after `if (path.length === 0) return` at line 476 — so with an empty path the latch is never consumed by physics ticks and persists indefinitely. The next `setGoal` calls `resetPath`, which hits `if (stopPathing) return stop()` (line 139), and that `stop()` sets `stateGoal = null` — wiping the goal that was just set.

Sequence: the bot is standing within 3 blocks of the player, so `follow` has an empty path and `isMoving()` is false. The player logs off; index.js:57 runs with `lastGoalKey === 'follow:<player>'` and latches `stopPathing`. The player rejoins next to a zombie, the stub returns `fight`, and fight.js:46 sets `GoalFollow(zombie, 2)` — swallowed. `ctx.lastGoalKey` is now `fight:<id>`, so subsequent ticks take the `else if (!inRange)` branch and only re-issue on `fightPursuit % 6 === 0`. The bot stands still and takes hits for about six ticks (~6 s at the default BRAIN_TICK_MS) before the retry lands, and those stalled ticks are charged against the 18-tick give-up budget. `follow` and `shadowPlayer` both re-issue on every stationary tick and so recover in one tick; only the spaced fight pursuit pays the full penalty.

Fix: Apply the same guard at the three index.js sites, e.g. `if (ctx.lastGoalKey !== 'idle' && bot.pathfinder.isMoving()) bot.pathfinder.stop()` — or export fight.js's `stopMoving` and call it from index.js so the rule lives in one place.

_confidence: 75 | sources: contract | lenses: contract_

## Sources

| agent | executor | model | effort | tokens | raised | status |
| --- | --- | --- | --- | --- | --- | --- |
| loop+goal | claude | claude-opus-5 (requested opus) | high | 513562 | 3 | ok |
| contract | claude | claude-opus-5 (requested opus) | high | 1108451 | 2 | ok |
