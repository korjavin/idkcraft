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

- **Bot tests:**
  ```bash
  cd bot && npm ci && npm test
  ```
  No Minecraft client is needed for tests — the bot test suite includes a fake-player end-to-end harness.
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
|  | 25565/tcp (Java + Bot)  |     | Node 22 + mineflayer  |  |
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
  - `MC_DATA_PATH`: Host bind-mount path (default `./data`)
  - `WHITELIST`: Comma-separated list (Bedrock players prefixed with `.`)
  - `OPS`: Comma-separated operators
  - `LEVEL`: World directory name (default `world`)
  - `BOT_USERNAME`: Bot player name (default `IdkBot`)
  - `BOT_FOLLOW`: Target player to follow (empty = work mode until `follow me`)
  - `BOT_BODY`: Bot body (`mineflayer` default | `baritone` — bot2 pins it; never set on bot)
  - `BOT2_USERNAME`: v2 bot name (empty = v2 off; whitelist its OFFLINE uuid like `BOT_USERNAME`)
  - `BOT_CASTLE_PEER`: peer bot whose memory file's complete castle is read (never written) as a night residence (bot2 pins it to `BOT_USERNAME`; empty = off)
  - `BOT_PEER_USERNAME`: peer bot name that ownerOnline ignores (bot2 pins it to `BOT_USERNAME`; v1 excludes v2 via `BOT2_USERNAME`; never set on bot)
  - `BODY2_MEM_LIMIT`: v2 body RAM cap (default `2500m`)
  - `BOT_SWARM_N`: flat swarm size incl. `bot` (idkcraft-lhg2; empty = off, swarm1..32 idle; `33` = bot + all 32). `flat <r>` splits the square into N x-strips: bot = strip 0, swarmK = strip K (`BOT_SWARM_I`, pinned per service; never set on bot). bot2 does not split; helpers answer only `stop`/`flat`
  - `BOT_SWARM_PREFIX`: swarm bot names `<prefix>1..32` (default `IdkSwarm`; whitelist each OFFLINE uuid like `BOT_USERNAME`; must not collide with `BOT2_USERNAME`)
  - `BOT_SWARM_MEM_LIMIT`: per-swarm-bot RAM cap (default `400m`)
    - Swarm use (idkcraft-zchb): say `flat <r>` — the main bot fixes the square around where you stood and the level = your feet level at command time, relays it (`swarm flat …` chat line, the only bot chat helpers obey; they ignore your own flat line), far helpers walk there; moving away or disconnecting changes nothing, only a new `flat`/`stop`. `flat <r> <x> <z>` (tpd1) still works (level = your feet if the main bot sees you, else the mode). Helpers are flat-only (refuse follow/work, park after `flat done`). Helpers keep the server occupied on a hidden-sample ping — clear `BOT_SWARM_N` after the job
  - `BRIDGE_HOST`/`BRIDGE_PORT`/`BRIDGE_CONSOLE_PORT`: bridge addresses (defaults `body2`/`7778`/`7777`, pinned on bot2)
  - `BRAIN_TICK_MS`: Reflex loop interval (default `1000`)
  - `BRAIN_URL`: retired (idkcraft-vhlb.5) — ignored with a log line; the FSM decides every tick and the laya/JEV tick ask is gone (A/B vhlb.1: no gain). The laya sidecar left the stack in idkcraft-jlda.6 (default empty = stub); manual chat `brain laya|jev` still opts in
  - `BRAIN_TIMEOUT_MS`: Per-call deadline for the remote brain (default `3000`)
  - `BOT_LEAVE_AFTER_MS`: Nobody-online grace in ms before the bot quits and re-polls the server ping (default `60000`; `0` = always on)
  - `BOT_AUTONOMOUS`: stay and work with nobody online (`1`|`true`|`yes`; `on` is NOT accepted; default empty = off; chat `autonomous on` lasts until restart)
  - `TYPESAFE_API_KEY`: JEV secret; enables only the stall-point plan() (and manual `brain jev`)
  - `ANTHROPIC_API_KEY`: opt-in LLM stall-point planner (watchdog `plan()` only, never per tick); empty = today's planner
  - `PLANNER`: `llm` | `jev` (default `llm` when `ANTHROPIC_API_KEY` is set, else `jev`)
  - `LLM_MODEL`: LLM planner model (default `claude-haiku-5-5`)
  - `GOAL_WATCHDOG_MS`: Goal-metric flat window in ms before a fast JEV round fires (default `60000`; `0` = watchdog off, the shipped 15/45-min ladder)
  - `GOAL_COMMIT_MS`: Bounded commitment window in ms for a watchdog choice (default `120000`)
  - `GOAL_WATCHDOG_MAX_ROUNDS`: Consecutive flat rounds before park/plan-B (default `6`)
  - `GOAL_TRAVEL_GRACE_MS`: Rate-limit floor for the castlefetch travel grace (default `90000`)
  - `GOAL_PLANB_SWITCH_MS`: Plan-B goal-switch duration in ms when nobody is online (default `450000`)
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

