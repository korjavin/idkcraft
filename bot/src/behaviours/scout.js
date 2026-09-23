'use strict'

// Scout: pure perception + chat, no brain, no body cost. The bot already
// walks with the player, so every few seconds it looks at the loaded chunks
// around itself (mineflayer keeps them in memory — this sees through walls,
// including ore underground) and reports new veins in chat.
//
// Runs at the every-tick seam in index.js regardless of the brain decision,
// so it keeps working while the bot is following, fighting, or idle.

const ORE_NAMES = [
  'diamond_ore',
  'deepslate_diamond_ore',
  'emerald_ore',
  'deepslate_emerald_ore',
  'ancient_debris',
  'gold_ore',
  'deepslate_gold_ore',
  'iron_ore',
  'deepslate_iron_ore',
  'lapis_ore',
  'deepslate_lapis_ore',
  'redstone_ore',
  'deepslate_redstone_ore',
]

function baseName(name) {
  return name.startsWith('deepslate_') ? name.slice('deepslate_'.length) : name
}

// Report priority: index of the first ORE_NAMES entry that strips to the
// same base name, so deepslate variants share their base rank.
function rankOf(name) {
  const base = baseName(name)
  for (let i = 0; i < ORE_NAMES.length; i++) {
    if (baseName(ORE_NAMES[i]) === base) return i
  }
  return ORE_NAMES.length
}

const { performance } = require('node:perf_hooks')
const metrics = require('../metrics')

function keyOf(p) {
  return `${p.x},${p.y},${p.z}`
}

// Staged search radii (amb): 48 first (the old cheap scan), 96 next, then
// the loaded-chunks boundary. Later stages run only when earlier ones are
// empty, so a nearby vein never pays for a far scan.
//
// mineflayer findBlocks walks 16-block sections in L1 (OctahedronIterator),
// not a sphere: a scan of maxDistance r misses diagonal/deep points still
// within r blocks. The sync scan therefore uses ceil(r*sqrt(3)) — the
// smallest octahedron containing the r-sphere — and results are filtered to
// real distance <= r before ranking, so 'nothing within r' is actually true.
// Measured live: a no-match padded walk costs ~110-160ms at scan ~100 but
// ~700ms at 160 and seconds at 278, so sync covers only the 48 stage; 96
// and 160 run async below, sliced across ticks (the bead's fallback).
const SEARCH_FIRST = 48
const SEARCH_MAX = 160

function scanRadius(r) {
  return Math.ceil(r * Math.sqrt(3))
}

// One far sub-scan: profiled live, the per-section palette check
// (Block.fromStateId per entry) costs ~0.25ms, so an apothem-6 walk (~95ms
// typical) is the biggest slice with real margin under the 0.3 s
// event-loop budget. True coverage is scan/sqrt(3); overlapping rings plus
// the real (wider) scan sphere cover the formal corner gaps.
// count 8: ore-rich centers break after the first layers (3-40ms live) while
// empty centers cost the same walk; merged across centers, recall is kept.
const FAR_SCAN = 88
const FAR_TRUE = 50
const FAR_COUNT = 8
// CPU ms per tick a far search may burn; at most one extra sub-scan past it.
const FAR_TICK_BUDGET_MS = 120
// 26 ray directions (6 axial + 12 edge + 8 corner) x rings: ring 70 covers
// the 48..96 shell, rings 110/150 the 96..160 shell, all with overlap.
const FAR_RINGS = { 96: [70], 160: [70, 110, 150] }

// Loaded-chunks boundary: probe bot.blockAt east of the bot until it reads
// null (unloaded). Real blockAt needs a Vec3 (b50): prefer origin.offset,
// plain {x,y,z} is the mock-bot fallback. Unreadable world -> 48, the old
// behaviour, never 0.
function loadedSearchRadius(bot) {
  const origin = bot && bot.entity && bot.entity.position
  if (!origin || typeof origin.x !== 'number') return SEARCH_FIRST
  const probes = [SEARCH_FIRST, 96, 128, SEARCH_MAX]
  let radius = SEARCH_FIRST
  try {
    for (const d of probes) {
      const q = (typeof origin.offset === 'function')
        ? origin.offset(d, 0, 0)
        : { x: Math.floor(origin.x) + d, y: Math.floor(origin.y), z: Math.floor(origin.z) }
      const b = bot.blockAt && bot.blockAt(q)
      if (b) radius = d
    }
  } catch {
    return SEARCH_FIRST
  }
  return radius
}

function dist(a, b) {
  if (a && typeof a.distanceTo === 'function') return a.distanceTo(b)
  if (b && typeof b.distanceTo === 'function') return b.distanceTo(a)
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
}

