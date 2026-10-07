#!/bin/sh
# CASTLE-RIG (idkcraft-vmzq.20): unattended-build throughput harness — reset
# a disposable world copy, boot Paper, flatten a pad, order `build castle`
# with an empty kit, run N minutes, print ONE verdict line:
#   castle <laid>/<total> in <min> min, flips=<n>, deaths=<n>, top-steps=<...>, top-fail=<...>
# Usage: sh castle-rig.sh [mins]   (default 6; CASTLE_MINS also works;
#   gate runs pass 30+ explicitly)
# Env: PRODWORLD (default /Users/iv/Projects/.idkcraft-prodworld),
#   CASTLE_RIG_ID (''/0 default, a-z, or auto over CASTLE_SLOTS "0 a b"),
#   CASTLE_LOCK (default /tmp/idkcraft-castle-rig.lock), CASTLE_LOCK_WAIT,
#   CASTLE_TAG, CASTLE_PAD ("x,z"), CASTLE_OUT, CASTLE_LOG, CASTLE_DAYLOCK=0
#   to run the natural day/night cycle instead of locked day,
#   CASTLE_KIT (empty|seeded — seeded pre-fills cobble/planks/tools so a
#   6-min window measures laying, not fetching),
#   CASTLE_TICKRATE (1 = wall-clock game; N > 1 runs /tick rate N for fast
#   iteration — gates always run at 1).
# Exit: 0 = measured (even 0 laid — the line says so),
#   2 = environment/setup failure, 130 = interrupted (never a pass).
# The pristine snapshot (world/world.tar) is only ever READ (tar -xf); a
# sha move fails the run (exit 2) so runs stay comparable. No /tick
# acceleration by design: the bot ticks on wall-clock seconds, so a faster
# game clock would distort physics timing without speeding decisions.
# One castle run per rig (own containers/ports/locks, so a castle run and a
# stuck run can share the box): container idk-castle[-<id>], host port
# 25581 + letter index (a=25582, b=25583), data under
# $PRODWORLD/castle-rigs/<id>/ (seeded once from replay-data/paper-base
# minus world/ and logs/; rm -rf it to reseed).
set -e
LOCKBASE="${CASTLE_LOCK:-/tmp/idkcraft-castle-rig.lock}"
RIG_ID="${CASTLE_RIG_ID:-}"
[ "$RIG_ID" = 0 ] && RIG_ID=
RIG_LOCK="$LOCKBASE${RIG_ID:+-$RIG_ID}"
rig_release() { # only ever remove a lock this process wrote
  [ "$(cat "$RIG_LOCK/pid" 2>/dev/null)" = "$$" ] && rm -rf "$RIG_LOCK"
  return 0
}
rig_try() { # $1 = lock dir; 0 = taken (a dead holder's lock is reclaimed)
  mkdir "$1" 2>/dev/null && return 0
  _hp="$(cat "$1/pid" 2>/dev/null || true)"
  if [ -n "$_hp" ] && ! kill -0 "$_hp" 2>/dev/null; then
    echo "rig lock: stale (holder pid $_hp dead) — reclaiming"
    mv "$1" "$1.stale.$$" 2>/dev/null && rm -rf "$1.stale.$$"
    mkdir "$1" 2>/dev/null && return 0
  fi
  return 1
}
if [ "${RIG_LOCK_HELD:-}" != 1 ]; then
  _auto=; if [ "$RIG_ID" = auto ]; then _auto=1; _slots="${CASTLE_SLOTS:-0 a b}"; else _slots="${RIG_ID:-0}"; fi
  _waited=0
  while :; do
    for _s in $_slots; do
      [ "$_s" = 0 ] && _s=
      RIG_ID="$_s"; RIG_LOCK="$LOCKBASE${RIG_ID:+-$RIG_ID}"
      rig_try "$RIG_LOCK" || continue
      if [ -n "$_auto" ] && docker ps --format '{{.Names}}' 2>/dev/null | grep -qx "idk-castle${_s:+-$_s}"; then
        echo "rig ${_s:-0}: idk-castle${_s:+-$_s} still running without a lock — next slot"
        rmdir "$RIG_LOCK"; continue
      fi
      break 2
    done
    if [ "$_waited" -ge "${CASTLE_LOCK_WAIT:-0}" ]; then
      echo "rig busy: $RIG_LOCK held by pid ${_hp:-?} (slots: $_slots) — one run per rig (CASTLE_LOCK_WAIT=<secs> to wait, CASTLE_RIG_ID=auto|<a-z> for another rig)"; exit 2
    fi
    sleep 5; _waited=$((_waited + 5))
  done
  echo $$ > "$RIG_LOCK/pid"
  trap rig_release EXIT
  trap 'exit 130' INT TERM
elif [ "$RIG_ID" = auto ]; then
  echo "RIG_LOCK_HELD=1 needs a concrete CASTLE_RIG_ID, not auto"; exit 2
