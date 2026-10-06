#!/bin/sh
# UNATTENDED BUILD ORACLE (idkcraft-vmzq.1): order a build on prod, leave,
# and judge it from the logs.
#
# Regime (the owner's case: "give the order and leave"): the puppet joins,
# says the order, confirms the bot's reply, and QUITS — progress is read
# from VictoriaLogs, not from the puppet. Nobody online, BOT_AUTONOMOUS on.
# A deploy restart mid-run must NOT void the run (resume + record it); a
# human joining voids it (exit 2, never rejoin).
#
# Usage: sh bot/tools/task-run.sh <house|castle> [budget-min]
#   house:  `build here` on a new site (moves the home, builds with what
#           the bot has). Default budget 180 min.
#   castle: `build castle` (or monitor the existing one when the bot answers
#           `I already have a castle at ...`). Default budget 480 min.
# Exit codes:
#   0  done within budget (`home done at` / `castle done at` in the window;
#      a house done over unhealed `build skip` lines is PARTIAL, not done)
#   1  budget exceeded (prints the last 20 bot lines + the last progress
#      line), castle with no site, or a partial house
#   2  environment: bad args, stash/kv/logs unreachable (up front or 3 dead
#      polls mid-run), puppet refused (human online), the bot never seen,
#      no order reply, human void, bot autonomy unverified (bot gone and
#      resumes exhausted)
#
# Secrets resolve at runtime and never print: MC host/port from the exact
# secrets/idkcraft-mc-host + secrets/idkcraft-mc-port keys; the
# Grafana/Portainer keys resolve FUZZY by generic words (like the
# session-review key() helper — no infra labels in this repo): the first
# stash key whose segments contain all of [portainer url], [portainer api
# key], [grafana token]. Env seams (tests/operators):
#   TASK_RUN_KV (default ~/.local/bin/kv), TASK_RUN_MC_HOST_KEY,
#   TASK_RUN_MC_PORT_KEY, TASK_RUN_PORTAINER_URL_KEY,
#   TASK_RUN_PORTAINER_API_KEY_KEY, TASK_RUN_GRAFANA_TOKEN_KEY (exact
#   overrides; unset = fuzzy), TASK_RUN_MC_HOST, TASK_RUN_MC_PORT,
#   TASK_RUN_LOGS_URL, TASK_RUN_GRAFANA_TOKEN, TASK_RUN_PUPPET_CMD,
#   TASK_RUN_HTTP_PORT (18080), TASK_RUN_BOT_NAME (IdkBot),
#   TASK_RUN_PUPPET_NAME (IdkTester), TASK_RUN_POLL_SECS (600),
#   TASK_RUN_BUDGET_SECS, TASK_RUN_MEET_SECS (720), TASK_RUN_REPLY_SECS (90),
#   TASK_RUN_BOT_WAIT_SECS (60), TASK_RUN_SKIP_HORIZON_SECS (3900),
#   TASK_RUN_LOGS_SCHEME (https), TASK_RUN_RESUMES (3), TASK_RUN_OUTDIR (/tmp)
#
# Every run prints the UTC window start and the VictoriaLogs queries to
# re-judge it by hand, and writes a progress-series JSON next to the
# puppet transcript under TASK_RUN_OUTDIR.
set -u

TASK="${1:-}"
BUDGET_MIN="${2:-}"
case "$TASK" in house | castle) : ;; *) echo "usage: task-run.sh <house|castle> [budget-min]" >&2; exit 2 ;; esac
if [ -z "$BUDGET_MIN" ]; then
  if [ "$TASK" = house ]; then BUDGET_MIN=180; else BUDGET_MIN=480; fi
fi
case "$BUDGET_MIN" in *[!0-9]* | '' | 0) echo "task-run: budget-min must be a positive integer (got '$BUDGET_MIN')" >&2; exit 2 ;; esac

TOOLS="$(cd "$(dirname "$0")" && pwd)"
KV="${TASK_RUN_KV:-$HOME/.local/bin/kv}"
MC_HOST_KEY="${TASK_RUN_MC_HOST_KEY:-secrets/idkcraft-mc-host}"
MC_PORT_KEY="${TASK_RUN_MC_PORT_KEY:-secrets/idkcraft-mc-port}"
PORTAINER_URL_KEY="${TASK_RUN_PORTAINER_URL_KEY:-}"
PORTAINER_API_KEY_KEY="${TASK_RUN_PORTAINER_API_KEY_KEY:-}"
GRAFANA_TOKEN_KEY="${TASK_RUN_GRAFANA_TOKEN_KEY:-}"
PUPPET_CMD="${TASK_RUN_PUPPET_CMD:-node $TOOLS/puppet.js}"
HTTP_PORT="${TASK_RUN_HTTP_PORT:-18080}"
BOT_NAME="${TASK_RUN_BOT_NAME:-IdkBot}"
PUPPET_NAME="${TASK_RUN_PUPPET_NAME:-IdkTester}"
POLL_SECS="${TASK_RUN_POLL_SECS:-600}"
MEET_SECS="${TASK_RUN_MEET_SECS:-720}"
REPLY_SECS="${TASK_RUN_REPLY_SECS:-90}"
BOT_WAIT_SECS="${TASK_RUN_BOT_WAIT_SECS:-60}"
SKIP_HORIZON_SECS="${TASK_RUN_SKIP_HORIZON_SECS:-3900}"
LOGS_SCHEME="${TASK_RUN_LOGS_SCHEME:-https}"
MAX_RESUMES="${TASK_RUN_RESUMES:-3}"
OUTDIR="${TASK_RUN_OUTDIR:-/tmp}"
C="localhost:$HTTP_PORT"

