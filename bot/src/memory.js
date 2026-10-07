'use strict'

// Disk memory (idkcraft-hlk): homes, resource finds, explored chunks,
// danger spots, and the gear ledger survive bot restart/redeploy. One JSON file on a named
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

// Given-up build cells (idkcraft-ipn.10): blueprint indices, sanitized both
// ways (a hand-edited file must not inject shapes). Cap 256 — the v2 plan
// holds 99; anything longer is garbage, not a plan.
const BUILD_SKIP_MAX = 256
// Verdict stamps for the skip retry (revmux 01 core-4): { idx: epochMs }.
// Same sanitize-and-cap discipline as skipOf — a hand-edited file must not
// inject shapes, and a far-future stamp must not freeze a cell past its
// retry window. Only skips already accepted by skipOf keep their stamps.
function skipAtOf(v, skip) {
  const out = {}
  try {
    if (v && typeof v === 'object' && Array.isArray(skip) && skip.length) {
      const keep = new Set(skip)
      for (const k of Object.keys(v)) {
        const n = Number(k)
        const t = v[k]
        if (!Number.isInteger(n) || n < 0 || n >= BUILD_SKIP_MAX) continue
        if (!keep.has(n)) continue
        if (typeof t !== 'number' || !Number.isFinite(t) || t <= 0 || t > Date.now() + 86400000) continue
        out[n] = t
      }
    }
  } catch (_) { /* stamps best-effort */ }
  return out
}
function skipOf(v) {
  const out = []
  try {
    if (Array.isArray(v)) {
      const seen = new Set()
      for (const n of v) {
        if (typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n >= BUILD_SKIP_MAX) continue
        if (seen.has(n)) continue
        seen.add(n)
        out.push(n)
      }
    }
  } catch (_) { /* skip best-effort */ }
  return out
}

// L2 park episode + day history (idkcraft-vmzq.3): { at, auto, diag } and
// { day, n }. Sanitized both ways like the rest of the record: a far-future
// at clamps to now (it still expires on time), diag caps at 200 chars, day
// must be a UTC date. Additive: old docs lack the keys.
const TASK_PARK_DIAG_MAX = 200
function taskParkOf(v) {
  try {
    if (!v || typeof v !== 'object') return null
    const at = num(v.at)
    if (at === null || at <= 0) return null
    const raw = typeof v.diag === 'string' && v.diag ? v.diag : 'unknown'
    return { at: Math.min(at, Date.now()), auto: v.auto === true, diag: raw.slice(0, TASK_PARK_DIAG_MAX) }
  } catch (_) {
    return null
  }
}
function parkHistOf(v) {
  try {
    if (!v || typeof v !== 'object') return null
    if (typeof v.day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v.day)) return null
    const n = num(v.n)
    if (n === null || n < 1) return null
    return { day: v.day, n: Math.min(Math.floor(n), 99) }
  } catch (_) {
    return null
  }
}

// Plan-B switch stamp (vmzq.21): the at-time rides with the parked flag
// so a restart mid-switch resumes the timer instead of fossilizing the
// park as owner-stopped. The duration stays code-side (read from
// GOAL_PLANB_SWITCH_MS at expiry time), so a hand-edited far-future
// stamp cannot freeze a goal.
function planbOf(v) {
  try {
    if (!v || typeof v !== 'object') return null
    const at = num(v.at)
    if (at === null || at <= 0) return null
    return { at: Math.min(at, Date.now()) }
  } catch (_) {
    return null
  }
}

function homeOf(h) {
  if (!h || !h.site) return null
  const site = v3(h.site)
  if (!site) return null
  const out = { site, interior: null, door: v3(h.door), table: v3(h.table), built: h.built === true, v: h && h.v === 2 ? 2 : 1 }
  // Task park (vmzq.3): a restart mid-park keeps the house veto, the
  // episode timer and the day count instead of wandering or freezing.
  try {
    if (h.parked === true) out.parked = true
    const tp = taskParkOf(h.taskPark)
    if (tp) out.taskPark = tp
    const ph = parkHistOf(h.parkHist)
    if (ph) out.parkHist = ph
    const pb = planbOf(h.planb)
    if (pb) out.planb = pb
  } catch (_) { /* park best-effort */ }
  try {
    const skip = skipOf(h.skip)
    if (skip.length) out.skip = skip
    const at = skipAtOf(h.skipAt, skip)
    if (skip.length && Object.keys(at).length) out.skipAt = at
  } catch (_) { /* skip best-effort */ }
  // Bedroom bed claims (idkcraft-ybt): without these a restart drops sleptA
  // until the next sleep, and the respawn log under-claims (plain instead of
  // (bed)) for the window. Additive like gear: old docs simply lack the keys;
  // verified ghosts still retract on the next beds tick. Only strict shapes
  // persist — a hand-edited file must not inject claims.
  try {
    const bedA = v3(h.bedA)
    if (bedA) out.bedA = bedA
    const bedB = v3(h.bedB)
    if (bedB) out.bedB = bedB
    if (h.sleptA === true) out.sleptA = true
  } catch (_) { /* claims best-effort */ }
  try {
    if (h.interior && h.interior.min && h.interior.max) {
      const min = v3(h.interior.min)
      const max = v3(h.interior.max)
      if (min && max) out.interior = { min, max }
    }
  } catch (_) { /* interior best-effort */ }
  return out
}

