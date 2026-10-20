'use strict'

// CASTLE-RIG (idkcraft-vmzq.20): unattended-build throughput harness. Run via
// castle-rig.sh (boots a disposable Paper, flattens nothing itself — the pad
// is built here). Flow: guide + follower join, a dirt pad is flattened at
// CASTLE_PAD, the follower's kit is emptied, the guide chats `autonomous on`
// + `build castle` through the real chat path, the guide quits (prod-alone
// parity: nobody online, autonomous on), the bot works CASTLE_MINS, and the
// run prints ONE verdict line plus a JSON record (CASTLE_OUT).
//
// The bot runs the REAL stack (index.runOnce) on real Paper physics:
// gather/craft/equip/fetch/build all run. The planner is the REAL JEV by
// default (RIG_PLANNER=jev, idkcraft-vmzq.23): the key arrives as
// TYPESAFE_API_KEY (never printed, never logged), the tick brain steps
// down to stub once the guide quits (prod-alone parity) while plan()
// keeps reaching JEV. RIG_PLANNER=stub keeps the deterministic stub brain
// for tests that need no network.
// Day is locked by the wrapper (gamerule), so the window measures work, not
// shelter. No baseline judging: this is a measurement loop instrument, the
// verdict line is the product.
//
// Env: CASTLE_HOST (localhost), CASTLE_PORT (25581),
//   CASTLE_CONTAINER (idk-castle), CASTLE_TAG (c + pid digits),
//   CASTLE_MINS (30), CASTLE_PAD ("300,300"), CASTLE_PADSPOT ("x,z", pins the
//   pad probe pick — controlled pairs set it on both legs), CASTLE_OUT (json path),
//   CASTLE_LOG (full log path; stdout keeps goal/need/blocked/death lines).
//   RIG_PLANNER (jev|laya|llm|stub, default jev), TYPESAFE_API_KEY (jev bearer),
//   ANTHROPIC_API_KEY (llm, vhlb.2).
//   CASTLE_NIGHT (1 = night mode, set by castle-rig.sh --night: the
//   wrapper skips the day lock, createNightDriver runs the nights).
//   CASTLE_SEED (complete = g0z.33: rcon-place the whole v2 castle + beds
//   + table on the pad, no order; the bot adopts it as its residence and
//   createResidenceNights reports entered/slept/shelter/deaths/dawn-exit).
//   CASTLE_SEED_VERSION (g0z.48: '' = current blueprint; 2 seeds the
//   complete castle as v2 and the guide chats `castle upgrade` through the
//   real chat path after adoption, so the window measures the stairs
//   relay; pair with CASTLE_KIT=stairs and read upgrade=<facing-ok>/<total>
//   @<phase> on the verdict).
//   CASTLE_IDLE (1 = 6x7.24, needs CASTLE_SEED=complete: the verdict adds
//   idle-maxdist/idle-miny/idle-underground-s, yard-litter=N (g0z.44: own
//   blocks left in the fence band, placedByBot + rcon readback) and a
//   CASTLE-RIG idle: PASS|FAIL line; FAIL exits 1).
//   CASTLE_IDLE_DEATH (N > 0 = 6x7.25, with CASTLE_IDLE: after N min the
//   follower is cleared and killed once, respawning with an empty kit
//   IDLE_RESPAWN_DIST blocks from home on the line to the world spawn —
//   the prod 10-09 drift path (home 23,65,7, world spawn ~225 off; the
//   rig pad is ~600 from it, a walk that eats the day). The seed adds the
//   decor (panes + banners) so castlefetch stays idle. That death is not
//   counted against the verdict; tracking pauses until the bot is back
//   within the leash (idle-rehome) and a never-back run FAILs).
//   CASTLE_SAND (1 = g0z.38: a 6x3x6 sand patch on a dirt base just east
//   of the pad, top flush with it — the pad has no sand of its own; with
//   CASTLE_SEED=complete the verdict adds panes=<laid>/44 and
//   upper-fence=<laid>/109 (g0z.45)) and attic=<laid>/6 (g0z.49, the
//   seeded kit carries the 5 shelves + table) and blast=<laid>/1 plus
//   furnace-spot=<3 C_FURNACE cells> (g0z.50, the kit carries the blast).
// Exit: 0 = measured (even at 0 laid — the line says so),
//   1 = CASTLE_IDLE verdict FAIL,
//   2 = environment/setup failure (spawn, pad, order, dropped follower,
//   jev without a key).

const mineflayer = require('mineflayer')
const Vec3 = require('vec3')
const fs = require('node:fs')
const path = require('node:path')
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')

const execFileAsync = promisify(execFile)

const HOST = process.env.CASTLE_HOST || 'localhost'
const PORT = parseInt(process.env.CASTLE_PORT || '25581', 10)
const CONTAINER = process.env.CASTLE_CONTAINER || 'idk-castle'
const TAG = process.env.CASTLE_TAG || `c${Math.floor(Math.random() * 1000)}`
const GUIDE = `CastleGuide${TAG}`
const FOLLOWER = `CastleBuild${TAG}`
const MINS = Math.max(1, parseInt(process.env.CASTLE_MINS || '30', 10) || 30)
const DIAG = process.env.CASTLE_DIAG === '1' // 6x7.26: set by castle-rig.sh for a component under 10 min
const PAD = String(process.env.CASTLE_PAD || '300,300').split(',').map(Number)
const OUT = process.env.CASTLE_OUT || `${__dirname}/last-castle.json`
const LOGFILE = process.env.CASTLE_LOG || `/tmp/castle-rig-${TAG}.log`
const KIT = process.env.CASTLE_KIT || 'empty'
const TICKRATE = process.env.CASTLE_TICKRATE || '1'
// neuc.60: /tick rate N (N > 1; 20 = normal) makes MINS GAME minutes — the
// window runs MINS * 20 / N wall minutes. Rate 1 = the server untouched.
const SPEED = (parseInt(TICKRATE, 10) || 1) > 1 ? parseInt(TICKRATE, 10) / 20 : 1
// neuc.60: component rig (castle-rig.sh CASTLE_COMPONENT=mine|lay) — one
// extra verdict line per GAME minute, judged against component-baseline.json.
const COMPONENT = process.env.CASTLE_COMPONENT || ''
const BLOCKED = Math.max(0, parseInt(process.env.CASTLE_BLOCKED || '0', 10) || 0)
const PLANNER = process.env.RIG_PLANNER || 'jev'
// Prod night (idkcraft-neuc.65.2, CASTLE_NIGHT=prod / --night prod): the same
// night machinery under prod conditions from window open — easy all window
// (no phantoms, no peaceful dawn), fall damage on, world spawn moved
// PROD_SPAWN_DIST from the pad; the tag adds day-deaths= and kitless=.
const NIGHT_PROD = process.env.CASTLE_NIGHT === 'prod'
const NIGHT = process.env.CASTLE_NIGHT === '1' || NIGHT_PROD
const SEED = process.env.CASTLE_SEED || ''
// Seeded blueprint version (g0z.48): '' reads the current blueprint; an
// older seed turns the run into an upgrade run (the guide chats
// `castle upgrade` after adoption). Pure over the raw env (unit-tested).
function parseSeedVersion(raw) {
  const blueprint = require('../src/castle')
  const s = String(raw == null ? '' : raw).trim()
  if (!s) return blueprint.BLUEPRINT_VERSION
  const v = Number(s)
  if (!Number.isInteger(v) || blueprint.blueprintOf(v).version !== v) {
    throw new Error(`CASTLE_SEED_VERSION: want ''|${Object.keys(blueprint.BLUEPRINTS).sort().join('|')}, got ${JSON.stringify(raw)}`)
  }
  return v
}
const SEED_VERSION = parseSeedVersion(process.env.CASTLE_SEED_VERSION || '')
const SEED_UPGRADE = SEED === 'complete' && SEED_VERSION < require('../src/castle').BLUEPRINT_VERSION
// Seed-except (g0z.51): with CASTLE_SEED=complete, seed every decor cell
// placed EXCEPT the comma-separated kinds — one ladder measured without
// the gauntlet (the IDLE_DEATH shape below, which seeds all decor for the
// same reason: its sand/wool legs walked 85+ out and drowned the drift it
// measures). Unset = today's behaviour (no decor seeded).
const SEED_DECOR_EXCEPT = (process.env.CASTLE_SEED_DECOR_EXCEPT || '').split(',').map((s) => s.trim()).filter(Boolean)
// Night home (g0z.59, needs CASTLE_SEED=complete): house = the castle is
// adopted, then an unbuilt (parked) house site on the pad corner becomes
// the home — prod's 'build here' by the castle; peer = the castle is never
// the bot's own: it lands in a peer memory file (BOT_CASTLE_PEER, v2's
// read-only path) and the same unbuilt house is the home. Either way the
// residence nights judge the castle as the night home. apron (g0z.63) =
// peer without BOT_CASTLE_PEER: a swarm helper's view, the castle is only a
// known castle (no night home), the unbuilt house sits in its apron, and the
// verdict adds apron-litter=<own non-plan blocks left in the apron>.
const NIGHT_HOME = process.env.CASTLE_NIGHT_HOME || ''
if (!['', 'house', 'peer', 'apron'].includes(NIGHT_HOME) || (NIGHT_HOME && SEED !== 'complete')) {
  throw new Error(`CASTLE_NIGHT_HOME: want ''|house|peer|apron with CASTLE_SEED=complete, got ${JSON.stringify(NIGHT_HOME)}`)
}
const PEER_FILE = NIGHT_HOME === 'peer' || NIGHT_HOME === 'apron'
// Bare night (idkcraft-neuc.65.3): no castle order and no seed — the guide
// only chats `autonomous on`, so the bot lives from fresh memory with no
// active castle (home none, then an unbuilt site): prod family A's nights.
const BARE = process.env.CASTLE_BARE === '1'
if (BARE && SEED) throw new Error('CASTLE_BARE=1 excludes CASTLE_SEED')
// Rig house (idkcraft-neuc.65.2, needs CASTLE_BARE=1): clean = a built v2
// house (raise-house.js) on the pad is the bot's home; bump = the same house
// with bedrock behind the door (gohome cannot get in: prod v2 10-16's
// cannot-reach-home dusks) — the night lines add the shelter spot's
// distance from the door (neuc.65.3's walk-off: 8+ is the pass). pit
// (neuc.65.6) = the doorstep is a 6-deep crater (prod v2 10-16: ten falls
// at one cell in front of a creeper-holed house door). gallery
// (neuc.65.6.1) = prod's real terrain: the house on a 1-block crust over a
// wide void, the doorstep crust cell and one interior floor cell gone, a
// west ramp so a body that drops in walks back up and loops.
const HOUSE = process.env.CASTLE_HOUSE || ''
if (!['', 'clean', 'bump', 'pit', 'gallery'].includes(HOUSE) || (HOUSE && !BARE)) {
  throw new Error(`CASTLE_HOUSE: want ''|clean|bump|pit|gallery with CASTLE_BARE=1, got ${JSON.stringify(HOUSE)}`)
}
const SAND = process.env.CASTLE_SAND === '1'
// Repair run (g0z.56, needs CASTLE_SEED=complete): after adoption the
// acceptance's 22 cells are knocked out (repairCells), wood = 16 oak_log in
// the castle chest, nowood = an empty chest and every log within
// NOWOOD_RADIUS cleared, planks = the nowood clearing plus 48 oak_planks
// in the castle chest (szr1: banked-planks refill with no logs anywhere);
// the guide chats `castle repair`.
const REPAIR = process.env.CASTLE_REPAIR || ''
if (!['', 'wood', 'nowood', 'planks', 'prkh'].includes(REPAIR) || (REPAIR && SEED !== 'complete')) {
  throw new Error(`CASTLE_REPAIR: want ''|wood|nowood|planks|prkh with CASTLE_SEED=complete, got ${JSON.stringify(REPAIR)}`)
}
// idkcraft-prkh: the fence-and-torch knock — 12 fence + 3 torch cells, the
// chest stocked with planks and every log within NOWOOD_RADIUS cleared
// (the planks shape). Stone is knocked mid-run by CASTLE_REKNOCK instead,
// while the quarry is dead (CASTLE_QUARRY=dead): the fence relays from the
// chest while stone stays honestly parked.
function prkhCells(st) {
  const cells = require('../src/castle').absPlan(st.site, st.rot, st.blueprintVersion).cells
  return [
    ...cells.filter((c) => c.kind === 'fence').slice(0, 12),
    ...cells.filter((c) => c.kind === 'torch').slice(0, 3),
  ]
}
// First series second a STAMPED stone fetch failure parks the word
// (idkcraft-prkh verdict tag): kind-only, so a torch hold under a stone
// word never misattributes. The master leg (no stamps) reads '-' while
// its kindless stone failures still show in top-fail. Pure (unit-tested).
function stoneheldAt(series) {
  for (const s of series || []) {
    const cf = s && s.castleFail
    if (cf && typeof cf.status === 'string' && cf.status.startsWith('failed:castlefetch-') &&
      cf.kind === 'stone') return s.t
  }
  return null
}
// Dead quarry (idkcraft-prkh, needs CASTLE_SEED=complete): water-fill the
// probe column of every trench side and pit spot below the surface, so the
// quarry/pit probes die wet-at-probe (aquifer shape, prod castle-8: sides
// 0/1 unusable) and no stone is ever exposed.
//
// idkcraft-awt9: the fill top sits one BELOW the floor (site.y - 1), never
// above it. A top at site.y + 1 flooded the pad surface and the gate
// approach (43 columns plus flow): Baritone's chest walk stalled in the
// water and went noPath while v1 swam through, so the v2 fence leg failed
// no-trees without ever drawing the stocked chest. The probes still die
// wet — the top-down scan reads air/dirt first, then the buried water.
// Pure (unit-tested).
function quarryDeadFills(st) {
  const cf = require('../src/behaviours/castlefetch')
  const origins = []
  for (let ring = 0; ring < 2; ring++) for (let s = 0; s < 4; s++) origins.push(cf.quarrySide(st, s, ring))
  for (const o of cf.pitSpots(st)) origins.push(o)
  return origins.map((o) => `fill ${o.x} ${st.site.y - 1} ${o.z} ${o.x} ${st.site.y - 9} ${o.z} minecraft:water`)
}
const QUARRY = process.env.CASTLE_QUARRY || ''
if (!['', 'dead'].includes(QUARRY) || (QUARRY && SEED !== 'complete')) {
  throw new Error(`CASTLE_QUARRY: want ''|dead with CASTLE_SEED=complete, got ${JSON.stringify(QUARRY)}`)
}
// Stone re-knock (idkcraft-prkh): mid-run rcon knock-out of these plan
// kinds (stone), once the torch fetch has failed into its hold — the word
// jumps back to stone while the torch hold still stands.
const REKNOCK = (process.env.CASTLE_REKNOCK || '').split(',').map((s) => s.trim()).filter(Boolean)
if (REKNOCK.length && SEED !== 'complete') throw new Error(`CASTLE_REKNOCK needs CASTLE_SEED=complete, got ${JSON.stringify(process.env.CASTLE_REKNOCK)}`)
const NOWOOD_RADIUS = 72
// The 22 knocked-out cells (g0z.56 acceptance, vf8e.8 adds 2 stairs):
// a fence row (12), the door, 4 ground-floor wall cells, 3 torches, 2
// stairs (v3 only — earlier blueprints have no stairs cells, still 20).
// Pure (unit-tested).
function repairCells(st) {
  const cells = require('../src/castle').absPlan(st.site, st.rot, st.blueprintVersion).cells
  return [
    ...cells.filter((c) => c.kind === 'fence').slice(0, 12),
    ...cells.filter((c) => c.kind === 'door'),
    ...cells.filter((c) => c.kind === 'stone' && c.y === st.site.y + 1).slice(0, 4),
    ...cells.filter((c) => c.kind === 'torch').slice(0, 3),
    ...cells.filter((c) => c.kind === 'stairs').slice(0, 2),
  ]
}
// Litter sweep (g0z.61, CASTLE_LITTER=1, needs CASTLE_SEED=complete): after
// adoption 30 litter items are rcon-placed — 10 lone dirt pillars in the
// open yard (one 4-high to a dy-3 window), 10 cobble bridge cells at dy -1
// in the dry moat's north strip, 10 two-high dirt pillars 2..14 west of
// the ring — plus 5 player structures east of the ring (a 3x2 cobble wall,
// a 5-long cobble path on the ground, a chest, a bed, a 2-high planks
// post). An item is swept once every cell reads air. Pure, rot 0 (the seed's
// rot); throws when the blueprint has no spot (unit-tested).
const LITTER = process.env.CASTLE_LITTER === '1'
const LITTER_PASS = 27 // of 30 items
// idkcraft-akze: the tidy scenario (CASTLE_REPAIR, g0z.62 cadence) starts
// the sweep only once the relay completes — 10+ min in — so the g0z.61
// 900 s bar never fits it. There the sweep is judged at window end, like
// repair; the standalone litter rig keeps its 15-min bar.
const LITTER_BY_S = process.env.CASTLE_REPAIR ? null : 15 * 60 // null = window end (tidy); 15 game-min (tick rate 1)
if (LITTER && SEED !== 'complete') throw new Error('CASTLE_LITTER=1 needs CASTLE_SEED=complete')
function litterSeeds(st) {
  const bp = require('../src/castle')
  if ((st.rot | 0) !== 0) throw new Error('litterSeeds: rot 0 only (the seeded castle)')
  const { w, d } = bp.siteDimensions(0, st.blueprintVersion)
  const at = bp.absPlan(st.site, 0, st.blueprintVersion).at
  const decor = bp.decorPlan(st.site, 0, st.blueprintVersion)
  const k = (x, y, z) => `${x},${y},${z}`
  const extras = new Set(seedCastleCells(st).filter((c) => c.kind === 'extra').map((c) => k(c.x, c.y, c.z)))
  const free = (x, y, z) => !at.has(k(x, y, z)) && !decor.at.has(k(x, y, z)) && !extras.has(k(x, y, z))
  const { x: sx, y: sy, z: sz } = st.site
  const sky = (x, z) => {
    if (at.has(k(x, sy - 1, z))) return false // a moat dig or a foundation: no yard floor
    for (let y = sy; y <= sy + 16; y++) if (!free(x, y, z)) return false
    return true
  }
  const cols = []
  const apart = (x, z) => cols.every((c) => Math.abs(c.x - x) > 1 || Math.abs(c.z - z) > 1)
  const litter = []
  const add = (what, x, z, y0, h, block) => {
    cols.push({ x, z })
    const cells = []
    for (let y = y0; y < y0 + h; y++) cells.push({ x, y, z, block })
    litter.push({ what, cells })
  }
  // The window tower: the open-sky side of a dy-3 pane, dy 0..3.
  for (const p of decor.cells) {
    if (p.kind !== 'pane' || p.dy !== 3 || cols.length) continue
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      if (!sky(p.x + dx, p.z + dz)) continue
      add('tower', p.x + dx, p.z + dz, sy, 4, 'dirt')
      break
    }
  }
  if (!cols.length) throw new Error('litterSeeds: no open-sky column beside a dy-3 window')
  for (let dx = 2; dx < w - 2 && litter.length < 10; dx += 3) {
    for (let dz = 2; dz < d - 2 && litter.length < 10; dz += 3) {
      const x = sx + dx, z = sz + dz
      if (sky(x, z) && apart(x, z)) add('yard', x, z, sy, 1 + (litter.length % 3), 'dirt')
    }
  }
  if (litter.length < 10) throw new Error(`litterSeeds: only ${litter.length} yard pillars`)
  // Moat bridges: both north-strip cells (dz 3 and 4) at dy -1, in the dug
  // moat's plan 'dig' cells — where a walker crossing at floor level places
  // (revmux 01), bank to bank.
  let bridges = 0
  for (let dx = 3; dx <= w - 4 && bridges < 5; dx++) {
    const x = sx + dx
    const dug = (z) => { const c = at.get(k(x, sy - 1, z)); const u = at.get(k(x, sy - 2, z)); return c && c.kind === 'dig' && u && u.kind === 'dig' }
    if (!dug(sz + 3) || !dug(sz + 4) || !apart(x, sz + 3) || !apart(x, sz + 4)) continue
    add('bridge', x, sz + 3, sy - 1, 1, 'cobblestone')
    add('bridge', x, sz + 4, sy - 1, 1, 'cobblestone')
    bridges++
    dx += 2
  }
  if (bridges < 5) throw new Error(`litterSeeds: only ${bridges} moat bridges`)
  ;[2, 3, 4, 6, 7, 8, 10, 11, 12, 14].forEach((out, i) => add('outside', sx - out, sz + 1 + 2 * i, sy, 2, 'dirt'))
  const xe = sx + w + 3
  const player = [
    { what: 'wall', cells: [2, 3, 4].flatMap((dz) => [0, 1].map((dy) => ({ x: xe, y: sy + dy, z: sz + dz, block: 'cobblestone' }))) },
    { what: 'path', cells: [8, 9, 10, 11, 12].map((dz) => ({ x: xe, y: sy, z: sz + dz, block: 'cobblestone' })) },
    { what: 'chest', cells: [{ x: xe, y: sy, z: sz + 15, block: 'chest' }] },
    { what: 'bed', cells: [{ x: xe, y: sy, z: sz + 18, block: 'red_bed[part=foot,facing=east]' }, { x: xe + 1, y: sy, z: sz + 18, block: 'red_bed[part=head,facing=east]' }] },
    { what: 'post', cells: [0, 1].map((dy) => ({ x: xe, y: sy + dy, z: sz + 21, block: 'oak_planks' })) },
  ]
  // The west pillars stand past the pad edge (pad = site +-9): a dirt
  // ground strip and air above it, so they are lone on flat ground.
  const prep = [
    `fill ${sx - 16} ${sy - 4} ${sz - 1} ${sx - 1} ${sy - 1} ${sz + d} minecraft:dirt`,
    `fill ${sx - 16} ${sy} ${sz - 1} ${sx - 1} ${sy + 8} ${sz + d} minecraft:air`,
  ]
  return { litter, player, prep }
}
// Start spot (g0z.58, needs CASTLE_SEED=complete): CASTLE_START="dx,dy,dz"
// off the seeded site's SW corner — after adoption the follower lands in a
// 1x2 air pocket there (prod g0z.55: castle site 8 65 -12, tunnel start
// 58 60 19 = "50,-5,31"). CASTLE_START_CELL=cobble|planks walls the pocket
// in a 3x4x3 shell of that block: v2 pathing hard-bans both (g0z.55
// blocksToDisallowBreaking), so only an explicit dig gets it out. The
// shell is SELF-enclosed: its cells land in the bot's placedByBot (a
// foreign cobble/planks box is a player build — default-deny protected,
// never dug) and the bot gets a stone pickaxe (its night-shelter kit).
// Pure (unit-tested); null when CASTLE_START is unset.
const START_BLOCK = { cobble: 'cobblestone', planks: 'oak_planks' }
function startPlan(site, raw, cell) {
  const s = String(raw || '').trim()
  const c = String(cell || '').trim()
  if (c && !START_BLOCK[c]) throw new Error(`CASTLE_START_CELL: want ''|cobble|planks, got ${JSON.stringify(cell)}`)
  if (!s) {
    if (c) throw new Error('CASTLE_START_CELL needs CASTLE_START')
    return null
  }
  const d = s.split(',').map((v) => Number(v.trim()))
  if (d.length !== 3 || !d.every(Number.isInteger)) throw new Error(`CASTLE_START: want "dx,dy,dz" (site-relative integers), got ${JSON.stringify(raw)}`)
  const x = site.x + d[0]; const y = site.y + d[1]; const z = site.z + d[2]
  const cmd = c
    ? `fill ${x - 1} ${y - 1} ${z - 1} ${x + 1} ${y + 2} ${z + 1} minecraft:${START_BLOCK[c]} hollow`
    : `fill ${x} ${y} ${z} ${x} ${y + 1} ${z} minecraft:air`
  // Out of the pocket = out of its shell box (the cell, or the 3x4x3 around a bare pocket).
  const out = (p) => Math.abs(Math.floor(p.x) - x) > 1 || Math.abs(Math.floor(p.z) - z) > 1 ||
    Math.floor(p.y) < y - 1 || Math.floor(p.y) > y + 2
  const shell = []
  if (c) {
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 2; dy++) {
        for (let dz = -1; dz <= 1; dz++) {
          if (dx === 0 && dz === 0 && (dy === 0 || dy === 1)) continue
          shell.push({ x: x + dx, y: y + dy, z: z + dz, name: START_BLOCK[c] })
        }
      }
    }
  }
  return { x, y, z, d, cell: c, cmd, out, shell }
}
const START = process.env.CASTLE_START || ''
const START_CELL = process.env.CASTLE_START_CELL || ''
startPlan({ x: 0, y: 0, z: 0 }, START, START_CELL) // validate up front
if (START && SEED !== 'complete') throw new Error('CASTLE_START needs CASTLE_SEED=complete')
// Tidy house (g0z.62, CASTLE_START_HOUSE=1, needs CASTLE_START): a built rig
// house at the start spot is the home, so the castle is not — only the tidy
// cadence (CASTLE_TIDY_MS) walks the bot back to repair and sweep.
const START_HOUSE = process.env.CASTLE_START_HOUSE === '1'
if (START_HOUSE && !START) throw new Error('CASTLE_START_HOUSE=1 needs CASTLE_START')
// Apron diff (g0z.64, needs CASTLE_SEED=complete): v2 places through
// Baritone in the client, so its throwaway towers/bridges never reach
// placedByBot (the bridge emits no blockUpdate) and apron-litter cannot see
// them. After the start spot the whole apron box (castle.apronOf's box:
// r=16, y site-4..site+16) is cloned into the deepslate under the site
// (y -58 up, slabs under the 32768 clone limit); at the window end
// `execute if blocks ... all` bisects to the changed cells. New = a cell
// that was air at the snapshot, is not now, and is no plan/decor cell.
// ponytail: the copy lives under the site — a mine leg that digs to y -38
// there corrupts it (night/residence rigs never do).
const APRON_DIFF = process.env.CASTLE_APRON_DIFF === '1'
if (APRON_DIFF && SEED !== 'complete') throw new Error('CASTLE_APRON_DIFF=1 needs CASTLE_SEED=complete')
const APRON_COPY_Y = -58
function apronBox(st) {
  const bp = require('../src/castle')
  const { w, d } = bp.siteDimensions(st.rot | 0, st.blueprintVersion)
  const r = bp.CASTLE_APRON
  return { x1: st.site.x - r, x2: st.site.x + w + r - 1, y1: st.site.y - 4, y2: st.site.y + 16, z1: st.site.z - r, z2: st.site.z + d + r - 1 }
}
// Pure: the snapshot's clone commands, slabs of at most 32768 cells.
function apronCloneCmds(box) {
  const per = Math.max(1, Math.floor(32768 / ((box.x2 - box.x1 + 1) * (box.z2 - box.z1 + 1))))
  const out = []
  for (let y = box.y1; y <= box.y2; y += per) {
    const y2 = Math.min(box.y2, y + per - 1)
    out.push(`clone ${box.x1} ${y} ${box.z1} ${box.x2} ${y2} ${box.z2} ${box.x1} ${APRON_COPY_Y + y - box.y1} ${box.z1} replace force`)
  }
  return out
}
// The changed cells of box vs its copy, bisecting `execute if blocks ...
// all` (rcon(cmd) -> its output text). Unit-tested with a fake rcon.
async function apronChanged(rcon, box, cap = 4000) {
  const dy = APRON_COPY_Y - box.y1
  const out = []
  async function walk(b) {
    if (out.length >= cap) return
    const sx = b.x2 - b.x1, sy = b.y2 - b.y1, sz = b.z2 - b.z1
    if ((sx + 1) * (sy + 1) * (sz + 1) <= 32768) { // vanilla's `if blocks` cap: bigger boxes split unasked
      const res = String(await rcon(`execute if blocks ${b.x1} ${b.y1} ${b.z1} ${b.x2} ${b.y2} ${b.z2} ${b.x1} ${b.y1 + dy} ${b.z1} all`))
      if (/Test passed/.test(res)) return
      if (!/Test failed/.test(res)) throw new Error(`apron diff: unreadable ${res.slice(0, 120)}`)
    }
    if (sx === 0 && sy === 0 && sz === 0) { out.push({ x: b.x1, y: b.y1, z: b.z1, copyY: b.y1 + dy }); return }
    const ax = sx >= sy && sx >= sz ? 'x' : sy >= sz ? 'y' : 'z'
    const m = Math.floor((b[`${ax}1`] + b[`${ax}2`]) / 2)
    await walk({ ...b, [`${ax}2`]: m })
    await walk({ ...b, [`${ax}1`]: m + 1 })
  }
  await walk(box)
  return out
}
const IDLE = process.env.CASTLE_IDLE === '1'
const IDLE_DEATH = IDLE ? Math.max(0, parseInt(process.env.CASTLE_IDLE_DEATH || '0', 10) || 0) : 0
// Far respawn (vmzq.29, prod run6): after CASTLE_FAR_AFTER min of the
// window the follower lands CASTLE_FAR blocks off the half-built site in a
// 3x3 pit 7 deep, dirt cleared, 64 cobble given — the walk back must pillar
// with cobble and progress must never read 0 meanwhile. 0 = off.
const FAR = Math.max(0, parseInt(process.env.CASTLE_FAR || '0', 10) || 0)
const FAR_AFTER = Math.max(1, parseInt(process.env.CASTLE_FAR_AFTER || '4', 10) || 4)
// Buried pickless (vmzq.37, prod y~37): after CASTLE_BURY_AFTER min the
// follower lands in a sealed 3x2x3 air pocket CASTLE_BURY blocks below the
// pad top, 12 off the site, every pickaxe cleared — it must craft a pick
// (or hand-dig) out and lay again. The verdict gets surfaced/resumed
// seconds. 0 = off.
const BURY = Math.max(0, parseInt(process.env.CASTLE_BURY || '0', 10) || 0)
const BURY_AFTER = Math.max(1, parseInt(process.env.CASTLE_BURY_AFTER || '4', 10) || 4)
// CASTLE_BURY_NOWOOD=1 also clears planks/logs/sticks/tables: no pick can
// be crafted, so only the bare-hand staircase (recover dig_step) gets out.
const BURY_NOWOOD = process.env.CASTLE_BURY_NOWOOD === '1'
// Pit-trapped with tools (vmzq.47, prod run7 stall962): after
// CASTLE_PIT_AFTER min a pit-guide leads the follower east past the site
// box and a CASTLE_PIT-deep open stone pit is built around it; it falls
// in with a stone pickaxe + 19 dirt (the prod kit), and every placement
// near/below the rim is refused with the prod text — recover must
// dig-staircase out instead of looping pillar_up. The verdict gets
// pit=escaped@Ns,resumed@Ms. 0 = off.
// CASTLE_PIT_REFUSE=0 keeps placements working (control: pillar escape).
// CASTLE_PIT_GOAL=level (idkcraft-i4wm) forces every stuck episode raised
// from inside the pit to carry a LEVEL coords goal (30 east at pit-floor
// height, the c698 shape: dist~30, through the open side). Organic pit
// episodes are usually high (surface fetch above) or goal-less, which climb
// out on master too — the forced goal is the only deterministic level-goal
// repro. Episodes outside the pit stay organic. Replay-only, default off.
// CASTLE_PIT_SHAPE=corner (idkcraft-i4wm): the hollow is a 3x3 with the
// settle pos in its northwest corner (walls=2, runway 2+ east and south)
// instead of the west-column landing. A wall-pressed west-column stance
// fails its shuffles (Paper rejects touch-moves), which bans via fails on
// master too.
// CASTLE_PIT_SHAPE=hall (idkcraft-i4wm): the hollow is a 5x5 centre
// landing (walls=0, runway 2+ every way) — the prod-like roomy pit where
// free-stance shuffles displace and the c698 done-loop (no fail accrual,
// no dig switch) reproduces instead of fail-banning. Same verdict; the
// staircase digs the hall sides. Replay-only, default off.
const PIT = Math.max(0, parseInt(process.env.CASTLE_PIT || '0', 10) || 0)
const PIT_AFTER = Math.max(1, parseInt(process.env.CASTLE_PIT_AFTER || '2', 10) || 2)
const PIT_REFUSE = process.env.CASTLE_PIT_REFUSE !== '0'
const PIT_GOAL = process.env.CASTLE_PIT_GOAL || ''
const PIT_SHAPE = process.env.CASTLE_PIT_SHAPE || ''

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)) }

