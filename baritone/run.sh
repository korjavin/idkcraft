#!/bin/sh
# Baritone A/B run (idkcraft-vhlb.6): reset a private rig world from the
# pristine world.tar, boot Paper (rig slot z: container idk-replay-z, port
# 25597, lock /tmp/idkcraft-rig.lock-z — never collides with stuck-run's
# default/auto slots 0 a b), launch the Baritone client, run ab.js, tear down.
# Usage: sh baritone/run.sh            (image: docker build -t idkcraft-baritone:spike baritone)
# Account (see baritone/README.md): the client launches with the account stored
# in the idkcraft-baritone-auth volume (one-time `login`), or offline ONLY when
# the owner opted in with BARITONE_OFFLINE=1.
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
PRODWORLD="${PRODWORLD:-/Users/iv/Projects/.idkcraft-prodworld}"
IMAGE="${BARITONE_IMAGE:-idkcraft-baritone:spike}"
RIG=idk-replay-z; PORT=25597; CLIENT=idk-baritone-client
LOCK="${RIG_LOCK:-/tmp/idkcraft-rig.lock}-z"
RIGDIR="$PRODWORLD/rigs/z"; D="$RIGDIR/replay-data/paper-base"
SRVFIFO="/tmp/baritone-srv-$$.fifo"; export CHAT_FIFO="/tmp/baritone-chat-$$.fifo"
LOG=/tmp/baritone-run.log

BOT="${BOT:-BaritoneBot}" # with a stored account: the profile name (pre-opped below)
HMC_PROPS=; HMC_OFFLINE=
if [ "${BARITONE_OFFLINE:-}" = 1 ]; then
  HMC_PROPS="-Dhmc.offline.username=$BOT"; HMC_OFFLINE=-offline
elif ! docker run --rm -v idkcraft-baritone-auth:/headlessmc/HeadlessMC/auth --entrypoint test "$IMAGE" -s /headlessmc/HeadlessMC/auth/.accounts.json; then
  echo "no stored account: run the one-time login (baritone/README.md) or opt in with BARITONE_OFFLINE=1"; exit 2
fi

mkdir "$LOCK" 2>/dev/null || { echo "rig z busy ($LOCK)"; exit 2; }
echo $$ > "$LOCK/pid"
STATS=
cleanup() {
  [ -n "$STATS" ] && kill "$STATS" 2>/dev/null
  docker stop -t 5 "$CLIENT" "$RIG" >/dev/null 2>&1 || true
  exec 8<&- 9<&- || true
  rm -f "$SRVFIFO" "$CHAT_FIFO"; rm -rf "$LOCK"
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
mkfifo "$SRVFIFO" "$CHAT_FIFO"
exec 9<> "$SRVFIFO" 8<> "$CHAT_FIFO" # held open: an EOF on stdin kills Paper / the HMC console
sh "$RIGDIR/START.sh" paper-base >>"$LOG" 2>&1 <&9 &
echo -n "wait: rcon"
for _ in $(seq 1 36); do docker exec "$RIG" rcon-cli list >/dev/null 2>&1 && break; echo -n .; sleep 5; done
docker exec "$RIG" rcon-cli list >/dev/null 2>&1 || { echo " rig never came up ($LOG)"; exit 2; }
echo " up"
for c in "difficulty peaceful" "gamerule fall_damage false" "gamerule advance_weather false" "weather clear"; do
  docker exec "$RIG" rcon-cli "$c"
done
# Pre-op before login: Paper's spawn protection (15 of 16 spots sit inside it)
# is decided at login, a later op does not lift it (stuck-run.sh, 3ro).
docker exec "$RIG" rcon-cli "op $BOT"

# Client: HMC console on stdin (the FIFO ab.js writes to); hmc-specifics `connect`.
docker run --rm -i --name "$CLIENT" -v idkcraft-baritone-auth:/headlessmc/HeadlessMC/auth \
  --entrypoint java "$IMAGE" $HMC_PROPS -jar headlessmc-launcher-wrapper.jar \
  --command launch fabric-loader-0.19.5-26.1.2 -lwjgl -commands $HMC_OFFLINE >>"$LOG.client" 2>&1 <&8 &
echo -n "wait: client joins"
JOINED=
for _ in $(seq 1 60); do
  sleep 5
  echo "connect host.docker.internal $PORT" > "$CHAT_FIFO" # retried only until the join
  docker exec "$RIG" rcon-cli list | grep -qw "$BOT" && { JOINED=1; break; }
  echo -n .
done
[ -n "$JOINED" ] || { echo " $BOT never joined ($LOG.client; with a stored account set BOT=<profile name>)"; exit 2; }
echo " $BOT"
export BOT RIG_CONTAINER="$RIG"
# Cost of the second bot while it paths, not one idle sample after the run.
docker stats --format '{{.Name}} cpu={{.CPUPerc}} mem={{.MemUsage}}' "$CLIENT" "$RIG" > "$LOG.stats" 2>&1 &
STATS=$!
node "$HERE/ab.js"
echo "client/rig cpu+mem samples: $LOG.stats (take max/mean per container)"
