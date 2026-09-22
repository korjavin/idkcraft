# Review: idkcraft-3nt.5 / 03-after-fix-retry2

scope: `/Users/iv/Projects/idkcraft/.revmux/tasks/idkcraft-3nt.5/03-after-fix-retry2/input/scope.md`

## Major

### The `idle` criterion sent to laya was not updated for the new distance split, so the central roam state is ambiguous and the hostile-caution retreat has no criterion at all

`bot/src/brain.js:102-103`

The stub gained a still/moving split (brain.js:38-47) and the `instructions` + `follow` + new `roam` criteria were rewritten to match, but the `idle` criterion at brain.js:102 (and the byte-identical laya/test/request.json:11) still reads verbatim "The player is already within 3 blocks: the bot should stand still and wait." The bot only ever runs the *model's* answer (`index.js:136` dispatches `decision.action`, and the deployed default `BRAIN_URL` is the laya sidecar; `laya/shim.py:66` passes `body.questions` straight to `agent.predict`), so the criteria text is what actually drives the body; the stub is only a reference for the disagree log at brain.js:123.

Two concrete states now diverge:

1. **The central roam state is ambiguous.** `distance_to_player=1.0 player_moving=false`, no hostile (literally the smoke row `dist 1` at smoke.py:33-34). The stub answers `roam` (pinned by brain.test.js:8-10). Against the criteria, *both* `roam` ("within 6 blocks and is not moving, and no hostile mob is near") and `idle` ("already within 3 blocks") match word for word. Nothing in the criteria dict breaks the tie — only the ordering sentence in `instructions` does. The bead's stated risk for this model is exactly "it collapses to one answer when criteria are vague" (cne.4), and this is the vaguest possible overlap on the one state the feature exists for: if the model picks `idle`, roam never fires on the deployed stack, the bot freezes next to a standing player exactly as before the bead, one `brain disagree source=… model=idle stub=roam` line is logged, and then the decision is cached so even the log goes quiet. `smoke.py` `check()` accepts `idle`, so the CI gate passes.

2. **The hostile-caution retreat has no criterion at all.** `distance_to_player=5.0 player_moving=false hostile_distance=4.0 bot_health=5`. The stub answers `follow` — walk back to the player because the bot is too hurt to fight (brain.js:32-36, pinned by brain.test.js:38-39). Against the criteria: `fight` needs health>=6 (no), `follow` needs "more than 6 blocks while standing still" (no, d=5), `roam` needs "no hostile mob is near" (no, one at 4 blocks), `idle` needs "within 3 blocks" (no, d=5). Zero criteria match, so the model's answer is arbitrary in the one state where being wrong is dangerous. Before this change that state matched `follow` cleanly ("more than 3 blocks"), so the gap is introduced here. No smoke row covers it either — `hostile 4` (smoke.py:35-36) runs at `bot_health=20`, i.e. the fight path.

The round-03 goal explicitly makes "question text matches the stub" a merge condition, and it does not.

Fix: Update the `idle` criterion in both brain.js:102 and laya/test/request.json:11 to the state the stub actually idles in, e.g. "The player is within 3 blocks and is moving, or a hostile mob is near but the bot has less than 6 health and the player is close: stand still and wait.", and extend the `follow` criterion with the caution case: "…or a hostile mob is near, the bot has less than 6 health and the player is more than 3 blocks away: walk back to the player." Optionally add a `dist 5 hurt hostile` row to smoke.py STATES so the table shows the caution case.

_confidence: 90 | sources: contract, loop+goal | lenses: contract, goal-and-tests, bot-loop | verdict: unverified_

### Roam's hand-back wedges the tick: the bot freezes for good when a stroll ends just past 6 blocks

`bot/src/behaviours/roam.js:23-25`

`roam.js:23` returns without touching the pathfinder when the bot is more than `HAND_BACK_DIST` (6) from the player, on the comment's assumption that "the next tick's brain answer will be follow". There is no next brain answer: `index.js:113` reuses `lastDecision` while `stateKey` is unchanged, and `perception.js:33` rounds `distance_to_player` to whole blocks. A stationary bot with a stationary player produces a byte-identical key forever, so the cached `roam` is re-dispatched every tick and `roam.js:23` hands the body back every tick. Nothing moves, so nothing changes the key.

Trigger (run against the real `createTicker` + real `stubBrain`, mock pathfinder):
```
d=1    action=roam calledBrain=true  setGoals=1   (GoalNear picked, r close to 6)
d=3    action=roam calledBrain=true  setGoals=1   (walking)
d=5.6  action=roam calledBrain=true  setGoals=1   (key "6", roam cached)
d=6.4  action=roam calledBrain=false setGoals=1   (goal reached, isMoving false, hand-back)
d=6.4  action=roam calledBrain=false setGoals=1
d=6.4  action=roam calledBrain=false setGoals=1   ... forever
```
A fresh `stubBrain.decide({distance_to_player: 6.4, player_moving: false})` returns `follow` — the bot is frozen only because the stale `roam` is never re-evaluated.

