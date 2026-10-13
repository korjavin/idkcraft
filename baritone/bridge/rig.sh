#!/bin/sh
# idkcraft-kqzf spike rig (neuc.2: the rig-goto.js judge is deleted with the
# console backend; this now boots Paper + the offline client and HOLDS the
# rig up for manual/acceptance runs until neuc.5 brings the real harness).
# Slot z like baritone/run.sh (container idk-replay-z, port 25597, lock
# /tmp/idkcraft-rig.lock-z) but a distinct client name + bridge port so a
# concurrent run.sh never collides. Offline launch (no account), the v2 body
# image (client.sh default idkcraft-baritone:local, built from this tree):
#   sh baritone/bridge/rig.sh
# Env: BOT (default IdkBody), RIG_LOCK_WAIT (secs to wait on a busy slot-z
# lock instead of exiting 2), RIG_BIND (bind the bridge there instead of
# all interfaces), BARITONE_API (default 1: the bridge mod needs the API
# jar; standalone logs 'no Java API' and the ws never opens), MOD_PORT
# (mod ws publish, default 7830) / BRIDGE_PORT (console, default 7831) —
# slot z of stuck-run's per-slot body ports (7778/7779 + 2 x letter index),
# container idk-baritone-body-z (idkcraft-neuc.23: the old fixed name and
# 7779 collided with a stuck-run body on the default slot).
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
PRODWORLD="${PRODWORLD:-/Users/iv/Projects/.idkcraft-prodworld}"
RIG=idk-replay-z; PORT=25597; CLIENT=idk-baritone-body-z
LOCK="${RIG_LOCK:-/tmp/idkcraft-rig.lock}-z"
RIGDIR="$PRODWORLD/rigs/z"; D="$RIGDIR/replay-data/paper-base"
SRVFIFO="/tmp/kqzf-srv-$$.fifo"
LOG=/tmp/kqzf-rig.log

BOT="${BOT:-IdkBody}"
export BARITONE_CLIENT="$CLIENT" CLIENT_LOG="$LOG.client" RIG_CONTAINER="$RIG"
export BARITONE_OFFLINE="${BARITONE_OFFLINE:-1}" BOT="$BOT" BRIDGE_PORT="${BRIDGE_PORT:-7831}"
export BARITONE_API="${BARITONE_API:-1}" MOD_PORT="${MOD_PORT:-7830}"

if ! mkdir "$LOCK" 2>/dev/null; then
  WAIT="${RIG_LOCK_WAIT:-0}"
  waited=0
  while [ "$waited" -lt "$WAIT" ]; do sleep 5; waited=$((waited + 5)); mkdir "$LOCK" 2>/dev/null && break; done
  mkdir "$LOCK" 2>/dev/null || { echo "rig z busy ($LOCK)"; exit 2; }
fi
echo $$ > "$LOCK/pid"
cleanup() {
  [ "${WORKER_STARTED:-}" = 1 ] && sh "$HERE/../client.sh" stop >/dev/null 2>&1 || true
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
docker exec "$RIG" rcon-cli "op $BOT"
sh "$HERE/../client.sh" start "$PORT" "$BOT" || exit 2
WORKER_STARTED=1
# Held up for manual/acceptance runs (smoke.js, a hand-started bot):
# attach with BOT_BODY=baritone BRIDGE_HOST=localhost BRIDGE_PORT=$MOD_PORT
# BRIDGE_CONSOLE_PORT=$BRIDGE_PORT (the bot's BRIDGE_PORT is the mod RPC,
# not this script's console publish).
echo "rig z up: Paper :$PORT, client $BOT, mod ws :$MOD_PORT, console :$BRIDGE_PORT; Ctrl-C to stop"
while :; do sleep 60; done
