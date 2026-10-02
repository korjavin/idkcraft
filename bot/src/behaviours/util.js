'use strict'

// Shared behaviour helpers (idkcraft-08i): byte-identical say/clearGoal
// lived in six behaviour files, botPos in three (plus a home.js variant
// without the try). One copy, so a latch fix lands everywhere at once.
// Requires only the external vec3 leaf (real bot.blockAt calls pos.floored,
// so plain {x,y,z} would throw) and the pure castle data module (no
// requires of its own) — still no repo import cycles.
const { Vec3 } = require('vec3')
const castle = require('../castle')

function say(bot, line) {
  try { bot.chat(line) } catch (_) { /* chat best-effort, like goal.js */ }
}

// Drop a live pathfinder goal like stopOnce, but without stop(): its latch
// would swallow the next setGoal issued on the same tick (gather pattern).
function clearGoal(bot, ctx) {
  try {
    if (bot.pathfinder && bot.pathfinder.goal && typeof bot.pathfinder.setGoal === 'function') {
      bot.pathfinder.setGoal(null)
    }
  } catch (_) { /* body best-effort */ }
  ctx.lastGoalKey = ''
}

function botPos(bot) {
  try {
    const p = bot && bot.entity && bot.entity.position
    if (p && typeof p.x === 'number') return p
  } catch (_) { /* no position */ }
  return null
}

module.exports = { say, clearGoal, botPos }

// Owner-build protection (idkcraft-drq): the single break guard every
// direct dig site calls. Breakable = natural terrain or blocks the bot
// placed itself this session (ctx.placedByBot, populated by trackPlaced).
// Everything else is protected, including owner-plausible naturals
// (cobblestone, ice, obsidian) and bare/stripped logs. Default deny:
// unknown names, nulls and errors all refuse. Quiet by design — callers
// log the protected: line when a denial changes a decision, so scans
// that evaluate dozens of cells do not flood the log.
const NATURAL_SOLID = new Set([
  'dirt', 'grass_block', 'coarse_dirt', 'rooted_dirt', 'podzol', 'mycelium',
  'mud', 'muddy_mangrove_roots',
  'sand', 'red_sand', 'gravel', 'clay', 'soul_sand', 'soul_soil',
  'stone', 'granite', 'diorite', 'andesite', 'deepslate', 'tuff', 'calcite',
  'dripstone_block', 'sandstone', 'red_sandstone', 'infested_stone',
  'snow', 'snow_block', 'ice', 'packed_ice', 'ancient_debris',
  'netherrack', 'basalt', 'blackstone', 'soul_sand', 'soul_soil',
  'magma_block', 'end_stone',
  'nether_wart_block', 'warped_wart_block',
])
// NOTE: matches flat.js DIG_ALLOWLIST (ice, nether/end terrain) except
// blue_ice, which is crafted-only and always a build. flat.js keeps its own
// allowlist + structureNear proximity gate; canBreak is the cross-behaviour
// floor both defer to at the dig moment.

// Clearable flora (moved from stockpile.js so the guard shares it): grows
// back, never part of a build. Torches are NOT here — foreign torches stay
// protected (build.js REPLACEABLE is wider on purpose: it only clears its
// own blueprint cells).
const CLEAR_FLORA = new Set([
  'short_grass', 'tall_grass', 'fern', 'large_fern', 'dead_bush', 'bush',
  'snow', 'poppy', 'dandelion', 'oxeye_daisy', 'cornflower', 'azure_bluet',
  'allium', 'blue_orchid', 'lily_of_the_valley', 'red_tulip', 'orange_tulip',
  'white_tulip', 'pink_tulip', 'vine', 'glow_lichen',
])

function isWoody(name) {
  return typeof name === 'string' && /(_log|_stem|_hyphae|_wood)$/.test(name)
}

function cellName(bot, x, y, z) {
  try {
    const b = bot && typeof bot.blockAt === 'function' ? bot.blockAt(new Vec3(x, y, z)) : null
    return (b && typeof b.name === 'string') ? b.name : null
  } catch (_) { return null }
}

