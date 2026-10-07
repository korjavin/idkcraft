#!/bin/sh
# CYCLES (idkcraft-vmzq.23): run N castle-rig cycles unattended, one table.
# Usage: sh cycles.sh N [mins]   (mins default: $CASTLE_MINS, else 6)
# Each cycle runs castle-rig.sh (own lock/window, sequential — no bursts at
# the JEV endpoint); the verdict line (or FAIL) lands in one table row.
# Env: passed through to castle-rig.sh — RIG_PLANNER (default jev),
#   TYPESAFE_API_KEY (or the stash fallback), CASTLE_RIG_ID=auto with
#   CASTLE_LOCK_WAIT to share the box, CASTLE_KIT, CASTLE_OUT (one worktree
#   run needs a distinct file per cycle — set CASTLE_OUT per cycle or the
#   last cycle wins; the table keeps every verdict line regardless).
# Exit: 0 when every cycle measured (even 0 laid); 1 when any cycle failed
#   to measure (its FAIL row names the reason; full output per cycle is in
#   the per-cycle log under /tmp).
set -u
N="${1:-}"
case "$N" in ''|*[!0-9]*) echo "cycles: want a positive integer N, got '$N'"; exit 2 ;; esac
[ "$N" -ge 1 ] || { echo "cycles: want a positive integer N, got '$N'"; exit 2; }
MINS="${2:-${CASTLE_MINS:-6}}"
case "$MINS" in ''|*[!0-9]*) echo "cycles: want a positive integer mins, got '$MINS'"; exit 2 ;; esac
[ "$MINS" -ge 1 ] || { echo "cycles: want a positive integer mins, got '$MINS'"; exit 2; }
HERE="$(dirname "$0")"
echo "cycles: N=$N mins=$MINS planner=${RIG_PLANNER:-jev} kit=${CASTLE_KIT:-empty} rig=${CASTLE_RIG_ID:-0}"
fails=0
i=1
while [ "$i" -le "$N" ]; do
  CLOG="/tmp/castle-cycle-$i-$$.log"
  if CASTLE_MINS="$MINS" sh "$HERE/castle-rig.sh" "$MINS" >"$CLOG" 2>&1; then
    line="$(grep -E '^castle [0-9]+/[0-9]+ in ' "$CLOG" | tail -n 1)"
    if [ -n "$line" ]; then
      echo "cycle $i/$N: $line"
    else
      echo "cycle $i/$N: NO-VERDICT (see $CLOG)"
      fails=$((fails + 1))
    fi
  else
    rc=$?
    why="$(grep -E 'CASTLE-RIG (SETUP-FAIL|FATAL)|rig busy|interrupted|RIG_PLANNER|TYPESAFE' "$CLOG" | tail -n 1)"
    echo "cycle $i/$N: FAIL rc=$rc ${why:-"(see $CLOG)"}"
    fails=$((fails + 1))
  fi
  i=$((i + 1))
done
echo "cycles: done fails=$fails/$N"
[ "$fails" -eq 0 ]
