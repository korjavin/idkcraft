# Review: idkcraft-3nt.2 / 01-initial

scope: `/Users/iv/Projects/idkcraft/.revmux/tasks/idkcraft-3nt.2/01-initial/input/scope.md`

## Major

### `fight` is now a reachable brain answer, but index.js maps it to a full stop

`bot/src/brain.js:39`

Verified against the code. `parseAction` (bot/src/brain.js:39) now accepts `fight` and the action question advertises it (brain.js:84-89), so the remote brain can answer `fight` on any tick, and the model's answer wins by design (brain.js:107-111 only logs the disagreement with the stub). The consumer is untouched by this diff: `applyDecision` (bot/src/index.js:87-99) handles `follow` only; `fight` falls into the else branch, which calls `bot.pathfinder.stop()` and sets `lastGoalKey = 'idle'`. The bot neither follows nor fights — it parks. Before this commit `parseAction` returned null for `fight`, which threw, was caught, and degraded to the stub → `follow`; the `fight` criterion also did not exist in the question, so the model was never offered it.

The finding's open question is answered by the PR body itself: the pasted smoke table has the `dist 1` row (`distance_to_player=1.0 ... nearby_hostiles=0 hostile_distance=none hostile_near_player=false`) answered `fight`. So laya does pick `fight` with zero hostile signal in the line — its fight boundary is not constrained by the hostile fields. Two corrections to the finding's reasoning, though:

- On that particular row `fight` and `idle` both land in the same else branch, so the observed case is behaviourally harmless. The harmful case is `fight` returned while the player is far (where `follow` was due); the two far rows in the table (`dist 12`, `dist 5`) came back `follow`, so that case is plausible but not demonstrated. The realistic prod trigger is the state the table never covers: index.js does populate `nearby_hostiles` (index.js:69-75, mobs within 16 blocks), so at night the line reads `distance_to_player=12.0 ... nearby_hostiles=1 hostile_distance=none`, which is the only hostile signal the model gets and exactly what the `fight` criterion describes.
- "Frozen indefinitely" is overstated. `stateKey` (index.js:22-29) does include `nearby_hostiles`, so a wandering mob changes the key and forces a fresh brain call; the player moving does the same. The cache does not lock the bot in place — but a re-query on a near-identical state will usually return `fight` again, so the practical outcome (the bot stops following) stands.

This falsifies the bead's own acceptance line "In-game: nothing visible yet (perception does not send hostile fields until the fight bead lands)": the absence of the hostile fields does not stop the model from choosing `fight`. It matches the profile's stated failure mode "a behaviour steals the tick from another one (follow stops …)", and merges to master deploy straight to Portainer, so this lands live in the window before idkcraft-3nt.3 (still OPEN) adds `behaviours/fight.js` and the hostile part of `stateKey`.

One factor cuts the other way and is worth knowing: the smoke run shows p50 3683 ms against `BRAIN_TIMEOUT_MS` default 3000, so on a comparably slow sidecar most calls would time out into `stub-fallback`, and the stub cannot return `fight` without hostile fields — the bot would keep following. That is chance, not a guard.

Fix: The bead explicitly forbids touching bot/src/index.js here, so the proportionate action is ordering, not code: say in the PR/bead that this must not deploy to master alone, and land it together with (or after) idkcraft-3nt.3, which adds fight execution and the hostile fields in `stateKey`. If it must go alone, the contained alternative is a one-line guard in applyDecision so an action the body cannot execute keeps following rather than parking — but that edits a file this bead scopes out and 3nt.3 rewrites anyway, so prefer the merge-order note.

_confidence: 78 | sources: loop+goal, contract | lenses: bot-loop, goal-and-tests, contract | verdict: refined_

## Minor

### No test pins the 8-block / 6-health boundaries the bead names explicitly

`bot/test/brain.test.js:20-28`

The bead's reference policy is `hostile_distance <= 8` and `bot_health >= 6`, and the criteria string shipped to the model says "bot_health is 6 or more". The three new stub tests use `hostile_distance: 4` with `bot_health: 20` and `bot_health: 5` — every one of them still passes if the comparisons are rewritten as `hd < 8` and `health > 6`.

Concrete defect the missing test would catch: a bot at exactly 6 health (3 hearts) with a hostile at exactly 8 blocks refusing to fight, while the criteria text sent to LAYA tells the model to fight — which makes the disagreement log, the whole point of this bead, report a difference that is the stub's fault, not the model's. Since the stub is the declared reference policy the owner reads prod logs against, an off-by-one here silently corrupts the experiment's baseline.

Fix: Add two stub cases: `{ hostile_distance: 8, bot_health: 6 }` → fight, and `{ hostile_distance: 8.1, bot_health: 20, distance_to_player: 5 }` → follow.

_confidence: 88 | sources: loop+goal | lenses: goal-and-tests | verdict: confirmed_

### Nothing asserts the disagree log stays silent when model and stub agree

`bot/test/brain.test.js:95-126`

The new test proves the log fires on disagreement, but no test proves it fires *only* then — the bead's wording is "One line, only on disagreement". Delete the `if (ref !== action)` guard at bot/src/brain.js:108 and the whole suite still passes: the agreement cases ('maps a canned JEV answer to follow/sprint', 'sends the expected request shape', the laya-endpoint cases) never capture `console.error`, so an unconditional log goes undetected until prod, where it would emit one error-level line for every brain call — i.e. one per tick with a player online, which is exactly the log-volume guard the bead cares about.

Fix: In the existing disagree test (or a sibling), also run an agreeing case under the same stubbed `console.error` — canned `choice: 'follow'` with `{ distance_to_player: 12 }` — and assert `logs.length === 0`.

_confidence: 85 | sources: loop+goal | lenses: goal-and-tests | verdict: confirmed_

## Pre-existing

### Editing laya test files retags and redeploys the laya sidecar

`laya/test/request.json:3`

CI tags the laya image by the `laya/` directory tree hash (.github/workflows/deploy.yml:41, `LAYA_SHA=$(git rev-parse HEAD:laya)`). `laya/test/request.json` and `laya/smoke.py` live inside that tree, so this test-only change produces a new LAYA_SHA, `docker manifest inspect` misses, and CI rebuilds, smokes and pushes a new image tag, then rewrites `image: ghcr.io/korjavin/idkcraft-laya:<sha>` on the deploy branch (deploy.yml:119). Portainer therefore recreates the sidecar on merge even though the runtime bytes (`shim.py`, weights) are identical.

Consequence: the laya container restarts and reloads the model — the healthcheck allows a 120 s start_period (docker-compose.yml:114) — and during that window every bot tick with a player online fails its brain call and logs `brain jev error, stub fallback`. That is the exact signal this bead's acceptance criterion asks the owner to read ("no stub-fallback regressions on prod logs"), so the deploy will produce a burst that looks like a regression and is not one.

Routed as pre-existing because the tagging scheme is untouched by this change — it was introduced by idkcraft-cne.9; this branch only happens to trip it.

Fix: No code change needed in this PR — note the expected stub-fallback burst on the bead so it is not read as a regression. If it recurs, the durable fix is to compute LAYA_SHA from the files the image actually ships (shim.py, Dockerfile, test/request.json) rather than the whole `laya/` tree, so smoke-only edits do not retag.

_confidence: 80 | sources: contract | lenses: contract_

## Sources

| agent | executor | model | effort | tokens | raised | status |
| --- | --- | --- | --- | --- | --- | --- |
| loop+goal | claude | claude-opus-5 (requested opus) | high | 402313 | 4 | ok |
| contract | claude | claude-opus-5 (requested opus) | high | 883450 | 2 | ok |