function crownNear(bot, x, y, z) {
  for (let dx = -2; dx <= 2; dx++) {
    for (let dy = -2; dy <= 2; dy++) {
      for (let dz = -2; dz <= 2; dz++) {
        if (dx === 0 && dy === 0 && dz === 0) continue
        const n = cellName(bot, x + dx, y + dy, z + dz)
        if (!n) continue
        if (n.endsWith('_leaves') || n === 'nether_wart_block' || n === 'warped_wart_block') return true
      }
    }
  }
  return false
}

// A log/stem is a tree only with a woody column above or below AND a leaf
// crown (or nether wart) around the column TOP: walk the woody cells up
// from the target (bounded) and look for leaves there. Judging at the
// target instead accepts cabin pillars under a canopy (leaves beside the
// middle of the pillar) and refuses the low logs of tall trunks (no
// leaves within 2 of the bottom). A solid cap directly above the top
// (planks, slabs: a roof, not sky) vetoes. Fails closed without a world
// view. Residual: a placed pillar deliberately crowned with leaves reads
// as a tree — indistinguishable, accepted.
function isTreeLog(bot, block) {
  try {
    if (!bot || typeof bot.blockAt !== 'function' || !block || !block.position) return false
    const p = block.position
    if (typeof p.x !== 'number' || typeof p.y !== 'number' || typeof p.z !== 'number') return false
    const x = Math.floor(p.x)
    const y = Math.floor(p.y)
    const z = Math.floor(p.z)
    const above = cellName(bot, x, y + 1, z)
    const below = cellName(bot, x, y - 1, z)
    if (!isWoody(above) && !isWoody(below)) {
      // Trunk remnant: the lower logs are already chopped (air below) and
      // the crown sits directly above. Without this the last log of every
      // trunk reads 'protected'. Below MUST be air: a lone log on dirt or
      // planks with leaves above is decor, not a remnant.
      const airBelow = below === 'air' || below === 'cave_air' || below === 'void_air'
      if (airBelow && above && (above.endsWith('_leaves') || above === 'nether_wart_block' || above === 'warped_wart_block') &&
          crownNear(bot, x, y, z)) return true
      return false
    }
    let top = y
    for (let i = 1; i <= 32; i++) {
      if (!isWoody(cellName(bot, x, y + i, z))) break
      top = y + i
    }
    const cap = cellName(bot, x, top + 1, z)
    if (cap && isWall(cap) && !cap.endsWith('_leaves') &&
        cap !== 'nether_wart_block' && cap !== 'warped_wart_block') return false
    return crownNear(bot, x, top, z)
  } catch (_) { return false }
}

// Walk-through blocks for the wall check below: real mineflayer reports
// these via boundingBox 'empty', fakes carry the name only.
const NOT_WALL = new Set(['water', 'lava', 'kelp', 'kelp_plant', 'seagrass', 'tall_seagrass'])

function isWall(name) {
  return typeof name === 'string' && name !== 'air' && name !== 'cave_air' &&
    name !== 'void_air' && !CLEAR_FLORA.has(name) && !NOT_WALL.has(name)
}

// Solid horizontal neighbours at the feet plane (0-4). Only proven walls
// count: unknown cells never do. (Asymmetry is deliberate: protection
// fails closed because a destroyed build is unrecoverable, while the trap
// rule needs proof because over-denying bricks legitimate digging such as
// flat restock on open ground.)
function walledSides(bot, feet) {
  try {
    if (!bot || typeof bot.blockAt !== 'function') return 0
    const fx = Math.floor(feet.x)
    const fy = Math.floor(feet.y)
    const fz = Math.floor(feet.z)
    const offs = [[1, 0], [-1, 0], [0, 1], [0, -1]]
    let n = 0
    for (const [dx, dz] of offs) {
      let b = null
      try { b = bot.blockAt(new Vec3(fx + dx, fy, fz + dz)) } catch (_) { b = null }
      if (!b) continue
      if (b.boundingBox === 'empty') continue
      if (isWall(b.name)) n++
    }
    return n
  } catch (_) { return 0 }
}

// A below-feet dig is a trap only in a real depression: one wall (a trunk,
// a bump, the rim of the hole flat is filling) still leaves a 1-deep dig
// jumpable, and so does a corner; three walls mean the deepened cell has
// no same-level way out.
const TRAP_WALLS = 3

