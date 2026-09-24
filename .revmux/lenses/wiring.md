---
description: the new thing is reachable in the deployed bot — dispatch entry, tick seam, env var, chat help, privacy
---
## Lens: wiring

Tests call behaviours directly, so a behaviour can pass every test and never run in prod (9sh:
`dig_step` had no `BEHAVIOURS` entry; dxl: `BOT_AUTONOMOUS` never passed by compose). Check only what
the diff adds:

- a new action/step name: is it in `BEHAVIOURS`, the arbiter menu, and the brain answer mapping, and
  wired into every tick seam that needs it (nobody-online, parked, work, follow)?
- a new env var the bot reads: passed in `docker-compose.yml` `bot.environment` and listed in
  CLAUDE.md's stack table; a renamed/removed service, env var, port or `laya` REST field is critical
- a new or changed chat command: parsed in `commands.js`, listed in the in-game help reply and
  `bot/README.md`, and not shadowed by an earlier pattern
- a new npm dependency present in `package-lock.json`
- any hostname, domain, IP, API key or token in any file, fixture, comment or log line — **critical**

Do not open compose, CI or Dockerfiles unless the diff adds an env var, dependency or build change.
