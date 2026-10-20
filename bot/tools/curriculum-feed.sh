#!/bin/sh
# CURRICULUM VICTORIALOGS FEED (idkcraft-b64i): bot2 log lines for the
# harvest that survive container re-creation. Redeploys wipe docker logs
# (2026-10-19/20: ~12 redeploys left minutes of bot2 log per container, so
# the harvest saw almost nothing); VictoriaLogs keeps every idkcraft
# container >= 29 days.
#
# Usage: sh tools/curriculum-feed.sh [days=7] > bot2-7d.txt
#   then: node tools/curriculum.js harvest bot2-7d.txt [days]
#   or in one go: sh tools/curriculum.sh vlogs [days]
# Output lines are "YYYY-MM-DD HH:MM:SS <bot> <msg>" (UTC, like deaths.sh),
# straight into the harvest. The bot name on every line is CURRICULUM_BOT
# (default BOT2_USERNAME, else IdkBotV2 — the owner's feed, like
# curriculum.js). The mc refusals stay out of this feed by owner rule
# (bring=excluded in the harvest why-line).
#
# LogsQL over the VictoriaLogs datasource behind the house Grafana
# (datasource proxy, same recipe as the session-review skill):
#   compose_service:<service> "recover action=" _time:<N>d
#   | sort by (_time) | fields _time, _msg
# (server-side recover filter: a 7-day decision stream is ~600k lines and
# the harvest only reads recover episodes).
#
# Env (secrets resolve at runtime and never print; stash KEY NAMES only in
# here, values come from env or kv — never paste them into the repo, no
# hostnames or domain labels anywhere below):
#   CURRICULUM_FEED_SERVICE (default bot2): the compose_service value. The
#     feed is single-service: every line is labelled CURRICULUM_FEED_BOT, so
#     a multi-service query would misattribute — don't widen it.
#   CURRICULUM_FEED_BOT (default BOT2_USERNAME, else IdkBotV2).
#   CURRICULUM_FEED_QUERY: full LogsQL query (default built from the two
#     above); CURRICULUM_FEED_LIMIT (default 50000).
#   CURRICULUM_LOGS_URL: full proxy URL (default resolved via Portainer).
#   CURRICULUM_GRAFANA_HOST / CURRICULUM_GRAFANA_TOKEN: skip Portainer/kv.
#   CURRICULUM_PORTAINER_URL / CURRICULUM_PORTAINER_API_KEY: skip kv.
#   CURRICULUM_KV (default ~/.local/bin/kv),
#   CURRICULUM_PORTAINER_URL_KEY (default secrets/idkcraft-portainer-url),
#   CURRICULUM_PORTAINER_API_KEY_KEY
#     (default secrets/idkcraft-portainer-api-key),
#   CURRICULUM_GRAFANA_TOKEN_KEY (default secrets/idkcraft-grafana-token).
#   One-time owner step: create those three stash keys with the prod
#   monitoring values (Grafana SA token, prod Portainer URL + API key).
#   CURRICULUM_FEED_CURL (default curl): stub seam for tests.
#   CURRICULUM_LOGS_SCHEME (default https).
#
# Exit 2 = environment (bad days, keys/hosts/logs unreachable).
set -u
DAYS="${1:-7}"
case "$DAYS" in *[!0-9]* | '' | 0) echo "curriculum-feed: days must be a positive integer (got '$DAYS')" >&2; exit 2 ;; esac

SERVICE="${CURRICULUM_FEED_SERVICE:-bot2}"
BOT="${CURRICULUM_FEED_BOT:-${BOT2_USERNAME:-IdkBotV2}}"
LIMIT="${CURRICULUM_FEED_LIMIT:-50000}"
KV="${CURRICULUM_KV:-$HOME/.local/bin/kv}"
CURL="${CURRICULUM_FEED_CURL:-curl}"
SCHEME="${CURRICULUM_LOGS_SCHEME:-https}"
QUERY="${CURRICULUM_FEED_QUERY:-compose_service:$SERVICE \"recover action=\" _time:${DAYS}d | sort by (_time) | fields _time, _msg}"

command -v python3 >/dev/null 2>&1 || { echo "curriculum-feed: need python3" >&2; exit 2; }

kvget() { "$KV" get "$1" 2>/dev/null || true; }