// Castle project (idkcraft-g0z.3): { site, rot, blueprintVersion, phase,
// blocked, parked } — progress lives in the world, so this is all a restart
// needs. Sanitized both ways like the home record: integer site, rot 0..3,
// a known phase, blocked entries '<v>:<idx>' -> { tries, until, why? }.
const CASTLE_PHASES = new Set(['prep', 'body', 'moat', 'complete'])
const CASTLE_BLOCKED_MAX = 4096
function castleOf(c) {
  try {
    if (!c || typeof c !== 'object') return null
    const site = pt(c.site)
    if (!site || ![site.x, site.y, site.z].every(Number.isInteger)) return null
    const rot = Number.isInteger(c.rot) && c.rot >= 0 && c.rot <= 3 ? c.rot : 0
    const out = { site, rot, phase: CASTLE_PHASES.has(c.phase) ? c.phase : 'body', blocked: {}, parked: c.parked === true }
    // Task park (vmzq.3): the episode timer and day count ride with the
    // parked flag (additive; owner parks have neither key).
    try {
      const tp = taskParkOf(c.taskPark)
      if (tp) out.taskPark = tp
      const ph = parkHistOf(c.parkHist)
      if (ph) out.parkHist = ph
      const pb = planbOf(c.planb)
      if (pb) out.planb = pb
    } catch (_) { /* park best-effort */ }
    if (Number.isInteger(c.blueprintVersion)) out.blueprintVersion = c.blueprintVersion
    if (c.blocked && typeof c.blocked === 'object') {
      for (const k of Object.keys(c.blocked).slice(0, CASTLE_BLOCKED_MAX)) {
        const e = c.blocked[k]
        if (!/^\d+:\d+$/.test(k) || !e || typeof e !== 'object') continue
        const tries = num(e.tries)
        const until = num(e.until)
        if (tries === null || until === null || tries < 1) continue
        // Clamped to the executor's backoff cap (10 min): a hand-edited
        // far-future stamp must not freeze a cell. The why rides along
        // (g0z.23): the stuck line needs it after a restart; anything but
        // a short reason token stays dropped.
        out.blocked[k] = { tries: Math.floor(tries), until: Math.min(until, Date.now() + 600000) }
        if (typeof e.why === 'string' && /^[a-z0-9_-]{1,64}$/.test(e.why)) out.blocked[k].why = e.why
      }
    }
    return out
  } catch (_) {
    return null
  }
}

