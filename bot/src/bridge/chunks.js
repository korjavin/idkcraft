// idkcraft-neuc.6: chunk cache for the Baritone-body bridge.
//
// The mod streams chunk sections as global block-state-id arrays
// (chunk.get / chunks.list, block.update notifications); this module
// fills prismarine-chunk columns in a prismarine-world WorldSync so
// bot.blockAt / bot.findBlocks / bot.world.raycast are the SYNC local
// reads mineflayer gives v1 — full prismarine-block parity (hardness,
// harvestTools, shapes, boundingBox) from the passed-through registry,
// zero per-read bridge traffic. Misses read null (unloaded), exactly
// like mineflayer. No new npm deps: prismarine-* arrive via mineflayer;
// they are loaded through mineflayer's own module paths so the bridge
// self-containment test (declared deps only) stays green.
// This file requires nothing outside bot/src/bridge/ (epic section 2).
'use strict'

const { createRequire } = require('node:module')

// Load a prismarine package the way mineflayer does: try the hoisted
// copy first, then mineflayer's nested copy. Never a new dependency.
function loadPrismarine(name) {
  try { return require(name) } catch (_) { /* fall through to nested */ }
  const mineflayerRequire = createRequire(require.resolve('mineflayer/package.json'))
  return mineflayerRequire(name)
}

let cachedFor = null
let cachedPkgs = null
function prismarine(registry) {
  if (cachedPkgs && cachedFor === registry) return cachedPkgs
  const World = loadPrismarine('prismarine-world')(registry)
  const Chunk = loadPrismarine('prismarine-chunk')(registry)
  const Block = loadPrismarine('prismarine-block')(registry)
  const { OctahedronIterator } = loadPrismarine('prismarine-world').iterators
  cachedFor = registry
  cachedPkgs = { World, Chunk, Block, OctahedronIterator }
  return cachedPkgs
}

// A registry usable for prismarine construction carries a version and
// block state ids; the tiny fake registries in unit tests do not.
function registryUsable(registry) {
  return !!(registry && registry.version && registry.blocksByName &&
    registry.blocksByName.stone && typeof registry.blocksByName.stone.defaultState === 'number')
}

function ensureWorld(bot) {
  if (bot.world) return bot.world
  if (!registryUsable(bot.registry)) return null
  try {
    const { World } = prismarine(bot.registry)
    bot.world = new World(null).sync
    if (!bot.game || typeof bot.game !== 'object') bot.game = {}
    if (typeof bot.game.minY !== 'number') bot.game.minY = -64
    if (typeof bot.game.height !== 'number') bot.game.height = 384
    return bot.world
  } catch (_) {
    return null
  }
}

// Decode one wire section: base64 int16-LE global state ids, index
// (y<<8)|(z<<4)|x over the section-local cube; null = all air.
function applyChunk(bot, payload) {
  const world = ensureWorld(bot)
  if (!world || !payload || typeof payload.cx !== 'number' || typeof payload.cz !== 'number') return false
  const { Chunk } = prismarine(bot.registry)
  const sections = Array.isArray(payload.sections) ? payload.sections : []
  const minY = typeof payload.minY === 'number' ? payload.minY : -64
  const worldHeight = sections.length > 0 ? sections.length * 16 : (bot.game.height || 384)
  const column = new Chunk({ minY, worldHeight })
  for (const sec of sections) {
    if (!sec || typeof sec.y !== 'number' || sec.states == null) continue
    const buf = Buffer.from(String(sec.states), 'base64')
    const count = Math.min(4096, Math.floor(buf.length / 2))
    const baseY = sec.y * 16
    for (let i = 0; i < count; i++) {
      const stateId = buf.readInt16LE(i * 2)
      if (stateId === 0) continue // air is the column default
      column.setBlockStateId({ x: i & 15, y: baseY + ((i >> 8) & 15), z: (i >> 4) & 15 }, stateId)
    }
  }
  world.setColumn(payload.cx, payload.cz, column)
  bot.game.minY = minY
  bot.game.height = worldHeight
  if (!bot._chunkCols) bot._chunkCols = new Set()
  bot._chunkCols.add(`${payload.cx},${payload.cz}`)
  return true
}

