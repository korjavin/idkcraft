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
# risky = the files where every stuck/livelock regression of 09-22..28 landed, plus the
# pathfinder/Movements customisations and packet taps that change what the server accepts
RISKY='bot/src/index\.js|bot/src/goal\.js|bot/src/brain\.js|bot/src/behaviours/recover\.js|bot/src/behaviours/follow\.js|bot/src/(jumpcost|nocorner|swim|snow|unpin|decontact|detour)\.js|laya/'
INFRA='^(docker-compose\.yml|Dockerfile|\.github/|\.env|bot/Dockerfile|laya/Dockerfile|\.revmux/)'
FILES="$(git diff --name-only "$BASE...HEAD")"
if [ -z "$PROFILE" ]; then
  if echo "$FILES" | rg -q "$RISKY" || git diff "$BASE...HEAD" | rg -q '^\+.*(Movements|allowSprinting|canDig|allowParkour|scafoldingBlocks|blocksCantBreak)'; then PROFILE=idkcraft-risky; else PROFILE=idkcraft; fi
fi
SYNTH=""; [ "$PROFILE" = idkcraft ] && SYNTH="--no-synthesis"   # one agent: nothing to merge; risky panel of two keeps synthesis (25% duplicate pairs without it)
# CI/compose/Dockerfile/env/.revmux-only diff: the tests lens alone (it carries the wiring checks). LENSES= overrides.
LENSFLAG=""
if [ -n "$LENSES" ]; then LENSFLAG="--lenses $LENSES"
elif [ -n "$FILES" ] && ! echo "$FILES" | rg -qv "$INFRA"; then LENSFLAG="--lenses tests"; fi
mkdir -p "$TASKS"
revmux new --task "$BEAD" --run "$RUN" --tasks-dir "$TASKS" --workdir "$PWD" >/dev/null 2>&1 || true
IN="$TASKS/$BEAD/$RUN/input"; mkdir -p "$IN"
OUT="$TASKS/$BEAD/$RUN/findings.json"
mkdir -p "$IN/context"
if [ -n "$PREV" ]; then
  # default REVIEWED_SHA: the sha the previous round recorded
  [ -n "$REVIEWED_SHA" ] || REVIEWED_SHA="$(cat "$(dirname "$PREV")/reviewed-sha" 2>/dev/null || true)"
  FROM="${REVIEWED_SHA:?set REVIEWED_SHA=<sha reviewed by the previous round>}"
  DIFFCMD="git diff $FROM..HEAD"
  STAT="$(git diff --shortstat "$FROM..HEAD")"; FILES="$(git diff --name-only "$FROM..HEAD")"
  # every earlier round's findings, named after its run dir (round 3 sees r1 and r2)
  for f in "$TASKS/$BEAD"/*/findings.json; do
    [ "$f" = "$OUT" ] && continue
    [ -s "$f" ] && cp "$f" "$IN/context/findings-$(basename "$(dirname "$f")").json"
  done
  [ -s "$IN/context/findings-$(basename "$(dirname "$PREV")").json" ] || cp "$PREV" "$IN/context/findings-$(basename "$(dirname "$PREV")").json"
  EXTRA="- Round 2+: review only the fix delta above; earlier rounds' findings are context/findings-*.json — do not re-raise settled ones, do flag a gating one that repeats unchanged."
else
  DIFFCMD="git diff $BASE...HEAD"; STAT="$(git diff --shortstat "$BASE...HEAD")"; EXTRA=""
fi
# STUCKRUN=<stuck-run.sh output/JSON> puts the oracle numbers (vs stuck-baseline.json) in front of the reviewer
[ -n "$STUCKRUN" ] && cp "$STUCKRUN" "$IN/context/stuck-run.txt"
bd show "$BEAD" > "$IN/context/bead.md" 2>/dev/null || true
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
  if [ -n "$STUCKRUN" ]; then echo "- Movement/stuck change: stuck-run.sh numbers vs stuck-baseline.json are in context/stuck-run.txt — a spot that got worse is a major."
  elif [ "$PROFILE" = idkcraft-risky ]; then echo "- Movement/stuck change with NO stuck-run.sh numbers supplied (STUCKRUN unset): report it as a major (tests lens) unless the diff cannot change movement."; fi
} > "$IN/goal.md"
revmux --task "$BEAD" --run "$RUN" --tasks-dir "$TASKS" --workdir "$PWD" --profile "$PROFILE" --no-tui $SYNTH $LENSFLAG > "$OUT.stdout" 2> "$TASKS/$BEAD/$RUN/revmux.log" || true
[ -s "$OUT" ] || cp "$OUT.stdout" "$OUT"
jq -e '.findings' "$OUT" >/dev/null 2>&1 || { echo "revmux produced no findings.json — crashed, see $TASKS/$BEAD/$RUN/revmux.log"; exit 2; }
git rev-parse HEAD > "$TASKS/$BEAD/$RUN/reviewed-sha"
echo "profile=$PROFILE ${LENSFLAG:+lenses=$LENSES} archive=$TASKS/$BEAD/$RUN"
if jq -e '.sources.degraded | length > 0' "$OUT" >/dev/null 2>&1; then echo "DEGRADED review — not a verdict"; jq '.sources.degraded' "$OUT"; exit 2; fi
G="$(jq '[.findings[] | select(.severity=="critical" or .severity=="major")] | length' "$OUT")"
M="$(jq '[.findings[] | select(.severity=="minor")] | length' "$OUT")"
jq -r '.findings[] | select(.severity=="critical" or .severity=="major") | "[\(.severity)] \(.file):\(.line) \(.title)\n    \(.body|gsub("\n";" ")|.[0:400])\n    fix: \(.fix//""|gsub("\n";" ")|.[0:300])"' "$OUT"
echo "gating=$G minors=$M (minors: fix in the same commit, no new round — see $OUT)"
[ "$G" = 0 ]
