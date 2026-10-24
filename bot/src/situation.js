'use strict'

// LLM situation context (idkcraft-qxql.9): one pure read-only function
// situationText(bot, ctx) — castle progress + missing kinds, home, chests,
// inventory, holds/failures, last owner orders, world. Called only inside
// llm-orders planOrder and task planState (never the tick path); every
// section degrades to 'unknown' so prod's many null ctx fields never throw.
// No new state here except the owner order ring (ctx.orderLog, capped, no
// persistence). Chest sections expose cached reads only, never open a chest:
// packroom.withChest snapshots every opened chest into ctx.chestLast.home /
// .castle (tagged by position); unopened chests read 'unknown'.

const worker = require('./worker')
const { timeWord } = require('./site')

// Moved from llm-orders.js (qxql.9): the pack as `name count` pairs.
function inventoryText(bot) {
  try {
    const n = {}
    for (const i of bot.inventory.items()) n[i.name] = (n[i.name] || 0) + i.count
    return Object.entries(n).map(([k, v]) => `${k} ${v}`).join(', ') || 'empty'
  } catch (_) { return 'unknown' }
}

function ageMin(at) {
  try {
    if (typeof at !== 'number') return '?'
    return String(Math.max(0, Math.floor((Date.now() - at) / 60000)))
  } catch (_) { return '?' }
}

// Owner order ring (qxql.9): last 5 order lines with timestamps. Pushed in
// chat.js where OWNER_ORDER matches or llmOrders.ask fires. Cap 5, no
// persistence — a restart starts the ring over.
function pushOrderLog(ctx, line) {
  try {
    if (!ctx || typeof line !== 'string') return
    const text = line.slice(0, 200)
    if (!text) return
    const log = Array.isArray(ctx.orderLog) ? ctx.orderLog : []
    log.push({ line: text, at: Date.now() })
    ctx.orderLog = log.slice(-5)
  } catch (_) { /* ring best-effort */ }
}

function castleSection(bot, ctx) {
  try {
    const st = ctx && ctx.castle
    if (!st || !st.site || typeof st.site.x !== 'number') return 'castle: no castle order'
    let word = 'unknown'
    try {
      const cw = ctx.castleWord
      if (cw && typeof cw.kind === 'string' && cw.kind) {
        let have = '?'
        // ctx passed (codex review): without it the protected castleCarry
        // stacks (owner chest relocation) count as spendable.
        try { have = String(require('./behaviours/castle').usable(bot, cw.kind, ctx)) } catch (_) { /* have best-effort */ }
        // The gated-kind word ('blocked', castle.js:1212) rides along: the
        // model must tell it from an ordinary open need.
        const pre = cw.word ? `${cw.word} ` : ''
        word = `${pre}${cw.kind} left=${cw.left} have=${have}`
      } else if (cw && typeof cw.word === 'string' && cw.word) word = cw.word
    } catch (_) { /* word best-effort */ }
    let prog = '?/?'
    try {
      const p = st.progress
      if (p && typeof p.done === 'number' && typeof p.total === 'number') prog = `${p.done}/${p.total}`
    } catch (_) { /* progress best-effort */ }
    let phase = 'unknown'
    try { if (typeof st.phase === 'string' && st.phase) phase = st.phase } catch (_) { /* phase best-effort */ }
    // Unread cells read as undone (codex review): far from the site a
    // complete castle would report full bill-of-materials deficits, so the
    // per-kind scan runs only while the site is loaded — otherwise unknown.
    let missing = 'unknown'
    try {
      const castle = require('./behaviours/castle')
      let loaded = false
      try { loaded = typeof castle.siteLoaded === 'function' ? castle.siteLoaded(bot, st) === true : false } catch (_) { loaded = false }
      if (loaded) {
        const rows = castle.progressByKind(bot, st)
        const open = Object.entries(rows || {})
          .map(([k, v]) => [k, (v && v.total | 0) - (v && v.done | 0)])
          .filter(([, n]) => n > 0)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 3)
          .map(([k, n]) => `${k}:${n}`)
        missing = open.length > 0 ? open.join(',') : 'none'
      }
    } catch (_) { /* missing best-effort */ }
    return `castle: ${word} ${prog} phase=${phase} missing=${missing}`
  } catch (_) { return 'castle: unknown' }
}

function homeSection(bot, ctx) {
  try {
    const h = ctx && ctx.home
    const state = !h || !h.site ? 'none' : h.built ? 'built' : 'site'
    let dist = '?'
    try {
      const bp = bot && bot.entity && bot.entity.position
      const s = h && h.site
      if (bp && s && typeof bp.x === 'number' && typeof s.x === 'number') {
        dist = `${Math.round(Math.hypot(bp.x - s.x, bp.z - s.z))} blocks`
      }
    } catch (_) { /* distance best-effort */ }
    return `home: ${state} ${dist}`
  } catch (_) { return 'home: unknown' }
}

function fmtChest(v) {
  try {
    if (!v || typeof v !== 'object') return null
    const ks = Object.keys(v).filter((k) => v[k] > 0)
    if (ks.length === 0) return 'empty'
    return ks.slice(0, 8).map((k) => `${k} ${v[k]}`).join(', ')
  } catch (_) { return null }
}