function unloadChunk(bot, cx, cz) {
  if (bot.world && typeof bot.world.unloadColumn === 'function') {
    try { bot.world.unloadColumn(cx, cz) } catch (_) { /* already gone */ }
  }
  if (bot._chunkCols) bot._chunkCols.delete(`${cx},${cz}`)
}

// One block.update cell. Returns [oldBlock, newBlock] (either may be
// null when the column is not loaded — the caller then stays silent,
// like mineflayer's updateBlockState).
function applyBlockUpdate(bot, p) {
  const world = ensureWorld(bot)
  if (!world || !p || typeof p.x !== 'number' || typeof p.stateId !== 'number') return [null, null]
  const pos = new bot.Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z))
  let oldBlock = null
  try { oldBlock = world.getBlock(pos) } catch (_) { oldBlock = null }
  if (!oldBlock) return [null, null]
  try { world.setBlockStateId(pos, p.stateId) } catch (_) { return [oldBlock, oldBlock] }
  let newBlock = null
  try { newBlock = world.getBlock(pos) } catch (_) { newBlock = null }
  return [oldBlock, newBlock]
}

// --- initial fill + steady-state fetching -----------------------------
// On the first poll round: chunks.list, columns within NEAR_CHUNKS of
// the body load at once, the rest trickle at <=4 per 100 ms. New
// chunk.loaded notifications jump the queue. Fetches are deduplicated
// by the loaded/loading sets; failures stay unloaded (blockAt null).

const NEAR_CHUNKS = 4
const BG_PER_TICK = 4
const BG_MS = 100

// neuc.33: the ring an order waits for (48 blocks: the sync find radius).
const HOLD_CHUNKS = 3

const MAX_INFLIGHT = 4 // chunk.get replies are 100 KB+ and the mod serves one connection serially

function chunkState(bot) {
  if (!bot._chunks) {
    bot._chunks = {
      listed: false, unsupported: false, loading: new Set(), retried: new Set(), reload: new Set(),
      queue: [], queued: new Set(), gens: new Map(), inflight: 0, timer: null,
      held: new Map(), // neuc.33: block.update cells that landed while their column was in flight
    }
  }
  return bot._chunks
}

function queueColumn(bot, transport, cx, cz, front = false) {
  const st = chunkState(bot)
  const key = `${cx},${cz}`
  if (st.loading.has(key) || st.queued.has(key)) return
  if (bot._chunkCols && bot._chunkCols.has(key)) return
  st.queued.add(key)
  if (front) st.queue.unshift([cx, cz])
  else st.queue.push([cx, cz])
  scheduleBackground(bot, transport)
}

async function fetchColumn(bot, transport, cx, cz) {
  const st = chunkState(bot)
  const key = `${cx},${cz}`
  if (st.loading.has(key)) return
  if (bot._chunkCols && bot._chunkCols.has(key)) return
  if (st.inflight >= MAX_INFLIGHT) { queueColumn(bot, transport, cx, cz, true); return } // near-first: front, not behind the far queue
  st.loading.add(key)
  st.inflight++
  const gen = st.gens.get(key) || 0
  let retry = false
  try {
    const payload = await transport.call('chunk.get', { cx, cz })
    // An unload during the await wins: the reply is stale (or the empty
    // placeholder column) and must not resurrect the column (revmux 01 core-2).
    if (payload && (st.gens.get(key) || 0) === gen) {
      applyChunk(bot, payload)
      st.retried.delete(key)
      // neuc.33: the snapshot may predate updates pushed mid-fetch (the
      // mod pushes on receipt, applies on the client thread): replay them.
      for (const u of st.held.get(key) || []) applyBlockUpdate(bot, u)
    }
  } catch (_) {
    // A column that raced an unload (or a busy client thread) retries
    // once in the background; after that it stays unloaded until the
    // next chunk.loaded for it.
    if (!bot._quitting && (st.gens.get(key) || 0) === gen && !st.retried.has(key)) {
      st.retried.add(key)
      retry = true // queued in finally: queueColumn skips keys still in st.loading
    }
  } finally {
    st.inflight--
    st.loading.delete(key)
    st.held.delete(key)
    if (retry && !bot._quitting) queueColumn(bot, transport, cx, cz)
    // A chunk.loaded that arrived mid-fetch asked for a refetch of the
    // (possibly reloaded) column; the reply above may predate it.
    if (st.reload.delete(key) && !bot._quitting) {
      if (bot._chunkCols) bot._chunkCols.delete(key) // force the refetch past the dedup
      queueColumn(bot, transport, cx, cz)
    }
  }
}