LOGS="${CURRICULUM_LOGS_URL:-}"
TOKEN="${CURRICULUM_GRAFANA_TOKEN:-}"
if [ -z "$LOGS" ]; then
  PURL="${CURRICULUM_PORTAINER_URL:-}"
  if [ -z "$PURL" ]; then
    PURL="$(kvget "${CURRICULUM_PORTAINER_URL_KEY:-secrets/idkcraft-portainer-url}" | sed 's:/*$::')"
  fi
  PKEY="${CURRICULUM_PORTAINER_API_KEY:-}"
  if [ -z "$PKEY" ]; then
    PKEY="$(kvget "${CURRICULUM_PORTAINER_API_KEY_KEY:-secrets/idkcraft-portainer-api-key}")"
  fi
  if [ -z "$PURL" ] || [ -z "$PKEY" ]; then
    echo "curriculum-feed: portainer keys unreachable (stash ${CURRICULUM_PORTAINER_URL_KEY:-secrets/idkcraft-portainer-url} / ${CURRICULUM_PORTAINER_API_KEY_KEY:-secrets/idkcraft-portainer-api-key}, or env CURRICULUM_PORTAINER_URL / CURRICULUM_PORTAINER_API_KEY)" >&2
    exit 2
  fi
  GHOST="${CURRICULUM_GRAFANA_HOST:-}"
  if [ -z "$GHOST" ]; then
    GHOST="$("$CURL" -s -m 20 -H "X-API-Key: $PKEY" "$PURL/api/stacks" 2>/dev/null | python3 -c 'import json,sys
try:
  stacks = json.load(sys.stdin)
except Exception:
  sys.exit(0)
for s in stacks if isinstance(stacks, list) else []:
  for e in s.get("Env") or []:
    if e.get("name") == "GRAFANA_HOST" and e.get("value"):
      print(e["value"])
      sys.exit(0)')"
  fi
  if [ -z "$GHOST" ]; then echo "curriculum-feed: GRAFANA_HOST not found via portainer" >&2; exit 2; fi
  if [ -z "$TOKEN" ]; then TOKEN="$(kvget "${CURRICULUM_GRAFANA_TOKEN_KEY:-secrets/idkcraft-grafana-token}")"; fi
  if [ -z "$TOKEN" ]; then
    echo "curriculum-feed: grafana token unreachable (stash ${CURRICULUM_GRAFANA_TOKEN_KEY:-secrets/idkcraft-grafana-token}, or env CURRICULUM_GRAFANA_TOKEN)" >&2
    exit 2
  fi
  LOGS="$SCHEME://$GHOST/api/datasources/proxy/uid/PD775F2863313E6C7/select/logsql/query"
fi

BODY="$(mktemp)" || { echo "curriculum-feed: cannot mktemp" >&2; exit 2; }
trap 'rm -f "$BODY" "$BODY.code"' EXIT
if ! "$CURL" -s -m 60 -o "$BODY" -w '%{http_code}' -H "Authorization: Bearer $TOKEN" "$LOGS" \
  --data-urlencode "query=$QUERY" --data-urlencode "limit=$LIMIT" >"$BODY.code" 2>/dev/null; then
  echo "curriculum-feed: logs unreachable (VictoriaLogs query failed)" >&2
  exit 2
fi
if [ "$(cat "$BODY.code")" != 200 ] || ! python3 - "$BODY" <<'EOF'
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
  echo "curriculum-feed: logs unreachable (VictoriaLogs probe failed)" >&2
  exit 2
fi
rm -f "$BODY.code"

# _time -> "YYYY-MM-DD HH:MM:SS", one harvest line per log line. A _msg with
# an embedded newline would forge a line: keep the first physical line only.
# A feed that hits CURRICULUM_FEED_LIMIT is truncated: say so on stderr, or
# the harvest is quietly incomplete.
BOT="$BOT" LIMIT="$LIMIT" python3 - "$BODY" <<'EOF'
import json,os,sys
bot = os.environ["BOT"]
try:
  lim = int(os.environ.get("LIMIT") or 0)
except ValueError:
  lim = 0
n = 0
with open(sys.argv[1]) as fh:
  for line in fh:
    line = line.strip()
    if not line:
      continue
    try:
      d = json.loads(line)
    except Exception:
      continue
    if not isinstance(d, dict) or "error" in d:
      continue
    t = str(d.get("_time") or "")
    msg = str(d.get("_msg") or "").split("\n")[0].strip()
    if len(t) < 19 or not msg:
      continue
    print("%s %s %s %s" % (t[0:10], t[11:19], bot, msg))
    n += 1
print("curriculum-feed: service feed lines=%d" % n, file=sys.stderr)
if lim and n >= lim:
  print("curriculum-feed: hit limit=%d, window truncated" % lim, file=sys.stderr)
EOF
