#!/bin/sh
# STUCK ORACLE (idkcraft-6x7.4): the pre-merge gate for movement code — reset
# the disposable world copy, boot the rig via START.sh, run stuck-replay.js
# (which judges the run against stuck-baseline.json), tear down.
# Usage: sh stuck-run.sh [variant] [spots.json] [secs]   (defaults below)
# Env: PRODWORLD (default /Users/iv/Projects/.idkcraft-prodworld),
#   REPLAY_TAG (bot name suffix; default r + 3 pid digits — exported so
#   the pre-op below and the replay target the same names), REPLAY_OUT, REPLAY_BRAIN,
#   REPLAY_BASELINE* (passed through to stuck-replay.js), REPLAY_WORKER=1
#   (launch the Baritone worker client beside the head, idkcraft-jlda.3),
#   REPLAY_BODY=baritone (run the FOLLOWER on the v2 Baritone body:
#   idkcraft-neuc.5 boots the offline client under the follower name and
#   exports BOT_BODY/BRIDGE_* for the replay; MOD_PORT/BODY_CONSOLE_PORT
#   pick the host publishes, defaults 7778/7779 on the default rig and
#   + 2 x letter index on RIG_ID=<a-z> (a=7780/7781); BODY_CLIENT the client
#   container name, default idk-baritone-body[-<RIG_ID>] — per slot, so
#   parallel v2 runs never collide, idkcraft-neuc.23. Judged against
#   stuck-baseline-v2.json, idkcraft-neuc.15),
#   REPLAY_KEEP=1 (micro-rig, idkcraft-vf8e.1: the first call boots, runs
#   the given spots once and KEEPS the rig up — idle teardown after
#   REPLAY_KEEP_IDLE secs, default 1800, or on INT/TERM; later
#   REPLAY_KEEP=1 calls on the same slot are inner runs on the live
#   server, see the block below the lock helpers), REPLAY_SKILLS_DIR
#   (keep mode only: exported to the bot as SKILLS_DIR + BOT_SKILLS=1).
#   Unset REPLAY_KEEP = the gate run, unchanged.
# Exit codes: 0 = baseline holds (incl. FLAKY: regressed spots held on the
# one automatic rerun, see the flake protocol at the end), 1 = REGRESSION vs
# the baseline (repeated on the rerun), 2 = environment failure (no START.sh/snapshot, rig never came up,
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
# vhlb.4: REPLAY_PLANNER=jev|llm (stall-point plan() on the stub, see
# stuck-replay.js). Keys: env, else the stash — env-only, prints nothing;
# a missing key fails before any lock/docker work.
case "${REPLAY_PLANNER:-stub}" in
  stub) ;;
  jev) [ -z "${TYPESAFE_API_KEY:-}" ] && [ -x "$HOME/.local/bin/kv" ] && TYPESAFE_API_KEY="$("$HOME/.local/bin/kv" get secrets/jev-api-key 2>/dev/null || true)"
    [ -n "${TYPESAFE_API_KEY:-}" ] || { echo "REPLAY_PLANNER=jev needs TYPESAFE_API_KEY (stash secrets/jev-api-key)"; exit 2; }
    export TYPESAFE_API_KEY ;;
  llm) [ -z "${ANTHROPIC_API_KEY:-}" ] && [ -x "$HOME/.local/bin/kv" ] && ANTHROPIC_API_KEY="$("$HOME/.local/bin/kv" get secrets/minecraft/anthropic-api-key 2>/dev/null || true)"
    [ -n "${ANTHROPIC_API_KEY:-}" ] || { echo "REPLAY_PLANNER=llm needs ANTHROPIC_API_KEY (stash secrets/minecraft/anthropic-api-key)"; exit 2; }
    export ANTHROPIC_API_KEY ;;
  *) echo "REPLAY_PLANNER: want stub|jev|llm, got '$REPLAY_PLANNER'"; exit 2 ;;
