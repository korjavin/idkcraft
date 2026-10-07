#!/bin/sh
# CASTLE-RIG (idkcraft-vmzq.20): unattended-build throughput harness — reset
# a disposable world copy, boot Paper, flatten a pad, order `build castle`
# with an empty kit, run N minutes, print ONE verdict line:
#   castle <laid>/<total> in <min> min, flips=<n>, deaths=<n>, top-steps=<...>, top-fail=<...>
# Usage: sh castle-rig.sh [mins]   (default 6; CASTLE_MINS also works;
#   gate runs pass 30+ explicitly)
# Env: PRODWORLD (default /Users/iv/Projects/.idkcraft-prodworld),
#   CASTLE_RIG_ID (''/0 default, a-z, or auto over CASTLE_SLOTS "0 a b c"),
#   CASTLE_LOCK (default /tmp/idkcraft-castle-rig.lock), CASTLE_LOCK_WAIT,
#   CASTLE_TAG, CASTLE_PAD ("x,z"), CASTLE_OUT, CASTLE_LOG, CASTLE_DAYLOCK=0
#   to run the natural day/night cycle instead of locked day,
#   CASTLE_KIT (empty|seeded|junk — seeded pre-fills cobble/planks/tools so a
#   6-min window measures laying, not fetching; junk is vmzq.38's prod pack:
#   36/36 granite/diorite/andesite/sand/mob junk, no pickaxe, no cobble),
#   CASTLE_BLOCKED (0 = none; N > 0 seeds N blocked plan cells after the
#   order — protected oak logs + a foreign chest, vmzq.27's stall mix),
#   CASTLE_BURY / CASTLE_BURY_AFTER (vmzq.37: N > 0 buries the bot pickless
#   N below the pad after M min; the verdict adds surfaced/resumed seconds;
#   CASTLE_BURY_NOWOOD=1 also clears the wood: the hand staircase only),
#   CASTLE_TICKRATE (1 = wall-clock game untouched, the gate regime;
#   N > 1 runs /tick rate N — literal ticks/sec, 20 = normal, 60 = 3x,
#   100 = 5x — for fast iteration),
#   RIG_PLANNER (jev|stub, default jev — the real JEV; the key comes from
#   TYPESAFE_API_KEY or, when unset, the stash secrets/jev-api-key, never
#   printed), GOAL_WATCHDOG_MS / GOAL_COMMIT_MS (pass through when set),
#   CASTLE_INIT_MEMORY/CASTLE_MAX_MEMORY (JVM heap, default 512M/768M),
#   CASTLE_VIEW_DISTANCE/CASTLE_SIM_DISTANCE (default 6/4).
# Exit: 0 = measured (even 0 laid — the line says so),
#   2 = environment/setup failure, 130 = interrupted (never a pass).
# The pristine snapshot (world/world.tar) is only ever READ (tar -xf); a
# sha move fails the run (exit 2) so runs stay comparable. Acceleration
# caveat: the bot ticks on wall-clock seconds, so a faster game clock gives
# it more game-time per decision — gates run at 1; the max safe rate is
# measured in the vmzq.24 report, not assumed here.
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
  _auto=; if [ "$RIG_ID" = auto ]; then _auto=1; _slots="${CASTLE_SLOTS:-0 a b c}"; else _slots="${RIG_ID:-0}"; fi
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
case "$KIT" in empty|seeded|junk) ;; *) echo "CASTLE_KIT: want empty|seeded|junk, got '$KIT'"; exit 2 ;; esac
BLOCKED="${CASTLE_BLOCKED:-0}"
case "$BLOCKED" in ''|*[!0-9]*) echo "blocked: want an integer 0..16, got '$BLOCKED'"; exit 2 ;; esac
{ [ "$BLOCKED" -ge 0 ] && [ "$BLOCKED" -le 16 ]; } || { echo "blocked: want an integer 0..16, got '$BLOCKED'"; exit 2; }
TICKRATE="${CASTLE_TICKRATE:-1}"
case "$TICKRATE" in ''|*[!0-9]*) echo "tickrate: want an integer 1..100, got '$TICKRATE'"; exit 2 ;; esac
{ [ "$TICKRATE" -ge 1 ] && [ "$TICKRATE" -le 100 ]; } || { echo "tickrate: want an integer 1..100, got '$TICKRATE'"; exit 2; }
RIG_PLANNER="${RIG_PLANNER:-jev}"
case "$RIG_PLANNER" in jev|stub) ;; *) echo "RIG_PLANNER: want jev|stub, got '$RIG_PLANNER'"; exit 2 ;; esac
export RIG_PLANNER
if [ "$RIG_PLANNER" = jev ] && [ -z "${TYPESAFE_API_KEY:-}" ] && [ -x "$HOME/.local/bin/kv" ]; then
  # Stash fallback (idkcraft-vmzq.23): the key travels as env only — this
  # block prints nothing. A still-empty key fails below, before any
  # docker or world work (revmux 01 core-2); the replay keeps its own
  # check for direct invocations.
  TYPESAFE_API_KEY="$("$HOME/.local/bin/kv" get secrets/jev-api-key 2>/dev/null || true)"
  export TYPESAFE_API_KEY