// Sheepless latch (idkcraft-9qt0): beds' ctx.beds.noWool {fails, at}.
// Survives restart so the bot does not re-hunt after every deploy; strict
// shape, and a far-future stamp clamps to now (it still expires on time).
function sheepOf(v, now) {
  try {
    if (!v || typeof v !== 'object') return null
    const fails = num(v.fails)
    const at = num(v.at)
    if (fails === null || at === null || fails < 1 || at <= 0) return null
    return { fails: Math.min(Math.floor(fails), 99), at: Math.min(at, typeof now === 'number' ? now : Date.now()) }
  } catch (_) {
    return null
  }
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
  if (cur) {
    // The live ctx.buildSkip is the current home's truth (ipn.10): the
    // deploy that used to drop it now carries it in the home record.
    try {
      const skip = skipOf(ctx.buildSkip)
      if (skip.length) cur.skip = skip
      else delete cur.skip
      const at = skipAtOf(ctx.buildSkipAt, skip)
      if (skip.length && Object.keys(at).length) cur.skipAt = at
      else delete cur.skipAt
    } catch (_) { /* skip best-effort */ }
    homes.push(cur)
  }
  let items = []
  try {
    const mem = ctx.resources
    if (mem && mem.items instanceof Map) {
      for (const r of mem.items.values()) {
        if (!r || typeof r.name !== 'string') continue
        const p = pt(r)
        if (!p) continue
        // atl.16: at + exposed survive the restart (bring prices memory
        // by age, and unloaded chunks cannot recompute exposure). Only
        // booleans persist — a pre-flag cell writes no key at all.
        const rec = { x: p.x, y: p.y, z: p.z, name: r.name }
        const at = num(r.at)
        if (at !== null) rec.at = at
        if (typeof r.exposed === 'boolean') rec.exposed = r.exposed
        items.push(rec)
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
  // Tri-state (p4s): a remembered name, null for an explicit revoke, and
  // undefined for a ctx that never restored — only the revoke may clear.
  let follow
  try {
    if (ctx && typeof ctx.followName === 'string' && ctx.followName) follow = ctx.followName
    else if (ctx && ctx.followName === null) follow = null
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
        const spot = { x: p.x, y: p.y, z: p.z, at }
        const r = num(s.r) // 9kd: wide water-death discs survive restart; default marks stay shapeless
        if (r !== null && r > 0 && r !== danger.AVOID_RADIUS) spot.r = r
        spots.push(spot)
      }
      spots = spots.slice(-danger.MAX_SPOTS)
    }
  } catch (_) { /* danger best-effort */ }
  // Gear ledger (ipn.3 round-2): without it every rejoin reforges the
  // owner's pieces (and orphaned in-flight goods lose their finished
  // record). Omitted when empty, like follow.
  let gear
  try {
    const gm = gearMaps({ given: ctx.gearGiven, finished: ctx.gearFinished, made: ctx.gear && ctx.gear.made })
    // The unhanded claim rides with the ledger (revmux 02-review): tossed()
    // reads an empty haul as proof of handover, so a rejoin without the
    // haul flips a death-lost piece to handed. Only ledger names persist -
    // forage loot haul stays session-scoped (deliver's domain, untouched).
    try {
      if (ctx.haul && typeof ctx.haul === 'object') {
        const haul = {}
        for (const n of new Set([...Object.keys(gm.made), ...Object.keys(gm.finished)])) {
          const c = ctx.haul[n]
          if (typeof c === 'number' && Number.isFinite(c) && c > 0) haul[n] = Math.floor(c)
        }
        gm.haul = haul
      }
    } catch (_) { /* haul best-effort */ }
    if (gearCount(gm) > 0) gear = gm
  } catch (_) { /* gear best-effort */ }
  // Castle (g0z.3), tri-state like follow: a record, null for an explicit
  // 'castle forget', undefined for a ctx that never restored (save keeps
  // the file's record then).
  let castle
  try {
    if (ctx.castle === null) castle = null
    else if (ctx.castle) castle = castleOf(ctx.castle) || undefined
  } catch (_) { /* castle best-effort */ }
  let sheep
  try { sheep = sheepOf(ctx.beds && ctx.beds.noWool, t) || undefined } catch (_) { /* latch best-effort */ }
  return { v: VERSION, world, savedAt: t, homes, resources: items, visited, danger: spots, follow, gear, castle, sheep }
}

// Gear ledger maps, sanitized both ways (own write, but a hand-edited
// file must not inject shapes): { given: {name: n}, finished: {name: n},
// made: {name: true}, haul: {name: n} }. Additive: old docs simply lack
// the key (and lack haul: a pre-fix file still forgives a death-loss, the
// crash-window class, exactly once).
function gearMaps(src) {
  const out = { given: {}, finished: {}, made: {}, haul: {} }
  try {
    const pick = (v, num) => {
      const o = {}
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        for (const [k, n] of Object.entries(v)) {
          if (typeof k !== 'string' || k.length === 0 || k.length > 64) continue
          if (num) {
            if (typeof n === 'number' && Number.isFinite(n) && n >= 0) o[k] = Math.floor(n)
          } else if (n === true) o[k] = true
        }
      }
      return o
    }
    const o = src || {}
    out.given = pick(o.given, true)
    out.finished = pick(o.finished, true)
    out.made = pick(o.made, false)
    out.haul = pick(o.haul, true)
  } catch (_) { /* gear best-effort */ }
  return out
}

