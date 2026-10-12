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

## Running it

A real client needs a Minecraft Java licence. `run.sh` refuses (exit 2) until one of:

1. **Owner account (~5 min once):** device-code login, stored in a
   local docker volume (never in the repo):
   `docker run --rm -it -v idkcraft-baritone-auth:/headlessmc/HeadlessMC/auth idkcraft-baritone:spike --command login`
   The server is `ONLINE_MODE=false`, so any owned profile joins; run with
   `BOT=<profile name>` so it is pre-opped (spawn protection) before login.
2. **Owner opt-in to offline** for this local test rig: `BARITONE_OFFLINE=1 sh baritone/run.sh`
   (not exercised: the owner account path was used).

Then: `docker build -t idkcraft-baritone:spike baritone && BOT=<profile name> sh baritone/run.sh`
(~7 min; works on arm64 under Docker, client log `/tmp/baritone-run.log.client`).

Headless gotchas (fixed in `run.sh`): the container has no TTY, so the
in-game JLine reader crashes the game at init unless forced dumb
(`-Dhmc.jvmargs=-Dhmc.jline.dumb=true`); `-commands` must NOT be passed
(it starts the runtime's own stdin reader, which then splits input with
hmc-specifics'); `connect` is sent only after `HMC-Specifics initialized`;
console `msg` sends quotes literally, so Baritone commands go unquoted
(`msg #goto x y z`). `connect host.docker.internal 25597` works from inside
the container.
