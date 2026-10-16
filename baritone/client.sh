#!/bin/sh
# Baritone worker client launch (idkcraft-jlda.3, factored out of run.sh):
# launch the worker image with the bridge published, wait for the HMC
# console, connect it to a rig Paper, wait for the join — or stop it.
# Both rig harnesses call it: baritone/run.sh (slot z A/B) and
# bot/tools/stuck-run.sh (REPLAY_WORKER=1: the worker beside the head).
# Usage: sh client.sh start <mc-port> <bot-name> | stop
# Env: BARITONE_IMAGE (default idkcraft-baritone:<short hash of this
#   checkout's committed baritone/ tree>, built from baritone/ when missing
#   — the warm image, idkcraft-6x7.28; an explicit tag that is missing exits
#   2 with the build hint. idkcraft-neuc.23: the old spike default had no
#   mod, so a v2 run never connected),
#   BARITONE_CLIENT (container name, default idk-baritone-client),
#   BARITONE_OFFLINE=1 (offline username <bot-name>, no stored account),
#   BARITONE_API=1 (run the Baritone API jar instead of standalone — the v2
#   body path; the bridge mod needs baritone/api/**, which standalone strips),
#   BRIDGE_PORT (host publish of the in-container 7777, default 7777),
#   MOD_PORT (host publish of the in-container 7778, the Fabric bridge mod
#   ws; default unset = not published, so run.sh/REPLAY_WORKER are unchanged),
#   BARITONE_MEM (docker --memory for the client, e.g. 2500m = the compose
#   BODY2_MEM_LIMIT default, so the rig sees the cgroup the JVM sees in
#   prod; unset = unlimited, the old rig behaviour),
#   RIG_BIND (bind the bridge there instead of all interfaces),
#   CLIENT_LOG (container stdout, default /tmp/baritone-client.log),
#   RIG_CONTAINER (the rig Paper container, for the join wait — required
#   for start). Exits 2 on every environment failure (no account, client
#   never started, bot never joined).
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
# idkcraft-6x7.28: default tag = the committed baritone/ tree hash of THIS
# checkout (CI tags ghcr the same way), so a before (master) and an after
# (PR) worktree each get their own body, and trees that share baritone/
# share one image. Uncommitted baritone/ edits are not in the hash: commit
# them or pass BARITONE_IMAGE. No git = the old :local default.
TREE_TAG="$(git -C "$HERE" rev-parse --short=8 HEAD:baritone 2>/dev/null || true)"
IMAGE="${BARITONE_IMAGE:-idkcraft-baritone:${TREE_TAG:-local}}"
CLIENT="${BARITONE_CLIENT:-idk-baritone-client}"
BRIDGE_PORT="${BRIDGE_PORT:-7777}"
CLIENT_LOG="${CLIENT_LOG:-/tmp/baritone-client.log}"

cmd="${1:-}"
if [ "$cmd" = stop ]; then
  docker stop -t 5 "$CLIENT" >/dev/null 2>&1 || true
  exit 0
fi
[ "$cmd" = start ] || { echo "usage: sh client.sh start <mc-port> <bot-name> | stop"; exit 2; }
MC_PORT="${2:-}"
BOTNAME="${3:-}"
case "$MC_PORT" in ''|*[!0-9]*) echo "client.sh start: want a numeric <mc-port>, got '$MC_PORT'"; exit 2 ;; esac
[ -n "$BOTNAME" ] || { echo "client.sh start: want a <bot-name>"; exit 2; }
[ -n "${RIG_CONTAINER:-}" ] || { echo "client.sh start: RIG_CONTAINER is required (the rig Paper container)"; exit 2; }
case "${MOD_PORT:-}" in
  '') ;; # unset = the mod ws stays unpublished (run.sh/REPLAY_WORKER)
  *[!0-9]*) echo "client.sh start: want a numeric MOD_PORT, got '$MOD_PORT'"; exit 2 ;;
esac

if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  if [ -n "${BARITONE_IMAGE:-}" ] || [ -z "$TREE_TAG" ]; then
    echo "client.sh start: no image $IMAGE — docker build -t $IMAGE baritone (or BARITONE_IMAGE=<tag>)"; exit 2
  fi
  # a dirty tree would cache edits under the committed hash's tag
  [ -z "$(git -C "$HERE" status --porcelain -- . 2>/dev/null)" ] || {
    echo "client.sh start: baritone/ has uncommitted edits — commit them or BARITONE_IMAGE=<tag>"; exit 2; }
  echo "client.sh: building $IMAGE (warm body, once per baritone/ tree)"
  docker build -t "$IMAGE" "$HERE" || { echo "client.sh start: docker build $IMAGE failed"; exit 2; }