## Review (revmux)

- One command, run from the branch's worktree: `.revmux/review.sh <bead> 01-review` — privacy pre-check,
  profile pick, scope/goal from the bead, archive in the MAIN checkout's `.revmux/tasks/` (a worktree's
  archive dies with the worktree), prints critical/major only, exit 1 while any is open.
- Profile is picked from the diff: `idkcraft-risky` (two agents, synthesis on) when it touches
  `bot/src/index.js`, `goal.js`, `brain.js`, `body.js` (`movementsFor`, the Movements write site),
  `behaviours/recover.js`, `follow.js`, the pathfinder
  customisations (`jumpcost.js`, `nocorner.js`, `swim.js`, `snow.js`), the packet taps (`unpin.js`,
  `decontact.js`, `detour.js`), any `Movements` setting elsewhere (an added `bot/src/` line naming
  `scafoldingBlocks`, `canDig`, `allow1by1towers`, `allowParkour`, `blocksCantBreak`, `exclusionAreas`,
  `canOpenDoors`, `allowSprinting` or `Movements`) or `laya/`; else `idkcraft`
  (one agent, `--no-synthesis`). Check a pick: `git diff --no-ext-diff origin/master...HEAD | sh .revmux/review.sh --pick`. Compose/Dockerfile/CI/env/.revmux-only diffs get `--lenses tests` automatically
  (`LENSES=` overrides).
- Risky files: the review archive is **mandatory** for merge.
- Stuck oracle (idkcraft-6x7.4), **batched** (owner 2026-10-03): PRs do NOT run
  `sh bot/tools/stuck-run.sh` and do not add spots — the rig run is too slow per PR. After a batch
  of risky merges (default: every 3, or before an owner play session) one `stuck-run.sh` runs on
  `master`, judged against `stuck-baseline.json`; exit 1 (regression) → bisect within the batch
  and file a P1 bead; exit 2 is an environment failure, fix the rig, not the code. The script
  holds its own rig lock (busy = exit 2; `RIG_LOCK_WAIT=<secs>` to wait). Accepted risk: a
  regression can reach prod before its batch run. A movement PR lists its prod coords in the PR
  body; a batch task adds them to `bot/tools/stuck-spots.json` (with `bead`) plus the measured
  entry in `bot/tools/stuck-baseline.json` — one without the other fails the gate or `npm test`.
  `STUCKRUN=<file>` stays optional for review rounds. Manual: `bot/tools/README.md`.
- v2 merge gate (owner 2026-10-15/16, throughput not stall spots): a PR touching v2 behaviour
  (`bot/src/bridge/*`, `baritone/*`, or a `BOT_BODY=baritone` branch in `bot/src`) quotes in the PR
  body the 10-game-min component rig verdict lines, before/after on equal settings, vs
  `bot/tools/component-baseline.json`: `CASTLE_COMPONENT=lay` and `CASTLE_COMPONENT=mine`
  (`CASTLE_BODY=baritone sh bot/tools/castle-rig.sh`, see `bot/tools/README.md` "Rig speed");
  OUTSIDE ±15% downward = regression. No `/tick rate` castle pair (>20 does not speed up v2).
  The full 90-min castle rig (`CASTLE_BODY=baritone sh bot/tools/castle-rig.sh 90`) is batched like
  the stuck oracle: every 3 v2 merges or before an owner play session, on `master`, judged vs a
  recorded baseline; regression -> bisect within the batch + P1 bead. House done-seconds + fail
  top-3 (`sh bot/tools/work-rig.sh 20`) and deaths per night (`castle-rig.sh --night`) stay
  optional verdicts. No new `failed:<reason>` string without a verdict line it moves.
  `REPLAY_BODY=baritone` stuck-run is a regression check only (not worse), never the reason to
  merge; v1 `stuck-run.sh` is unchanged and frozen (v1 is phased out). Stall-point beads
  (neuc.29/.31/.48/.49, umou, sfmk) are deferred "postponed: structural plan" until the
  mine/recover/build beads land.
- Rounds 2+ only after a critical/major was fixed: `PREV=<round-1 findings.json> REVIEWED_SHA=<sha>
  .revmux/review.sh <bead> 02-after-fix` (scope = the fix delta, one-agent `idkcraft` profile unless one is passed). Minors are fixed in the same commit
  and never trigger another round. Max 3 rounds (the script refuses a 4th); whatever is still gating is outstanding in the handoff.
- A livelock/pathing finding raised in two rounds or by both agents is never dropped or downgraded
  without a written reason (the ones that were came back as prod bugs: 3nt.19→ak4, ef3→9sq, 2bh→lzw).
- Privacy pre-check by hand (must print nothing):
  `git diff --no-ext-diff origin/master...HEAD | rg -n '^\+.*(\b\d{1,3}(\.\d{1,3}){3}\b|(api[_-]?key|secret|token)\s*[:=]\s*\S{8,})'`
