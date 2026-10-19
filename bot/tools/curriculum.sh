#!/bin/sh
# NIGHTLY CURRICULUM RUNNER (idkcraft-vf8e.10): harvest -> propose ->
# reproduce -> skill-loop -> ledger, under a USD/day + attempts caps.
#
# The curriculum (vf8e.9) only names what to learn next; this closes the loop
# so the owner can run it unattended overnight (laptop rig only — learning
# never runs on prod) and find GREEN skills in the morning. A GREEN candidate
# ends with a PROMOTE line for the morning promotion (vf8e.4's
# skill-promote.js, whose PR carries the rig verdicts); the night job itself
# never opens PRs. Started by hand or by the orchestrator before an owner
# play session / overnight — there is no scheduler; the laptop sleeps and
# the owner decides.
#
# Usage: sh tools/curriculum.sh <bot-dump.txt> [days=7]
#   (the script cds to bot/ itself, so run it from anywhere as
#   sh bot/tools/curriculum.sh <dump>)
#
# Rig use: one keeper PER CANDIDATE on the one slot — boot (fresh world),
# pre-run + skill loop as inner runs on it, tear it down afterwards
# (laptop hygiene: containers stopped, one rig slot, no residue between
# candidates). A keeper that never comes up skips the night (exit 2).
#
# Env:
#   CURRICULUM_DIR (default /tmp/idkcraft-curriculum): work root — harvest
#     output, AUTO-<sig>/ work dirs, curriculum-ledger.json (never in git).
#   CURRICULUM_K (default 2): signatures attempted per run.
#   CURRICULUM_USD_PER_DAY (default 30): refuse to START a scenario once
#     today's ledger sum reaches it (exit 3 = budget).
#   CURRICULUM_MAX_ATTEMPTS (default 6): skill-loop attempts per scenario.
#   CURRICULUM_RIG_ID (default 0 = the default rig): the ONE rig slot; inner
#     runs serialise on it, never in parallel.
#   CURRICULUM_BODY (default empty = mineflayer replay): export REPLAY_BODY
#     for the keeper, the pre-run and the loop — set baritone when the
#     harvest feeds bot2 stalls, so the gate and the skill verify on v2.
#   RIG_LOCK_WAIT (default 7200): how long the keeper boot waits for a busy
#     rig; then the night is skipped (exit 2).
#   REPLAY_KEEP_IDLE (default 1800): keeper idle teardown, see stuck-run.sh.
#   SKILL_LOOP_MODEL/_EFFORT, LLM_TOKENS_PER_HOUR (vf8e.5, still applies
#     inside the loop), ANTHROPIC_API_KEY (else the stash, never printed).
#   CURRICULUM_LOOP: stub the skill loop (tests) — `sh $CURRICULUM_LOOP
#     <scenario> <max>` with SKILL_LOOP_DIR/_SCENARIOS/_SPOTS/_RIG set.
#     Default: node tools/skill-loop.js.
#   CURRICULUM_PRERUN: stub the no-skill reproduction run (tests) —
#     `sh $CURRICULUM_PRERUN <spots.json> <out.json>`. Default: an inner run
#     on the kept rig (REPLAY_BASELINE_OFF=1, no skills).
#   CURRICULUM_NO_KEEPER=1: skip the keeper boot/teardown (tests: the stubs
#     need no rig; refuses the real loop, which needs the keeper).
#
# Exit codes: 0 = night done (see the CURRICULUM line; loop REDs are ledger
#   data, not failures), 2 = environment failure (rig busy, keeper dead, a
#   stub missing — nothing reached a loop verdict), 3 = budget (today's sum
#   reached the cap: nothing more starts tonight).
set -e
HERE="$(dirname "$0")"
cd "$HERE/.."
DUMP="${1:-}"
DAYS="${2:-7}"
if [ -z "$DUMP" ] || [ ! -f "$DUMP" ]; then echo "usage: sh tools/curriculum.sh <bot-dump.txt> [days=7]"; exit 2; fi

