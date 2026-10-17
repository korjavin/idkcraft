#!/bin/sh
# DEATHS PER DAY (idkcraft-neuc.65.1): per bot per UTC day, deaths by killer
# from the mc log, plus the enriched bot 'death health=' lines (time word,
# step, kit, distance to spawn) and the respawn lines (the death loop).
# Usage: sh deaths.sh [file...]   (no file = stdin; mc + bot dumps together)
# Input lines start "YYYY-MM-DD HH:MM:SS <name> <msg>", UTC:
#   mc:  2026-10-17 11:47:20 IdkBot was shot by Skeleton
#   bot: 2026-10-17 11:47:20 IdkBot death health=0 hostiles=1 at -51 71 -225 nearest=skeleton 2.5 time=night ...
#        2026-10-17 11:47:20 IdkBot respawn at 0 70 16 [(bed)] / ... respawned at 0 70 16
# Anything else is skipped. How to pull the dumps: README "Deaths per day".
# Env: SPAWN_XZ (world spawn x z, default "0 16"), SWARM_PREFIX (default
#   IdkSwarm: those names fold into one 'swarm' row), FROM / TO (YYYY-MM-DD,
#   inclusive day bounds), NEAR (spawn radius, default 60), LOOP_S (death
#   within this many seconds of a respawn at world spawn, default 300).
# Old-format death lines (before the enriched line) count with '?' facts;
# dist_spawn then comes from the 'at x y z' position.
# ponytail: one awk pass over time-sorted lines, no JSON output — the
# baseline JSON is copied by hand from the 'summary' lines.
cat "$@" | LC_ALL=C sort -s -k1,2 | awk \
  -v spawn="${SPAWN_XZ:-0 16}" -v swarm="${SWARM_PREFIX:-IdkSwarm}" \
  -v from="${FROM:-0000-00-00}" -v to="${TO:-9999-99-99}" \
  -v near="${NEAR:-60}" -v loops="${LOOP_S:-300}" '