command -v curl >/dev/null 2>&1 || { echo "task-run: need curl" >&2; exit 2; }
command -v python3 >/dev/null 2>&1 || { echo "task-run: need python3" >&2; exit 2; }
case "$PUPPET_CMD" in node\ *) command -v node >/dev/null 2>&1 || { echo "task-run: need node" >&2; exit 2; } ;; esac
[ -d "$OUTDIR" ] && [ -w "$OUTDIR" ] || { echo "task-run: OUTDIR not writable: $OUTDIR" >&2; exit 2; }

now_epoch() { date +%s; }
now_utc() { date -u +%Y-%m-%dT%H:%M:%SZ; }
STAMP="$(date -u +%Y%m%dT%H%M%SZ)-$$"
SERIES="$OUTDIR/task-run-$TASK-$STAMP.series.json"
JOURNAL="$OUTDIR/task-run-$TASK-$STAMP.journal.jsonl"
: >"$JOURNAL" || { echo "task-run: cannot write $JOURNAL" >&2; exit 2; }

kvget() { "$KV" get "$1" 2>/dev/null || true; }

# Fuzzy stash-key resolution (revmux 01 critical): the first key under
# secrets/ whose segments (split on non-alphanumerics) contain every given
# word. No infra labels in this repo — the words are generic. Prints the
# key, or nothing when kv fails or nothing matches.
kvkey() {
  "$KV" ls secrets 2>/dev/null | python3 -c '
import json,sys,re
try:
  keys = json.load(sys.stdin)
except Exception:
  sys.exit(0)
words = [w.lower() for w in sys.argv[1:]]
for e in keys if isinstance(keys, list) else []:
  segs = set(re.split(r"[^a-z0-9]+", (e.get("key") or "").lower()))
  if all(w in segs for w in words):
    print(e["key"])
    sys.exit(0)
' "$@"
}

# --- resolve the MC endpoint (never printed) ---
MC_HOST="${TASK_RUN_MC_HOST:-}"
if [ -z "$MC_HOST" ]; then MC_HOST="$(kvget "$MC_HOST_KEY")"; fi
MC_PORT="${TASK_RUN_MC_PORT:-}"
if [ -z "$MC_PORT" ]; then MC_PORT="$(kvget "$MC_PORT_KEY")"; fi
case "$MC_PORT" in *[!0-9]* | '') echo "task-run: no MC host/port (stash $MC_HOST_KEY / $MC_PORT_KEY)" >&2; exit 2 ;; esac
if [ "$MC_PORT" -lt 1 ] || [ "$MC_PORT" -gt 65535 ] || [ -z "$MC_HOST" ]; then
  echo "task-run: no MC host/port (stash $MC_HOST_KEY / $MC_PORT_KEY)" >&2; exit 2
fi

# --- resolve the logs (probed before the puppet touches prod) ---
LOGS="${TASK_RUN_LOGS_URL:-}"
TOKEN="${TASK_RUN_GRAFANA_TOKEN:-}"
if [ -z "$LOGS" ]; then
  if [ -z "$PORTAINER_URL_KEY" ]; then PORTAINER_URL_KEY="$(kvkey portainer url)"; fi
  if [ -z "$PORTAINER_API_KEY_KEY" ]; then PORTAINER_API_KEY_KEY="$(kvkey portainer api key)"; fi
  if [ -z "$GRAFANA_TOKEN_KEY" ]; then GRAFANA_TOKEN_KEY="$(kvkey grafana token)"; fi
  PURL="$(kvget "$PORTAINER_URL_KEY" | sed 's:/*$::')"
  PKEY="$(kvget "$PORTAINER_API_KEY_KEY")"
  if [ -z "$PURL" ] || [ -z "$PKEY" ]; then echo "task-run: portainer keys unreachable (stash words: portainer url / portainer api key)" >&2; exit 2; fi
  GHOST="$(curl -s -m 20 -H "X-API-Key: $PKEY" "$PURL/api/stacks" 2>/dev/null | python3 -c 'import json,sys
try:
  stacks = json.load(sys.stdin)
