# Review: idkcraft-3nt.10 / 02-after-fix

scope: `/Users/iv/Projects/idkcraft/.revmux/tasks/idkcraft-3nt.10/02-after-fix/input/scope.md`

## Major

### A written-off mob that walks into melee range is ignored for up to 30 ticks — the brain keeps answering follow and fight.js's swing-on-range branch never runs

`bot/src/index.js:119-137`

The latch now drives the brain, but nothing re-evaluates it against distance. `buildState` sets `hostile_reachable` purely by id equality (bot/src/perception.js:102), and the ticker's latch block only clears the latch when the mob stops being a fight candidate (index.js:121) or after 30 ticks (index.js:127). So a latched mob standing 1 block from the bot still reads `hostile_reachable=false`, the stub answers `follow` (it is not near the player), and `fight()` is never dispatched — which means fight.js:47-50 ("swing if the mob wandered into range", the documented local safety net) is unreachable on exactly the path the bead makes the main path.

Traced through the real `createTicker` with the test-suite mocks (bot at x=0, Steve at x=30, zombie at x=6, `pathfinder.isMoving()` false throughout):
- t0-t19: fight, pursuit stalls, latch set on the zombie at t19.
- t20-t21: brain yields follow. Correct, this is the bead.
- t22: the zombie walks to x=1 (1 block from the bot, 29 from Steve). `hostile_near_player` stays false, `hostile_reachable` stays false, decision stays `follow`.
- t22-t48: 27 consecutive ticks at melee range, `bot.calls.attack === 0`. The bot paths toward the player while being hit and never swings.
- t49: the 30-tick re-probe clears the latch, `fight` returns, first swing lands.

The same sequence on `origin/master` swings at t22 and every tick after (38 attacks over the window vs 0 here), so this is a behaviour regression introduced by the change, not a pre-existing gap. At Minecraft melee rates that is ~18 zombie hits taken without retaliating; the bot can die.

A realistic trigger does not even need a trapped mob: whenever the *bot* is the thing pathfinder cannot move (stuck in a 1-block hole, in water, on a ledge), every hostile gets written off after 18 ticks and the bot then refuses to fight anything that walks up to it.

No test in bot/test/ fails on this. bot/test/fight.test.js:251 ("swings if a given-up mob walks into range") still passes because it calls `fight()` directly with `ctx.fightGivenUpId` set — a ctx state the ticker now only produces when `hostile_near_player` is true — so it passes by construction and hides the regression. The two ticker-level tests (fight.test.js:401, :421) both keep the mob out of swing range for the whole run.

Fix: Minimal fix: in the index.js latch block, when the latched mob is within fight.js's SWING_RANGE (3) of the bot, set `state.hostile_reachable = true` without clearing `ctx.fightGivenUpId` (leave `fightUnreachableTicks` alone). The brain then answers fight, fight.js takes its documented given-up branch (fight.js:47-50) and clears the latch itself while swinging — no fresh pursuit goal and no re-equip, which is what the existing unit test at fight.test.js:251 asserts. Clearing the latch in the ticker instead would send fight.js down the `key !== ctx.lastGoalKey` path and issue a new GoalFollow plus equipSword on a mob already in reach. Add a ticker-level test that gives up on a mob, moves it to 1 block with the player far away, and asserts `bot.calls.attack > 0` on the next tick.

_confidence: 95 | sources: loop+goal | lenses: bot-loop, goal-and-tests | verdict: refined_

## Sources

| agent | executor | model | effort | tokens | raised | status |
| --- | --- | --- | --- | --- | --- | --- |
| loop+goal | claude | claude-opus-5 (requested opus) | high | 1160424 | 1 | ok |
| contract | claude | claude-opus-5 (requested opus) | high | 1248548 | 0 | ok, nothing raised |
