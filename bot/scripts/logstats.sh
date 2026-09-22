#!/bin/sh
# logstats.sh — offline summary of a saved bot log.
# Usage: sh bot/scripts/logstats.sh bot.log
# The log is whatever `docker logs --timestamps <container> > bot.log 2>&1`
# saved (timestamps optional; 2>&1 matters — disagree and tick-error lines
# go to stderr and are lost without it). Exit 0, prints counts even when zero.
log="${1:?usage: sh bot/scripts/logstats.sh bot.log}"
if [ ! -r "$log" ]; then
  echo "no such file: $log" >&2
  exit 1
fi
lines=$(wc -l < "$log" | tr -d ' ')
echo "lines: $lines"
echo "--- per action= ---"
actions=$(grep -o -E 'action=[A-Za-z_-]+' "$log" | sort | uniq -c | sort -rn)
[ -n "$actions" ] || actions='(none)'
printf '%s\n' "$actions"
echo "--- per source= ---"
# Decision lines only: 'brain disagree' lines also carry source= and would
# double-count every tick the model diverged from the reference policy.
sources=$(grep 'decision ' "$log" | grep -o -E 'source=[A-Za-z_-]+' | sort | uniq -c | sort -rn)
[ -n "$sources" ] || sources='(none)'
printf '%s\n' "$sources"
echo "brain disagree: $(grep -c 'brain disagree' "$log" || true)"
echo "route easy: $(grep -c 'brain route=easy' "$log" || true)"
echo "route hard: $(grep -c 'brain route=hard' "$log" || true)"
echo "--- per reason= (hard only) ---"
reasons=$(grep 'brain route=hard' "$log" | grep -o -E 'reason=[A-Za-z_-]+' | sort | uniq -c | sort -rn)
[ -n "$reasons" ] || reasons='(none)'
printf '%s\n' "$reasons"
echo "stub-fallback: $(grep 'decision ' "$log" | grep -c 'stub-fallback' || true)"
echo "deaths: $(grep -c -E '(^| )death health=' "$log" || true)"
echo "respawns: $(grep -c -E '(^| )respawn at ' "$log" || true)"
echo "tick errors: $(grep -c 'tick error' "$log" || true)"
first=$(grep -o -E '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+[^ ]*' "$log" | head -n 1)
last=$(grep -o -E '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+[^ ]*' "$log" | tail -n 1)
if [ -n "$first" ]; then
  echo "first: $first"
  echo "last: $last"
else
  echo "span: no timestamps (re-save with: docker logs --timestamps <container> > bot.log 2>&1)"
fi
