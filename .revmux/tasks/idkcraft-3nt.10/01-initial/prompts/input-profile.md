# idkcraft — project review profile

## What this is
A hobby Minecraft stack: Paper server (`mc`), a Node 22 mineflayer bot (`bot/src`), and a CPU
"System-1" brain sidecar (`laya/shim.py`, FastAPI-shaped REST). Deployed by GitOps to Portainer.
The owner treats it as a learning project: changes should be readable and explain themselves.

## What a real failure looks like
- The bot crash-loops, disconnects, or stops ticking (`BRAIN_TICK_MS` loop stalls, unhandled
  promise rejection, mineflayer event never handled).
- The bot spams the remote brain when no player is online (cost guard in README is deliberate).
- A behaviour steals the tick from another one (follow stops while scouting, fight never yields).
- Secrets, hostnames, domains or IPs land in the repo (privacy rule in CLAUDE.md) — **critical**.
- A change to `docker-compose.yml` service names, env var names or the `laya` REST shape breaks the
  deployed stack (shared contract in CLAUDE.md, "do not rename").

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
