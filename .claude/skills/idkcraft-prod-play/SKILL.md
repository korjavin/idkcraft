---
name: idkcraft-prod-play
description: Run a real play session with the idkcraft bot on the prod server via the puppet player — join as IdkTester, script chat commands and walks, then review the window. Trigger when the owner says "run a play session", "test the bot on prod", "погоняй бота", "проверь на проде", or an agent needs a live session without the owner.
---

# idkcraft prod play (puppet)

You play the owner's part: the puppet (`bot/tools/puppet.js`) joins prod as
`IdkTester` and you drive it over localhost HTTP. The bot sees a real player
(entity, chat, roster), so follow/build/bring orders behave exactly as with
the owner online. The JSONL transcript is your session record.

## 1. Start

Prod host/port live in the stash, never in the repo. Resolve them at runtime,
never echo them or write them into files, beads, PRs, or reports:

```bash
KV=~/.local/bin/kv
# key names follow the stash convention; list and pick the prod mc host/port
H=$($KV get "<prod-mc-host-key>"); P=$($KV get "<prod-mc-port-key>")
node bot/tools/puppet.js --host="$H" --port="$P" --http-port=18080 > /tmp/puppet.log 2>&1 &
```

Startup prints the transcript path (`/tmp/idkcraft-puppet-<pid>.jsonl`).
Env alternative, same keys: `PUPPET_HOST`, `PUPPET_PORT`, `PUPPET_NAME`,
`BOT_USERNAME`, `PUPPET_HTTP_PORT`, `PUPPET_LOG`, `PUPPET_IDLE_MS` (see
`bot/tools/README.md`). Needs: the puppet name whitelisted on prod (offline
UUID entry, never op), and NO human online — otherwise it refuses with exit 2
and no join. Check `GET /state` shows `state: online` before scripting.

## 2. Script a scenario

Control is `localhost` only (`POST /say`, `/goto`, `/look`, `/stop`, `GET
/state[?n=N]`, `POST /quit`):

```bash
C=localhost:18080
curl -s -XPOST $C/say -d '{"text":"follow me"}'
curl -s -XPOST $C/goto -d '{"x":100,"y":64,"z":-200}'  # walks; never digs/towers
sleep 20; curl -s "$C/state?n=5"   # poll: bot pos+dist, roster, last chat
curl -s -XPOST $C/stop -d '{}'
curl -s -XPOST $C/quit            # always quit when done
```

Keep sessions short and purposeful: one scenario per run (follow, one work
order, one walk). Note the UTC window (first/last transcript timestamps) for
the review step.

## 3. Yield to humans — no exceptions

- A human joining makes the puppet say goodbye and leave within 2 s; later
  control calls return `409 human online`. On a 409 (or `state: yielded`):
  stop the scenario, `POST /quit`, and report the session as cut short.
- Never rejoin while a human is on, never ask for op, never touch server
  config. A teleport, if ever needed, goes via rcon over the prod-debug path.
- No control call for 15 min quits the puppet by itself (crashed-agent net);
  `/state` polls do not count — plan one control call per 15 min or quit.

## 4. Review the window

Hand the UTC window + transcript to the existing session-review flow
(`idkcraft-session-review` skill): pull `idkcraft-bot`/`idkcraft-mc` logs for
the window, match each `/say` against the bot's first reaction, file beads
per root cause. Puppet sessions read `chat from=IdkTester` in the bot log
(and `IdkTester` in the server log) — quote them as the session bounds.
Redact IPs before quoting any line anywhere.
