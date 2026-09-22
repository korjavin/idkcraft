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
  - `fight`: Reachable hostile mob within 8 blocks of bot, or any hostile near the player, with bot health >= 6. A mob flagged `hostile_reachable=false` (fight gave up pursuit) yields to `follow` unless it threatens the player.
  - `follow`: Player moved away (> 3 blocks while moving or with hostile near, > 6 blocks while standing still with no hostile near).
  - `roam`: Player is within 6 blocks and not moving, no hostile mob near (strolls within 6 blocks of player, walks back past 6, never > 8).
  - `idle`: Player within 3 blocks and moving, low-health retreat within 3 blocks with hostile near, or nobody online / parked.
  The brain also decides whether to `sprint` when the player is > 8 blocks away (the remote model also checks that the player is moving, while the stub triggers on distance alone). Fight wins over both follow and roam; follow preempts roam when the player walks away.
- **Execution is local (`src/behaviours/*.js`):** The selected action is dispatched to the corresponding behaviour module via `BEHAVIOURS` in `src/index.js`. Scouting has zero body cost and runs every tick while a player is visible, alongside whatever decision is executing.

### Behaviours Table

| Behaviour | Trigger | Who decides | How to observe |
| --- | --- | --- | --- |
| `follow` | Player > 3 blocks away while moving or with hostile near, > 6 blocks while still (sprints if > 8 blocks; remote checks player moving) | Brain decision (`action=follow`) | Walk away from bot; bot paths toward player (sprints if you run far ahead) |
| `fight` | Reachable hostile within 8 blocks of bot OR near player, and health >= 6 (unreachable mob yields to `follow` unless near player) | Brain decision (`action=fight`) | `/summon zombie ~5 ~ ~`; bot equips first sword and attacks (1 swing/s within 3 blocks) |
| `roam` | Player within 6 blocks and standing still, no hostile near (strolls up to 6 blocks, walks back past 6, never > 8) | Brain decision (`action=roam`) | Stand still near bot; bot strolls within 6 blocks of player (walks back if past 6) |
| `idle` | Player within 3 blocks and moving, low-health retreat within 3 blocks with hostile near, or nobody online / parked | Brain decision (`action=idle`), or local reflex | Stand still near bot; bot stops pathfinding and waits quietly |
| `scout` | Every 5 s within 16-block radius | Local reflex (no brain cost; runs every tick while player visible) | `/setblock ~2 ~ ~ diamond_ore`; bot announces vein in chat within 5 s |

### Reflex Mechanics & Implementation Details

- **Fight (`src/behaviours/fight.js`):**
  - **Candidate Ranges:** Hostile mob within 8 blocks of bot OR 6 blocks of player, with `bot_health >= 6`. The state line adds `hostile_reachable=false` once pursuit is abandoned (see below); the stub and the prompt criteria refuse an unreachable mob unless it is near the player.
  - **Exclusions:** Creepers are excluded (striking a creeper near the player causes detonations; fleeing is out of scope). Players and passive mobs are never targeted.
  - **Sticky Target:** Locks onto current hostile with a 2-block hysteresis margin (`STICKY_MARGIN_BLOCKS = 2`) so the bot does not flip-flop between targets on every tick.
  - **Pursuit Give-Up & Shadow Fallback:** If pathfinding stalls for 18 stationary ticks (`GIVE_UP_TICKS = 18`, retrying pathing every 6 ticks), pursuit is abandoned (e.g. mob trapped behind glass or in a ravine) and the give-up latch is fed back to the brain as `hostile_reachable=false`, so the brain arbitrates the yield to `follow`. The bot shadows the player at 3 blocks as a local safety net while still swinging if the mob wanders within 3 blocks (`SWING_RANGE = 3`). The ticker clears the latch after 30 ticks (`FIGHT_REPROBE_TICKS = 30`) so a changed world gets a fresh pursuit. Shadow mode also activates if the brain returns `fight` when no hostile is reachable.
  - **Equipment & Combat:** Equips the first sword in inventory upon engaging (fists if none). Swings once per second at <= 3 blocks range (`SWING_RANGE = 3`).
- **Roam (`src/behaviours/roam.js`):**
  - **Stroll Envelope:** Strolls within 6 blocks of a standing player (`ROAM_RADIUS = 6`). When idle and not already moving, picks a random destination within 6 blocks (`GoalNear(x, y, z, 1)`), ensuring the destination never exceeds 8 blocks from the player.
  - **Walk-Back Past Envelope:** If distance to player exceeds 6 blocks (`HAND_BACK_DIST = 6`), walks back toward the player (`GoalFollow(target, 3)`) rather than standing still, avoiding state-cache freezes and letting the brain re-evaluate on the next tick.
  - **Preemption & Hierarchy:** Follow preempts roam when the player walks away; fight wins over both whenever a hostile mob threatens.