except Exception:
  sys.exit(0)
for s in stacks if isinstance(stacks, list) else []:
  for e in s.get("Env") or []:
    if e.get("name") == "GRAFANA_HOST" and e.get("value"):
      print(e["value"])
      sys.exit(0)')"
  if [ -z "$GHOST" ]; then echo "task-run: GRAFANA_HOST not found via portainer" >&2; exit 2; fi
  TOKEN="$(kvget "$GRAFANA_TOKEN_KEY")"
  if [ -z "$TOKEN" ]; then echo "task-run: grafana token unreachable (stash words: grafana token)" >&2; exit 2; fi
  LOGS="$LOGS_SCHEME://$GHOST/api/datasources/proxy/uid/PD775F2863313E6C7/select/logsql/query"
fi
PROBE_BODY="$OUTDIR/task-run-probe-$$.json"
PROBE_CODE="$(curl -s -m 30 -o "$PROBE_BODY" -w '%{http_code}' -H "Authorization: Bearer $TOKEN" "$LOGS" --data-urlencode 'query=container_name:idkcraft-bot _time:5m | stats count() as n' --data-urlencode 'limit=2' 2>/dev/null)"
if [ "$PROBE_CODE" != 200 ] || ! python3 - "$PROBE_BODY" <<'EOF'
import json,sys
try:
  with open(sys.argv[1]) as fh:
    first = fh.readline()
  d = json.loads(first)
except Exception:
  sys.exit(1)
sys.exit(0 if isinstance(d, dict) and "error" not in d else 1)
EOF
then
  echo "task-run: logs unreachable (VictoriaLogs probe failed)" >&2; exit 2
fi
rm -f "$PROBE_BODY"

# --- puppet lifecycle ---
PUPPET_PID=""
SCRATCH="task-run-body-$$.json task-run-mc-$$.jsonl task-run-bot-$$.jsonl task-run-bot-tail-$$.jsonl task-run-probe-$$.json"
puppet_cleanup() {
  if [ -n "$PUPPET_PID" ] && kill -0 "$PUPPET_PID" 2>/dev/null; then
    kill "$PUPPET_PID" 2>/dev/null || true
    sleep 2
    kill -9 "$PUPPET_PID" 2>/dev/null || true
  fi
  for f in $SCRATCH; do rm -f "$OUTDIR/$f"; done
}
trap puppet_cleanup EXIT
trap 'puppet_cleanup; exit 130' INT TERM

start_puppet() { # $1 = log path suffix; sets PUPPET_PID, returns 0 on online
  PLOG="$OUTDIR/task-run-$TASK-$STAMP.$1.puppet.jsonl"
  POUT="$OUTDIR/task-run-$TASK-$STAMP.$1.puppet.out"
  # The puppet prints the host to its own stdout: keep it in the file.
  # shellcheck disable=SC2086
  $PUPPET_CMD --host="$MC_HOST" --port="$MC_PORT" --name="$PUPPET_NAME" --bot-name="$BOT_NAME" --http-port="$HTTP_PORT" --log="$PLOG" --idle-ms=900000 >"$POUT" 2>&1 &
  PUPPET_PID=$!
  deadline=$(( $(now_epoch) + 120 ))
  while [ "$(now_epoch)" -lt "$deadline" ]; do
    if ! kill -0 "$PUPPET_PID" 2>/dev/null; then
      wait "$PUPPET_PID"; code=$?
      PUPPET_PID=""
      if [ "$code" = 2 ]; then echo "task-run: puppet refused (human online)" >&2; else echo "task-run: puppet exited $code, see $POUT" >&2; fi
      return 1
    fi
    if pctl GET "/state?n=5" && [ "$PSTAT" = 200 ] && state_is online; then return 0; fi
    sleep 3
  done
  echo "task-run: puppet never came online (see $POUT)" >&2
  return 1
}

stop_puppet() { # quit politely, then make sure it is gone
  pctl POST /quit >/dev/null 2>&1 || true
  if [ -n "$PUPPET_PID" ]; then
    deadline=$(( $(now_epoch) + 15 ))
    while kill -0 "$PUPPET_PID" 2>/dev/null && [ "$(now_epoch)" -lt "$deadline" ]; do sleep 1; done
    puppet_cleanup
    PUPPET_PID=""
  fi
}

# --- puppet HTTP: sets PSTAT (000 = unreachable) + PBODY file ---
PBODY="$OUTDIR/task-run-body-$$.json"
pctl() {
  if [ -n "${3:-}" ]; then
    PSTAT="$(curl -s -m 10 -o "$PBODY" -w '%{http_code}' -X"$1" "$C$2" -d "$3" 2>/dev/null)"
  else
    PSTAT="$(curl -s -m 10 -o "$PBODY" -w '%{http_code}' -X"$1" "$C$2" 2>/dev/null)"
  fi
  [ -n "$PSTAT" ] || PSTAT="000"
  [ "$PSTAT" != "000" ]
}