K="${CURRICULUM_K:-2}"
WORK="${CURRICULUM_DIR:-/tmp/idkcraft-curriculum}"
CAP="${CURRICULUM_USD_PER_DAY:-30}"
MAXN="${CURRICULUM_MAX_ATTEMPTS:-6}"
SLOT="${CURRICULUM_RIG_ID:-0}"
LOCKWAIT="${RIG_LOCK_WAIT:-7200}"
NIGHT="$(date -u +%F)"
PICKF="$WORK/.pick.out"
case "$CAP" in ''|*[!0-9.]*|*.*.*) echo "curriculum: CURRICULUM_USD_PER_DAY must be a number (got '$CAP')"; exit 2 ;; esac

# The reproduction gate runs WITHOUT skills: never let an operator export leak in.
unset SKILLS_DIR REPLAY_SKILLS_DIR BOT_SKILLS
# Body (revmux 01 core-2): the harvest feeds bot2 stalls by default, so the
# gate and the loop run on the v2 Baritone body when the operator asks —
# CURRICULUM_BODY=baritone. Empty (default) is today's mineflayer replay.
# The loop inherits it and records it in result.json; the ledger records it
# too, and the morning promotion (vf8e.4) refuses a body mismatch.
if [ -n "${CURRICULUM_BODY:-}" ]; then export REPLAY_BODY="$CURRICULUM_BODY"; fi

KEEPER=""
on_exit() {
  rc=$?
  if [ -n "$KEEPER" ]; then kill "$KEEPER" 2>/dev/null || true; wait "$KEEPER" 2>/dev/null || true; fi
  exit "$rc"
}
trap on_exit EXIT

kill_keeper() {
  if [ -n "$KEEPER" ]; then kill "$KEEPER" 2>/dev/null || true; wait "$KEEPER" 2>/dev/null || true; fi
  KEEPER=""
}

# Boot the candidate's keeper (no spots: the pre-run is the first run).
# Prints the kept line, or fails after RIG_LOCK_WAIT + boot time.
boot_keeper() {
  KLOG="$CAND/keeper.log"
  : > "$KLOG"
  REPLAY_KEEP=1 RIG_ID="$SLOT" RIG_LOCK_WAIT="$LOCKWAIT" REPLAY_BASELINE_OFF=1 \
    REPLAY_KEEP_IDLE="${REPLAY_KEEP_IDLE:-1800}" \
    sh tools/stuck-run.sh paper-base >"$KLOG" 2>&1 &
  KEEPER=$!
  waited=0
  limit=$((LOCKWAIT + 900))
  while kill -0 "$KEEPER" 2>/dev/null; do
    if grep -q "kept: rig .* up" "$KLOG" 2>/dev/null; then break; fi
    if [ "$waited" -ge "$limit" ]; then break; fi
    sleep 5
    waited=$((waited + 5))
  done
  if grep -q "kept: rig .* up" "$KLOG" 2>/dev/null; then
    echo "curriculum: $(grep "kept: rig .* up" "$KLOG" | tail -n 1) (log $KLOG)"
  else
    tail -n 5 "$KLOG" 2>/dev/null || true
    return 1
  fi
}

mkdir -p "$WORK"

# A model key is needed for every loop: fail before booting the rig.
if [ -z "${CURRICULUM_LOOP:-}" ]; then
  if [ -z "${ANTHROPIC_API_KEY:-}" ]; then
    KV="$HOME/.local/bin/kv"
    [ -x "$KV" ] || KV="kv"
    ANTHROPIC_API_KEY="$("$KV" get secrets/minecraft/anthropic-api-key 2>/dev/null || true)"
    export ANTHROPIC_API_KEY
  fi
  if [ -z "${ANTHROPIC_API_KEY:-}" ]; then
    echo "curriculum: no ANTHROPIC_API_KEY (stash secrets/minecraft/anthropic-api-key) — nothing to spend, skipping the night"
    exit 2
  fi
fi

# 1. harvest, then the top-K pick (ledger rules live in curriculum.js).
node tools/curriculum.js harvest "$DUMP" "$DAYS" || exit 2
node tools/curriculum.js pick "$K" > "$PICKF" || exit 2
NSKIP0=$(grep -c '^skip ' "$PICKF" || true)
grep '^skip ' "$PICKF" | while read -r _ s why; do echo "CURRICULUM $s skipped: $why"; done
TOTAL=$(grep -c '^pick ' "$PICKF" || true)
if [ "$TOTAL" = 0 ]; then
  echo "CURRICULUM night=$NIGHT tried=0 green=0 red=0 skipped=$NSKIP0 cost=\$0.00"
  exit 0
