# idkcraft — project review profile

## What this is
A hobby Minecraft stack: Paper server (`mc`), a Node 22 mineflayer bot (`bot/src`), and a CPU
"System-1" brain sidecar (`laya/shim.py`, FastAPI-shaped REST). Deployed by GitOps to Portainer.
The owner treats it as a learning project: changes should be readable and explain themselves.

## What a real failure looks like (from prod, 2026-09-22..24)
- The bot stands still forever while each tick re-decides the same step: failed step re-picked by the
  arbiter, stall counter that never reaches its limit, give-up that leaves the pathfinder goal set.
- State wrong after a mode switch or a one-tick preemption (fight/bring wiping gather/follow counters,
  `follow me` with the player out of tracking range treated as "nobody online").
- A shared `Movements` tweak for one behaviour breaking pathing for all of them.
- A new behaviour/env var/command that tests reach but prod never wires (`BEHAVIOURS`, compose).
- laya offered a long menu and always picking the same option.
- Secrets, hostnames, domains or IPs in the repo (privacy rule in CLAUDE.md) — **critical**.
- A renamed service, env var or `laya` REST field (shared contract in CLAUDE.md) — breaks the live stack.

## Blast radius
One private server, a handful of players. Wrong bot behaviour is annoying, not dangerous. A leaked
hostname or key is the one thing that cannot be taken back.

## Reporting bar
Report what breaks at runtime in the bot loop, in tests, or in the deploy contract. `npm test` in
`bot/` runs without a Minecraft client (fake-player harness) — a change that needs a live server to
be verified at all should say so, and a missing assertion for new branching logic is a finding.

## Deliberate conventions
- Ponytail rules: smallest diff, no speculative abstractions, one brain interface. A
  `// ponytail:` comment marks an intentional shortcut with its ceiling — not a finding.
- `ONLINE_MODE=false` + `ENFORCE_WHITELIST=TRUE`: intentional, the bot has no Microsoft account.
- Stub brain must keep working when `TYPESAFE_API_KEY` / brain URL is absent.
- Plain CommonJS, no TypeScript, no framework beyond mineflayer + its plugins.