fi
if [ "$RIG_PLANNER" = jev ] && [ -z "${TYPESAFE_API_KEY:-}" ]; then
  echo "RIG_PLANNER=jev needs TYPESAFE_API_KEY (stash secrets/jev-api-key)"; exit 2
fi
if [ -n "${GOAL_WATCHDOG_MS:-}" ]; then export GOAL_WATCHDOG_MS; fi
if [ -n "${GOAL_COMMIT_MS:-}" ]; then export GOAL_COMMIT_MS; fi
INIT_MEM="${CASTLE_INIT_MEMORY:-512M}"
MAX_MEM="${CASTLE_MAX_MEMORY:-768M}"
valid_mem() { _m="$1"; case "$_m" in *M|*G) _m="${_m%?}";; *) return 1;; esac; case "$_m" in ''|*[!0-9]*) return 1;; esac; }
valid_mem "$INIT_MEM" || { echo "memory: want <n>M|<n>G, got INIT '$INIT_MEM'"; exit 2; }
valid_mem "$MAX_MEM" || { echo "memory: want <n>M|<n>G, got MAX '$MAX_MEM'"; exit 2; }
mem_mb() { case "$1" in *G) echo $(( ${1%?} * 1024 ));; *) echo "${1%?}";; esac; }
{ [ "$(mem_mb "$INIT_MEM")" -gt 0 ] && [ "$(mem_mb "$INIT_MEM")" -le "$(mem_mb "$MAX_MEM")" ]; } || { echo "memory: INIT $INIT_MEM must be >0 and <= MAX $MAX_MEM"; exit 2; }
VIEW_DIST="${CASTLE_VIEW_DISTANCE:-6}"
SIM_DIST="${CASTLE_SIM_DISTANCE:-4}"
case "$VIEW_DIST" in ''|*[!0-9]*) echo "view-distance: want an integer 2..32, got '$VIEW_DIST'"; exit 2 ;; esac
{ [ "$VIEW_DIST" -ge 2 ] && [ "$VIEW_DIST" -le 32 ]; } || { echo "view-distance: want an integer 2..32, got '$VIEW_DIST'"; exit 2; }
case "$SIM_DIST" in ''|*[!0-9]*) echo "sim-distance: want an integer 2..32, got '$SIM_DIST'"; exit 2 ;; esac
{ [ "$SIM_DIST" -ge 2 ] && [ "$SIM_DIST" -le 32 ]; } || { echo "sim-distance: want an integer 2..32, got '$SIM_DIST'"; exit 2; }
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
sed -e "s/--name idk-replay /--name $CONTAINER /" -e "s/-p 25571:/-p $RIG_PORT:/" \
  -e "s/-e EULA=TRUE/-e EULA=TRUE -e INIT_MEMORY=$INIT_MEM -e MAX_MEMORY=$MAX_MEM/" \
  "$PRODWORLD/START.sh" > "$RIGDIR/START.sh"
grep -q -- "--name $CONTAINER " "$RIGDIR/START.sh" && grep -q -- "-p $RIG_PORT:" "$RIGDIR/START.sh" \
  && grep -q -- "MAX_MEMORY=$MAX_MEM" "$RIGDIR/START.sh" \
  || { echo "START.sh no longer has '--name idk-replay ' / '-p 25571:' / '-e EULA=TRUE' — cannot derive rig ${RIG_ID:-0}"; exit 2; }
D="$RIGDIR/replay-data/$VARIANT"
# Per-rig trim (idkcraft-vmzq.24): smaller view/simulation distances cap
# chunk memory so 3-4 rigs fit the host; set every run (idempotent — the
# server rewrites this file on boot, so seed-time only would drift).
for _kv in "view-distance=$VIEW_DIST" "simulation-distance=$SIM_DIST"; do
  _key="${_kv%%=*}"
  if grep -q "^$_key=" "$D/server.properties" 2>/dev/null; then
    sed "s/^$_key=.*/$_kv/" "$D/server.properties" > "$D/server.properties.tmp" \
      && mv "$D/server.properties.tmp" "$D/server.properties"
  else
    echo "$_kv" >> "$D/server.properties"
  fi
done
echo "rig ${RIG_ID:-0}: container $CONTAINER, port $RIG_PORT, data $D"
echo "trim: heap $INIT_MEM/$MAX_MEM, view-distance=$VIEW_DIST, simulation-distance=$SIM_DIST"
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
    # /tick rate is literal ticks/sec (20 = normal): 2..19 runs SLOWER than
    # wall clock — warn loud, it is almost never what the caller wanted.
    if [ "$TICKRATE" -lt 20 ]; then
      echo "tickrate [$TICKRATE]: BELOW normal 20 tps — the game runs SLOWER than wall clock (60 = 3x, 100 = 5x)"
    fi
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
export CASTLE_KIT="$KIT" CASTLE_TICKRATE="$TICKRATE" CASTLE_BLOCKED="$BLOCKED"
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