// Carried-food census (idkcraft-vmzq.34): mirror of reflexes.js EDIBLE_FOODS
// (the source of truth — update both). The 15 s sample reads hunger + carried
// edibles so long runs evidence the food economy, not just the build.
const SAMPLE_EDIBLES = new Set([
  'bread', 'cooked_beef', 'cooked_porkchop', 'cooked_chicken', 'cooked_mutton',
  'cooked_rabbit', 'apple', 'carrot', 'baked_potato',
  'beef', 'porkchop', 'mutton', 'rabbit',
])

// Full log to a file; stdout keeps the cycle-readable lines (goal steps,
// fetch needs, blocked cells, progress, deaths, verdict). Ticker chatter
// (decision/scout/kit/eat) would bury the verdict on a 30+ min run.
const logStream = fs.createWriteStream(LOGFILE, { flags: 'w' })
const PRINT = [/^goal step=/, /^castlefetch \S+: need /, /^castle blocked /, /^castle relocate /,
  /^castle \d+\/\d+$/, /death/, /^castle-sample /, /^castle \d+\/\d+ in /,
  /^CASTLE-RIG /, /^task castle /, /no progress for/,
  /^goal watchdog /, /^goal outcome /, /^residence /]
const origLog = console.log
const origErr = console.error
const seen = { flips: 0, steps: {}, fails: {}, progress: [], said: [], wdCalls: 0, wdChoices: {}, wdFirstAt: 0, outcomes: { progress: 0, flat: 0, preempted: 0 }, timeEvents: [], timeMaxDrift: 0, step: null, nightSteps: null, shelterEps: 0, regressAt: [], fetchEv: [], leg: null, lastWd: null, kitless: 0, falls: 0, drops: 0, doorLost: 0, gohomeFails: 0, shelterAt: null }
function resetSeen() {
  seen.kitless = 0
  seen.falls = 0
  seen.drops = 0
  seen.doorLost = 0
  seen.gohomeFails = 0
  seen.shelterAt = null
  seen.regressAt = []
  seen.fetchEv = []
  seen.leg = null
  seen.lastWd = null
  seen.shelterEps = 0
  seen.flips = 0
  seen.steps = {}
  seen.fails = {}
  seen.progress = []
  seen.said = []
  seen.wdCalls = 0
  seen.wdChoices = {}
  seen.wdFirstAt = 0
  seen.outcomes = { progress: 0, flat: 0, preempted: 0 }
  seen.timeEvents = []
  seen.timeMaxDrift = 0
  seen.step = null
  seen.nightSteps = null
}
function hookConsole() {
  console.log = (...a) => {
    const line = a.map(String).join(' ')
    try { logStream.write(line + '\n') } catch (_) { /* log best-effort */ }
    classify(line)
    if (PRINT.some((re) => re.test(line))) origLog(line)
  }
  console.error = (...a) => {
    const line = a.map(String).join(' ')
    try { logStream.write('ERR ' + line + '\n') } catch (_) { /* log best-effort */ }
    classify(line)
    origErr(line)
  }
}
// Goal-step flips castle<->castlefetch, per-step decision counts, failure
// reasons, watchdog fires + choices, commitment outcomes. Parsed from the
// bot's own log lines (in-process, loss-free). now is injectable for tests.
function classify(line, now = Date.now()) {
  if (line.startsWith('castle regress ')) { seen.regressAt.push(now); return } // g0z.56
  // neuc.65.2: kitless = a death line (neuc.65.1 facts) with no sword held.
  if (line.startsWith('death health=')) { if (/ sword=0( |$)/.test(line)) seen.kitless++; return }
  // neuc.65.2: where the shelter settled (the house-bump door distance).
  const sp = /^shelter phase=(\S+) pos=(-?\d+) (-?\d+) (-?\d+)/.exec(line)
  if (sp) {
    if (sp[1] !== 'walk' && sp[1] !== 'swim') seen.shelterAt = { x: +sp[2], y: +sp[3], z: +sp[4] }
    return
  }
  let m = /^goal step=(\S+) prev=(\S+)/.exec(line)
  if (m) {
    if (seen.leg && m[2] === 'castlefetch' && m[1] !== 'castlefetch') { // neuc.62: leg cut by a goal switch
      const why = /why=(\S+)/.exec(line)
      const force = /force=(\S+)/.exec(line)
      const by = force ? `force=${force[1]}` : seen.lastWd ? `watchdog:${seen.lastWd}` : (why ? why[1] : '?')
      // step-done: the leg ended itself without a `leg over` line (finish) — not a cut
      seen.fetchEv.push(why && why[1] === 'step-done' && !force ? { at: now, ev: 'finish' } : { at: now, ev: 'cut', by })
      seen.leg = null
    }
    seen.lastWd = null
    if (line.includes(' fail=failed:cannot-reach-home')) seen.gohomeFails++
    seen.step = m[1]
    if (seen.nightSteps) seen.nightSteps.add(m[1])
    if (m[1] === 'shelter' && m[2] !== 'shelter') seen.shelterEps++
    const pair = [m[1], m[2]].sort().join('<>')
    if (pair === 'castle<>castlefetch') seen.flips++
    return
  }
  m = /^decision source=\S+ action=(\S+)/.exec(line)
  if (m) {
    seen.steps[m[1]] = (seen.steps[m[1]] || 0) + 1
    return
  }
  m = /failed:([A-Za-z0-9_-]+)/.exec(line)
  if (m) {
    const r = m[1]
    // Count step-failure reasons, not the ticker's fail-count echoes: the
    // goal line's why=step-failed and the behaviour's own failed: line each
    // fire once per finish (dedup by reason per second is overkill for a
    // top-list; the ordering is what matters).
    seen.fails[r] = (seen.fails[r] || 0) + 1
  }
  // neuc.62: castlefetch leg start / finish (the cut is the goal-step branch above).
  m = /^castlefetch stone: need (\d+) more/.exec(line)
  if (m) {
    if (seen.leg) seen.fetchEv.push({ at: now, ev: 'cut', by: 'kind-switch' })
    seen.fetchEv.push({ at: now, ev: 'start' })
    seen.leg = true
    return
  }
  if (/^castlefetch stone: leg over \(/.test(line)) {
    seen.fetchEv.push({ at: now, ev: 'finish' })
    seen.leg = null
    return
  }
  // Watchdog resolutions (vmzq.21): every `goal watchdog` line is one
  // consumed round; choice=none is a failure path (error/stale/low-conf),
  // not an intervention — counted in calls, not in choices/first.
  m = /^goal watchdog .* choice=(\S+)/.exec(line)
  if (m) {
    seen.wdCalls++
    // A far choice taken inside a live castlefetch leg prints no goal step
    // line (same step): the near leg is cut and a far leg starts, right here.
    if (seen.leg && /far/.test(m[1])) {
      seen.fetchEv.push({ at: now, ev: 'cut', by: `watchdog:${m[1]}` }, { at: now, ev: 'start' })
      seen.lastWd = null
    } else seen.lastWd = m[1] !== 'none' ? m[1] : null
    if (m[1] !== 'none') {
      seen.wdChoices[m[1]] = (seen.wdChoices[m[1]] || 0) + 1
      if (!seen.wdFirstAt) seen.wdFirstAt = now
    }
  }
  // Commitment outcomes: progress moved the metric, flat covers flat +
  // failed:* (no goal effect either way), preempted:* never ran its course.
  m = /^goal outcome .* result=(\S+)/.exec(line)
  if (m) {
    const r = m[1]
    if (r === 'progress') seen.outcomes.progress++
    else if (r.startsWith('preempted:')) seen.outcomes.preempted++
    else seen.outcomes.flat++
  }
}

// Server-clock resync (idkcraft-vmzq.45): on MC 26.1 + /tick rate > 1 the
// server sends full clock state only on join/time-set/gamerule flips and
// thereafter one EMPTY update_time per 20 game ticks (measured on Paper
// 26.1.2: 1/s wall at rate 20, 5/s at rate 100, tick-aligned). Mineflayer
// keeps interpolating the stale rate=1 clock at 20/s wall — it never learns
// the new rate — so bot.time lags ~5x at rate 100 and the bot shelters
// through server days. The rig re-anchors on every full packet and counts
// +20 game ticks per empty while the anchor rate is > 0 (daylock fulls
// carry rate=0 and empties keep arriving on the frozen clock — counting
// those would invent time). Pre-26.1 packets (no clockUpdates), unknown
// dimensions and dimension switches stay hands-off. TICKRATE=1 tracks only:
// the gate path never writes bot.time.
// Split tap: onPacket only mutates resync state (mineflayer injects its own
// update_time listener deferred on inject_allowed, so it runs AFTER any
// listener attached at createBot and would overwrite an onPacket write).
// apply() runs on the bot 'time' event, which mineflayer's handler emits
// synchronously at its end — the correction always lands last.
const RESYNC_TICKS_PER_EMPTY = 20
const RESYNC_JUMP_TICKS = 1000 // bigger anchor moves are time-sets: re-arm silently
const RESYNC_DRIFT_TICKS = 100 // srv/bt breach: the correction stopped landing
function resyncDimName(bot, id) {
  try { return bot.registry.dimensionsById[id] && bot.registry.dimensionsById[id].name } catch (_) { return null }
}
function resyncWrite(bot, total) { // exact mirror of mineflayer time.js
  const t = Math.floor(total)
  bot.time.bigTime = BigInt(t)
  bot.time.time = t
  bot.time.timeOfDay = t % 24000
  bot.time.day = Math.floor(t / 24000)
  bot.time.isDay = bot.time.timeOfDay >= 0 && bot.time.timeOfDay < 13000
  bot.time.moonPhase = bot.time.day % 8
}
function resyncWord(daytime) { // goal.js timeWord cutoffs
  return daytime < 12000 ? 'day' : daytime <= 13000 ? 'dusk' : 'night'
}
// Circular |srv - bt| in daytime ticks, null when either clock is unreadable
// (the midnight straddle reads 10 ticks, not 23990).
function timeDrift(srv, bt) {
  if (typeof srv !== 'number' || typeof bt !== 'number' || !Number.isFinite(srv) || !Number.isFinite(bt)) return null
  const d = Math.abs(srv - bt) % 24000
  return Math.min(d, 24000 - d)
}
// onEvent({ event, server, bot, at }) — event is dusk|nightfall|dawn,
// server/bot are daytimes, at is a wall epoch. now is injectable for tests
// (classify precedent).
function createTimeResync({ write = true, onEvent = null } = {}) {
  const st = { anchor: null, rate: 0, empties: 0, dim: null, word: null, pending: null }
  const total = () => st.anchor == null ? null : st.anchor + st.empties * RESYNC_TICKS_PER_EMPTY
  const daytime = () => {
    const t = total()
    return t == null ? null : Math.floor(t) % 24000
  }
  function crossed(bot, now) {
    const d = daytime()
    if (d == null) return
    const w = resyncWord(d)
    const prev = st.word
    st.word = w
    if (!onEvent || prev == null || prev === w) return
    const fwd = (prev === 'day' && w === 'dusk') || (prev === 'dusk' && w === 'night') || (prev === 'night' && w === 'day')
    if (!fwd) return // non-forward word changes re-arm silently
    const ev = { event: w === 'dusk' ? 'dusk' : w === 'night' ? 'nightfall' : 'dawn', server: d, at: now }
    // In write mode the event waits for the next physicsTick and reports
    // the live clock as the brain would read it — never the counted value
    // (revmux 02 minor: a read-back on the line after the write agrees by
    // construction, a live-tick read can fail).
    if (write) { st.pending = ev; return }
    onEvent({ ...ev, bot: bot && bot.time ? bot.time.timeOfDay : null })
  }
  return {
    state: st,
    daytime,
    onPacket(bot, packet, now = Date.now()) {
      const cu = packet && packet.clockUpdates
      if (!Array.isArray(cu)) return // pre-26.1 absolute-time shape
      if (cu.length > 0) {
        const cur = bot && bot.game && bot.game.dimension
        const hit = cu.find((c) => resyncDimName(bot, c.id) === cur)
        const tot = hit ? Number(hit.totalTicks) : NaN
        if (!hit || !Number.isFinite(tot)) { st.anchor = null; st.word = null; st.pending = null; return }
        const prev = total()
        st.anchor = tot; st.rate = Number(hit.rate) || 0; st.empties = 0; st.dim = cur
        st.pending = null // a new anchor invalidates any queued crossing
        if (prev != null && Math.abs(tot - prev) > RESYNC_JUMP_TICKS) {
          const was = st.word
          st.word = resyncWord(daytime()) // time-set jump (a night->day set is not a dawn)
          // g0z.33 revmux 01: a FORWARD jump out of dusk/night into day is
          // the server's sleep skip (the bot alone in bed) — a dawn, or the
          // night it slept through never closes. Backward sets stay silent.
          if (onEvent && tot > prev && (was === 'dusk' || was === 'night') && st.word === 'day') {
            const ev = { event: 'dawn', server: daytime(), at: now, skip: true }
            if (write) st.pending = ev
            else onEvent({ ...ev, bot: bot && bot.time ? bot.time.timeOfDay : null })
          }
          return
        }
        crossed(bot, now) // full packet: mineflayer already wrote server truth
        return
      }
      if (st.anchor == null || !(st.rate > 0)) return // frozen (daylock) or unanchored
      if (!bot || !bot.game || bot.game.dimension !== st.dim) return // switched dimension: hands off
      st.empties++
      crossed(bot, now)
    },
    // v2 body (neuc.65.2): the bridge has no packet client, so crossings
    // come from its bot.time (the mod's server clock) on each 'time' event;
    // without this a CASTLE_BODY=baritone --night never closed a night.
    onBotTime(bot, now = Date.now()) {
      const d = bot && bot.time && bot.time.timeOfDay
      if (typeof d !== 'number' || !Number.isFinite(d) || !onEvent) return
      const w = resyncWord(((d % 24000) + 24000) % 24000)
      const prev = st.word
      st.word = w
      if (prev == null || prev === w) return
      if (!((prev === 'day' && w === 'dusk') || (prev === 'dusk' && w === 'night') || (prev === 'night' && w === 'day'))) return
      onEvent({ event: w === 'dusk' ? 'dusk' : w === 'night' ? 'nightfall' : 'dawn', server: d, bot: d, at: now })
    },
    apply(bot) { // bot 'time' tap: lands after mineflayer's own write
      if (!write || st.anchor == null || !(st.rate > 0)) return
      if (!bot || !bot.game || bot.game.dimension !== st.dim) return
      resyncWrite(bot, st.anchor + st.empties * RESYNC_TICKS_PER_EMPTY)
    },
    onTick(bot) { // physicsTick tap: flushes queued crossings with the live clock
      if (!write || !st.pending || !onEvent) return
      onEvent({ ...st.pending, bot: bot && bot.time ? bot.time.timeOfDay : null })
      st.pending = null
    },
  }
}

// Night mode (idkcraft-ek69, absorbs the orchestrator's night-driver.sh):
// castle-rig.sh --night runs the natural cycle; open() at window start sets
// time 0, each nightfall goes easy + summons phantoms over the follower,
// each dawn goes peaceful and logs one night verdict (deaths during the
// night, sheltered = a shelter/rest goal step held at any point of it).
// Crossings before open() (setup) stay peaceful. cmd runs one rcon command,
// deaths() reads the follower's death count; never fails the run.
const NIGHT_SAFE_STEPS = new Set(['shelter', 'rest'])
// prod (neuc.65.2): no per-night difficulty flips or phantoms — openCmds
// (easy, fall damage, world spawn) run once at open and hold all window;
// the tag adds day-deaths (window deaths outside the nights) and kitless
// (seen.kitless since open). door ({x, z}, the house-bump door) adds one
// `CASTLE-RIG house-bump night <n>:` line per night and bump=<pass>/<n>.
const BUMP_DOOR_GAP = 8
function createNightDriver({ cmd, who, deaths, log, phantoms = 2, prod = false, openCmds = [], door = null }) {
  const nights = []
  let armed = false
  let cur = null
  let open0 = null
  let gLast = 0
  const run = (c) => Promise.resolve().then(() => cmd(c)).then(
    (o) => log(`CASTLE-RIG night-rcon [${c}]: ${String(o).trim().split('\n')[0]}`),
    (e) => log(`CASTLE-RIG night-rcon FAILED [${c}]: ${e && e.message ? e.message : e}`))
  const close = (partial) => {
    if (!cur) return null
    const steps = [...cur.steps]
    const n = { night: nights.length + 1, deaths: deaths() - cur.d0, sheltered: steps.some((s) => NIGHT_SAFE_STEPS.has(s)), steps, partial }
    if (door) {
      const at = seen.shelterAt
      n.gohomeFails = seen.gohomeFails - gLast
      n.shelterAt = at
      n.doorDist = at ? Math.round(Math.hypot(at.x + 0.5 - door.x, at.z + 0.5 - door.z)) : null
      n.bump = !partial && n.deaths === 0 && n.doorDist != null && n.doorDist >= BUMP_DOOR_GAP
    }
    nights.push(n)
    cur = null
    seen.nightSteps = null
    // Per day: dusk's gohome failure and shelter land before nightfall.
    gLast = seen.gohomeFails
    seen.shelterAt = null
    log(`CASTLE-RIG night ${n.night}: deaths=${n.deaths}, sheltered=${n.sheltered ? 'yes' : 'no'}, steps=${steps.join(',') || 'none'}${partial ? ' (partial)' : ''}`)
    if (door) {
      log(`CASTLE-RIG house-bump night ${n.night}: gohome-fails=${n.gohomeFails}, shelter-at=${n.shelterAt ? `${n.shelterAt.x} ${n.shelterAt.y} ${n.shelterAt.z}` : 'none'}, ` +
        `door-dist=${n.doorDist == null ? 'none' : n.doorDist}, deaths=${n.deaths}, ${n.bump ? 'PASS' : 'FAIL'}${partial ? ' (partial)' : ''}`)
    }
    return n
  }
  return {
    nights,
    async open() {
      armed = true
      open0 = { d: deaths(), k: seen.kitless, f: seen.falls }
      gLast = seen.gohomeFails
      seen.shelterAt = null
      await run('time set 0')
      for (const c of openCmds) await run(c)
    },
    async onEvent(ev) {
      if (!armed) return
      if (ev.event === 'nightfall' && !cur) {
        cur = { d0: deaths(), steps: new Set(seen.step ? [seen.step] : []) }
        seen.nightSteps = cur.steps
        if (prod) return
        await run('difficulty easy')
        for (let i = 0; i < phantoms; i++) await run(`execute at ${who} run summon phantom ~ ~16 ~`)
      } else if (ev.event === 'dawn' && cur) {
        close(false)
        if (!prod) await run('difficulty peaceful')
      }
    },
    finish() { return close(true) },
    // Verdict-line tail: nights seen, how many sheltered, deaths at night.
    tag() {
      const nd = nights.reduce((a, n) => a + n.deaths, 0)
      const prodTag = prod && open0 ? `, day-deaths=${deaths() - open0.d - nd}, kitless=${seen.kitless - open0.k}, falls=${seen.falls - open0.f}${HOUSE ? `, drops=${seen.drops}, door-lost=${seen.doorLost}` : ''}` : ''
      const bumpTag = door ? `, bump=${nights.filter((n) => n.bump).length}/${nights.length}` : ''
      if (!nights.length) return ', nights=0' + prodTag + bumpTag
      return `, nights=${nights.length}, sheltered=${nights.filter((n) => n.sheltered).length}/${nights.length}, night-deaths=${nd}` + prodTag + bumpTag
    },
  }
}

// Residence nights (idkcraft-g0z.33, the g0z.30 acceptance): one record per
// night of a seeded complete castle, dusk to dawn — entered (inside a
// residence floor, seconds after dusk), slept (bot.isSleeping or a 'sleep'
// event), shelter episodes (goal step entries into shelter), deaths, and
// dawn-exit (seconds from dawn to the first sample off the floors; only
// owed when the bot was inside at dawn). A night passes on entered +
// slept + 0 shelter + 0 deaths + a dawn exit. t = window seconds.
function createResidenceNights({ deaths, log }) {
  const nights = []
  let armed = false
  let cur = null
  let exitWait = null
  const fmt = (n) => `CASTLE-RIG residence night ${n.night}: entered=${n.enteredS != null ? `yes@${n.enteredS}s` : 'no'}, slept=${n.slept ? 'yes' : 'no'}, ` +
    `shelter=${n.shelter}, deaths=${n.deaths}, dawn-exit=${n.dawnExitS != null ? `${n.dawnExitS}s` : n.insideAtDawn ? 'pending' : 'n/a'}` +
    `${n.partial ? ' (partial)' : ''}${n.pass != null ? (n.pass ? ', PASS' : ', FAIL') : ''}`
  const close = (t, partial) => {
    const n = {
      night: cur.night, enteredS: cur.enteredS, slept: cur.slept, shelter: seen.shelterEps - cur.sh0,
      deaths: deaths() - cur.d0, insideAtDawn: cur.inside === true, dawnExitS: null, partial, pass: null,
    }
    nights.push(n)
    cur = null
    if (!partial && n.insideAtDawn) exitWait = { n, dawnS: t }
    log(fmt(n))
  }
  const judge = (n) => { n.pass = !n.partial && n.enteredS != null && n.slept && n.shelter === 0 && n.deaths === 0 && n.dawnExitS != null }
  return {
    nights,
    open() { armed = true },
    onEvent(ev, t) {
      if (!armed) return
      if ((ev.event === 'dusk' || ev.event === 'nightfall') && !cur) {
        exitWait = null // never left all day: the dawn exit stays unset
        cur = { night: nights.length + 1, duskS: t, enteredS: null, slept: false, sh0: seen.shelterEps, d0: deaths(), inside: null }
      } else if (ev.event === 'dawn' && cur) close(t, false)
    },
    onSample(t, inside, sleeping) {
      if (cur) {
        if (inside && cur.enteredS == null) cur.enteredS = t - cur.duskS
        if (sleeping) cur.slept = true
        cur.inside = !!inside
      } else if (exitWait && !inside) {
        exitWait.n.dawnExitS = t - exitWait.dawnS
        log(`CASTLE-RIG residence night ${exitWait.n.night}: dawn-exit=${exitWait.n.dawnExitS}s`)
        exitWait = null
      }
    },
    finish(t) {
      if (cur) close(t, true)
      for (const n of nights) { judge(n); log(fmt(n)) }
    },
    tag() {
      return `, residence=${nights.filter((n) => n.pass).length}/${nights.length}`
    },
  }
}

// Idle-alone oracle (idkcraft-6x7.24, for atl.24/vmzq.63/vmzq.64): where the
// bot goes with a complete castle, nobody online, no order. Tracks max XZ
// distance from home.site (explore.anchorOf's home anchor), min feet y and
// seconds spent below home.y - 20. Pass: maxdist <= 200 (owner 2026-10-11:
// distance does not matter), the bot was within the home envelope
// (IDLE_HOME = 64 + 16, the alone leash plus a margin) in the last 5 min
// of samples (a forage trip in flight at the cutoff is fine), miny >= resources.surfaceFloor (the gather/explore
// depth floor, read from the bot's own code), 0 deaths, every closed
// residence night PASS. Pure (unit-tested): t = window seconds.
const IDLE_HOME = 64 + 16
const IDLE_MAXDIST = 200
const IDLE_HOME_WINDOW_S = 300
const IDLE_UNDERGROUND_DY = 20
const IDLE_RESPAWN_DIST = 225
// Respawn point for the forced death: IDLE_RESPAWN_DIST from home toward
// the world spawn (the spawn itself when closer), y 150 — fall damage is
// off in the rig, the bot drops onto whatever surface is there.
// v2 body clock (neuc.65.2): bridge bot.time crossings feed only a night
// run; other modes keep today's no-event v2 path (no CASTLE-RIG time:
// lines, no residence-night feed). Returns whether it hooked.
function hookBotClock(b, timeResync, night) {
  if (!night || !b || typeof b.on !== 'function') return false
  b.on('time', () => timeResync.onBotTime(b))
  return true
}
// Prod-night world spawn (neuc.65.2): PROD_SPAWN_DIST from the pad centre
// toward the snapshot's world spawn (+x when they coincide) — prod deaths
// respawn 100-250 out, the snapshot's spawn is ~600 off the pad.
const PROD_SPAWN_DIST = 150
function prodSpawnPoint(pad, spawn) {
  const dx = spawn ? spawn.x - pad.x : 0
  const dz = spawn ? spawn.z - pad.z : 0
  const d = Math.hypot(dx, dz)
  if (d < 1) return { x: Math.round(pad.x + PROD_SPAWN_DIST), z: Math.round(pad.z) }
  return { x: Math.round(pad.x + dx * PROD_SPAWN_DIST / d), z: Math.round(pad.z + dz * PROD_SPAWN_DIST / d) }
}
// Rig house cells after raiseHouse (neuc.65.2): a bed in the bedroom (the
// HOUSE-NIGHT cells), and for bump bedrock in the two cells behind the
// door — the gohome walk cannot get in and nothing digs it.
function rigHouseCommands(site, kind) {
  const { x: ox, y: oy, z: oz } = site
  const cmds = [
    `setblock ${ox + 2} ${oy} ${oz + 4} red_bed[facing=east,part=head]`,
    `setblock ${ox + 1} ${oy} ${oz + 4} red_bed[facing=east,part=foot]`,
  ]
  if (kind === 'bump') cmds.push(`fill ${ox + 3} ${oy} ${oz + 1} ${ox + 3} ${oy + 1} ${oz + 1} bedrock`)
  if (kind === 'pit') {
    // neuc.65.6: the 3x2 doorstep (raise-house) becomes a 6-deep crater in
    // a stone shell — floor 6 below the house floor, like prod's -85 82 -4
    // under the 88 floor. The house slab (z >= oz, y = oy-1) stays.
    cmds.push(`fill ${ox + 1} ${oy - 7} ${oz - 3} ${ox + 5} ${oy - 2} ${oz} stone`)
    cmds.push(`fill ${ox + 2} ${oy - 6} ${oz - 2} ${ox + 4} ${oy - 1} ${oz - 1} air`)
  }
  if (kind === 'gallery') {
    // neuc.65.6.1: a dirt shell, then the void y oy-7..oy-2 under the house
    // and its yard (the oy-1 crust + the house slab stay), feet 6 below
    // the house floor like prod's -85 82 -4 under 88. The doorstep crust
    // cell and the floor beside the table go; a 3-wide west ramp of
    // 1-high steps climbs from the void floor back to the surface.
    cmds.push(`fill ${ox - 15} ${oy - 8} ${oz - 11} ${ox + 13} ${oy - 2} ${oz + 8} dirt`)
    cmds.push(`fill ${ox - 8} ${oy - 7} ${oz - 10} ${ox + 12} ${oy - 2} ${oz + 7} air`)
    cmds.push(`setblock ${ox + 3} ${oy - 1} ${oz - 1} air`)
    cmds.push(`setblock ${ox + 4} ${oy - 1} ${oz + 1} air`)
    for (let k = 1; k <= 6; k++) cmds.push(`fill ${ox - 8 - k} ${oy - 7 + k} ${oz - 1} ${ox - 8 - k} ${oy - 1} ${oz + 1} air`)
  }
  // z591: CASTLE_SILL=dirt puts natural dirt back under the standing door,
  // the sill every pre-z591 prod house has (the swap leg).
  if (process.env.CASTLE_SILL === 'dirt') cmds.push(`setblock ${ox + 3} ${oy - 1} ${oz} dirt`)
  return cmds
}
// neuc.65.6: a server fall-death message for the follower (the vanilla
// fall family: high place, too hard, doomed to fall, fell off/while).
const FALL_DEATH = /^(\S+) (fell from a high place|hit the ground too hard|was doomed to fall|fell off |fell while |was knocked off|fell too far)/
function isFallDeath(msg, who) {
  const m = FALL_DEATH.exec(String(msg || ''))
  return !!m && m[1] === who
}
// neuc.65.6.1: non-lethal drops near the rig house (prod's fall loop is 3 hp
// per 6-block drop, a death only after ~7). A landing 4+ below the last
// grounded sample (vanilla fall damage starts past 3) counts once; stairs,
// the 1-high ramp and a dig-down step never reach it. near(p) false =
// re-anchor only. ponytail: 250 ms samples, no velocity read.
const DROP_MIN = 4
function createDropTrack(near) {
  let groundY = null
  return {
    onSample(p, onGround) {
      if (!p || typeof p.y !== 'number' || onGround === false) return 0
      const drop = groundY != null && groundY - p.y >= DROP_MIN && (!near || near(p))
      groundY = p.y
      return drop ? 1 : 0
    },
  }
}
function idleRespawnPoint(home, spawn) {
  const dx = spawn.x - home.x
  const dz = spawn.z - home.z
  const k = Math.min(1, IDLE_RESPAWN_DIST / (Math.hypot(dx, dz) || 1))
  return { x: Math.round(home.x + dx * k), y: 150, z: Math.round(home.z + dz * k) }
}
function createIdleTrack(home) {
  const h = home.site
  const floor = require('../src/resources').surfaceFloor({ home })
  const st = { maxdist: 0, miny: null, undergroundS: 0, lastT: null, lastUnder: false, homeT: null, endT: null, diedS: null, rehomeS: null, paused: false, yardLitter: null }
  return {
    st,
    floor,
    // Yard litter (idkcraft-g0z.44): own blocks left in the fence band,
    // counted once after the window (placedByBot candidates, rcon
    // readback). Unset = unjudged, like an empty night list.
    setYardLitter(n) { st.yardLitter = n },
    // Forced death (6x7.25): the respawn walk from world spawn is not
    // judged; tracking resumes at the first sample back inside the leash.
    // pause() spans the kill until the body stands at the respawn point
    // (the sampler timer runs on its own: a stale or fresh position read in
    // between must not count).
    pause() { st.paused = true },
    died(t) { st.paused = false; st.diedS = t; st.rehomeS = null; st.lastT = null; st.lastUnder = false },
    onSample(t, p) {
      if (st.paused || !p || typeof p.y !== 'number') return
      const d = Math.hypot(p.x - h.x, p.z - h.z)
      if (st.diedS != null && st.rehomeS == null) {
        if (d > IDLE_HOME) return
        st.rehomeS = t
      }
      st.endT = t
      if (d <= IDLE_HOME) st.homeT = t
      if (d > st.maxdist) st.maxdist = d
      if (st.miny == null || p.y < st.miny) st.miny = p.y
      if (st.lastUnder && st.lastT != null) st.undergroundS += t - st.lastT
      st.lastUnder = p.y < h.y - IDLE_UNDERGROUND_DY
      st.lastT = t
    },
    tag() {
      const death = st.diedS == null ? '' : `, idle-death=${Math.round(st.diedS)}s, idle-rehome=${st.rehomeS == null ? 'never' : `${Math.round(st.rehomeS)}s`}`
      const yard = st.yardLitter == null ? '' : `, yard-litter=${st.yardLitter}`
      return `, idle-maxdist=${Math.round(st.maxdist)}, idle-miny=${st.miny == null ? '?' : Math.floor(st.miny)}, idle-underground-s=${Math.round(st.undergroundS)}${death}${yard}`
    },
    // nights: residence night records (partial ones are not judged).
    verdict(deaths, nights = []) {
      const why = []
      if (st.maxdist > IDLE_MAXDIST) why.push(`maxdist ${Math.round(st.maxdist)}>${IDLE_MAXDIST}`)
      if (st.endT != null && (st.homeT == null || st.endT - st.homeT > IDLE_HOME_WINDOW_S)) why.push('not home at the end')
      if (st.miny == null) why.push('no position samples')
      else if (Math.floor(st.miny) < floor) why.push(`miny ${Math.floor(st.miny)}<${floor}`)
      if (st.diedS != null && st.rehomeS == null) why.push('never back within the leash after the forced death')
      if (st.yardLitter != null && st.yardLitter > 0) why.push(`yard-litter ${st.yardLitter}>0`)
      if (deaths > 0) why.push(`deaths ${deaths}>0`)
      for (const n of nights) if (!n.partial && !n.pass) why.push(`residence night ${n.night} FAIL`)
      return { pass: why.length === 0, line: `CASTLE-RIG idle: ${why.length ? `FAIL (${why.join(', ')})` : 'PASS'} floor=${floor}` }
    },
  }
}

// Seeded complete castle (idkcraft-g0z.33): every setblock for a finished
// castle at st (st.blueprintVersion, v3 since g0z.47) — keep-clear/moat
// cells to air first, then the plan cells in lay order (the bot's own
// paint: cobble, oak planks/fence, spruce frame, cobble stairs with the
// plan facing), the gate's upper half, both bedroom beds and the table
// on the residence cells. kind = plan kind (read back with
// castle.matches) or 'extra' (read back by block name). Pure.
const SEED_PAINT = { stone: 'cobblestone', planks: 'oak_planks', frame: 'spruce_log', fence: 'oak_fence', chest: 'chest', torch: 'torch', air: 'air', dig: 'air' }
const FACING = ['north', 'east', 'south', 'west']
function seedCastleCells(st) {
  const blueprint = require('../src/castle')
  const residence = require('../src/residence')
  const cells = blueprint.absPlan(st.site, st.rot, st.blueprintVersion).cells
  const f = FACING[(st.rot | 0) % 4]
  const out = []
  for (const c of cells) if (!blueprint.isPlaceTarget(c.kind)) out.push({ x: c.x, y: c.y, z: c.z, kind: c.kind, block: 'air' })
  for (const c of cells) {
    if (!blueprint.isPlaceTarget(c.kind)) continue
    const block = c.kind === 'door' ? `oak_door[half=lower,facing=${f}]`
      : c.kind === 'stairs' ? `cobblestone_stairs[facing=${blueprint.faceName(c.face)},half=bottom]`
      : SEED_PAINT[c.kind]
    out.push({ x: c.x, y: c.y, z: c.z, kind: c.kind, block })
  }
  const door = cells.find((c) => c.kind === 'door')
  out.push({ x: door.x, y: door.y + 1, z: door.z, kind: 'extra', block: `oak_door[half=upper,facing=${f}]` })
  // lqgo: the door sill as v2 lays it (planks), so the seed is not a swap leg;
  // CASTLE_SILL=dirt keeps the pre-lqgo natural sill (the swap leg).
  out.push({ x: door.x, y: door.y - 1, z: door.z, kind: 'extra', block: process.env.CASTLE_SILL === 'dirt' ? 'dirt' : 'oak_planks' })
  const home = residence.castleHome(st)
  for (const b of residence.CASTLE.beds(home)) {
    out.push({ x: b.foot.x, y: b.foot.y, z: b.foot.z, kind: 'extra', block: `red_bed[part=foot,facing=${FACING[b.facing]}]` })
    out.push({ x: b.head.x, y: b.head.y, z: b.head.z, kind: 'extra', block: `red_bed[part=head,facing=${FACING[b.facing]}]` })
  }
  const t = residence.CASTLE.table(home)
  out.push({ x: t.x, y: t.y, z: t.z, kind: 'extra', block: 'crafting_table' })
  return out
}
function seedMatches(cell, name, props) {
  if (cell.kind === 'extra') return name === cell.block.split('[')[0]
  if (!require('../src/castle').matches(cell.kind, name)) return false
  if (cell.kind === 'stairs' && props && typeof props.facing === 'string') {
    const want = /facing=([a-z]+)/.exec(cell.block)
    const half = /half=([a-z]+)/.exec(cell.block)
    if (!want || props.facing !== want[1]) return false
    if (half && props.half !== half[1]) return false
  }
  return true
}

// neuc.60: the world's game tick counter (advances under the day lock too);
// null when unreadable — the caller falls back to wall x SPEED.
async function gameTime() {
  try {
    const m = /(\d+)/.exec(await rcon('time query gametime'))
    return m ? Number(m[1]) : null
  } catch (_) { return null }
}

// neuc.62: the one banked-stone loop (componentLine and fetchLine share it).
// banked = positive stone deltas between consecutive castlefetch samples;
// spanS/firstS count from the sample before the first gain; fetchS = all
// castlefetch sample seconds; dead = [from, to] windows (wall s) of >= 120 s
// without a gain.
function bankedOf(series) {
  let banked = 0
  let spanS = 0
  let firstS = null
  let fetchS = 0
  const dead = []
  let w = null
  const close = () => { if (w && w[1] - w[0] >= 120) dead.push(w); w = null }
  for (let i = 1; i < series.length; i++) {
    const a = series[i - 1]
    const b = series[i]
    if (b.step !== 'castlefetch' || typeof a.stone !== 'number' || typeof b.stone !== 'number') { close(); continue }
    fetchS += b.t - a.t
    const gain = Math.max(0, b.stone - a.stone)
    if (gain > 0) close()
    else if (w && w[1] === a.t) w[1] = b.t
    else { close(); w = [a.t, b.t] }
    if (firstS == null && gain > 0) firstS = a.t
    if (firstS == null) continue
    banked += gain
    spanS += b.t - a.t
  }
  close()
  return { banked, spanS, firstS, fetchS, dead }
}

// neuc.60: component verdict, pure (unit-tested). lay = castle cells laid
// per game minute of the window; mine = stone (castle STONE_ITEMS) banked
// in the pack per game minute of castlefetch time, counted from the sample
// before the first gain (the walk to the first stone is first=, not rate).
// series = the 15 s samples ({ t, step, stone, done }); wall seconds scale
// by the measured game/wall ratio. baseline = { rate } or null. diag (6x7.26:
// a window under the baseline's 10 game-min) never judges and tags the line.
function componentLine(kind, { laid, gameMin, wallMin, series, tick, baseline, diag }) {
  const ratio = wallMin > 0 ? gameMin / wallMin : 1
  let rate = null
  let body
  if (kind === 'lay') {
    rate = gameMin > 0 ? laid / gameMin : null
    body = `laid=${laid} in ${gameMin.toFixed(1)} game-min`
  } else {
    const { banked, spanS, firstS } = bankedOf(series)
    const spanMin = spanS / 60 * ratio
    rate = spanMin > 0 ? banked / spanMin : null
    body = `banked=+${banked} in ${spanMin.toFixed(1)} game-min of castlefetch, first=${firstS == null ? '-' : `${Math.round(firstS * ratio)}s`}, window=${gameMin.toFixed(1)} game-min`
  }
  let judge = ''
  if (!diag && rate != null && baseline && baseline.rate > 0) {
    const pct = Math.round((rate / baseline.rate - 1) * 100)
    judge = `, baseline ${baseline.rate} -> ${rate.toFixed(1)} (${pct >= 0 ? '+' : ''}${pct}%, ${Math.abs(pct) <= 20 ? 'within' : 'OUTSIDE'} ±20%)`
  }
  return `${kind}-rate ${rate == null ? '-' : rate.toFixed(1)}/game-min${diag ? ' (DIAG, no baseline verdict)' : ''}: ${body}, tick=${tick}${judge}`
}

// 6x7.27: CASTLE_BASELINE_RATE > 0 judges against the cached before
// (castle-before.sh) instead of the component-baseline.json entry.
function baselineFor(fileEntry, env) {
  const r = Number(env.CASTLE_BASELINE_RATE)
  return r > 0 ? { rate: r } : fileEntry
}

// neuc.62: fetch verdict, pure (unit-tested). events = classify's leg events
// with t (wall s from window open); ticks = castlefetch decisions; mineBase =
// the mine entry of component-baseline.json or null. Diagnosis only, no judge.
function fetchLine({ series, events, ticks, ratio, mineBase }) {
  const { banked, fetchS, dead } = bankedOf(series)
  const starts = events.filter((e) => e.ev === 'start').length
  if (!fetchS && !starts) return 'fetch: -'
  const cuts = {}
  let nCut = 0
  for (const e of events) if (e.ev === 'cut') { cuts[e.by] = (cuts[e.by] || 0) + 1; nCut++ }
  const fin = events.filter((e) => e.ev === 'finish').length
  const per = banked > 0 ? (fetchS * ratio / banked).toFixed(1) : '-'
  const comp = mineBase && mineBase.rate > 0 ? (60 / mineBase.rate).toFixed(1) : '-'
  const by = Object.entries(cuts).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, v]) => `${k}:${v}`).join(',') || 'none'
  const far = Object.entries(cuts).filter(([k]) => /far/.test(k)).reduce((n, [, v]) => n + v, 0)
  const min = (x) => Math.round(x / 60 * ratio)
  const deadMin = Math.round(dead.reduce((n, w) => n + (w[1] - w[0]), 0) / 60 * ratio)
  const ranges = dead.slice(0, 5).map((w) => `${min(w[0])}-${min(w[1])}`).join(',')
  return `fetch: ticks=${ticks || 0} stone=+${banked} (${per} s/stone, component ${comp}) legs=${starts} finished=${fin} cut=${nCut} cut-by=${by} far=${far} dead=${deadMin}min${ranges ? ` (t=${ranges}${dead.length > 5 ? ',...' : ''})` : ''}`
}

