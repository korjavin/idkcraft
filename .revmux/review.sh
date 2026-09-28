#!/bin/sh
# One-command revmux round for an idkcraft bead (process audit 2026-09-29).
# Usage: .revmux/review.sh <bead-id> <round-name> [profile]
#   e.g. .revmux/review.sh idkcraft-abc 01-review
# Run from the branch's worktree. Does, in order:
#   1. privacy pre-check (CLAUDE.md) — any hit aborts, exit 3
#   2. picks the profile from the diff when not given: idkcraft-risky if the
#      diff touches index.js, goal.js, brain.js, recover.js, follow.js,
#      Movements/pathfinder settings or laya/; else idkcraft
#   3. writes scope.md / goal.md from the diff and `bd show` (acceptance)
#   4. runs revmux with the archive in the MAIN checkout's .revmux/tasks
#      (survives `git worktree remove`; the orchestrator reads it from there)
#   5. prints critical/major findings only; exit 1 if any, 0 if clean
# Round 2+: pass the previous round's findings path via PREV=<findings.json>;
# scope becomes the fix delta since REVIEWED_SHA (default: the previous
# round's HEAD recorded in the archive).
set -e
BEAD="$1"; RUN="$2"; PROFILE="$3"
[ -n "$BEAD" ] && [ -n "$RUN" ] || { echo "usage: review.sh <bead-id> <round> [profile]"; exit 2; }
MAIN="${IDKCRAFT_MAIN:-/Users/iv/Projects/idkcraft}"
TASKS="$MAIN/.revmux/tasks"
BASE="${BASE:-origin/master}"
git fetch -q origin
if git diff "$BASE...HEAD" | rg -n '^\+.*(\b\d{1,3}(\.\d{1,3}){3}\b|(api[_-]?key|secret|token)\s*[:=]\s*\S{8,})'; then
  echo "PRIVACY PRE-CHECK HIT — fix before any review"; exit 3
fi
RISKY='bot/src/index\.js|bot/src/goal\.js|bot/src/brain\.js|bot/src/behaviours/recover\.js|bot/src/behaviours/follow\.js|bot/src/stuck\.js|laya/'
FILES="$(git diff --name-only "$BASE...HEAD")"
if [ -z "$PROFILE" ]; then
  if echo "$FILES" | rg -q "$RISKY" || git diff "$BASE...HEAD" | rg -q '^\+.*(Movements|allowSprinting|canDig|allowParkour|scafoldingBlocks|blocksCantBreak)'; then PROFILE=idkcraft-risky; else PROFILE=idkcraft; fi
fi
SYNTH=""; [ "$PROFILE" = idkcraft ] && SYNTH="--no-synthesis"   # one agent: nothing to merge; risky panel of two keeps synthesis (25% duplicate pairs without it)
mkdir -p "$TASKS"
revmux new --task "$BEAD" --run "$RUN" --tasks-dir "$TASKS" --workdir "$PWD" >/dev/null 2>&1 || true
IN="$TASKS/$BEAD/$RUN/input"; mkdir -p "$IN"
STAT="$(git diff --shortstat "$BASE...HEAD")"
if [ -n "$PREV" ]; then
  FROM="${REVIEWED_SHA:?set REVIEWED_SHA=<sha reviewed by the previous round>}"
  DIFFCMD="git diff $FROM..HEAD"
  cp "$PREV" "$IN/findings-prev.json"
  EXTRA="- Round 2+: review only the fix delta above; previous findings in input/findings-prev.json — do not re-raise settled ones, do flag a gating one that repeats unchanged."
else
  DIFFCMD="git diff $BASE...HEAD"; EXTRA=""
fi
{
  echo "# Scope: $BEAD ($STAT)"
  echo "- Diff: \`$DIFFCMD\` (branch $(git rev-parse --abbrev-ref HEAD) @ $(git rev-parse --short HEAD))"
  echo "- Files:"; echo "$FILES" | sed 's/^/  - /'
  echo "- Read in full: the changed functions and their direct callers; the tests the diff touches."
  echo "- Ignore: .beads/, node_modules, worktree junk. Tests already ran green (npm test in bot/) — do not run them."
  [ -n "$EXTRA" ] && echo "$EXTRA"
} > "$IN/scope.md"
{
  echo "# Merge gate: $BEAD — correct only if the bead's acceptance holds"
  bd show "$BEAD" 2>/dev/null | sed -n '/DESCRIPTION/,/NOTES/p' | rg -i -A20 'ПРИЁМКА|ACCEPTANCE|Acceptance' | head -30 || true
  echo "- Movement/stuck change: PR must carry stuck-run.sh before/after numbers; absent = major (tests lens)."
} > "$IN/goal.md"
OUT="$TASKS/$BEAD/$RUN/findings.json"
revmux --task "$BEAD" --run "$RUN" --tasks-dir "$TASKS" --workdir "$PWD" --profile "$PROFILE" --no-tui $SYNTH > "$OUT.stdout" 2> "$TASKS/$BEAD/$RUN/revmux.log" || true
[ -s "$OUT" ] || cp "$OUT.stdout" "$OUT"
git rev-parse HEAD > "$TASKS/$BEAD/$RUN/reviewed-sha"
echo "profile=$PROFILE archive=$TASKS/$BEAD/$RUN"
if jq -e '.sources.degraded | length > 0' "$OUT" >/dev/null 2>&1; then echo "DEGRADED review — not a verdict"; jq '.sources.degraded' "$OUT"; exit 2; fi
G="$(jq '[.findings[] | select(.severity=="critical" or .severity=="major")] | length' "$OUT")"
M="$(jq '[.findings[] | select(.severity=="minor")] | length' "$OUT")"
jq -r '.findings[] | select(.severity=="critical" or .severity=="major") | "[\(.severity)] \(.file):\(.line) \(.title)\n    \(.body|gsub("\n";" ")|.[0:400])\n    fix: \(.fix//""|gsub("\n";" ")|.[0:300])"' "$OUT"
echo "gating=$G minors=$M (minors: fix in the same commit, no new round — see $OUT)"
[ "$G" = 0 ]
