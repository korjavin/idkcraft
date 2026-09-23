# IdkCraft bot

Node 22 companion bot that joins the Paper server, follows the player, scouts
for valuable ore, and fights hostile mobs. Built around a "one body, many senses"
concurrency architecture: perception and scouting are local, always-on reflexes,
while the hybrid brain (rule FSM primary, remote LAYA/JEV model on named
hard states, built-in stub fallback) arbitrates who owns the body each second.

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

Step-up check (proves a movement fix in ~60 s): with the server and the bot
running as above, run `MC_HOST=localhost node test/e2e-step.js`. It drives the
server over RCON (`docker exec idk-mc rcon-cli`, enabled by mc-up.sh): `/fill`s
a 7x7 1-block stone plateau, walks the FakePlayer end to end on top (constant
motion keeps the stub on follow; a standing player would read as roam), and
asserts IdkBot climbs up within 15 s from a cardinal and a diagonal start,
printing the bot's y each second. A wedge shows as y hovering ~0.5 above ground until the 15 s
timeout; a healthy climb reaches plateau-top y on two consecutive samples and
passes. (RCON, not an opped FakePlayer: the `OPS`-seeded ops.json UUID does not
match offline-mode logins, so the server rejects chat-sent commands.)

## Env vars

| Var | Default | Meaning |
| --- | ------- | ------- |
| `MC_HOST` | `mc` | Minecraft server host (`localhost` for local runs) |
| `MC_PORT` | `25565` | Java server port |
| `BOT_USERNAME` | `IdkBot` | Bot login name |
| `BOT_FOLLOW` | `` (work mode) | Player name to follow; empty means the bot works on its own goal until `follow me` |
| `BRAIN_TICK_MS` | `1000` | Reflex tick interval |
| `TYPESAFE_API_KEY` | `` (stub brain) | JEV key; bogus key still joins, logs `stub-fallback` |
| `BRAIN_URL` | JEV endpoint | Remote brain URL (same JEV wire shape); when set, the hybrid brain runs: FSM primary, remote model on hard states only. Empty = FSM only (`brain=stub`); that is the rollback. |
| `BRAIN_TIMEOUT_MS` | `BRAIN_TICK_MS` | Per-call deadline for the remote brain |
| `BOT_LEAVE_AFTER_MS` | `60000` | Nobody-online grace (ms) before the bot quits and re-polls; `0` disables (always on) |

Cost guards: with no player online the bot makes no brain calls at all (local
idle decision, slow 10 s poll — 1 s while the melee reflex is swinging at a
hostile in reach, still no brain calls — at most one log line per minute) and
performs no scout scans (the nobody-online tick only scans entities for the
reflex) — and after `BOT_LEAVE_AFTER_MS` (default 60 s) with nobody online
it re-checks the server ping and, if still nobody is online, quits
(`leaving: nobody online`) and polls the server ping every 2 s until a
player appears (`waiting for players`, at most one line per minute), then
waits 4.5 s so Paper's 4 s connection throttle expires before joining. A player
online-but-far keeps it idling instead of flapping join/leave. Off the
server nothing can kill it and no chunks stay loaded for it. `BOT_LEAVE_AFTER_MS=0`
keeps the old always-on behaviour. While a player is visible the tick stays at
`BRAIN_TICK_MS`, but an unchanged perception state (distance rounded to 1 block,
same flags) reuses the last decision instead of calling the brain again. Easy states never call the model at all — the network is touched only on named hard states (see Hard states below).

## Behaviours & Arbitration

The bot uses a "one body, many senses" model to handle concurrent activities without conflicting controls:

