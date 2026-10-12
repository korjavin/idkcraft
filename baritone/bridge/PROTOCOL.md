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
  `dig.once`/`place.once` may run longer (30 s).
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
| GoalNear/GoalBlock/GoalGetToBlock | `#goto x y z` (GetToBlock keeps the spike cell for now — unused in bot/src; gets the neighbour treatment if a caller appears) |
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