function bodyChunk(bot) {
  const bp = (bot.entity && bot.entity.position) || { x: 0, z: 0 }
  return [Math.floor(bp.x / 16), Math.floor(bp.z / 16)]
}

// neuc.33: nearest-to-the-body first, measured at pop time. After a
// teleport the whole new view arrives classified against the OLD position
// (state.get lags the chunk stream), and FIFO put the body's own columns
// behind hundreds of others (~8 columns/s over the bridge).
// ponytail: O(queue) scan per pop (<= ~600 entries, 40 pops/s).
function takeNearest(bot, st) {
  const [bcx, bcz] = bodyChunk(bot)
  let best = 0
  let bestD = Infinity
  for (let i = 0; i < st.queue.length; i++) {
    const [cx, cz] = st.queue[i]
    const d = Math.max(Math.abs(cx - bcx), Math.abs(cz - bcz))
    if (d < bestD) { bestD = d; best = i }
  }
  return st.queue.splice(best, 1)[0]
}

// neuc.33: columns within r of the body the cache still waits for
// (announced by chunk.loaded, queued or in flight). Never-announced or
// given-up columns are not pending: they read null, like mineflayer.
function nearPending(bot, r = HOLD_CHUNKS) {
  const st = bot._chunks
  if (!st) return false
  const [bcx, bcz] = bodyChunk(bot)
  for (let dx = -r; dx <= r; dx++) {
    for (let dz = -r; dz <= r; dz++) {
      const key = `${bcx + dx},${bcz + dz}`
      if (st.queued.has(key) || st.loading.has(key)) return true
    }
  }
  return false
}

function scheduleBackground(bot, transport) {
  const st = chunkState(bot)
  if (st.timer || st.queue.length === 0) return
  st.timer = setInterval(() => {
    if (bot._quitting) { clearInterval(st.timer); st.timer = null; return }
    let n = Math.min(BG_PER_TICK, MAX_INFLIGHT - st.inflight)
    while (n-- > 0 && st.queue.length > 0) {
      const [cx, cz] = takeNearest(bot, st)
      st.queued.delete(`${cx},${cz}`)
      void fetchColumn(bot, transport, cx, cz)
    }
    if (st.queue.length === 0) { clearInterval(st.timer); st.timer = null }
  }, BG_MS)
  if (typeof st.timer.unref === 'function') st.timer.unref()
}

async function refreshChunks(bot, transport) {
  const st = chunkState(bot)
  if (st.listed || st.unsupported) return
  if (!ensureWorld(bot)) return // no real registry yet: retry next round
  let list
  try {
    list = await transport.call('chunks.list', {})
  } catch (e) {
    // Only a method-not-found means an old mod (unsupported for good);
    // a transient timeout retries on the next round (revmux 01 core-3).
    if (/unknown method|-32601/.test(String((e && e.message) || e))) st.unsupported = true
    return
  }
  const cols = list && Array.isArray(list.columns) ? list.columns : []
  // An empty list while in world means the mod's packet-fed set has not
  // caught up (it reconciles per call): keep retrying on later rounds.
  if (cols.length === 0 && bot._hasPos) return
  st.listed = true
  const bp = (bot.entity && bot.entity.position) || { x: 0, z: 0 }
  const bcx = Math.floor(bp.x / 16)
  const bcz = Math.floor(bp.z / 16)
  const near = []
  const far = []
  for (const c of cols) {
    if (!c || typeof c.cx !== 'number' || typeof c.cz !== 'number') continue
    const d = Math.max(Math.abs(c.cx - bcx), Math.abs(c.cz - bcz))
    if (d <= NEAR_CHUNKS) near.push([c.cx, c.cz])
    else far.push([c.cx, c.cz])
  }
  // Near first, far queued only after (revmux 02 core-2).
  await Promise.all(near.map(([cx, cz]) => fetchColumn(bot, transport, cx, cz)))
  for (const [cx, cz] of far) queueColumn(bot, transport, cx, cz)
  scheduleBackground(bot, transport)
}