fi
case "$RIG_ID" in ''|[a-z]) ;; *) echo "CASTLE_RIG_ID must be one letter a-z, 0 or auto (got '$RIG_ID')"; exit 2 ;; esac
MINS="${1:-${CASTLE_MINS:-6}}"
case "$MINS" in ''|*[!0-9]*) echo "mins: want a positive integer, got '$MINS'"; exit 2 ;; esac
[ "$MINS" -ge 1 ] || { echo "mins: want a positive integer, got '$MINS'"; exit 2; }
KIT="${CASTLE_KIT:-empty}"
case "$KIT" in empty|seeded) ;; *) echo "CASTLE_KIT: want empty|seeded, got '$KIT'"; exit 2 ;; esac
TICKRATE="${CASTLE_TICKRATE:-1}"
case "$TICKRATE" in ''|*[!0-9]*) echo "tickrate: want an integer 1..100, got '$TICKRATE'"; exit 2 ;; esac
{ [ "$TICKRATE" -ge 1 ] && [ "$TICKRATE" -le 100 ]; } || { echo "tickrate: want an integer 1..100, got '$TICKRATE'"; exit 2; }
PRODWORLD="${PRODWORLD:-/Users/iv/Projects/.idkcraft-prodworld}"
HERE="$(dirname "$0")"
TREE="$(cd "$HERE/../.." && pwd)"
VARIANT="paper-base"
SRC="$PRODWORLD/replay-data/$VARIANT"
[ -x "$PRODWORLD/START.sh" ] || { echo "no START.sh in $PRODWORLD"; exit 2; }
[ -d "$SRC/world" ] || { echo "no snapshot at $SRC"; exit 2; }
[ -f "$PRODWORLD/world.tar" ] || { echo "no world.tar in $PRODWORLD"; exit 2; }
CONTAINER="idk-castle${RIG_ID:+-$RIG_ID}"
RIG_PORT=25581
RIGDIR="$PRODWORLD/castle-rigs/0"
if [ -n "$RIG_ID" ]; then
  RIG_PORT=$((25581 + $(printf '%d' "'$RIG_ID") - 96))
  RIGDIR="$PRODWORLD/castle-rigs/$RIG_ID"
fi
if [ ! -d "$RIGDIR/replay-data/$VARIANT" ]; then
  echo "seed: $RIGDIR/replay-data/$VARIANT <- $SRC (minus world/, logs/)"
  mkdir -p "$RIGDIR/replay-data"
  rm -rf "$RIGDIR/replay-data/.$VARIANT.tmp"
  rsync -a --exclude /world --exclude /logs "$SRC/" "$RIGDIR/replay-data/.$VARIANT.tmp/"
  mv "$RIGDIR/replay-data/.$VARIANT.tmp" "$RIGDIR/replay-data/$VARIANT"
fi
sed -e "s/--name idk-replay /--name $CONTAINER /" -e "s/-p 25571:/-p $RIG_PORT:/" "$PRODWORLD/START.sh" > "$RIGDIR/START.sh"
grep -q -- "--name $CONTAINER " "$RIGDIR/START.sh" && grep -q -- "-p $RIG_PORT:" "$RIGDIR/START.sh" \
  || { echo "START.sh no longer has '--name idk-replay ' / '-p 25571:' — cannot derive rig ${RIG_ID:-0}"; exit 2; }
D="$RIGDIR/replay-data/$VARIANT"
echo "rig ${RIG_ID:-0}: container $CONTAINER, port $RIG_PORT, data $D"
if docker ps --format '{{.Names}}' | grep -qx "$CONTAINER"; then
  echo "$CONTAINER already running — one run per rig"; exit 2