async function rcon(cmd) {
  const { stdout } = await execFileAsync('docker', ['exec', CONTAINER, 'rcon-cli', cmd])
  const out = String(stdout)
  if ((cmd.startsWith('tp ') && !out.includes('Teleported')) ||
      (cmd.startsWith('op ') && !out.toLowerCase().includes('operator')) ||
      ((cmd.startsWith('clear ') || cmd.startsWith('give ') || cmd.startsWith('effect ')) && /No entity was found|Unknown|incorrect/i.test(out)) ||
      ((cmd.startsWith('fill ') || cmd.startsWith('setblock ')) && !/Successfully filled|No blocks were filled|Changed the block|Could not set the block/.test(out))) {
    throw new Error(`rcon failed [${cmd}]: ${out.trim().slice(0, 160)}`)
  }
  return out
}

function fail(kind, detail) {
  origLog(`CASTLE-RIG SETUP-FAIL ${kind}: ${detail} (full log ${LOGFILE})`)
  try { logStream.end() } catch (_) { /* close best-effort */ }
  process.exit(2)
}

// Blocked-cell seeds (idkcraft-vmzq.27): prod run4's stall mix — a lone
// oak_log reads 'protected' (util.isTreeLog wants a trunk or a crown),
// a chest reads kept-chest (FOREIGN, never dug). Lowest (dy, idx) stone
// first: all three land in the work order's first-16 prefix, so the old
// layer gate stalls on them within minutes and the skip fix must build
// past. Pure (unit-tested): the rcon writes + readback live in main().
// vmzq.40: planks join the mix and the chest is seeded filled (SEED_NBT) —
// the footprint rule clears both and relocates the chest, contents intact.
const SEED_MATS = ['oak_log', 'chest', 'oak_planks']
const SEED_NBT = { chest: '{Items:[{Slot:0b,id:"minecraft:diamond",count:3},{Slot:1b,id:"minecraft:oak_planks",count:20}]}' }
function pickBlockedSeeds(site, rot, version, n) {
  const blueprint = require('../src/castle')
  const { cells } = blueprint.absPlan(site, rot, version)
  const byDyIdx = (a, b) => a.dy - b.dy || a.idx - b.idx
  return cells.filter((c) => c.kind === 'stone').sort(byDyIdx).slice(0, n)
    .map((c, i) => ({ x: c.x, y: c.y, z: c.z, kind: c.kind, block: SEED_MATS[i % SEED_MATS.length] }))
}