function resolveIds(bot, names) {
  const byName = (bot.registry && bot.registry.blocksByName) || {}
  const ids = []
  for (const name of names) {
    const entry = byName[name]
    // Names missing from the registry are skipped, not fatal.
    if (entry && typeof entry.id === 'number') ids.push(entry.id)
  }
  return ids
}

// Name -> ore ids for the 'find me <block>' chat command: the exact
// name, plus every registry block containing <base>_ore (covers
// deepslate_* and nether_* variants). Registry names that are missing
// are skipped, not fatal.
function resolveBlockIds(bot, blockName) {
  const byName = (bot.registry && bot.registry.blocksByName) || {}
  const base = blockName.endsWith('_ore') ? blockName.slice(0, -'_ore'.length) : blockName
  const ids = []
  const exact = byName[blockName]
  if (exact && typeof exact.id === 'number') ids.push(exact.id)
  const pattern = `${base}_ore`
  for (const name of Object.keys(byName)) {
    if (name.includes(pattern)) {
      const entry = byName[name]
      if (entry && typeof entry.id === 'number' && !ids.includes(entry.id)) ids.push(entry.id)
    }
  }
  return ids
}

// 'find me' name resolution: 'ore' means any scout-listed ore, a trailing
// 's' falls back to the singular (diamonds -> diamond); everything else goes
// through resolveBlockIds (exact + <base>_ore variants). No fuzzy search:
// anything still unmatched resolves to no ids ('unknown' downstream).
// Dynamic *_log ids for 'bring me logs' (gather.js logIds, shared): exact
// names vary by wood type, so enumerate the registry like the matcher does.
function resolveLogIds(bot) {
  const byName = (bot.registry && bot.registry.blocksByName) || {}
  const ids = []
  for (const name of Object.keys(byName)) {
    if (!name.endsWith('_log')) continue
    const entry = byName[name]
    if (entry && typeof entry.id === 'number' && !ids.includes(entry.id)) ids.push(entry.id)
  }
  return ids
}

function resolveFindIds(bot, name) {
  if (name === 'ore' || name === 'ores') return resolveIds(bot, ORE_NAMES)
  if (name === 'log' || name === 'logs') return resolveLogIds(bot)
  let ids = resolveBlockIds(bot, name)
  if (ids.length === 0 && name.length > 1 && name.endsWith('s')) {
    const singular = name.slice(0, -1)
    ids = singular === 'ore' ? resolveIds(bot, ORE_NAMES) : resolveBlockIds(bot, singular)
  }
  return ids
}

// A position counts as exposed when a confirmed air block touches it on one
// of the six sides (visible from a cave or the surface). Unloaded (null) or
// unreadable does not count: only confirmed air.
function isExposed(bot, p) {
  if (!bot.blockAt) return false
  const offs = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]
  try {
    for (const [dx, dy, dz] of offs) {
      const q = (p && typeof p.offset === 'function')
        ? p.offset(dx, dy, dz)
        : { x: Math.floor(p.x) + dx, y: Math.floor(p.y) + dy, z: Math.floor(p.z) + dz }
      const b = bot.blockAt(q)
      if (b && (b.name === 'air' || b.name === 'cave_air')) return true
    }
  } catch {
    return false
  }
  return false
}

// Scan helper, exported for the 'find me <block>' chat command:
// block name -> nearest loaded position; null when the name resolves but
// nothing is nearby; 'unknown' when the name matches no block at all so the
// caller can answer 'unknown block'.
// Ranking: exposed ore first (lead the player somewhere walkable, not into
// solid rock), then closest in height to refY (the requesting player's Y;
// the bot's own when unknown), then nearest by straight distance.
function findNearestBlock(bot, blockName, refY = null) {
  const ids = resolveFindIds(bot, blockName)
  if (ids.length === 0) return 'unknown'
  const from = bot.entity && bot.entity.position
  let scanned = null
  const t0 = performance.now()
  try {
    scanned = bot.findBlocks({ matching: ids, maxDistance: scanRadius(SEARCH_FIRST), count: 64 })
  } catch {
    return null
  }
  const tookMs = performance.now() - t0
  const found = from
    ? (scanned || []).filter((q) => dist(q, from) <= SEARCH_FIRST)
    : (scanned || [])
  console.log(`search ${blockName} r=${SEARCH_FIRST} took=${tookMs.toFixed(1)}ms found=${found.length}`)
  try { metrics.searchDuration.observe({ radius: String(SEARCH_FIRST) }, tookMs / 1000) } catch { /* metrics never break search */ }
  if (found.length === 0) return null
  return rankHits(bot, found, refY)
}

