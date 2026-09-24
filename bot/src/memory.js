'use strict'

// Disk memory (idkcraft-hlk): homes, resource finds, explored chunks and
// danger spots survive bot restart/redeploy. One JSON file on a named
// volume (/app/memory/<BOT_USERNAME>.json), atomic write (tmp + rename),
// throttled periodic save plus save on setHome and on disconnect. Load runs
// before spawn adoption; a missing, corrupt or other-world file means empty
// memory, never a crash. No decision logic — only the existing stores
// (home shape, resources.js, explore visited, danger.js), serialized.

const fs = require('node:fs')
const path = require('node:path')
const Vec3 = require('vec3')
const resources = require('./resources')
const danger = require('./danger')

const VERSION = 1
const DIR_DEFAULT = '/app/memory'
const SAVE_MIN_MS = 45000 // periodic tick save at most this often
const VISITED_MAX = 4096 // MAX_RADIUS 512 spiral holds ~3.2k chunks
const HOMES_MAX = 8

function safeName(name) {
  const s = typeof name === 'string' && name ? name : 'IdkBot'
  return (s.replace(/[^A-Za-z0-9_.-]+/g, '_').slice(0, 64) || 'IdkBot')
}

function fileFor(env, username) {
  try {
    const e = env || {}
    if (typeof e.BOT_MEMORY_FILE === 'string' && e.BOT_MEMORY_FILE) return e.BOT_MEMORY_FILE
    return path.join(DIR_DEFAULT, `${safeName(username)}.json`)
  } catch (_) {
    return path.join(DIR_DEFAULT, 'IdkBot.json')
  }
}

// World identity: world spawn is fixed per world (mineflayer exposes no
// level name/seed, so spawn coords are the key, plus the level name when a
// future bot exposes one). A moved spawn or a fresh world on the same
// ground reads as a new world — accepted: memory then skips a run instead
// of misleading it.
function worldKey(bot) {
  try {
    const parts = []
    const lvl = bot && bot.game && typeof bot.game.levelName === 'string' ? bot.game.levelName : null
    if (lvl) parts.push(`level:${lvl}`)
    const sp = bot && bot.spawnPoint
    if (sp && typeof sp.x === 'number' && typeof sp.z === 'number') {
      parts.push(`spawn:${Math.round(sp.x)},${Math.round(sp.y || 0)},${Math.round(sp.z)}`)
    }
    return parts.length ? parts.join('|') : null
  } catch (_) {
    return null
  }
}

function num(n) {
  return typeof n === 'number' && Number.isFinite(n) ? n : null
}

function pt(p) {
  if (!p) return null
  const x = num(p.x)
  const y = num(p.y)
  const z = num(p.z)
  return x === null || y === null || z === null ? null : { x, y, z }
}

// Revive to Vec3 (revmux 01-review): producers (adoptHome, build) store
// home coords as Vec3 and consumers (craft's blockAt(table)) need the
// methods — a plain {x,y,z} throws inside prismarine-world and craft then
// walks to the table forever instead of crafting.
function v3(p) {
  const q = pt(p)
  return q ? new Vec3(q.x, q.y, q.z) : null
}

function homeOf(h) {
  if (!h || !h.site) return null
  const site = v3(h.site)
  if (!site) return null
  const out = { site, interior: null, door: v3(h.door), table: v3(h.table), built: h.built === true }
  try {
    if (h.interior && h.interior.min && h.interior.max) {
      const min = v3(h.interior.min)
      const max = v3(h.interior.max)
      if (min && max) out.interior = { min, max }
    }
  } catch (_) { /* interior best-effort */ }
  return out
}

function sameSite(a, b) {
  try {
    return !!a && !!b && !!a.site && !!b.site &&
      a.site.x === b.site.x && a.site.y === b.site.y && a.site.z === b.site.z
  } catch (_) {
    return false
  }
}

function snapshot(bot, ctx, now) {
  const world = worldKey(bot)
  if (!world || !ctx) return null
  const t = typeof now === 'number' ? now : Date.now()
  const homes = []
  const cur = homeOf(ctx.home)
  if (cur) homes.push(cur)
  let items = []
  try {
    const mem = ctx.resources
    if (mem && mem.items instanceof Map) {
      for (const r of mem.items.values()) {
        if (!r || typeof r.name !== 'string') continue
        const p = pt(r)
        if (!p) continue
        items.push({ x: p.x, y: p.y, z: p.z, name: r.name })
      }
      items = items.slice(-resources.MAX_ITEMS)
    }
  } catch (_) { /* resources best-effort */ }
  let visited = []
  try {
    const e = ctx.explore
    if (e && e.visited instanceof Set) {
      visited = [...e.visited].filter((k) => typeof k === 'string' && /^-?\d+,-?\d+$/.test(k))
      visited = visited.slice(-VISITED_MAX)
    }
  } catch (_) { /* visited best-effort */ }
  let follow = null
  try {
    if (ctx && typeof ctx.followName === 'string' && ctx.followName) follow = ctx.followName
  } catch (_) { /* follow best-effort */ }
  let spots = []
  try {
    const mem = ctx.danger
    if (mem && Array.isArray(mem.spots)) {
      for (const s of mem.spots) {
        const p = pt(s)
        if (!p) continue
        const at = num(s.at)
        if (at === null || t - at > danger.TTL_MS) continue
        spots.push({ x: p.x, y: p.y, z: p.z, at })
      }
      spots = spots.slice(-danger.MAX_SPOTS)
    }
  } catch (_) { /* danger best-effort */ }
  return { v: VERSION, world, savedAt: t, homes, resources: items, visited, danger: spots, follow }
}

