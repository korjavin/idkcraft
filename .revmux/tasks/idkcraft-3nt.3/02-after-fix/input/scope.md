# Scope: idkcraft-3nt.3 round 2 (after round-1 fixes)

Since round 1, merged origin/master (scout PR #22: package.json keeps all 4 suites, index.js keeps fight entry + scout seam) and fixed all 3 round-1 findings in the fight bead only.

Diff vs origin/master (`git diff origin/master...HEAD` in workdir): bot/src/behaviours/fight.js (new, 86 lines: GoalFollow pursue + swing-gate + spaced retries + give-up + once-per-target sword equip), bot/src/perception.js (+35: hostile_distance/hostile_near_player/hostile facts, creeper exclusion, stateKey extension), bot/src/index.js (+1 fight entry), bot/src/brain.js (-4 gap guard), bot/test/fight.test.js (new, 18 tests), bot/test/brain.test.js (-32 guard test), bot/package.json (test script lists all suites).

Fixes to verify: (1) pursuit re-issues setGoal only on new target or every 6th stationary tick, gives up after 18 (no per-tick resetPath churn, no pin on unreachable mob); (2) equipSword runs once per target even at stationary melee; (3) new tests for the player-range filter arm (dBot>8, dPlayer<=6) and the 8-block boundary.

Read: bot/src/behaviours/fight.js, bot/src/perception.js, bot/test/fight.test.js, bot/src/index.js (BEHAVIOURS + scout seam interplay).