// Pad-spot pick (pair 2, vmzq.33): the flattest readable 48x48 among the 9
// candidates around the pad. Readability is chunk-load timing after a fixed
// sleep, so two runs on the same pad can pick different spots — pair 2 ran
// the castle at 235,347 (master) vs 235,297 (branch), different quarries,
// and the branch-only dig stalls. CASTLE_PADSPOT="x,z" pins the spot and
// skips the scan: controlled pairs set it on both legs. Pure over scan
// (a null scan reads unreadable); exported for tests.
function pickPadSpot(scan, px, pz) {
  const pin = String(process.env.CASTLE_PADSPOT || '').trim()
  if (pin) {
    const m = pin.match(/^(-?\d+)\s*,\s*(-?\d+)$/)
    if (!m) throw new Error(`CASTLE_PADSPOT: want "x,z", got ${JSON.stringify(process.env.CASTLE_PADSPOT)}`)
    return { bx: +m[1], bz: +m[2], brel: null, best: null, pinned: true }
  }
  const cands = [[px, pz], [px - 50, pz], [px + 50, pz], [px, pz - 50], [px, pz + 50],
    [px - 50, pz - 50], [px + 50, pz - 50], [px - 50, pz + 50], [px + 50, pz + 50]]
  let best = null
  for (const [qx, qz] of cands) {
    const r = scan(qx, qz)
    if (r && (!best || r.score < best.score)) best = { ...r, x: qx, z: qz }
  }
  if (best) return { bx: best.x, bz: best.z, brel: best, best, pinned: false }
  return { bx: px, bz: pz, brel: null, best: null, pinned: false }
}

function waitFor(em, ev, ms, what) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { em.removeListener(ev, on); reject(new Error(`${what} timeout`)) }, ms)
    function on(...a) { clearTimeout(t); resolve(a) }
    em.once(ev, on)
  })
}

// Landing read (idkcraft-g0z.54): the guide's Y once it stops falling —
// five stable floored reads (2.5 s), so a laggy mid-fall read (the 0/44
// "regression": y=139 on a fixed 4 s sleep, pad floating 77 above the
// terrain) never becomes the pad top. reads is Y floats or nulls
// (unreadable); the floored Y or null. Pure.
const LANDING_STABLE_READS = 5
function landingY(reads) {
  if (!Array.isArray(reads) || reads.length < LANDING_STABLE_READS) return null
  const tail = reads.slice(-LANDING_STABLE_READS)
  if (tail.some((y) => typeof y !== 'number' || !Number.isFinite(y))) return null
  const f = Math.floor(tail[0])
  return tail.every((y) => Math.floor(y) === f) ? f : null
}

// Accepted landing (revmux core-2): a stable read above the ceiling is a
// hover over an unloaded chunk (physics never runs, Y frozen at the tp
// height), not a landing — the poll keeps waiting for chunks to load
// instead of failing fast. Pure.
const LANDING_CEIL = 140
function acceptLanding(reads) {
  const y = landingY(reads)
  return y != null && y > LANDING_CEIL ? null : y
}

// Grounded check (idkcraft-g0z.54): the block just below the pad dirt —
// air/void/unreadable means the pad floats (a sky-platform landing) and
// the setup fails loud instead of stranding a 60 min run. Solid or
// liquid passes (an ocean pad sits on water). Pure.
function padFloats(below) {
  if (!below || typeof below.name !== 'string') return true
  return below.name === 'air' || below.name === 'cave_air' || below.name === 'void_air'
}

// Floating pad (revmux core-3): air at BOTH depths — a lone cave under
// the centre column must not fail a grounded pad, but a 77-deep sky
// column fails. Pure.
function floatingPad(shallow, deep) {
  return padFloats(shallow) && padFloats(deep)
}

