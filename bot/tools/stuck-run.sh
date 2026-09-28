#!/bin/sh
# STUCK REGRESSION RUN wrapper (idkcraft-4rz): reset the disposable world
# copy, boot the rig via START.sh, run stuck-replay.js, tear down.
# Usage: sh stuck-run.sh [variant] [spots.json] [secs]   (defaults below)
# Env: PRODWORLD (default /Users/iv/Projects/.idkcraft-prodworld),
#   REPLAY_TAG, REPLAY_OUT (passed through to stuck-replay.js).
# The pristine snapshot (world/world.tar) is only ever READ (tar -xf);
# the wrapper prints its sha before/after so runs stay comparable.
# Refuses when an idk-replay container already runs: two rig runs share
# one world and invalidate each other.
set -e
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
cleanup() {
  docker stop -t 5 idk-replay >/dev/null 2>&1 || true
  kill "$SRVPID" >/dev/null 2>&1 || true
  exec 9<&- || true
  rm -f "$FIFO" || true
  SHA_AFTER="$(sha_of "$PRODWORLD/world.tar")"
  if [ "$SHA_AFTER" = "$SHA_BEFORE" ]; then echo "pristine world.tar untouched ($SHA_AFTER)"; else echo "PRISTINE world.tar CHANGED: $SHA_BEFORE -> $SHA_AFTER"; fi
}
trap cleanup EXIT INT TERM
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
export REPLAY_VARIANT="$VARIANT" REPLAY_WORLDSHA="$SHA_BEFORE" REPLAY_GITSHA="$GITSHA"
if [ -n "$SPOTS" ]; then
  case "$SPOTS" in
    /*) export REPLAY_SPOTS="$SPOTS" ;;
    *) export REPLAY_SPOTS="$(cd "$(dirname "$SPOTS")" && pwd)/$(basename "$SPOTS")" ;;
  esac
fi
[ -n "$SECS" ] && export REPLAY_SECS="$SECS"
cd "$HERE/.." && node tools/stuck-replay.js