function secs(d, t,   y, m, dd, a) {  # days-from-civil, good for sorting/diffs
  y = substr(d, 1, 4) + 0; m = substr(d, 6, 2) + 0; dd = substr(d, 9, 2) + 0
  if (m <= 2) { y--; m += 12 }
  a = 365 * y + int(y / 4) - int(y / 100) + int(y / 400) + int((153 * (m - 3) + 2) / 5) + dd
  return a * 86400 + substr(t, 1, 2) * 3600 + substr(t, 4, 2) * 60 + substr(t, 7, 2)
}
function who(n) { return index(n, swarm) == 1 ? "swarm" : n }
function bump(k) { if (!(k in cnt)) keys[++nk] = k; cnt[k]++ }
function top(prefix, n,   out, i, j, best, bk, used, c) {
  out = ""; split("", used)
  for (j = 0; j < n; j++) {
    best = 0; bk = ""
    for (i = 1; i <= nk; i++) if (index(keys[i], prefix) == 1 && !(keys[i] in used) && cnt[keys[i]] > best) { best = cnt[keys[i]]; bk = keys[i] }
    if (bk == "") break
    used[bk] = 1; c = substr(bk, length(prefix) + 1)
    out = out (out == "" ? "" : ",") c ":" best
  }
  return out == "" ? "none" : out
}
function killer(msg,   k, n) {
  if (match(msg, /^(was (slain|shot|impaled|blown up|killed|speared|doomed to fall) by|was burned to a crisp while fighting) /)) {
    k = substr(msg, RLENGTH + 1)
    sub(/ (using|whilst) .*$/, "", k)
    k = tolower(k); gsub(/ /, "_", k); return k
  }
  if (msg ~ /^drowned/) return "drowning"
  if (msg ~ /^fell from a high place/) return "fell"
  if (msg ~ /^hit the ground too hard/) return "hit-ground"
  if (msg ~ /^suffocated in a wall/) return "suffocated"
  if (msg ~ /^(burned to death|went up in flames|tried to swim in lava|starved to death|died|was (killed|squashed|pricked|struck|frozen|fireballed|stung|poked|squished))/) return "other"
  return ""
}
BEGIN { split(spawn, sp, " ") }
$1 ~ /^[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]$/ && $2 ~ /^[0-9][0-9]:[0-9][0-9]:[0-9][0-9]/ {
  d = $1; if (d < from || d > to) next
  b = who($3); msg = $0; sub(/^[^ ]+ [^ ]+ [^ ]+ /, "", msg)
  now = secs(d, $2)
  if ($4 == "respawn" || $4 == "respawned") {     # respawned (measured) overrides the claim
    if ($5 != "at" || $6 == "unknown") next
    atSpawn = (msg !~ /\(bed\)/ && (($6 - sp[1]) ^ 2 + ($8 - sp[2]) ^ 2) <= 64)
    lastAt[$3] = now; lastSpawn[$3] = atSpawn; next
  }
  if ($4 == "death" && $5 ~ /^health=/) {
    if (!((b, d) in seen)) { seen[b, d] = 1; rows[++nr] = b SUBSEP d }
    bump("L" b SUBSEP d); bump("L" b)
    tw = "?"; st = "?"; sw = ""; ds = ""
    for (i = 6; i <= NF; i++) {
      if ($i ~ /^time=/) tw = substr($i, 6)
      else if ($i ~ /^step=/) st = substr($i, 6)
      else if ($i ~ /^sword=/) sw = substr($i, 7)
      else if ($i ~ /^dist_spawn=/) ds = substr($i, 12)
      else if ($i == "at" && ds == "" && $(i + 1) != "unknown") ds = int(sqrt(($(i + 1) - sp[1]) ^ 2 + ($(i + 3) - sp[2]) ^ 2))
    }
    bump("T" b SUBSEP d SUBSEP tw); bump("S" b SUBSEP d SUBSEP st); bump("s" b SUBSEP st)
    if (sw != "") { bump("K" b SUBSEP d); bump("K" b); if (sw == "0") { bump("k" b SUBSEP d); bump("k" b) } }
    if (ds != "none" && ds != "" && ds + 0 <= near) bump("N" b SUBSEP d)
    if (($3 in lastAt) && lastSpawn[$3] && now - lastAt[$3] <= loops) { bump("R" b SUBSEP d); bump("R" b) }
    next
  }
  k = killer(msg); if (k == "" || $3 !~ /^[A-Za-z0-9_]+$/) next
  if (!((b, d) in seen)) { seen[b, d] = 1; rows[++nr] = b SUBSEP d }
  if (!(b in bots)) { bots[b] = 1; order[++nb] = b }
  if (!((b, d) in days)) { days[b, d] = 1; ndays[b]++ }
  bump("D" b SUBSEP d); bump("D" b); bump("X" b SUBSEP d SUBSEP k); bump("x" b SUBSEP k)
}
function c(k) { return (k in cnt) ? cnt[k] : 0 }
END {
  for (r = 1; r <= nr; r++) {
    split(rows[r], p, SUBSEP); b = p[1]; d = p[2]; key = b SUBSEP d; L = c("L" key)
    if (!(b in bots)) { bots[b] = 1; order[++nb] = b }
    printf "%s %s deaths=%d lines=%d\n", b, d, c("D" key), L
    printf "  killer %s\n", top("X" key SUBSEP, 99)
    printf "  time %s\n", top("T" key SUBSEP, 9)
    printf "  step %s\n", top("S" key SUBSEP, 99)
    printf "  kitless=%d/%d near_spawn=%d/%d loop=%d/%d\n", c("k" key), c("K" key), c("N" key), L, c("R" key), L
  }
  for (i = 1; i <= nb; i++) {
    b = order[i]; n = ndays[b] ? ndays[b] : 1
    printf "summary %s days=%d deaths=%d perDay=%.1f topKillers=%s topSteps=%s kitless=%d/%d loop=%d/%d\n", b, ndays[b], c("D" b), c("D" b) / n, top("x" b SUBSEP, 3), top("s" b SUBSEP, 3), c("k" b), c("K" b), c("R" b), c("L" b)
  }
}'