Reachability: `GoalNear(x, pp.y, z, 1)` lets the bot come to rest up to ~1 block beyond a point picked at `r` up to `ROAM_RADIUS=6`, so any stroll with `r > 5` that arrives from the far side of an obstacle, or on a block a step above the player's y (the distance at `roam.js:20` is 3-D), rests at 6.0-6.9. The arrival tick is exactly where consecutive distances are closest, so the previous tick's key is usually also "6" and the cache hits. The bot then stands still until the player moves, a hostile appears, or health/food changes — which is precisely the "bot looks dead" symptom the bead exists to remove, and it violates the acceptance criterion "player stands still -> the bot strolls".

The same wedge fires whenever the remote brain answers `roam` at any distance past 6 (the case round 01 defended this branch as a guard for): the guard itself is what stops the loop.

No test covers it. `roam.test.js:75-82` calls `roam()` directly at d=20 with a fresh ctx, so it never sees the cache; the new crossover test at `roam.test.js:94-119` jumps 5.5 -> 7, straddling the (6, 6.5) window where the rounded key stays 6.

Fix: Never let roam return without either moving the body or changing the state: raise `HAND_BACK_DIST` to 8 (the bead's own "never leaves 8"), so a bot resting at 6.4 picks a fresh GoalNear inside the envelope and walks back in, changing the key and letting the brain re-decide. Add a ticker-level test that runs three ticks with the bot parked at 6.4 after a cached roam and asserts either a second setGoal or a follow decision.

_confidence: 85 | sources: loop+goal | lenses: bot-loop, goal-and-tests | verdict: unverified_

## Minor

### bot/README.md still documents three brain actions and the old 3-block follow/idle thresholds

`bot/README.md:53-63`

`bot/README.md:50-54` enumerates the brain's exclusive actions as `fight` / `follow` / `idle` with "`idle`: Player is close (<= 3 blocks)", and the behaviours table at `:61-63` says `follow` triggers at "> 3 blocks away" and `idle` at "Player within 3 blocks". After this change a still player at 1-6 blocks yields `roam`, and follow triggers at >3 only while the player is moving, >6 while standing still. All three lines are now wrong and `roam` has no row at all.

The README is the document the in-game acceptance check is read against — the bead says "log lines show action=roam", and an owner reading this README to run that check finds no documented `action=roam` and an idle trigger that states the opposite of what the bot does. The table is also the observation guide for the deployed bot, so the drift lands on a reader diagnosing the live server. Prose only — nothing breaks at runtime, and the bead's Files list does not name bot/README.md, so this is arguably deferrable.

Fix: Add a `roam` bullet and table row (trigger: player within 6 blocks and standing still, no hostile near; observe: stand still, bot strolls and never leaves ~8) and correct the `follow` and `idle` triggers to the moving/still split (>3 moving, >6 still).

_confidence: 99 | sources: loop+goal, contract | lenses: goal-and-tests, contract | verdict: unverified_

### Duplicate stub test case: 'follows back once the stroll leaves the envelope' repeats lines 23-25 verbatim

`bot/test/brain.test.js:32-34`

`brain.test.js:32-34` asserts `stubBrain.decide({ distance_to_player: 7, player_moving: false })` equals follow — character-for-character the same call and expectation as `brain.test.js:23-25` ('follow wins over roam once the player is beyond the envelope (dist 7, still)'). It adds no coverage: deleting either one leaves the same set of mutants killed. (`:11-13` d=1 moving and `:35-37` d=2 moving are likewise near-duplicates, though those at least differ in distance.)

Against the project's smallest-diff rule this is test noise in a diff that is otherwise tightly scoped; it also makes the suite read as if two distinct envelope boundaries were pinned when only one is.

Fix: Delete `brain.test.js:32-34`, or repoint it at the boundary that is genuinely untested — a still player at d=6.4, the distance at which the cached-roam wedge in roam.js bites.

_confidence: 95 | sources: loop+goal | lenses: goal-and-tests | verdict: unverified_

## Sources

| agent | executor | model | effort | tokens | raised | status |
| --- | --- | --- | --- | --- | --- | --- |
| loop+goal | claude | claude-opus-5 (requested opus) | high | 1055559 | 5 | ok |
| contract | claude | claude-opus-5 (requested opus) | high | 999915 | 2 | ok |