- **Perception is local and always-on (`src/perception.js`):** Every tick, the bot computes distances, player movement, and hostile mob proximity. These are factual inputs, not decisions.
- **The Brain arbitrates the body (`src/brain.js`):** The pathfinder and attack mechanics share a single physical body. Two brains, one interface (`decide(state) -> {action, sprint, source}`):
  - The rule FSM (`stubBrain`) is PRIMARY: it decides every tick, and easy states never touch the network (`source=stub`).
  - The remote model (`source=laya` on the sidecar, `source=jev` on JEV) is consulted only on named hard states, and there the MODEL WINS. On timeout/error the FSM answer is used (`source=stub-fallback`, retried on the next state change).
  The per-action rules below are the FSM — still the whole policy on easy states:
  - `fight`: Reachable hostile mob within 8 blocks of bot, or any hostile near the player, with bot health >= 6. A mob flagged `hostile_reachable=false` (fight gave up pursuit) yields to `follow` unless it threatens the player.
  - `follow`: Player moved away (> 3 blocks while moving or with hostile near, > 6 blocks while standing still with no hostile near).
  - `roam`: Player is within 6 blocks and not moving, no hostile mob near (strolls within 6 blocks of player, walks back past 6, never > 8).
  - `idle`: Player within 3 blocks and moving, low-health retreat within 3 blocks with hostile near, or nobody online / parked.
  Sprint always comes from the rule FSM (`distance_to_player > 8`); it is no longer asked of the model. The body ignores it and always walks (`Movements.allowSprinting` stays false) because a sprint-jump wedges the bot flush against 1-block steps. Fight wins over both follow and roam; follow preempts roam when the player walks away.
  To help small classifier models discriminate state, the wire state sent to the remote brain uses categorical words rather than numbers: a leading `hard=<reason>` word naming the hard case (`low-health-hostile|unreachable-hostile|crowd|hostile-vs-far-player` — the one fact that distinguishes the hard states, passed by the router), then `player=near|far|away|none` (<=3 / <=6 / >6 / no target), `player_moving=yes|no`, `hostile=adjacent|near|far|none` (<=3 / <=8 / <16 / none), `hostile_near_player=yes|no`, `hostile_reachable=yes|no`, `health=low|ok` (<6 / >=6), and `food=hungry|ok`.
- **Execution is local (`src/behaviours/*.js`):** The selected action is dispatched to the corresponding behaviour module via `BEHAVIOURS` in `src/index.js`. Scouting has zero body cost and runs every tick while a player is visible, alongside whatever decision is executing.

### Hard states

`isHard(state)` names the states where the fixed rule is known to conflict
or to have failed. The FSM is a precedence chain, so exactly one rule always
fires — hardness is a judgement written down per case (first match wins),
not derived by counting. On these the remote model is consulted and wins:

