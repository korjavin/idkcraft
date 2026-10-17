#!/bin/sh
# Usage: castle-give.sh castle-give-A.txt   (or '-' for stdin). One rcon command per line,
# e.g. "give IdkBotV2 minecraft:cobblestone 896". Runs each via Portainer exec -> rcon-cli in the mc container.
# Secrets come from stash (kv) at runtime; nothing is printed except rcon replies. Run ONE round at a time.
set -eu
KV="$HOME/.local/bin/kv"
kvkey() { "$KV" ls secrets 2>/dev/null | python3 -c '
import json,sys,re
words=[w.lower() for w in sys.argv[1:]]
for e in json.load(sys.stdin):
  if all(w in set(re.split(r"[^a-z0-9]+",(e.get("key") or "").lower())) for w in words):
    print(e["key"]);sys.exit(0)' "$@"; }
PURL="$("$KV" get "$(kvkey portainer url)" | sed 's:/*$::')"
PKEY="$("$KV" get "$(kvkey portainer api key)")"
[ -n "$PURL" ] && [ -n "$PKEY" ] || { echo "castle-give: portainer keys unreachable" >&2; exit 2; }
EP="$PURL/api/endpoints/2/docker"
IN="${1:--}"; [ "$IN" = "-" ] && IN=/dev/stdin
while IFS= read -r line; do
  case "$line" in ''|'#'*) continue ;; esac
  body="$(python3 -c 'import json,shlex,sys;print(json.dumps({"AttachStdout":True,"AttachStderr":True,"Cmd":["rcon-cli"]+shlex.split(sys.argv[1])}))' "$line")"
  id="$(curl -s -m 20 -H "X-API-Key: $PKEY" -H 'Content-Type: application/json' -d "$body" "$EP/containers/idkcraft-mc/exec" | python3 -c 'import json,sys;print(json.load(sys.stdin)["Id"])')"
  printf '%s -> ' "$line"
  curl -s -m 30 -H "X-API-Key: $PKEY" -H 'Content-Type: application/json' -d '{"Detach":false,"Tty":false}' "$EP/exec/$id/start" | strings
  sleep 1
done < "$IN"
