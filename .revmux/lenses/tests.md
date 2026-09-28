---
description: goal fit against the bead, whether npm test would fail without the fix, and whether the new thing is reachable in the deployed bot
---
## Lens: tests

First say in one line what the diff does, then compare with the acceptance criteria in `{{GOAL}}`.

- an acceptance criterion not met, or met only for a config prod does not run (e.g. only with
  `BOT_FOLLOW` set; prod default is empty = work mode)
- new branching logic that changes what the bot does (a step chosen or refused, a stuck verdict, a
  give-up, a menu option) with no test in `bot/test/` that fails when the branch is inverted or deleted —
  name the defect the missing test would catch. A defensive or logging-only branch without a test is
  not a finding
- a test that passes by construction: asserts the value it fed in, a stub configured to agree, an
  existing test edited to match the new gate instead of pinning old behaviour (9sh)
- a new assertion on a log line's exact wording where the same fact is available on `ctx` or a return
  value — log-format assertions couple every fix to the log text (79 such assertions today); **minor**
- a fake-harness blind spot the fix depends on: the fake has no gravity, no collision, no Paper
  movement validation, no real `Movements`/A* executor, no entity tracking range — if the fix only works
  because of the fake, say so; a movement/stuck fix with no `stuck-run.sh` before/after numbers in the
  PR is a **major**
- async left running after a test (meal, timer, promise) that can write into the next test's log
  capture (cn7 flake)
- scope creep: renames or restructuring the bead did not ask for (parallel branches collide)

Reachability (tests call behaviours directly, so a behaviour can pass every test and never run in
prod — 9sh: `dig_step` had no `BEHAVIOURS` entry; dxl: `BOT_AUTONOMOUS` never passed by compose).
Check only what the diff adds:

- a new action/step name: in `BEHAVIOURS`, the arbiter menu, the brain answer mapping, and every tick
  seam that needs it (nobody-online, parked, work, follow)
- a new env var the bot reads: passed in `docker-compose.yml` `bot.environment` and listed in
  CLAUDE.md's stack table; a renamed/removed service, env var, port or `laya` REST field is **critical**
- a new or changed chat command: parsed in `commands.js`, listed in the in-game help reply and
  `bot/README.md`, not shadowed by an earlier pattern
- a new npm dependency present in `package-lock.json`
- any hostname, domain, IP, API key or token in any file, fixture, comment or log line — **critical**

Do not open compose, CI or Dockerfiles unless the diff adds an env var, dependency or build change.
A `// ponytail:` shortcut with its ceiling named is deliberate, not a finding.