// Shared ranking: exposed first (walkable, not solid rock), then closest in
// height to refY, then nearest by straight distance. Capped to the nearest
// 64 by distance first: a far search can merge hundreds of hits, and each
// exposure check costs up to six blockAt reads on the completion tick.
function rankHits(bot, found, refY = null) {
  const origin = bot.entity && bot.entity.position
  if (origin && found.length > 64) {
    found = [...found].sort((a, b) => dist(a, origin) - dist(b, origin)).slice(0, 64)
  }
  const y0 = typeof refY === 'number' ? refY
    : (origin && typeof origin.y === 'number' ? origin.y : null)
  let best = found[0]
  let bestScore = scoreOf(found[0])
  for (const p of found) {
    const sc = scoreOf(p)
    if (compareScore(sc, bestScore) < 0) {
      best = p
      bestScore = sc
    }
  }
  return best

  function scoreOf(p) {
    const exposed = isExposed(bot, p) ? 0 : 1
    const dy = y0 != null && typeof p.y === 'number' ? Math.abs(p.y - y0) : 0
    const d = origin ? dist(p, origin) : 0
    return [exposed, dy, d]
  }
}

// Far search (amb): shells beyond the sync 48, sliced across ticks. A cursor
// holds ring centers nearest-first; stepFarSearch runs sub-scans until the
// per-tick CPU budget is spent and returns done + the ranked hit (or null).
// Coverage is exact by construction: padded sub-scans, merged, deduped,
// filtered to real distance. Returns null immediately when the loaded edge
// leaves no ring (unreadable world): the caller answers from sync alone.
function farDirs() {
  const dirs = []
  for (const s of [-1, 1]) {
    dirs.push([s, 0, 0], [0, s, 0], [0, 0, s])
    for (const t of [-1, 1]) {
      dirs.push([s, t, 0], [s, 0, t], [0, s, t])
      for (const u of [-1, 1]) dirs.push([s, t, u])
    }
  }
  return dirs
}

function startFarSearch(bot, blockName, refY = null) {
  const ids = resolveFindIds(bot, blockName)
  if (ids.length === 0) return 'unknown'
  const origin = bot.entity && bot.entity.position
  if (!origin || typeof origin.x !== 'number') return null
  const edge = loadedSearchRadius(bot)
  const rings = (FAR_RINGS[SEARCH_MAX] || []).filter((ring) => ring <= edge)
  if (rings.length === 0) return null
  const queue = []
  for (const ring of rings) {
    for (const [dx, dy, dz] of farDirs()) {
      const len = Math.sqrt(dx * dx + dy * dy + dz * dz)
      const k = ring / len
      queue.push({ ring, dx: dx * k, dy: dy * k, dz: dz * k })
    }
  }
  return { blockName, ids, refY, queue, at: 0, hits: new Map(), stageMs: {}, stageScans: {} }
}

// True once the completed ring's shell holds a hit inside its claim:
// ring 70 covers (48..96], rings 110/150 the (96..160] shell.
function farShellDone(cursor, bot, ring) {
  const origin = bot.entity && bot.entity.position
  if (!origin) return false
  const edge = ring === 70 ? 96 : SEARCH_MAX
  for (const q of cursor.hits.values()) {
    if (dist(q, origin) <= edge) return true
  }
  return false
}

