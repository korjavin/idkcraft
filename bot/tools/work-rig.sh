#!/bin/sh
# WORK-RIG (idkcraft-6x7.16): offline work-cycle harness — the offline twin
# of the rw4.7 (home -> night -> morning) and atl.3 (items/h, deaths)
# prod acceptances. Reset a disposable world copy, boot Paper on NORMAL
# difficulty with the natural day/night cycle, raise a rig-built v2 house +
# both bedroom beds on a flat pad at spawn, order `autonomous on` + `go work`,
# quit the guide (prod-alone parity), run N minutes, print ONE verdict line:
#   work nights=<n> slept=<n> inside=<n> dugin=<n> deaths=<n> banked=<items>/h brought=<n> steps=<top-4> fail=<top-3>
# Usage: sh work-rig.sh [mins]   (default 20; WORK_MINS also works)
# Env: PRODWORLD (default /Users/iv/Projects/.idkcraft-prodworld),
#   WORK_RIG_ID (''/0 default, a-z, or auto over WORK_SLOTS "0 a b c"),
#   WORK_LOCK (default /tmp/idkcraft-work-rig.lock), WORK_LOCK_WAIT (falls
#   back to RIG_LOCK_WAIT, default 0), WORK_TAG, WORK_OUT, WORK_LOG,
#   WORK_KIT (empty|chest|seeded — chest adds a home chest at the first v2
#   chest spot; seeded adds stone tools + bread on top of the chest),
#   WORK_TICKRATE (default 60 = 3x, one mc day ~6.7 min; 1 = the gate
#   regime, wall-clock game), RIG_PLANNER (jev|stub, default jev — key from
#   TYPESAFE_API_KEY or the stash secrets/jev-api-key, never printed),
#   GOAL_WATCHDOG_MS / GOAL_COMMIT_MS (pass through when set),
#   WORK_INIT_MEMORY/WORK_MAX_MEMORY (default 512M/768M),
#   WORK_VIEW_DISTANCE/WORK_SIM_DISTANCE (default 6/4).
# Exit: 0 = measured (even all zeros — the line says so),
#   2 = environment/setup failure, 130 = interrupted (never a pass).
# Measured, not suppressed: no daylock, no peaceful, fall damage and
# keepInventory untouched (deaths and drops ARE the measurement). Weather
# stays clear so runs compare. The pristine world.tar is only ever READ; a
# sha move fails the run (exit 2).
# One work run per rig, beside the castle and stuck rigs (own containers,
# ports, locks): container idk-work[-<id>], host port 25611 + letter index
# (a=25612), data under $PRODWORLD/work-rigs/<id>/ (seeded once from
# replay-data/paper-base minus world/ and logs/; rm -rf it to reseed).
#
# ponytail: copy of castle-rig boot/lock/teardown, extract rig-lib.sh after ek69
set -e
LOCKBASE="${WORK_LOCK:-/tmp/idkcraft-work-rig.lock}"
RIG_ID="${WORK_RIG_ID:-}"
[ "$RIG_ID" = 0 ] && RIG_ID=
RIG_LOCK="$LOCKBASE${RIG_ID:+-$RIG_ID}"
LOCK_WAIT="${WORK_LOCK_WAIT:-${RIG_LOCK_WAIT:-0}}"
case "$LOCK_WAIT" in ''|*[!0-9]*) echo "lock-wait: want seconds >= 0, got '$LOCK_WAIT'"; exit 2 ;; esac
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
_auto=; if [ "$RIG_ID" = auto ]; then _auto=1; _slots="${WORK_SLOTS:-0 a b c}"; else _slots="${RIG_ID:-0}"; fi
_waited=0
while :; do
  for _s in $_slots; do
    [ "$_s" = 0 ] && _s=
    case "$_s" in ''|[a-z]) ;; *) echo "WORK_RIG_ID must be one letter a-z, 0 or auto (got '$_s')"; exit 2 ;; esac
    RIG_ID="$_s"; RIG_LOCK="$LOCKBASE${RIG_ID:+-$RIG_ID}"
    rig_try "$RIG_LOCK" || continue
    if [ -n "$_auto" ] && docker ps --format '{{.Names}}' 2>/dev/null | grep -qx "idk-work${_s:+-$_s}"; then
      echo "rig ${_s:-0}: idk-work${_s:+-$_s} still running without a lock — next slot"
      rmdir "$RIG_LOCK"; continue
    fi
    break 2
  done
  if [ "$_waited" -ge "$LOCK_WAIT" ]; then
    echo "rig busy: $RIG_LOCK held by pid ${_hp:-?} (slots: $_slots) — one run per rig (WORK_LOCK_WAIT=<secs> to wait, WORK_RIG_ID=auto|<a-z> for another rig)"; exit 2
  fi
  sleep 5; _waited=$((_waited + 5))