async function main() {
  if (GUIDE.length > 16 || FOLLOWER.length > 16) {
    throw new Error(`bot names exceed 16 chars (TAG=${JSON.stringify(TAG)}); set a shorter CASTLE_TAG`)
  }
  if (PAD.length !== 2 || !PAD.every(Number.isFinite)) throw new Error(`CASTLE_PAD: want "x,z", got ${JSON.stringify(process.env.CASTLE_PAD)}`)
  hookConsole()
  const [px, pz] = PAD.map(Math.floor)
  const index = require('../src/index')
  const brainMod = require('../src/brain')
  let brain = brainMod.stubBrain
  let brainEngine = ''
  if (SEED && SEED !== 'complete') fail('seed', `CASTLE_SEED: want ''|complete, got ${JSON.stringify(SEED)}`)
  if (IDLE && SEED !== 'complete') fail('idle', 'CASTLE_IDLE=1 needs CASTLE_SEED=complete (castle-rig.sh sets it)')
  // vhlb.2: only the llm leg may reach the LLM planner — an operator
  // shell key would otherwise re-attach it on the autonomous step-down.
  if (PLANNER !== 'llm') delete process.env.ANTHROPIC_API_KEY
  if (PLANNER === 'jev') {
    const key = process.env.TYPESAFE_API_KEY
    // Loud, never silent: a jev run without a key would measure the stub
    // while the verdict claims JEV. The key itself is never printed.
    if (!key) fail('planner-key', 'RIG_PLANNER=jev needs TYPESAFE_API_KEY (stash secrets/jev-api-key)')
    brain = brainMod.hybridBrain(brainMod.jevBrain(key, undefined, brainMod.brainTimeoutMs(process.env), brainMod.JEV_ENDPOINT))
    brainEngine = 'jev'
  } else if (PLANNER === 'laya') { // idkcraft-vhlb.1: laya sidecar, tick asks only (no key = no JEV planner), prod's 3 s deadline
    const url = process.env.REPLAY_BRAIN_URL || 'http://localhost:8000/v1/systemone'
    brain = brainMod.hybridBrain(brainMod.jevBrain(undefined, undefined, parseInt(process.env.REPLAY_BRAIN_TIMEOUT_MS || '3000', 10), url))
    brainEngine = 'laya'
  } else if (PLANNER === 'llm') {
    // vhlb.2: stub tick brain + the LLM stall planner (ANTHROPIC_API_KEY,
    // never printed); withPlanner refuses nothing, so check the key here.
    if (!process.env.ANTHROPIC_API_KEY) fail('planner-key', 'RIG_PLANNER=llm needs ANTHROPIC_API_KEY (stash secrets/minecraft/anthropic-api-key)')
    brain = brainMod.withPlanner(brainMod.stubBrain, { ...process.env, PLANNER: 'llm' })
  } else if (PLANNER !== 'stub') {
    fail('planner', `RIG_PLANNER: want jev|laya|llm|stub, got ${JSON.stringify(PLANNER)}`)
  }
  origLog(`CASTLE-RIG planner=${PLANNER}`)

  // Clock resync (vmzq.45): track server dusk/dawn every run, correct
  // bot.time only above wall-clock rate (the TICKRATE=1 gate path writes
  // nothing). Attached in mk(), before login completes — the spawn full
  // packets are the first anchor, and a post-spawn attach would miss them.
  const RESYNC_WRITE = (parseInt(TICKRATE, 10) || 1) > 1
  const timeT0 = Date.now()
  // deaths is declared below; the driver reads it only once armed (window open).
  // neuc.65.2: filled once the pad is known (open() reads them at window start).
  // keep_inventory stays true (prod reads true 2026-10-17, the bead assumed
  // false): CASTLE_KEEP_INVENTORY=0 drops the kit on death instead.
  const nightOpen = NIGHT_PROD ? ['difficulty easy', 'gamerule fall_damage true', ...(process.env.CASTLE_KEEP_INVENTORY === '0' ? ['gamerule keep_inventory false'] : [])] : []
  const bumpDoor = HOUSE === 'bump' ? { x: 0, z: 0 } : null
  const night = NIGHT ? createNightDriver({ cmd: rcon, who: FOLLOWER, deaths: () => deaths, log: origLog, prod: NIGHT_PROD, openCmds: nightOpen, door: bumpDoor }) : null
  const resNights = SEED ? createResidenceNights({ deaths: () => deaths, log: origLog }) : null
  let winT0 = 0 // window start; residence nights count seconds from it
  const timeResync = createTimeResync({
    write: RESYNC_WRITE,
    onEvent: (ev) => {
      const plusS = Math.round((ev.at - timeT0) / 1000)
      seen.timeEvents.push({ event: ev.event, server: ev.server, bot: ev.bot, plusS })
      origLog(`CASTLE-RIG time: ${ev.event} server=${ev.server} bot=${ev.bot} +${plusS}s${ev.skip ? ' (sleep skip)' : ''}`)
      if (night) night.onEvent(ev)
      if (resNights) resNights.onEvent(ev, Math.round((ev.at - winT0) / 1000))
    },
  })
  origLog(`CASTLE-RIG time-resync: tickrate=${TICKRATE} mode=${RESYNC_WRITE ? 'correct' : 'track'}`)

  const guide = mineflayer.createBot({ host: HOST, port: PORT, username: GUIDE, auth: 'offline' })
  await waitFor(guide, 'spawn', 60000, 'guide spawn').catch((e) => fail('guide-spawn', e.message))
  guide.on('messagestr', (m) => { if (isFallDeath(m, FOLLOWER)) seen.falls++ }) // neuc.65.6: falls= on the prod tag
  await sleep(6000) // past Paper's same-IP connection throttle (stuck-replay precedent)

  let follower = null
  const chats = []
  const mk = (opts) => {
    // v2 body (g0z.56, the stuck-replay neuc.5 shape): BOT_BODY=baritone
    // builds on the bridge adapter; it connects from inside its container,
    // where the rig's loopback is host.docker.internal. No raw packet
    // client there: the time resync tracks the bot clock only.
    const b = process.env.BOT_BODY === 'baritone'
      ? require('../src/bridge').createBot({ ...opts, host: process.env.REPLAY_BODY_MC_HOST || 'host.docker.internal', username: FOLLOWER })
      : mineflayer.createBot({ ...opts, username: FOLLOWER })
    follower = b
    if (b._client) b._client.on('update_time', (packet) => timeResync.onPacket(b, packet))
    else hookBotClock(b, timeResync, NIGHT)
    b.on('time', () => timeResync.apply(b))
    b.on('physicsTick', () => timeResync.onTick(b))
    b.once('spawn', () => {
      const origChat = b.chat.bind(b)
      b.chat = (msg) => { chats.push(String(msg)); return origChat(msg) }
    })
    return b
  }
  let deaths = 0
  index.runOnce({
    host: HOST, port: PORT, username: FOLLOWER, tickMs: 1000, idleTickMs: 1000,
    brain, brainEngine, leaveAfterMs: 0, followName: '', autonomous: true, createBot: mk,
    pingFn: async () => ({ players: {} }),
  }).then(() => {}, (e) => { origLog(`CASTLE-RIG follower runOnce rejected: ${e && e.message ? e.message : e}`); process.exit(2) })
  if (!follower) throw new Error('follower never created')
  await waitFor(follower, 'spawn', 60000, 'follower spawn').catch((e) => fail('follower-spawn', e.message))
  follower.on('death', () => { deaths++ })
  let worldSpawn = null // 6x7.25: the first spawn, before any tp, is the world spawn
  try { worldSpawn = follower.entity.position.floored() } catch (_) { worldSpawn = null }
  follower.on('end', () => fail('follower-dropped', 'connection ended mid-run'))
  await sleep(3000)
  await rcon(`op ${GUIDE}`).catch((e) => fail('op', e.message))
  await rcon(`op ${FOLLOWER}`).catch((e) => fail('op', e.message))
  const tickCtx = () => follower._tickerCtx
  if (tickCtx()) tickCtx().paused = true

  // Pad probe: drop the guide over the preferred centre (loads chunks
  // around it), pick the flattest 48x48 among candidates, read the landing
  // there, flatten around it. Flat matters: prod's castle search wants
  // level ground, and a mesa pad strands the gather return under sheer
  // dirt walls (rig cycle 8: the bot sat 14 below the trench, unreachable).
  // Pad top = landing (dirt box below, air above in <=17k-block fills —
  // the fill cap is 32768). 48x48 holds the 31x27 site plus the search.
  await rcon(`tp ${GUIDE} ${px} 150 ${pz}`).catch((e) => fail('pad-probe', e.message))
  await sleep(6000) // fall + chunks in (view distance covers the candidates)
  const scanRelief = (qx, qz) => {
    let lo = Infinity; let hi = -Infinity; let liquid = 0; let n = 0
    for (let x = qx - 24; x <= qx + 24; x += 3) {
      for (let z = qz - 24; z <= qz + 24; z += 3) {
        let top = null; let topY = null
        for (let y = 110; y >= 45; y--) {
          let b = null
          // A Vec3, never a bare {x,y,z}: getBlock floors it, a plain object
          // threw into the catch and every candidate read unreadable — the
          // pad fell back to the preferred spot, a lake (idkcraft-vmzq.26).
          try { b = guide.blockAt(new Vec3(x, y, z)) } catch (_) { b = null }
          if (!b) return null // unloaded: candidate unreadable
          if (b.name === 'air' || b.name === 'cave_air' || b.name === 'void_air') continue
          top = b.name; topY = y
          break
        }
        if (top == null) return null
        n++
        if (top === 'water' || top === 'lava') liquid++
        if (topY < lo) lo = topY
        if (topY > hi) hi = topY
      }
    }
    if (n === 0) return null
    return { span: hi - lo, liquid, score: (hi - lo) + liquid * 2 }
  }
  let bx = px; let bz = pz; let brel = null
  {
    const pick = pickPadSpot(scanRelief, px, pz)
    bx = pick.bx; bz = pick.bz; brel = pick.brel
    const tag = pick.best ? '' : (pick.pinned ? ' (pinned)' : ' (preferred, unreadable)')
    origLog(`CASTLE-RIG padspot ${bx},${bz} span=${brel ? brel.span : '?'} liquid=${brel ? brel.liquid : '?'}${tag}`)
  }
  await rcon(`tp ${GUIDE} ${bx} 150 ${bz}`).catch((e) => fail('pad-probe', e.message))
  // Wait for the landing (g0z.54): poll Y to 30 s, accept on five stable
  // reads — a fixed 4 s sleep misread y=139 mid-fall under lag and the
  // pad floated 77 above the terrain (the 0/44 "regression").
  let gy = null
  {
    const reads = []
    for (let i = 0; i < 60 && gy == null; i++) {
      await sleep(500)
      let y = null
      try { y = guide.entity.position.y } catch (_) { y = null }
      reads.push(typeof y === 'number' ? y : null)
      gy = acceptLanding(reads)
    }
  }
  if (gy == null) fail('pad-probe', `guide never landed at ${bx},150,${bz}`)
  if (gy < 40 || gy > LANDING_CEIL) fail('pad-probe', `no landing at ${bx},150,${bz} (y=${gy})`)
  const x0 = bx - 24; const x1 = bx + 24; const z0 = bz - 24; const z1 = bz + 24
  origLog(`CASTLE-RIG pad ${x0}..${x1} top ${gy} ${z0}..${z1}`)
  for (const cmd of [
    `fill ${x0} ${gy - 5} ${z0} ${x1} ${gy} ${z1} dirt`,
    `fill ${x0} ${gy + 1} ${z0} ${x1} ${gy + 7} ${z1} air`,
    `fill ${x0} ${gy + 8} ${z0} ${x1} ${gy + 14} ${z1} air`,
  ]) {
    await rcon(cmd).catch((e) => fail('pad-fill', e.message))
  }
  // Grounded (g0z.54): the pad dirt must sit on something — air at both
  // depths is a floating pad (a sky-platform landing) that would strand
  // the run. One air column alone is a cave, not a failure (core-3).
  {
    let shallow = null
    let deep = null
    try { shallow = guide.blockAt(new Vec3(bx, gy - 6, bz)) } catch (_) { shallow = null }
    try { deep = guide.blockAt(new Vec3(bx, gy - 20, bz)) } catch (_) { deep = null }
    if (floatingPad(shallow, deep)) fail('pad-float', `pad top ${gy} floats (below ${bx} ${gy - 6}/${gy - 20} ${bz} is ${shallow && shallow.name ? shallow.name : 'unreadable'}/${deep && deep.name ? deep.name : 'unreadable'})`)
  }
  // Sand patch (g0z.38): east of the pad edge (x1 = bx + 24), ~11 off the
  // seeded castle's east wall, dry (dirt base) and walkable from the pad.
  if (SAND) {
    for (const cmd of [
      `fill ${bx + 25} ${gy - 5} ${bz - 4} ${bx + 32} ${gy} ${bz + 3} dirt`,
      `fill ${bx + 25} ${gy + 1} ${bz - 4} ${bx + 32} ${gy + 7} ${bz + 3} air`,
      `fill ${bx + 26} ${gy - 2} ${bz - 3} ${bx + 31} ${gy} ${bz + 2} sand`,
    ]) {
      await rcon(cmd).catch((e) => fail('sand-fill', e.message))
    }
    origLog(`CASTLE-RIG sand patch ${bx + 26}..${bx + 31} ${gy - 2}..${gy} ${bz - 3}..${bz + 2} (108 sand)`)
  }
  // Seeded castle (g0z.33): the castle covers the pad centre, so both
  // land north of its fence line (site.z = bz - 13) instead.
  const standZ = SEED ? bz - 17 : bz
  await rcon(`tp ${GUIDE} ${bx + 0.5} ${gy + 1} ${standZ + 0.5}`).catch((e) => fail('pad-tp', e.message))
  await rcon(`tp ${FOLLOWER} ${bx + 2.5} ${gy + 1} ${standZ + 0.5}`).catch((e) => fail('pad-tp', e.message))
  await rcon(`clear ${FOLLOWER}`).catch((e) => fail('clear', e.message))
  // Seeded kit (pace split: laying measured independent of fetching): a
  // complete castle-opening kit — batch stone, planks, scaffold dirt and a
  // stone kit (pick + sword), so equip is kit-complete and the first castle
  // word is a batch. One give carries many stacks (stuck precedent).
  if (KIT === 'seeded') {
    for (const [item, count] of [['cobblestone', 128], ['oak_planks', 64], ['dirt', 64],
      ['stone_pickaxe', 1], ['stone_sword', 1], ['bookshelf', 5], ['enchanting_table', 1], ['blast_furnace', 1]]) {
      await rcon(`give ${FOLLOWER} ${item} ${count}`).catch((e) => fail('seed', `${item}: ${e.message}`))
    }
    origLog('CASTLE-RIG kit=seeded (128 cobble, 64 planks, 64 dirt, stone pick+sword, 5 shelves + table, blast furnace)')
  }
  // neuc.60 component kits: lay = the seeded kit with stock for a whole
  // 10-game-min window (no fetch leg should open); pick = 3 stone picks +
  // a sword and nothing to lay, so the first castle word opens a stone leg.
  if (KIT === 'lay') {
    for (const [item, count] of [['cobblestone', 640], ['oak_planks', 192], ['dirt', 64], ['torch', 32],
      ['stone_pickaxe', 1], ['stone_sword', 1], ['bookshelf', 5], ['enchanting_table', 1], ['blast_furnace', 1]]) {
      await rcon(`give ${FOLLOWER} ${item} ${count}`).catch((e) => fail('seed', `${item}: ${e.message}`))
    }
    origLog('CASTLE-RIG kit=lay (640 cobble, 192 planks, 64 dirt, 32 torches, stone pick+sword, 5 shelves + table, blast furnace)')
  }
  if (KIT === 'pick') {
    for (const [item, count] of [['stone_pickaxe', 3], ['stone_sword', 1]]) {
      await rcon(`give ${FOLLOWER} ${item} ${count}`).catch((e) => fail('seed', `${item}: ${e.message}`))
    }
    origLog('CASTLE-RIG kit=pick (3 stone picks + sword, nothing to lay)')
  }
  // Junk kit (vmzq.38): the prod 2026-10-06 pack — 36/36 stone variants,
  // sand and mob junk, wooden sword only: no pickaxe, no table, no cobble.
  if (KIT === 'junk') {
    for (const [item, count] of [['granite', 90], ['diorite', 113], ['andesite', 115], ['smooth_basalt', 12],
      ['sand', 30], ['leaf_litter', 40], ['rotten_flesh', 20], ['bow', 4], ['raw_iron', 63], ['oak_planks', 128],
      ['acacia_door', 3], ['white_bed', 1], ['arrow', 88], ['wooden_sword', 1], ['bone', 64], ['string', 64],
      ['gunpowder', 64], ['spider_eye', 64], ['feather', 64], ['flint', 64], ['wheat_seeds', 64], ['oak_sapling', 64],
      ['kelp', 64], ['cactus', 64], ['egg', 16], ['ink_sac', 64], ['slime_ball', 64], ['clay_ball', 64]]) {
      await rcon(`give ${FOLLOWER} ${item} ${count}`).catch((e) => fail('seed', `${item}: ${e.message}`))
    }
    origLog('CASTLE-RIG kit=junk (36/36 stone variants + junk, no pickaxe)')
  }
  // Valuables kit (vmzq.39): 36/36 never-dropped valuables — ores, wool,
  // tools, coal, wood — no stone or dirt (the dig has no room until the
  // site chest takes them), a pick to dig with once it does, chests and a
  // table to build the storage. Nothing droppable, nothing shedable.
  if (KIT === 'valuables') {
    for (const [item, count] of [['raw_iron', 64], ['iron_ingot', 64], ['raw_gold', 64], ['diamond', 32],
      ['coal', 64], ['oak_log', 64], ['oak_planks', 64], ['white_wool', 32],
      ['stone_pickaxe', 2], ['iron_sword', 1], ['bow', 2], ['chest', 2], ['crafting_table', 1],
      ['bread', 32], ['arrow', 96], ['white_bed', 1], ['oak_door', 1], ['oak_fence', 16], ['torch', 32],
      ['charcoal', 64], ['raw_copper', 64], ['lapis_lazuli', 64], ['redstone', 64], ['emerald', 32],
      ['iron_helmet', 1], ['iron_chestplate', 1], ['shield', 1], ['string', 64], ['bone', 64],
      ['gunpowder', 64], ['feather', 64], ['flint', 64], ['leather', 64]]) {
      await rcon(`give ${FOLLOWER} ${item} ${count}`).catch((e) => fail('seed', `${item}: ${e.message}`))
    }
    origLog('CASTLE-RIG kit=valuables (36/36 ores + tools + wood, no stone/dirt)')
  }
  // Stairs kit (g0z.48): the upgrade run's material — one stair per
  // converted cell (the v3 count, read from the plan), a stone kit to dig
  // the v2 steps out with, and bread for the 68 min window (a workable
  // castle vetoes forage, so no food would stall the relay hungry).
  if (KIT === 'stairs') {
    const bp = require('../src/castle')
    const n = bp.absPlan({ x: 0, y: 0, z: 0 }, 0, bp.BLUEPRINT_VERSION).cells.filter((c) => c.kind === 'stairs').length
    for (const [item, count] of [['cobblestone_stairs', n], ['stone_pickaxe', 1], ['stone_sword', 1], ['bread', 32]]) {
      await rcon(`give ${FOLLOWER} ${item} ${count}`).catch((e) => fail('seed', `${item}: ${e.message}`))
    }
    origLog(`CASTLE-RIG kit=stairs (${n} cobble stairs, stone pick+sword, 32 bread)`)
  }
  // Blast kit (g0z.51): the self-source run's material — 5 raw iron +
  // coal + cobble (3 smooth chain + 8 recipe furnace + 8 station + the 24
  // scaffold/shelter reserve the ladder refuses to spend), a stone kit and
  // bread. The finished block is NOT carried: the ladder smelts and crafts
  // it. Pair with CASTLE_SEED=complete (+ CASTLE_SAND=1 so the pane ladder
  // completes instead of eating the window).
  if (KIT === 'blast') {
    for (const [item, count] of [['raw_iron', 5], ['coal', 16], ['cobblestone', 48],
      ['stone_pickaxe', 1], ['stone_sword', 1], ['bread', 32]]) {
      await rcon(`give ${FOLLOWER} ${item} ${count}`).catch((e) => fail('seed', `${item}: ${e.message}`))
    }
    origLog('CASTLE-RIG kit=blast (5 raw iron, 16 coal, 48 cobble, stone pick+sword, 32 bread)')
  }
  // Woodmix kit (szr1): the prod mixed pack — 1 oak log + 1 oak plank, no
  // table: every wood variant ties uncoverable, so master names the nether
  // tie-break. Pair with CASTLE_REPAIR=planks (chest planks, no logs within
  // reach): the branch withdraws the planks and lays while master loops.
  if (KIT === 'woodmix') {
    for (const [item, count] of [['oak_log', 1], ['oak_planks', 1],
      ['stone_pickaxe', 1], ['stone_sword', 1], ['bread', 32]]) {
      await rcon(`give ${FOLLOWER} ${item} ${count}`).catch((e) => fail('seed', `${item}: ${e.message}`))
    }
    origLog('CASTLE-RIG kit=woodmix (1 oak log + 1 oak plank, stone pick+sword, 32 bread, no table)')
  }
  await sleep(3000) // chunks in, both landed
  // Seeded complete castle (g0z.33): site SW corner so the 31x27 castle
  // centres on the pad, floor on the pad top + 1 (siteEval's median + 1).
  // setblock 8 wide, read back from the guide; misses get one ordered
  // retry, then a setup fail. The castle state lands complete (memory
  // shape), so the live g0z.30 path adopts it: residence -> castle,
  // setHome saves the memory home kind=castle — both checked.
  let seedTag = ''
  if (SEED === 'complete') {
    const st = { site: { x: bx - 15, y: gy + 1, z: bz - 13 }, rot: 0, blueprintVersion: SEED_VERSION }
    const cells = seedCastleCells(st)
    const set = (c) => rcon(`setblock ${c.x} ${c.y} ${c.z} minecraft:${c.block}`).catch((e) => fail('seed-castle', e.message))
    let next = 0
    await Promise.all(Array.from({ length: 8 }, async () => { while (next < cells.length) await set(cells[next++]) }))
    const misses = async () => {
      await sleep(2000) // block updates reach the guide
      return cells.filter((c) => {
        let name = null
        let props = null
        try {
          const b = guide.blockAt(new Vec3(c.x, c.y, c.z))
          name = b && b.name
          props = b && typeof b.getProperties === 'function' ? b.getProperties() : null
        } catch (_) { name = null }
        return !seedMatches(c, name, props)
      })
    }
    let miss = await misses()
    for (const c of miss) await set(c)
    if (miss.length) miss = await misses()
    if (miss.length) fail('seed-castle', `${miss.length} cells wrong after retry: ${miss.slice(0, 5).map((c) => `${c.x} ${c.y} ${c.z} ${c.block}`).join('; ')}`)
    const placed = cells.filter((c) => c.kind !== 'extra' && c.kind !== 'air' && c.kind !== 'dig').length
    seedTag = `, seeded=${placed}/${placed}`
    origLog(`CASTLE-RIG seeded castle site ${st.site.x} ${st.site.y} ${st.site.z} rot 0: ${cells.length} setblocks, ${placed} plan blocks + gate + 2 beds + table read back`)
    if (IDLE_DEATH > 0 || SEED_DECOR_EXCEPT.length > 0) {
      // 6x7.25: decor too (44 panes + 2 gate banners + the g0z.45 upper
      // fence row + the g0z.49 attic nook + the g0z.50 blast furnace), so
      // castlefetch has nothing left to fetch: its sand/wool legs walked
      // 85+ out on both builds and drowned the gather drift this scenario
      // measures. g0z.51: CASTLE_SEED_DECOR_EXCEPT leaves kinds open (the
      // blast acceptance seeds all but the blast, same drowning).
      const decor = require('../src/castle').decorPlan(st.site, 0, st.blueprintVersion).cells
      const kinds = new Set(decor.map((c) => c.kind))
      for (const k of SEED_DECOR_EXCEPT) {
        if (!kinds.has(k)) fail('seed-decor', `unknown decor kind ${k} (have ${[...kinds].sort().join(',')})`)
      }
      let seeded = 0
      for (const c of decor) {
        if (SEED_DECOR_EXCEPT.includes(c.kind)) continue
        let block = 'glass_pane'
        if (c.kind === 'banner') {
          const f = c.wall.z > c.z ? 'north' : c.wall.z < c.z ? 'south' : c.wall.x > c.x ? 'west' : 'east'
          block = `white_wall_banner[facing=${f}]`
        } else if (c.kind === 'fence') {
          block = 'oak_fence'
        } else if (c.kind === 'bookshelf') {
          block = 'bookshelf'
        } else if (c.kind === 'enchanting_table') {
          block = 'enchanting_table'
        } else if (c.kind === 'blast_furnace') {
          block = 'blast_furnace'
        } else if (c.kind === 'gate') {
          // g0z.46: seeded SHUT, so the night acceptance proves the opener.
          block = `oak_fence_gate[facing=${require('../src/castle').faceName(c.face)},open=false]`
        }
        await rcon(`setblock ${c.x} ${c.y} ${c.z} minecraft:${block}`).catch((e) => fail('seed-decor', e.message))
        seeded++
      }
      origLog(`CASTLE-RIG seeded decor: ${seeded}/${decor.length} cells (panes + banners + upper fence + attic + blast + gate${SEED_DECOR_EXCEPT.length > 0 ? ` except ${SEED_DECOR_EXCEPT.join(',')}` : ''})`)
    }
    if (!tickCtx()) fail('seed-castle', 'no follower ctx')
    if (PEER_FILE) {
      // g0z.59: the castle only in a peer's memory file — never ctx.castle.
      const peer = `CastlePeer${(process.env.CASTLE_RIG_ID || '0').replace(/[^a-z0-9]/g, '')}`
      const peerFile = path.join(path.dirname(process.env.BOT_MEMORY_FILE), `${peer}.json`)
      const world = require('../src/memory').worldKey(follower)
      if (!world) fail('seed-castle', 'no world key for the peer file')
      const peerDoc = (w) => JSON.stringify({ v: 1, world: w, castle: { ...st, phase: 'complete', blocked: {}, parked: false } })
      fs.writeFileSync(peerFile, peerDoc(world))
      // g0z.63: --night prod moves the world spawn after this seed, which
      // re-keys the bot's world (memory.worldKey) and would read the peer
      // as another world. Prod's spawn is fixed: follow the key here.
      let peerWorld = world
      setInterval(() => {
        try {
          const w = require('../src/memory').worldKey(follower)
          if (w && w !== peerWorld) { fs.writeFileSync(peerFile, peerDoc(w)); peerWorld = w; origLog(`CASTLE-RIG peer castle re-keyed: ${w}`) }
        } catch (_) { /* re-key best-effort */ }
      }, 5000).unref()
      if (NIGHT_HOME === 'apron') {
        // Which step placed each own block (the apron-litter diagnosis).
        const seenK = new Set()
        setInterval(() => {
          try {
            const c = tickCtx()
            if (!c || !(c.placedByBot instanceof Set)) return
            for (const k of c.placedByBot) {
              if (seenK.has(k)) continue
              seenK.add(k)
              const [x, y, z] = k.split(',').map(Number)
              const inA = require('../src/castle').apronOf(st, { x, y, z })
              origLog(`CASTLE-RIG placed ${k} ${(c.placedNames instanceof Map && c.placedNames.get(k)) || '?'} step=${c.step} rec=${c.recovery ? c.recovery.action : '-'} apron=${inA ? 'in' : 'out'} known=${Array.isArray(c.knownCastles) ? c.knownCastles.length : 0}`)
            }
          } catch (_) { /* diag best-effort */ }
        }, 250).unref()
      }
      if (NIGHT_HOME === 'peer') process.env.BOT_CASTLE_PEER = peer
      else delete process.env.BOT_CASTLE_PEER
      origLog(`CASTLE-RIG peer castle: ${peerFile} (BOT_CASTLE_PEER=${process.env.BOT_CASTLE_PEER || ''}), the bot keeps no castle`)
    } else {
      tickCtx().castle = { ...st, phase: 'complete', blocked: {}, parked: false }
    }
  }
  if (tickCtx()) tickCtx().paused = false
  if (SEED === 'complete' && PEER_FILE) {
    // Settles past one refresh window (memory.SAVE_MIN_MS) so the first
    // dusk already reads it.
    let seen = false
    for (let i = 0; i < 120 && !seen; i++) {
      const c = tickCtx()
      seen = !!(c && (NIGHT_HOME === 'peer' ? c.peerCastle : Array.isArray(c.knownCastles) && c.knownCastles.length))
      if (!seen) await sleep(500)
    }
    if (!seen) fail('seed-castle', 'the bot never read the peer castle')
    if (tickCtx().castle) fail('seed-castle', 'the peer castle became the bot\'s own')
  } else if (SEED === 'complete') {
    let adopted = false
    for (let i = 0; i < 60 && !adopted; i++) {
      const h = tickCtx() && tickCtx().home
      adopted = !!h && h.kind === 'castle'
      if (!adopted) await sleep(500)
    }
    if (!adopted) fail('seed-castle', 'the bot never adopted the castle as its residence')
    let memHome = null
    try {
      const doc = JSON.parse(fs.readFileSync(process.env.BOT_MEMORY_FILE, 'utf8'))
      memHome = doc.homes[doc.homes.length - 1]
    } catch (e) { fail('seed-castle', `memory file unreadable: ${e.message}`) }
    if (!memHome || memHome.kind !== 'castle') fail('seed-castle', `memory home is not kind=castle: ${JSON.stringify(memHome).slice(0, 160)}`)
    origLog('CASTLE-RIG residence: castle adopted, memory home kind=castle')
  }
  let knocked = []
  if (REPAIR) {
    const st = tickCtx().castle
    knocked = REPAIR === 'prkh' ? prkhCells(st) : repairCells(st)
    tickCtx().paused = true // no relay before the readback (the nowood fills take seconds)
    const door = knocked.find((c) => c.kind === 'door')
    // Upper door half first: no dropped door item to hand the bot.
    if (door) await rcon(`setblock ${door.x} ${door.y + 1} ${door.z} minecraft:air`).catch((e) => fail('repair-seed', e.message))
    for (const c of knocked) await rcon(`setblock ${c.x} ${c.y} ${c.z} minecraft:air`).catch((e) => fail('repair-seed', e.message))
    await rcon(`kill @e[type=minecraft:item,x=${st.site.x + 15},y=${st.site.y},z=${st.site.z + 13},distance=..40]`).catch(() => {})
    const chest = require('../src/castle').absPlan(st.site, st.rot, st.blueprintVersion).cells.find((c) => c.kind === 'chest')
    if (REPAIR === 'wood') {
      await rcon(`item replace block ${chest.x} ${chest.y} ${chest.z} container.0 with minecraft:oak_log 16`).catch((e) => fail('repair-seed', e.message))
    } else {
      // No wood within reach (nowood, and planks below): every log in a
      // NOWOOD_RADIUS square, one y layer per fill (the 32768-block cap).
      const cx = st.site.x + 15
      const cz = st.site.z + 13
      for (let y = gy - 12; y <= gy + 30; y++) {
        await rcon(`fill ${cx - NOWOOD_RADIUS} ${y} ${cz - NOWOOD_RADIUS} ${cx + NOWOOD_RADIUS} ${y} ${cz + NOWOOD_RADIUS} minecraft:air replace #minecraft:logs`).catch((e) => fail('repair-seed', e.message))
      }
      // The fill took the castle's own Fachwerk beams too: lay them back.
      for (const c of seedCastleCells(st)) {
        if (c.kind === 'frame') await rcon(`setblock ${c.x} ${c.y} ${c.z} minecraft:${c.block}`).catch((e) => fail('repair-seed', e.message))
      }
      if (REPAIR === 'planks' || REPAIR === 'prkh') {
        await rcon(`item replace block ${chest.x} ${chest.y} ${chest.z} container.0 with minecraft:oak_planks 48`).catch((e) => fail('repair-seed', e.message))
      }
    }
    await sleep(2000)
    const miss = knocked.filter((c) => {
      try { const b = guide.blockAt(new Vec3(c.x, c.y, c.z)); return !b || b.name !== 'air' } catch (_) { return true }
    })
    if (miss.length) fail('repair-seed', `${miss.length} knocked cells not air`)
    tickCtx().paused = false
    // idkcraft-akze: the knockdown is rig action, not bot damage — reset the
    // bot's regress high-water so the first post-seed scan baselines instead
    // of logging the seed as regress. Deterministic (not wall-clock): the
    // away-gap re-baseline in progress() stays as the backstop. Dig cells
    // re-register on scan (still air), so clearing idx is safe.
    try {
      const c = tickCtx()
      if (c) {
        const sig = c.castleDug && c.castleDug.sig
        c.castleDug = { sig, idx: new Set(), high: 0, was: new Set(), lastScan: Date.now() }
      }
    } catch (_) { /* baseline best-effort: the away gap covers it */ }
    origLog(`CASTLE-RIG repair seed: ${knocked.length} cells knocked out (${knocked.map((c) => c.kind).join(',')}), chest ${REPAIR === 'wood' ? '16 oak_log' : REPAIR === 'planks' || REPAIR === 'prkh' ? `48 oak_planks, logs cleared within ${NOWOOD_RADIUS}` : `empty, logs cleared within ${NOWOOD_RADIUS}`}`)
  }
  // Dead quarry (idkcraft-prkh): water-fill the probe column of every
  // trench side and pit spot below the surface, so every probe dies wet.
  if (QUARRY === 'dead') {
    const st = tickCtx().castle
    if (!st || !st.site) fail('quarry', 'no castle site')
    const fills = quarryDeadFills(st)
    tickCtx().paused = true
    for (const cmd of fills) {
      await rcon(cmd).catch((e) => fail('quarry', e.message))
    }
    // No exposed stone in the pick window (site.y-2..+3, ±32): stone family
    // to dirt outside the footprint, so neither the pick nor the v2 mine
    // finds any. Four boxes around the footprint (never the castle itself).
    const bp = require('../src/castle')
    const fam = Array.isArray(bp.STONE_ITEMS) && bp.STONE_ITEMS.length > 0 ? bp.STONE_ITEMS : ['stone', 'cobblestone']
    const { w, d } = bp.siteDimensions(st.rot | 0, st.blueprintVersion)
    const m = 2
    const boxes = [
      [st.site.x - 32, st.site.z - 32, st.site.x + w + 31, st.site.z - m - 1],
      [st.site.x - 32, st.site.z + d + m, st.site.x + w + 31, st.site.z + 32],
      [st.site.x - 32, st.site.z - m - 1, st.site.x - m - 1, st.site.z + d + m],
      [st.site.x + w + m, st.site.z - m - 1, st.site.x + w + 31, st.site.z + d + m],
    ]
    for (const [x0, z0, x1, z1] of boxes) {
      for (const name of fam) {
        await rcon(`fill ${x0} ${st.site.y - 2} ${z0} ${x1} ${st.site.y + 3} ${z1} minecraft:dirt replace minecraft:${name}`).catch((e) => fail('quarry', e.message))
      }
    }
    await sleep(2000)
    tickCtx().paused = false
    origLog(`CASTLE-RIG quarry dead: ${fills.length} probe columns water-filled, exposed stone swept in +-32 (footprint kept)`)
  }
  let litterSeed = null
  if (LITTER) {
    litterSeed = litterSeeds(tickCtx().castle)
    tickCtx().paused = true // no sweep before the readback
    for (const c of litterSeed.prep) await rcon(c).catch((e) => fail('litter-seed', e.message))
    const all = [...litterSeed.litter, ...litterSeed.player].flatMap((o) => o.cells)
    for (const c of all) await rcon(`setblock ${c.x} ${c.y} ${c.z} minecraft:${c.block}`).catch((e) => fail('litter-seed', e.message))
    await sleep(2000)
    const miss = all.filter((c) => {
      try { const b = guide.blockAt(new Vec3(c.x, c.y, c.z)); return !b || b.name !== c.block.split('[')[0] } catch (_) { return true }
    })
    if (miss.length) fail('litter-seed', `${miss.length} seeded cells wrong: ${miss.slice(0, 5).map((c) => `${c.x} ${c.y} ${c.z} ${c.block}`).join('; ')}`)
    tickCtx().paused = false
    const n = (what) => litterSeed.litter.filter((o) => o.what === what).length
    origLog(`CASTLE-RIG litter seed: ${litterSeed.litter.length} items (${litterSeed.litter.flatMap((o) => o.cells).length} cells: tower+yard ${n('tower') + n('yard')}, bridge ${n('bridge')}, outside ${n('outside')}), player ${litterSeed.player.map((o) => o.what).join(',')}`)
  }
  let start = null
  if (START) {
    start = startPlan({ x: bx - 15, y: gy + 1, z: bz - 13 }, START, START_CELL)
    tickCtx().paused = true
    await rcon(start.cmd).catch((e) => fail('start', e.message))
    await rcon(`tp ${FOLLOWER} ${start.x + 0.5} ${start.y} ${start.z + 0.5}`).catch((e) => fail('start', e.message))
    if (start.cell) {
      // Mark own only after the fill's block updates reached the bot:
      // trackPlaced drops a key whose cell changes kind (that ate the marks).
      await sleep(3000)
      const c = tickCtx()
      if (!(c.placedByBot instanceof Set)) c.placedByBot = new Set()
      if (!(c.placedNames instanceof Map)) c.placedNames = new Map()
      const unread = start.shell.filter((b) => {
        try { const blk = follower.blockAt(new Vec3(b.x, b.y, b.z)); return !blk || blk.name !== b.name } catch (_) { return true }
      })
      if (unread.length) fail('start', `${unread.length} shell cells not ${start.shell[0].name} on the bot`)
      for (const b of start.shell) {
        c.placedByBot.add(`${b.x},${b.y},${b.z}`)
        c.placedNames.set(`${b.x},${b.y},${b.z}`, b.name)
      }
      await rcon(`give ${FOLLOWER} stone_pickaxe 1`).catch((e) => fail('start', e.message))
    }
    tickCtx().paused = false
    origLog(`CASTLE-RIG start ${start.x} ${start.y} ${start.z} (site +${start.d.join(',')})${start.cell ? `, sealed in ${start.cell}` : ', bare pocket'}`)
  }
  if (START_HOUSE) {
    const site = { x: start.x + 2, y: start.y, z: start.z + 2 }
    tickCtx().paused = true
    try {
      await require('./raise-house').raiseHouse(rcon, site)
      for (const c of rigHouseCommands(site, 'clean')) await rcon(c)
    } catch (e) { fail('start-house', e.message) }
    await rcon(`tp ${FOLLOWER} ${site.x + 3.5} ${site.y} ${site.z - 1.5}`).catch((e) => fail('start-house', e.message))
    tickCtx().home = {
      site: { ...site }, built: true, v: 2,
      interior: { min: { x: site.x + 1, y: site.y, z: site.z + 1 }, max: { x: site.x + 5, y: site.y + 1, z: site.z + 4 } },
      door: { x: site.x + 3, y: site.y, z: site.z },
      // The raised table's claim, as build.js sets it on a finished prod
      // house: without it furnace.js finds no table to craft the home
      // furnace and the tidy torch fetch fails smelt-no-table (rig only).
      table: new Vec3(site.x + 5, site.y, site.z + 1),
    }
    tickCtx().paused = false
    origLog(`CASTLE-RIG start house: built house ${site.x} ${site.y} ${site.z} is the home (tidy ${process.env.CASTLE_TIDY_MS || 'default'} ms)`)
  }
  let apronSnap = null
  if (APRON_DIFF) {
    apronSnap = { site: { x: bx - 15, y: gy + 1, z: bz - 13 }, rot: 0, blueprintVersion: SEED_VERSION }
    for (const c of apronCloneCmds(apronBox(apronSnap))) {
      const out = await rcon(c).catch((e) => fail('apron-diff', e.message))
      if (!/Successfully cloned/.test(out)) fail('apron-diff', `${c}: ${String(out).trim().slice(0, 120)}`)
    }
    origLog(`CASTLE-RIG apron snapshot: ${JSON.stringify(apronBox(apronSnap))} -> y ${APRON_COPY_Y}`)
  }
  if (NIGHT_HOME) {
    // g0z.59: an unbuilt house order on the pad corner, parked so the day
    // never builds it (the night is what this measures).
    const site = new Vec3(bx + 17, gy + 1, bz + 17)
    tickCtx().home = { site, interior: null, door: null, table: null, built: false, v: 2, parked: true }
    origLog(`CASTLE-RIG night home=${NIGHT_HOME}: unbuilt house site ${site.x} ${site.y} ${site.z}`)
  }
  if (HOUSE) {
    // neuc.65.2: a built rig house on the pad's SE quarter is the home (the
    // stuck-replay night-spot shape), the follower re-seated after the fill.
    const site = { x: bx + 8, y: gy + 1, z: bz + 8 }
    tickCtx().paused = true // no tick picks a home site mid-raise
    try {
      await require('./raise-house').raiseHouse(rcon, site)
      for (const c of rigHouseCommands(site, HOUSE)) await rcon(c)
    } catch (e) { fail('house', e.message) }
    await rcon(`tp ${FOLLOWER} ${bx + 2.5} ${gy + 1} ${standZ + 0.5}`).catch((e) => fail('house', e.message))
    tickCtx().home = {
      site: { ...site }, built: true, v: 2,
      interior: { min: { x: site.x + 1, y: site.y, z: site.z + 1 }, max: { x: site.x + 5, y: site.y + 1, z: site.z + 4 } },
      door: { x: site.x + 3, y: site.y, z: site.z },
    }
    if (bumpDoor) { bumpDoor.x = site.x + 3.5; bumpDoor.z = site.z + 0.5 }
    tickCtx().paused = false
    origLog(`CASTLE-RIG house=${HOUSE}: built house ${site.x} ${site.y} ${site.z}, door ${site.x + 3} ${site.y} ${site.z}${HOUSE === 'bump' ? ', bedrock behind the door' : HOUSE === 'pit' ? ', 6-deep doorstep pit' : HOUSE === 'gallery' ? ', 1-block crust over a 6-deep void, doorstep + table-side floor gone, west ramp' : ''}`)
  }
  if (NIGHT_PROD) {
    const sp = prodSpawnPoint({ x: bx, z: bz }, worldSpawn)
    let out = ''
    try { out = String(await rcon(`execute positioned ${sp.x} 0 ${sp.z} positioned over world_surface run setworldspawn ~ ~ ~`)) } catch (e) { fail('world-spawn', e.message) }
    const y = /(-?\d+), (-?\d+), (-?\d+)/.exec(out)
    if (!y || +y[2] < 40) fail('world-spawn', `setworldspawn ${sp.x} ${sp.z}: ${out.trim().split('\n')[0] || 'no reply'}`)
    origLog(`CASTLE-RIG night prod: world spawn ${y[1]} ${y[2]} ${y[3]} (${PROD_SPAWN_DIST} from the pad toward ${worldSpawn ? `${worldSpawn.x} ${worldSpawn.z}` : '?'}), easy + fall damage from window open`)
  }

  // The order needs the speaker's entity loaded on the follower, else the
  // bot answers "I can't see you" and nothing starts. A seeded castle
  // needs no order (autonomous rides runOnce) — except an older seed,
  // which the guide relays with `castle upgrade` (g0z.48).
  let ordered = BARE ? 'bare (autonomous on, no castle)' : SEED && !SEED_UPGRADE ? 'seeded' : null
  let sees = !!SEED
  for (let i = 0; i < 40 && !sees; i++) {
    try { sees = !!(follower.players && follower.players[GUIDE] && follower.players[GUIDE].entity) } catch (_) { sees = false }
    if (!sees) await sleep(500)
  }
  if (!sees) fail('order', `follower never saw ${GUIDE}`)
  if (!SEED) {
    try { guide.chat('autonomous on') } catch (e) { fail('order', `autonomous chat: ${e.message}`) }
    await sleep(1000)
    if (!BARE) try { guide.chat('build castle') } catch (e) { fail('order', `castle chat: ${e.message}`) }
  } else if (SEED_UPGRADE) {
    try { guide.chat('castle upgrade') } catch (e) { fail('order', `upgrade chat: ${e.message}`) }
  } else if (REPAIR) {
    const from = chats.length
    try { guide.chat('castle repair') } catch (e) { fail('order', `repair chat: ${e.message}`) }
    let reply = null
    for (let i = 0; i < 40 && !reply; i++) {
      reply = chats.slice(from).find((l) => /^castle(:| at )/.test(l)) || null
      if (!reply) await sleep(500)
    }
    if (!reply) fail('order', 'no castle repair reply in 20 s')
    origLog(`CASTLE-RIG repair reply: ${reply.slice(0, 200)}`)
  }
  // Order ack: the direct site ('castle at …, ~1722 blocks') or the search
  // ('found a castle spot …', which carries the same startCastle tail), or
  // the upgrade relay ('upgrading the castle …'). The asker leaving
  // cancels the search, so the guide stays till the ack.
  const tOrder = Date.now()
  let scanned = 0
  while (Date.now() - tOrder < 300000) {
    for (; scanned < chats.length; scanned++) {
      const line = chats[scanned]
      if (/found a castle spot |castle at -?\d+ -?\d+ -?\d+, ~\d+ blocks|upgrading the castle to stair blocks/.test(line)) { ordered = line; break }
      if (/I found no castle spot|I can't see you/.test(line)) fail('order', line.slice(0, 160))
    }
    if (ordered) break
    await sleep(500)
  }
  if (!ordered) fail('order', 'no castle ack in 300 s')
  origLog(`CASTLE-RIG ordered: ${ordered.slice(0, 160)}`)
  // Blocked seeds (vmzq.27): set after the ack (the site only exists now),
  // before the guide quits — its presence loads the site chunks, and the
  // readback below fails the run instead of measuring an unseeded castle.
  let blockedSeeds = []
  if (BLOCKED > 0 && !SEED) {
    const st = follower._tickerCtx && follower._tickerCtx.castle
    if (!st || !st.site || typeof st.site.x !== 'number') fail('seed-blocked', 'no castle site after order')
    blockedSeeds = pickBlockedSeeds(st.site, st.rot, st.blueprintVersion, BLOCKED)
    if (blockedSeeds.length < BLOCKED) fail('seed-blocked', `only ${blockedSeeds.length} seed cells for ${BLOCKED}`)
    await rcon(`tp ${GUIDE} ${st.site.x + 15.5} ${st.site.y + 10} ${st.site.z + 13.5}`).catch((e) => fail('seed-blocked', e.message))
    await sleep(3000)
    for (const s of blockedSeeds) {
      await rcon(`setblock ${s.x} ${s.y} ${s.z} minecraft:${s.block}${SEED_NBT[s.block] || ''}`).catch((e) => fail('seed-blocked', `${s.x} ${s.y} ${s.z}: ${e.message}`))
    }
    await sleep(1000)
    for (const s of blockedSeeds) {
      let name = null
      try { const b = guide.blockAt(new Vec3(s.x, s.y, s.z)); name = b && b.name } catch (_) { name = null }
      if (name !== s.block) fail('seed-blocked', `readback ${s.x} ${s.y} ${s.z}: want ${s.block}, got ${name}`)
    }
    origLog(`CASTLE-RIG blocked: ${blockedSeeds.map((s) => `${s.x} ${s.y} ${s.z} ${s.kind} ${s.block}`).join('; ')}`)
  }
  try { guide.quit('ordered') } catch (_) { /* quit best-effort */ }

  // Window: sample progress/step/pos every 15 s; a short sample line every
  // 5 min keeps long runs visibly alive without burying the verdict.
  const series = []
  let repairT = null
  let litterT = null
  let nowoodT = null
  const t0 = Date.now()
  const endAt = t0 + MINS * 60000 / SPEED
  const gt0 = await gameTime()
  let lastSampleLine = 0
  const sample = () => {
    const s = { t: Math.round((Date.now() - t0) / 1000) }
    try {
      const c = follower._tickerCtx
      const st = c && c.castle
      s.done = st && st.progress && typeof st.progress.done === 'number' ? st.progress.done : null
      s.total = st && st.progress && typeof st.progress.total === 'number' ? st.progress.total : null
      s.phase = st && st.phase
      s.step = c && c.step
      s.status = c && c.stepStatus
    } catch (_) { /* sample best-effort */ }
    try {
      const p = follower.entity.position
      s.x = Math.round(p.x); s.y = Math.round(p.y); s.z = Math.round(p.z)
    } catch (_) { /* pos best-effort */ }
    try {
      s.hunger = (follower && typeof follower.food === 'number') ? follower.food : null
    } catch (_) { /* hunger best-effort */ }
    try {
      // vmzq.45: server daytime (re-anchored + counted) vs the bot's own
      // clock as the brain reads it. srv=null means the resync never
      // anchored (pre-26.1 shape or unknown dimension). A breach is loud:
      // the correction stopped landing (revmux 01 major).
      s.srv = timeResync.daytime()
      s.bt = (follower && follower.time && typeof follower.time.timeOfDay === 'number') ? follower.time.timeOfDay : null
      const drift = timeDrift(s.srv, s.bt)
      if (drift != null) {
        if (drift > seen.timeMaxDrift) seen.timeMaxDrift = drift
        if (drift > RESYNC_DRIFT_TICKS) origErr(`CASTLE-RIG time-drift: srv=${s.srv} bt=${s.bt} (+${s.t}s)`)
      }
    } catch (_) { /* time best-effort */ }
    try {
      let cobble = 0; let dirt = 0; let logs = 0; let planks = 0; let sticks = 0
      let edibles = 0
      let pick = 'none'
      for (const it of (follower.inventory && follower.inventory.items()) || []) {
        if (!it || typeof it.name !== 'string') continue
        const n = typeof it.count === 'number' ? it.count : 1
        if (SAMPLE_EDIBLES.has(it.name)) edibles += n
        if (it.name === 'cobblestone') cobble += n
        else if (it.name === 'dirt') dirt += n
        else if (/_log$/.test(it.name)) logs += n
        else if (/_planks$/.test(it.name)) planks += n
        else if (it.name === 'stick') sticks += n
        else if (/_pickaxe$/.test(it.name)) {
          if (it.name === 'stone_pickaxe') pick = 'stone'
          else if (pick === 'none' && it.name === 'wooden_pickaxe') pick = 'wood'
        }
      }
      // neuc.60: every castle stone kind (the mine-rate component).
      const { isStone } = require('../src/castle')
      s.stone = 0
      for (const it of (follower.inventory && follower.inventory.items()) || []) {
        if (it && isStone(it.name)) s.stone += typeof it.count === 'number' ? it.count : 1
      }
      s.cobble = cobble; s.dirt = dirt; s.logs = logs; s.planks = planks; s.sticks = sticks; s.pick = pick; s.edibles = edibles
    } catch (_) { /* inventory best-effort */ }
    try {
      // Ground-drop census (vmzq.20): non-player entities near the bot.
      // In a peaceful rig these are item drops — a direct read on whether
      // dug blocks bank or litter the trench (cycle 12: ~2/3 never banked).
      let drops = 0
      const bp = follower.entity && follower.entity.position
      const ents = (follower.entities && typeof follower.entities === 'object') ? Object.values(follower.entities) : []
      for (const e of ents) {
        if (!e || e.type === 'player' || e.username) continue
        if (!bp || !e.position) continue
        if (Math.hypot(e.position.x - bp.x, e.position.y - bp.y, e.position.z - bp.z) <= 12) drops++
      }
      s.drops = drops
    } catch (_) { /* drops best-effort */ }
    try {
      const c = follower._tickerCtx
      const f = c && c.castleFetch
      if (f) s.fetch = { kind: f.kind, quarry: !!(f.target && f.target.quarry), skips: f.skips || 0, dead: (f.quarry && f.quarry.dead) || [] }
      const sf = c && c.stepFail && c.stepFail.castlefetch
      if (sf && typeof sf.status === 'string') s.castleFail = { status: sf.status, kind: typeof sf.kind === 'string' ? sf.kind : null }
      if (c && c.castleWord && typeof c.castleWord.kind === 'string') s.cword = c.castleWord.kind
    } catch (_) { /* fetch best-effort */ }
    if (knocked.length) {
      // g0z.56: knocked cells laid back (read on the follower), the first
      // full relay, the first 'no wood' status.
      let n = 0
      for (const c of knocked) {
        try { const b = follower.blockAt(new Vec3(c.x, c.y, c.z)); if (b && require('../src/castle').matches(c.kind, b.name)) n++ } catch (_) { /* unread */ }
      }
      s.relaid = n
      if (n === knocked.length && repairT == null) repairT = s.t
      const st = follower._tickerCtx && follower._tickerCtx.castle
      if (nowoodT == null && st && typeof st.status === 'string' && st.status.startsWith('no wood')) nowoodT = s.t
    }
    if (litterSeed) {
      // g0z.61: litter items swept (every cell air, read on the follower).
      const air = (c) => { try { const b = follower.blockAt(new Vec3(c.x, c.y, c.z)); return !!b && b.name === 'air' } catch (_) { return false } }
      s.litter = litterSeed.litter.filter((o) => o.cells.every(air)).length
      if (s.litter >= LITTER_PASS && litterT == null) litterT = s.t
    }
    series.push(s)
    return s
  }
  const checkpoint = () => {
    const last = series[series.length - 1] || {}
    try {
      fs.writeFileSync(OUT, JSON.stringify({
        date: new Date().toISOString(), mins: MINS,
        done: typeof last.done === 'number' ? last.done : 0,
        total: typeof last.total === 'number' ? last.total : 0,
        flips: seen.flips, deaths, steps: seen.steps, fails: seen.fails,
        partial: Date.now() < endAt,
        tag: TAG, gitsha: process.env.CASTLE_GITSHA || '?', log: LOGFILE,
        kit: KIT, tickrate: TICKRATE, planner: PLANNER, said: seen.said,
        wdCalls: seen.wdCalls, wdChoices: seen.wdChoices, outcomes: seen.outcomes, series,
        timeEvents: seen.timeEvents, timeMaxDrift: seen.timeMaxDrift,
        nights: night ? night.nights : undefined,
      }))
    } catch (_) { /* checkpoint best-effort */ }
  }
  sample()
  checkpoint()
  // Holes report (vmzq.27): the follower's own `castle: ` chats (the ack
  // has no colon, so the prefix skips it) land in the log + OUT record.
  let scannedSay = chats.length
  const drainSaid = () => {
    for (; scannedSay < chats.length; scannedSay++) {
      const msg = chats[scannedSay]
      if (typeof msg === 'string' && msg.startsWith('castle: ')) {
        seen.said.push(msg.slice(0, 300))
        origLog(`CASTLE-RIG say: ${msg.slice(0, 300)}`)
      }
    }
  }
  origLog(`CASTLE-RIG window: ${MINS} ${SPEED !== 1 ? `game min (tick rate ${TICKRATE}, ${(MINS / SPEED).toFixed(1)} wall min)` : 'min'}, ends ${new Date(endAt).toISOString()}`)
  if (night) await night.open()
  winT0 = t0
  let dropTimer = null
  if (HOUSE) {
    const h = tickCtx().home && tickCtx().home.site
    const track = createDropTrack((p) => !!h && Math.abs(p.x - h.x - 3.5) <= 16 && Math.abs(p.z - h.z) <= 16)
    dropTimer = setInterval(() => {
      try {
        const e = follower.entity
        if (track.onSample(e && e.position, e && e.onGround)) {
          seen.drops++
          origLog(`CASTLE-RIG drop ${seen.drops} at ${(Date.now() - t0) / 1000 | 0}s pos ${e.position.x.toFixed(1)} ${e.position.y.toFixed(1)} ${e.position.z.toFixed(1)} step=${seen.step || '?'}`)
        }
      } catch (_) { /* drops best-effort */ }
    }, 250)
    // idkcraft-z591: the house door and its sill (the block it hangs on).
    // A door that turns into a non-door counts once as door-lost; every
    // sill change logs with the body pos + step (the support-break trace).
    if (h && typeof follower.on === 'function') {
      const door = `${h.x + 3},${h.y},${h.z}`
      const sill = `${h.x + 3},${h.y - 1},${h.z}`
      follower.on('blockUpdate', (oldB, newB) => {
        try {
          const q = (newB && newB.position) || (oldB && oldB.position)
          if (!q) return
          const k = `${q.x},${q.y},${q.z}`
          if (k !== door && k !== sill) return
          const o = (oldB && oldB.name) || '?'
          const n = (newB && newB.name) || '?'
          if (o === n) return
          const e = follower.entity
          const at = `at ${(Date.now() - t0) / 1000 | 0}s pos ${e ? `${e.position.x.toFixed(2)} ${e.position.y.toFixed(2)} ${e.position.z.toFixed(2)}` : '?'} step=${seen.step || '?'}`
          if (k === sill) origLog(`CASTLE-RIG sill ${o}->${n} ${at}`)
          else if (o.endsWith('_door') && !n.endsWith('_door')) origLog(`CASTLE-RIG door-lost ${++seen.doorLost} ${o}->${n} ${at}`)
        } catch (_) { /* trace best-effort */ }
      })
    }
  }
  let resTimer = null
  let startEscS = null // g0z.58: first second out of the start pocket
  let startHomeS = null // g0z.58: first second inside the castle interior
  const idle = IDLE ? createIdleTrack(tickCtx().home) : null
  if (resNights) {
    resNights.open()
    const resSample = () => {
      let inside = false
      try {
        // g0z.59: the night home (the castle covering an unbuilt house).
        const h = follower._tickerCtx && require('../src/residence').nightHome(follower._tickerCtx, follower.entity.position)
        inside = !!h && h.kind === 'castle' && require('../src/residence').of(h).interior(h, follower.entity.position)
      } catch (_) { inside = false }
      const tS = Math.round((Date.now() - t0) / 1000)
      resNights.onSample(tS, inside, !!follower.isSleeping)
      if (start) {
        try { if (startEscS == null && start.out(follower.entity.position)) startEscS = tS } catch (_) { /* start best-effort */ }
        if (startHomeS == null && inside) startHomeS = tS
      }
      if (idle) { try { idle.onSample((Date.now() - t0) / 1000, follower.entity.position) } catch (_) { /* idle best-effort */ } }
    }
    resTimer = setInterval(resSample, 1000)
    follower.on('sleep', resSample)
  }
  let farAt = 0
  let farPre = null
  let buryAt = 0
  let buryPre = null
  let surfacedS = null
  let resumedS = null
  let pitAt = 0
  let pitPre = null
  let pitRim = null
  let pitCX = null
  let pitCZ = null
  let escapedS = null
  let pitResumedS = null
  let pitEsc = null
  let idleDeathAt = 0
  let idleForced = 0
  let idlePosAt = 0
  let reknockAt = 0 // idkcraft-prkh: the mid-run stone knock-out second
  while (Date.now() < endAt) {
    await sleep(15000)
    // Stone re-knock (idkcraft-prkh): once a torch fetch has failed into
    // its hold (the fence already relayed from the chest), knock out the
    // REKNOCK plan kinds — the word jumps back to stone while the torch
    // hold still stands.
    if (REKNOCK.length && !reknockAt) {
      let torchHeld = false
      try {
        const sf = follower._tickerCtx && follower._tickerCtx.stepFail && follower._tickerCtx.stepFail.castlefetch
        torchHeld = !!sf && typeof sf.status === 'string' && sf.status === 'failed:castlefetch-no-torch'
      } catch (_) { torchHeld = false }
      if (torchHeld) {
        const st = follower._tickerCtx && follower._tickerCtx.castle
        if (!st || !st.site) fail('reknock', 'no castle site')
        const cells = require('../src/castle').absPlan(st.site, st.rot, st.blueprintVersion).cells
        const targets = []
        for (const kind of REKNOCK) for (const c of cells.filter((c) => c.kind === kind).slice(0, 4)) targets.push(c)
        if (!targets.length) fail('reknock', `no ${REKNOCK.join(',')} cells on the plan`)
        tickCtx().paused = true
        for (const c of targets) await rcon(`setblock ${c.x} ${c.y} ${c.z} minecraft:air`).catch((e) => fail('reknock', e.message))
        await rcon(`kill @e[type=minecraft:item,x=${st.site.x + 15},y=${st.site.y},z=${st.site.z + 13},distance=..40]`).catch(() => {})
        await sleep(2000)
        try {
          const c = tickCtx()
          if (c) {
            const sig = c.castleDug && c.castleDug.sig
            c.castleDug = { sig, idx: new Set(), high: 0, was: new Set(), lastScan: Date.now() }
          }
        } catch (_) { /* baseline best-effort: the away gap covers it */ }
        tickCtx().paused = false
        for (const c of targets) knocked.push(c)
        reknockAt = Date.now()
        origLog(`CASTLE-RIG reknock: at ${(reknockAt - t0) / 1000 | 0}s ${targets.length} cells knocked out (${targets.map((c) => c.kind).join(',')}), knocked now ${knocked.length}`)
      }
    }
    if (IDLE_DEATH > 0 && !idleDeathAt && Date.now() - t0 >= IDLE_DEATH * 60000) {
      idleDeathAt = Date.now()
      if (!worldSpawn) fail('idle-death', 'world spawn never read')
      const rp = idleRespawnPoint(tickCtx().home.site, worldSpawn)
      // keep_inventory is on: clear first, so the respawn kit is empty. The
      // spawnpoint overrides a castle bed the bot may have slept in.
      await rcon(`clear ${FOLLOWER}`).catch((e) => fail('idle-death', e.message))
      await rcon(`spawnpoint ${FOLLOWER} ${rp.x} ${rp.y} ${rp.z}`).catch((e) => fail('idle-death', e.message))
      const d0 = deaths
      if (idle) idle.pause()
      await rcon(`kill ${FOLLOWER}`).catch((e) => fail('idle-death', e.message))
      for (let i = 0; i < 20 && deaths === d0; i++) await sleep(500)
      if (deaths === d0) fail('idle-death', 'kill never reached the follower')
      idleForced = deaths - d0
      const atRp = () => { try { const p = follower.entity.position; return Math.hypot(p.x - rp.x - 0.5, p.z - rp.z - 0.5) <= 4 } catch (_) { return false } }
      for (let i = 0; i < 60 && !atRp(); i++) await sleep(500)
      if (!atRp()) fail('idle-death', `never respawned at ${rp.x} ${rp.z}`)
      if (idle) idle.died((idleDeathAt - t0) / 1000)
      origLog(`CASTLE-RIG idle-death: at ${(idleDeathAt - t0) / 1000 | 0}s, cleared + killed, respawn ${rp.x} ${rp.y} ${rp.z} (world spawn ${worldSpawn.x} ${worldSpawn.y} ${worldSpawn.z})`)
    }
    if (idleDeathAt && Date.now() - idlePosAt >= 60000) {
      idlePosAt = Date.now()
      try {
        const p = follower.entity.position
        const h = tickCtx().home.site
        origLog(`CASTLE-RIG idle-pos t=${(Date.now() - t0) / 1000 | 0}s dist=${Math.round(Math.hypot(p.x - h.x, p.z - h.z))} y=${Math.floor(p.y)} step=${seen.step}`)
      } catch (_) { /* diagnostic best-effort */ }
    }
    if (FAR > 0 && !farAt && Date.now() - t0 >= FAR_AFTER * 60000) {
      farAt = Date.now()
      const st = follower._tickerCtx && follower._tickerCtx.castle
      if (!st || !st.site) fail('far', 'no castle site')
      const fx = st.site.x + FAR
      const fz = st.site.z
      await rcon(`tp ${FOLLOWER} ${fx + 0.5} 200 ${fz + 0.5}`).catch((e) => fail('far', e.message))
      let fy = null
      for (let i = 0; i < 40; i++) {
        await sleep(500)
        try { if (follower.entity.onGround) { fy = Math.floor(follower.entity.position.y); break } } catch (_) { /* landing */ }
      }
      if (fy == null) fail('far', 'never landed')
      await rcon(`fill ${fx - 1} ${fy - 7} ${fz - 1} ${fx + 1} ${fy - 1} ${fz + 1} air`).catch((e) => fail('far', e.message))
      await rcon(`clear ${FOLLOWER} minecraft:dirt`).catch((e) => fail('far', e.message))
      await rcon(`give ${FOLLOWER} cobblestone 64`).catch((e) => fail('far', e.message))
      farPre = st.progress && typeof st.progress.done === 'number' ? st.progress.done : null
      origLog(`CASTLE-RIG far: at ${(Date.now() - t0) / 1000 | 0}s ${(st.progress && st.progress.done) ?? '?'}/${(st.progress && st.progress.total) ?? '?'} -> pit ${fx} ${fy - 8} ${fz} (${FAR} off), dirt cleared, +64 cobble`)
    }
    if (BURY > 0 && !buryAt && Date.now() - t0 >= BURY_AFTER * 60000) {
      const st = follower._tickerCtx && follower._tickerCtx.castle
      if (!st || !st.site) fail('bury', 'no castle site')
      const px = st.site.x - 12
      const pz = st.site.z
      const py = gy - BURY
      await rcon(`fill ${px - 2} ${py - 1} ${pz - 2} ${px + 2} ${py + 3} ${pz + 2} minecraft:stone`).catch((e) => fail('bury', e.message))
      await rcon(`fill ${px - 1} ${py} ${pz - 1} ${px + 1} ${py + 1} ${pz + 1} air`).catch((e) => fail('bury', e.message))
      await rcon(`tp ${FOLLOWER} ${px + 0.5} ${py} ${pz + 0.5}`).catch((e) => fail('bury', e.message))
      for (const m of ['wooden', 'stone', 'golden', 'iron', 'diamond', 'netherite']) {
        await rcon(`clear ${FOLLOWER} minecraft:${m}_pickaxe`).catch(() => { /* none held */ })
      }
      if (BURY_NOWOOD) {
        for (const it of ['#minecraft:planks', '#minecraft:logs', 'minecraft:stick', 'minecraft:crafting_table']) {
          await rcon(`clear ${FOLLOWER} ${it}`).catch(() => { /* none held */ })
        }
      }
      await sleep(2000) // the pack read lags the clears
      buryAt = Date.now()
      buryPre = st.progress && typeof st.progress.done === 'number' ? st.progress.done : 0
      const k = sample()
      origLog(`CASTLE-RIG bury: at ${(buryAt - t0) / 1000 | 0}s ${buryPre}/${(st.progress && st.progress.total) ?? '?'} -> pocket ${px} ${py} ${pz} (${BURY} below ${gy}), picks cleared${BURY_NOWOOD ? ' + wood' : ''}, pack cobble=${k.cobble} planks=${k.planks} logs=${k.logs} pick=${k.pick}`)
    }
    if (PIT > 0 && !pitAt && Date.now() - t0 >= PIT_AFTER * 60000) {
      const pst = follower._tickerCtx && follower._tickerCtx.castle
      if (!pst || !pst.site) fail('pit', 'no castle site')
      // Lead-out past the site box (max width 31: inside it the pit stone
      // reads as castle groundCell and every recover dig refuses
      // 'protected' (c31)). The follower itself never tps — burst tp
      // confirms lie (c698/c921 dropped nowhere with 'Teleported'
      // printed). Instead an expendable pit-guide tps near the site
      // (retried to client-verify), chats 'follow me', and walks east;
      // the follower trails it by gameplay. Then the pit is built around
      // the follower and it falls in — physics, client-verified.
      const GUIDE2 = `PitGuide${TAG}`.slice(0, 16)
      let guide2 = null
      try {
        guide2 = mineflayer.createBot({ host: HOST, port: PORT, username: GUIDE2, auth: 'offline' })
        await waitFor(guide2, 'spawn', 60000, 'pit guide2 spawn')
      } catch (e) { fail('pit', `guide2 join: ${e.message}`) }
      await sleep(6000) // past Paper's same-IP connection throttle (guide precedent)
      let pfMod = null
      try {
        pfMod = require('mineflayer-pathfinder')
        guide2.loadPlugin(pfMod.pathfinder)
      } catch (e) { fail('pit', `guide2 pathfinder: ${e.message}`) }
      try { guide2.chat('follow me') } catch (e) { fail('pit', `guide2 chat: ${e.message}`) }
      await sleep(2000) // the follower adopts on the next tick or two
      const fpos = () => {
        try {
          const p = follower.entity && follower.entity.position
          return p && typeof p.x === 'number' ? p : null
        } catch (_) { return null }
      }
      const gpos = () => {
        try {
          const p = guide2.entity && guide2.entity.position
          return p && typeof p.x === 'number' ? p : null
        } catch (_) { return null }
      }
      try {
        const moves = new pfMod.Movements(guide2)
        moves.canDig = false // surface walk only: no tunnels the follower cannot trail
        moves.allowParkour = true
        moves.allowSprinting = true
        guide2.pathfinder.setMovements(moves)
      } catch (e) { fail('pit', `guide2 moves: ${e.message}`) }
      // Guide2 goes by tp (the follower never does): it is expendable and
      // retries are cheap, and its client position is truth (no rcon
      // data-get, whose point readback false-passed once (c921)). Then a
      // short lead on loaded chunks — a 400-block GoalXZ from world spawn
      // never computes (c69, c900) and strands the lead.
      const G2X = pst.site.x + 10
      const G2Z = pst.site.z
      let g2there = false
      for (let i = 0; i < 5 && !g2there; i++) {
        if (i > 0) await sleep(2000) // space burst rcon (silent-no-op class)
        await rcon(`tp ${GUIDE2} ${G2X + 0.5} ${gy + 1} ${G2Z + 0.5}`).catch(() => {}) // confirm lies; client verifies
        for (let k = 0; k < 10 && !g2there; k++) {
          await sleep(1000)
          const gp = gpos()
          if (gp && Math.hypot(gp.x - (G2X + 0.5), gp.z - (G2Z + 0.5)) < 6 && Math.abs(gp.y - (gy + 1)) < 3) g2there = true
        }
      }
      if (!g2there) fail('pit', 'guide2 tp never applied (client readback)')
      // Pull-to-window on the flat on-pad east strip (pad x1 274, site box
      // ends at site.x+31): off-pad slopes slide the parked bot downhill
      // and false-positive the fall-in (c216), and inside the box the pit
      // stone is castle-protected (c31). Guide2 steps east until the
      // follower reads inside [site.x+32, site.x+36].
      const WIN_LO = pst.site.x + 32
      const WIN_HI = pst.site.x + 36
      let ledOut = false
      for (let step = 0; step < 12 && !ledOut; step++) {
        try { guide2.pathfinder.setGoal(new pfMod.goals.GoalXZ(pst.site.x + 38 + step * 5, pst.site.z)) } catch (e) { fail('pit', `guide2 goal: ${e.message}`) }
        for (let i = 0; i < 10 && !ledOut; i++) {
          await sleep(2000)
          const fp = fpos()
          if (fp && fp.x >= WIN_LO && fp.x <= WIN_HI) ledOut = true
        }
      }
      try { guide2.chat('stop') } catch (_) { /* parking best-effort */ }
      await sleep(2000)
      if (!ledOut) fail('pit', 'follower never entered the on-pad window [site.x+32, site.x+36] (lead-out)')
      // Parked for the build: a working bot walks out from under the fills
      // (c982). Resume ('go work') only after the fall verifies — 'stop'
      // alone would park it idle with no goal to get stuck against (c429).
      // The hollow takes its footing and it falls 4 to the pit floor.
      // Hollow east-shifted so it lands in the west column, wall-adjacent
      // (a centre landing has no dig_step: no solid side at feet — the
      // dead zone, not the dig).
      let bx = null
      let by = null
      let bz = null
      for (let i = 0; i < 20; i++) {
        await sleep(500)
        try {
          if (follower.entity && follower.entity.onGround !== false) {
            const p = follower.entity.position
            if (p && typeof p.x === 'number') { bx = Math.floor(p.x); by = Math.floor(p.y); bz = Math.floor(p.z); break }
          }
        } catch (_) { /* settling */ }
      }
      if (bx == null) fail('pit', 'follower never settled')
      if (bx < WIN_LO || bx > WIN_HI) fail('pit', 'settle x left the on-pad window')
      // Mass rim (bx-3..bx+3) stays on the flattened pad: WIN_HI+3 <= 274.
      if (PIT_SHAPE !== '' && PIT_SHAPE !== 'corner' && PIT_SHAPE !== 'hall') fail('pit-shape', `CASTLE_PIT_SHAPE: want ''|corner|hall, got ${JSON.stringify(PIT_SHAPE)}`)
      const massFill = PIT_SHAPE === 'hall'
        ? `fill ${bx - 3} ${by - 5} ${bz - 3} ${bx + 3} ${by - 1} ${bz + 3} minecraft:stone`
        : `fill ${bx - 3} ${by - 5} ${bz - 2} ${bx + 3} ${by - 1} ${bz + 2} minecraft:stone`
      await rcon(massFill).catch((e) => fail('pit', e.message))
      await sleep(1000) // space burst rcon (same silent-no-op class as the tps)
      const hollowFill = PIT_SHAPE === 'hall'
        ? `fill ${bx - 2} ${by - 4} ${bz - 2} ${bx + 2} ${by + 6} ${bz + 2} minecraft:air`
        : PIT_SHAPE === 'corner'
          ? `fill ${bx} ${by - 4} ${bz} ${bx + 2} ${by + 6} ${bz + 2} minecraft:air`
          : `fill ${bx} ${by - 4} ${bz - 1} ${bx + 2} ${by + 6} ${bz + 1} minecraft:air`
      await rcon(hollowFill).catch((e) => fail('pit', e.message))
      // Fill-verify (client scan): burst rcon silently no-ops (c698). The
      // mass cell proves the mass applied; the hollow cell is air only if
      // the hollow applied on top of it (the mass would stone it).
      await sleep(1000)
      let massOk = false
      let hollowOk = false
      try {
        const m = follower.blockAt(new Vec3(bx - 3, by - 2, bz))
        massOk = !!(m && m.name !== 'air' && m.name !== 'cave_air' && m.name !== 'void_air')
        const h = follower.blockAt(new Vec3(bx + 1, by - 2, bz))
        hollowOk = !!(h && (h.name === 'air' || h.name === 'cave_air' || h.name === 'void_air'))
      } catch (_) { /* scan failed: verify loud below */ }
      if (!massOk || !hollowOk) fail('pit', `fills never landed (mass=${massOk} hollow=${hollowOk})`)
      // Persistent fall-in: one low read is a downhill slide off-pad, a
      // jump transient, or lag — three consecutive lows is the pit floor.
      let lowRun = 0
      let fellIn = false
      for (let i = 0; i < 30 && !fellIn; i++) {
        await sleep(500)
        const p = fpos()
        if (p && Math.floor(p.y) <= by - 3) { lowRun++; if (lowRun >= 3) fellIn = true } else lowRun = 0
      }
      if (!fellIn) fail('pit', 'follower never fell in')
      // Open top (client scan, no rcon): a hill lip overhead head-blocks
      // every dig mount and the pit is unescapable-by-shape.
      let capped = false
      try {
        for (let y = by; y <= by + 6; y++) {
          const b = follower.blockAt(new Vec3(bx + 1, y, bz))
          if (b && b.name !== 'air' && b.name !== 'cave_air' && b.name !== 'void_air') { capped = true; break }
        }
      } catch (_) { capped = false }
      if (capped) fail('pit', 'capped by terrain (re-run; the walk varies)')
      const qy = by - PIT // pit-floor feet level; rim feet level is by
      await sleep(1000)
      await rcon(`give ${FOLLOWER} minecraft:stone_pickaxe 1`).catch((e) => fail('pit', e.message))
      await sleep(1000)
      await rcon(`give ${FOLLOWER} minecraft:dirt 19`).catch((e) => fail('pit', e.message))
      await sleep(1000)
      await rcon(`clear ${FOLLOWER} minecraft:water_bucket`).catch(() => { /* none held */ })
      await sleep(2000) // the pack read lags the gives
      pitRim = by
      pitCX = bx + 1
      pitCZ = bz
      if (PIT_GOAL !== '' && PIT_GOAL !== 'level') fail('pit-goal', `CASTLE_PIT_GOAL: want ''|level, got ${JSON.stringify(PIT_GOAL)}`)
      if (PIT_GOAL === 'level' && !follower._pitGoalInstalled) {
        // Installed BEFORE the resume like the refuse hook: the first pit
        // episode must already carry the forced goal. stuck.js raises every
        // episode through recover.setStuck (property lookup, same module
        // object in-process), so one wrapper covers all owners; the guides
        // are bare bots and never raise. The goal is fixed (c698: level,
        // dist~30, east through the open side) while the body is below the
        // rim near the pit; outside episodes stay organic.
        follower._pitGoalInstalled = true
        const recoverMod = require('../src/behaviours/recover')
        const rawSetStuck = recoverMod.setStuck
        recoverMod.setStuck = (ctx, by, goal, key) => {
          let g = goal
          try {
            const p = follower.entity && follower.entity.position
            if (p && typeof p.y === 'number' && p.y < pitRim &&
              Math.hypot(p.x - (pitCX + 0.5), p.z - (pitCZ + 0.5)) <= 6) {
              g = { x: pitCX + 30, y: qy, z: pitCZ }
            }
          } catch (_) { /* forcing best-effort */ }
          return rawSetStuck(ctx, by, g, key)
        }
      }
      if (PIT_REFUSE && !follower._pitRefuseInstalled) {
        // Installed BEFORE the resume: a post-resume install gives the bot
        // an unrefused head start and it pillar-towers out (c913: 67->69
        // in the 4s gap). Below the rim, near the pit, every placement
        // throws the run7 text. Above the rim or back at the site the real
        // place runs, so resumed-seconds still measure.
        follower._pitRefuseInstalled = true
        const rawPlace = follower.placeBlock.bind(follower)
        follower.placeBlock = async (ref, face, opts) => {
          let p = null
          try { p = follower.entity && follower.entity.position } catch (_) { p = null }
          if (p && typeof p.y === 'number' && p.y < pitRim &&
            Math.hypot(p.x - (pitCX + 0.5), p.z - (pitCZ + 0.5)) <= 6) {
            const held = (follower.heldItem && follower.heldItem.name) || 'block'
            const rp = ref && ref.position
            const d = rp && face ? `(${rp.x + face.x}, ${rp.y + face.y}, ${rp.z + face.z})` : '(?, ?, ?)'
            throw new Error(`Server refused to place ${held} at ${d}: the block is still air`)
          }
          return rawPlace(ref, face, opts)
        }
      }
      // Post-kit still-low, checked while still parked (before the resume):
      // the parked bot cannot move, so a high read here is a slope the
      // fall-in false-positived (c216), while a post-resume check would
      // also catch the control's first legit pillar block (c998: 68).
      {
        const pk = fpos()
        if (!pk || Math.floor(pk.y) > by - 3) fail('pit', `follower not pit-low after kit (y=${pk ? pk.y : '?'}, need block<=${by - 3})`)
      }
      try { guide2.chat('go work') } catch (_) { /* resume best-effort */ }
      await sleep(2000) // adopts on the next tick or two
      try { guide2.quit() } catch (_) { /* quit best-effort */ }
      pitAt = Date.now()
      pitPre = pst.progress && typeof pst.progress.done === 'number' ? pst.progress.done : 0
      const k = sample()
      origLog(`CASTLE-RIG pit: at ${(pitAt - t0) / 1000 | 0}s ${pitPre}/${(pst.progress && pst.progress.total) ?? '?'} -> open ${PIT}-deep stone pit ${bx} ${qy} ${bz} (rim ${by}), shape=${PIT_SHAPE || 'square'}, pick+scaffold kit, refuse=${PIT_REFUSE ? 'on' : 'off'}, goal=${PIT_GOAL || 'organic'}, pack cobble=${k.cobble} dirt=${k.dirt} pick=${k.pick}`)
    }
    const s = sample()
    if (buryAt) {
      const since = Math.round((Date.now() - buryAt) / 1000)
      if (surfacedS == null && typeof s.y === 'number' && s.y >= gy - 2) surfacedS = since
      if (surfacedS != null && resumedS == null && typeof s.done === 'number' && s.done > buryPre) resumedS = since // laid after surfacing
    }
    if (pitAt) {
      const since = Math.round((Date.now() - pitAt) / 1000)
      // Resume baselines at the escape sample, not the pit sample: the
      // initial done=0 is set without scanning, so the first rescan can
      // jump on terrain stone (c378: 0->5 from the pit floor) and a
      // pit-baselined resume would fire at the escape sample.
      if (escapedS == null && typeof s.y === 'number' && s.y >= pitRim) { escapedS = since; pitEsc = typeof s.done === 'number' ? s.done : null }
      const resumeBase = pitEsc != null ? pitEsc : pitPre
      if (escapedS != null && pitResumedS == null && typeof s.done === 'number' && s.done > resumeBase) pitResumedS = since // laid after escaping
    }
    drainSaid()
    checkpoint()
    const line = `castle-sample t=${Math.round(s.t / 60)}min ${s.done ?? '?'}/${s.total ?? '?'} step=${s.step} flips=${seen.flips} deaths=${deaths} hunger=${s.hunger ?? '?'} edibles=${s.edibles ?? '?'}`
    try { logStream.write(line + '\n') } catch (_) { /* log best-effort */ }
    if (Date.now() - lastSampleLine > 300000) {
      lastSampleLine = Date.now()
      origLog(line)
    }
  }
  drainSaid()
  // Relocated boxes (vmzq.40): read the contents back where the bot says it put them.
  for (const m of seen.said) {
    const mv = /moved the (\S+) out of the castle to (-?\d+) (-?\d+) (-?\d+)/.exec(m)
    if (!mv) continue
    const got = await rcon(`data get block ${mv[2]} ${mv[3]} ${mv[4]} Items`).catch((e) => `error ${e.message}`)
    origLog(`CASTLE-RIG relocated ${mv[1]} at ${mv[2]} ${mv[3]} ${mv[4]}: ${String(got).slice(0, 300)}`)
  }
  const last = series[series.length - 1] || {}
  const done = typeof last.done === 'number' ? last.done : 0
  const total = typeof last.total === 'number' ? last.total : 0
  // neuc.60: game minutes actually run (gametime delta; wall x SPEED when
  // unreadable) — a server that cannot hold the rate shows here.
  const wallMin = (Date.now() - t0) / 60000
  const gt1 = await gameTime()
  const gameMin = gt0 != null && gt1 != null ? (gt1 - gt0) / 1200 : wallMin * SPEED
  const laid = done - (typeof series[0].done === 'number' ? series[0].done : 0)
  const tickTag = TICKRATE !== '1' ? `, tick=${TICKRATE}, game=${gameMin.toFixed(1)}min, cells/game-min=${(gameMin > 0 ? laid / gameMin : 0).toFixed(1)}` : ''
  const top = (obj, n) => Object.entries(obj).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => `${k}:${v}`).join(',') || 'none'
  const first = seen.wdFirstAt ? Math.round((seen.wdFirstAt - t0) / 1000) : '-'
  // Far event readout (vmzq.29): done at the jump / lowest sample after it
  // (must never drop: an unloaded site keeps the last read) / final.
  const farMin = farAt ? Math.min(...series.filter((x) => x.t * 1000 >= farAt - t0 && typeof x.done === 'number').map((x) => x.done)) : null
  const farTag = farAt ? `, far=${farPre}/${farMin}/${done}${farMin < farPre ? ' DROPPED' : ''}` : ''
  const buryTag = buryAt ? `, bury=surfaced@${surfacedS ?? 'never'}s,resumed@${resumedS ?? 'never'}s` : ''
  const pitTag = pitAt ? `, pit=escaped@${escapedS ?? 'never'}s,resumed@${pitResumedS ?? 'never'}s` : ''
  if (night) night.finish()
  if (resTimer) clearInterval(resTimer)
  if (dropTimer) clearInterval(dropTimer)
  if (resNights) resNights.finish(Math.round((Date.now() - t0) / 1000))
  // Yard litter (idkcraft-g0z.44): own blocks left in the fence band —
  // placedByBot candidates from the in-process ctx, read back via rcon
  // (the follower may end far away, its site chunks unloaded). `execute
  // if block` answers 'Test passed' for air, 'Test failed' for a block.
  if (idle) {
    const c = tickCtx()
    const cands = require('../src/castle').ownBandCells(c && c.placedByBot, c && c.castle, c && c.placedNames)
    let n = 0
    for (const cell of cands) {
      const out = await rcon(`execute if block ${cell.x} ${cell.y} ${cell.z} air`).catch((e) => fail('yard-litter', e.message))
      if (/Test passed/.test(out)) continue
      if (/Test failed/.test(out)) { n++; continue }
      fail('yard-litter', `unreadable cell ${cell.x} ${cell.y} ${cell.z}: ${String(out).slice(0, 120)}`)
    }
    if (n > 0) origLog(`CASTLE-RIG yard-litter: ${n} own blocks left in the fence band`)
    idle.setYardLitter(n)
  }
  // Apron litter (g0z.63): the non-owner's own blocks (placedByBot) left
  // solid in the known castle's apron, off its plan — read back via rcon
  // like the yard litter.
  let apronTag = ''
  if (NIGHT_HOME === 'apron') {
    const c = tickCtx()
    const known = c && Array.isArray(c.knownCastles) ? c.knownCastles[0] : null
    const bp = require('../src/castle')
    const at = known ? bp.absPlan(known.site, known.rot, known.blueprintVersion).at : new Map()
    let n = 0
    const names = {}
    for (const k of (c && c.placedByBot instanceof Set ? c.placedByBot : [])) {
      const [x, y, z] = k.split(',').map(Number)
      if (!known || !bp.apronOf(known, { x, y, z }) || at.has(k)) continue
      const out = await rcon(`execute if block ${x} ${y} ${z} air`).catch((e) => fail('apron-litter', e.message))
      if (!/Test failed/.test(out)) continue
      n++
      const nm = (c.placedNames instanceof Map && c.placedNames.get(k)) || '?'
      names[nm] = (names[nm] || 0) + 1
      if (n <= 40) origLog(`CASTLE-RIG apron-litter cell ${x} ${y} ${z} ${nm}`)
    }
    const hist = Object.entries(names).map(([k, v]) => `${k}:${v}`).join(',')
    apronTag = `, apron-litter=${known ? n : 'no-known-castle'}${hist ? `(${hist})` : ''}`
  }
  if (apronSnap) {
    const box = apronBox(apronSnap)
    const bp = require('../src/castle')
    const v = apronSnap.blueprintVersion
    // Place cells only: dig (dry moat, must end as air) and air (doorways,
    // windows) cells are not excluded, so throwaway bridged into them
    // counts toward apron-throwaway (5g43 body-1).
    const plan = new Set([...bp.absPlan(apronSnap.site, 0, v).cells.filter((c) => bp.isPlaceTarget(c.kind)), ...bp.decorPlan(apronSnap.site, 0, v).cells].map((c) => `${c.x},${c.y},${c.z}`))
    await rcon(`forceload add ${box.x1} ${box.z1} ${box.x2} ${box.z2}`).catch((e) => fail('apron-diff', e.message))
    await sleep(3000)
    const changed = await apronChanged(rcon, box).catch((e) => fail('apron-diff', e.message))
    // Throwaway = Baritone's acceptableThrowawayItems (body.js scaffold set:
    // dirt + castle.STONE_ITEMS) — the gate count; the rest (tree growth,
    // a crafting table, ...) is named for the diagnosis only.
    const throwaway = ['dirt', ...bp.STONE_ITEMS]
    const other = ['#minecraft:leaves', '#minecraft:logs', '#minecraft:saplings', '#minecraft:flowers', '#minecraft:replaceable', 'oak_planks', 'crafting_table', 'furnace', 'torch', 'chest', 'water', 'lava']
    const names = {}
    let n = 0
    let thrown = 0
    for (const c of changed) {
      if (plan.has(`${c.x},${c.y},${c.z}`)) continue
      if (!/Test passed/.test(await rcon(`execute if block ${c.x} ${c.copyY} ${c.z} air`))) continue // was solid: a dig or a swap
      if (/Test passed/.test(await rcon(`execute if block ${c.x} ${c.y} ${c.z} air`))) continue
      let nm = '?'
      for (const k of [...throwaway, ...other]) {
        if (/Test passed/.test(await rcon(`execute if block ${c.x} ${c.y} ${c.z} ${k}`))) { nm = k.replace('#minecraft:', '#'); break }
      }
      n++
      if (throwaway.includes(nm)) thrown++
      names[nm] = (names[nm] || 0) + 1
      if (n <= 40) origLog(`CASTLE-RIG apron-new cell ${c.x} ${c.y} ${c.z} ${nm}`)
    }
    await rcon(`forceload remove ${box.x1} ${box.z1} ${box.x2} ${box.z2}`).catch(() => {})
    const hist = Object.entries(names).map(([k, val]) => `${k}:${val}`).join(',')
    apronTag += `, apron-throwaway=${thrown}, apron-new=${n}${hist ? `(${hist})` : ''}, apron-changed=${changed.length}${changed.length >= 4000 ? '+ CAPPED (incomplete: counts are a floor)' : ''}`
  }
  // Stairs facing (g0z.47): every v3 stairs cell read back via rcon — laid
  // (any stair) vs laid with the plan facing, half bottom. Build runs, and
  // upgrade runs (g0z.48), where the facing-ok count joins the verdict.
  let upgrade = null
  if ((!SEED && !idle) || SEED_UPGRADE) {
    const c = tickCtx()
    const st = c && c.castle
    if (st && st.site && st.blueprintVersion === 3) {
      const blueprint = require('../src/castle')
      const stairs = blueprint.absPlan(st.site, st.rot, 3).cells.filter((o) => o.kind === 'stairs')
      let laid = 0
      let ok = 0
      for (const cell of stairs) {
        const at = `${cell.x} ${cell.y} ${cell.z}`
        const any = await rcon(`execute if block ${at} #minecraft:stairs`).catch((e) => `error ${e.message}`)
        if (!/Test passed/.test(any)) continue
        laid++
        const right = await rcon(`execute if block ${at} minecraft:cobblestone_stairs[facing=${blueprint.faceName(cell.face)},half=bottom]`).catch((e) => `error ${e.message}`)
        if (/Test passed/.test(right)) ok++
      }
      origLog(`CASTLE-RIG stairs: laid=${laid} facing-ok=${ok}`)
      if (SEED_UPGRADE) upgrade = { ok, total: stairs.length, phase: st.phase }
    } else if (SEED_UPGRADE) {
      upgrade = { ok: 0, total: 0, phase: (st && st.phase) || 'no-castle' }
    }
  }
  // Panes (g0z.38): decor pane cells of the seeded castle reading
  // *glass_pane on the follower (unloaded cells are counted apart).
  // Upper fence (g0z.45): the same for the second fence row.
  // Attic (g0z.49): the same for the table + 5 shelves, read back via
  // castle.matches like the seeded plan cells.
  // Blast (g0z.50): the same for the kitchen blast furnace; furnace-spot
  // reads the 3 C_FURNACE cells — the pane ladder smelts in the plain
  // furnace and must never adopt or replace the decor blast.
  // Recall (g0z.45): the window's side work can end the follower far off
  // site (a 60-min seed run read 153/153 unread) — tp it over the site and
  // wait for the chunks before counting. Verdict phase only: the idle
  // extremes below accumulate during the window, a centre sample moves none.
  let paneTag = ''
  let fenceTag = ''
  let atticTag = ''
  let blastTag = ''
  let furnaceTag = ''
  if (SEED === 'complete') {
    const site = { x: bx - 15, y: gy + 1, z: bz - 13 }
    await rcon(`tp ${FOLLOWER} ${site.x + 15.5} ${site.y + 12} ${site.z + 13.5}`).catch(() => {})
    for (let i = 0; i < 30; i++) {
      let loaded = false
      try {
        loaded = [[0, 0], [30, 0], [0, 26], [30, 26]]
          .every(([dx, dz]) => !!follower.blockAt(new Vec3(site.x + dx, site.y, site.z + dz)))
      } catch (_) { loaded = false }
      if (loaded) break
      await sleep(1000)
    }
    const castle = require('../src/castle')
    const dp = castle.decorPlan(site, 0, 2).cells
    for (const [kinds, tag] of [[['pane'], 'panes'], [['fence'], 'upper-fence'], [['bookshelf', 'enchanting_table'], 'attic'], [['blast_furnace'], 'blast']]) {
      const cells = dp.filter((c) => kinds.includes(c.kind))
      let laid = 0
      let unread = 0
      for (const c of cells) {
        let b = null
        try { b = follower.blockAt(new Vec3(c.x, c.y, c.z)) } catch (_) { b = null }
        if (!b) unread++
        else if (castle.matches(c.kind, b.name)) laid++
      }
      const t = `, ${tag}=${laid}/${cells.length}${unread ? `(${unread} unread)` : ''}`
      if (tag === 'panes') paneTag = t
      else if (tag === 'upper-fence') fenceTag = t
      else if (tag === 'attic') atticTag = t
      else blastTag = t
    }
    const spots = require('../src/residence').CASTLE.furnace({ site, rot: 0, blueprintVersion: 2 })
    const at = []
    for (const sp of spots) {
      let b = null
      try { b = follower.blockAt(new Vec3(site.x + sp.dx, site.y + sp.dy, site.z + sp.dz)) } catch (_) { b = null }
      at.push(b ? b.name : 'unread')
    }
    furnaceTag = `, furnace-spot=${at.join('/')}`
  }
  const upgradeTag = upgrade ? `, upgrade=${upgrade.ok}/${upgrade.total}@${upgrade.phase}` : ''
  let repairTag = ''
  if (knocked.length) {
    const relaid = series.length ? series[series.length - 1].relaid : 0
    const after = repairT == null ? 0 : seen.regressAt.filter((at) => at > t0 + repairT * 1000).length
    // prkh: first second a stone fetch failure parks the word (kinded on
    // the branch, word-attributed on master) — the verdict names the gap.
    const stoneheldT = stoneheldAt(series)
    repairTag = `, repair=${relaid}/${knocked.length}@${repairT == null ? '-' : `${repairT}s`}, regress=${after}, nowood@${nowoodT == null ? '-' : `${nowoodT}s`}, stoneheld@${stoneheldT == null ? '-' : `${stoneheldT}s`}`
  }
  // g0z.58: regress counts the whole window (a v2 tunnel through the wall
  // logs one), escaped/home are seconds from window open.
  const startTag = start ? `, start=${start.d.join(',')}${start.cell ? `/${start.cell}` : ''}, escaped@${startEscS == null ? 'no' : `${startEscS}s`}, home@${startHomeS == null ? 'no' : `${startHomeS}s`}, regress=${seen.regressAt.filter((at) => at >= t0).length}` : ''
  let litterTag = ''
  let litterV = null
  if (litterSeed) {
    const swept = series.length ? series[series.length - 1].litter : 0
    const nameAt = (c) => { try { const b = follower.blockAt(new Vec3(c.x, c.y, c.z)); return b && b.name } catch (_) { return null } }
    const intact = litterSeed.player.filter((o) => o.cells.every((c) => nameAt(c) === c.block.split('[')[0]))
    const regress = seen.regressAt.filter((at) => at >= t0).length
    litterTag = `, litter=${swept}/${litterSeed.litter.length}@${litterT == null ? '-' : `${litterT}s`}, player=${intact.length}/${litterSeed.player.length}, regress=${regress}`
    const broken = litterSeed.player.filter((o) => !intact.includes(o)).map((o) => o.what)
    const left = litterSeed.litter.filter((o) => !o.cells.every((c) => nameAt(c) === 'air')).map((o) => `${o.what}@${o.cells[0].x},${o.cells[0].y},${o.cells[0].z}`)
    const litterByS = LITTER_BY_S == null ? MINS * 60 : LITTER_BY_S // tidy: judged at window end
    const pass = litterT != null && litterT <= litterByS && broken.length === 0 && regress === 0 && done === total
    litterV = `CASTLE-RIG litter: ${pass ? 'PASS' : 'FAIL'} (>= ${LITTER_PASS}/${litterSeed.litter.length} swept by ${litterByS}s: ${litterT == null ? 'never' : `${litterT}s`}; player intact ${intact.length}/${litterSeed.player.length}${broken.length ? ` broken=${broken.join(',')}` : ''}; plan ${done}/${total}, regress=${regress}${left.length ? `; left ${left.slice(0, 6).join(' ')}` : ''})`
  }
  const nightTag = (night ? night.tag() : '') + seedTag + startTag + paneTag + fenceTag + atticTag + blastTag + furnaceTag + upgradeTag + repairTag + litterTag + (resNights ? resNights.tag() : '') + (idle ? idle.tag() : '') + apronTag
  const line = `castle ${done}/${total} in ${MINS} min, flips=${seen.flips}, deaths=${deaths}, top-steps=${top(seen.steps, 4)}, top-fail=${top(seen.fails, 3)}, watchdog=${seen.wdCalls}, first=${first}, choices=${top(seen.wdChoices, 3)}, outcomes=progress:${seen.outcomes.progress},flat:${seen.outcomes.flat},preempted:${seen.outcomes.preempted}${farTag}${buryTag}${pitTag}${nightTag}${tickTag}`
  let compLine = null
  if (COMPONENT) {
    let base = null
    try { base = JSON.parse(fs.readFileSync(path.join(__dirname, 'component-baseline.json'), 'utf8'))[process.env.BOT_BODY === 'baritone' ? 'v2' : 'v1'][COMPONENT] || null } catch (_) { base = null }
    compLine = componentLine(COMPONENT, { laid, gameMin, wallMin, series, tick: TICKRATE, baseline: baselineFor(base, process.env), diag: DIAG })
  }
  let mineBase = null
  try { mineBase = JSON.parse(fs.readFileSync(path.join(__dirname, 'component-baseline.json'), 'utf8'))[process.env.BOT_BODY === 'baritone' ? 'v2' : 'v1'].mine || null } catch (_) { mineBase = null }
  const fetchTxt = fetchLine({ series, events: seen.fetchEv.map((e) => ({ ...e, t: (e.at - t0) / 1000 })), ticks: seen.steps.castlefetch, ratio: wallMin > 0 ? gameMin / wallMin : 1, mineBase })
  const record = {
    date: new Date().toISOString(), mins: MINS, done, total, flips: seen.flips, deaths,
    steps: seen.steps, fails: seen.fails, pad: { x0, x1, z0, z1, top: gy, cx: bx, cz: bz, span: brel ? brel.span : null },
    tag: TAG, gitsha: process.env.CASTLE_GITSHA || '?', log: LOGFILE,
    kit: KIT, tickrate: TICKRATE, planner: PLANNER, blocked: blockedSeeds, said: seen.said,
    wdCalls: seen.wdCalls, wdFirstS: first, wdChoices: seen.wdChoices, outcomes: seen.outcomes,
    series, timeEvents: seen.timeEvents, timeMaxDrift: seen.timeMaxDrift,
    nights: night ? night.nights : undefined,
    seed: SEED || undefined, residence: resNights ? resNights.nights : undefined,
    seedVersion: SEED ? SEED_VERSION : undefined, upgrade: upgrade || undefined,
    gameMin, wallMin, component: compLine || undefined, diag: DIAG || undefined, fetch: fetchTxt,
  }
  try { fs.writeFileSync(OUT, JSON.stringify(record, null, 1)) } catch (e) {
    origLog(`CASTLE-RIG out write failed: ${e.message}`)
  }
  origLog(line)
  if (compLine) origLog(compLine)
  origLog(fetchTxt)
  const idleV = idle ? idle.verdict(deaths - idleForced, resNights ? resNights.nights : []) : null
  if (idleV) origLog(idleV.line)
  if (litterV) origLog(litterV)
  try { logStream.end() } catch (_) { /* close best-effort */ }
  process.exit(idleV && !idleV.pass ? 1 : 0)
}

if (require.main === module) {
  main().catch((e) => {
    origLog(`CASTLE-RIG FATAL: ${e && e.message ? e.message : e}`);
    try { logStream.end() } catch (_) { /* close best-effort */ }
    process.exit(2)
  })
}
module.exports = { apronBox, apronCloneCmds, apronChanged, componentLine, baselineFor, fetchLine, bankedOf, repairCells, prkhCells, quarryDeadFills, stoneheldAt, litterSeeds, startPlan, createIdleTrack, IDLE_MAXDIST, IDLE_HOME, idleRespawnPoint, prodSpawnPoint, hookBotClock, rigHouseCommands, isFallDeath, createDropTrack, classify, seen, resetSeen, pickBlockedSeeds, createResidenceNights, seedCastleCells, seedMatches, parseSeedVersion, pickPadSpot, createTimeResync, timeDrift, createNightDriver, landingY, padFloats, acceptLanding, floatingPad }
