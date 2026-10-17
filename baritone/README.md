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
endpoint. With empty env and no stored account the container logs the login
hint and sleeps (default-off, no JVM, ~0 RAM); with `BARITONE_OFFLINE=1`
(compose, owner Q2) it launches offline under `WORKER_NAME` instead.

| file | what |
|---|---|
| `Dockerfile` | Temurin 25 + HeadlessMc + Baritone + hmc-specifics (console `connect`/`msg`) + socat; jars pinned by sha256; entrypoint `start.sh` |
| `start.sh` | container entrypoint: login passthrough (`--command login`), offline/account gate, client on a FIFO, socat bridge |
| `settings.txt` | Baritone presets baked into the run dir (`allowParkour` off — the head follows on foot; `chatControl` off — own status chat never runs as a command; sprint stays default — `false` breaks doors, see the file) |
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

## Prod: owner steps (env only, no login)

Owner decision 2026-10-12 (Q2): the worker launches OFFLINE under its own
name — no Java account, no device login. The server is `ONLINE_MODE=false`,
so an offline name joins like the bot does. Two steps, all by hand:

1. **Whitelist**: add the worker name's OFFLINE uuid to `WHITELIST` (a name
   would resolve to an online UUID and be rejected — same recipe as the
   IdkBot comment in `docker-compose.yml`):
   `python3 -c 'import uuid,hashlib;print(uuid.UUID(bytes=hashlib.md5(b"OfflinePlayer:<name>").digest(),version=3))'`
2. **Enable**: set `WORKER_NAME=<name>` and `BARITONE_OFFLINE=1` in the
   Portainer stack env, redeploy. The compose service passes the worker name
   from `WORKER_NAME` — the same env the bot reads — so the two never
   diverge. Empty `BARITONE_OFFLINE` = worker off (the container sleeps at
   ~0 RAM, the bot behaves exactly as today); `BARITONE_OFFLINE=1` without
   `WORKER_NAME` also sleeps — the offline launch needs a name.

Never run the `--command login` for prod: the auth volume stays empty — a
stored account would shadow the offline name (the client would join as the
stored profile, not `WORKER_NAME`).

## Body JVM args and the dig read (idkcraft-neuc.67)

`BODY_JVM_ARGS` (compose `body2`, the rig via `client.sh`) is appended to
the game JVM's `hmc.jvmargs` by `start.sh`; empty (the default, and always
on the worker) = the JVM as before: no `-Xmx`, max heap = 25% of the
cgroup (~626 MiB at `BODY2_MEM_LIMIT=2500m`). Example:
`BODY_JVM_ARGS=-XX:MaxRAMPercentage=60 -Xlog:gc:stdout` (~1.5 GiB heap, GC
pause lines in the container log).

The prod read needs no JVM tools (the JRE image has none): the bot2 log
carries `body.stats heap=<used>/<max>MB gc=<n>x<ms>ms maxTickGap=<ms>
maxPush=<ms> chunks=<n> entities=<n>` once a minute and
`dig slow <block> expect=<ms> ticks=<n> client=<ms> wall=<ms> rpc=<ms>`
for a dig past 1.3x its expected time (PROTOCOL.md, dig/place +
body.stats).

## Local rig

`run.sh` refuses (exit 2) until the client can launch with one of:

1. **Owner account:** device-code login into the local docker volume (never
   in the repo):
   `docker run --rm -it -v idkcraft-baritone-auth:/headlessmc/HeadlessMC/auth idkcraft-baritone:local --command login`
   The server is `ONLINE_MODE=false`, so any owned profile joins; run with
   `BOT=<profile name>` so it is pre-opped (spawn protection) before login.
2. **Owner opt-in to offline** for this local test rig: `BARITONE_OFFLINE=1 sh baritone/run.sh`
   (exercised via the `REPLAY_WORKER=1` harness; offline mounts no auth
   volume — a stored account would shadow the offline name).

Then: `BOT=<profile name> sh baritone/run.sh` (client.sh builds its image if missing)
(~7 min; works on arm64 under Docker, client log `/tmp/baritone-run.log.client`).
The image is warm (idkcraft-6x7.28): the build launches the client offline
once, so the libraries + assets are baked in and no launch downloads them.
Without `BARITONE_IMAGE`, `client.sh` uses (and builds if missing)
`idkcraft-baritone:<git rev-parse --short=8 HEAD:baritone>`.
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