| Name | Numeric condition (`isHard`) | Why the rules cannot decide | Who wins |
| --- | --- | --- | --- |
| `low-health-hostile` | hostile fact (`hostile_distance` is a number or `hostile_near_player`) and `bot_health < 6` | Bot at 4.9 hp shadowing while the player was slain 5 times: fight (protect) vs follow (survive) is a real judgement | model |
| `unreachable-hostile` | `hostile_reachable === false` (fight's give-up latch) | The rules already failed once on this mob; re-probe vs shadow the player is a guess | model |
| `crowd` | `nearby_hostiles >= 3` | The FSM roams into crowds; both bot deaths had 3-4 hostiles around it | model |
| `hostile-vs-far-player` | hostile fact and `distance_to_player > 8` | Chase the mob or run to the player; the legs are the question (the melee reflex swings regardless) | model |

### What the model is asked

Every named hard case is a fight-vs-follow judgement, so the wire question
is exactly that — two choices, one sentence of instructions ("The simple
rules could not decide this state; choose fight or follow."), rule-style
criteria on the categorical words plus the `hard=` word. Sprint is not
asked. Local smoke round against the sidecar (8 hard rows + 2
consistency repeats, `laya/smoke.py`):

| state | model | verdict |
| --- | --- | --- |
| H1 low-health (health low, hostile far, near player) | fight | wrong (fights while weak; rule says health is low -> follow) |
| H1b near (player far, hostile near, health low) | fight | wrong (fights while weak; rule says health is low -> follow) |
| H2 crowd (no hostile fact, health ok) | fight | matches rule (hard is crowd and health ok -> fight) |
| H2b crowd weak (hostile near, health low) | fight | wrong (fights while weak; rule says health is low -> follow) |
| H3 far-player (hostile adjacent, player away, health ok) | follow | matches rule (hostile-vs-far-player and player away -> follow) |
| H3b far weak (hostile near, health low) | follow | matches rule (health is low -> follow) |
| H4 unreachable (reachable no, near player no) | fight | wrong (nothing threatens the player; rule says unreachable-hostile -> follow) |
| H4b unreach-near-p (reachable no, near player yes) | fight | matches rule (hostile near player and health ok -> fight) |
| H1 repeat (same wire state as H1) | fight | consistent with H1 (no jitter this round) |
| H3 repeat (same wire state as H3) | follow | consistent with H3 |

Readout: 4/8 match; the model leans fight (fights all three low-health
rows plus the unreachable mob with nobody to protect). Caveats: H2b/H3b
are synthetic wire states the first-match router can never send, and
H3/H3b/H4b satisfy both criteria, so the decidable readout is 1/5 —
see the full table and verdicts in the idkcraft-872.3 PR body.

### Behaviours Table

| Behaviour | Trigger | Who decides | How to observe |
| --- | --- | --- | --- |
| `follow` | Player > 3 blocks away while moving or with hostile near, > 6 blocks while still (the brain may answer sprint when far, but the body always walks) | Brain decision (`action=follow`) | Walk away from bot; bot paths toward player at walking speed |
| `fight` | Reachable hostile within 8 blocks of bot OR near player, and health >= 6 (unreachable mob yields to `follow` unless near player) | Brain decision (`action=fight`) | `/summon zombie ~5 ~ ~`; bot equips first sword and attacks (1 swing/s within 3 blocks) |
| `roam` | Player within 6 blocks and standing still, no hostile near (strolls up to 6 blocks, walks back past 6, never > 8) | Brain decision (`action=roam`) | Stand still near bot; bot strolls within 6 blocks of player (walks back if past 6) |
| `idle` | Player within 3 blocks and moving, low-health retreat within 3 blocks with hostile near, or nobody online / parked | Brain decision (`action=idle`), or local reflex | Stand still near bot; bot stops pathfinding and waits quietly |
| `scout` | Every 5 s within 16-block radius | Local reflex (no brain cost; runs every tick while player visible) | `/setblock ~2 ~ ~ diamond_ore`; bot announces vein in chat within 5 s |
| `melee reflex` | Hostile within 3 blocks of the bot under any brain answer, even with nobody online | Local reflex (no brain cost; the arm, not the body) | Summon a zombie next to the bot while the brain answers `follow`; bot swings within 1-2 ticks with no `action=fight` decision |
| `flee reflex` | Creeper within 6 blocks (the brain never sees creepers) | Local reflex (no brain cost; walks 6 blocks away, never attacks) | Lure a creeper close; bot paths away and logs `reflex flee creeper dist=<d>` |
| `eat reflex` | Food < 18 and edible item in inventory, no hostile within 3 blocks | Local reflex (no brain cost; the gut, not the body) | `/give IdkBot bread 64`; bot eats until food >= 18 |

### Reflex Mechanics & Implementation Details

- **Fight (`src/behaviours/fight.js`):**
  - **Candidate Ranges:** Hostile mob within 8 blocks of bot OR 6 blocks of player, with `bot_health >= 6`. The state line adds `hostile_reachable=false` once pursuit is abandoned (see below); the stub and the prompt criteria refuse an unreachable mob unless it is near the player.
  - **Exclusions:** Creepers are excluded (striking a creeper near the player causes detonations; they are handled by the flee reflex below, never attacked). Players and passive mobs are never targeted.
  - **Sticky Target:** Locks onto current hostile with a 2-block hysteresis margin (`STICKY_MARGIN_BLOCKS = 2`) so the bot does not flip-flop between targets on every tick.
  - **Pursuit Give-Up & Shadow Fallback:** If pathfinding stalls for 18 stationary ticks (`GIVE_UP_TICKS = 18`, retrying pathing every 6 ticks), pursuit is abandoned (e.g. mob trapped behind glass or in a ravine) and the give-up latch is fed back to the brain as `hostile_reachable=false`, so the brain arbitrates the yield to `follow`. The bot shadows the player at 3 blocks as a local safety net while still swinging if the mob wanders within 3 blocks (`SWING_RANGE = 3`). The ticker clears the latch after 30 ticks (`FIGHT_REPROBE_TICKS = 30`) so a changed world gets a fresh pursuit. Shadow mode also activates if the brain returns `fight` when no hostile is reachable.
  - **Equipment & Combat:** Equips the first sword in inventory upon engaging (fists if none). Swings once per second at <= 3 blocks range (`SWING_RANGE = 3`).
- **Roam (`src/behaviours/roam.js`):**
  - **Stroll Envelope:** Strolls within 6 blocks of a standing player (`ROAM_RADIUS = 6`). When idle and not already moving, picks a random destination within 6 blocks (`GoalNear(x, y, z, 1)`), ensuring the destination never exceeds 8 blocks from the player.
  - **Walk-Back Past Envelope:** If distance to player exceeds 6 blocks (`HAND_BACK_DIST = 6`), walks back toward the player (`GoalFollow(target, 3)`) rather than standing still, avoiding state-cache freezes and letting the brain re-evaluate on the next tick.
  - **Preemption & Hierarchy:** Follow preempts roam when the player walks away; fight wins over both whenever a hostile mob threatens.
  - **Wedge Recovery:** After 2 `stuck` path resets with no displacement while the executor still reports moving, roam sidesteps 2 blocks + one jump (same recovery as follow) and picks a fresh stroll target, so two stucks on one goal are impossible. Logs `stuck reason=wedge`.
- **Scout (`src/behaviours/scout.js`):**
  - Scans loaded chunk blocks in memory every 5 s within a 16-block radius (sees through walls and underground).
  - Valued ores: diamond, emerald, ancient debris, gold, iron, lapis, redstone (deepslate variants grouped under base name; coal and copper excluded).
  - Reports at most 3 lines per scan in chat (one per ore type, highest value first) as `<ore> x<count> at <x> <y> <z>`.
  - Deduplicates positions (seen cache capped at 5,000 entries) so the bot never repeats announcements while standing still.
- **Creeper flee (`src/index.js`, `fleeReflex`):**
  - **Trigger:** Nearest creeper within 6 blocks (`CREEPER_FLEE_RANGE = 6`, via `findCreeper`; the brain excludes creepers from hostile facts, so this never routes to the model).
  - **Execution:** Walks 6 blocks directly away (`CREEPER_FLEE_DIST = 6`, `GoalNear`, re-issued when the creeper changes or the executor stalls — a chasing creeper makes a finished goal stale). Never swings: hitting one next to the player detonates it on the player. Logs `reflex flee creeper dist=<d>` once per creeper.
- **Eat Reflex (`src/index.js`):**
  - **Trigger:** When `bot.food < 18` and inventory holds an edible item (`bread`, `cooked_beef`, `cooked_porkchop`, `cooked_chicken`, `apple`, `carrot`, `baked_potato` — first match wins).
  - **Exclusions:** Skips while an eat is already in flight (`ctx.eatInFlight`) or a hostile is within swing range (`SWING_RANGE = 3`).
  - **Execution:** Equips food item to hand (`bot.equip(item, 'hand')`), consumes it (`bot.consume()`), then restores combat gear via `fightMod.equipGear(bot)`.
  - **Logging:** Logs `eat <item> food=<n>` per bite.

### Chat Commands

#### How to talk to the bot

- **Opening chat:**
  - **Nintendo Switch / Bedrock:** Press **Right on the D-pad** to open chat (default controller layout; check **Settings → Controls → Chat** if remapped), type your message, and press the send button.
  - **Java Edition:** Press **T** to open the chat window.
- **NO leading slash:** Type commands directly as plain text (e.g. `follow me`, not `/follow me`). Any message starting with a slash (`/`) is treated by Paper as a server command, so the bot never receives it.
- **Case-insensitive:** Commands are case-insensitive (`follow me`, `FOLLOW ME`). Block names for search should be in English, snake_case (e.g. `coal_ore`, `diamond_ore`, `iron_block`).
- **Command list & replies:** In game, say `help` for the command list and `help <command>` for usage with an example (e.g. `help find me`) — that reply is the source of truth, this file does not duplicate it.
- **Bot chat & ore reports:** The bot answers command responses in chat; if no reply appears within ~2 s, check the log line `decision source=...` is still flowing. The bot also broadcasts unsolicited ore announcements when its scouting reflex detects veins (e.g. `diamond_ore x4 at -60 12 -180`); these are autonomous scout reflex announcements, not replies to commands.

| Command | Action | Implementation |
| --- | --- | --- |
| `follow me` | Locks onto speaker, resumes movement if parked | Sets `followName` to speaker, unparks ticker, replies `Following <username>` |
| `stop` | Parks the bot in place | Clears `followName`, pauses ticker, stops pathfinder; perception and scout continue running while a player is visible, and the melee reflex still swings at a hostile within 3 blocks; clears work mode |
| `go work` / `free` | Releases the bot to work on its own goal | Sets work mode, unparks ticker, clears `followName`; replies `on my own; say 'follow me' to call me` |
| `status` | Reports mode, goal step, logs/planks, home | Replies e.g. `working step=rest logs=0 planks=0 home=none` |
| `find me <block>` | Finds nearest block matching name within 48 blocks | Scans loaded chunks (exposed ore first, then level with you); replies with `leading you to <name>, <N> blocks, follow me`, `no <block> within 48 blocks`, or `unknown block: <block>`; deep targets warn instead of leading |
| `lead anyway` | Walks to a warned-about deep target | Replays the held deep offer once, then forgets it (`no deep find on hold` when there is none) |

`find me <block>` also orders the bot to LEAD: it walks to the nearest match (`GoalNear` range 2), pauses when the player falls more than 12 blocks behind (`waiting for you, come to me (<N> blocks)`) and resumes once within 8 (`going on, <N> blocks left`), announces `here: <block> at <x> <y> <z>` on arrival, gives up with `cannot reach <block> at ...` when the vein stays unreachable or `giving up on <name>` when you never come back. The order overrides the brain like `stop` does, `fight` still preempts it, and `stop` / `follow me` cancel it. A successful `find me` unparks a stopped bot. Safety: ore more than 8 blocks below you is never led to blindly — the bot warns (`<name> is <N> blocks down, dig carefully`) and waits for `lead anyway`.

### Autonomy & chat commands

With no `BOT_FOLLOW` target the bot spawns into work mode and pursues its own
goal (see `src/goal.js`): at each decision point (new step, finished step, or
changed goal facts) the smart model picks the next step from the feasible menu
and the FSM stays the fallback and disagreement reference — exactly like the
hybrid brain. The bot announces every step change in chat
(`next: chopping wood (laya)`). `follow me` pulls it back to
following (clearing work mode); `go work` releases it again; `stop` parks it
until the next order; `status` reports mode, step, inventory and home. Work
continues while anyone is on the server (player roster, not visibility), and
the bot still leaves an empty server after the nobody-online grace.

Step choice goes through the shared `ask()` (`src/brain.js`): one question,
one label back, never a model pick (laya vs jev is the URL). LAYA answers
reliably only with up to 2 options, so a wider menu becomes a yes/no chain
over the options in order, first yes wins. A failed ask falls back to the FSM
step and counts `idkcraft_bot_escalation_total{from,to,reason}`.

### Brain route and disagreement logging

With the hybrid brain every brain call logs one route line to stdout:

```
brain route=easy fsm=<a>
brain route=hard reason=<r> model=<a> fsm=<b> source=<s>
```

On hard states the model's answer is also compared against `stubBrain`, which encodes the exact reference policy:
```
brain disagree source=<source> model=<action> stub=<ref> state=<state-line>
```
Logged to stderr whenever the model output diverges from the reference rules — so `brain disagree` now appears only on hard states. Note that the disagree log line deliberately retains the numeric `state=` representation (via `numericStateToText`) so downstream tools like `logstats.sh` can parse exact distances and metrics even though the remote model receives categorical words. This provides the owner with an immediate signal on model accuracy, disagreement rate, and edge cases where prompt criteria or classifications may need tuning.

How to read the ratio: `sh bot/scripts/logstats.sh bot.log` prints the
route easy / route hard counts plus the per-reason hard histogram — how
often the model is consulted (`route=hard` / all) and how often it
disagrees.

## Ops: gearing the bot

The bot fights with what it carries. An op hands it an iron kit once;
`keepInventory` keeps the kit through death.

```sh
/gamerule keepInventory true
/give IdkBot iron_sword
/give IdkBot iron_helmet
/give IdkBot iron_chestplate
/give IdkBot iron_leggings
/give IdkBot iron_boots
/give IdkBot cobblestone 64
/give IdkBot iron_pickaxe
/give IdkBot bread 64
```

- Run `/gamerule keepInventory true` once as op; the flag persists in
  `level.dat`. (Already enabled on the prod world; kept here as a note.)
  It also spares every player inventory on death — revert if unwanted.
- Then `/give` the iron set above; the bot equips the sword to hand and
  armor to head/torso/legs/feet on the next spawn and whenever it engages
  a hostile or the melee reflex fires.
- Then `/give IdkBot cobblestone 64`: the pathfinder only pillars and
  bridges when dirt/cobblestone is in inventory — 64 covers dozens of
  climbs, top up when the log shows `kit scaffold=0`.
- Then `/give IdkBot iron_pickaxe`: the pathfinder equips it via
  bestHarvestTool, so stone dig time drops from 7.5 s to 0.4 s and
  dig-through paths become cheap enough for A* to pick.
- Then `/give IdkBot bread 64`: natural regeneration requires food >= 18;
  the eat reflex consumes bread when food drops below 18, top up when the
  `kit` line shows `food=0`.
- To op yourself, add your name to the `OPS` env list on the stack and restart.

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

It prints counts per `action=` and per `source=`, the `route=easy` / `route=hard` counts with the per-reason hard histogram, the brain-disagreement
count, deaths, respawns, tick errors, the `stub-fallback` count, and the
first/last timestamp (timestamps only appear when the log was saved
with `--timestamps`).

Line types:

| Line | Meaning |
| --- | --- |
| `decision source=<s> action=<a> ...` | One per tick while a player is visible (at most one per minute when idle). Compare `source=laya` against the stub to judge the model. |
| `brain route=easy fsm=<a>` / `brain route=hard reason=<r> model=<a> fsm=<b> source=<s>` | One per brain call: which route was taken and both answers on hard states. `route=hard` / all = how often the model is consulted. |
| `brain disagree source=<s> model=<a> stub=<r> ...` | The model answered differently from the local reference policy (hard states only). A high rate means the prompt criteria and the rules drifted apart. |
| `scout <ore> x<n> at <x> <y> <z>` | New ore vein reported in chat (local reflex, at most 3 lines per 5 s scan). |
| `stuck reason=<s> pos=<x,y,z> dist=<d>` | Follow stalled at unchanged position across terminal results, or follow/roam wedged with the executor still reporting moving (`reason=wedge`); triggers jump + 2-block sidestep nudge. |
| `death health=<n> hostiles=<k> at <x> <y> <z>` | The bot died. Match its timestamp against the server log (`was slain by ...`, `was shot by ...`) for the cause; `hostiles=` is the nearby-hostile count at that moment. |
| `respawn at <x> <y> <z>` | The bot reappeared (auto-respawn). Coords are the respawn destination (world spawn — the bot sets no bed), because the position field still holds the death coords at that instant. Strictly one per death: `respawn` packets from dimension changes are not logged. A death with no respawn after it means the bot never came back. |
| `kit scaffold=<n> pickaxe=<yes|no> sword=<yes|no> food=<k>` | Inventory summary logged at spawn. |
| `eat <item> food=<n>` | The bot ate an edible item to sustain natural health regeneration. |
| `tick error: ...` | The tick threw instead of deciding; the bot retried on the next tick. Frequent lines here point at perception or brain bugs, not at the model. |
| `metrics on :<port>/metrics` | Prometheus endpoint is up (`:9464` on the bot, the sidecar API port on laya). |
| `reflex flee creeper dist=<d>` | Creeper flee reflex fired (once per creeper). |

### Metrics (Prometheus + Grafana)

Both containers expose Prometheus metrics (compose labels
`prometheus.scrape: "true"`; the house monitoring stack scrapes them
into VictoriaMetrics — graph them in Grafana, no log grepping needed):

- Bot `:9464/metrics` (`bot/src/metrics.js`): `idkcraft_bot_brain_routes_total{route,reason}` (easy vs hard + hard reason — the logstats ratio, live), `idkcraft_bot_brain_disagreements_total{model,stub}`, `idkcraft_bot_brain_request_duration_seconds{source}` (remote call latency incl. failures), `idkcraft_bot_tick_duration_seconds{brain_called}`, `idkcraft_bot_decisions_total{source,action}`, `idkcraft_bot_events_total{event}` (death, respawn, reflex_swing, spawn), `idkcraft_bot_state{fact}` (health, food, distances), `idkcraft_bot_online`.
- Sidecar `/metrics` on its API port (`laya/shim.py`): `laya_predict_duration_seconds` (model latency), `laya_answers_total{choice}` (fight vs follow + errors).

### Prod acceptance (2026-09-23, owner session on the live stack)

Two sessions (A 23:44–23:53 UTC on the pre-gk6 build; B 00:39–00:43 UTC
on 2aa98cc): the model is now consulted for real — A saw 16 hard / 327
easy calls (all `hostile-vs-far-player`), B 14 hard / 117 easy (8
far-player, 6 low-health-hostile).

- Latency well inside the tick: laya predict p50 0.13 s, p99 0.29 s;
  bot tick p99 0.36 s; event-loop lag max 0.22 s. No timeouts, no JEV
  errors — p50 stays far under `BRAIN_TICK_MS` (1000 ms).
- Disagreement (model vs FSM on hard states): A 3/16 (19%), B 10/14
  (71%), total 13/30 (43%) — but the direction is mostly wrong against
  our own criteria: adjacent hostile (1.4–2.0 blocks) with the player
  9–15 away answered `follow` x7 (criteria say fight when adjacent),
  low health answered `fight` x6 (criteria say follow when weak). The
  model discriminates, just not the way the prompt asks.
- Lead episode: `find me iron` arrived in 3 s; `find me gold` 45 blocks
  out (ore y 35–41, player ~66, `path=partial`) walked the player
  underground and the player fell to death at 00:42:43 — this is why
  deep targets now warn instead of leading. Chat narration
  (leading/waiting/going on/here) worked throughout.
- Scout, follow, wedge recovery (`stuck reason=wedge` x3), melee reflex
  all active; no bot deaths in B. Creeper flee untested (no creeper
  met). Owner vocabulary misses: `find me ore` fixed after the session (ore
  alias + plurals like `diamonds`); `rock` and typos such as `diamand`
  still answer `unknown block` (no fuzzy search, by design).

## Online-mode note

The server runs offline-mode, so the bot uses `auth: 'offline'` — no
Microsoft account needed. If the server ever flips to online mode, the only
bot change is `auth: 'microsoft'` in `src/index.js` plus a `profilesFolder`
volume for the auth cache; nothing else changes.
