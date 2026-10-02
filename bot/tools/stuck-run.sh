#!/bin/sh
# STUCK ORACLE (idkcraft-6x7.4): the pre-merge gate for movement code — reset
# the disposable world copy, boot the rig via START.sh, run stuck-replay.js
# (which judges the run against stuck-baseline.json), tear down.
# Usage: sh stuck-run.sh [variant] [spots.json] [secs]   (defaults below)
# Env: PRODWORLD (default /Users/iv/Projects/.idkcraft-prodworld),
#   REPLAY_TAG (bot name suffix; default r + 3 pid digits — exported so
#   the pre-op below and the replay target the same names), REPLAY_OUT, REPLAY_BRAIN,
#   REPLAY_BASELINE* (passed through to stuck-replay.js).
# Exit codes: 0 = baseline holds, 1 = REGRESSION vs the baseline (from the
# replay), 2 = environment failure (no START.sh/snapshot, rig never came up,
# anti-noise rejected, pristine world.tar changed mid-run, guide setup
# failed, follower dropped mid-run).
# The pristine snapshot (world/world.tar) is only ever READ (tar -xf);
# the wrapper checks its sha before/after and fails the run (exit 2) on a
# mismatch so runs stay comparable.
# Refuses when an idk-replay container already runs: two rig runs share
# one world and invalidate each other.
# Rig lock (idkcraft-3on): the guard above and the reset below are not atomic,
# so the whole run holds an atomic mkdir lock (RIG_LOCK, default
# /tmp/idkcraft-rig.lock — the path the old manual `until mkdir ...` wrapper
# used). Busy = exit 2 BEFORE touching the world (fail loud; RIG_LOCK_WAIT=<secs>
# polls instead). The holder pid lives in $RIG_LOCK/pid; a dead holder is
# stale and reclaimed. Released on every exit path (trap). A caller that
# already holds RIG_LOCK itself (old wrapper) sets RIG_LOCK_HELD=1 to skip it —
# new callers need no wrapper at all.
# Parallel rigs (idkcraft-qd9s): RIG_ID=<a-z> is a second rig — its own
# container (idk-replay-<id>), port (25571 + letter index: a=25572, b=25573),
# data copy ($PRODWORLD/rigs/<id>/replay-data/<variant>, seeded once from the
# default rig minus world/ and logs/; rm -rf it to reseed) and lock
# ($RIG_LOCK-<id>). RIG_ID=auto takes the first free of RIG_SLOTS (default
# "0 a b"; 0 = the default rig). Unset/0 = the default rig, unchanged.
set -e
LOCKBASE="${RIG_LOCK:-/tmp/idkcraft-rig.lock}"
RIG_ID="${RIG_ID:-}"
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
    # ponytail: mv-then-rm narrows but does not close a two-reclaimer race; flock if it ever bites
    mv "$1" "$1.stale.$$" 2>/dev/null && rm -rf "$1.stale.$$"
    mkdir "$1" 2>/dev/null && return 0
  fi
  return 1
}
if [ "${RIG_LOCK_HELD:-}" != 1 ]; then
  _auto=; if [ "$RIG_ID" = auto ]; then _auto=1; _slots="${RIG_SLOTS:-0 a b}"; else _slots="${RIG_ID:-0}"; fi
  _waited=0
  while :; do
    for _s in $_slots; do
      [ "$_s" = 0 ] && _s=
      RIG_ID="$_s"; RIG_LOCK="$LOCKBASE${RIG_ID:+-$RIG_ID}"
      rig_try "$RIG_LOCK" || continue
      # auto: a slot whose container outlived its lock would only exit 2 below — try the next one
      if [ -n "$_auto" ] && docker ps --format '{{.Names}}' 2>/dev/null | grep -qx "idk-replay${_s:+-$_s}"; then
        echo "rig ${_s:-0}: idk-replay${_s:+-$_s} still running without a lock — next slot"
        rmdir "$RIG_LOCK"; continue
      fi
      break 2
    done
    if [ "$_waited" -ge "${RIG_LOCK_WAIT:-0}" ]; then
      echo "rig busy: $RIG_LOCK held by pid ${_hp:-?} (slots: $_slots) — one run per rig (RIG_LOCK_WAIT=<secs> to wait, RIG_ID=auto|<a-z> for another rig; if YOUR wrapper holds it, drop the wrapper or set RIG_LOCK_HELD=1)"; exit 2
    fi
    sleep 5; _waited=$((_waited + 5))
  done
  echo $$ > "$RIG_LOCK/pid"
  trap rig_release EXIT
  trap 'exit 130' INT TERM