// Blocks that fall when their support is dug (sand, gravel, concrete
// powder): digging one of these directly is safe (it breaks into item
// form), but digging its SUPPORT drops the stack onto whatever is below.
function isGravityBlock(name) {
  return name === 'sand' || name === 'red_sand' || name === 'gravel' ||
    (typeof name === 'string' && name.endsWith('_concrete_powder'))
}

// Name of the gravity block directly above pos, or null. Unknown cells
// return null: trap rules need proof (see walledSides above).
function gravityAbove(bot, pos) {
  try {
    if (!bot || typeof bot.blockAt !== 'function' || !pos) return null
    const b = bot.blockAt(new Vec3(Math.floor(pos.x), Math.floor(pos.y) + 1, Math.floor(pos.z)))
    const n = b && b.name
    return isGravityBlock(n) ? n : null
  } catch (_) { return null }
}

// atl.20: is the cell directly below pos a PROVEN solid landing (a known
// solid block — air, water/lava and unknown cells are not)? The landing
// is never dug, only stood on, so protection does not apply to it. Used
// by bring's below-feet exemption: digging the ore under your feet onto
// solid stone is what a player does (a safe 1-block drop), not a trap.
// The guard itself stays conservative for every other behaviour (equip's
// no-deepen rule, forage/flat skips), which never loop on this denial.
function solidBelow(bot, pos) {
  try {
    if (!bot || typeof bot.blockAt !== 'function' || !pos) return false
    const b = bot.blockAt(new Vec3(Math.floor(pos.x), Math.floor(pos.y) - 1, Math.floor(pos.z)))
    if (!b) return false
    if (b.boundingBox === 'empty') return false
    return isWall(b.name)
  } catch (_) { return false }
}

// denyReason is the guard's single decision point. Returns null when the
// dig is allowed, else a self-trap reason ('below-feet': the target is
// below the feet plane while the bot already stands in a depression, so
// the dig would deepen the hole; 'gravity': the dig would drop a sand /
// gravel stack onto the bot's own head — owner session 2026-09-28:
// recover dig_up opened a sand ceiling at -11 56 124 and the bot
// suffocated 2s after the dig finished; 'submerged': water in the target
// cell or above it, the dig needs a dive — prod 2026-09-28 drowned on
// one) or 'protected' (owner-build protection). A below-feet dig on open
// ground stays allowed: it makes a 1-deep hole the bot jumps out of.
// Both trap rules need a known position and proven cells; without either
// they cannot prove a trap and stay out, while the protection rules below
// them still fail closed.
// Water-like cells for the breath guard (idkcraft-0u9): plain water plus
// the flora that only stands in water (mirrors swim.js WET_NAMES).
const WET_DIG_NAMES = new Set(['water', 'bubble_column', 'kelp', 'kelp_plant', 'seagrass', 'tall_seagrass'])

function isWetDigName(name) {
  return typeof name === 'string' && WET_DIG_NAMES.has(name)
}

// Water in the cell or directly above it — the shared 'submerged'
// predicate (bring.js costs wet candidates without digging them).
function submergedAt(bot, x, y, z) {
  try {
    if (typeof x !== 'number' || typeof y !== 'number' || typeof z !== 'number') return false
    return isWetDigName(cellName(bot, Math.floor(x), Math.floor(y), Math.floor(z))) ||
      isWetDigName(cellName(bot, Math.floor(x), Math.floor(y) + 1, Math.floor(z)))
  } catch (_) { return false }
}