function chestsSection(ctx) {
  try {
    const last = ctx && ctx.chestLast
    const castle = fmtChest(last && last.castle && last.castle.contents) || 'unknown'
    const site = fmtChest(last && last.site && last.site.contents) || 'unknown'
    const home = fmtChest(last && last.home && last.home.contents) || 'unknown'
    return `chests: castle=[${castle}] site=[${site}] home=[${home}]`
  } catch (_) { return 'chests: unknown' }
}

function holdsSection(ctx) {
  try {
    const parts = []
    try {
      const sf = ctx && ctx.stepFail
      if (sf && typeof sf === 'object') {
        for (const [name, rec] of Object.entries(sf)) {
          if (!rec || typeof rec !== 'object') continue
          // Full step.js status (failed:<reason> carries the failReason).
          const status = typeof rec.status === 'string' ? rec.status : 'failed'
          let extra = ''
          try {
            const kinds = rec.kinds
            if (kinds && typeof kinds === 'object') {
              const ks = Object.keys(kinds)
              // klh2 R1 F3: entries are { at, pos } (legacy bare timestamps
              // still read) — ageMin on the entry object renders '?m'.
              if (ks.length > 0) extra = ` kinds=${ks.map((k) => `${k}@${ageMin(kinds[k] && typeof kinds[k] === 'object' ? kinds[k].at : kinds[k])}m`).join(',')}`
            }
          } catch (_) { /* kinds best-effort */ }
          parts.push(`${name} ${status} ${ageMin(rec.at)}m ago${extra}`)
        }
      }
    } catch (_) { /* stepFail best-effort */ }
    try {
      const parks = []
      if (ctx && ctx.castle && (ctx.castle.parked || ctx.castle.taskPark)) {
        const why = ctx.castle.taskPark && ctx.castle.taskPark.diag ? ` why=${String(ctx.castle.taskPark.diag).slice(0, 80)}` : ''
        parks.push(`castle parked${why}`)
      }
      if (ctx && ctx.home && (ctx.home.parked || ctx.home.taskPark)) {
        const why = ctx.home.taskPark && ctx.home.taskPark.diag ? ` why=${String(ctx.home.taskPark.diag).slice(0, 80)}` : ''
        parks.push(`home parked${why}`)
      }
      for (const p of parks) parts.push(p)
    } catch (_) { /* park best-effort */ }
    return `holds: ${parts.length > 0 ? parts.join('; ') : 'none'}`
  } catch (_) { return 'holds: unknown' }
}

function ownerSection(ctx) {
  try {
    const log = ctx && ctx.orderLog
    if (!Array.isArray(log) || log.length === 0) return 'owner: none'
    const lines = log.slice(-5).map((e) => {
      if (!e || typeof e.line !== 'string') return null
      return `${e.line} (${ageMin(e.at)}m ago)`
    }).filter(Boolean)
    return `owner: ${lines.length > 0 ? lines.join(' | ') : 'none'}`
  } catch (_) { return 'owner: unknown' }
}

function worldSection(bot, ctx) {
  try {
    let time = 'unknown'
    try { time = timeWord(bot) || 'unknown' } catch (_) { /* time best-effort */ }
    let health = '?'
    try { health = String(bot && typeof bot.health === 'number' ? Math.round(bot.health) : '?') } catch (_) { /* health best-effort */ }
    let food = '?'
    try { food = String(bot && typeof bot.food === 'number' ? Math.round(bot.food) : '?') } catch (_) { /* food best-effort */ }
    let players = 'unknown'
    try {
      const e = process.env
      const peers = [e.BOT_USERNAME, e.BOT2_USERNAME, e.BOT_PEER_USERNAME].filter(Boolean)
      const names = Object.keys(worker.players(bot) || {}).filter((n) => !peers.includes(n))
      players = names.length > 0 ? names.slice(0, 5).join(',') : 'none'
    } catch (_) { /* players best-effort */ }
    let pos = '?'
    try {
      const p = bot && bot.entity && bot.entity.position
      if (p && typeof p.x === 'number') pos = `${Math.round(p.x)} ${Math.round(p.y)} ${Math.round(p.z)}`
    } catch (_) { /* position best-effort */ }
    return `world: time=${time} health=${health} food=${food} players=${players} pos=${pos}`
  } catch (_) { return 'world: unknown' }
}

// <= ~40 lines of text, one section per line group. Read-only over
// ctx/bot/memory; safe on null-everything. Hard-capped (codex review): the
// sections are bounded by construction, but the prompt section never grows
// past SITUATION_MAX chars no matter what the pack or the ring hold.
const SITUATION_MAX = 4000
function situationText(bot, ctx) {
  const lines = []
  try { lines.push(castleSection(bot, ctx)) } catch (_) { lines.push('castle: unknown') }
  try { lines.push(homeSection(bot, ctx)) } catch (_) { lines.push('home: unknown') }
  try { lines.push(chestsSection(ctx)) } catch (_) { lines.push('chests: unknown') }
  try { lines.push(`inventory: ${inventoryText(bot)}`) } catch (_) { lines.push('inventory: unknown') }
  try { lines.push(holdsSection(ctx)) } catch (_) { lines.push('holds: unknown') }
  try { lines.push(ownerSection(ctx)) } catch (_) { lines.push('owner: unknown') }
  try { lines.push(worldSection(bot, ctx)) } catch (_) { lines.push('world: unknown') }
  return lines.join('\n').slice(0, SITUATION_MAX)
}

module.exports = { situationText, inventoryText, pushOrderLog, SITUATION_MAX }
