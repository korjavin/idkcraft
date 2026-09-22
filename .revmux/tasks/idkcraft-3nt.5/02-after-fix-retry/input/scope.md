Re-review the diff `git diff origin/master...HEAD` on branch idkcraft-3nt.5 (PR #28, draft)
after round-01 fixes. Scale: small, bot + laya only, +~300/-30 incl. tests.

Round-01 findings and fixes (verify each fix, hunt for regressions, do not re-litigate
rejected points): (1) MAJOR follow-preempted-roam yo-yo FIXED by widening the stub roam
envelope to 6 blocks for a still player with no hostile (bot/src/brain.js stub + question
text; request.json regenerated); new ticker-level crossover test walks the bot to 5.5
(roam, goal untouched) and 7 (follow reclaims). (2) minor AFK brain-call rate acknowledged
as by-design (fresh decisions keep fight preemption instant). (3) minor smoke rows added:
`dist 1 moving` (idle) and `dist 5 still` (roam), 7 states total. Also merged origin/master
(3nt.9 docs + ticker changes) — check the merge kept the one-line roam dispatch.

Read in full: bot/src/brain.js, bot/src/behaviours/roam.js, bot/test/roam.test.js,
bot/test/brain.test.js (envelope cases). Skim: laya/smoke.py, laya/test/request.json,
bot/src/index.js dispatch, merged tick.test.js.

Ignore: fight.js, scout.js, perception.js, docs, CI/docker, node_modules. Do not re-run
tests: `cd bot && npm test` is 111/111 green plus a 9-case mutation battery (all killed).
Finding nothing is a valid answer.