state_is() { # $1 = want state word; reads PBODY
  [ "$PSTAT" = 200 ] && python3 - "$PBODY" "$1" <<'EOF'
import json,sys
try:
  d = json.load(open(sys.argv[1]))
except Exception:
  sys.exit(1)
sys.exit(0 if d.get("state") == sys.argv[2] else 1)
EOF
}

bot_in_roster() { # 0 when BOT_NAME is on the /state roster in PBODY
  python3 - "$PBODY" "$BOT_NAME" <<'EOF'
import json,sys
try:
  d = json.load(open(sys.argv[1]))
except Exception:
  sys.exit(1)
sys.exit(0 if sys.argv[2] in (d.get("roster") or []) else 1)
EOF
}

chat_len() { # prints the /state chat length in PBODY (0 on garbage)
  python3 - "$PBODY" <<'EOF'
import json,sys
try:
  print(len(json.load(open(sys.argv[1])).get("chat") or []))
except Exception:
  print(0)
EOF
}

say() { # $1 = text; 409 (human) fails the run, anything else is returned
  pctl POST /say "{\"text\":\"$1\"}" || return 2
  if [ "$PSTAT" = 409 ]; then echo "task-run: human online (409), voiding" >&2; return 3; fi
  [ "$PSTAT" = 200 ]
}

# --- rendezvous: `follow me` until the bot is mutually visible ---
# The unseen reply leaks the bot's coords (`I'm at X Y Z`, chat.js) — walk
# there. `autonomous on` goes AFTER the meet: said earlier the bot may be
# offline and never hear it (revmux 01 major). Quiet; returns 0 on visible,
# 3 on human, 1 otherwise.
meet_bot() {
  say 'follow me' || return $?
  deadline=$(( $(now_epoch) + MEET_SECS ))
  last_goto=""
  last_ask=0
  while [ "$(now_epoch)" -lt "$deadline" ]; do
    if ! kill -0 "$PUPPET_PID" 2>/dev/null; then echo "task-run: puppet died mid-meet" >&2; return 1; fi
    if ! pctl GET "/state?n=100"; then sleep 5; continue; fi
    if [ "$PSTAT" = 409 ]; then echo "task-run: human online (409), voiding" >&2; return 3; fi
    if [ "$PSTAT" != 200 ]; then sleep 5; continue; fi
    parsed="$(python3 - "$PBODY" "$BOT_NAME" <<'EOF'
import json,sys,re
try:
  d = json.load(open(sys.argv[1]))
except Exception:
  print("dist=none"); print("at=none"); sys.exit(0)
bot = (d.get("bot") or {}).get("dist")
print("dist=%s" % ("none" if bot is None else bot))
at = None
for c in d.get("chat") or []:
  if c.get("from") != sys.argv[2]:
    continue
  mm = re.search(r"I.m at (-?\d+) (-?\d+) (-?\d+)", c.get("msg") or "")
  if mm:
    at = "%s,%s,%s" % mm.groups()
print("at=%s" % (at or "none"))
EOF
)"
    dist="$(printf '%s' "$parsed" | sed -n 's/^dist=//p')"
    at="$(printf '%s' "$parsed" | sed -n 's/^at=//p')"
    if [ "$dist" != "none" ]; then # mutually visible: the bot is online and hears
      say 'autonomous on' >/dev/null 2>&1 || return $?
      return 0
    fi
    now="$(now_epoch)"
    if [ "$at" != "none" ] && [ "$at" != "$last_goto" ]; then
      last_goto="$at"
      pctl POST /goto "{\"x\":$(printf '%s' "$at" | cut -d, -f1),\"y\":$(printf '%s' "$at" | cut -d, -f2),\"z\":$(printf '%s' "$at" | cut -d, -f3)}" >/dev/null 2>&1 || true
      if [ "$PSTAT" = 409 ]; then echo "task-run: human online (409), voiding" >&2; return 3; fi
    elif [ $(( now - last_ask )) -ge 30 ]; then
      last_ask="$now" # the bot may have walked: re-ask, re-parse, re-walk
      say 'follow me' >/dev/null 2>&1 || { code=$?; [ "$code" = 3 ] && return 3; }
    fi
    sleep 5
  done
  echo "task-run: bot never visible within ${MEET_SECS}s" >&2
  return 1
}

