# One-body bridge protocol (idkcraft-neuc)

Target: ONE body — the whole Node logic (castle, goals, orders, recovery)
runs on a real headless client (HeadlessMc + Fabric + Baritone) instead of
mineflayer, via a Node adapter (`bot/src/bridge/index.js`) that looks like mineflayer's
`bot` to the logic. The client carries a small Fabric mod
(`mod/`, live since neuc.1) that exposes state+actions over a socket.
Baritone itself only moves/mines/builds-from-schematic and exposes no
world/inventory read API to an outside process, so without the mod the
adapter cannot see anything.

## Wire shape

One TCP port on the client (default 7778, next to the 7777 write-only
console bridge; never published outside the compose network / rig):

- `ws://<client>:7778/rpc` — JSON-RPC 2.0 over websocket, Node calls mod.
  One call = `{jsonrpc:'2.0',id,method,params}`; reply =
  `{jsonrpc:'2.0',id,result|error}`. Timeouts are per call (5 s default);
  `place.once` may wait on the client thread; a dig's outcome arrives
  as notifications (see the dig/place section).
- The same socket streams mod->node events as notifications (no `id`):
  `{jsonrpc:'2.0',method,params}`. The adapter folds them into `bot.emit`.

JSON, not NBT/cbor: debuggable over `websocat`, and the 10 Hz state poll
is ~200 bytes. Binary chunk snapshots (prod `chunk.get`) ride as base64
inside the same envelope — no second port.

## Implemented methods (neuc.1 core + neuc.3 entities)

| method | params | result | mineflayer surface |
|---|---|---|---|
| `hello` | — | `{mod,v,mc,baritone}` | handshake (version gate) |
| `state.get` | — | `{pos:{x,y,z,yaw,pitch,onGround,vel},health,food,oxygen,time,spawn,isRaining,isSleeping,dimension,gameMode}` (all null offline) | `entity/position/health/food`, `time`, `game`, `isRaining` |
| `chat.send` | `{message}` (`/…` runs a command) | `{sent:true}` | `chat(msg)` |
| `baritone.cmd` | `{command}` e.g. `#goto x y z` (`#` stripped) | `{id}` (fresh id per cmd; goal cmds arm the tracker) | `pathfinder.setGoal/stop` |
| `baritone.status` | — | `{id,pathing,last}` (`last`: `none` before any terminal) | `isMoving`, `path_update`/`path_reset` |
| `entities.list` | — | `{entities:[…]}` (shape in the entities section below) | `bot.entities[id]` |
| `roster.get` | — | `{players:[…]}` | `bot.players[name]` |
| `input.set`/`input.clear` | partial booleans / — | `{states}` | `setControlState`/`clearControlStates` (neuc.13 section below) |

Events: `chat {username,uuid,message,position:'chat'}` (player chat),
`message {message,position:'system'|'game_info'}` (system lines, action bar,
disguised chat), `baritone.event {id,status}` (`success|noPath|timeout|
stopped`), `player.joined {name,uuid}` / `player.left {name,uuid}`,
`entity.gone {id}` (best-effort; the list diff is the reliable channel).
Unknown methods fail `-32601` (the adapter treats unimplemented surfaces
as best-effort); `-32602` is bad params (incl. unknown Baritone
commands), `-32603` internal, `-32001` client busy (the client thread
didn't answer in 3 s), `-32002` not in world.

Units are mineflayer's, by design (the adapter maps them straight onto
`bot`): yaw/pitch are mineflayer-convention radians (not MC degrees);
`vel` is blocks/tick; `oxygen` is `round(airTicks/15)` (0–20);
`time` mirrors mineflayer's formulas (`timeOfDay` 0–23999, `isDay` below
13000, frozen daylight reads `|clock|`); `dimension` is the full id
(`minecraft:overworld`); `gameMode` the name (`survival`); `spawn` the
world shared spawn (player bed/anchor refinement deferred). `state.get`
while the client is at the menu returns every key present and null (never
an error) so the adapter polls for `pos`.

