# Review: idkcraft-3nt.3 / 04-final

scope: `/Users/iv/Projects/idkcraft/.revmux/tasks/idkcraft-3nt.3/04-final/input/scope.md`

## Major

### A remote `fight` answer with no hostile now parks the bot; on master the gap guard turned it into follow

`bot/src/brain.js:108-111`

Real behaviour change, but not for the reason given. The deleted guard (brain.js:111-114 on master) read `!('hostile_distance' in state)` — **key presence, not value**. The deleted test proves it: brain.test.js:180-182 on master asserts that with `hostile_distance: null` present, the model's `fight` wins. So the guard never enforced "fight must come with a hostile"; it enforced "perception is new enough to send hostile facts", exactly what its `// ponytail: remove once perception sends hostile_distance (idkcraft-3nt.3)` comment says. Removing it in this bead is what the comment prescribed.

The regression is nonetheless real, as a side effect of the pair of changes. On master the key was never emitted, so the guard fired on *every* remote `fight` and rewrote it to the stub action (follow at 10 blocks); master's BEHAVIOURS table also had no `fight` entry, so an unconverted `fight` would have fallen to index.js:31-33 and parked. On the branch, perception always sends the key, the guard is gone, and `fight` dispatches to fight.js — where `stickyTarget` returns null, fight.js:29-36 calls `stopMoving` and sets `lastGoalKey = 'idle'`. The bot parks instead of following.

It can persist. Production always runs the remote brain (docker-compose.yml:91 pins BRAIN_URL to the laya sidecar, and laya is a real 322M model — laya/shim.py:44 — not a deterministic mirror of the stub, which is why the disagree log at brain.js:108-110 exists). `decision.source` is `laya`, not `stub-fallback`, so index.js:112-115 caches it under the current `stateKey`; while the player stands still every stateKey field is unchanged and index.js:105 replays the cached `fight`, so the bot stays parked until the player moves.

The stub cannot trigger it (brain.js:27 only returns `fight` when `hostile_distance` is numeric or `hostile_near_player` is set, both implying a non-null `state.hostile`), so the trigger is laya emitting a `fight` choice on a state whose text reads `hostile_distance=none nearby_hostiles=0` — plausible for a small CPU model, but a model misbehaviour rather than a certainty, which is what holds confidence at 70.

Fix: Either degrade the degenerate action in brain.js — after the disagree log, `if (action === 'fight' && state && state.hostile_distance == null && !state.hostile_near_player) action = ref` — or make fight.js's no-hostile branch (fight.js:29-36) defer to follow instead of parking on 'idle'. The fight.js site is the one the defect actually lives at and also covers any future caller. Add a test for whichever is chosen: a remote `fight` on a hostile-free state must not leave the bot idle at 10 blocks.

_confidence: 70 | sources: loop+goal | lenses: bot-loop, goal-and-tests | verdict: refined_

## Minor

### STICKY_MARGIN_BLOCKS is unpinned from below: setting it to 0 keeps every test green

`bot/src/behaviours/fight.js:104`

The hysteresis margin at fight.js:104 (`if (dFresh + STICKY_MARGIN_BLOCKS < dPrev) return fresh`) is the new branching logic this round added, and no test fails if the margin is weakened to 0.

Traced through the two tests that exercise it:
- fight.test.js:270-283 (`switches to a newcomer nearer by the margin`): A at 7, B at 2. With margin 0, `2 + 0 < 7` is still true, the switch still happens, `setGoal` still reaches 2. Passes.
- fight.test.js:221-239 (`stays on target when the nearest rank flip-flops`): A at 5, B at 6. The test hands `b` as `state.hostile` while `b` is the *farther* mob — something perception (perception.js:78-87, strict nearest-by-bot) never produces. With margin 0, `6 + 0 < 5` is false, the incumbent is kept, `setGoal` and `equip` stay at 1. Passes.

The remaining two-mob tests (fight.test.js:241-268) both go through the give-up escape at fight.js:98, which returns `fresh` before the margin is consulted. So the margin is pinned from above (a value ≥ 5 breaks the 270 test) but not from below, and the test that looks like it pins the sticky behaviour passes by construction on an input perception cannot generate.

The defect the missing test would catch: with no effective margin, two mobs a fraction of a block apart alternate as perception's nearest, so `stickyTarget` switches every tick, the key-change branch (fight.js:60-66) fires every tick, and `fightPursuit`, `fightGivenUpId` and `fightShadowTicks` are all reset every tick — give-up can never complete — while `equipSword` sends an equip packet every tick.

Fix: Replace the flip-flop test's unrealistic input with a realistic one: two mobs that genuinely swap nearest rank inside the margin (A at 4.0, B at 3.6, then A at 3.5, B at 3.6), always handing perception's true nearest as `state.hostile`, and assert `setGoal` and `equip` stay at 1 across the swaps.

_confidence: 80 | sources: loop+goal | lenses: goal-and-tests, bot-loop | verdict: confirmed_