elif [ "$RIG_ID" = auto ]; then
  echo "RIG_LOCK_HELD=1 needs a concrete RIG_ID, not auto"; exit 2
fi
VARIANT="${1:-paper-base}"
SPOTS="$2"
SECS="$3"
PRODWORLD="${PRODWORLD:-/Users/iv/Projects/.idkcraft-prodworld}"
HERE="$(dirname "$0")"
TREE="$(cd "$HERE/../.." && pwd)"
D="$PRODWORLD/replay-data/$VARIANT"
[ -x "$PRODWORLD/START.sh" ] || { echo "no START.sh in $PRODWORLD"; exit 2; }
[ -d "$D/world" ] || { echo "no snapshot at $D"; exit 2; }
[ -f "$PRODWORLD/world.tar" ] || { echo "no world.tar in $PRODWORLD"; exit 2; }
CONTAINER=idk-replay
RIGDIR="$PRODWORLD"
if [ -n "$RIG_ID" ]; then
  case "$RIG_ID" in [a-z]) ;; *) echo "RIG_ID must be one letter a-z, 0 or auto (got '$RIG_ID')"; exit 2 ;; esac
  CONTAINER="idk-replay-$RIG_ID"
  RIG_PORT=$((25571 + $(printf '%d' "'$RIG_ID") - 96))
  RIGDIR="$PRODWORLD/rigs/$RIG_ID"
  if [ ! -d "$RIGDIR/replay-data/$VARIANT" ]; then
    echo "seed: $RIGDIR/replay-data/$VARIANT <- $D (minus world/, logs/)"
    mkdir -p "$RIGDIR/replay-data"
    rm -rf "$RIGDIR/replay-data/.$VARIANT.tmp" # a half-seeded copy from a killed run
    rsync -a --exclude /world --exclude /logs "$D/" "$RIGDIR/replay-data/.$VARIANT.tmp/"
    mv "$RIGDIR/replay-data/.$VARIANT.tmp" "$RIGDIR/replay-data/$VARIANT"
  fi
  # START.sh stays the single source of image/flags: the rig copy only renames
  # the container and the host port; its dirname $0 points it at the rig data.
  sed -e "s/--name idk-replay /--name $CONTAINER /" -e "s/-p 25571:/-p $RIG_PORT:/" "$PRODWORLD/START.sh" > "$RIGDIR/START.sh"
  grep -q -- "--name $CONTAINER " "$RIGDIR/START.sh" && grep -q -- "-p $RIG_PORT:" "$RIGDIR/START.sh" \
    || { echo "START.sh no longer has '--name idk-replay ' / '-p 25571:' — cannot derive rig $RIG_ID"; exit 2; }
  D="$RIGDIR/replay-data/$VARIANT"
  export REPLAY_CONTAINER="$CONTAINER" REPLAY_PORT="$RIG_PORT"
  echo "rig $RIG_ID: container $CONTAINER, port $RIG_PORT, data $D"
fi
if docker ps --format '{{.Names}}' | grep -qx "$CONTAINER"; then
  echo "$CONTAINER already running — one run per rig"; exit 2
fi
if [ "$VARIANT" = "vanilla" ]; then
  echo "vanilla has no pristine tar (transplanted hand-built world) — refusing reset; use paper-base|paper-relaxed"; exit 2
