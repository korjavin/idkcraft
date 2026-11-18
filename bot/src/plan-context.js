'use strict'

// Plan context (owner 2026-11-18): what JEV/LLM sees at a stall so the
// choice is informed, not a coin flip — goal + why + what is owed, a short
// pack, known chests with distance, terrain from find memory, vitals and
// threats, and a one-line "what it would give" per option. Fire-time only
// (planState), reads cached ctx/memory: one blockAt for the biome, no scans.

const { countItems, snapHostiles } = require('./perception')
const { timeWord } = require('./site')

const WHY = {
  house: 'a shelter for the night: bed spawn, door, chest storage; everything else waits on it',
  castle: 'the owner ordered this build; the long-term project',
  bring: 'the owner asked for these items and is waiting',
  comehome: 'the owner called the bot home',
  gocastle: 'the owner sent the bot to the castle',
  lead: 'the owner asked to be led to a find',
  flat: 'the owner asked for level ground',
}
const MAX_BYTES = 3000 // ~750 tokens for this block; planState total stays under ~1.5k

const isWood = (n) => /_log$|_stem$|_planks$/.test(n)
const woodOf = (c) => {
  let n = 0
  for (const [k, v] of Object.entries(c || {})) if (typeof v === 'number') n += k.endsWith('_planks') ? v : isWood(k) ? 4 * v : 0
  return n
}

function dist(a, b) {
  return Math.round(Math.hypot(a.x - b.x, (a.y || 0) - (b.y || 0), a.z - b.z))
}

function top(obj, n) {
  return Object.entries(obj || {}).filter(([, v]) => typeof v === 'number' && v > 0)
    .sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => `${k} ${v}`).join(', ')
}

function packOf(bot) {
  const n = {}
  for (const i of bot.inventory.items()) n[i.name] = (n[i.name] || 0) + i.count
  const tools = Object.keys(n).filter((k) => /_(pickaxe|axe|sword|shovel|hoe)$|^shears$/.test(k))
  for (const t of tools) delete n[t]
  return { tools: tools.join(',') || 'none', items: top(n, 8) || 'empty', free: 36 - bot.inventory.items().length }
}

// Every known chest (home/site/castle slots + own and peer snapshots),
// nearest first, deduped by position.
function chestsOf(bot, ctx) {
  const bp = bot.entity.position
  const seen = new Set()
  const out = []
  const add = (pos, contents, at, tag) => {
    if (!pos || typeof pos.x !== 'number' || !contents) return
    const k = `${pos.x},${pos.y},${pos.z}`
    if (seen.has(k)) return
    seen.add(k)
    out.push({ d: dist(bp, pos), tag, contents, wood: woodOf(contents), age: typeof at === 'number' ? Math.floor((Date.now() - at) / 60000) : null, top: top(contents, 4) || 'empty' })
  }
  const last = ctx.chestLast || {}
  add(ctx.home && ctx.home.chest, last.home && last.home.contents, last.home && last.home.at, 'home')
  add(ctx.castle && ctx.castle.siteChest, last.site && last.site.contents, last.site && last.site.at, 'site')
  for (const c of Array.isArray(ctx.chests) ? ctx.chests : []) add(c, c.contents, c.at, 'own')
  for (const c of Array.isArray(ctx.peerChests) ? ctx.peerChests : []) add(c, c.contents, c.at, 'peer')
  return out.sort((a, b) => a.d - b.d)
}

const TERRAIN = [['trees', /_log$|_stem$/], ['stone', /^(stone|cobblestone|deepslate|andesite|diorite|granite)$/], ['ore', /_ore$/], ['sand', /sand$/], ['water', /^water$/]]

// Find memory (explore/scout arrival scans) by class: count + nearest distance.
function terrainOf(bot, ctx) {
  const bp = bot.entity.position
  const t = {}
  try {
    const b = bot.blockAt(bp)
    const bio = b && b.biome && b.biome.name
    if (bio) t.biome = bio
  } catch (_) { /* biome best-effort */ }
  const items = ctx.resources && ctx.resources.items instanceof Map ? ctx.resources.items.values() : []
  const acc = {}
  for (const it of items) {
    const cls = TERRAIN.find(([, re]) => re.test(it.name))
    if (!cls) continue
    const d = dist(bp, it)
    const a = acc[cls[0]] || (acc[cls[0]] = { n: 0, near: Infinity })
    a.n++
    if (d < a.near) a.near = d
  }
  for (const [k] of TERRAIN) t[k] = acc[k] ? `${acc[k].n} known, nearest ${acc[k].near}m` : 'none known'
  return t
}

