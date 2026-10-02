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
set -e
RIG_LOCK="${RIG_LOCK:-/tmp/idkcraft-rig.lock}"
rig_release() { # only ever remove a lock this process wrote
  [ "$(cat "$RIG_LOCK/pid" 2>/dev/null)" = "$$" ] && rm -rf "$RIG_LOCK"
  return 0
}
if [ "${RIG_LOCK_HELD:-}" != 1 ]; then
  _waited=0
  until mkdir "$RIG_LOCK" 2>/dev/null; do
    _hp="$(cat "$RIG_LOCK/pid" 2>/dev/null || true)"
    if [ -n "$_hp" ] && ! kill -0 "$_hp" 2>/dev/null; then
      echo "rig lock: stale (holder pid $_hp dead) — reclaiming"
      # ponytail: mv-then-rm narrows but does not close a two-reclaimer race; flock if it ever bites
      mv "$RIG_LOCK" "$RIG_LOCK.stale.$$" 2>/dev/null && rm -rf "$RIG_LOCK.stale.$$"
      continue
    fi
    if [ "$_waited" -ge "${RIG_LOCK_WAIT:-0}" ]; then
      echo "rig busy: $RIG_LOCK held by pid ${_hp:-?} — one rig run at a time (RIG_LOCK_WAIT=<secs> to wait)"; exit 2
    fi
    sleep 5; _waited=$((_waited + 5))
  done
  echo $$ > "$RIG_LOCK/pid"
  trap rig_release EXIT
  trap 'exit 130' INT TERM
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
if docker ps --format '{{.Names}}' | grep -qx 'idk-replay'; then
  echo "idk-replay already running — one rig run at a time"; exit 2
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
LOG="/tmp/stuck-run-$VARIANT.log"
echo "boot: $VARIANT (log $LOG)"
FIFO="/tmp/stuck-stdin-$$.fifo"
mkfifo "$FIFO"
exec 9<> "$FIFO" # held open: Paper's console reader blocks instead of EOF-exiting (muse-5: START.sh dies on stdin EOF)
sh "$PRODWORLD/START.sh" "$VARIANT" >"$LOG" 2>&1 <&9 &
SRVPID=$!
teardown() {
  docker stop -t 5 idk-replay >/dev/null 2>&1 || true
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
  if docker exec idk-replay rcon-cli "list" >/dev/null 2>&1; then echo " up"; break; fi
  echo -n "."; sleep 5
done
docker exec idk-replay rcon-cli "list" >/dev/null 2>&1 || { echo " rig never came up (see $LOG)"; exit 2; }
# Anti-noise (repeatability, not prod combat): hostile interference (fights,
# knockback, deaths) would make stuck/recover numbers unrepeatable. Every
# command asserts and echoes: Paper 26.1 renamed gamerules to snake_case and
# the old camelCase fails with "Incorrect argument" (3ro) — a silent
# >/dev/null hid the dead rules and every run measured a noisier game.
rcon_assert() { # $1 = command; fails the run unless rcon accepts it
  _out=$(docker exec idk-replay rcon-cli "$1" 2>&1) || { echo "ANTI-NOISE FAILED [$1]: $_out"; exit 2; }
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