function denyReason(bot, block, ctx) {
  try {
    if (!block || typeof block.name !== 'string') return 'protected'
    const name = block.name
    if (name === 'air' || name === 'cave_air' || name === 'void_air') return null
    // Breath (idkcraft-0u9): a dig the bot must submerge its head for —
    // water in the target cell or directly above it. Prod 2026-09-28
    // drowned mid-dig on an underwater vein; the ticker breath reflex
    // rescues the body, this refusal keeps digs out of the water in the
    // first place. A property of the target, not the stance, so it sits
    // above the trap rules; unknown cells read dry (proof rule, above).
    const pos = block.position
    if (pos && submergedAt(bot, pos.x, pos.y, pos.z)) return 'submerged'
    const feet = botPos(bot)
    if (feet && pos && typeof pos.y === 'number' && Math.floor(pos.y) < Math.floor(feet.y)) {
      const near = Math.abs(Math.floor(pos.x) - Math.floor(feet.x)) <= 1 &&
        Math.abs(Math.floor(pos.z) - Math.floor(feet.z)) <= 1
      if (near && walledSides(bot, feet) >= TRAP_WALLS) return 'below-feet'
    }
    // Never dig a support out from under a gravity block in the bot's own
    // column: the stack falls onto the bot. The exemption is only the body
    // cells (feet, head): digging the sand out of the cell you already
    // occupy is the escape when buried. A gravity block HIGHER up with
    // more gravity above it is itself a support — digging it drops the
    // stack through your air cells onto your head. Below-feet targets stay
    // with the rule above (a gravity block directly above the floor is the
    // feet cell itself, i.e. already buried).
    if (feet && pos && typeof pos.y === 'number' && Math.floor(pos.y) >= Math.floor(feet.y)) {
      const ty = Math.floor(pos.y)
      if (Math.floor(feet.x) === Math.floor(pos.x) && Math.floor(feet.z) === Math.floor(pos.z) &&
          gravityAbove(bot, pos) && !(isGravityBlock(name) && ty <= Math.floor(feet.y) + 1)) {
        return 'gravity'
      }
    }
    return protectedReason(bot, block, ctx)
  } catch (_) { return 'protected' }
}

// Interior box + 1 ring (walls) (all the way down) to the roof, plus
// the apron (yard ground around it, below the doorstep level). Home shape: site, interior{min,max}, v (door dx 3 on v2, else 1).
function inHouseFootprint(home, pos) {
  try {
    const s = home && home.site
    const b = home && home.interior
    if (!s || !b || !b.min || !b.max || !pos) return false
    const x = Math.floor(pos.x), y = Math.floor(pos.y), z = Math.floor(pos.z)
    if (x >= b.min.x - 1 && x <= b.max.x + 1 && z >= b.min.z - 1 && z <= b.max.z + 1 && y <= b.max.y + 1) return true
    // Apron (idkcraft-0mlh): 2 cells of yard ground past the walls (3 on
    // the door side: outsidePos and two cells in front of it), up to the
    // doorstep level. Prod 2026-10-02: equip dug a 2-4 deep pit on the porch,
    // gohome then arrived at y=69 and died at the door.
    const apron = x >= b.min.x - 3 && x <= b.max.x + 3 && z >= Math.min(b.min.z - 3, s.z - 3) && z <= b.max.z + 3 && y <= s.y + 1
    return apron ? 'apron' : false
  } catch (_) { return false }
}

// Pit escape (idkcraft-0mlh revmux 01 core-1): a recovering body standing
// below the doorstep level (in an old porch pit) may still dig apron cells
// beside it at body height and above — recover's stair/headroom digs —
// never below. Recover only (ctx.recovery): equip in the pit must not
// widen it (revmux 02).
function apronEscape(bot, home, pos) {
  const feet = botPos(bot)
  if (!feet || !pos) return false
  const fy = Math.floor(feet.y)
  return fy < home.site.y && Math.floor(pos.y) >= fy &&
    Math.abs(Math.floor(pos.x) - Math.floor(feet.x)) <= 1 && Math.abs(Math.floor(pos.z) - Math.floor(feet.z)) <= 1
}

// The type-rules tail of denyReason, split out so bring's atl.20 exemption
// can unmask what the trap rules hide: denyReason returns 'below-feet'
// before it checks protection (pinned: trap fires before type rules), so
// a 'below-feet' denial over solid may sit on a build. Returns null when
// the block itself is diggable, else 'protected'. Never returns trap
// reasons (revmux 01 core-1).
// Castle guard (shared with behaviours/castle.js guardCastle): a laid plan
// block, or natural ground under the site (idkcraft-g0z.14). Solid ground
// only, like the house footprint: snow layers stay build's clears.
function castleProtects(state, pos, name) {
  return castle.protects(state, pos, name) ||
    (name !== 'snow' && NATURAL_SOLID.has(name) && castle.groundCell(state, pos))
}