# --- order + reply: sets ORDER_REPLY (the ack line), 0 on ack ---
ORDER_REPLY=""
order_and_wait() { # $1 = order text
  pctl POST /stop >/dev/null 2>&1 || true
  # Chat length before the order: only later lines can be the reply.
  # (Index, not time: a reply in the same second must still count, and the
  # 100-tail never binds in these short sessions.)
  pctl GET "/state?n=100" >/dev/null 2>&1 || return 2
  if [ "$PSTAT" = 409 ]; then echo "task-run: human online (409), voiding" >&2; return 3; fi
  if [ "$PSTAT" != 200 ]; then echo "task-run: puppet not answering" >&2; return 1; fi
  seen="$(chat_len)"
  say "$1" || return $?
  deadline=$(( $(now_epoch) + REPLY_SECS ))
  while [ "$(now_epoch)" -lt "$deadline" ]; do
    if ! kill -0 "$PUPPET_PID" 2>/dev/null; then echo "task-run: puppet died waiting for the reply" >&2; return 1; fi
    pctl GET "/state?n=100" >/dev/null 2>&1 || { sleep 3; continue; }
    if [ "$PSTAT" = 409 ]; then echo "task-run: human online (409), voiding" >&2; return 3; fi
    if [ "$PSTAT" != 200 ]; then sleep 3; continue; fi
    verdict="$(python3 - "$PBODY" "$BOT_NAME" "$TASK" "$seen" <<'EOF'
import json,sys,re
task = sys.argv[3]
try:
  n = int(sys.argv[4])
except Exception:
  n = 0
try:
  d = json.load(open(sys.argv[1]))
except Exception:
  print("NONE"); print(""); sys.exit(0)
verdict = "NONE"
line = ""
for c in (d.get("chat") or [])[n:]:
  if c.get("from") != sys.argv[2]:
    continue
  m = c.get("msg") or ""
  if task == "house" and "building a home at " in m:
    verdict = "ACK"; line = m; break
  elif task == "castle" and ("castle at " in m or "looking for a castle spot" in m):
    verdict = "ACK"; line = m; break
  elif re.search(r"can.t see you", m):
    verdict = "NOSEE"; line = m; break
print(verdict)
print(line)
EOF
)"
    v="$(printf '%s' "$verdict" | sed -n '1p')"
    if [ "$v" = ACK ]; then ORDER_REPLY="$(printf '%s' "$verdict" | sed -n '2p')"; return 0; fi
    if [ "$v" = NOSEE ]; then echo "task-run: order refused: $(printf '%s' "$verdict" | sed -n '2p')" >&2; return 1; fi
    sleep 3
  done
  echo "task-run: no order reply within ${REPLY_SECS}s" >&2
  return 1
}

print_queries() { # $1 = hours back (covers the window)
  echo "manual VictoriaLogs queries (UTC window starts $WINDOW_START):"
  if [ "$TASK" = house ]; then
    echo "  container_name:idkcraft-mc _time:$1h home done at | sort by (_time) | fields _time,_msg"
    echo "  container_name:idkcraft-mc _time:$1h building | sort by (_time) | fields _time,_msg"
  else
    echo "  container_name:idkcraft-mc _time:$1h castle done at | sort by (_time) | fields _time,_msg"
    echo "  container_name:idkcraft-bot _time:$1h castle | sort by (_time) | fields _time,_msg"
  fi
  echo "  container_name:idkcraft-mc _time:$1h joined the game | sort by (_time) | fields _time,_msg"
}

journal_event() { # $1=kind $2=line (agent-side events: resumes)
  python3 - "$JOURNAL" "$(now_utc)" "$1" "$2" <<'EOF'
import json,sys
_, jf, t, kind, line = sys.argv
e = {"k": "%s|run|%s|%s" % (t, kind, line), "t": t, "src": "run", "kind": kind, "line": line}
open(jf, "a").write(json.dumps(e) + "\n")
EOF
}

wait_for_roster() { # 0 once BOT_NAME is on the roster (BOT_WAIT_SECS)
  deadline=$(( $(now_epoch) + BOT_WAIT_SECS ))
  while [ "$(now_epoch)" -lt "$deadline" ]; do
    if ! kill -0 "$PUPPET_PID" 2>/dev/null; then return 1; fi
    pctl GET "/state?n=5" >/dev/null 2>&1 || { sleep 3; continue; }
    if [ "$PSTAT" = 200 ] && bot_in_roster; then return 0; fi
    sleep 3
  done
  return 1
}

wait_for_bot_line() { # $1 = needle $2 = secs $3 = chat length before the say; prints 1 on sight, HUMAN on 409, else 0
  seen="$3"
  deadline=$(( $(now_epoch) + $2 ))
  while [ "$(now_epoch)" -lt "$deadline" ]; do
    if ! kill -0 "$PUPPET_PID" 2>/dev/null; then echo 0; return 0; fi
    pctl GET "/state?n=100" >/dev/null 2>&1 || { sleep 3; continue; }
    if [ "$PSTAT" = 409 ]; then echo HUMAN; return 0; fi
    [ "$PSTAT" = 200 ] || { sleep 3; continue; }
    if python3 - "$PBODY" "$BOT_NAME" "$seen" "$1" <<'EOF'
import json,sys
try:
  n = int(sys.argv[3])
except Exception:
  n = 0
try:
  d = json.load(open(sys.argv[1]))
except Exception:
  sys.exit(1)
for c in (d.get("chat") or [])[n:]:
  if c.get("from") == sys.argv[2] and sys.argv[4] in (c.get("msg") or ""):
    sys.exit(0)
sys.exit(1)
EOF
    then
      echo 1
      return 0
    fi
    sleep 3
  done
  echo 0
}

