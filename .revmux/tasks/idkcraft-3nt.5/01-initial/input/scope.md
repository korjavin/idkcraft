Review the diff `git diff origin/master...HEAD` on branch idkcraft-3nt.5 (PR #28, draft):
roam as a fourth brain choice. Scale: small, 8 files, +227/-14.

Read in full: bot/src/brain.js (stub + question), bot/src/behaviours/roam.js (new, ~45 lines),
bot/src/index.js (1-line dispatch), bot/test/roam.test.js, bot/test/brain.test.js (roam cases),
laya/smoke.py + laya/test/request.json (contract sync).

Ignore: bot/src/behaviours/fight.js, scout.js, perception.js (untouched), docs, CI/docker,
node_modules, package-lock. Do not re-run tests: `cd bot && npm test` already ran 104/104
green 3x plus a 7-case mutation battery (all killed). Judge correctness from the code.