esac
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
# Micro-rig (idkcraft-vf8e.1): REPLAY_KEEP=1 with a kept rig already up on
# the slot (its keeper wrote $RIG_LOCK/keep.env and is alive) = an INNER run:
# no lock (the keeper holds it — the RIG_LOCK_HELD=1 contract), no reset, no
# boot, no flake rerun — one stuck-replay.js process (fresh bot code) over
# the given spots on the live server, its own verdict and exit code. Inner
# runs serialise on $RIG_LOCK/run. Each spot's prep/tp/kit is the arena reset.
# RIG_ID=auto picks the first kept slot of RIG_SLOTS.
if [ "${REPLAY_KEEP:-}" = 1 ]; then
  _ks="${RIG_ID:-0}"; [ "$_ks" = auto ] && _ks="${RIG_SLOTS:-0 a b}"
  for _s in $_ks; do
    [ "$_s" = 0 ] && _s=
    _kl="$LOCKBASE${_s:+-$_s}"
    [ -f "$_kl/keep.env" ] || continue
    KEEP_PID=; . "$_kl/keep.env"
    { [ -n "$KEEP_PID" ] && kill -0 "$KEEP_PID" 2>/dev/null; } || continue
    [ "${1:-paper-base}" = "$KEEP_VARIANT" ] || { echo "kept rig ${_s:-0} runs $KEEP_VARIANT, not ${1:-paper-base}"; exit 2; }
    RIG_LOCK="$_kl/run"
    until rig_try "$RIG_LOCK"; do
      kill -0 "$KEEP_PID" 2>/dev/null || { echo "keeper $KEEP_PID died while waiting"; exit 2; }
      sleep 2
    done
    echo $$ > "$RIG_LOCK/pid"
    trap rig_release EXIT
    trap 'exit 130' INT TERM
    _t0=$(date +%s)
    echo "micro-run: kept rig ${_s:-0} (keeper $KEEP_PID, tag $REPLAY_TAG)"
    _here="$(dirname "$0")"
    REPLAY_GITSHA="$(git -C "$_here/../.." rev-parse --short HEAD 2>/dev/null || echo '?')"
    export REPLAY_GITSHA
    case "${2:-}" in
      '') ;;
      /*) export REPLAY_SPOTS="$2" ;;
      *) REPLAY_SPOTS="$(cd "$(dirname "$2")" && pwd)/$(basename "$2")"; export REPLAY_SPOTS ;;
    esac
    [ -n "${3:-}" ] && export REPLAY_SECS="$3"
    [ -n "${REPLAY_SKILLS_DIR:-}" ] && export SKILLS_DIR="$REPLAY_SKILLS_DIR" BOT_SKILLS=1
    cd "$_here/.."
    set +e; node tools/stuck-replay.js; rc=$?; set -e
    echo "micro-run: exit $rc in $(( $(date +%s) - _t0 ))s"
    exit "$rc"
  done
fi
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
GITSHA="$(git -C "$TREE" rev-parse --short HEAD 2>/dev/null || echo '?')"
LOG="/tmp/stuck-run-$VARIANT${RIG_ID:+-$RIG_ID}.log"
: > "$LOG"
FIFO="/tmp/stuck-stdin-$$.fifo"
RERUN="/tmp/stuck-rerun-$$.json"
SRVPID=
teardown() {
  # Worker client (idkcraft-jlda.3): stop it with the rig, on every exit
  # path — but only when THIS run started it (a failed start cleans
  # itself; a guarded one must never stop another run's client).
  if [ "${WORKER_STARTED:-}" = 1 ]; then
    sh "$TREE/baritone/client.sh" stop >/dev/null 2>&1 || true
  fi
  # v2 body client (idkcraft-neuc.5): same ownership rule, its own name.
  if [ "${BODY_STARTED:-}" = 1 ]; then
    BARITONE_CLIENT="$BODY_CLIENT" sh "$TREE/baritone/client.sh" stop >/dev/null 2>&1 || true
  fi
  docker stop -t 5 "$CONTAINER" >/dev/null 2>&1 || true
  if [ -n "$SRVPID" ]; then kill "$SRVPID" >/dev/null 2>&1 || true; wait "$SRVPID" 2>/dev/null || true; fi
  SRVPID=
  exec 9<&- || true
  rm -f "$FIFO" || true
}
on_exit() { # EXIT only: the replay verdict (0/1) passes through, env exits stay 2
  rc=$?
  if [ "${KEPT:-}" = 1 ]; then rm -f "$RIG_LOCK/keep.env"; fi # unpublish first: no inner run starts on a dying rig
  teardown
  rm -f "$RERUN"
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
  if [ "${KEPT:-}" = 1 ]; then rm -f "$RIG_LOCK/keep.env"; fi # unpublish before the slow teardown
  teardown
  echo "interrupted"
  exit 130
}
trap on_exit EXIT
trap on_sig INT TERM
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
boot() { # reset the world copy from the pristine tar, start the rig, anti-noise, pre-op
  echo "reset: $D/world <- world.tar"
  rm -rf "$D/world"
  tar -xf "$PRODWORLD/world.tar" -C "$D"
  echo "boot: $VARIANT (log $LOG)"
  mkfifo "$FIFO"
  exec 9<> "$FIFO" # held open: Paper's console reader blocks instead of EOF-exiting (muse-5: START.sh dies on stdin EOF)
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
  rcon_assert "weather clear"
  rcon_assert "op StuckGuide$REPLAY_TAG"
  rcon_assert "op StuckReplay$REPLAY_TAG"
}
boot
# Worker beside the head (idkcraft-jlda.3): launch the Baritone client on
# THIS rig's slot (the port, not run.sh's slot z), pre-opped BEFORE it
# joins — spawn protection is decided at login (3ro). The worker is
# offline under its own name (owner decision, jlda Q2): BARITONE_OFFLINE=1
# is forced here, never the owner's account; BOT overrides the name. The
# head never connects it (client.sh owns the join; the head's ensureJoined
# stays quiet while it is online). client.sh stop rides in teardown().
if [ "${REPLAY_WORKER:-}" = 1 ]; then
  WORKER="${BOT:-IdkWorker}"
  rcon_assert "op $WORKER"
  # MOD_PORT cleared: the mod-ws publish belongs to the body client only
  # (revmux 02 core-3) — an inherited value would collide with it on a
  # shared box. Empty reads as unset in client.sh, so worker-only runs
  # are unchanged.
  MOD_PORT= BARITONE_OFFLINE=1 RIG_CONTAINER="$CONTAINER" CLIENT_LOG="/tmp/stuck-worker-$VARIANT${RIG_ID:+-$RIG_ID}.log" \
    sh "$TREE/baritone/client.sh" start "${REPLAY_PORT:-25571}" "$WORKER" || exit 2
  WORKER_STARTED=1 # the client is ours to stop from here on (teardown)
  # Paper's same-IP connection throttle (4000 ms, bukkit.yml): the worker
  # just joined from localhost and the guide connects next — hold the 6 s
  # gap here (the replay holds guide->follower itself).
  sleep 6
  # localhost, not the literal loopback IP (privacy pre-check); the bridge
  # publishes on all interfaces, so both reach it.
  export WORKER_NAME="$WORKER" WORKER_HOST=localhost WORKER_PORT="${BRIDGE_PORT:-7777}"
fi
# v2 body (idkcraft-neuc.5): the FOLLOWER runs on the Baritone body — pre-op
# its name, boot the offline client under it (client.sh owns the join)
# with the API jar (BARITONE_API=1: the bridge mod needs
# baritone/api/**, which the standalone jar strips),
# publish the console bridge (BODY_CONSOLE_PORT) and the Fabric mod ws
# (MOD_PORT), export the adapter addresses for the replay. Name and console
# port are distinct from the worker's, so REPLAY_WORKER=1 +
# REPLAY_BODY=baritone share one box (revmux 01 core-4: the same host port
# would collide). The 7779 default is the spike's body-client port.
# Per slot (idkcraft-neuc.23): RIG_ID=<a-z> shifts the container name and
# both ports, so v2 runs on parallel rigs never collide. body_start runs
# after every boot — the flake rerun relaunches the body too
# (idkcraft-neuc.15; teardown stopped it with the rig).
if [ "${REPLAY_BODY:-}" = baritone ]; then
  _bn=0; [ -n "$RIG_ID" ] && _bn=$(( $(printf '%d' "'$RIG_ID") - 96 ))
  BODY_CLIENT="${BODY_CLIENT:-idk-baritone-body${RIG_ID:+-$RIG_ID}}"
  MOD_PORT="${MOD_PORT:-$((7778 + 2 * _bn))}"
  BODY_CONSOLE_PORT="${BODY_CONSOLE_PORT:-$((7779 + 2 * _bn))}"
fi
body_start() {
  [ "${REPLAY_BODY:-}" = baritone ] || return 0
  rcon_assert "op StuckReplay$REPLAY_TAG"
  BARITONE_MEM="${BARITONE_MEM-2500m}" BARITONE_OFFLINE=1 BARITONE_API=1 RIG_CONTAINER="$CONTAINER" BARITONE_CLIENT="$BODY_CLIENT" \
    BRIDGE_PORT="$BODY_CONSOLE_PORT" MOD_PORT="$MOD_PORT" \
    CLIENT_LOG="/tmp/stuck-body-$VARIANT${RIG_ID:+-$RIG_ID}.log" \
    sh "$TREE/baritone/client.sh" start "${REPLAY_PORT:-25571}" "StuckReplay$REPLAY_TAG" || exit 2
  BODY_STARTED=1 # the client is ours to stop from here on (teardown)
  # Paper's same-IP connection throttle (4000 ms): the body just joined
  # from localhost and the guide connects next — the same 6 s gap as the
  # worker block (the replay holds guide->follower itself).
  sleep 6
  # localhost, not the literal loopback IP (privacy pre-check).
  export BOT_BODY=baritone BRIDGE_HOST=localhost BRIDGE_PORT="$MOD_PORT" BRIDGE_CONSOLE_PORT="$BODY_CONSOLE_PORT"
}
body_start
export REPLAY_VARIANT="$VARIANT" REPLAY_WORLDSHA="$SHA_BEFORE" REPLAY_GITSHA="$GITSHA"
if [ -n "$SPOTS" ]; then
  case "$SPOTS" in
    /*) export REPLAY_SPOTS="$SPOTS" ;;
    *) export REPLAY_SPOTS="$(cd "$(dirname "$SPOTS")" && pwd)/$(basename "$SPOTS")" ;;
  esac
fi
[ -n "$SECS" ] && export REPLAY_SECS="$SECS"
cd "$HERE/.."
# Micro-rig keeper (idkcraft-vf8e.1): run the given spots once if any, then
# publish the rig for inner runs (see the REPLAY_KEEP block at the top) and
# hold the server up until INT/TERM or REPLAY_KEEP_IDLE seconds (default
# 1800) without an inner run; every exit tears down through on_exit.
if [ "${REPLAY_KEEP:-}" = 1 ]; then
  [ -n "${REPLAY_SKILLS_DIR:-}" ] && export SKILLS_DIR="$REPLAY_SKILLS_DIR" BOT_SKILLS=1
  if [ -n "$SPOTS" ]; then
    set +e; node tools/stuck-replay.js; rc=$?; set -e
    echo "keep: first run exit $rc"
  fi
  {
    echo "KEEP_PID=$$"
    echo "KEEP_VARIANT='$VARIANT'"
    for _v in REPLAY_TAG REPLAY_CONTAINER REPLAY_PORT REPLAY_VARIANT REPLAY_WORLDSHA BOT_BODY BRIDGE_HOST BRIDGE_PORT BRIDGE_CONSOLE_PORT WORKER_NAME WORKER_HOST WORKER_PORT; do
      eval "_val=\${$_v-}"
      [ -z "$_val" ] || echo "export $_v='$_val'"
    done
  } > "$RIG_LOCK/keep.env"
  KEPT=1
  _idle=0; _max="${REPLAY_KEEP_IDLE:-1800}"
  echo "kept: rig ${RIG_ID:-0} up — inner runs: REPLAY_KEEP=1${RIG_ID:+ RIG_ID=$RIG_ID} sh bot/tools/stuck-run.sh $VARIANT <spots.json>; idle teardown after ${_max}s, INT/TERM tears down"
  while [ "$_idle" -lt "$_max" ]; do
    sleep 5
    _rp="$(cat "$RIG_LOCK/run/pid" 2>/dev/null || true)"
    if [ -n "$_rp" ] && kill -0 "$_rp" 2>/dev/null; then _idle=0; else _idle=$((_idle + 5)); fi
  done
  echo "kept: idle ${_max}s — tearing down"
  exit 0
fi
set +e; node tools/stuck-replay.js; rc=$?; set -e
[ "$rc" = 1 ] || exit "$rc"
# Flake protocol (idkcraft-6x7.9): the corpus is non-deterministic by
# construction (recover's random sidestep side, Paper water ticks) and that
# randomness is prod behavior, so it is never seeded. A regression gets ONE
# rerun of only the regressed spots on a freshly reset world (dug terrain
# persists across spots): repeats = REGRESSION, exit 1; holds = FLAKY, exit 0.
# A spot without a baseline entry is deterministic: no rerun. Ceilings stay.
BAD="$(node -e '
const fs = require("fs"), r = require("./tools/stuck-replay.js")
const [out, spotsFile, dst] = process.argv.slice(1)
const diffs = r.compareBaseline(JSON.parse(fs.readFileSync(out, "utf8")), r.loadBaseline().baseline)
if (diffs.some((d) => d.verdict === "no-baseline")) process.exit(0)
const bad = new Set(diffs.filter((d) => d.verdict === "regressed").map((d) => d.spot))
fs.writeFileSync(dst, JSON.stringify(JSON.parse(fs.readFileSync(spotsFile, "utf8")).filter((s) => bad.has(s.name))))
console.log([...bad].join(" "))
' "${REPLAY_OUT:-tools/last-replay.json}" "${REPLAY_SPOTS:-tools/stuck-spots.json}" "$RERUN")"
[ -n "$BAD" ] || { echo "verdict: REGRESSION (no rerun: a spot has no baseline entry)"; exit 1; }
echo "RERUN (flake check): $BAD — once, on a freshly reset world"
teardown
BODY_STARTED=
for _ in $(seq 1 30); do docker ps -a --format '{{.Names}}' 2>/dev/null | grep -qx "$CONTAINER" || break; sleep 1; done
boot
body_start
set +e; REPLAY_SPOTS="$RERUN" REPLAY_OUT="/tmp/stuck-rerun-$VARIANT${RIG_ID:+-$RIG_ID}.json" node tools/stuck-replay.js; rc=$?; set -e
case "$rc" in
  0) for s in $BAD; do echo "FLAKY $s: regressed on the first run (BASELINE line above), baseline held on the rerun"; done
     echo "verdict: FLAKY — $BAD (exit 0)"; exit 0 ;;
  1) echo "verdict: REGRESSION (repeated on the rerun)"; exit 1 ;;
  *) exit "$rc" ;;
esac
