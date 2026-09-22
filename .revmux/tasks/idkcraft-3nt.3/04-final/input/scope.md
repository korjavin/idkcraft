# Scope: idkcraft-3nt.3 round 04-final (merge gate)

Merged origin/master again (PR #24 find-me chat command, PR #25 paused flag: stop parks via idle + stop-once, brain skipped while paused; both touched index.js/tests, auto-merged clean). Suite 89/89 green on the merged head (a1c4ce9, pushed).

Diff vs origin/master: bot/src/behaviours/fight.js (new, 143 lines: GoalFollow pursue + swing gate + spaced retries + give-up with player shadow + sticky target with hysteresis + re-probe + once-per-target equip), bot/src/perception.js (+41: hostile facts, creeper exclusion, stateKey, exported isFightTarget), bot/src/index.js (+1 fight entry), bot/src/brain.js (-4 gap guard), bot/test/fight.test.js (new, 30 tests), bot/test/brain.test.js (-32 guard test), bot/package.json (4 suites in test script).

Rounds 01-03 findings are all fixed and mutation-checked. This is the final pass: hunt remaining defects (tick-stealing, wrong targets, pathfinder churn, stuck pursuit, interplay with paused mode — fight state persists across pause, key-change clears it on resume — and the find-me/scout seam), plus answer the proportionality question in goal.md.

Read: bot/src/behaviours/fight.js, bot/src/perception.js, bot/test/fight.test.js, bot/src/index.js (dispatch + paused branches + scout seam).