RESUME_OK=0
attempt_resume() { # the bot is gone: a fresh puppet waits for it, re-issues `autonomous on`
  RESUMES_LEFT=$(( RESUMES_LEFT - 1 ))
  n=$(( MAX_RESUMES - RESUMES_LEFT ))
  echo "task-run: bot is gone; resume attempt $n/$MAX_RESUMES (re-issue autonomous on)"
  ok=0
  if start_puppet "resume$n"; then
    # The bot rejoins seconds after the puppet (waitForPlayers): saying
    # before it is on the roster is lost, and ok=1 needs its reply
    # (revmux 01 major). The chat baseline is taken before the say —
    # an instant reply must still count.
    if wait_for_roster && pctl GET "/state?n=100" >/dev/null 2>&1 && [ "$PSTAT" = 200 ]; then
      seen="$(chat_len)"
      say 'autonomous on' >/dev/null 2>&1
      code=$?
      if [ "$code" = 3 ]; then
        stop_puppet
        write_series void-human
        echo "task-run: VOID — human online (409 during resume); series: $SERIES"
        exit 2
      elif [ "$code" = 0 ]; then
        ok=$(wait_for_bot_line 'autonomous on' "$REPLY_SECS" "$seen")
        if [ "$ok" = HUMAN ]; then
          stop_puppet
          write_series void-human
          echo "task-run: VOID — human online (409 during resume); series: $SERIES"
          exit 2
        fi
      fi
    fi
  fi
  stop_puppet
  journal_event resume "attempt $n ok=$ok"
  RESUME_OK="$ok"
}

fetch_logs() { # $1=container $2=span-min $3=outfile; transient failures just fail
  code="$(curl -s -m 30 -o "$3" -w '%{http_code}' -H "Authorization: Bearer $TOKEN" "$LOGS" --data-urlencode "query=container_name:$1 _time:$2m | sort by (_time) | fields _time,_msg" --data-urlencode 'limit=20000' 2>/dev/null)"
  [ "$code" = 200 ]
}

classify_poll() { # $1=mcf $2=botf: append new events, print signals
  python3 - "$1" "$2" "$JOURNAL" "$TASK" "$BOT_NAME" "$PUPPET_NAME" "$WINDOW_START" "$SKIP_HORIZON_SECS" <<'EOF'
import datetime,json,sys,re
mc_f, bot_f, journal, task, bot, puppet, start, horizon = sys.argv[1:9]
try:
  horizon = int(horizon)
except Exception:
  horizon = 3900
seen = set()
old_skips = [] # (t, line), every house skip already journalled
try:
  for l in open(journal):
    try:
      e = json.loads(l)
    except Exception:
      continue
    seen.add(e.get("k"))
    if e.get("kind") == "skip":
      old_skips.append((e.get("t") or "", e.get("line") or ""))
except Exception:
  pass
out = []
def emit(t, src, kind, line):
  k = "%s|%s|%s" % (t, src, line)
  if k in seen:
    return False
  seen.add(k)
  out.append({"k": k, "t": t, "src": src, "kind": kind, "line": line})
  return True
def lines(f):
  try:
    fh = open(f)
  except Exception:
    return
  for l in fh:
    try:
      d = json.loads(l)
    except Exception:
      continue
    t = d.get("_time") or ""
    m = d.get("_msg") or ""
    if t < start: # this window only: no verdict on older lines
      continue
    yield t, m
def parse(t):
  try:
    return datetime.datetime.strptime(t, "%Y-%m-%dT%H:%M:%SZ")
  except Exception:
    return None
signals = []
last_progress = ""
dones = []
nbot = 0
for t, m in lines(mc_f):
  if task == "house" and "home done at " in m:
    if emit(t, "mc", "done", m):
      dones.append((t, m)) # judged PARTIAL-or-DONE below, against the skips
  elif task == "castle" and "castle done at " in m:
    if emit(t, "mc", "done", m):
      signals.append("DONE " + m)
  elif task == "castle" and "I found no castle spot" in m:
    if emit(t, "mc", "nosite", m):
      signals.append("NOSITE " + m)
  elif task == "house" and re.search(r"building \d+/\d+", m):
    if emit(t, "mc", "progress", m):
      last_progress = m
  mm = re.search(r"(\S+) joined the game", m)
  if mm:
    name = mm.group(1)
    if emit(t, "mc", "join", m) and name != bot and name != puppet:
      signals.append("VOID " + name)
for t, m in lines(bot_f):
  nbot += 1
  if task == "castle" and re.match(r"^castle \d+/\d+$", m.strip()):
    if emit(t, "bot", "progress", m):
      last_progress = m
  if task == "house" and m.startswith("build skip "):
    if emit(t, "bot", "skip", m):
      old_skips.append((t, m))
  if ("spawned as %s" % bot) in m:
    emit(t, "bot", "restart", m) # a deploy restart: recorded, never voiding
  if "leaving: nobody online" in m:
    if emit(t, "bot", "leave", m):
      signals.append("LEAVE")
# A house done over unhealed skips is PARTIAL (revmux 01 major): skips
# prune hourly, so a skip younger than the horizon at done-time is still
# a hole; an older one had a prune cycle (a re-fail would re-log young).
for t, m in dones:
  dt = parse(t)
  bad = [(st, sm) for (st, sm) in old_skips
         if dt is None or parse(st) is None or datetime.timedelta(0) <= (dt - parse(st)) <= datetime.timedelta(seconds=horizon)]
  if bad:
    signals.append("PARTIAL %d %s" % (len(bad), bad[-1][1]))
  else:
    signals.append("DONE " + m)
if nbot == 0:
  signals.append("BOT_SILENT")
if out:
  with open(journal, "a") as fh:
    for e in out:
      fh.write(json.dumps(e) + "\n")
for s in signals:
  print(s)
if last_progress:
  print("PROGRESS " + last_progress)
EOF
}