// Notification half: chunk.loaded / chunk.unloaded / block.update.
// Returns true when consumed. blockUpdate emits here (old, new) with
// mineflayer's shape; index.js's router lets this run first.
function handleChunkEvent(bot, transport, method, params) {
  const p = params || {}
  if (method === 'chunk.loaded') {
    if (typeof p.cx === 'number' && typeof p.cz === 'number') {
      const st = chunkState(bot)
      st.unsupported = false
      st.retried.delete(`${p.cx},${p.cz}`)
      // A (re)load always refetches: a stale column from a raced unload
      // must not survive it (revmux 01 core-2). Mid-fetch, the refetch
      // is armed for fetchColumn's finally (revmux 02 core-1).
      if (st.loading.has(`${p.cx},${p.cz}`)) st.reload.add(`${p.cx},${p.cz}`)
      if (bot._chunkCols) bot._chunkCols.delete(`${p.cx},${p.cz}`)
      // Near columns fetch now; the rest join the throttled background
      // queue — the login stream is ~441 columns (revmux 01 body-2).
      const bp = (bot.entity && bot.entity.position) || { x: 0, z: 0 }
      const d = Math.max(Math.abs(p.cx - Math.floor(bp.x / 16)), Math.abs(p.cz - Math.floor(bp.z / 16)))
      if (d <= NEAR_CHUNKS) void fetchColumn(bot, transport, p.cx, p.cz)
      else queueColumn(bot, transport, p.cx, p.cz)
    }
    return true
  }
  if (method === 'chunk.unloaded') {
    if (typeof p.cx === 'number' && typeof p.cz === 'number') {
      const st = chunkState(bot)
      const key = `${p.cx},${p.cz}`
      st.gens.set(key, (st.gens.get(key) || 0) + 1) // in-flight fetches drop their reply
      st.retried.delete(key)
      // neuc.33: a queued fetch of a gone column is a wasted (failing) call.
      if (st.queued.delete(key)) st.queue = st.queue.filter(([cx, cz]) => cx !== p.cx || cz !== p.cz)
      unloadChunk(bot, p.cx, p.cz)
    }
    return true
  }
  if (method === 'block.update') {
    // neuc.33: a column in flight also replays it onto the reply (whose
    // snapshot may predate it); a cached column being re-fetched still
    // applies and emits now, as before.
    if (typeof p.x === 'number' && typeof p.z === 'number' && bot._chunks) {
      const key = `${Math.floor(p.x / 16)},${Math.floor(p.z / 16)}`
      const st = bot._chunks
      if (st.loading.has(key)) {
        if (!st.held.has(key)) st.held.set(key, [])
        st.held.get(key).push(p)
      }
    }
    const [oldBlock, newBlock] = applyBlockUpdate(bot, p)
    if (newBlock) bot.emit('blockUpdate', oldBlock, newBlock)
    return true
  }
  return false
}

function stopChunks(bot) {
  const st = bot._chunks
  if (st && st.timer) { clearInterval(st.timer); st.timer = null }
}

// --- mineflayer sync surface (blocks.js semantics, cited) -------------

