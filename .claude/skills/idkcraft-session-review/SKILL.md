---
name: idkcraft-session-review
description: Review a real play session of the idkcraft Minecraft bot from production logs and metrics — find what the bot did, where it got stuck, lost, died or misbehaved, compare with what the owner saw, and file bd beads with evidence. Trigger when the owner says "I played with the bot, check the logs", "the bot got stuck / didn't come / died", "review the session", "разбери сессию", "посмотри логи".
---

# idkcraft session review

The owner plays on the prod server and reports a symptom in one sentence ("I said follow me and it never came"). Your job: reconstruct the session from logs and metrics, find the root cause in code, and leave behind beads the developers can act on. You never change prod and never print secrets.

## 1. Access (secrets live in the local stash, never in the repo)

```bash
KV=~/.local/bin/kv
key(){ $KV ls secrets | python3 -c "import json,sys;print([k['key'] for k in json.load(sys.stdin) if all(w in k['key'] for w in sys.argv[1:])][0])" "$@"; }
T=$($KV get "$(key grafana sa-token)")   # Grafana service-account token (Bearer)
# Grafana host = GRAFANA_HOST env of the Portainer stack "monitoring":
U=$($KV get "$(key portainer-url)" | sed 's:/*$::'); K=$($KV get "$(key portainer-api-key)")
G=https://$(curl -s -H "X-API-Key: $K" "$U/api/stacks" | python3 -c 'import json,sys
for s in json.load(sys.stdin):
  for e in s.get("Env") or []:
    if e["name"]=="GRAFANA_HOST": print(e["value"])')
LOGS="$G/api/datasources/proxy/uid/PD775F2863313E6C7/select/logsql/query"   # VictoriaLogs
PROM="$G/api/datasources/proxy/uid/P4169E866C3094E38/api/v1"                # VictoriaMetrics
```

Rules: never echo `$T`/`$K`; redact IPs (`sed -E 's/[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+/<ip>/g'`) before quoting a line; never write hostnames into beads, PRs or the repo. Portainer is read-only for you (GET only): `.../api/endpoints/2/docker/containers/idkcraft-bot/json` gives env (BOT_FOLLOW, BRAIN_URL, BRAIN_TICK_MS) and `State.StartedAt`.

## 2. Pull the session

Containers: `idkcraft-bot` (bot decisions), `idkcraft-mc` (server: joins, chat, deaths, teleports), `idkcraft-laya` (model).

```bash
S=<your scratchpad>
q(){ curl -s -H "Authorization: Bearer $T" "$LOGS" --data-urlencode "query=$1" --data-urlencode 'limit=20000' \
  | python3 -c 'import json,sys,re
for l in sys.stdin:
  d=json.loads(l); m=re.sub(r"\d+\.\d+\.\d+\.\d+","<ip>",d["_msg"]).split("INFO]: ")[-1]; print(d["_time"][:19].replace("T"," "), m[:300])'; }
q 'container_name:idkcraft-bot _time:3h -"waiting for players" | sort by (_time) | fields _time,_msg' > $S/bot.txt
q 'container_name:idkcraft-mc _time:3h | sort by (_time) | fields _time,_msg' | grep -v -E "UUID of|logged in with" > $S/mc.txt
```

Keep the full date in the timestamp: sessions cross midnight UTC and a plain `HH:MM` string compare silently mixes days. Sessions are bounded by `spawned as IdkBot` … `leaving: nobody online` in bot.txt and `joined/left the game` in mc.txt. mc.txt `_time` is the log-shipping time and is unreliable: it lags by tens of seconds and the shipper attaches each server message to the PREVIOUS line's timestamp. Use the server's own `[HH:MM:SS INFO]` time inside the message (keep it: drop the `.split("INFO]: ")` when you need times). Order events by bot.txt, use mc.txt for *what* happened (chat, deaths, `/tp`).

Which build was running: `gh run list --limit 10 --json headSha,updatedAt,displayTitle` — the deploy that finished before the session's `spawned` line is the build. Name it (PR numbers) in the report.

