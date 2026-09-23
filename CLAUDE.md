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
|  | 19132/udp (Bedrock)     |     | rule FSM + System-1 on hard states |  |
|  +-------------------------+     +-----------------------+  |
|                                                             |
|  +-----------------------------------------------------+    |
|  | laya                                                |    |
|  | CPU System-1 brain, JEV REST shape, port 8000       |    |
|  | (internal only, no published ports)                 |    |
|  +-----------------------------------------------------+    |
+-------------------------------------------------------------+
```

Bot architecture follows "one body, many senses": local perception (`bot/src/perception.js`) gathers facts every tick, the brain arbitrates body ownership (`fight` | `follow` | `idle`), and execution dispatches via `BEHAVIOURS` (`bot/src/behaviours/*.js`), while scouting runs alongside as a local reflex.

### Shared Contract (do not rename)
- **Services:** `mc`, `bot`, `laya`
- **Compose file:** `docker-compose.yml` at repository root
- **Bot build context:** `./bot`, `bot/Dockerfile`
- **Image:** `ghcr.io/korjavin/idkcraft:latest` (CI rewrites the tag to the commit SHA on the `deploy` branch)
- **Stack Environment Variables:**
  - `MC_VERSION`: Paper version pin
  - `MC_MEMORY`: RAM allocation (default `4G`)
  - `MC_JAVA_PORT`: Java listening port (`25565`)
  - `MC_BEDROCK_PORT`: Bedrock listening port (`19132`)
  - `MC_DATA_PATH`: Host bind-mount path (default `./data`)
  - `WHITELIST`: Comma-separated list (Bedrock players prefixed with `.`)
  - `OPS`: Comma-separated operators
  - `BOT_USERNAME`: Bot player name (default `IdkBot`)
  - `BOT_FOLLOW`: Target player to follow (empty = work mode until `follow me`)
  - `BRAIN_TICK_MS`: Reflex loop interval (default `1000`)
  - `BRAIN_URL`: Remote brain endpoint (default `http://laya:8000/v1/systemone`); hybrid (FSM primary, model on hard states only); empty = FSM only, the rollback; the sidecar needs no key
  - `BRAIN_TIMEOUT_MS`: Per-call deadline for the remote brain (default `3000`)
  - `METRICS_PORT`: Prometheus endpoint port (default `9464`; the sidecar serves `/metrics` on its API port; scraped by the house monitoring stack)
  - `BOT_LEAVE_AFTER_MS`: Nobody-online grace in ms before the bot quits and re-polls the server ping (default `60000`; `0` = always on)
  - `LAYA_MEM_LIMIT`: Sidecar container memory cap (default `3g`)
  - `TYPESAFE_API_KEY`: JEV secret; only used when `BRAIN_URL` points at JEV

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
- **Simplicity (Ponytail rules):**
  - Smallest diff that meets acceptance criteria, no speculative abstractions beyond the single brain interface.
  - Server runs `ONLINE_MODE=false` + `ENFORCE_WHITELIST=TRUE` in iteration 1 so the bot does not need a Microsoft account.
