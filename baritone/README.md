# Baritone worker: a headless client beside the mineflayer head (idkcraft-jlda)

The worker is a real headless Minecraft client (HeadlessMc 2.10.0 + Fabric
0.19.5 + Baritone v1.18.0, MC 26.1.2 = the prod Paper) that takes the long
walks and the mining while the mineflayer bot keeps the head (brain, chat,
goals, items). Design: the jlda epic — the worker is a pilot fish, never a
hauler (Baritone has no inventory actions, so it only moves and the head
follows it).

Control = the write-only bridge: `start.sh` feeds a TCP line port into the
HMC console FIFO; whatever the head writes is typed into the console
(`connect`/`disconnect`, `msg #goto ...`). Baritone replies land in the
client stdout (`docker logs`) as `[CHAT] [Baritone] ...`. No HTTP, no
auto-connect (the head drives `connect mc 25565` / `disconnect`), no status
endpoint. With no stored account the container logs the login hint and
sleeps (default-off, no JVM, ~0 RAM).

| file | what |
|---|---|
| `Dockerfile` | Temurin 25 + HeadlessMc + Baritone + hmc-specifics (console `connect`/`msg`) + socat; jars pinned by sha256; entrypoint `start.sh` |
| `start.sh` | container entrypoint: login passthrough (`--command login`), account gate, client on a FIFO, socat bridge |
| `settings.txt` | Baritone presets baked into the run dir (`allowParkour` off — the head follows on foot; sprint stays default — `false` breaks doors, see the file) |
| `run.sh` | rig slot `z` (container `idk-replay-z`, port 25597, lock `/tmp/idkcraft-rig.lock-z`): reset world from `world.tar`, boot Paper, launch the image's own entrypoint with the bridge published for the rig, run `ab.js` through it, `docker stats`, tear down |
| `client.sh` | factored client launch (`start <mc-port> <bot-name>` \| `stop`): account gate, bridge publish, HMC console wait, connect + join wait — called by `run.sh` and by `stuck-run.sh` (`REPLAY_WORKER=1`) |
| `ab.js` | per spot: prep, tp, stuck-replay kit, `#goto` (or `#mine`) via the bridge; judged over rcon (pos within 2.5 of goal, or raw_iron count); rows to `/private/tmp/baritone-ab.json` |
| `tasks.json` | the two owner failures: BED-60 (walk 60+ blocks through terrain), MINE-10 (10 iron from the surface) |
| `ab.test.js` | `node --test baritone/` |

## Result (2026-10-12, n=2)

Follow corpus (16 spots): mineflayer 15 reached / 296 s, Baritone 14 / 233-245 s
(faster on most spots; fails DUGPIT-BARE — no water-bucket escape). Owner
failures: BED-60 reached in 16 s, MINE-10 10 iron in ~84 s. Client ~1.9 GiB,
CPU mean ~30 %. Table and recommendation: PR #446 and the bead notes.

## Prod: owner steps (one-time, never automated)

A real client needs a Minecraft Java licence. Three steps, all by hand:

1. **Account login** (device code, ~5 min once): on the prod host,
   `docker run --rm -it -v idkcraft-baritone-auth:/headlessmc/HeadlessMC/auth ghcr.io/korjavin/idkcraft-baritone:<tag> --command login`
   (`<tag>` = the baritone tree-hash sha CI wrote on the `deploy` branch).
   The auth volume name is FIXED in `docker-compose.yml`, so the login
   survives redeploys whatever the Portainer stack name is. The server is
   `ONLINE_MODE=false`, so any owned profile joins.
2. **Whitelist**: add the profile's OFFLINE uuid to `WHITELIST` (a name would
   resolve to an online UUID and be rejected — same recipe as the IdkBot
   comment in `docker-compose.yml`):
   `python3 -c 'import uuid,hashlib;print(uuid.UUID(bytes=hashlib.md5(b"OfflinePlayer:<profile>").digest(),version=3))'`
3. **Enable**: set `WORKER_NAME=<profile>` in the Portainer stack env,
   redeploy. Empty `WORKER_NAME` = worker off (the container sleeps at ~0
   RAM, the bot behaves exactly as today).

## Local rig

`run.sh` refuses (exit 2) until the client can launch with one of:

1. **Owner account:** device-code login into the local docker volume (never
   in the repo):
   `docker run --rm -it -v idkcraft-baritone-auth:/headlessmc/HeadlessMC/auth idkcraft-baritone:spike --command login`
   The server is `ONLINE_MODE=false`, so any owned profile joins; run with
   `BOT=<profile name>` so it is pre-opped (spawn protection) before login.
2. **Owner opt-in to offline** for this local test rig: `BARITONE_OFFLINE=1 sh baritone/run.sh`
   (exercised via the `REPLAY_WORKER=1` harness; offline mounts no auth
   volume — a stored account would shadow the offline name).

Then: `docker build -t idkcraft-baritone:spike baritone && BOT=<profile name> sh baritone/run.sh`
(~7 min; works on arm64 under Docker, client log `/tmp/baritone-run.log.client`).
The rig uses the image's own entrypoint and publishes the bridge for the rig
(`-p 7777:7777` — plain `-p` by default, since a literal loopback IP trips
the privacy pre-check and the rig's Paper+rcon already publish the same
way; `RIG_BIND=<loopback address>` binds it there instead); `ab.js` drives
the client through it, so the rig exercises the
exact prod plumbing — the client log shows the `[CHAT] [Baritone] > goto ...`
lines arriving via the port.

Headless gotchas (fixed in `start.sh`): the container has no TTY, so the
in-game JLine reader crashes the game at init unless forced dumb
(`-Dhmc.jvmargs=-Dhmc.jline.dumb=true`); `-commands` must NOT be passed
(it starts the runtime's own stdin reader, which then splits input with
hmc-specifics'); `connect` is sent only after `HMC-Specifics initialized`;
console `msg` sends quotes literally, so Baritone commands go unquoted
(`msg #goto x y z`). `connect host.docker.internal 25597` works from inside
the container.