function gearCount(gm) {
  try {
    return Object.keys(gm.given).length + Object.keys(gm.finished).length + Object.keys(gm.made).length + Object.keys(gm.haul || {}).length
  } catch (_) {
    return 0
  }
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
    const empty = !doc.homes.length && !doc.resources.length && !doc.visited.length && !doc.danger.length && !doc.follow && !doc.gear && !doc.castle && !doc.sheep
    f = file || fileFor(process.env, bot && bot.username)
    let prev = null
    try {
      prev = readDoc(f)
      if (prev && prev.v === VERSION && prev.world === doc.world && Array.isArray(prev.homes)) {
        const cur = doc.homes[doc.homes.length - 1]
        const merged = prev.homes.filter((h) => homeOf(h) && (cur ? !sameSite(h, cur) : true))
        if (cur) merged.push(cur)
        doc.homes = merged.slice(-HOMES_MAX)
      }
    } catch (_) { /* first save, corrupt or other world: fresh list */ }
    // A follow revocation is information too: an explicit null clears the
    // stored target, but an unrestored ctx (undefined) never wipes the file
    // on a pre-spawn end/kicked/error save (p4s majors).
    const prevFollow = prev && typeof prev.follow === 'string' && prev.follow ? prev.follow : null
    // Castle: undefined keeps the same world's record, null drops it — and
    // a drop is information like a follow revoke.
    const prevCastle = prev && prev.v === VERSION && prev.world === doc.world ? castleOf(prev.castle) : null
    if (doc.castle === undefined && prevCastle) doc.castle = prevCastle
    if (empty && !(prevFollow && doc.follow === null) && !(prevCastle && doc.castle === null)) return false
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
    const out = { homes: 0, resources: 0, visited: 0, danger: 0, follow: 0, gear: 0, castle: 0, sheep: 0 }
    const sheep = sheepOf(doc.sheep, t)
    if (sheep) {
      if (!ctx.beds || typeof ctx.beds !== 'object') ctx.beds = {}
      ctx.beds.noWool = sheep
      out.sheep = 1
    }
    // Castle (g0z.3): a restart resumes the project as stored — the
    // order-time site checks never re-run over it.
    const castle = castleOf(doc.castle)
    if (castle) {
      ctx.castle = castle
      out.castle = 1
    }
    if (typeof doc.follow === 'string' && doc.follow) {
      ctx.followName = doc.follow
      out.follow = 1
    }
    if (doc.gear && typeof doc.gear === 'object') {
      const gm = gearMaps(doc.gear)
      if (gearCount(gm) > 0) {
        ctx.gearGiven = gm.given
        ctx.gearFinished = gm.finished
        if (!ctx.gear || typeof ctx.gear !== 'object') ctx.gear = {}
        ctx.gear.made = gm.made
        // Restore enforces the same ledger-names filter as save (revmux
        // 03-review): a hand-written doc must not inject a haul claim for a
        // name the ledger never made (e.g. forage loot deliver would toss).
        for (const [n, c] of Object.entries(gm.haul)) {
          if (!(c > 0) || (!gm.made[n] && !(n in gm.finished))) continue
          if (!ctx.haul || typeof ctx.haul !== 'object') ctx.haul = {}
          ctx.haul[n] = c
        }
        out.gear = gearCount(gm)
      }
    }
    if (Array.isArray(doc.homes) && doc.homes.length) {
      const h = homeOf(doc.homes[doc.homes.length - 1])
      if (h) {
        ctx.home = h
        // The record's skips are this home's (ipn.10): a deploy mid-build
        // resumes past the given-up cells instead of re-looping them.
        try {
          ctx.buildSkip = skipOf(h.skip)
          ctx.buildSkipAt = skipAtOf(h.skipAt, ctx.buildSkip)
        } catch (_) { /* skip best-effort */ }
        out.homes = Math.min(doc.homes.length, HOMES_MAX)
      }
    }
    if (Array.isArray(doc.resources) && doc.resources.length) {
      const spots = []
      for (const r of doc.resources) {
        if (!r || typeof r.name !== 'string') continue
        const p = pt(r)
        if (!p) continue
        // atl.16: at restores per-cell (noteSpots honors s.at); a missing
        // exposed key stays undefined — a pre-flag record, not buried.
        const rec = { x: p.x, y: p.y, z: p.z, name: r.name }
        const at = num(r.at)
        if (at !== null) rec.at = at
        if (typeof r.exposed === 'boolean') rec.exposed = r.exposed
        spots.push(rec)
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
        const spot = { x: p.x, y: p.y, z: p.z, at }
        const r = num(s.r) // 9kd: pre-fix files simply lack r and read as default
        if (r !== null && r > 0 && r !== danger.AVOID_RADIUS) spot.r = r
        spots.push(spot)
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
