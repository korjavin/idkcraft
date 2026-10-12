# One-body bridge protocol (idkcraft-kqzf spike)

Target: ONE body — the whole Node logic (castle, goals, orders, recovery)
runs on a real headless client (HeadlessMc + Fabric + Baritone) instead of
mineflayer, via a Node adapter (`bot/src/bridge/index.js`) that looks like mineflayer's
`bot` to the logic. The client carries a small Fabric mod
(`mod/`, skeleton in this spike) that exposes state+actions over a socket.
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

## Spike methods (implemented in `bot/src/bridge/transport.js` FakeTransport + `bot/src/bridge/index.js` — neuc.2 moved them into the bot image)

| method | params | result | mineflayer surface |
|---|---|---|---|
| `hello` | — | `{mod,v,mc,baritone}` | handshake (version gate) |
| `state.get` | — | `{pos:{x,y,z,yaw,pitch,onGround},health,food,baritone:{pathing,last}}` | `entity/position/health/food`, `isMoving` |
| `block.get` | `{x,y,z}` (floored) | `{name,x,y,z}` | `blockAt` via the sync cache |
| `inventory.get` | — | `{items:[{slot,name,count,type}]}` | `inventory.items()`, `heldItem` |
| `dig.once` | `{x,y,z}` | `{broke:name}` | `dig(block)` promise |
| `place.once` | `{x,y,z}` | `{placed:name}` | `placeBlock(ref,face)` promise |
| `chat.send` | `{message}` | `{sent:true}` | `chat(msg)` |
| `baritone.cmd` | `{command}` e.g. `#goto x y z` | `{accepted:true}` | `pathfinder.setGoal/stop` |
| `baritone.status` | — | `{pathing,last}` | `isMoving`, `path_update`/`path_reset` |

Events (spike): `chat {username,message}`, `death {}`, `respawn {}`,
`block.update {x,y,z,name}` (cache write-through), `baritone.event
{status}` (`success|noPath|timeout`, from a Baritone API listener in the
mod — the executive-poll fallback in `bot/src/bridge/index.js#refresh` is spike-only).

Status attribution (revmux 01 core-3, 02 core-1): the spike adapter
latches a goal generation per `setGoal`, arms a witnessed-motion flag on
the first `pathing:true` poll, and only trusts a `pathing:false`
terminal once motion was witnessed for THAT goal — a stale latch from a
previous goal (or still calculating) keeps the `setGoal` latch and stays
silent, because synthesising `success` (or even just flipping `isMoving`)
re-issues `follow.js` every tick and the body never moves. A goal that
fails before any poll shows motion must surface via the pushed
`baritone.event`, never the poll. Prod replaces the latch with a goal id
echoed through `baritone.cmd` → `baritone.status` (required, not optional:
the latch trusts that every goal shows motion on some poll).

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
setGoal/stop invalidates in-flight binds, overlapping follow re-issues
order by seq) and applies `baritone.status {id,pathing,last}` /
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
| GoalPlaceBlock/GoalLookAtBlock | `#goto` at the neighbour cell on the bot's side (dominant horizontal axis; +x when above/below) — GoalBlock only past the goal's place range above the feet (roofs: Baritone pillars like v1's executor does when no ground node is in range), else GoalXZ (rows 2-3, fills, floors, table look: v1 places those from the ground, so do we); our own column at/below feet level reports noPath (GoalXZ counts any Y in it — an in-goal `#goto` is answered with silence); without feet there is no safe side → noPath (revmux 01 core-2, 02 core-2, 03 core-1/2). Deep-below cells whose surface stands past place range fail visibly at the place attempt — a descend-first approach is wave-3 tuning if ever needed |
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
