# IdkCraft bot

Node 22 companion bot that joins the Paper server, follows the player, scouts
for valuable ore, and fights hostile mobs. Built around a "one body, many senses"
concurrency architecture: perception and scouting are local, always-on reflexes,
while the System-1 brain (remote LAYA/JEV model or built-in stub) arbitrates who
owns the body each second.

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
| `BRAIN_URL` | JEV endpoint | Remote brain URL (same JEV wire shape); set to the sidecar to run without a key, decisions then log `source=laya` |
| `BRAIN_TIMEOUT_MS` | `BRAIN_TICK_MS` | Per-call deadline for the remote brain |

Cost guards: with no player online the bot makes no brain calls at all (local
idle decision, slow 10 s poll, at most one log line per minute) and performs no
scout scans. While a player is visible the tick stays at `BRAIN_TICK_MS`, but an
unchanged perception state (distance rounded to 1 block, same flags) reuses the
last decision instead of calling the brain again.

## Behaviours & Arbitration

The bot uses a "one body, many senses" model to handle concurrent activities without conflicting controls:

- **Perception is local and always-on (`src/perception.js`):** Every tick, the bot computes distances, player movement, and hostile mob proximity. These are factual inputs, not decisions.
- **The Brain arbitrates the body (`src/brain.js`):** The pathfinder and attack mechanics share a single physical body. Every tick (1 s), the System-1 classifier chooses ONE exclusive action:
  - `fight`: Hostile mob threatening bot or player.
  - `follow`: Player moved away.
  - `idle`: Player is close (<= 3 blocks).
  The brain also decides whether to `sprint` when the player is > 8 blocks away (the remote model also checks that the player is moving, while the stub triggers on distance alone).
- **Execution is local (`src/behaviours/*.js`):** The selected action is dispatched to the corresponding behaviour module via `BEHAVIOURS` in `src/index.js`. Scouting has zero body cost and runs every tick while a player is visible, alongside whatever decision is executing.

### Behaviours Table

| Behaviour | Trigger | Who decides | How to observe |
| --- | --- | --- | --- |
| `follow` | Player > 3 blocks away (sprints if > 8 blocks; remote checks player moving) | Brain decision (`action=follow`) | Walk away from bot; bot paths toward player (sprints if you run far ahead) |
| `fight` | Hostile within 8 blocks of bot OR 6 of player, and health >= 6 | Brain decision (`action=fight`) | `/summon zombie ~5 ~ ~`; bot equips first sword and attacks (1 swing/s within 3 blocks) |
| `idle` | Player within 3 blocks, or nobody online / parked | Brain decision (`action=idle`), or local reflex | Stand still near bot; bot stops pathfinding and waits quietly |
| `scout` | Every 5 s within 16-block radius | Local reflex (no brain cost; runs every tick while player visible) | `/setblock ~2 ~ ~ diamond_ore`; bot announces vein in chat within 5 s |

### Reflex Mechanics & Implementation Details

- **Fight (`src/behaviours/fight.js`):**
  - **Candidate Ranges:** Hostile mob within 8 blocks of bot OR 6 blocks of player, with `bot_health >= 6`.
  - **Exclusions:** Creepers are excluded (striking a creeper near the player causes detonations; fleeing is out of scope). Players and passive mobs are never targeted.
  - **Sticky Target:** Locks onto current hostile with a 2-block hysteresis margin (`STICKY_MARGIN_BLOCKS = 2`) so the bot does not flip-flop between targets on every tick.
  - **Pursuit Give-Up & Shadow Fallback:** If pathfinding stalls for 18 stationary ticks (`GIVE_UP_TICKS = 18`, retrying pathing every 6 ticks), pursuit is abandoned (e.g. mob trapped behind glass or in a ravine). The bot drops into shadow mode, following the player at 3 blocks as a bodyguard while still swinging if the mob wanders within 3 blocks (`SWING_RANGE = 3`). Pursuit is re-probed after 30 ticks (`SHADOW_REPROBE_TICKS = 30`). Shadow mode also activates if the brain returns `fight` when no hostile is reachable.
  - **Equipment & Combat:** Equips the first sword in inventory upon engaging (fists if none). Swings once per second at <= 3 blocks range (`SWING_RANGE = 3`).
- **Scout (`src/behaviours/scout.js`):**
  - Scans loaded chunk blocks in memory every 5 s within a 16-block radius (sees through walls and underground).
  - Valued ores: diamond, emerald, ancient debris, gold, iron, lapis, redstone (deepslate variants grouped under base name; coal and copper excluded).
  - Reports at most 3 lines per scan in chat (one per ore type, highest value first) as `<ore> x<count> at <x> <y> <z>`.
  - Deduplicates positions (seen cache capped at 5,000 entries) so the bot never repeats announcements while standing still.

### Chat Commands

| Command | Action | Implementation |
| --- | --- | --- |
| `follow me` | Locks onto speaker, resumes movement if parked | Sets `followName` to speaker, unparks ticker, replies `Following <username>` |
| `stop` | Parks the bot in place | Clears `followName`, pauses ticker, stops pathfinder; perception and scout continue running while a player is visible |
| `find me <block>` | Finds nearest block matching name within 48 blocks | Scans loaded chunks; replies with `<block> at <x> <y> <z> (<N> blocks)`, `no <block> within 48 blocks`, or `unknown block: <block>` |

### Brain Disagreement Logging

When running with a remote classifier (`source=laya` or `source=jev`), each decision is compared against `stubBrain`, which encodes the exact reference policy:
```
brain disagree source=<source> model=<action> stub=<ref> state=<state-line>
```
Logged to stderr whenever the model output diverges from the reference rules. This provides the owner with an immediate signal on model accuracy, disagreement rate, and edge cases where prompt criteria or classifications may need tuning.

## Online-mode note

The server runs offline-mode, so the bot uses `auth: 'offline'` — no
Microsoft account needed. If the server ever flips to online mode, the only
bot change is `auth: 'microsoft'` in `src/index.js` plus a `profilesFolder`
volume for the auth cache; nothing else changes.