- **Scout (`src/behaviours/scout.js`):**
  - Scans loaded chunk blocks in memory every 5 s within a 16-block radius (sees through walls and underground).
  - Valued ores: diamond, emerald, ancient debris, gold, iron, lapis, redstone (deepslate variants grouped under base name; coal and copper excluded).
  - Reports at most 3 lines per scan in chat (one per ore type, highest value first) as `<ore> x<count> at <x> <y> <z>`.
  - Deduplicates positions (seen cache capped at 5,000 entries) so the bot never repeats announcements while standing still.

### Chat Commands

#### How to talk to the bot

- **Opening chat:**
  - **Nintendo Switch / Bedrock:** Press **Right on the D-pad** to open chat (default controller layout; check **Settings → Controls → Chat** if remapped), type your message, and press the send button.
  - **Java Edition:** Press **T** to open the chat window.
- **NO leading slash:** Type commands directly as plain text (e.g. `follow me`, not `/follow me`). Any message starting with a slash (`/`) is treated by Paper as a server command, so the bot never receives it.
- **Case-insensitive:** Commands are case-insensitive (`follow me`, `FOLLOW ME`). Block names for search should be in English, snake_case (e.g. `coal_ore`, `diamond_ore`, `iron_block`).
- **Command list & replies:**
  - `follow me` — Locks onto you and resumes following, replying with `Following <username>` (e.g. `Following Player`).
  - `stop` — Parks the bot in place and cancels movement immediately; stays parked quietly without sending a chat reply.
  - `find me <block>` (e.g. `find me coal` or `find me diamond_ore`) — Searches loaded chunks within 48 blocks. The bot replies with `<block> at <x> <y> <z> (<N> blocks)` (e.g. `coal_ore at -12 64 200 (14 blocks)`), `no <block> within 48 blocks`, or `unknown block: <block>`.
- **Bot chat & ore reports:** The bot answers command responses in chat; if no reply appears within ~2 s, check the log line `decision source=...` is still flowing. The bot also broadcasts unsolicited ore announcements when its scouting reflex detects veins (e.g. `diamond_ore x4 at -60 12 -180`); these are autonomous scout reflex announcements, not replies to commands.

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

## Reading the logs

The bot logs one line per tick, so a saved log plus a text search answers
most "why did it do that?" questions. The compose stack caps each container log at 20 MB (`json-file` driver,
`max-size: 20m`; the prod host runs podman, whose log driver does not accept
`max-file`), so history survives the host-journal vacuuming that used to eat
a day of play in ~2.5 h.

Get a log:

```sh
# From Portainer: Containers -> <bot container> -> Logs -> Download.
# From a shell next to the server:
docker logs --timestamps <bot-container> > bot.log 2>&1  # 2>&1 matters: disagree/tick-error lines go to stderr
# Death causes come from the server side (the bot only sees it died):
docker logs <mc-container> | grep 'IdkBot was'
```

Summarise a saved log:

```sh
sh bot/scripts/logstats.sh bot.log
```

It prints counts per `action=` and per `source=`, the brain-disagreement
count, deaths, respawns, tick errors, the `stub-fallback` count, and the
first/last timestamp (timestamps only appear when the log was saved
with `--timestamps`).

Line types:

| Line | Meaning |
| --- | --- |
| `decision source=<s> action=<a> ...` | One per tick while a player is visible (at most one per minute when idle). Compare `source=laya` against the stub to judge the model. |
| `brain disagree source=<s> model=<a> stub=<r> ...` | The remote brain answered differently from the local reference policy. A high rate means the prompt criteria and the rules drifted apart. |
| `scout <ore> x<n> at <x> <y> <z>` | New ore vein reported in chat (local reflex, at most 3 lines per 5 s scan). |
| `death health=<n> hostiles=<k> at <x> <y> <z>` | The bot died. Match its timestamp against the server log (`was slain by ...`, `was shot by ...`) for the cause; `hostiles=` is the nearby-hostile count at that moment. |
| `respawn at <x> <y> <z>` | The bot reappeared (auto-respawn). Coords are the respawn destination (world spawn — the bot sets no bed), because the position field still holds the death coords at that instant. Strictly one per death: `respawn` packets from dimension changes are not logged. A death with no respawn after it means the bot never came back. |
| `tick error: ...` | The tick threw instead of deciding; the bot retried on the next tick. Frequent lines here point at perception or brain bugs, not at the model. |

## Online-mode note

The server runs offline-mode, so the bot uses `auth: 'offline'` — no
Microsoft account needed. If the server ever flips to online mode, the only
bot change is `auth: 'microsoft'` in `src/index.js` plus a `profilesFolder`
volume for the auth cache; nothing else changes.