done
echo $$ > "$RIG_LOCK/pid"
trap rig_release EXIT
trap 'exit 130' INT TERM
MINS="${1:-${WORK_MINS:-20}}"
case "$MINS" in ''|*[!0-9]*) echo "mins: want a positive integer, got '$MINS'"; exit 2 ;; esac
[ "$MINS" -ge 1 ] || { echo "mins: want a positive integer, got '$MINS'"; exit 2; }
KIT="${WORK_KIT:-empty}"
case "$KIT" in empty|chest|seeded) ;; *) echo "WORK_KIT: want empty|chest|seeded, got '$KIT'"; exit 2 ;; esac
TICKRATE="${WORK_TICKRATE:-60}"
case "$TICKRATE" in ''|*[!0-9]*) echo "tickrate: want an integer 1..100, got '$TICKRATE'"; exit 2 ;; esac
{ [ "$TICKRATE" -ge 1 ] && [ "$TICKRATE" -le 100 ]; } || { echo "tickrate: want an integer 1..100, got '$TICKRATE'"; exit 2; }
RIG_PLANNER="${RIG_PLANNER:-jev}"
case "$RIG_PLANNER" in jev|stub) ;; *) echo "RIG_PLANNER: want jev|stub, got '$RIG_PLANNER'"; exit 2 ;; esac
export RIG_PLANNER
if [ "$RIG_PLANNER" = jev ] && [ -z "${TYPESAFE_API_KEY:-}" ] && [ -x "$HOME/.local/bin/kv" ]; then
  # Stash fallback: the key travels as env only — this block prints nothing.
  TYPESAFE_API_KEY="$("$HOME/.local/bin/kv" get secrets/jev-api-key 2>/dev/null || true)"
  export TYPESAFE_API_KEY
fi
if [ "$RIG_PLANNER" = jev ] && [ -z "${TYPESAFE_API_KEY:-}" ]; then
  echo "RIG_PLANNER=jev needs TYPESAFE_API_KEY (stash secrets/jev-api-key)"; exit 2
