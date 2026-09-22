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
- loop+goal (lenses: bot-loop, goal-and-tests) reported 5 findings: loop+goal-1, loop+goal-2, loop+goal-3, loop+goal-4, loop+goal-5
- contract (lenses: contract) reported 3 findings: contract-1, contract-2, contract-3

Treat that list as fact. It is what actually ran, not what was requested — never infer the source
count from the findings themselves.

## Findings

[
  {
    "id": "loop+goal-1",
    "file": "bot/src/behaviours/roam.js",
    "line": 12,
    "end_line": 30,
    "severity": "major",
    "confidence": 75,
    "title": "follow preempts roam at 3 blocks, so the stroll yo-yos and never reaches the 6-block radius",
    "body": "roam picks a point up to ROAM_RADIUS=6 blocks from the player and hands the body back only past HAND_BACK_DIST=6 (roam.js:12-13, :23). But the arbitration that dispatches roam switches to follow at 3 blocks — stubBrain `if (d \u003e 3) return follow` (brain.js:32), and the remote question says the same (\"follow when the player is more than 3 blocks away\", brain.js:90/93). Tick trace with a standing player: tick N, d≈1, brain says roam, roam sets GoalNear at a point ~5 blocks out, bot starts walking. Tick N+1 (1 s later, walking speed ~4.3 b/s) the bot is at d≈4, so stateKey changed and the fresh decision is follow; follow.js sees key `follow:Steve` !== ctx.lastGoalKey (`roam:…`) and calls setGoal(GoalFollow(target,3),true), which replaces the roam goal. The bot reverses mid-stroll and walks back to 3. Tick N+2: d\u003c=3, roam again, new random point. Observable result is a yo-yo between ~1 and ~4.5 blocks, not the \"strolling in a radius of ~6 blocks\" the bead's acceptance criterion asks for, and the ore-scan widening that motivates the bead is roughly halved. Corollary: the `distToPlayer \u003e HAND_BACK_DIST` branch (roam.js:23) is unreachable under the shipped policy — nothing ever dispatches roam at d\u003e3, let alone d\u003e6 — so the 6-block geometry in this file and the 3-block threshold in the brain never agree. No test in bot/test/ covers the roam→follow crossover; a test that ticks the ticker with the real stub while the bot sits at d=4 and asserts the roam goal survives (or is deliberately dropped) would have caught this.",
    "fix": "Make the two thresholds agree. Smallest version: let the stub hold roam while the player is still — `if (d \u003e 3 \u0026\u0026 (state.player_moving || d \u003e HAND_BACK_DIST)) return follow` (and the matching sentence in the question/criteria text plus request.json), so an in-flight stroll runs out to 6 before follow takes the body back. Alternatively drop ROAM_RADIUS/HAND_BACK_DIST to 3 and accept a smaller stroll, and say so on the bead.",
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
    "file": "bot/src/brain.js",
    "line": 36,
    "end_line": 38,
    "severity": "minor",
    "confidence": 85,
    "title": "roam defeats the state-dedup cache: a standing player now means a brain call every tick instead of none",
    "body": "stateKey exists to skip remote calls — its own comment reads \"distance rounded to 1 block + same flags =\u003e reuse last decision, skip the JEV call\" (perception.js:27-28), and index.js:106 serves the cached decision whenever the key is unchanged. Before this change a player standing still inside 3 blocks produced a constant state (bot idle, distance fixed), so the brain was called once and never again while they stood there. With roam the bot is in motion every tick, so distance_to_player rounds to a different value most ticks and the cache never hits: an AFK player now generates ~1 remote call per second indefinitely against the laya sidecar (BRAIN_URL default). Nothing crashes — inFlight serialises the calls — but a slow CPU answer over BRAIN_TIMEOUT_MS also yields a stub-fallback, which is deliberately not cached (index.js:113), so a timing-out sidecar produces one call plus one console.error per tick forever. The money ceiling is the pennies/day the ponytail note in brain.js:74-76 states; the sidecar CPU load is the real change.",
    "fix": "Skip the brain while a roam goal is in flight, e.g. in the ticker reuse lastDecision when `lastDecision.action === 'roam' \u0026\u0026 bot.pathfinder.isMoving()`, so only the start and end of each stroll cost a call.",
    "sources": [
      "loop+goal"
    ],
    "lenses": [
      "bot-loop"
    ],
    "verdict": ""
  },
  {
    "id": "loop+goal-3",
    "file": "laya/smoke.py",
    "line": 37,
    "end_line": 38,
    "severity": "minor",
    "confidence": 90,
    "title": "new smoke row \"dist 1 still\" is byte-identical to the existing \"dist 1\" row, so the four-choice table proves nothing",
    "body": "The state string added at smoke.py:38 is character-for-character the same as the \"dist 1\" row at smoke.py:33-34 (distance_to_player=1.0 … player_moving=false … hostile_distance=none hostile_near_player=false). The table now makes five calls for four distinct states, and the fifth row can only echo the third. The bead asks for this row so the human can \"look at what the model answers\" with four choices, and the fallback decision (drop roam from the question if LAYA degrades) is supposed to be made from that table — but no row exercises the one boundary roam introduces, a close player who IS moving, where the model must answer idle rather than roam. As it stands the quality table cannot show the degradation the bead is guarding against.",
    "fix": "Change the new row to the discriminating case, e.g. (\"dist 1 moving\", \"distance_to_player=1.0 player_visible=true player_moving=true bot_health=20 bot_food=20 nearby_hostiles=0 hostile_distance=none hostile_near_player=false\").",
    "sources": [
      "loop+goal"
    ],
    "lenses": [
      "goal-and-tests"
    ],
    "verdict": ""
  },
  {
    "id": "loop+goal-4",
    "file": "bot/src/behaviours/roam.js",
    "line": 21,
    "end_line": 23,
    "severity": "minor",
    "confidence": 65,
    "title": "the \"hand the body back (set no goal)\" branch does not clear the in-flight goal",
    "body": "The comment at roam.js:21-22 promises \"set no goal\", and the bead spells it out the same way, but the branch only returns: an already-issued non-dynamic roam goal keeps running and the bot keeps walking to a stale point. The check also sits before the isMoving() guard, so it is precisely the moving case it fails to handle. Under the stub this is unreachable (see the threshold finding — roam is never dispatched past 3 blocks), but a remote brain answering roam at d\u003e6 gets a bot that ignores the hand-back and keeps strolling, and ctx.lastGoalKey is left pointing at the old roam key so the next behaviour's dedupe sees stale state. roam.test.js:75-82 asserts the current no-op behaviour (stop count 0, lastGoalKey untouched), so it locks the mismatch in rather than catching it.",
    "fix": "Clear the goal before returning, mirroring fight.js's guard: `if (distToPlayer \u003e HAND_BACK_DIST) { if (bot.pathfinder.isMoving()) bot.pathfinder.stop(); ctx.lastGoalKey = 'idle'; return }` — or fix the comment to say the goal is left to run out.",
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
    "file": "bot/src/behaviours/roam.js",
    "line": 27,
    "end_line": 30,
    "severity": "minor",
    "confidence": 60,
    "title": "GoalNear flooring pushes the goal past the stated 6-block radius, up to ~7.4 blocks",
    "body": "The point is picked at r \u003c 6 from the player, but GoalNear floors each coordinate (node_modules/mineflayer-pathfinder/lib/goals.js:52-57), which moves the goal block up to one block further out in both x and z when the point lands in the −x/−z quadrant: worst case 6 + sqrt(2) ≈ 7.41 blocks from the player. GoalNear's range is 1, so the bot may stop a further block short, ~8.4 from the player — past the bead's \"never further than 8\". roam.test.js:58 encodes this by asserting `d \u003c= 7.5` rather than the 6 the merge gate states, so the assertion cannot fail on a widened radius below 7.5. Today the threshold finding above masks this in practice (the bot is yanked back at 3-4 blocks and never gets out there); fixing that makes this live.",
    "fix": "Pick the point on integer blocks, e.g. `const x = Math.round(pp.x + Math.cos(angle) * r)` with the same for z, and drop ROAM_RADIUS to 5 so goal + range 1 stays inside 6; then tighten the test bound to 6.",
    "sources": [
      "loop+goal"
    ],
    "lenses": [
      "goal-and-tests"
    ],
    "verdict": ""
  },
  {
    "id": "contract-1",
    "file": "bot/src/behaviours/roam.js",
    "line": 30,
    "end_line": 31,
    "severity": "major",
    "confidence": 95,
    "title": "Roaming busts the decision cache, so a standing player now costs one brain call per tick instead of one total",
    "body": "`perception.js:27-29` states the cost guard in writing: \"Dedup key: distance rounded to 1 block + same flags =\u003e reuse last decision, skip the JEV call\", and `index.js:106` only reuses `lastDecision` while `stateKey(state)` is unchanged. `distance_to_player` is part of that key.\n\nBefore this change, a player standing within 3 blocks was the cheapest possible state: the stub answered idle, `applyDecision` stopped the pathfinder, the bot did not move, the rounded distance stayed constant, and the brain was called exactly once and then cached for as long as the player stood still.\n\nRoam moves the bot. `setGoal` sends it up to 6 blocks away at pathfinder speed (~4.3 blocks/s against the default `BRAIN_TICK_MS=1000`), so `Math.round(distance_to_player)` changes on nearly every tick and the cache misses on nearly every tick. Worse, the stub flips to `follow` as soon as the bot crosses 3 blocks, so the bot yo-yos out and back, guaranteeing the key keeps changing.\n\nI ran the real `createTicker` with a mock pathfinder that walks 4.3 blocks per tick toward the goal, with the player motionless at 1 block:\n- this branch: `roam, roam, roam, follow, roam, roam, follow, ...` — **10 brain calls in 12 ticks**\n- master's behaviour (idle at d\u003c=3): **1 brain call in 12 ticks**\n\nSo an AFK or building player — the single most common state on this server — now drives a continuous ~1 req/s stream at `BRAIN_URL`. On the default `laya` sidecar that is a permanent CPU inference load (~127 ms p50 per the CI note) where there was previously none; if `BRAIN_URL` points at JEV it is paid traffic for as long as someone stands still.\n\nA side effect of the same yo-yo, visible in the trace above: the bot never gets past ~4.5 blocks before `follow` yanks it back, so `HAND_BACK_DIST = 6` at roam.js:13/23 is unreachable under the stub policy and the effective stroll radius is ~4, not the ~6 the bead asks for.",
    "fix": "Drop `distance_to_player` out of the dedup key while the last decision was `roam` (or key roam ticks on the goal instead of the distance), so a motionless player yields one brain call and the roam goal simply runs to completion. Cheapest version: in `index.js`, reuse `lastDecision` when `lastDecision.action === 'roam' \u0026\u0026 bot.pathfinder.isMoving()` and only the distance component of the key changed.",
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
    "file": "bot/src/brain.js",
    "line": 95,
    "end_line": 95,
    "severity": "major",
    "confidence": 85,
    "title": "The four-choice request has never been exercised against laya; the smoke quality table the bead requires is missing",
    "body": "The bead's acceptance criteria require \"smoke.py quality table pasted in the PR with the four-choice outcome\", and the bead exists precisely because a fourth criterion is a known risk for this model (\"cne.4 showed it collapses to one answer when criteria are vague\"), with a recorded fallback path if it degrades. The PR #28 body states plainly that no sidecar was reachable and no table could be produced, and takes the primary path on the grounds that there is \"no local evidence of collapse\" — that is absence of evidence, and the evidence the bead asks for is exactly what is missing.\n\nConcretely, `laya/shim.py:66` passes `body.questions` straight into `agent.predict`, so the choice set the model has to arbitrate over is whatever `criteria` contains. This change makes that four keys for the first time, and nothing in the change has run against a live sidecar.\n\nThe first execution will be in CI: `.github/workflows/deploy.yml` rebuilds the laya image because the `laya/` tree hash changed, then runs `python3 laya/smoke.py` as a gate. That step has no `continue-on-error`, so if laya errors or returns anything outside `{fight, follow, roam, idle}` the job fails *after* the bot image has been pushed but *before* \"Update deploy branch\" and \"Trigger Portainer webhook\" — the live stack silently stays on the previous deploy with a red master build. `check()` accepts all four choices, so a quality collapse (always answering `roam`) passes the gate silently and reaches production as a bot that ignores hostiles.\n\nPre-existing risk that this change is the first to take on, not a regression in the code itself.",
    "fix": "Run `laya/smoke.py` against the sidecar and paste the five-row table into the PR before merging, then record on the bead which path was taken. If the table shows roam/idle where fight/follow belongs, take the bead's documented fallback: drop the `roam` criterion from the question and use the idle-streak local rule.",
    "sources": [
      "contract"
    ],
    "lenses": [
      "contract"
    ],
    "verdict": ""
  },
  {
    "id": "contract-3",
    "file": "laya/smoke.py",
    "line": 37,
    "end_line": 38,
    "severity": "minor",
    "confidence": 90,
    "title": "New \"dist 1 still\" smoke row is byte-identical to the existing \"dist 1\" row, so the quality table gains no roam coverage",
    "body": "The state strings on lines 34 and 38 are identical character for character — I parsed `STATES` and compared: `DUPLICATE state string: dist 1 == dist 1 still`. The pre-existing \"dist 1\" row already has `player_moving=false`, so it was already the roam case.\n\nThe result is that the quality table the bead asks for still cannot separate roam from idle: every row with a close player is still, and every moving row (`dist 12 moving`, `dist 5`) is far. There is no close-and-moving state, which is the one that must answer idle rather than roam — the exact new branch added at `brain.js:36`. The extra row costs one more inference call in the CI gate and returns no new information.\n\nThe PR body reframes the duplicate as a deliberate determinism probe. That is a fair secondary use, but it does not replace the missing discriminating row.",
    "fix": "Change the new row to the close-and-moving case, e.g. `(\"dist 1 moving\", \"distance_to_player=1.0 player_visible=true player_moving=true bot_health=20 bot_food=20 nearby_hostiles=0 hostile_distance=none hostile_near_player=false\")`, so the table shows roam vs idle side by side.",
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
