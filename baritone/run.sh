#!/bin/sh
# Baritone A/B run (idkcraft-vhlb.6, prod plumbing since jlda.1): reset a
# private rig world from the pristine world.tar, boot Paper (rig slot z:
# container idk-replay-z, port 25597, lock /tmp/idkcraft-rig.lock-z — never
# collides with stuck-run's default/auto slots 0 a b), launch the Baritone
# client via the image's own entrypoint with the bridge published for the
# rig, run ab.js through the bridge, tear down.
# Usage: sh baritone/run.sh            (image: docker build -t idkcraft-baritone:local baritone)
# Account (see baritone/README.md): the client launches with the account stored
# in the idkcraft-baritone-auth volume (one-time `login`), or offline ONLY when
# the owner opted in with BARITONE_OFFLINE=1.
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
PRODWORLD="${PRODWORLD:-/Users/iv/Projects/.idkcraft-prodworld}"
RIG=idk-replay-z; PORT=25597; CLIENT=idk-baritone-client
LOCK="${RIG_LOCK:-/tmp/idkcraft-rig.lock}-z"
RIGDIR="$PRODWORLD/rigs/z"; D="$RIGDIR/replay-data/paper-base"
SRVFIFO="/tmp/baritone-srv-$$.fifo"
LOG=/tmp/baritone-run.log

BOT="${BOT:-BaritoneBot}" # with a stored account: the profile name (pre-opped below)
export BARITONE_CLIENT="$CLIENT" CLIENT_LOG="$LOG.client" RIG_CONTAINER="$RIG"

mkdir "$LOCK" 2>/dev/null || { echo "rig z busy ($LOCK)"; exit 2; }
echo $$ > "$LOCK/pid"
STATS=
cleanup() {
  [ -n "$STATS" ] && kill "$STATS" 2>/dev/null
  # Only our own client (a failed start cleans itself; an early exit must
  # never stop another run's worker).
  [ "${WORKER_STARTED:-}" = 1 ] && sh "$HERE/client.sh" stop >/dev/null 2>&1 || true
  docker stop -t 5 "$RIG" >/dev/null 2>&1 || true
  exec 9<&- || true
  rm -f "$SRVFIFO"; rm -rf "$LOCK"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

if [ ! -d "$D" ]; then
  mkdir -p "$RIGDIR/replay-data"
  rsync -a --exclude /world --exclude /logs "$PRODWORLD/replay-data/paper-base/" "$D/"
fi
sed -e "s/--name idk-replay /--name $RIG /" -e "s/-p 25571:/-p $PORT:/" "$PRODWORLD/START.sh" > "$RIGDIR/START.sh"
rm -rf "$D/world"; tar -xf "$PRODWORLD/world.tar" -C "$D"
: > "$LOG"
mkfifo "$SRVFIFO"
exec 9<> "$SRVFIFO" # held open: an EOF on stdin kills Paper
sh "$RIGDIR/START.sh" paper-base >>"$LOG" 2>&1 <&9 &
printf "wait: rcon"
for _ in $(seq 1 36); do docker exec "$RIG" rcon-cli list >/dev/null 2>&1 && break; printf .; sleep 5; done
docker exec "$RIG" rcon-cli list >/dev/null 2>&1 || { echo " rig never came up ($LOG)"; exit 2; }
echo " up"
for c in "difficulty peaceful" "gamerule fall_damage false" "gamerule advance_weather false" "weather clear"; do
  docker exec "$RIG" rcon-cli "$c"
done
# Pre-op before login: Paper's spawn protection (15 of 16 spots sit inside it)
# is decided at login, a later op does not lift it (stuck-run.sh, 3ro).
docker exec "$RIG" rcon-cli "op $BOT"

# Client (client.sh: launch, HMC console wait, connect, join wait — exit 2
# when the bot never joins). RIG_CONTAINER/BARITONE_CLIENT/CLIENT_LOG are
# exported above; BARITONE_OFFLINE/BARITONE_IMAGE/BRIDGE_PORT/RIG_BIND pass
# through from the environment.
sh "$HERE/client.sh" start "$PORT" "$BOT" || exit 2
WORKER_STARTED=1 # the client is ours to stop from here on (cleanup)
export BOT
# Cost of the second bot while it paths, not one idle sample after the run.
docker stats --format '{{.Name}} cpu={{.CPUPerc}} mem={{.MemUsage}}' "$CLIENT" "$RIG" > "$LOG.stats" 2>&1 &
STATS=$!
node "$HERE/ab.js"
echo "client/rig cpu+mem samples: $LOG.stats (take max/mean per container)"