function stepFarSearch(bot, cursor) {
  if (!cursor || cursor === 'unknown') return { done: true, result: cursor }
  const origin = bot.entity && bot.entity.position
  if (!origin) return { done: true, result: null }
  const t0 = performance.now()
  let lastRing = cursor.at > 0 ? cursor.queue[cursor.at - 1].ring : null
  while (cursor.at < cursor.queue.length) {
    if (performance.now() - t0 > FAR_TICK_BUDGET_MS && cursor.at > 0) break
    const c = cursor.queue[cursor.at++]
    // Ring completed: a nearer shell with hits closes the search (the next
    // stage runs only when the previous came up empty).
    if (lastRing !== null && c.ring !== lastRing) {
      if (farShellDone(cursor, bot, lastRing)) {
        cursor.at = cursor.queue.length
        break
      }
    }
    lastRing = c.ring
    const center = (typeof origin.offset === 'function')
      ? origin.offset(c.dx, c.dy, c.dz)
      : { x: origin.x + c.dx, y: origin.y + c.dy, z: origin.z + c.dz }
    let scanned = null
    const s0 = performance.now()
    try {
      scanned = bot.findBlocks({ matching: cursor.ids, maxDistance: FAR_SCAN, count: FAR_COUNT, point: center }) || []
    } catch {
      continue
    }
    const dt = performance.now() - s0
    cursor.stageMs[c.ring] = (cursor.stageMs[c.ring] || 0) + dt
    cursor.stageScans[c.ring] = (cursor.stageScans[c.ring] || 0) + 1
    for (const q of scanned) {
      if (dist(q, origin) > SEARCH_MAX) continue
      const key = keyOf(q)
      if (!cursor.hits.has(key)) cursor.hits.set(key, q)
    }
  }
  if (cursor.at < cursor.queue.length) {
    // Slow truth, fast walkability: a fully covered shell is needed for an
    // honest negative, but one exposed (walkable) hit inside the claimed
    // shell already answers the request with an honest distance — nearer
    // unscanned hits stay a best-effort miss, same as the count cap. Buried
    // hits alone never stop the search: a walkable vein may be one tick out.
    const edge = cursor.queue[cursor.at].ring === 70 ? 96 : SEARCH_MAX
    for (const q of cursor.hits.values()) {
      if (dist(q, origin) > edge) continue
      let exposed = false
      try { exposed = isExposed(bot, q) } catch { exposed = false }
      if (exposed) {
        cursor.at = cursor.queue.length
        break
      }
    }
  }
  if (cursor.at < cursor.queue.length) return { done: false, result: null }
  for (const ring of Object.keys(cursor.stageMs).sort((a, b) => a - b)) {
    const edge = ring === '70' ? 96 : SEARCH_MAX
    console.log(`search ${cursor.blockName} r=${edge} took=${cursor.stageMs[ring].toFixed(1)}ms found=${cursor.hits.size} scans=${cursor.stageScans[ring]}`)
    try { metrics.searchDuration.observe({ radius: String(edge) }, cursor.stageMs[ring] / 1000) } catch { /* never break search */ }
  }
  const within96 = [...cursor.hits.values()].filter((q) => dist(q, origin) <= 96)
  const pool = within96.length > 0 ? within96 : [...cursor.hits.values()]
  if (pool.length === 0) return { done: true, result: null }
  return { done: true, result: wrapResult(bot, cursor.blockName, rankHits(bot, pool, cursor.refY)) }
}

function compareScore(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] - b[i]
  }
  return 0
}

// Display wrapper: registry-canonical name at the hit, rounded straight
// distance, and the exposed flag bring uses for its buried refusal.
function wrapResult(bot, blockName, p) {
  const origin = bot.entity && bot.entity.position
  const distance = origin ? Math.round(dist(p, origin)) : 0
  let name = blockName
  try {
    const block = bot.blockAt && bot.blockAt(p)
    if (block && block.name) name = block.name
  } catch {
    name = blockName
  }
  let exposed = false
  try { exposed = isExposed(bot, p) } catch { exposed = false }
  return { name, position: p, distance, exposed }
}

function findNearest(bot, blockName, refY = null) {
  const p = findNearestBlock(bot, blockName, refY)
  if (p === 'unknown') return 'unknown'
  if (!p) return null
  return wrapResult(bot, blockName, p)
}

function makeScout(bot, { everyMs = 5000, radius = 16, say = bot.chat, now = () => Date.now(), maxSeen = 5000 } = {}) {
  const oreIds = resolveIds(bot, ORE_NAMES)
  const seen = new Set()
  let lastScan = 0

  function tick() {
    const t = now()
    if (t - lastScan < everyMs) return
    lastScan = t
    let found = []
    try {
      found = bot.findBlocks({ matching: oreIds, maxDistance: radius, count: 64 }) || []
    } catch {
      return
    }
    const fresh = new Map() // base ore name -> new positions
    for (const p of found) {
      const key = keyOf(p)
      if (seen.has(key)) continue
      seen.add(key)
      let name = null
      try {
        const block = bot.blockAt(p)
        name = block && block.name
      } catch {
        name = null
      }
      if (!name) continue
      const base = baseName(name)
      if (!fresh.has(base)) fresh.set(base, [])
      fresh.get(base).push(p)
    }
    // ponytail: bounded memory, LRU if it ever matters.
    if (seen.size > maxSeen) seen.clear()
    const names = [...fresh.keys()].sort((a, b) => rankOf(a) - rankOf(b)).slice(0, 3)
    const origin = bot.entity && bot.entity.position
    for (const name of names) {
      const spots = fresh.get(name)
      let nearest = spots[0]
      if (origin) {
        for (const p of spots) {
          if (dist(p, origin) < dist(nearest, origin)) nearest = p
        }
      }
      const line = `${name} x${spots.length} at ${nearest.x} ${nearest.y} ${nearest.z}`
      say.call(bot, line)
      console.log(`scout ${line}`)
    }
  }

  return { tick }
}

module.exports = { makeScout, findNearestBlock, findNearest, startFarSearch, stepFarSearch, resolveBlockIds, resolveFindIds, isExposed, loadedSearchRadius, ORE_NAMES }