### The bead's "never targets players or passive mobs" criterion has no test; only the creeper half is covered

`bot/test/fight.test.js:57-126`

goal.md lists as an acceptance criterion that "attacking never targets players, passive mobs, or creepers". `isFightTarget` (perception.js:19-25) implements all three: the `entity.type === 'player'` guard, the `HOSTILE_NAMES` allowlist, and the explicit `name === 'creeper'` exclusion. Only the creeper exclusion is tested (fight.test.js:76-93).

No test in `bot/test/` ever puts a player entity or a passive mob into `bot.entities` — every `bot.entities = {...}` assignment in fight.test.js (lines 61, 70, 78, 89, 97, 105, 113, 226, 246, 250, 261, 265, 274, 320) contains only zombies, skeletons and creepers, and `isFightTarget` is never called directly. In production `bot.entities` always contains the followed player and the bot's own entity, so this is the live case, not a hypothetical.

Delete the `entity.type === 'player'` clause from perception.js:20 and the whole suite still passes. The failure the missing test would catch is the natural next edit: broadening `HOSTILE_NAMES`, or swapping the allowlist for a denylist when someone adds more mobs, makes `buildState` rank the followed player as `state.hostile`, and fight.js:84-86 swings at the player it is supposed to be escorting — with a sword, on the acceptance criterion the bead calls out by name.

Fix: Add two cases to the `perception hostile facts` block: one with `{ 7: { id: 7, type: 'player', username: 'Steve', name: 'Steve', position: pos(2,64,0) } }` in `bot.entities` asserting `state.hostile === null`, and one with a `cow` at 2 blocks asserting `state.hostile === null` and `state.nearby_hostiles === 0`.

_confidence: 90 | sources: loop+goal | lenses: goal-and-tests | verdict: confirmed_

## Pre-existing

### `stop` on a parked bot latches pathfinder.stop(), and fight's spaced retries turn the swallowed goal into a ~6 s freeze

`bot/src/index.js:149`

The reviewer states explicitly that the four `bot.pathfinder.stop()` call sites in index.js (33, 69, 86, 149) are pre-existing lines this diff does not touch, and that round 03 already flagged this as pre-existing — so the change under review did not introduce the latch. What the reviewer argues is new is only the cost.

`bot.pathfinder.stop()` only sets `stopPathing = true` (mineflayer-pathfinder/index.js:161-163). `monitorMovement` consumes the latch at index.js:580-583, but only after `if (path.length === 0) return` at index.js:474 — so on an empty path the latch is never consumed. The next `setGoal` runs `resetPath`, whose last line is `if (stopPathing) return stop()` (index.js:139), and that internal `stop()` sets `stateGoal = null` (index.js:390-396), wiping the goal just set.

fight.js is the only behaviour that does not re-issue its goal on every stationary tick, so it is the only one that pays more than one tick for a swallowed goal. fight.js:118-122 even states the rule ("never stop an empty path") for its own `stopMoving`, while index.js still violates it.

Concrete sequence, no unusual world state needed:
1. Bot is parked next to Steve, `ctx.lastGoalKey === 'idle'`, pathfinder path empty.
2. Steve types `stop`. handleChat (index.js:192-194) calls `ticker.setFollow('')`, which blanks `ctx.lastGoalKey` to `''` (index.js:146), then `ticker.stop()`, where `'' !== 'idle'` passes the guard and `bot.pathfinder.stop()` runs on an empty path (index.js:149). `stopPathing` is latched and nothing will consume it.
3. Steve types `follow me` with a zombie 5 blocks away. The brain returns `fight`.
4. fight.js:60-62 takes the key-change branch and sets `GoalFollow(zombie, 2)` — `resetPath` swallows it, `stateGoal` is null. `ctx.lastGoalKey` is now `fight:<id>`.
5. Ticks 2-6 take the `else if (!inRange)` branch with `isMoving()` false, so `ctx.fightPursuit` climbs 1..5 and fight.js:77 issues nothing (`% 6 !== 0`). The bot stands still and takes hits for about six ticks (~6 s at the default `BRAIN_TICK_MS`), and those stalled ticks are charged against the 18-tick give-up budget. Only at `fightPursuit === 6` does the retry land on a cleared latch and the bot start moving.

`follow` and `shadowPlayer` both re-issue on every stationary tick and so lose one tick, not six.

Fix: Apply fight.js's rule at the index.js call sites, e.g. export `stopMoving` from fight.js and call it from index.js:33, 69, 86 and 149, or inline `if (ctx.lastGoalKey !== 'idle' && bot.pathfinder.isMoving()) bot.pathfinder.stop()` at each.

_confidence: 78 | sources: loop+goal | lenses: bot-loop_

## Sources

| agent | executor | model | effort | tokens | raised | status |
| --- | --- | --- | --- | --- | --- | --- |
| loop+goal | claude | claude-opus-5 (requested opus) | high | 1241080 | 5 | ok |
| contract | claude | claude-opus-5 (requested opus) | high | 827158 | 0 | ok, nothing raised |