fi
if [ -n "${GOAL_WATCHDOG_MS:-}" ]; then export GOAL_WATCHDOG_MS; fi
if [ -n "${GOAL_COMMIT_MS:-}" ]; then export GOAL_COMMIT_MS; fi
INIT_MEM="${WORK_INIT_MEMORY:-512M}"
MAX_MEM="${WORK_MAX_MEMORY:-768M}"
valid_mem() { _m="$1"; case "$_m" in *M|*G) _m="${_m%?}";; *) return 1;; esac; case "$_m" in ''|*[!0-9]*) return 1;; esac; }
valid_mem "$INIT_MEM" || { echo "memory: want <n>M|<n>G, got INIT '$INIT_MEM'"; exit 2; }
valid_mem "$MAX_MEM" || { echo "memory: want <n>M|<n>G, got MAX '$MAX_MEM'"; exit 2; }
mem_mb() { case "$1" in *G) echo $(( ${1%?} * 1024 ));; *) echo "${1%?}";; esac; }
{ [ "$(mem_mb "$INIT_MEM")" -gt 0 ] && [ "$(mem_mb "$INIT_MEM")" -le "$(mem_mb "$MAX_MEM")" ]; } || { echo "memory: INIT $INIT_MEM must be >0 and <= MAX $MAX_MEM"; exit 2; }
VIEW_DIST="${WORK_VIEW_DISTANCE:-6}"
SIM_DIST="${WORK_SIM_DISTANCE:-4}"
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
CONTAINER="idk-work${RIG_ID:+-$RIG_ID}"
RIG_PORT=25611
RIGDIR="$PRODWORLD/work-rigs/0"
if [ -n "$RIG_ID" ]; then
  RIG_PORT=$((25611 + $(printf '%d' "'$RIG_ID") - 96))
  RIGDIR="$PRODWORLD/work-rigs/$RIG_ID"
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
LOG="/tmp/work-run-${RIG_ID:-0}.log"
: > "$LOG"
FIFO="/tmp/work-stdin-$$.fifo"
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
  _out=$(docker exec "$CONTAINER" rcon-cli "$1" 2>&1) || { echo "SETUP FAILED [$1]: $_out"; exit 2; }
  case "$_out" in
    *Incorrect*|*Unknown*|*incomplete*|*No\ entity*) echo "SETUP REJECTED [$1]: $(printf '%s' "$_out" | head -n 1)"; exit 2 ;;
  esac
  echo "setup [$1]: $(printf '%s' "$_out" | head -n 1)"
}
_ptail=$(( $$ % 1000 ))
export WORK_TAG="${WORK_TAG:-w$_ptail}"
boot() {
  echo "reset: $D/world <- world.tar"
  rm -rf "$D/world"
  tar -xf "$PRODWORLD/world.tar" -C "$D"
  echo "boot: $VARIANT (log $LOG)"
  mkfifo "$FIFO"
  exec 9<> "$FIFO"
  sh "$RIGDIR/START.sh" "$VARIANT" >>"$LOG" 2>&1 <&9 &
  SRVPID=$!
  printf "wait: rcon"
  for _ in $(seq 1 36); do
    if docker exec "$CONTAINER" rcon-cli "list" >/dev/null 2>&1; then echo " up"; break; fi
    printf "."; sleep 5
  done
  docker exec "$CONTAINER" rcon-cli "list" >/dev/null 2>&1 || { echo " rig never came up (see $LOG)"; exit 2; }
  # Night and mobs are the measurement: normal difficulty, the clock runs.
  rcon_assert "difficulty normal"
  rcon_assert "gamerule advance_weather false"
  rcon_assert "weather clear"
  if _out=$(docker exec "$CONTAINER" rcon-cli "gamerule advance_time true" 2>&1) && \
     case "$_out" in *Incorrect*|*Unknown*|*incomplete*) false ;; *) true ;; esac; then
    echo "setup [gamerule advance_time true]: $(printf '%s' "$_out" | head -n 1)"
  else
    rcon_assert "gamerule do_daylight_cycle true"
  fi
  rcon_assert "time set 1000"
  if [ "$TICKRATE" != 1 ]; then
    if [ "$TICKRATE" -lt 20 ]; then
      echo "tickrate [$TICKRATE]: BELOW normal 20 tps — the game runs SLOWER than wall clock (60 = 3x, 100 = 5x)"
    fi
    if _out=$(docker exec "$CONTAINER" rcon-cli "tick rate $TICKRATE" 2>&1) && \
       case "$_out" in *Incorrect*|*Unknown*|*incomplete*) false ;; *) true ;; esac; then
      echo "tickrate [$TICKRATE]: $(printf '%s' "$_out" | head -n 1)"
    else
      echo "tickrate [$TICKRATE] REJECTED, running at wall clock: $(printf '%s' "${_out:-?}" | head -n 1)"
      TICKRATE=1
    fi
  fi
  rcon_assert "op WorkGuide$WORK_TAG"
  rcon_assert "op WorkBot$WORK_TAG"
}
boot
export WORK_MINS="$MINS" WORK_CONTAINER="$CONTAINER" WORK_PORT="$RIG_PORT" WORK_GITSHA="$GITSHA"
export WORK_KIT="$KIT" WORK_TICKRATE="$TICKRATE"
export WORK_OUT="${WORK_OUT:-/tmp/work-rig-${RIG_ID:-0}.json}"
export BOT_MEMORY_FILE="${BOT_MEMORY_FILE:-/tmp/work-mem-${RIG_ID:-0}.json}"
rm -f "$BOT_MEMORY_FILE"
cd "$HERE/.."
# Tee: the verdict survives on disk even if the caller keeps only a tail.
RIGOUT="/tmp/work-rig-out-${RIG_ID:-0}.log"
: > "$RIGOUT"
set -o pipefail 2>/dev/null || true
node tools/work-replay.js 2>&1 | tee -a "$RIGOUT"