write_series() { # $1=verdict
  python3 - "$JOURNAL" "$SERIES" "$TASK" "$BUDGET_MIN" "$WINDOW_START" "$(now_utc)" "$1" "$ORDER_TEXT" "$ORDER_REPLY" "$(( MAX_RESUMES - RESUMES_LEFT ))" <<'EOF'
import json,sys
_, journal, series, task, budget, start, end, verdict, order, reply, resumes = sys.argv
events = []
try:
  for l in open(journal):
    try:
      e = json.loads(l)
      events.append({"t": e.get("t"), "src": e.get("src"), "kind": e.get("kind"), "line": e.get("line")})
    except Exception:
      pass
except Exception:
  pass
events.sort(key=lambda e: e.get("t") or "")
doc = {"seriesVersion": 1, "task": task, "budgetMin": int(budget), "windowStart": start,
       "endedAt": end, "verdict": verdict, "order": order, "orderReply": reply,
       "resumesUsed": int(resumes), "events": events}
open(series, "w").write(json.dumps(doc, indent=1) + "\n")
EOF
}

last_bot_lines() { # $1=count: fresh fetch, redacted
  tmp="$OUTDIR/task-run-bot-tail-$$.jsonl"
  fetch_logs idkcraft-bot 20 "$tmp" || { echo "(bot tail unavailable)"; return; }
  python3 - "$tmp" "$1" <<'EOF'
import json,sys,re
rows = []
for l in open(sys.argv[1]):
  try:
    d = json.loads(l)
  except Exception:
    continue
  rows.append(((d.get("_time") or "")[:19].replace("T", " "), re.sub(r"\d+\.\d+\.\d+\.\d+", "<ip>", d.get("_msg") or "")[:300]))
for t, m in sorted(rows)[-int(sys.argv[2]):]:
  print("%s %s" % (t, m))
EOF
}

last_progress_line() {
  python3 - "$JOURNAL" <<'EOF'
import json,sys
last = ""
try:
  for l in open(sys.argv[1]):
    try:
      e = json.loads(l)
    except Exception:
      continue
    if e.get("kind") == "progress":
      last = "%s %s" % (e.get("t"), e.get("line"))
except Exception:
  pass
print(last or "(no progress line in the window)")
EOF
}

# --- main: order, quit, poll ---
if [ "$TASK" = house ]; then ORDER_TEXT="build here"; else ORDER_TEXT="build castle"; fi

start_puppet order || exit 2
meet_bot || { stop_puppet; exit 2; }
if ! order_and_wait "$ORDER_TEXT"; then
  # One re-meet: the bot may have walked out of range between meet and order.
  if ! meet_bot || ! order_and_wait "$ORDER_TEXT"; then stop_puppet; exit 2; fi
fi
WINDOW_START="$(now_utc)"
stop_puppet

BUDGET_SECS="${TASK_RUN_BUDGET_SECS:-$(( BUDGET_MIN * 60 ))}"
START_EPOCH="$(now_epoch)"
END_EPOCH=$(( START_EPOCH + BUDGET_SECS ))
SPAN_MIN=$(( POLL_SECS / 60 + 2 ))
[ "$SPAN_MIN" -ge 2 ] || SPAN_MIN=2
RESUMES_LEFT="$MAX_RESUMES"
LOST_STREAK=0
SILENT_STREAK=0

trap 'write_series interrupted 2>/dev/null; echo "task-run: interrupted; series so far: $SERIES"; exit 130' INT TERM