function readDoc(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

// Save ctx stores to file (default: memory file for this bot). Atomic
// tmp+rename; never creates directories (the volume/Dockerfile provide the
// dir, so a missing dir just fails clean). Merges the previous homes list
// of the same world — the bot keeps one current home, the file keeps the
// list with current last. Returns true on write.
function save(bot, ctx, file, now) {
  let f = null
  let tmp = null
  try {
    const doc = snapshot(bot, ctx, now)
    if (!doc) return false
    // An empty snapshot carries no information (revmux 01-review): writing
    // it would clobber a real file with nothing — e.g. an 'end' before the
    // spawn handler ever restored. Skip the write entirely.
    if (!doc.homes.length && !doc.resources.length && !doc.visited.length && !doc.danger.length && !doc.follow) return false
    f = file || fileFor(process.env, bot && bot.username)
    try {
      const prev = readDoc(f)
      if (prev && prev.v === VERSION && prev.world === doc.world && Array.isArray(prev.homes)) {
        const cur = doc.homes[doc.homes.length - 1]
        const merged = prev.homes.filter((h) => homeOf(h) && (cur ? !sameSite(h, cur) : true))
        if (cur) merged.push(cur)
        doc.homes = merged.slice(-HOMES_MAX)
      }
    } catch (_) { /* first save, corrupt or other world: fresh list */ }
    tmp = `${f}.tmp-${process.pid}`
    fs.writeFileSync(tmp, JSON.stringify(doc))
    fs.renameSync(tmp, f)
    lastSave = { at: doc.savedAt, path: f }
    return true
  } catch (_) {
    if (tmp) {
      try { fs.unlinkSync(tmp) } catch (_) { /* tmp best-effort */ }
    }
    return false
  }
}

// Restore file stores into ctx. Adopt-before-restore is the caller's job:
// this only fills ctx.home (last stored home), resources, explore visited
// and danger (expired marks dropped). Returns counts, or null when there
// is no usable memory (missing/corrupt/other-world file). Never throws.
function restore(bot, ctx, file, now) {
  try {
    if (!ctx) return null
    const f = file || fileFor(process.env, bot && bot.username)
    const doc = readDoc(f)
    if (!doc || doc.v !== VERSION || typeof doc.world !== 'string') return null
    const world = worldKey(bot)
    if (!world || doc.world !== world) return null
    const t = typeof now === 'number' ? now : Date.now()
    const out = { homes: 0, resources: 0, visited: 0, danger: 0, follow: 0 }
    if (typeof doc.follow === 'string' && doc.follow) {
      ctx.followName = doc.follow
      out.follow = 1
    }
    if (Array.isArray(doc.homes) && doc.homes.length) {
      const h = homeOf(doc.homes[doc.homes.length - 1])
      if (h) {
        ctx.home = h
        out.homes = Math.min(doc.homes.length, HOMES_MAX)
      }
    }
    if (Array.isArray(doc.resources) && doc.resources.length) {
      const spots = []
      for (const r of doc.resources) {
        if (!r || typeof r.name !== 'string') continue
        const p = pt(r)
        if (!p) continue
        spots.push({ x: p.x, y: p.y, z: p.z, name: r.name })
      }
      if (spots.length) {
        resources.noteSpots(ctx, spots, t)
        out.resources = resources.count(ctx)
      }
    }
    if (Array.isArray(doc.visited) && doc.visited.length) {
      const set = new Set(doc.visited.filter((k) => typeof k === 'string' && /^-?\d+,-?\d+$/.test(k)))
      if (set.size) {
        if (!ctx.explore || typeof ctx.explore !== 'object') ctx.explore = { visited: set }
        else ctx.explore.visited = set
        out.visited = set.size
      }
    }
    if (Array.isArray(doc.danger) && doc.danger.length) {
      const spots = []
      for (const s of doc.danger) {
        const p = pt(s)
        if (!p) continue
        const at = num(s.at)
        if (at === null || t - at > danger.TTL_MS) continue
        spots.push({ x: p.x, y: p.y, z: p.z, at })
      }
      if (spots.length) {
        ctx.danger = { spots: spots.slice(-danger.MAX_SPOTS) }
        out.danger = ctx.danger.spots.length
      }
    }
    return out
  } catch (_) {
    return null
  }
}

// Periodic tick save: at most one write per SAVE_MIN_MS per file. Returns
// true only when it wrote.
let lastSave = { at: 0, path: null }
function saveThrottled(bot, ctx, now) {
  try {
    const t = typeof now === 'number' ? now : Date.now()
    const f = fileFor(process.env, bot && bot.username)
    if (f === lastSave.path && t - lastSave.at < SAVE_MIN_MS) return false
    const ok = save(bot, ctx, f, t)
    // A failed save (no world key, missing dir, empty snapshot) retries at
    // most once per window instead of once per tick.
    if (!ok) lastSave = { at: t, path: f }
    return ok
  } catch (_) {
    return false
  }
}

module.exports = { save, restore, saveThrottled, fileFor, worldKey, SAVE_MIN_MS, VISITED_MAX, HOMES_MAX }