// What is owed for the next stage: cells left + wood have/short (house),
// the castle's open kind word, or the order's have/want.
function needOf(bot, ctx, kind, done, total, chests) {
  const left = typeof done === 'number' && typeof total === 'number' ? total - done : null
  const out = { progress: `${done}/${total}`, cells_left: left }
  if (kind === 'house' || kind === 'castle') {
    const pack = countItems(bot, (n) => n.endsWith('_planks')) + 4 * countItems(bot, (n) => /_log$|_stem$/.test(n))
    const stored = chests.reduce((s, c) => s + c.wood, 0)
    out.wood_planks = { pack, chests: stored }
    if (kind === 'house' && left !== null) out.wood_short = Math.max(0, left - pack)
  }
  if (kind === 'castle' && ctx.castleWord && ctx.castleWord.kind) out.next_kind = `${ctx.castleWord.kind} left=${ctx.castleWord.left}`
  return out
}

// Key-resource matrix (owner 2026-11-18): fixed rows (cheststock NEED
// families the bot builds with) x pack | near chests (<=32 m) | far chests
// (amount@nearest m) | world nearest source m | owed by the goal. Wood is in
// logs (planks 1/4), food in hunger points.
const NEAR_M = 32
const FAMILIES = [
  { key: 'wood', test: (n) => /_log$|_stem$/.test(n) || n.endsWith('_planks'), per: (n) => n.endsWith('_planks') ? 0.25 : 1, world: /_log$|_stem$/ },
  { key: 'stone', test: (n) => /^(cobblestone|cobbled_deepslate|stone)$/.test(n), world: /^(stone|cobblestone|deepslate|andesite|diorite|granite)$/ },
  { key: 'food', test: (n) => FOOD_PTS[n] > 0, per: (n) => FOOD_PTS[n], animals: true },
  { key: 'coal', test: (n) => n === 'coal' || n === 'charcoal', world: /coal_ore$/ },
  { key: 'iron', test: (n) => n === 'raw_iron' || n === 'iron_ingot', world: /iron_ore$/ },
  { key: 'sand', test: (n) => n === 'sand' || n === 'glass', world: /^sand$/ },
]
const FOOD_PTS = { bread: 5, apple: 4, carrot: 3, baked_potato: 5, golden_carrot: 6, cooked_beef: 8, cooked_porkchop: 8, cooked_mutton: 6, cooked_chicken: 6, cooked_cod: 5, cooked_salmon: 6, beef: 3, porkchop: 3, mutton: 2, chicken: 2 }
const ANIMALS = new Set(['cow', 'pig', 'sheep', 'chicken'])

function sumOf(contents, f) {
  let n = 0
  for (const [k, v] of Object.entries(contents || {})) if (typeof v === 'number' && v > 0 && f.test(k)) n += v * (f.per ? f.per(k) : 1)
  return n
}

function resMatrix(bot, ctx, kind, done, total, chests) {
  const bp = bot.entity.position
  const packC = {}
  for (const i of bot.inventory.items()) packC[i.name] = (packC[i.name] || 0) + i.count
  const left = typeof done === 'number' && typeof total === 'number' ? Math.max(0, total - done) : 0
  const fams = FAMILIES.slice()
  const cw = ctx.castleWord
  if (kind === 'castle' && cw && cw.kind && !fams.some((f) => f.key === cw.kind)) fams.push({ key: cw.kind, test: (n) => n === cw.kind })
  const items = ctx.resources && ctx.resources.items instanceof Map ? [...ctx.resources.items.values()] : []
  return fams.map((f) => {
    const pack = sumOf(packC, f)
    let near = 0
    let far = 0
    let farD = null
    for (const c of chests) {
      const n = sumOf(c.contents, f)
      if (n <= 0) continue
      if (c.d <= NEAR_M) near += n
      else { far += n; if (farD === null || c.d < farD) farD = c.d }
    }
    let world = null
    if (f.world) for (const it of items) if (f.world.test(it.name)) { const d = dist(bp, it); if (world === null || d < world) world = d }
    if (f.animals) for (const id in (bot.entities || {})) { const e = bot.entities[id]; if (e && e.position && ANIMALS.has(e.name)) { const d = dist(bp, e.position); if (world === null || d < world) world = d } }
    let owe = 0
    if (kind === 'house' && f.key === 'wood') owe = Math.ceil(left / 4)
    if (kind === 'castle' && cw && f.key === cw.kind) owe = cw.left | 0
    const r = (x) => Math.floor(x)
    const line = `res ${f.key} pack=${r(pack)} near=${r(near)} far=${far > 0 ? `${r(far)}@${farD}m` : 0} world=${world === null ? '?' : `${world}m`} owe=${owe}`
    return { key: f.key, world, line }
  })
}