echo "task-run $TASK: order '$ORDER_TEXT' acked, puppet quit"
echo "window start (UTC): $WINDOW_START"
print_queries $(( BUDGET_SECS / 3600 + 1 ))
echo "puppet transcript: $PLOG"
echo "series: $SERIES (writing)"
echo "order reply: $ORDER_REPLY"

while :; do
  MCF="$OUTDIR/task-run-mc-$$.jsonl"
  BOTF="$OUTDIR/task-run-bot-$$.jsonl"
  mc_ok=0
  bot_ok=0
  fetch_logs idkcraft-mc "$SPAN_MIN" "$MCF" && mc_ok=1
  fetch_logs idkcraft-bot "$SPAN_MIN" "$BOTF" && bot_ok=1
  if [ "$mc_ok" = 1 ] || [ "$bot_ok" = 1 ]; then
    LOST_STREAK=0
    [ "$mc_ok" = 1 ] || : >"$MCF"
    [ "$bot_ok" = 1 ] || : >"$BOTF"
    signals="$(classify_poll "$MCF" "$BOTF")"
    if [ "$bot_ok" = 1 ]; then # bot silence counts only on a good fetch
      if printf '%s' "$signals" | grep -q '^BOT_SILENT$'; then SILENT_STREAK=$(( SILENT_STREAK + 1 )); else SILENT_STREAK=0; fi
    fi
    if printf '%s' "$signals" | grep -q '^VOID '; then
      who="$(printf '%s' "$signals" | sed -n 's/^VOID //p' | head -n 1)"
      write_series void-human
      echo "task-run: VOID — human joined ($who); series: $SERIES"
      exit 2
    fi
    if printf '%s' "$signals" | grep -q '^PARTIAL '; then
      write_series partial
      echo "task-run: PARTIAL — done marker over unhealed skips: $(printf '%s' "$signals" | sed -n 's/^PARTIAL //p' | head -n 1)"
      echo "last progress: $(last_progress_line)"
      echo "series: $SERIES"
      exit 1
    fi
    if printf '%s' "$signals" | grep -q '^DONE '; then
      write_series "done"
      echo "task-run: DONE within budget: $(printf '%s' "$signals" | sed -n 's/^DONE //p' | head -n 1)"
      echo "series: $SERIES"
      exit 0
    fi
    if printf '%s' "$signals" | grep -q '^NOSITE '; then
      write_series no-site
      echo "task-run: no castle site: $(printf '%s' "$signals" | sed -n 's/^NOSITE //p' | head -n 1)"
      echo "series: $SERIES"
      exit 1
    fi
    # The bot is gone explicitly (LEAVE) or silently (a restart never logs
    # LEAVE — two quiet polls in a row, revmux 01 major): resume while
    # resumes last, else the run is dead, not slow — exit 2, not 1.
    need_resume=0
    if printf '%s' "$signals" | grep -q '^LEAVE$'; then need_resume=1; fi
    if [ "$SILENT_STREAK" -ge 2 ]; then need_resume=1; fi
    if [ "$need_resume" = 1 ]; then
      if [ "$RESUMES_LEFT" -gt 0 ]; then
        attempt_resume
        if [ "$RESUME_OK" = 0 ] && [ "$RESUMES_LEFT" = 0 ]; then
          write_series unverified
          echo "task-run: bot autonomy unverified (bot gone, resumes exhausted); series: $SERIES" >&2
          exit 2
        fi
      else
        write_series unverified
        echo "task-run: bot autonomy unverified (bot gone, resumes exhausted); series: $SERIES" >&2
        exit 2
      fi
    fi
    prog="$(printf '%s' "$signals" | sed -n 's/^PROGRESS //p' | head -n 1)"
    if [ -n "$prog" ]; then echo "task-run progress: $prog"; fi
  else
    LOST_STREAK=$(( LOST_STREAK + 1 ))
    if [ "$LOST_STREAK" -ge 3 ]; then
      write_series logs-lost
      echo "task-run: logs unreachable 3 polls in a row — cannot judge; series: $SERIES" >&2
      exit 2
    fi
    echo "task-run: poll failed (transient), retrying next interval"
  fi
  now="$(now_epoch)"
  if [ "$now" -ge "$END_EPOCH" ]; then
    write_series budget-exceeded
    echo "task-run: BUDGET EXCEEDED after ${BUDGET_MIN} min"
    echo "last progress: $(last_progress_line)"
    echo "--- last 20 bot lines ---"
    last_bot_lines 20
    echo "series: $SERIES"
    print_queries $(( BUDGET_SECS / 3600 + 1 ))
    exit 1
  fi
  wait_secs=$(( END_EPOCH - now ))
  [ "$wait_secs" -gt "$POLL_SECS" ] && wait_secs="$POLL_SECS"
  sleep "$wait_secs"
done

