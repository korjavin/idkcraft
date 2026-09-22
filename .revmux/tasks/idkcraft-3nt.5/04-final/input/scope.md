Final verification of the diff `git diff origin/master...HEAD` on branch idkcraft-3nt.5
(PR #28, draft). Scale: small, bot + laya only.

Round-03 findings and fixes (verify each fix, hunt for regressions only): (1) MAJOR
hand-back wedge FIXED — roam() past 6 blocks now walks back with GoalFollow (same
re-issue guard as follow.js) instead of setting no goal; new ticker-level wedge test rests
the bot at 6.4 with a stale cached roam and asserts recovery. (2) MAJOR criteria gaps
FIXED — follow/idle criteria rewritten so every stub branch (incl. low-health hostile
retreat) matches exactly one criterion; request.json regenerated from brain.js strings;
smoke table is 8 states incl. `hostile 4 weak`. (3) minor duplicate stub test removed.
(4) minor README drift (3 actions documented, no roam row) DEFERRED — bot/README.md is
edited in parallel by the docs track and outside this bead's file list; confirm only that
no runtime behavior depends on it.

Read in full: bot/src/behaviours/roam.js, bot/src/brain.js (stub + question). Skim:
bot/test/roam.test.js, bot/test/brain.test.js, laya/smoke.py, laya/test/request.json.

Ignore: fight.js, scout.js, perception.js, docs, CI/docker, node_modules. Do not re-run
tests: `cd bot && npm test` is 113/113 green plus mutation battery (walk-back deleted → 3
failures; caution disabled → 4; all earlier mutants killed). Finding nothing is valid.
