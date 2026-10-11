# Baritone second-bot spike (idkcraft-vhlb.6)

An experiment, not a migration (see `docs/future-baritone.md`): a real
headless Minecraft client (HeadlessMc 2.10.0 + Fabric 0.19.5 + Baritone
v1.18.0, MC 26.1.2 = the rig Paper) replays the same stuck corpus as
`bot/tools/stuck-run.sh`, on its own rig slot, never prod.

| file | what |
|---|---|
| `Dockerfile` | Temurin 25 + HeadlessMc + Baritone + hmc-specifics (console `connect`/`msg`); jars pinned by sha256 |
| `run.sh` | rig slot `z` (container `idk-replay-z`, port 25597, lock `/tmp/idkcraft-rig.lock-z`): reset world from `world.tar`, boot Paper, launch the client, join, run `ab.js`, `docker stats`, tear down |
| `ab.js` | per spot: prep, tp, stuck-replay kit, `#goto` (or `#mine`) via the client console; judged over rcon (pos within 2.5 of goal, or raw_iron count); rows to `/private/tmp/baritone-ab.json` |
| `tasks.json` | the two owner failures: BED-60 (walk 60+ blocks through terrain), MINE-10 (10 iron from the surface) |
| `ab.test.js` | `node --test baritone/` |

## Status: built, not run — blocked on the client account

The image builds and installs Fabric for 26.1.2; Baritone and hmc-specifics
both declare 26.1.x. **The game was never launched**: a real client needs a
Minecraft Java licence. HeadlessMc allows offline accounts only for CI
tests, and the agent did not launch Mojang's client without the owner's
licence decision. `run.sh` refuses (exit 2) until one of:

1. **Owner account (cheapest, ~5 min once):** device-code login, stored in a
   local docker volume (never in the repo):
   `docker run --rm -it -v idkcraft-baritone-auth:/headlessmc/HeadlessMC/auth idkcraft-baritone:spike --command login`
   The server is `ONLINE_MODE=false`, so any owned profile joins.
2. **Owner opt-in to offline** for this local test rig: `BARITONE_OFFLINE=1 sh baritone/run.sh`.

Then: `docker build -t idkcraft-baritone:spike baritone && sh baritone/run.sh`
(~15 min: 16 spots ≤ 90 s + BED-60 240 s + MINE-10 600 s).

Unverified until the first launch: the `msg` console command reaching
Baritone's chat hook, `connect host.docker.internal 25597` from inside the
client container, `-Dhmc.offline.username` being honoured. The first run
proves or kills each of these in its log (`/tmp/baritone-run.log.client`).