fi
sha_of() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'; else shasum -a 256 "$1" | awk '{print $1}'; fi; }
SHA_BEFORE="$(sha_of "$PRODWORLD/world.tar")"
echo "reset: $D/world <- world.tar"
rm -rf "$D/world"
tar -xf "$PRODWORLD/world.tar" -C "$D"
GITSHA="$(git -C "$TREE" rev-parse --short HEAD 2>/dev/null || echo '?')"
LOG="/tmp/stuck-run-$VARIANT${RIG_ID:+-$RIG_ID}.log"
echo "boot: $VARIANT (log $LOG)"
FIFO="/tmp/stuck-stdin-$$.fifo"
mkfifo "$FIFO"
exec 9<> "$FIFO" # held open: Paper's console reader blocks instead of EOF-exiting (muse-5: START.sh dies on stdin EOF)
sh "$RIGDIR/START.sh" "$VARIANT" >"$LOG" 2>&1 <&9 &
SRVPID=$!
teardown() {
  docker stop -t 5 "$CONTAINER" >/dev/null 2>&1 || true
  kill "$SRVPID" >/dev/null 2>&1 || true
  exec 9<&- || true
  rm -f "$FIFO" || true
}
on_exit() { # EXIT only: the replay verdict (0/1) passes through, env exits stay 2
  rc=$?
  teardown
  rig_release
  SHA_AFTER="$(sha_of "$PRODWORLD/world.tar")"
  if [ "$SHA_AFTER" = "$SHA_BEFORE" ]; then
    echo "pristine world.tar untouched ($SHA_AFTER)"
    exit "$rc"
  else
    echo "PRISTINE world.tar CHANGED: $SHA_BEFORE -> $SHA_AFTER"
    exit 2 # env failure dominates: the run is no longer comparable
  fi
}
on_sig() { # INT/TERM: never report a kill as a pass
  teardown
  echo "interrupted"
  exit 130
}
trap on_exit EXIT
trap on_sig INT TERM
echo -n "wait: rcon"
for _ in $(seq 1 36); do
  if docker exec "$CONTAINER" rcon-cli "list" >/dev/null 2>&1; then echo " up"; break; fi
  echo -n "."; sleep 5
done
docker exec "$CONTAINER" rcon-cli "list" >/dev/null 2>&1 || { echo " rig never came up (see $LOG)"; exit 2; }
# Anti-noise (repeatability, not prod combat): hostile interference (fights,
# knockback, deaths) would make stuck/recover numbers unrepeatable. Every
# command asserts and echoes: Paper 26.1 renamed gamerules to snake_case and
# the old camelCase fails with "Incorrect argument" (3ro) — a silent
# >/dev/null hid the dead rules and every run measured a noisier game.
rcon_assert() { # $1 = command; fails the run unless rcon accepts it
  _out=$(docker exec "$CONTAINER" rcon-cli "$1" 2>&1) || { echo "ANTI-NOISE FAILED [$1]: $_out"; exit 2; }
  case "$_out" in
    *Incorrect*|*Unknown*|*incomplete*|*No\ entity*) echo "ANTI-NOISE REJECTED [$1]: $(printf '%s' "$_out" | head -n 1)"; exit 2 ;;
  esac
  echo "anti-noise [$1]: $(printf '%s' "$_out" | head -n 1)"
}
rcon_assert "difficulty peaceful"
rcon_assert "gamerule fall_damage false"
rcon_assert "gamerule advance_weather false"
rcon_assert "weather clear"
# Spawn protection (3ro): the spawn-cluster spots sit inside r=16 of world
# spawn and Paper enforces protection once ops.json is non-empty — one stray
# op armed it mid-day and the baseline collapsed to 3/10 with no code change.
# Pre-op both bots (offline names resolve pre-login) so protection is off
# from the first tick; the replay re-ops post-spawn as the asserted
# guarantee. The TAG is exported (not random-in-replay) so both ops and the
# login target the same names. Usernames cap at 16 chars (StuckReplay + tag
# must fit), so the default tag is r + 3 pid digits — a full pid overflows
# the hello and the login dies server-side with a decode error.
_ptail=$(( $$ % 1000 ))
export REPLAY_TAG="${REPLAY_TAG:-r$_ptail}"
rcon_assert "op StuckGuide$REPLAY_TAG"
rcon_assert "op StuckReplay$REPLAY_TAG"
export REPLAY_VARIANT="$VARIANT" REPLAY_WORLDSHA="$SHA_BEFORE" REPLAY_GITSHA="$GITSHA"
if [ -n "$SPOTS" ]; then
  case "$SPOTS" in
    /*) export REPLAY_SPOTS="$SPOTS" ;;
    *) export REPLAY_SPOTS="$(cd "$(dirname "$SPOTS")" && pwd)/$(basename "$SPOTS")" ;;
  esac
fi
[ -n "$SECS" ] && export REPLAY_SECS="$SECS"
cd "$HERE/.." && node tools/stuck-replay.js