## 3. What each bot log line means

- `decision source=<stub|laya|jev|stub-fallback|local-idle> action=<fight|follow|idle|roam|lead|gather|craft|build|gohome|stay|rest> sprint= dist=<to player> moving=<pathfinder isMoving> path=<success|partial|timeout|noPath> reset=<why the path was reset>` — one per tick. `dist` is distance to the followed player; `moving=true` is the pathfinder's opinion, NOT proof the body moves (it stays true on partial/timeout paths).
- `brain route=easy fsm=<a>` / `brain route=hard reason=<case> model=<a> fsm=<b> source=<laya|jev>` — whether the model was asked (hard states only today). `brain disagree ... state=...` — model vs FSM, with the full state text.
- `stuck reason=wedge pos= dist=` — displacement-based stuck recovery fired (follow/roam/lead). `reset=stuck` — pathfinder's own stuck reset. `reflex swing <mob>`, `reflex flee`, `eat <food>`, `death health= hostiles= nearest=`, `respawn at`, `kit ...`, `scout <ore> xN at`.
- Work mode (epic rw4): goal step changes are chatted and logged (`on my own: …`, `working step=…`); `status` in chat prints `working step=<s> logs= planks= home=`.
- Chat commands the owner uses: `follow me`, `stop`, `go work`/`free`, `status`, `find me <ore>`, `lead anyway`, `build here`.

## 4. How to find the cause

1. Timeline first: list owner chat + commands from mc.txt, and for each one the bot's first reaction in bot.txt (`Following <name>`, action change). A command with no reaction = handler or mode bug; a reaction without movement = body bug.
2. For "didn't come": after `follow me`, check `action=` (is it really `follow`, or still `gather`/`lead`/work step overriding it?), `dist` over time (shrinking = coming; flat = stuck; growing = walking away), `moving`, `path=`, and `stuck`/`wedge` lines. Flat `dist` with `moving=true` = stuck body. `dist=none` = bot doesn't see the player (other chunk / too far / player entity not loaded) — check whether follow handles an unseen target.
3. Death/loss: `death` lines, mc `was slain by`/`fell from`/`blown up`, `respawn at` (bot may respawn far away at world spawn — then `dist` jumps).
4. Metrics for the window: `idkcraft_bot_decisions_total`, `idkcraft_bot_brain_routes_total`, `idkcraft_bot_events_total`, `idkcraft_bot_online`, `idkcraft_bot_tick_duration_seconds_*`, `idkcraft_bot_nodejs_eventloop_lag_max_seconds`, `laya_predict_duration_seconds_*`. Use `query_range` with `start/end` = session bounds. Event-loop lag > 1 s means the bot froze (sync scans).
5. Then read the code path that produced the bad lines (`bot/src/index.js` ticker/handleChat, `bot/src/behaviours/*.js`, `bot/src/goal.js`, `bot/src/perception.js`, `bot/src/brain.js`) and name the exact branch. Reproduce with the fake-player harness in `bot/test` if cheap.

Compare sessions when useful (before/after a fix): same counts (hard/easy routes, disagreement %, wedge count, deaths, time from `follow me` to `dist<4`) side by side, and say which build each ran.

## 5. Output

- Beads (`bd create -t bug`), one per root cause, in Russian like the recent ones (`bd show idkcraft-gk6`): ЧТО (timestamps UTC + the quoted log lines as evidence), ПОЧЕМУ (code path, file:function), ЧТО СДЕЛАТЬ (smallest fix), ACCEPTANCE (a test in bot/test that fails today). Priority P1 if it breaks follow/safety, P2 otherwise. Check `bd list --status open` first — add a note to an existing bead instead of duplicating.
- A short report back: session window + build, timeline of the owner's commands and bot reactions, root causes with bead ids, numbers (routes, disagreements, latency, deaths, stuck events), and anything you could not explain.
- Do not write code, commit, push, or touch prod.