// Port of mineflayer lib/plugins/blocks.js findBlocks (~60 lines over
// world columns): OctahedronIterator over sections, palette pre-check,
// nearest-first sort, count slice. useExtraInfo semantics identical.
function findBlocks(bot, options = {}) {
  const world = ensureWorld(bot)
  if (!world) return []
  const { Block, OctahedronIterator } = prismarine(bot.registry)
  const matching = options.matching
  let matcher
  if (typeof matching === 'function') matcher = matching
  else {
    const types = Array.isArray(matching) ? matching : [matching]
    matcher = (block) => block !== null && types.indexOf(block.type) >= 0
  }
  const pointOpt = options.point || (bot.entity && bot.entity.position)
  if (!pointOpt) return []
  const point = typeof pointOpt.floored === 'function' ? pointOpt.floored() : { x: Math.floor(pointOpt.x), y: Math.floor(pointOpt.y), z: Math.floor(pointOpt.z) }
  const maxDistance = options.maxDistance || 16
  const count = options.count || 1
  const useExtraInfo = options.useExtraInfo || false
  const Vec3 = bot.Vec3
  // mineflayer getFullMatchingFunction, verbatim shapes:
  const matchAt = typeof useExtraInfo === 'boolean'
    ? (cursor) => matcher(bot.blockAt(cursor, useExtraInfo))
    : (cursor) => { const b = bot.blockAt(cursor, true); return matcher(b) && useExtraInfo(b) }
  const minY = typeof bot.game.minY === 'number' ? bot.game.minY : -64
  const height = typeof bot.game.height === 'number' ? bot.game.height : 384
  const start = new Vec3(Math.floor(point.x / 16), Math.floor(point.y / 16), Math.floor(point.z / 16))
  const it = new OctahedronIterator(start, Math.ceil((maxDistance + 8) / 16))
  const visitedSections = new Set()
  let blocks = []
  let startedLayer = 0
  let next = start
  while (next) {
    const column = world.getColumn(next.x, next.z)
    const sectionY = next.y + Math.abs(minY >> 4)
    const totalSections = height >> 4
    if (sectionY >= 0 && sectionY < totalSections && column && !visitedSections.has(next.toString())) {
      const section = column.sections[sectionY]
      let inSection = useExtraInfo === true
      if (!inSection && section) {
        if (section.palette) {
          for (const stateId of section.palette) {
            let probe = null
            try { probe = Block.fromStateId(stateId, 0) } catch (_) { probe = null }
            if (probe && matcher(probe)) { inSection = true; break }
          }
        } else inSection = true
      }
      if (section && inSection) {
        const begin = new Vec3(next.x * 16, sectionY * 16 + minY, next.z * 16)
        const cursor = begin.clone()
        const end = cursor.offset(16, 16, 16)
        for (cursor.x = begin.x; cursor.x < end.x; cursor.x++) {
          for (cursor.y = begin.y; cursor.y < end.y; cursor.y++) {
            for (cursor.z = begin.z; cursor.z < end.z; cursor.z++) {
              if (matchAt(cursor) && cursor.distanceTo(point) <= maxDistance) blocks.push(cursor.clone())
            }
          }
        }
      }
      visitedSections.add(next.toString())
    }
    if (startedLayer !== it.apothem && blocks.length >= count) break
    startedLayer = it.apothem
    next = it.next()
  }
  blocks.sort((a, b) => a.distanceTo(point) - b.distanceTo(point))
  if (blocks.length > count) blocks = blocks.slice(0, count)
  return blocks
}

function findBlock(bot, options = {}) {
  const blocks = findBlocks(bot, options)
  if (blocks.length === 0) return null
  return bot.blockAt(blocks[0])
}

// mineflayer canSeeBlock (blocks.js): raycast from the eyes to the
// block centre; the first shape hit must be the block itself.
function canSeeBlock(bot, block) {
  const world = ensureWorld(bot)
  if (!world || !block || !block.position || !bot.entity || !bot.entity.position) return false
  try {
    const eyeHeight = typeof bot.entity.eyeHeight === 'number' ? bot.entity.eyeHeight : 1.62
    const headPos = bot.entity.position.offset(0, eyeHeight, 0)
    const range = headPos.distanceTo(block.position)
    const dir = block.position.offset(0.5, 0.5, 0.5).minus(headPos)
    const match = (inputBlock, iter) => {
      const intersect = iter.intersect(inputBlock.shapes, inputBlock.position)
      if (intersect) return true
      return block.position.equals(inputBlock.position)
    }
    const hit = world.raycast(headPos, dir.normalize(), range, match)
    return !!(hit && hit.position.equals(block.position))
  } catch (_) {
    return false
  }
}

module.exports = {
  ensureWorld, applyChunk, unloadChunk, applyBlockUpdate,
  refreshChunks, handleChunkEvent, stopChunks, nearPending,
  findBlocks, findBlock, canSeeBlock, registryUsable,
}