function protectedReason(bot, block, ctx) {
  try {
    if (!block || typeof block.name !== 'string') return 'protected'
    const name = block.name
    const pos = block.position
    // Beds are never dug, even our own (idkcraft-jrp): placedByBot is
    // positional, so a stale entry (a roadside table on B-foot, hand-cleared,
    // then the bed placed into the same cell) would license a recover dig to
    // pop the bedroom. No behaviour digs beds (bring-bed crafts fresh, the
    // bed step fails loud on halves).
    if (name.endsWith('_bed')) return 'protected'
    // Castle blocks (idkcraft-g0z.2): guarded for every executor BEFORE the
    // placedByBot exemption — the bot laid them, and that must not license
    // a recover/gather dig through the castle wall.
    if (ctx && ctx.castle && castleProtects(ctx.castle, pos, name)) return 'protected'
    // House footprint (idkcraft-e5ba): natural ground under/around our own
    // house is its floor and door support, never scaffold. Solid ground only:
    // build's own clears (flora, snow) stay legal.
    // The whole column below the roof is covered (equip would otherwise dig
    // under the floor). Bot-placed patches above the floor layer stay diggable.
    let fp = name !== 'snow' && NATURAL_SOLID.has(name) && inHouseFootprint(ctx && ctx.home, pos)
    if (fp === 'apron' && ctx.recovery && apronEscape(bot, ctx.home, pos)) fp = false // recover only (revmux 02 core-1)
    if (fp && !(pos.y >= ctx.home.site.y && ctx.placedByBot instanceof Set &&
      ctx.placedByBot.has(`${Math.floor(pos.x)},${Math.floor(pos.y)},${Math.floor(pos.z)}`))) return 'protected'
    if (pos && ctx && ctx.placedByBot instanceof Set && !(fp && pos.y < ctx.home.site.y)) {
      try {
        if (ctx.placedByBot.has(`${Math.floor(pos.x)},${Math.floor(pos.y)},${Math.floor(pos.z)}`)) return null
      } catch (_) { /* fall through to type rules */ }
    }
    if (CLEAR_FLORA.has(name) || NATURAL_SOLID.has(name)) return null
    if (name.endsWith('_ore') || name.endsWith('_leaves')) return null
    const woody = (name.endsWith('_log') && !name.startsWith('stripped_')) ||
      name.endsWith('_stem') || name.endsWith('_hyphae')
    if (woody) return isTreeLog(bot, block) ? null : 'protected'
    return 'protected'
  } catch (_) { return 'protected' }
}

function canBreak(bot, block, ctx) {
  return denyReason(bot, block, ctx) === null
}

function logDeny(block, reason) {
  try {
    const n = (block && block.name) || '?'
    const p = block && block.position
    const at = (p && typeof p.x === 'number')
      ? `${Math.floor(p.x)} ${Math.floor(p.y)} ${Math.floor(p.z)}`
      : '? ? ?'
    if (reason === 'below-feet' || reason === 'gravity' || reason === 'submerged') {
      console.log(`selftrap: refused dig ${n} at ${at} (${reason})`)
    } else {
      console.log(`protected: ${n} at ${at}`)
    }
  } catch (_) { /* logging never breaks a dig */ }
}

// Record every successful placement in ctx.placedByBot ("x,y,z", capped).
// Installed once per bot in createTicker; covers all place sites plus the
// pathfinder executor's own placements, so future code is tracked too.
function trackPlaced(bot, ctx) {
  if (!bot || typeof bot.placeBlock !== 'function' || bot._placedTrackInstalled) return
  bot._placedTrackInstalled = true
  const orig = bot.placeBlock.bind(bot)
  bot.placeBlock = async (ref, face, opts) => {
    const out = await orig(ref, face, opts)
    try {
      const rp = ref && ref.position
      if (rp && face && typeof face.x === 'number' && ctx) {
        if (!(ctx.placedByBot instanceof Set)) ctx.placedByBot = new Set()
        if (ctx.placedByBot.size >= 5000) {
          const oldest = ctx.placedByBot.values().next().value
          ctx.placedByBot.delete(oldest)
        }
        ctx.placedByBot.add(`${Math.floor(rp.x + face.x)},${Math.floor(rp.y + face.y)},${Math.floor(rp.z + face.z)}`)
      }
    } catch (_) { /* tracking never breaks a place */ }
    return out
  }
}

module.exports = { say, clearGoal, botPos, canBreak, denyReason, logDeny, trackPlaced, CLEAR_FLORA, NATURAL_SOLID, submergedAt, solidBelow, protectedReason, castleProtects }