// One line per option: what picking it would give, from the same reads.
function hintOf(id, terrain, chests, res) {
  const wood = res.find((r) => r.key === 'wood')
  const woodChest = chests.filter((c) => c.wood > 0).sort((a, b) => a.d - b.d)[0]
  if (/fetch|bank|stockpile|withdraw/.test(id)) return woodChest ? `chest ${woodChest.d}m holds ${woodChest.top}` : (chests[0] ? `nearest chest ${chests[0].d}m: ${chests[0].top}` : 'no known chest')
  if (/gather|chop/.test(id)) return wood && wood.world !== null ? `nearest tree ${wood.world}m` : 'no known tree'
  if (/forage/.test(id)) return `trees: ${terrain.trees}; ore: ${terrain.ore}`
  if (/mine|stone|smith/.test(id)) return `stone: ${terrain.stone}; ore: ${terrain.ore}`
  if (/explore/.test(id)) return 'walks to unseen chunks; slow, finds new trees/stone'
  return null
}

function planContext(bot, ctx, kind, done, total, goalText, criteria) {
  const out = {}
  const c = ctx || {}
  let chests = []
  try { chests = chestsOf(bot, c) } catch (_) { chests = [] }
  let res = []
  try { res = resMatrix(bot, c, kind, done, total, chests) } catch (_) { res = [] }
  chests = chests.slice(0, 5)
  let terrain = {}
  try { terrain = terrainOf(bot, c) } catch (_) { terrain = {} }
  try { out.goal = { what: goalText, why: WHY[kind] || 'the current work goal', ...needOf(bot, c, kind, done, total, chests) } } catch (_) { /* skip */ }
  try { out.pack = packOf(bot) } catch (_) { /* skip */ }
  out.res = res.map((r) => r.line)
  out.chests = chests.map((x) => `${x.tag} ${x.d}m${x.age !== null ? ` read ${x.age}m ago` : ''}: ${x.top}`)
  out.terrain = terrain
  try {
    const h = snapHostiles(bot)
    out.vitals = { time: timeWord(bot) || 'unknown', health: Math.round(bot.health), food: Math.round(bot.food), threats: h.count > 0 ? `${h.count} hostile, nearest ${h.name} ${Math.round(h.dist)}m` : 'none' }
  } catch (_) { /* skip */ }
  try { out.step = { now: c.step || null, status: c.stepStatus || null } } catch (_) { /* skip */ }
  if (criteria && typeof criteria === 'object') {
    const opts = {}
    for (const id of Object.keys(criteria)) {
      const h = hintOf(id, terrain, chests, res)
      opts[id] = h ? `${criteria[id]} | ${h}` : criteria[id]
    }
    out.options = opts
  }
  // Hard cap: drop the bulkiest optional parts first.
  for (const k of ['terrain', 'chests', 'options']) { // res never dropped
    if (JSON.stringify(out).length <= MAX_BYTES) break
    if (k === 'chests') out.chests = out.chests.slice(0, 2)
    else if (k === 'terrain') delete out.terrain.water
    else delete out.options
  }
  return out
}

// Adds state.context to a built plan request and logs the full request once
// per stall episode (stallMs resets on progress).
function withContext(bot, ctx, kind, done, total, state, req) {
  try {
    req.state.context = planContext(bot, ctx, kind, done, total, req.state.goal, req.criteria)
    const ms = (state && state.stallMs) || 0
    if (state && (!state.ctxLoggedMs || ms < state.ctxLoggedMs)) {
      state.ctxLoggedMs = ms || 1
      const json = JSON.stringify(req)
      console.log(`stall context goal=${kind} bytes=${json.length} json=${json.slice(0, 2048)}`)
    }
  } catch (_) { /* context best-effort */ }
  return req
}

// Source options (owner 2026-11-18: code gives context, JEV decides): each
// known source of the goal's missing resource is its own option, with the
// cost in metres. applySource runs the chosen one directly through one
// self-bring rung (chestFirst / craftFirst / the plain ladder), never the
// fixed ACQUIRE_RESOLVERS order.
function owedOf(bot, ctx, kind, done, total) {
  if (kind === 'house' && typeof done === 'number' && typeof total === 'number') {
    const pack = countItems(bot, (n) => n.endsWith('_planks')) + 4 * countItems(bot, (n) => /_log$|_stem$/.test(n))
    const short = Math.max(0, total - done - pack)
    return short > 0 ? { fam: (n) => /_log$|_stem$|_planks$/.test(n), planks: short, world: /_log$|_stem$/ } : null
  }
  if (kind === 'castle') {
    const cw = ctx.castleWord
    if (!cw || !cw.kind || !(cw.left > 0)) return null
    let item = null
    try { item = require('./behaviours/castlefetch').acquireItem(bot, cw.kind) } catch (_) { item = null }
    if (!item) return null
    return { fam: (n) => n === item, item, want: cw.left | 0, world: new RegExp(`^${item}$`) }
  }
  return null
}