Goal ids (replaces the spike's witnessed-motion latch — revmux 01 core-3,
02 core-1 — which re-issued `follow.js` every tick on synthesised
terminals): every accepted `baritone.cmd` mints a fresh monotonic id
(from 1; 0 = no cmd yet), but only a goal-issuing command re-arms the
tracker: the custom goal changed across the execute (Baritone news a
`Goal` per setGoal, so even a same-spot re-issue counts), another
process took control (`#goto <block>` routes to GetToBlock and never
touches the custom goal), or a process command
(`follow/mine/build/explore/farm/elytra`) re-issued onto its live
process. Controls (`#stop`/`#pause`/`#resume`/`#set`/…) return their id
and leave the live goal armed; their ids never resolve. Events and `status.id`
carry the TRACKED goal id; a superseded goal receives NO terminal event
(the adapter binds the echoed goal id and drops anything else). First
terminal per tracked id wins; later events for it drop. Mapping:
`AT_GOAL`→`success`, `CALC_FAILED`→`noPath`, `CANCELED`→`success` when
the feet stand in `mostRecentGoal` (Baritone cancels the segment as
arrival cleanup, and `AT_GOAL` never fires then — incl.
goto-where-you-stand), else swallowed within 10 ticks of the goal cmd
(the superseded segment's cancel), else `stopped`. `NEXT_CALC_FAILED`
and the other `PathEvent`s are lookahead chatter, never terminal. No
terminal within 120 s of walking → `{id,timeout}` plus a mod-issued
`#stop` to halt the body; a bridge-issued `#pause` freezes that budget
(it bills walking time, not paused time) — a `#pause` typed in game
chat still bills the goal, the mod only sees bridge traffic (and a
`#resume` from any other channel leaves the freeze on until the next
goal or `#stop`). `#stop`'s
`CANCELED` resolves the TRACKED goal id as `stopped` (idle stops stay
silent). A cmd issued at the menu resolves `stopped` on the next tick —
no player to drive.

## Prod methods (sized, not in the spike)

Ordered by the bead's ask (which surface is easy/hard). Sizes are
engineer-days for mod+adapter+harness, calibrated on the measured
coupling (1793 `bot.*` sites in 64 files; counts from `rg` on master).

Easy (spike-proven shape, 1–4 d each):

- `state.get` extensions (`time.get`, `spawn.get`) — the client owns them;
  adapter caches. 26 `time` + 25 `spawnPoint` sites. (1 d)
- `entities.list` (players+mobs in view distance, pos/health/name) +
  `roster.get` (tab list) + `player.joined/left` events — client world
  iteration + `ClientPlayNetworkHandler.getPlayerList()`. 21 `entities` +
  14 `players` sites, but perception fans them out, so the stream must
  carry velocity/pose; Floodgate dot names pass through untouched. (3–4 d)
- `chunk.get {cx,cz}` snapshot + `block.update` stream — replaces the
  spike's N+1 `block.get`. The adapter keeps mineflayer's sync `blockAt`
  (268 sites) reading a local cache; misses read unloaded (null), exactly
  as today. Full `Block` parity (hardness, `harvestTools`, shapes) reuses
  prismarine-block via the passed-through `registry` — 90 `registry`
  sites need zero bridge traffic. (2–3 d)
- `find.scan` — once the chunk cache exists, `findBlocks` (25 sites) is a
  local scan; no mod call at all. (2 d, after the cache)
- `baritone.cmd` extensions (`#mine`, `#follow`, `#stop`, `#pause`) +
  the settings map (`Movements` -> `settings.txt`: `scafoldingBlocks`,
  `canDig`, `allowParkour`, `allowSprint`, doors — the head follows on
  foot today, so `allowParkour` stays off). Proven pattern: the A/B rig
  already drives `#goto`/`#mine` through the console bridge. (3 d)

Medium (a week each, needs the parity harness):

- Dig/place timing parity: mineflayer's `dig` promise resolves on the
  break tick and aborts on displacement; `placeBlock` honours reach,
  yaw/pitch and `_placeBlockWithOptions` timing taps. The mod must drive
  `ClientPlayerInteractionManager` tick-accurately (tool select, attack
  break progress, abort) and report `dig.progress` events; `stuck.js`
  reads `targetDigBlock` mid-dig. 39 `dig` + 34 `placeBlock` + 18
  `canDigBlock` sites. (5 d)
- Entity-event parity (`blockUpdate`, `playerLeft`, `death`/`respawn`,
  `kicked`/`error`/`end`, `physicsTick` synth at poll rate,
  `path_update`/`path_reset` from Baritone callbacks). `index.js` wires
  13 `bot.on` events; every one needs a mod source or a documented drop.
  (5 d)
- `look/lookAt/attack/activateBlock/activateItem` (12+12+2+4 sites):
  Baritone owns the crosshair while pathing, so each call must
  pause/resume Baritone around one client interaction tick. Design risk
  is low but every call site needs a rig pin. (5 d)

Hard (weeks, the go/no-go drivers):

- Windows/crafting: `craft` (19) + `clickWindow` (13) + `openChest/
  openFurnace/openContainer` (9) + `recipesFor/recipesAll` (12) +
  `currentWindow/closeWindow`. The mod must drive client
  `ScreenHandler`s (inventory clicks, recipe book resolve, furnace
  progress slots) while the server window id churns underneath; the
  2x2-grid strand workaround in `craft.js` assumes mineflayer click
  semantics tick-for-tick. No Baritone help exists. (10–15 d)
- Physics/control states: `setControlState` (36) + `clearControlStates`
  (21) + `sleep/wake/consume` + the swim/snow/jumpcost/nocorner
  pathfinder customisations + the recover pillar/jump timers. Baritone
  does not take injected inputs; the adapter must pause Baritone and
  feed `Input`/`KeyBinding` state per client tick, then resume without
  losing the goal. The water-bucket climb (Baritone fails DUGPIT-BARE
  in the A/B — no bucket escape) has no Baritone path and stays a
  hand-driven control sequence. (10 d + accepted behaviour deltas)
- Packet taps (`unpin.js`, `decontact.js`, `detour.js`) and the
  movement lease in `body.js`: mineflayer-packet-level hacks with no
  client equivalent. Rewrite as Fabric mixins or drop with a behaviour
  change each — every one needs a corpus re-baseline. (5–10 d)
- Test migration: 213 `bot/test` files mock mineflayer sync shapes and
  the e2e harness calls `mineflayer.createBot`. The adapter needs a
  FakeTransport-backed `createBot` shim plus a rig parity gate (both
  bodies side by side as TWO players — the hybrid rig — diffing
  decisions, not items) before any cutover. (5–10 d)

## Why the cutover is big-bang (and what de-risks it)

One name = one connection: either mineflayer connects or the real
client connects. There is no shadow mode for one body, so the adapter
must cover every surface the logic touches before the logic can run on
it — 1793 sites, no incremental prod traffic. What de-risks it:

1. Land the hybrid first (epic idkcraft-jlda): the worker slot doubles
   as the adapter parity rig (two players, decision diff).
2. Cut the adapter in three phases — walk (movement+state+chat),
   touch (+dig/place/inventory/entities), live (+windows/controls/
   parity) — each gated on the stuck corpus + BED-60/MINE-10 on the rig.
3. Keep mineflayer as the rollback: the adapter is a seam under
   `bot/`, the logic stays byte-identical (this spike changes zero
   `bot/src` files).

## Console backend (spike-only, DELETED by neuc.2)

The spike's `adapter.js` `backend:'console'` sent pathfinder goals as
`msg #goto` lines through the existing write-only HMC bridge
(`baritone/client.sh` plumbing) with no mod and no state. It existed
only so `rig-goto.js` proved the `#goto` leg on real iron before the mod
was written; both are deleted (neuc.5 brings the real harness). Prod
never used it (no status, no state, position-blind `isMoving`).

## Pathfinder parity (idkcraft-neuc.4)

Goal-id attribution: `baritone.cmd` echoes `{id}` per `#goto`; the
adapter binds the newest send's echo (sequence-guarded: a superseding
setGoal/stop/re-issue invalidates in-flight binds and drops the old id
at once, so a late terminal for it can neither clear the follow arm nor
verdict a goal Baritone no longer runs) and applies
`baritone.status {id,pathing,last}` /
`baritone.event {id,status}` only for the latched id — older, foreign,
or no-goal verdicts drop. A terminal for the live id emits `path_update
{status}` + `path_reset` (`success` → `goal reached`, else the status
verbatim) exactly once; the cleared latch drops the second channel.
`stop()` on a live goal sends `#stop` + `path_reset 'stopped'` (no
`path_update`: v1's stop leaves the status sticky); idle stops stay
silent like v1. Unknown `last` verdicts fail as `timeout` (retry-safe,
never synthesised success).

Already-satisfied goals never reach Baritone: when `goal.isEnd(feet)`
holds, setGoal stops the live walk and emits the success pair with no
command. v1 ends the same way (A* start isEnd), while Baritone's
setGoalAndPath returns before CALC_STARTED with no PathEvent for an
in-goal `#goto` — sending one would wedge `isMoving` (revmux 01 core-1).
Worldless place/look one step away also succeed (a clean isEnd=false is
honoured; feet==p and p-at-head are excluded like v1's isStandingIn —
v1 steps out first, so the walk does too).

Goal → command map (extends the spike's five):

| goal | command |
|---|---|
| GoalNear | `#near x y z r` — the mod's own verb (not a Baritone console command): sets Baritone's `GoalNear(BlockPos, r)` on the custom goal process, tracked like any `#goto`; `r = floor(sqrt(rangeSq))`, so the region is never wider than v1's isEnd. Malformed `near` → INVALID_PARAMS. Why (idkcraft-neuc.21): `#goto x y z` is an exact GoalBlock, and callers centre GoalNear on cells nobody stands in (one above the floor, a log, a chest) — rig at the prod spawn wedge: 7/10 GoalNear(r=2) goals within 7 blocks answered noPath (or stopped in range and still said noPath), 10/10 success with `#near` |
| GoalBlock/GoalGetToBlock | `#goto x y z` (GetToBlock keeps the spike cell for now — unused in bot/src; gets the neighbour treatment if a caller appears) |
| GoalXZ/GoalNearXZ | `#goto x z` |
| GoalY | `#goto y` (Baritone `goto <y>` = Y level, verified in GotoCommand) |
| GoalFollow | one-shot `#goto` at the live target + adapter re-issue (> 1 block drift, ≤ 1 cmd/s, dynamic only; follow.js still owns terminal/timeout re-issue) |
| GoalCompositeAny/All | first mappable member, else noPath |
| GoalPlaceBlock/GoalLookAtBlock | `#goto` at the neighbour cell on the bot's side (dominant horizontal axis; +x when above/below) — GoalBlock only past the goal's place range above the feet (roofs: Baritone pillars like v1's executor does when no ground node is in range; our own feet → noPath), else GoalXZ (rows 2-3, fills, floors, table look: v1 places those from the ground, so do we); our own column reports noPath at any level (GoalXZ counts any Y in it — an in-goal `#goto` is answered with silence); without feet there is no safe side → noPath (revmux 01 core-2, 02 core-2, 03 core-1/2, verify 01). Deep-below cells whose surface stands past place range fail visibly at the place attempt — a descend-first approach is wave-3 tuning if ever needed |
| GoalInvert, GoalBreakBlock | noPath (no `#goto` spelling; GoalBreakBlock throws on v1 — gather.js) |

Note for .1 (cc): every normal arrival emits AT_GOAL *then* CANCELED
(the process tick after the executor finishes runs CANCEL_AND_SET_GOAL),
and re-issues emit no CANCELED at all (FORCE_REVALIDATE goes through the
event-free softCancelIfSafe; cancelled calcs suppress CALC_FAILED —
verified in PathingBehavior/PathingControlManager). So: report AT_GOAL
as success, and never surface a CANCELED after a reported success as a
new verdict for that id — the adapter drops it as stale (id cleared),
but a reordered CANCELED-first would wrongly stop a live goal.

Movements → `#set` map (pushed on setMovements and every setGoal,
diffed — only changes cross; the first push is absolute over the image
settings.txt baseline):

| Movements | Baritone setting |
|---|---|
| canDig | allowBreak |
| allowSprinting | allowSprint |
| allowParkour | allowParkour |
| allow1by1towers | allowPlace |
| scafoldingBlocks ids | acceptableThrowawayItems (comma-joined names via the registry) |
| blocksCantBreak ids | blocksToAvoidBreaking (diggable names only — chest + deliberate adds; bedrock-class defaults need no telling) |

Unmapped ceilings: canOpenDoors (Baritone opens doors itself), Movements
blocksToAvoid (a future bead can send Baritone's own blocksToAvoid),
exclusionAreasBreak/Place + danger.addPathCost (function costs over
getNeighbors — no Baritone equivalent; // ponytail: danger marks not
mapped; Baritone avoidance settings if a prod pit repeats). Lists never
send empty (no `#set` spelling clears one); both are non-empty in
practice. bestHarvestTool mirrors mineflayer-pathfinder over inventory
digTime (enchantments read empty: prismarine-nbt is not a direct dep —
ranking may prefer an unenchanted tool, digs still work); getPathTo is a
sync `{status:'noPath',path:[]}` stub (no live callers — bring.js names
it as a future upgrade path).

## Control states (idkcraft-neuc.13)

Mod: `mod/src/main/java/idkcraft/bridge/Input.java` (+ pure `InputState.java`),
wired from `BridgeMod.onInitializeClient`. Node: `bot/src/bridge/input.js`
(`installInput` in the adapter constructor; `setBaritonePaused(bot, paused)`
exported for neuc.9's look/attack/activate reuse).

| method | params | result | mineflayer surface |
|---|---|---|---|
| `input.set` | `{forward?,back?,left?,right?,jump?,sneak?,sprint?}` booleans, absent = unchanged | `{states}` | `setControlState` (coalesced diff) |
| `input.clear` | — | `{states}` (all false) | `clearControlStates` |

`state.get` also reports `input:{states:{...}}`; the adapter adopts it only
when no local change is queued/in flight. Node mirror: `bot.controlState[k]`,
`bot.getControlState(k)`; invalid control/state throws like mineflayer.

Held semantics: states hold until changed/cleared. Per client tick, while
any key is held the mod swaps `LocalPlayer.input` for an adapter-owned
`ClientInput` republishing the held `Input` record (sneak = shift) and a
normalized move vector, restoring the original input on all-off. Direct
KeyBinding/`keyPresses` writes do not survive KeyboardInput.tick() or
Baritone's input override, and HeadlessMc `-lwjgl` has no key context —
the swapped object is what `LocalPlayer.applyInput` reads. Held jump
therefore repeats on ground; sprint rides the record's sprint flag.

Release on disconnect/quit: `BaritoneBot.quit()` sends `input.clear`
best-effort (bounded 500 ms) before closing the transport, and the mod
clears held inputs + resumes Baritone when the last bridge websocket
closes (`WsServer.onLastClose` → `Input.onDisconnect`), so a dead Node
process never leaves the body driving or paused. Only a pause issued by
input itself is resumed; a foreign pause is left alone. On reconnect the
adapter forces one `input.clear` before its first refresh.

Baritone pause/resume: the first held key runs Baritone `pause` through
`BridgeServer.executeBaritone` (also freezing the 120 s goal watchdog via
`pausedLocal`); clear/last-release runs `resume`. Pause/resume never
clears or re-mints the tracked goal id, so a latched goal continues after
a hand-driven episode with no re-issue and no spurious `path_reset` —
the adapter asserts this against FakeTransport (`inputPaused` flips, the
goal id is unchanged). FakeTransport scripts `input.set`/`input.clear`
and logs them in `inputLog`.

Rig acceptance deferred to the batched rig run: DUGPIT-BARE escapes via
the water-bucket climb, S6-PIT/HOME-PIT and recover sidestep/pillar rows
under `REPLAY_BODY=baritone` are not run by this PR (per repo rule, rig
runs batch on master).

## entities.list / roster.get (idkcraft-neuc.3)

Mod: `mod/src/main/java/idkcraft/bridge/Entities.java`
(`Entities.install(server)`, wired from `BridgeMod.onInitializeClient`).
Node: `bot/src/bridge/entities.js` (`refreshEntities` once per adapter poll
round, `handleBridgeEvent` first in the adapter's event router).

| method | params | result | mineflayer surface |
|---|---|---|---|
| `entities.list` | — | `{entities:[{id,uuid,type,name?,displayName,kind,pos{x,y,z},vel{x,y,z},yaw,pitch,health?,onGround,pose,self?}]}` | `bot.entities[id]` |
| `roster.get` | — | `{players:[{name,uuid,ping,gameMode}]}` | `bot.players[name]` |

`type` is `'player'` or the mob registry id (e.g. `'zombie'`);
`name` is set on players only (tab-list name, Floodgate dots untouched);
`kind` is `player|hostile|animal|other` from the client's MobCategory
(MONSTER→hostile, MISC→other, players→player, rest→animal);
`gameMode` is the numeric mode id (null when the entry carries none);
`self:true` tags the local player when the client world lists it.

Events: `player.joined {name,uuid}` / `player.left {name,uuid}` (tab-list
diff per client tick), `entity.gone {id}` (best-effort; the list diff is
the reliable channel — perception tolerates missing ids).

Node fold rules: entity objects mutate in place (stable refs across polls;
gone ones emit `entityGone`, flip `isValid=false`, unlink, delete); roster
entries merge with the matching player entity by uuid with `entity:null`
when out of range; roster/notification diffs emit `playerJoined` /
`playerLeft` / `entitySpawn` exactly once (whichever channel runs first
wins); `bot.entity` stays state.get-fed and is aliased under
`bot.entities[selfId]` when the wire tags it (mineflayer parity);
`bot.nearestEntity(filter)` mirrors mineflayer (skips `bot.entity`).
Non-player `entity.type` comes from the passed-through registry
(zombie→`hostile`, arrow→`projectile`, like v1; `flat.js` skips
`projectile`), kind bucket as fallback. Mob height/width come from the
same registry (zero bridge traffic); raw entity metadata is NOT streamed
yet (sheep wool reads fail open). A null network handler (real
disconnect) clears both snapshots; a null world with a live handler
serves last-good. BridgeServer seam: `onClientTick(Runnable)` plus
`register`/`push` over Gson `JsonObject`s (the snapshots stay plain
Maps/Lists and convert at the boundary). Node-side wiring is landed
(poll + router in `bot/src/bridge/index.js`); the mod half
(`Entities.install`) went live with .1's `BridgeServer`.

## Chunk cache (idkcraft-neuc.6)

Mod: `mod/src/main/java/idkcraft/bridge/Chunks.java`
(`Chunks.install(server)`, wired from `BridgeMod.onInitializeClient`).
Node: `bot/src/bridge/chunks.js` (poll-round initial fill + event router
in `bot/src/bridge/index.js`; the spike's N+1 `block.get` Map is gone).

| method | params | result | mineflayer surface |
|---|---|---|---|
| `chunks.list` | — | `{columns:[{cx,cz}]}` | loaded columns |
| `chunk.get` | `{cx,cz}` | `{cx,cz,minY,sections:[{y,states}]}` | one prismarine-chunk column |

`y` is the section Y (blockY/16, e.g. -4 in the overworld); `states` is
base64 of 4096 int16-LE **global block-state ids** in section-local
`(y<<8)|(z<<4)|x` order, or null for an all-air section. Ids are the
client's own (`Block.getId(state)` over `BLOCK_STATE_REGISTRY`) — the
same numbering minecraft-data 26.1.2 uses, so Node builds real
prismarine-blocks from them (the rig smoke asserts this numbering;
see smoke step 5b). An unloaded `{cx,cz}` fails `-32002`.

Events: `chunk.loaded {cx,cz}` / `chunk.unloaded {cx,cz}` (inbound
chunk packets, packet-fed loaded set), `block.update {x,y,z,stateId}`
(single + multi-block packets fan out per cell; no mixins — the core
packet hook in `BridgeServer.onPacket`).

Node fold: `bot.world = new World(null).sync` (prismarine-world via
mineflayer's deps, no new npm dep), columns = prismarine-chunk filled
by `setBlockStateId` per section; `block.update` → `setBlockStateId` +
`bot.emit('blockUpdate', old, new)` (unloaded column: silent, like
mineflayer). `bot.blockAt(pos)` = `world.getBlock` (miss = null),
`bot.findBlocks`/`findBlock` = a port of mineflayer
`lib/plugins/blocks.js` over the same columns, `bot.world.raycast` and
`bot.canSeeBlock` come from prismarine-world, `bot.canDigBlock` =
diggable + eye reach 5.1 with liquids/bedrock refused.

Initial fill: on the first poll round, `chunks.list` → columns within
4 chunks (Chebyshev) of the body load at once, the rest at ≤4 columns
per 100 ms in the background; `chunk.loaded` fetches near columns at
once and queues the rest the same way, with at most 4 `chunk.get` calls
in flight (the mod serves one connection serially). A failed
fetch retries once in the background, then waits for the next
`chunk.loaded`. `bot.game.minY`/`height` start at the overworld
defaults (-64/384) and refine from each `chunk.get`.

## inventory.get / select / equip / toss (idkcraft-neuc.8)

Mod: `mod/src/main/java/idkcraft/bridge/Inventory.java`
(`Inventory.install(server)`, wired from `BridgeMod.onInitializeClient`).
Node: `bot/src/bridge/inventory.js` (`installInventory` in the adapter
constructor — before `spawn`, so `reflexes.installEquipGuard` can wrap
`bot.equip`; poll folds `inventory.get`, `_handleEvent` folds the update).

| method | params | result | mineflayer surface |
|---|---|---|---|
| `inventory.get` | — | `{selected, slots:[{slot,name,count,damage,maxDamage,enchantments:[{name,level}],customName}]}` (non-empty slots only) | `bot.inventory` window |
| `inventory.select` | `{hotbar:0..8}` | snapshot as above | `bot.setQuickBarSlot` / `quickBarSlot` |
| `inventory.equip` | `{slot,dest:hand\|off-hand\|head\|torso\|legs\|feet}` (dest may be a numeric slot — the adapter's unequip move) | snapshot as above | `bot.equip`/`bot.unequip` |
| `inventory.toss` | `{slot,count}` | snapshot as above | `bot.toss`/`bot.tossStack` |

Event: `inventory.update {slot,item:{...}|null,selected}` per changed slot
(diffed per client tick; `item` carries the same fields as a `slots` entry).

Slot numbering is mineflayer's player-window numbering on the wire and in
Node: 5-8 armor (head/torso/legs/feet — `fight.js` hard-codes them), 9-35
main, 36-44 hotbar, 45 offhand. `name` is the registry id (`minecraft:`
prefix stripped Node-side). Actions run one at a time on the client thread
through the player's own `inventoryMenu` (pickup/swap clicks, no window
open; armor goes by the same swap, a piece the slot rejects never lands);
equipping a hotbar stack to the hand only moves the selection, like v1.
An equip resolves only when the destination slot holds the item afterwards
(mod checks, adapter re-verifies, mineflayer's error strings where the
logic matches: `Invalid item object in equip ...`, `invalid destination:`).

Node fold: `bot.inventory` is a prismarine-windows window when the package
and a full registry resolve (transitive via mineflayer — dynamically
loaded, zero new deps), else a minimal window with the same reads
(`items()` = slots 9-44, `slots[]`, `count`, `emptySlotCount`,
`firstEmptyInventorySlot`, `findInventoryItem`); items are prismarine-item
instances when resolvable (`name/type/count/displayName/durabilityUsed`,
`enchants` in prismarine-item's `{name,lvl}` shape, `customName` as a plain
prop). `bot.heldItem = slots[36+selected]`; ops serialise through one
adapter chain. `bot._syncWindow`/`currentWindow` are NOT here (.11/.12).

## Lifecycle: leaving the world (idkcraft-neuc.20)

The ws stays up while the client sits at the menu, so "connected" is not
"in world". The in-world signal is `state.get`: a non-null `pos` means
joined; the null snapshot means at the menu (disconnect/kick/never
joined).

- Mod: `baritone.cmd` fails `-32002` (not in world) whenever the client
  has no player/level — Baritone commands are never executed out of
  world (their goal code dereferences the null LocalPlayer). On world
  unload the mod executes `stop`, marks the tracked goal `stopped`, and
  clears `pathing`, so no pathing process ticks at the menu.
- Node adapter: after the first joined state, a null `pos` sustained
  past a 3 s grace (respawn/dimension swaps flap inside it) emits `end`
  once, exactly like a dropped v1 connection — `runOnce` fatal()s, the
  container restarts, and the handshake re-sends the console
  `connect <host> <port>`: that is the v2 rejoin path. `quit()` sends
  `#stop` (bounded to 1 s) before the console `disconnect`.

## Lifecycle: death and respawn (idkcraft-neuc.21)

A dead client sits on the death screen with a frozen `pos` (no auto
respawn), so every walk, sidestep and hop reads no-progress forever.
`respawn {}` → `{ok}` clicks respawn on the client thread
(a live player no-ops; `-32002` when not in world). The Node adapter
drives it off `state.get` `health` (mineflayer `respawn: true` parity):
alive→`health <= 0` emits `death`, then `respawn` is called at most once
per second while dead; the first live poll after that emits `respawn`.

## look / attack / interact / sleep (idkcraft-neuc.9)

Mod: `mod/src/main/java/idkcraft/bridge/Look.java`
(`Look.install(server)`, wired from `BridgeMod.onInitializeClient`; one
client-thread task per call via the `BridgeServer.onClient` seam).
Node: `bot/src/bridge/look.js` (`installLook` from the adapter
constructor, `handleLookEvent` in the adapter's event router).

| method | params | result | mineflayer surface |
|---|---|---|---|
| `look.set` | `{yaw,pitch,force}` (mineflayer radians) | `{ok}` | `bot.look(yaw,pitch,force)` |
| `look.at` | `{x,y,z}` | `{ok,yaw,pitch}` (aimed, mineflayer radians) | `bot.lookAt(point,force)` |
| `attack` | `{entityId}` | `{ok}` | `bot.attack(entity)` |
| `interact.block` | `{x,y,z,face,cursor{x,y,z},sneak}` | `{ok,result}` | `bot.activateBlock(block,direction,cursorPos)` |
| `interact.item` | `{hand:'main'\|'off',holdMs?}` | `{ok}` | `bot.activateItem(offHand)` |
| `interact.stop` | — | `{ok}` | `bot.deactivateItem()` |
| `sleep` | `{x,y,z}` (bed block) | `{ok}` | `bot.sleep(bedBlock)` |
| `wake` | — | `{ok}` | `bot.wake()` |

Events: `sleep {}` / `wake {}` on the player's sleeping-state edge
(per-tick hook in `Look`); the adapter flips `bot.isSleeping` and
re-emits mineflayer's `sleep`/`wake`.

Yaw/pitch stay mineflayer radians on the wire; the mod converts to
notch degrees (`notchYaw = deg(pi - yaw)`, `notchPitch = deg(-pitch)`,
the inverse of `state.get`'s conversion) and sets body + head rotation.
`look.at` aims from the real eye position on the client; the adapter
computes the same yaw/pitch locally for `bot.entity`.

Baritone pause/resume lives in the NODE adapter, not the mod:
`withBaritonePaused` (look.js, the one exported helper — neuc.7's
dig/place reuse it) sends `#pause` before and `#resume` after an
interaction only when `pathfinder.isMoving()`. `#pause`/`#resume` are
control commands: the tracked goal stays armed and its 120 s watchdog
freezes while paused. After resume the adapter re-checks
`baritone.status` for the latched goal id; a goal Baritone dropped
without a terminal verdict (not pathing, `last:'none'`) is re-issued
from the latched `pathfinder.goal`. Reflex-tick cheapness: `bot.look`
never crosses the wire for a sub-degree change (force always sends).

`consume()` = `interact.item` held until the held count drops or 2 s
pass, then `interact.stop`; no drop in the window rejects
(`consume: held item was not consumed`), and it rejects with
mineflayer's messages where mineflayer has one (`Food is full`, plus
`not holding any item`). The mod holds the client's use key for
continuous uses (eat/drink/bow — a use animation) until
`interact.stop`/the `holdMs` deadline, since vanilla releases a
one-shot use on the next tick; instant uses (buckets) never hold.
`interact.item` with `holdMs` also auto-stops on the client when the
deadline passes. `sleep` waits up to 3 s for the sleeping state and
rejects `bot is not sleeping` (mineflayer's timeout message); `wake`
rejects `already awake` and `sleep` rejects `already sleeping` /
`wrong block : not a bed block`, all mineflayer's strings.

Doors while pathing: Baritone opens doors itself, so the adapter's
`activateBlock` is a no-op for `*_door` blocks while
`pathfinder.isMoving()` (a reflex toggle would double-toggle the panel
shut). Adapter-side only; `doors.js` is untouched.

## Event parity (idkcraft-neuc.10)

Mod: `mod/src/main/java/idkcraft/bridge/Lifecycle.java`
(`Lifecycle.install(server)`, wired from `BridgeMod.onInitializeClient`;
packet taps ride the `BridgeServer.onPacket` seam, edges ride
`onClientTick`). Node: `bot/src/bridge/lifecycle.js`
(`installLifecycle` + `handleLifecycleEvent` in the adapter's event
router), plus the poll synthesis in `bot/src/bridge/index.js`.
`state.get` also carries `saturation` since this bead (the adapter maps
it to `bot.foodSaturation`). death/respawn are neuc.21's (see its
Lifecycle section above): `_noteLife` emits them off the state.get
health edge and drives the Look `respawn` RPC; this bead's lifecycle
fold shares the same `_dead` latch, so a stray mod death/respawn push
can never double-emit, and `bot.respawn()` is that same RPC.

Every `bot.on`/`bot.once` wire in `bot/src` (index.js spawn/message/
chat/path taps + lifecycle, behaviours/util.js, unpin.js) and its v2
source — no empty rows:

| event | mod source | adapter emit (mineflayer shape) | test |
|---|---|---|---|
| `spawn` / `login` | first `state.get` with non-null pos (createBot handshake) | `login`, then `spawn`, no args | bridge-body: handshakes then login+spawn |
| `message` | `ClientboundSystemChatPacket` / disguised chat (BridgeServer capture) | `(msg, position, senderUuid)` | bridge-body: chat events arrive as chat + message |
| `chat` | `ClientboundPlayerChatPacket` | `(username, message)` (+ `message` twin) | bridge-body (same test) |
| `path_update` | Baritone PathEvent bus via GoalTracker (neuc.4) | `({status})` on the attributed terminal | bridge-pathfinder |
| `path_reset` | same terminal / `#stop` | `(reason)` (`goal reached` on success) | bridge-pathfinder |
| `physicsTick` | none — synthesised at the 100 ms poll cadence (every in-world round) | no args; `doors.doorShutFast` throttles to 250 ms itself | bridge-lifecycle: physicsTick per poll round |
| `move` | same poll synthesis, position changed | `(oldPos)` Vec3 of the previous position | bridge-lifecycle: move carries the old pos |
| `forcedMove` | same, jump > 8 blocks between polls | no args | bridge-lifecycle: >8 blocks is forcedMove |
| `death` | adapter `_noteLife` off the `state.get` health edge (neuc.21) | no args; `isAlive=false`; `_dead`-guarded (no re-fire) | bridge-lifecycle: death/respawn/spawnReset shapes |
| `respawn` | same: first live poll after the Look `respawn` RPC revives the body (neuc.21) | no args; `isAlive=true` | bridge-lifecycle (same) + runOnce death→respawn logs |
| `spawnReset` | `ClientboundGameEventPacket` NO_RESPAWN_BLOCK_AVAILABLE, or tick spawn-point change (first observed = baseline, no fire) | no args | bridge-lifecycle (same) |
| `health` | tick change of health/food/saturation | no args, after `bot.health/food/foodSaturation` update | bridge-lifecycle: health updates before emitting |
| `entityHurt` | `ClientboundDamageEventPacket` `{id}` | `(entity)` resolved from `bot.entities` (self aliased); mineflayer's 2nd `source` arg DROPPED — no consumer in bot/src | bridge-lifecycle: entityHurt resolves ids |
| `entityGone` | Entities tick id diff `entity.gone {id}` (neuc.3; the list diff is the reliable twin) | `(entity)`, then `isValid=false` + delete | bridge-lifecycle (same) + bridge-entities |
| `entitySpawn` | Entities `entities.list` diff (neuc.3) | `(entity)` | bridge-entities |
| `playerCollect` | `ClientboundTakeItemEntityPacket` `{collectorId,itemId}` | `(collector, collected)` entity objects | bridge-lifecycle: playerCollect resolves ids |
| `playerJoined` / `playerLeft` | Entities roster tick diff + `roster.get` (neuc.3) | `(player)` roster entry | bridge-entities |
| `rain` | tick edge: `level.isRaining()` change `{raining}` | no args, after `bot.isRaining` update | bridge-lifecycle: rain and time |
| `time` | tick cadence: once per 20 client ticks `{age,timeOfDay}` | no args, after `bot.time` update | bridge-lifecycle: rain and time |
| `sleep` / `wake` | Look tick sleeping-state edge (neuc.9) | no args, `bot.isSleeping` flipped first | bridge-look |
| `blockUpdate` | `block.update` notification (neuc.6 Chunks) | `(oldBlock, newBlock)` from the chunk cache (`chunks.handleChunkEvent`) | bridge-chunks |
| `diggingCompleted` / `diggingAborted` | Interact `dig.done` / `dig.abort` notifications (neuc.7) | `(newBlock)` / `(block)` from the adapter `dig()` (interact.js); no `bot.on` consumer in bot/src | bridge-interact: dig progress -> done, abort |
| `windowOpen` / `windowClose` | `window.open` / `window.close` notifications (neuc.11 Windows) | `(window)` prismarine-windows window; no `bot.on` consumer in bot/src (mineflayer's open* use it internally) | bridge-windows: openChest -> windowOpen, close -> windowClose |
| `kicked` | `ClientboundDisconnectPacket` / login disconnect `{reason,loggedIn}` | `(reason, loggedIn=true)` — runOnce fatal()s it like v1 | bridge-lifecycle: kicked carries (reason, loggedIn) |
| `end` | disconnect packet; a silent drop with no packet is neuc.20's sustained null-pos grace in the adapter poll (`bridge: left world`) | `(reason)`; once per disconnect (the transport-close twin drops; our own `quit()` is not doubled) | bridge-lifecycle: end fires once + runOnce wanted-end resolves |
| `error` | transport ws error / handshake failure (createBot) | `(Error)` — runOnce fatal()s it like v1 | bridge-body: unknown hello.mc surfaces as error |

Deliberate drops: the deprecated `physicTick` alias (no consumer);
`entityHurt`'s source entity (no consumer); a dimension-change
`respawn` packet while not dead (mineflayer fires it, but index.js's
createLifecycle already pairs respawn lines to deaths, so the visible
behaviour is identical); physics consumers that only make sense under
prismarine-physics (the real client's own physics runs the body —
`physicsTick` here is a cadence tap, not a simulation step).

Logging/metrics parity (verified by the runOnce bridge-lifecycle test):
the death line prints on v2 (`deathLine` reads `bot.health` +
`buildState` over `bot.entities`, both bridge-fed), `respawn at …`
follows from `bot.spawnPoint`, and `metrics.setVitals` receives
health/food through the unchanged ticker (`buildState` →
`state.bot_health/bot_food`), with `setVitals(null)` on `end`.
## window.open / click / close (idkcraft-neuc.11)

Mod: `mod/src/main/java/idkcraft/bridge/Windows.java`
(`Windows.install(server)`, wired from `BridgeMod.onInitializeClient`).
Node: `bot/src/bridge/windows.js` (`installWindows` from the adapter
constructor, `handleWindowEvent` in the adapter's event router).

| method | params | result | mineflayer surface |
|---|---|---|---|
| `window.open` | `{x,y,z}` (container block) | menu (below), after the server's window lands (≤ 1.5 s, else `window.open: no window opened`; a click the block does not take fails at once) | `bot.openContainer`/`openChest`/`openDispenser`/`openFurnace` |
| `window.click` | `{windowId,slot,mouseButton,mode}` (mineflayer modes 0-6; slot `-999` = outside) | menu after the click | `bot.clickWindow`/`simpleClick` (+ `transfer`/`putAway`/`putSelectedItemRange`, window `withdraw`/`deposit`, furnace `put*`/`take*`) |
| `window.close` | `{windowId}` | `{ok}` | `bot.closeWindow`/`window.close()` |

Menu: `{windowId,type,title,size,slots:[{slot,...inventory slot fields}],cursor:{...}|null}`
— `type` is the menu registry id (`minecraft:generic_9x3`, `minecraft:furnace`, …),
`size` the menu's total slot count (container + 36), `slots` the non-empty
slots only, `cursor` the carried stack.

Events (diffed per client tick): `window.open` (menu, also for a window
the server opened), `window.slot {windowId,slot,item|null}`,
`window.close {windowId}` (our close or the server's).

Slot numbering is the vanilla menu order = mineflayer's window numbering:
container slots first, then the player's 27 main + 9 hotbar (a 9x3 chest:
0-26 chest, 27-53 main, 54-62 hotbar). Window id 0 is the player
inventory menu (clicks only; `window.close` on it is a no-op). `inventory.equip`/`toss`
close an open container first (vanilla drops window-0 clicks while one is
up); the `window.close` push clears Node's `currentWindow`. A click on
a window that is no longer the open one fails `stale window <id>`.

The client runs every click (`handleContainerInput`) and tracks the
server's state id itself, so window-id/revision churn never reaches
Node. Node does not predict: each click reply replaces the window's
slots + cursor, and the container's player section is folded into
`bot.inventory` on the spot (mineflayer `copyInventory`); later server
corrections arrive as `window.slot`.

Node fold: windows are prismarine-windows windows built from the same
factory as `bot.inventory` (`inventory.js windowFactory`); `withdraw`/
`deposit`/`transfer`/`putAway`/`putSelectedItemRange` are mineflayer's
click algorithms over `clickWindow`, with its error strings
(`destination full`, `Can't find <name> in slots [a - b]`, `Unable to
withdraw, Bot inventory is full.`); a click that moves nothing fails
(`transfer: click on slot N moved nothing`) instead of spinning. Furnace
windows carry `inputItem/fuelItem/outputItem`, `takeInput/takeFuel/
takeOutput`, `putInput/putFuel`. Baritone is paused across `window.open`
and each `window.click` while pathing (`withBaritonePaused`, goal
restored after) — per call, not for the window's lifetime, so a window
left open (furnace.js keeps one across smelt ticks) never stalls a walk.

Not on this wire: `window.property` (furnace fuel/progress — the
furnace's `fuel`/`progress` fields stay null; furnace.js reads output
growth only), entity containers (`openContainer(entity)`: no logic site
uses it), `bot._syncWindow` (craft.js falls back to its settle wait; .12).

## dig / place (idkcraft-neuc.7)

Mod: `mod/src/main/java/idkcraft/bridge/Interact.java`
(`Interact.install(server)`, wired from `BridgeMod.onInitializeClient`).
Node: `bot/src/bridge/interact.js` (`installInteract` in the adapter
constructor — before `spawn`, so util.js `trackPlaced`/`installPlaceTiming`
wrap `bot.placeBlock`; `handleInteractEvent` in the event router).

| method | params | result | mineflayer surface |
|---|---|---|---|
| `dig.start` | `{x,y,z,face,look}` | `{ok}` at once; the outcome is a notification | `bot.dig(block, forceLook, digFace)` |
| `dig.abort` | — | `{ok,aborted}` | `bot.stopDigging()` |
| `place.once` | `{x,y,z,face,yaw,pitch,cursor{x,y,z},sneak}` — x,y,z = the TARGET cell, `face` = the clicked face of the reference (ref = target − face) | `{ok,result}` (vanilla InteractionResult) | `bot.placeBlock(ref, faceVector)` |

Notifications: `dig.progress {x,y,z,progress}` (0..1 on each destroy-stage
change), `dig.done {x,y,z,broke,stateId}` (the cell's new state),
`dig.abort {x,y,z,reason}` with reason `moved` (out of interaction
reach) | `changed` (the block became something else, or a new
`dig.start` replaced it) | `timeout` (30 s) | `unreachable` (no player /
dead) | `cancelled` (`dig.abort` call).

Dig (client thread): picks the hotbar tool that breaks the block strictly
faster than the held stack (tool speed / 30 harvestable, / 100 not —
pathfinder bestHarvestTool simplified, enchants ignored), aims at the
face centre unless `look:false`, then drives the break like Baritone's own
BlockBreakHelper through its `IPlayerController`: `clickBlock` once,
`onPlayerDamageBlock` + swing per client tick, `setHittingBlock(false)`
after each (else vanilla's per-tick `continueAttack(false)` aborts the
dig: the headless client never holds the attack key). Done = the block
turned air/liquid on the client (mineflayer resolves on its predicted
air too; a server refusal arrives as a `block.update` that restores the
cache). A cell that is already air answers `dig.done {broke:false}`.

Node: `bot.dig` rejects like mineflayer (`dig was called with an
undefined or null block`, `dig time for <name> is Infinity`), sets
`targetDigBlock` for the dig's life, resolves on `dig.done` (writing the
cell through the chunk cache and emitting `blockUpdate` + 
`diggingCompleted`), rejects `Digging aborted (<reason>)` on the mod's
abort and `Digging aborted` on `stopDigging()` (emitting
`diggingAborted`); a 35 s guard covers a lost notification. Baritone is
paused for the whole dig while pathing (`withBaritonePaused`).
`bot.placeBlock` looks at the face centre (mineflayer's point; the mod
sets the rotation and clicks in one client-thread task), then settles on
the server's `block.update` for the target like mineflayer
`place_block.js`: a type change resolves (`blockPlaced`), an unchanged
answer rejects `Server refused to place <item> at (x, y, z): the block
is still <name>`, silence for 1 s rejects `Server did not answer the
placement at ...`; no held item rejects `must be holding an item to
place`. `bot.swingArm` is a no-op (the mod swings itself);
`_placeBlockWithOptions` stays absent (castle.js stairs fall back to
`placeBlock`). Not on this wire: sneak-placing against interactables
(the mod takes `sneak`, the adapter sends false like mineflayer), the
deep.js raw `block_dig` burst (neuc.14).
