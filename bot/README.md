# IdkCraft bot

Node 22 container that joins the Paper server, follows the player, and gets
reflex decisions from JEV (TypeSafe AI) — or from a built-in stub when
`TYPESAFE_API_KEY` is absent.

## Run locally

```sh
cd bot
npm ci
npm test            # unit checks (stub + mocked JEV)
MC_HOST=localhost node src/index.js
```

E2E against a throwaway server (needs Docker):

```sh
sh test/mc-up.sh            # terminal 1: Paper, offline-mode, whitelist off
MC_HOST=localhost node src/index.js          # terminal 2: the bot (brain=stub)
MC_HOST=localhost node test/e2e-follow.js    # terminal 3: FakePlayer check
```

## Env vars

| Var | Default | Meaning |
| --- | ------- | ------- |
| `MC_HOST` | `mc` | Minecraft server host (`localhost` for local runs) |
| `MC_PORT` | `25565` | Java server port |
| `BOT_USERNAME` | `IdkBot` | Bot login name |
| `BOT_FOLLOW` | `` (nearest player) | Player name to follow |
| `BRAIN_TICK_MS` | `1000` | Reflex tick interval |
| `TYPESAFE_API_KEY` | `` (stub brain) | JEV key; bogus key still joins, logs `stub-fallback` |

In-game chat: `follow me` locks onto the speaker, `stop` clears the lock.

Cost guards: with no player online the bot makes no JEV calls at all (local
idle decision, slow 10 s poll, at most one log line per minute). While a
player is visible the tick stays at `BRAIN_TICK_MS`, but an unchanged
perception state (distance rounded to 1 block, same flags) reuses the last
decision instead of calling JEV again.

## Online-mode note

The server runs offline-mode, so the bot uses `auth: 'offline'` — no
Microsoft account needed. If the server ever flips to online mode, the only
bot change is `auth: 'microsoft'` in `src/index.js` plus a `profilesFolder`
volume for the auth cache; nothing else changes.
