#!/bin/sh
# idkcraft-kqzf spike rig: ONE stuck spot through the adapter's console
# backend (setGoal -> `msg #goto` on the real client), judged over rcon.
# Slot z like baritone/run.sh (container idk-replay-z, port 25597, lock
# /tmp/idkcraft-rig.lock-z) but a distinct client name + bridge port so a
# concurrent run.sh never collides. Offline launch (no account):
#   BARITONE_IMAGE=idkcraft-baritone:spike sh baritone/bridge/rig.sh [SPOT]
# Env: GOTO_SPOT (default EP1), BOT (default IdkBody), RIG_LOCK_WAIT (secs
# to wait on a busy slot-z lock instead of exiting 2), RIG_BIND (bind the
# bridge there instead of all interfaces).
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
PRODWORLD="${PRODWORLD:-/Users/iv/Projects/.idkcraft-prodworld}"
RIG=idk-replay-z; PORT=25597; CLIENT=idk-baritone-body
LOCK="${RIG_LOCK:-/tmp/idkcraft-rig.lock}-z"
RIGDIR="$PRODWORLD/rigs/z"; D="$RIGDIR/replay-data/paper-base"
SRVFIFO="/tmp/kqzf-srv-$$.fifo"
LOG=/tmp/kqzf-rig.log

BOT="${BOT:-IdkBody}"
GOTO_SPOT="${1:-${GOTO_SPOT:-EP1}}"
export BARITONE_CLIENT="$CLIENT" CLIENT_LOG="$LOG.client" RIG_CONTAINER="$RIG"
export BARITONE_OFFLINE="${BARITONE_OFFLINE:-1}" BOT="$BOT" BRIDGE_PORT="${BRIDGE_PORT:-7779}"

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
GOTO_SPOT="$GOTO_SPOT" node "$HERE/rig-goto.js"