fi
sha_of() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'; else shasum -a 256 "$1" | awk '{print $1}'; fi; }
SHA_BEFORE="$(sha_of "$PRODWORLD/world.tar")"
GITSHA="$(git -C "$TREE" rev-parse --short HEAD 2>/dev/null || echo '?')"
LOG="/tmp/castle-run-${RIG_ID:-0}.log"
: > "$LOG"
FIFO="/tmp/castle-stdin-$$.fifo"
SRVPID=
teardown() {
  docker stop -t 5 "$CONTAINER" >/dev/null 2>&1 || true
  if [ -n "$SRVPID" ]; then kill "$SRVPID" >/dev/null 2>&1 || true; wait "$SRVPID" 2>/dev/null || true; fi
  SRVPID=
  exec 9<&- || true
  rm -f "$FIFO" || true
}
on_exit() {
  rc=$?
  teardown
  rig_release
  SHA_AFTER="$(sha_of "$PRODWORLD/world.tar")"
  if [ "$SHA_AFTER" = "$SHA_BEFORE" ]; then
    echo "pristine world.tar untouched ($SHA_AFTER)"
    exit "$rc"
  else
    echo "PRISTINE world.tar CHANGED: $SHA_BEFORE -> $SHA_AFTER"
    exit 2
  fi
}
on_sig() {
  teardown
  echo "interrupted"
  exit 130
}
trap on_exit EXIT
trap on_sig INT TERM
rcon_assert() { # $1 = command; fails the run unless rcon accepts it
  _out=$(docker exec "$CONTAINER" rcon-cli "$1" 2>&1) || { echo "ANTI-NOISE FAILED [$1]: $_out"; exit 2; }
  case "$_out" in
    *Incorrect*|*Unknown*|*incomplete*|*No\ entity*) echo "ANTI-NOISE REJECTED [$1]: $(printf '%s' "$_out" | head -n 1)"; exit 2 ;;
  esac
  echo "anti-noise [$1]: $(printf '%s' "$_out" | head -n 1)"
}
_ptail=$(( $$ % 1000 ))
export CASTLE_TAG="${CASTLE_TAG:-c$_ptail}"
boot() {
  echo "reset: $D/world <- world.tar"
  rm -rf "$D/world"
  tar -xf "$PRODWORLD/world.tar" -C "$D"
  echo "boot: $VARIANT (log $LOG)"
  mkfifo "$FIFO"
  exec 9<> "$FIFO"
  sh "$RIGDIR/START.sh" "$VARIANT" >>"$LOG" 2>&1 <&9 &
  SRVPID=$!
  echo -n "wait: rcon"
  for _ in $(seq 1 36); do
    if docker exec "$CONTAINER" rcon-cli "list" >/dev/null 2>&1; then echo " up"; break; fi
    echo -n "."; sleep 5
  done
  docker exec "$CONTAINER" rcon-cli "list" >/dev/null 2>&1 || { echo " rig never came up (see $LOG)"; exit 2; }
  rcon_assert "difficulty peaceful"
  rcon_assert "gamerule fall_damage false"
  rcon_assert "gamerule advance_weather false"
  rcon_assert "gamerule keep_inventory true"
  rcon_assert "weather clear"
  if [ "${CASTLE_DAYLOCK:-1}" != 0 ]; then
    if _out=$(docker exec "$CONTAINER" rcon-cli "gamerule advance_time false" 2>&1) && \
       case "$_out" in *Incorrect*|*Unknown*|*incomplete*) false ;; *) true ;; esac; then
      echo "anti-noise [gamerule advance_time false]: $(printf '%s' "$_out" | head -n 1)"
    else
      rcon_assert "gamerule do_daylight_cycle false"
    fi
    rcon_assert "time set 1000"
  fi
  if [ "$TICKRATE" != 1 ]; then
    # Accelerator, not regime: a Paper that rejects /tick runs on at wall
    # clock with a loud line (never a silent confound, never a failed run).
    if _out=$(docker exec "$CONTAINER" rcon-cli "tick rate $TICKRATE" 2>&1) && \
       case "$_out" in *Incorrect*|*Unknown*|*incomplete*) false ;; *) true ;; esac; then
      echo "tickrate [$TICKRATE]: $(printf '%s' "$_out" | head -n 1)"
    else
      echo "tickrate [$TICKRATE] REJECTED, running at wall clock: $(printf '%s' "${_out:-?}" | head -n 1)"
      TICKRATE=1
    fi
  fi
  rcon_assert "op CastleGuide$CASTLE_TAG"
  rcon_assert "op CastleBuild$CASTLE_TAG"
}
boot
export CASTLE_MINS="$MINS" CASTLE_CONTAINER="$CONTAINER" CASTLE_PORT="$RIG_PORT" CASTLE_GITSHA="$GITSHA"
export CASTLE_KIT="$KIT" CASTLE_TICKRATE="$TICKRATE"
# Absolute: node runs from bot/ after the cd below, so a relative default
# would point at bot/bot/tools/ and every checkpoint would throw.
case "${CASTLE_OUT:-}" in
  /*) ;;
  '') CASTLE_OUT="$TREE/bot/tools/last-castle.json" ;;
  *) CASTLE_OUT="$(cd "$HERE/.." && pwd)/tools/$CASTLE_OUT" ;;
esac
export CASTLE_OUT
export BOT_MEMORY_FILE="${BOT_MEMORY_FILE:-/tmp/castle-mem-${RIG_ID:-0}.json}"
rm -f "$BOT_MEMORY_FILE"
cd "$HERE/.."
# Tee: the verdict must survive on disk even if the caller only keeps a
# tail (or the pipe dies with the run). pipefail keeps node's exit code.
RIGOUT="/tmp/castle-rig-out-${RIG_ID:-0}.log"
: > "$RIGOUT"
set -o pipefail 2>/dev/null || true
node tools/castle-replay.js 2>&1 | tee -a "$RIGOUT"