function wantOf(o, name) {
  if (o.planks) return name.endsWith('_planks') ? o.planks : Math.ceil(o.planks / 4)
  return o.want
}

function sourceOptions(bot, ctx, kind, done, total) {
  const out = []
  const c = ctx || {}
  try {
    const o = owedOf(bot, c, kind, done, total)
    if (!o) return out
    const bp = bot.entity.position
    for (const ch of chestsOf(bot, c).slice(0, 3)) {
      const best = Object.entries(ch.contents).filter(([k, v]) => o.fam(k) && v > 0).sort((a, b) => b[1] - a[1])[0]
      if (!best) continue
      const [name, n] = best
      out.push({
        id: `fetch:${name}@chest(${ch.d}m,${n})`, step: null, unlock: null, source: { resolver: 'chest', item: name, want: Math.min(n, wantOf(o, name)) },
        criterion: `walk ${ch.d}m to the ${ch.tag} chest and take ${name} (it held ${n}, read ${ch.age === null ? '?' : ch.age}m ago)`,
      })
    }
    let near = null
    const items = c.resources && c.resources.items instanceof Map ? c.resources.items.values() : []
    for (const it of items) if (o.world.test(it.name)) { const d = dist(bp, it); if (!near || d < near.d) near = { d, name: it.name } }
    if (near) {
      out.push({
        id: `gather:${near.name}(nearest ${near.d}m)`, step: null, unlock: null, source: { resolver: 'ladder', item: near.name, want: wantOf(o, near.name) },
        criterion: `walk ${near.d}m and dig/chop ${near.name} from the world`,
      })
    }
    const item = o.item || (o.planks ? 'oak_planks' : null)
    if (item) {
      const want = Math.max(1, wantOf(o, item))
      let plan = null
      try { plan = require('./behaviours/craftany').planCraft(bot, c, [item], want) } catch (_) { plan = null }
      if (plan && plan.ok) {
        out.push({ id: `craft:${item}(from pack)`, step: null, unlock: null, source: { resolver: 'craft', item, want }, criterion: `craft ${item} from what the pack holds; no walk` })
      }
    }
  } catch (_) { /* sources best-effort */ }
  return out
}

// Run a chosen source directly (one rung, the llm-orders self-bring shape).
function applySource(ctx, src) {
  const t = ctx && ctx.ordersTicker
  if (!t || typeof t.setBring !== 'function' || !src) return false
  const before = { bring: ctx.bring, ps: ctx.pendingSearch }
  const reply = t.setBring(src.resolver === 'ladder'
    ? { name: src.item, want: src.want, by: 'self' }
    : { name: src.item, want: src.want, by: 'self', chestFirst: src.resolver === 'chest', craftFirst: src.resolver === 'craft' })
  if (ctx.bring && ctx.bring !== before.bring) ctx.bring.self = true
  else if (ctx.pendingSearch && ctx.pendingSearch !== before.ps) ctx.pendingSearch.self = true
  console.log(`stall source resolver=${src.resolver} item=${src.item} want=${src.want} reply=${reply || '-'}`)
  return true
}

// Loop: the same choice 3 rounds running, or A/B alternating 4 rounds,
// none with progress. Returns 'gather-far x3' / 'a<->b x4', else null.
function loopOf(history) {
  const h = Array.isArray(history) ? history : []
  const flat = (xs) => xs.every((e) => e && e.outcome !== 'progress')
  const l3 = h.slice(-3)
  if (l3.length === 3 && flat(l3) && l3.every((e) => e.choice === l3[0].choice)) return `${l3[0].choice} x3`
  const l4 = h.slice(-4)
  if (l4.length === 4 && flat(l4) && l4[0].choice !== l4[1].choice && l4[0].choice === l4[2].choice && l4[1].choice === l4[3].choice) return `${l4[0].choice}<->${l4[1].choice} x4`
  return null
}

const ESCALATE_ID = 'escalate_llm'
function escalateOption(loop) {
  return {
    id: ESCALATE_ID, step: null, unlock: null,
    criterion: `${loop ? `RECOMMENDED, loop=${loop}: ` : ''}ask the LLM for a multi-step plan (once per stall episode; slower, costs tokens)`,
  }
}

module.exports = { planContext, withContext, sourceOptions, applySource, loopOf, escalateOption, ESCALATE_ID, MAX_BYTES }