fi

# Test mode skips every keeper boot (the stubs need no rig); the real
# pre-run and the real loop need the keeper, so both stubs are required.
if [ "${CURRICULUM_NO_KEEPER:-}" = 1 ]; then
  if [ -z "${CURRICULUM_LOOP:-}" ] || [ -z "${CURRICULUM_PRERUN:-}" ]; then
    echo "curriculum: CURRICULUM_NO_KEEPER=1 needs CURRICULUM_LOOP=<stub> and CURRICULUM_PRERUN=<stub>"
    exit 2
  fi
  echo "curriculum: no keeper (CURRICULUM_NO_KEEPER=1)"
fi

tried=0
ngreen=0
nred=0
skipped=$NSKIP0
session="0.00"
ENVFAIL=0
BUDGET=0
i=0
for SIG in $(grep '^pick ' "$PICKF" | awk '{print $2}' || true); do
  i=$((i + 1))
  SPENT="$(node tools/curriculum.js spent)"
  if awk "BEGIN{exit !( $SPENT >= $CAP )}"; then
    echo "CURRICULUM $SIG budget: today \$$SPENT >= \$$CAP cap — refusing to start (exit 3)"
    skipped=$((skipped + (TOTAL - i + 1)))
    BUDGET=1
    break
  fi
  CAND="$WORK/AUTO-$SIG"
  if ! node tools/curriculum.js propose "$SIG" >"$WORK/.propose-$SIG.log" 2>&1; then
    echo "CURRICULUM $SIG skipped: propose failed ($(tail -n 1 "$WORK/.propose-$SIG.log"))"
    skipped=$((skipped + 1))
    continue
  fi
  SCN="$CAND/scenario.json"
  SPOTS="$CAND/spots.json"
  NAME="$(node -p "JSON.parse(require('fs').readFileSync('$SCN','utf8'))[0].name")"
  SKILL="$(node -p "JSON.parse(require('fs').readFileSync('$SCN','utf8'))[0].skill")"
  SCBEAD="$(node -p "JSON.parse(require('fs').readFileSync('$SCN','utf8'))[0].bead")"
  # The candidate's keeper (fresh world); torn down right after it.
  if [ "${CURRICULUM_NO_KEEPER:-}" != 1 ]; then
    if ! boot_keeper; then
      echo "CURRICULUM $SIG env: keeper never kept (rig busy?) — skipping the night (see $CAND/keeper.log)"
      ENVFAIL=1
      skipped=$((skipped + (TOTAL - i + 1)))
      break
    fi
  fi
  # 2. reproduction gate: one micro-run WITHOUT a skill. Anything but RED
  # is not-reproduced: the ledger records it and no model tokens are spent.
  PRC=0
  if [ -n "${CURRICULUM_PRERUN:-}" ]; then
    sh "$CURRICULUM_PRERUN" "$SPOTS" "$CAND/pre.json" >"$CAND/pre.log" 2>&1 || PRC=$?
  else
    REPLAY_KEEP=1 RIG_ID="$SLOT" REPLAY_BASELINE_OFF=1 REPLAY_OUT="$CAND/pre.json" \
      sh tools/stuck-run.sh paper-base "$SPOTS" >"$CAND/pre.log" 2>&1 || PRC=$?
  fi
  if [ ! -f "$CAND/pre.json" ]; then
    echo "CURRICULUM $SIG env: pre-run failed (rc $PRC, see $CAND/pre.log) — not RED, cap unspent"
    kill_keeper
    ENVFAIL=1
    skipped=$((skipped + 1))
    continue
  fi
  tried=$((tried + 1))
  GRC=0
  node tools/curriculum.js gate "$CAND/pre.json" >"$CAND/gate.log" 2>&1 || GRC=$?
  if [ "$GRC" = 2 ]; then
    echo "CURRICULUM $SIG env: gate unreadable ($(cat "$CAND/gate.log")) — not RED, cap unspent"
    kill_keeper
    ENVFAIL=1
    skipped=$((skipped + 1))
    continue
  fi
  if [ "$GRC" = 1 ]; then
    echo "CURRICULUM $SIG not-reproduced: $(cat "$CAND/gate.log") — spending nothing"
    node tools/curriculum.js record "$SIG" not-reproduced
    kill_keeper
    skipped=$((skipped + 1))
    continue
  fi
  echo "CURRICULUM $SIG RED: $(cat "$CAND/gate.log")"
  # 3. the skill loop, on the same keeper. Its result.json carries the cost
  # per attempt (the PRICE table) — summed from there, never re-estimated.
  # Exit 2 is an environment failure (keeper never kept, network): not RED,
  # and the cap is not spent on it.
  LOOPD="$CAND/loop"
  LRC=0
  if [ -n "${CURRICULUM_LOOP:-}" ]; then
    SKILL_LOOP_DIR="$LOOPD" SKILL_LOOP_SCENARIOS="$SCN" SKILL_LOOP_SPOTS="$SPOTS" SKILL_LOOP_RIG="$SLOT" \
      sh "$CURRICULUM_LOOP" "$NAME" "$MAXN" >"$CAND/loop.log" 2>&1 || LRC=$?
  else
    SKILL_LOOP_DIR="$LOOPD" SKILL_LOOP_SCENARIOS="$SCN" SKILL_LOOP_SPOTS="$SPOTS" SKILL_LOOP_RIG="$SLOT" \
      node tools/skill-loop.js "$NAME" "$MAXN" >"$CAND/loop.log" 2>&1 || LRC=$?
  fi
  kill_keeper
  RES="$LOOPD/result.json"
  if [ ! -f "$RES" ]; then
    echo "CURRICULUM $SIG env: loop rc $LRC but no $RES (see $CAND/loop.log) — not RED, cap unspent"
    ENVFAIL=1
    skipped=$((skipped + 1))
    continue
  fi
  COST="$(node -p "Number(JSON.parse(require('fs').readFileSync('$RES','utf8')).cost||0).toFixed(2)")"
  ATTN="$(node -p "JSON.parse(require('fs').readFileSync('$RES','utf8')).attempts||0")"
  session="$(awk "BEGIN{printf \"%.2f\", $session + $COST}")"
  if [ "$LRC" = 0 ]; then
    SKILLF="$LOOPD/skills/$SKILL.js"
    node tools/curriculum.js record "$SIG" GREEN:unpromoted "$RES" "$SKILLF"
    ngreen=$((ngreen + 1))
    echo "CURRICULUM $SIG GREEN attempts=$ATTN cost=\$$COST skill=$SKILLF"
    # The promotion refuses a body mismatch (vf8e.4): carry the night's body.
    PROMOTE_ENV=""
    [ -n "${REPLAY_BODY:-}" ] && PROMOTE_ENV="REPLAY_BODY=$REPLAY_BODY "
    echo "PROMOTE: ${PROMOTE_ENV}node tools/skill-promote.js $SCBEAD $SKILLF  # scenario $SCN spot $SPOTS result $RES (run from bot/)"
  elif [ "$LRC" = 1 ]; then
    node tools/curriculum.js record "$SIG" RED "$RES"
    nred=$((nred + 1))
    echo "CURRICULUM $SIG RED attempts=$ATTN cost=\$$COST (see $RES)"
  else
    # Exit 2 is an environment failure: never RED, reds is not bumped. But
    # dollars actually spent (paid attempts before the failure) still reach
    # the ledger, or the $ cap goes blind (revmux 01 core-1).
    if awk "BEGIN{exit !($COST > 0)}"; then
      node tools/curriculum.js record "$SIG" env "$RES"
      echo "CURRICULUM $SIG env: skill-loop exit $LRC ($(tail -n 1 "$CAND/loop.log")) — not RED, spend \$$COST recorded"
    else
      echo "CURRICULUM $SIG env: skill-loop exit $LRC ($(tail -n 1 "$CAND/loop.log")) — not RED, cap unspent"
    fi
    ENVFAIL=1
    skipped=$((skipped + 1))
  fi
done

echo "CURRICULUM night=$NIGHT tried=$tried green=$ngreen red=$nred skipped=$skipped cost=\$$session"
if [ "$BUDGET" = 1 ]; then exit 3; fi
if [ "$ENVFAIL" = 1 ] && [ "$ngreen" = 0 ] && [ "$nred" = 0 ]; then exit 2; fi
exit 0