fi

# Account gate (run.sh, unchanged): the client launches with the account
# stored in the idkcraft-baritone-auth volume (one-time `login`), or
# offline ONLY when the owner opted in (the stuck-run worker path forces
# BARITONE_OFFLINE=1: the worker is offline under its own name, jlda Q2).
# Offline mounts NO auth volume: a stored account shadows the -offline
# launch (the client joins as the stored profile, not <bot-name>).
AUTH_VOL="-v idkcraft-baritone-auth:/headlessmc/HeadlessMC/auth"
OFFLINE_ENV=
if [ "${BARITONE_OFFLINE:-}" = 1 ]; then
  OFFLINE_ENV="-e BARITONE_OFFLINE=1 -e BOT=$BOTNAME"
  AUTH_VOL=
elif ! docker run --rm $AUTH_VOL --entrypoint test "$IMAGE" -s /headlessmc/HeadlessMC/auth/.accounts.json; then
  echo "no stored account: run the one-time login (baritone/README.md) or opt in with BARITONE_OFFLINE=1"; exit 2
fi
API_ENV=
if [ "${BARITONE_API:-}" = 1 ]; then
  API_ENV="-e BARITONE_API=1"
fi

if docker ps --format '{{.Names}}' 2>/dev/null | grep -qx "$CLIENT"; then
  echo "$CLIENT already running — one worker client per box (BARITONE_CLIENT=... for another)"; exit 2
fi

# The image's own entrypoint (start.sh) — HMC console on its in-container
# FIFO, bridge published for the rig, so the rig exercises the exact prod
# plumbing. Plain -p by default: a literal loopback IP trips the privacy
# pre-check, and the rig's Paper+rcon already publish the same way.
# RIG_BIND=<loopback address> binds the bridge there instead.
# Container stdout = the client log ($CLIENT_LOG).
MOD_PUBLISH=
if [ -n "${MOD_PORT:-}" ]; then
  MOD_PUBLISH="-p ${RIG_BIND:+$RIG_BIND:}$MOD_PORT:7778"
fi
docker run --rm --name "$CLIENT" ${BARITONE_MEM:+--memory $BARITONE_MEM} $AUTH_VOL \
  $OFFLINE_ENV $API_ENV $MOD_PUBLISH -p "${RIG_BIND:+$RIG_BIND:}$BRIDGE_PORT:7777" "$IMAGE" >"$CLIENT_LOG" 2>&1 &
bridge_send() { # one console line via the bridge (ab.js speaks TCP; POSIX sh cannot)
  node -e "require(process.argv[1]).sendBridgeLine({host:'localhost',port:+process.argv[2],line:process.argv[3]}).then(()=>{},(e)=>{console.error('bridge:',e.message);process.exit(1)})" "$HERE/ab.js" "$BRIDGE_PORT" "$1"
}
printf "wait: client console"
for _ in $(seq 1 60); do docker logs "$CLIENT" 2>/dev/null | grep -q "HMC-Specifics initialized" && break; printf .; sleep 3; done
# Past the guard the name is ours (sequential launches; parallel same-name
# launches are unsupported), so a failed start stops what it launched —
# callers stop only after a successful start (their WORKER_STARTED).
docker logs "$CLIENT" 2>/dev/null | grep -q "HMC-Specifics initialized" || { echo " client never started ($CLIENT_LOG)"; docker stop -t 5 "$CLIENT" >/dev/null 2>&1 || true; exit 2; }
printf " up; wait: client joins"
JOINED=
for i in $(seq 0 23); do
  # one connect per 30 s: a connect resent mid-login restarts the handshake.
  # A dead bridge fails the start (it owns the join) and stops the launched
  # client — a bare bridge_send here would exit under set -e and leak it.
  if [ $((i % 6)) = 0 ]; then
    bridge_send "connect host.docker.internal $MC_PORT" || { echo " bridge send failed ($CLIENT_LOG)"; docker stop -t 5 "$CLIENT" >/dev/null 2>&1 || true; exit 2; }
  fi
  sleep 5
  docker exec "$RIG_CONTAINER" rcon-cli list 2>/dev/null | grep -qw "$BOTNAME" && { JOINED=1; break; }
  printf .
done
[ -n "$JOINED" ] || { echo " $BOTNAME never joined ($CLIENT_LOG; with a stored account set BOT=<profile name>)"; docker stop -t 5 "$CLIENT" >/dev/null 2>&1 || true; exit 2; }
echo " $BOTNAME"
