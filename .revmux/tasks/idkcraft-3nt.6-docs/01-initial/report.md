# Review: idkcraft-3nt.6-docs / 01-initial

scope: `/Users/iv/Projects/idkcraft/.revmux/tasks/idkcraft-3nt.6-docs/01-initial/input/scope.md`

## Minor

### perception.js credited with ore scanning it does not do

`bot/README.md:49`

The arbitration bullet says "**Perception is local and always-on (`src/perception.js`):** Every tick, the bot computes distances, hostile mob proximity, and loaded ore chunks." `bot/src/perception.js` (read in full, 103 lines) exports only `findTarget`, `buildState`, `stateKey`, `isFightTarget` — distances, hostile ranges, health/food, nearby-hostile count. It never calls `findBlocks` and knows nothing about ore. Ore scanning lives in `bot/src/behaviours/scout.js:127` and runs on a 5 s gate, not every tick. On a learning project where the README is the discoverability deliverable, this points a reader at the wrong file for the scout logic and contradicts the same document's own Scout bullet two sections below (`src/behaviours/scout.js`, every 5 s).

Fix: Drop "and loaded ore chunks" from the perception bullet; the Execution bullet already credits scouting to `src/behaviours/scout.js`.

_confidence: 90 | sources: loop+goal | lenses: goal-and-tests, bot-loop | verdict: confirmed_

### README documents `roam`, which exists nowhere in the tree

`bot/README.md:54`

Two places describe a `roam` behaviour: line 54 "*(roam is currently being added as a fourth choice to stroll near a stationary player)*" and lines 80-81 "**Roam (upcoming):**". `rg -ni roam` across the worktree matches `bot/README.md` only — no code, no test, no brain criterion; `bot/src/brain.js:39` accepts only fight/follow/idle and `stubBrain` has no roam branch. `bd show idkcraft-3nt.5` confirms roam is still `in_progress` and unmerged, and 3nt.6's own Notes say "Depends on 3nt.3 and 3nt.4 (and 3nt.5 if it lands first; do not wait for it)" — the docs bead does not ask for roam to be documented ahead of the code. The cited precedent is real: commit 051cb76 removed "future" from a scout.js comment in review round 1.

Weaker than the finding implies: both mentions are labelled "currently being added" / "(upcoming)", so a reader is not misled about what the bot does today. What remains is a concrete staleness risk — the bullet already commits to specific numbers ("within 6 blocks of a standing player") that 3nt.5 may land differently — and a README that documents a behaviour the reader cannot observe. The fix is deleting two lines, so it costs nothing.

Fix: Delete the parenthetical on line 54 and the "Roam (upcoming)" bullet; document roam in the PR that actually adds it.

_confidence: 75 | sources: loop+goal | lenses: goal-and-tests | verdict: refined_

### "Scouting runs every tick" is false with nobody online

`bot/README.md:56`

Line 56 says "Scouting has zero body cost and runs every tick alongside whatever decision is executing", and the Behaviours table (line 65) repeats "runs every tick". In `bot/src/index.js:79-97`, when `findTarget` returns no target the tick returns at line 96 — before the scout seam at lines 101-102 — so no scan happens at all, and the loop drops to the 10 s `IDLE_TICK_MS` cadence. The same holds on the paused path, which scouts only `if (target)` (index.js:58-62). The comment at index.js:54-55 states this deliberately: "same cost guard as 'no player online', including no scans with nobody online." The README's Cost guards paragraph (lines 39-43) mentions only brain calls, tick cadence and log volume, so nothing tells the owner that a bot left alone on the server stops scouting entirely — a reader comparing the README against a container log would conclude the scout is broken. (The finding's grep illustration is a little loose: `scout ` lines are logged only for newly-seen veins (`scout.js:168`), so their absence is not by itself proof — but the scan genuinely does not run.)

Fix: Qualify as "runs every tick while a player is visible" and add the no-scans-with-nobody-online clause to the Cost guards paragraph.

_confidence: 85 | sources: loop+goal | lenses: bot-loop, goal-and-tests | verdict: refined_

### Sprint documented as requiring a moving player; the default stub ignores that

`bot/README.md:55`

Line 55 says the brain decides sprint "when player is > 8 blocks away and moving", and the follow row (line 62) repeats "`sprint` if > 8 blocks and moving". The remote-model prompt does carry the moving clause (`bot/src/brain.js:93`), but `stubBrain.decide` at `bot/src/brain.js:32` returns `{ action: 'follow', sprint: d > 8 }` with no reference to `state.player_moving`. The stub is the default path whenever `BRAIN_URL` and `TYPESAFE_API_KEY` are both absent (`makeBrain`, brain.js:124-137) and is also the fallback on every remote error (brain.js:116). So with the documented stub configuration, a player standing still 10 blocks away still gets `sprint=true` in the `decision source=stub` log line — the opposite of what the README tells the reader to expect from the same log.

Fix: Say the moving condition applies to the remote classifier and that the stub sprints on distance alone, or just state "sprint when the player is more than 8 blocks away".

_confidence: 85 | sources: loop+goal | lenses: bot-loop, goal-and-tests | verdict: confirmed_

## Sources

| agent | executor | model | effort | tokens | raised | status |
| --- | --- | --- | --- | --- | --- | --- |
| loop+goal | claude | claude-opus-5 (requested opus) | high | 443042 | 6 | ok |
| contract | claude | claude-opus-5 (requested opus) | high | 403457 | 0 | ok, nothing raised |
