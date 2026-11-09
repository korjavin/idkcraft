# Project Instructions for AI Agents

This file provides instructions and context for AI coding agents working on this project.

<!-- BEGIN BEADS INTEGRATION v:1 profile:minimal hash:1105d646 -->
## Beads Issue Tracker

This project uses **bd (beads)** for issue tracking. Run `bd prime` to see full workflow context and commands.

### Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --claim  # Claim work
bd close <id>         # Complete work
```

### Rules

- Use `bd` for ALL task tracking — do NOT use TodoWrite, TaskCreate, or markdown TODO lists
- Run `bd prime` for detailed command reference and session close protocol
- Use `bd remember` for persistent knowledge — do NOT use MEMORY.md files

**Architecture in one line:** issues live in a local Dolt DB; sync uses `refs/dolt/data` on your git remote; `.beads/issues.jsonl` is a passive export. See https://github.com/gastownhall/beads/blob/main/docs/core-concepts/sync-concepts.md for details and anti-patterns.

## Agent Context Profiles

The managed Beads block is task-tracking guidance, not permission to override repository, user, or orchestrator instructions.

- **Conservative (default)**: Use `bd` for task tracking. Do not run git commits, git pushes, or Dolt remote sync unless explicitly asked. At handoff, report changed files, validation, and suggested next commands.
- **Minimal**: Keep tool instruction files as pointers to `bd prime`; use the same conservative git policy unless active instructions say otherwise.
- **Team-maintainer**: Only when the repository explicitly opts in, agents may close beads, run quality gates, commit, and push as part of session close. A current "do not commit" or "do not push" instruction still wins.

## Session Completion

This protocol applies when ending a Beads implementation workflow. It is subordinate to explicit user, repository, and orchestrator instructions.

1. **File issues for remaining work** - Create beads for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **Handle git/sync by active profile**:
   ```bash
   # Conservative/minimal/default: report status and proposed commands; wait for approval.
   git status

   # Team-maintainer opt-in only, unless current instructions forbid it:
   git pull --rebase
   git push
   git status
   ```
5. **Hand off** - Summarize changes, validation, issue status, and any blocked sync/commit/push step

**Critical rules:**
- Explicit user or orchestrator instructions override this Beads block.
- Do not commit or push without clear authority from the active profile or the current user request.
- If a required sync or push is blocked, stop and report the exact command and error.
<!-- END BEADS INTEGRATION -->

## Build & Test

- **Node 26** everywhere (`.nvmrc`; CI, `bot/Dockerfile` and `bot/package.json` engines `26.x` agree; bump all together). `nvm use`/`fnm use` picks it up. `npm ci` on another major only warns (EBADENGINE); to make it fail, run `echo engine-strict=true > bot/.npmrc` (idkcraft-6x7.29 shipped soft: no matching Node manager on the dev laptop yet; once one is installed, commit that `bot/.npmrc`).
- **Bot tests:**
  ```bash
  cd bot && npm ci && npm test
  ```
  No Minecraft client is needed for tests — the bot test suite includes a fake-player end-to-end harness.
- Prod signals: `node bot/tools/prod-score.js <pulled-log.txt> --day` (idkcraft-qxql.6).
- **Local stack:**
  ```bash
  docker compose up
  ```
  Requires Docker. Note: first Paper boot downloads ~100 MB of dependencies and plugins, taking 1–2 minutes.

## Architecture Overview

Three containers in a single Docker Compose stack, deployed without Traefik (Minecraft uses raw TCP/UDP, no HTTP routing):

```
+-------------------------------------------------------------+
| Compose Stack (<server-address>)                            |
|                                                             |
|  +-------------------------+     +-----------------------+  |
|  | mc                      |     | bot                   |  |
|  | itzg/minecraft-server   |<----+ ghcr.io/korjavin/     |  |
|  | TYPE=PAPER + Geyser     |     |   idkcraft:<sha>      |  |
|  | 25565/tcp (Java + Bot)  |     | Node 26 + mineflayer  |  |
|  | 19132/udp (Bedrock)     |     | rule FSM              |  |
|  +-------------------------+     +-----------------------+  |
|                                                             |
|  +-----------------------------------------------------+    |
|  | baritone                                            |    |
|  | HeadlessMc + Baritone pilot fish, bridge :7777      |    |
|  | (internal only, no published ports)                 |    |
|  +-----------------------------------------------------+    |
+-------------------------------------------------------------+
```

Bot architecture follows "one body, many senses": local perception (`bot/src/perception.js`) gathers facts every tick, the brain arbitrates body ownership (`fight` | `follow` | `roam` | `idle`, or the work-mode goal arbiter `stay` | `gohome` | `shelter` | `craft` | `equip` | `build` | `gather` | `deliver` | `forage` | `explore` | `rest` when nobody is followed), and execution dispatches via `BEHAVIOURS` (`bot/src/behaviours/*.js`), while scouting runs alongside as a local reflex. Bot disk memory (homes, finds, chunks, danger) lives in `/app/memory/<BOT_USERNAME>.json` on the `bot-memory` named volume — do not rename the path or the volume.

### Shared Contract (do not rename)
- **Services:** `mc`, `bot`, `baritone`, `bot2`, `body2`, `swarm1`..`swarm32` (the `laya` sidecar left the stack in idkcraft-jlda.6; rollback: restore its service + CI steps from pre-jlda.6 git history and set `BRAIN_URL=http://laya:8000/v1/systemone`)
- **Compose file:** `docker-compose.yml` at repository root
- **Bot build context:** `./bot`, `bot/Dockerfile`
- **Image:** `ghcr.io/korjavin/idkcraft:latest` (CI rewrites the tag to the commit SHA on the `deploy` branch)
- **Baritone auth volume:** `idkcraft-baritone-auth` (fixed name — the owner's one-time login targets it whatever the Portainer stack name is)
- **Stack Environment Variables:**
  - `MC_VERSION`: Paper version pin
  - `MC_MEMORY`: RAM allocation (default `4G`)
  - `MC_JAVA_PORT`: Java listening port (`25565`)
  - `MC_BEDROCK_PORT`: Bedrock listening port (`19132`)
  - `MC_MAX_PLAYERS`: Paper max-players (default `40`; swarm up to 33 bots + bot2 + worker + owners; needs an mc restart)
  - `MC_DATA_PATH`: Host bind-mount path (default `./data`)
  - `WHITELIST`: Comma-separated list (Bedrock players prefixed with `.`)
  - `OPS`: Comma-separated operators
  - `LEVEL`: World directory name (default `world`)
  - `BOT_USERNAME`: Bot player name (default `IdkBot`)
  - `BOT_FOLLOW`: Target player to follow (empty = work mode until `follow me`)
  - `OWNER_USERNAME`: owner-only orders (when set, only that player's chat lines become orders, case-insensitive, leading-dot-insensitive; empty = everyone, as before; pass through stack env + recreate)
  - `BOT_BODY`: Bot body (`mineflayer` default | `baritone` — bot2 pins it; never set on bot)
  - `BOT2_USERNAME`: v2 bot name (empty = v2 off; whitelist its OFFLINE uuid like `BOT_USERNAME`)
  - `BOT_CASTLE_PEER`: peer bot whose memory file's complete castle is read (never written) as a night residence (bot2 pins it to `BOT_USERNAME`; empty = off)
  - `BOT_PEER_USERNAME`: peer bot name that ownerOnline ignores (bot2 pins it to `BOT_USERNAME`; v1 excludes v2 via `BOT2_USERNAME`; never set on bot)
  - `BODY2_MEM_LIMIT`: v2 body RAM cap (default `2500m`)
  - `BODY_JVM_ARGS`: extra game-JVM args for the v2 body, appended to `hmc.jvmargs` by `baritone/start.sh` (body2 default `-Xmx1500m`, idkcraft-e4p4; explicit value wins; e.g. `-XX:MaxRAMPercentage=60 -Xlog:gc:stdout`; idkcraft-neuc.67)
  - `BOT_SWARM_N`: flat swarm size incl. `bot` (idkcraft-lhg2; empty = off, swarm1..32 idle: slots with `BOT_SWARM_I` >= N run `sleep infinity` from the compose `command` instead of node; `33` = bot + all 32). `flat <r>` splits the square into N x-strips: bot = strip 0, swarmK = strip K (`BOT_SWARM_I`, pinned per service; never set on bot). bot2 does not split (compose pins bot2 `BOT_SWARM_I=-1`, no strip, and passes `BOT_SWARM_N`/`BOT_SWARM_PREFIX` so its chat sieve matches the swarm). Helpers (strip >= 1) chat only `flattening...` and `flat done`; their progress/refill lines go to the log; helpers answer only `stop`/`flat`; `<BotName>: <command>` addresses one known bot
  - `BOT_SWARM_PREFIX`: swarm bot names `<prefix>1..32` (default `IdkSwarm`; whitelist each OFFLINE uuid like `BOT_USERNAME`; must not collide with `BOT2_USERNAME`)
  - `BOT_SWARM_MEM_LIMIT`: per-swarm-bot RAM cap (default `400m`)
    - Swarm use (idkcraft-zchb): say `flat <r>` — the main bot fixes the square around where you stood and the level = your feet level at command time, relays it (`swarm flat …` chat line, the only bot chat helpers obey; they ignore your own flat line), far helpers walk there; moving away or disconnecting changes nothing, only a new `flat`/`stop`. `flat <r> <x> <z>` (tpd1) still works (level = your feet if the main bot sees you, else the mode). Helpers are flat-only (refuse follow/work, park after `flat done`). Helpers keep the server occupied on a hidden-sample ping — clear `BOT_SWARM_N` after the job
  - `BRIDGE_HOST`/`BRIDGE_PORT`/`BRIDGE_CONSOLE_PORT`: bridge addresses (defaults `body2`/`7778`/`7777`, pinned on bot2)
  - `BRAIN_TICK_MS`: Reflex loop interval (default `1000`)
  - `BRAIN_URL`: retired (idkcraft-vhlb.5) — ignored with a log line; the FSM decides every tick and the laya/JEV tick ask is gone (A/B vhlb.1: no gain). The laya sidecar left the stack in idkcraft-jlda.6 (default empty = stub); manual chat `brain laya|jev` still opts in
  - `BRAIN_TIMEOUT_MS`: Per-call deadline for the remote brain (default `3000`)
  - `BOT_LEAVE_AFTER_MS`: Nobody-online grace in ms before the bot quits and re-polls the server ping (default `60000`; `0` = always on)
  - `BOT_AUTONOMOUS`: stay and work with nobody online (`1`|`true`|`yes`; `on` is NOT accepted; default empty = off; chat `autonomous on` lasts until restart)
  - `BOT_SKILLS`: load generated skills (`bot/skills/*.js`, plus `SKILLS_DIR` on the rig) into the recover/step menus (`1`|`true`|`yes`; default empty = off, loader never called; idkcraft-vf8e.2, contract in `bot/skills/README.md`). v1 (`bot`) only; chat `skills off` lasts until restart; a skill that fails 3 times is banned until restart (`skill <name> banned`)
  - `CASTLE_LLM_ESCALATION`: bot2 only (compose default `1`; `0` = the old castlerecovery menu; idkcraft-8hx3). A retired castle hole gets <=3 LLM calls (`ANTHROPIC_API_KEY`, `LLM_TOKENS_PER_HOUR`), each a plan of <=4 primitives `walk_to`/`dig`/`place`/`wait`/`ask_owner`; safety is in the primitives (refusals go back to the model), then the bot asks the owner and backs off. Logs `escalation target=… plan=[…] outcome=…` and `escalation primitive=… result=…`
  - `BOT2_SKILLS`: the same switch for v2 (`bot2` reads it into its `BOT_SKILLS`; idkcraft-vf8e.4). Promotion: `node bot/tools/skill-promote.js` (`bot/tools/README.md`)
  - `TYPESAFE_API_KEY`: JEV secret; enables only the stall-point plan() (and manual `brain jev`)
  - `ANTHROPIC_API_KEY`: opt-in LLM stall-point planner (watchdog `plan()` only, never per tick); empty = today's planner
  - `PLANNER`: `llm` | `jev` (default `llm` when `ANTHROPIC_API_KEY` is set, else `jev`)
  - `LLM_MODEL`: LLM planner model (default `claude-haiku-5-5`)
  - `BOT_LLM_ORDERS`: LLM orders (idkcraft-vf8e.6; `1`|`true`|`yes`, needs `ANTHROPIC_API_KEY`; default empty = off, chat unchanged). A roster player's unparsed line (or an unknown `bring me` name, or `plan <order>`) gets ONE model call -> a plan of whitelisted steps: chat orders (`bring`/`find`/`flat`/`share`, re-fed through the chat path) and goal work steps (pinned via `ctx.taskPlanStep`). `stop`/`follow me`/`go work` cancel; `status` shows the plan step; tokens count as `use=orders` under `LLM_TOKENS_PER_HOUR`
  - `LLM_TOKENS_PER_HOUR`: sliding-hour token cap per bot process for every Anthropic call (`brain.js` `llmCall`; default `200000`, `0` = unlimited); over it the call is skipped (`llm_calls_total{outcome="budget"}`) and the planner parks as on any error
  - `GOAL_WATCHDOG_MS`: Goal-metric flat window in ms before a fast JEV round fires (default `60000`; `0` = watchdog off, the shipped 15/45-min ladder)
  - `GOAL_COMMIT_MS`: Bounded commitment window in ms for a watchdog choice (default `120000`)
  - `GOAL_WATCHDOG_MAX_ROUNDS`: Consecutive flat rounds before park/plan-B (default `6`)
  - `GOAL_TRAVEL_GRACE_MS`: Rate-limit floor for the castlefetch travel grace (default `90000`)
  - `GOAL_PLANB_SWITCH_MS`: Plan-B goal-switch duration in ms when nobody is online (default `450000`)
  - `CASTLE_TIDY_MS`: Owner bot walks back to its complete castle to repair/sweep once its last visit is this old (default `3600000`; `0` = off)
  - `WORKER_NAME`: Baritone worker player name (default empty = worker off, zero behaviour diff)
  - `WORKER_HOST`: Worker bridge host (default `baritone`)
  - `WORKER_PORT`: Worker bridge port (default `7777`)
  - `BARITONE_MEM_LIMIT`: Worker container memory cap (default `2500m`)
  - `BARITONE_OFFLINE`: `1` = worker launches offline under `WORKER_NAME`, no account (default empty = idle, no JVM)

## Conventions

- **Privacy:**
  - Never commit hostnames, domain names or IPs; use placeholders, real values live in Portainer env vars.
- **House GitOps:**
  - Pushing to `master` triggers GitHub Actions CI.
  - CI builds `ghcr.io/korjavin/idkcraft:<sha>`, force-pushes to the `deploy` branch, and triggers the Portainer webhook.
  - Portainer tracks the `deploy` branch, never `master`.
- **Secrets:**
  - Never commit API keys or credentials to the repository.
  - The JEV API key is stored in stash at `secrets/jev-api-key` and passed to Portainer as `TYPESAFE_API_KEY`.
  - The bot must run with the stub brain whenever the key is absent.
- **Step status:** new writes/parses of `ctx.stepStatus` (`done` / `failed:<reason>`) go through `bot/src/step.js` (`stepDone`/`stepFailed`/`failReason`/`isFinished`); convert existing ones in files a PR already touches.
- **Simplicity (Ponytail rules):**
  - Smallest diff that meets acceptance criteria, no speculative abstractions beyond the single brain interface.
  - Server runs `ONLINE_MODE=false` + `ENFORCE_WHITELIST=TRUE` in iteration 1 so the bot does not need a Microsoft account.

## Fast experimental delivery (owner 2026-11-09)

This is a game: ship small experiments promptly and tolerate minor regressions.
The owner supersedes the older mandatory revmux, rig and multi-round review gates.
Keep Beads for work tracking, but do not create process-only handoffs or wait for
an architect/review round when a focused fix is clear.

- For ordinary changes, run focused tests or a targeted reproduction, and have the
  orchestrator or another developer inspect the diff for correctness. A brief
  review is enough; revmux, full local suites and rigs are optional tools.
- Merge and deploy once the focused checks and review pass; do not wait for
  duplicate PR CI. The main CI test suite gates deployment on master; the slow
  suite runs independently and failures must be investigated. Do not claim
  deployment before verifying the running image and relevant production logs.
- Treat credentials, access controls, world/data deletion or migration, and
  deployment infrastructure as higher risk: inspect the exact change and use
  appropriate extra checks. Preserve secrets, player builds and existing data.
- Prefer reversible, small changes; note the production signal and roll back or
  fix a regression promptly. Do not wait for long rigs or new review rounds by
  default. The v1 body and frozen replay remain out of scope unless requested.
- Before publishing, scan the diff for secrets, hostnames and IP addresses.
  Existing explicit user instructions always take precedence.
