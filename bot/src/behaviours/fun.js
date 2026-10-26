'use strict'

// Idle whimsy (idkcraft-o95q): the bot does something funny and illogical
// from time to time — a useless gift, a tiny Stonehenge-like ring, or an
// LLM-improvised joke. Idle-only goal step ('fun', ranked just above
// 'rest'): day, no castle, no orders/pins, nobody fighting for the body,
// pack holds junk or cheap mats. Rare: a 30-60 min randomized cooldown
// stamped when the act starts. Every act chats its own unmistakable line
// so it reads as a joke, never a malfunction; nothing spends the last of
// anything; nothing touches the flat square, the house, or the castle.

const Vec3 = require('vec3')
const { stepDone, stepFailed, chatStep } = require('../step')
const { HOSTILE_NAMES } = require('../perception')

// Long cooldown, randomized (brief: once per 30-60 min max).
const FUN_MIN_MS = 30 * 60 * 1000
const FUN_JITTER_MS = 30 * 60 * 1000
// Bounds (brief: tiny folly, reversible joke).
const MAX_PLACE = 7
const REACH = 4.5
// Cheap mats only: dirt-family + stone you trip over. Never logs/planks
// (the house eats those), never anything mined with effort.
const CHEAP_BLOCKS = new Set(['dirt', 'coarse_dirt', 'sand', 'gravel', 'cobblestone'])
// Worthless enough to give away with a straight face.
const GIFT_JUNK = new Set([
  'poisonous_potato', 'rotten_flesh', 'spider_eye', 'feather', 'string',
  'wheat_seeds', 'beetroot_seeds', 'pumpkin_seeds', 'melon_seeds',
])
const GIFT_ALLOW = new Set([...GIFT_JUNK, ...CHEAP_BLOCKS])
// One pinned line per act: the joke must be unmistakable.
const CHAT_GIFT = 'a gift for you. you\'re welcome.'
const CHAT_FOLLY = 'do not ask what it means. it is art.'
const CHAT_IMPROV = 'the voices said you would like this. enjoy.'
// New failed: reasons (S5): fun-no-mats, fun-no-ground, fun-no-gift,
// fun-place, fun-toss. All mean "the joke did not land, back off".
const LLM_TIMEOUT_MS = 20000
const TOSS_TIMEOUT_MS = 5000
const PACK_SUMMARY_MAX = 300

function itemsOf(bot) {
  try {
    const items = bot && bot.inventory && typeof bot.inventory.items === 'function' ? bot.inventory.items() : []
    return Array.isArray(items) ? items : []
  } catch (_) {
    return []
  }
}

function packCounts(bot) {
  const counts = new Map()
  for (const i of itemsOf(bot)) {
    if (!i || typeof i.name !== 'string') continue
    counts.set(i.name, (counts.get(i.name) || 0) + (i.count | 0))
  }
  return counts
}

// Never spends the last of anything: gift one only with 2+ on hand.
function giftPick(bot) {
  const counts = packCounts(bot)
  for (const name of GIFT_ALLOW) {
    if ((counts.get(name) || 0) >= 2) return name
  }
  return null
}

// Folly needs more cheap blocks than it places (keep-last rule).
function follyMats(bot) {
  const counts = packCounts(bot)
  for (const name of CHEAP_BLOCKS) {
    if ((counts.get(name) || 0) > MAX_PLACE) return name
  }
  return null
}

function improvReady(bot) {
  try {
    if (!process.env.ANTHROPIC_API_KEY) return false
    return itemsOf(bot).length > 0
  } catch (_) {
    return false
  }
}

// A hostile close by means the body belongs to fight, not whimsy
// (dispatch preemption is the real guard; this keeps the menu honest).
function threatNear(bot) {
  try {
    const bp = bot && bot.entity && bot.entity.position
    if (!bp || typeof bp.x !== 'number') return false
    const entities = (bot && bot.entities && typeof bot.entities === 'object') ? Object.values(bot.entities) : null
    if (!Array.isArray(entities)) return false
    for (const e of entities) {
      if (!e || e.type === 'player' || !e.position) continue
      if (!HOSTILE_NAMES.has(e.name || '')) continue
      if (e.isValid === false) continue
      let d = null
      try { d = bp.distanceTo ? bp.distanceTo(e.position) : Math.hypot(bp.x - e.position.x, bp.y - e.position.y, bp.z - e.position.z) } catch (_) { continue }
      if (typeof d === 'number' && d <= 10) return true
    }
    return false
  } catch (_) {
    return false
  }
}

function castleQuiet(facts) {
  const w = facts && facts.castle
  return w === 'none' || w === 'done' || w === 'parked' || w == null
}

// Idle-only gate (brief): day, no castle, no order/pin/lease on the body,
// nobody fighting nearby, cooldown elapsed, and at least one act is
// materially possible with the pack on hand.
function funFeasible(facts, bot, ctx, now = Date.now()) {
  try {
    if (!facts || facts.time !== 'day') return false
    if (!castleQuiet(facts)) return false
    if (!ctx || ctx.paused) return false
    if (ctx.bring || ctx.lead || ctx.comehome || ctx.gocastle) return false
    if (ctx.flat && !ctx.flat.parked) return false
    if (ctx.taskPlanStep || ctx.llmOrder || ctx.llmAsk) return false
    if (threatNear(bot)) return false
    if (typeof ctx.funNext === 'number' && now < ctx.funNext) return false
    if (facts.player !== 'none' && giftPick(bot)) return true
    if (follyMats(bot)) return true
    if (facts.player === 'none' && giftPick(bot) && improvReady(bot)) return true
    if (improvReady(bot) && (giftPick(bot) || follyMats(bot))) return true
    return false
  } catch (_) {
    return false
  }
}

// Cooldown stamped when the act STARTS, so a failure still spaces out.
function stampFun(ctx, now = Date.now(), rand = Math.random) {
  try {
    const r = typeof rand === 'function' ? rand() : rand
    ctx.funNext = now + FUN_MIN_MS + Math.floor((typeof r === 'number' ? r : Math.random()) * FUN_JITTER_MS)
  } catch (_) {
    try { ctx.funNext = now + FUN_MIN_MS } catch (_) { /* stamp best-effort */ }
  }
}

// Which acts can run now; the trigger rolls one (brief: the model picks
// for improv, the dice picks between the acts).
function availActs(bot, facts, ctx) {
  const acts = []
  try {
    if (facts && facts.player !== 'none' && giftPick(bot)) acts.push('gift')
    if (follyMats(bot)) acts.push('folly')
    if (improvReady(bot) && (giftPick(bot) || follyMats(bot))) acts.push('improv')
  } catch (_) { /* available best-effort */ }
  return acts
}

function pickAct(bot, facts, ctx, rand = Math.random) {
  const acts = availActs(bot, facts, ctx)
  if (!acts.length) return null
  const r = typeof rand === 'function' ? rand() : rand
  return acts[Math.floor((typeof r === 'number' ? r : 0) * acts.length) % acts.length]
}

// "name xN, ..." sublist for the model, capped (brief: capped length).
function packSummary(bot, max = PACK_SUMMARY_MAX) {
  try {
    const parts = []
    for (const [name, n] of packCounts(bot)) parts.push(`${name} x${n}`)
    let s = parts.join(', ')
    if (s.length > max) s = s.slice(0, max)
    return s
  } catch (_) {
    return ''
  }
}

const FUN_SYSTEM = 'You invent a tiny joke for a Minecraft companion bot with an idle moment. ' +
  'Answer JSON only, no prose: {"kind":"gift","item":"<id>"} to hand over one worthless item, or ' +
  '{"kind":"build","block":"<id>","count":<n>} to place a tiny ring of n identical cheap blocks. ' +
  'Rules: item/block must come from the pack list; block must be dirt, coarse_dirt, sand, gravel or cobblestone; ' +
  'count is 1-7; never tools, weapons, armour, food, fire, lava, water, tnt or redstone; keep it small and reversible. ' +
  'When nothing in the pack suits a joke, answer {"kind":"none"}.'

// Validator: the allowlist is the safety — anything outside is an honest
// skip, never executed. keep-last: counts must leave one behind.
function validateFunOffer(offer, counts) {
  const bad = (why) => ({ ok: false, why })
  if (!offer || typeof offer !== 'object') return bad('no-offer')
  const kind = typeof offer.kind === 'string' ? offer.kind.toLowerCase().trim() : ''
  const have = (name) => (counts instanceof Map ? (counts.get(name) || 0) : 0)
  if (kind === 'none') return bad('model-passed')
  if (kind === 'gift') {
    const item = typeof offer.item === 'string' ? offer.item.toLowerCase().trim().replace(/\s+/g, '_') : ''
    if (!GIFT_ALLOW.has(item)) return bad(`gift-no-item:${item.slice(0, 24)}`)
    if (!(have(item) >= 2)) return bad(`gift-short:${item.slice(0, 24)}`)
    return { ok: true, act: 'gift', item }
  }
  if (kind === 'build') {
    const block = typeof offer.block === 'string' ? offer.block.toLowerCase().trim().replace(/\s+/g, '_') : ''
    if (!CHEAP_BLOCKS.has(block)) return bad(`build-no-block:${block.slice(0, 24)}`)
    const count = Math.floor(Number(offer.count))
    if (!(count >= 1 && count <= MAX_PLACE)) return bad(`build-count:${String(offer.count).slice(0, 8)}`)
    if (!(have(block) > count)) return bad(`build-short:${block.slice(0, 24)}`)
    return { ok: true, act: 'build', block, count }
  }
  return bad(`no-kind:${String(kind).slice(0, 24)}`)
}

function blockNameAt(bot, p) {
  try {
    const b = bot.blockAt && bot.blockAt(p)
    return b && typeof b.name === 'string' ? b.name : null
  } catch (_) {
    return null
  }
}

function botPos(bot) {
  try {
    const p = bot && bot.entity && bot.entity.position
    return p && typeof p.x === 'number' ? p : null
  } catch (_) {
    return null
  }
}

// Hex-ish ground ring + centre, 7 cells max. Rejects cells near the home
// site, the flat square, or the castle site — whimsy never builds on work.
function findFollySpot(bot, ctx) {
  try {
    const bp = botPos(bot)
    if (!bp) return null
    const home = ctx && ctx.home && ctx.home.site
    const flat = ctx && ctx.flatEnd
    const castle = ctx && ctx.castle && ctx.castle.site
    const farFrom = (x, z, s, r) => {
      if (!s || typeof s.x !== 'number') return true
      return Math.hypot(x - s.x, z - s.z) > r
    }
    const ring = [[2, 0], [1, 1], [-1, 1], [-2, 0], [-1, -1], [1, -1], [0, 0]]
    // The centre hugs the body: the far ring cell (centre + 2) must stay
    // within placing reach, so the centre sits 2 out in each of 8
    // directions. Vetoes keep the ring off the home site, the flat
    // square and the castle site.
    const d = 2
    for (let a = 0; a < 8; a++) {
      const cx = Math.round(bp.x + d * Math.cos((a * Math.PI) / 4))
      const cz = Math.round(bp.z + d * Math.sin((a * Math.PI) / 4))
      if (!farFrom(cx, cz, home, 6) || !farFrom(cx, cz, flat, 6) || !farFrom(cx, cz, castle, 10)) continue
      let gy = null
      const cells = []
      let ok = true
      for (const [ox, oz] of ring) {
        const x = cx + ox
        const z = cz + oz
        if (Math.hypot(x - bp.x, z - bp.z) > REACH) { ok = false; break }
        let y = null
        for (let dy = 2; dy >= -3; dy--) {
          const n = blockNameAt(bot, new Vec3(x, Math.floor(bp.y) + dy, z))
          if (n == null) { ok = false; break }
          if (n === 'air' || n === 'cave_air' || n === 'void_air') continue
          y = Math.floor(bp.y) + dy + 1
          break
        }
        if (y == null) { ok = false; break }
        if (gy == null) gy = y
        if (y !== gy) { ok = false; break } // one flat ring, no cliffs
        const top = blockNameAt(bot, new Vec3(x, y, z))
        if (top !== 'air' && top !== 'cave_air' && top !== 'void_air') { ok = false; break }
        cells.push(new Vec3(x, y, z))
      }
      if (ok && cells.length) return { cells }
    }
    return null
  } catch (_) {
    return null
  }
}

function tossOne(bot, item) {
  return new Promise((resolve) => {
    let done = false
    const fin = (ok) => { if (!done) { done = true; resolve(ok) } }
    try {
      const timer = setTimeout(() => fin(false), TOSS_TIMEOUT_MS)
      const cb = (err) => { clearTimeout(timer); fin(!err) }
      if (typeof bot.tossStack === 'function') return void bot.tossStack(item, cb)
      if (typeof bot.toss === 'function') return void bot.toss(item.type, null, 1, cb)
      clearTimeout(timer)
      fin(false)
    } catch (_) {
      fin(false)
    }
  })
}

async function equipHand(bot, name) {
  try {
    const item = itemsOf(bot).find((i) => i && i.name === name)
    if (!item) return false
    if (typeof bot.equip === 'function') await bot.equip(item, 'hand')
    return true
  } catch (_) {
    return false
  }
}

async function placeCells(bot, block, cells) {
  let placed = 0
  for (const cell of cells) {
    try {
      if (!equipHandSyncCheck(bot, block)) return { placed, fail: 'no-mats' }
      const okEq = await equipHand(bot, block)
      if (!okEq) return { placed, fail: 'no-mats' }
      let ref = null
      try { ref = bot.blockAt && bot.blockAt(new Vec3(cell.x, cell.y - 1, cell.z)) } catch (_) { ref = null }
      if (!ref || !ref.position) return { placed, fail: 'no-ground' }
      await bot.placeBlock(ref, new Vec3(0, 1, 0))
      placed++
    } catch (_) {
      return { placed, fail: 'place-fail' }
    }
  }
  return { placed, fail: null }
}

function equipHandSyncCheck(bot, block) {
  try {
    return itemsOf(bot).some((i) => i && i.name === block)
  } catch (_) {
    return false
  }
}

async function doGift(bot, ctx, item, line) {
  const inv = itemsOf(bot)
  const stack = inv.find((i) => i && i.name === item) || { name: item, type: null }
  const tossed = await tossOne(bot, stack)
  if (!tossed) { stepFailed(ctx, 'fun-toss'); return }
  try { chatStep(bot, ctx, line) } catch (_) { /* chat best-effort */ }
  stepDone(ctx)
}

async function doFolly(bot, ctx, block, count, line) {
  const spot = findFollySpot(bot, ctx)
  if (!spot) { stepFailed(ctx, 'fun-no-ground'); return }
  const cells = spot.cells.slice(0, count)
  const { placed, fail } = await placeCells(bot, block, cells)
  if (fail) {
    try { console.log(`fun folly placed=${placed}/${cells.length} fail=${fail}`) } catch (_) { /* log best-effort */ }
    stepFailed(ctx, fail === 'no-mats' ? 'fun-no-mats' : fail === 'no-ground' ? 'fun-no-ground' : 'fun-place')
    return
  }
  try { chatStep(bot, ctx, line) } catch (_) { /* chat best-effort */ }
  stepDone(ctx)
}

async function doImprov(bot, ctx, fetchFn) {
  const summary = packSummary(bot)
  if (!summary) { stepDone(ctx); return }
  let data = null
  try {
    const brain = require('../brain')
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(new DOMException('fun timeout', 'TimeoutError')), LLM_TIMEOUT_MS)
    try {
      data = await brain.llmCall({
        use: 'fun',
        apiKey: process.env.ANTHROPIC_API_KEY,
        signal: ac.signal,
        fetchFn,
        body: {
          model: process.env.LLM_MODEL || brain.LLM_MODEL,
          max_tokens: 300,
          thinking: { type: 'disabled' },
          system: FUN_SYSTEM,
          messages: [{ role: 'user', content: `Pack (name xcount): ${summary}\nOffer ONE tiny joke fitting the pack.` }],
        },
      })
    } finally {
      clearTimeout(timer)
    }
  } catch (err) {
    try { console.log(`fun improv llm error: ${String((err && err.message) || err).slice(0, 80)}`) } catch (_) { /* log best-effort */ }
    stepDone(ctx) // honest skip: the joke does not land, the cooldown spaces the next try
    return
  }
  let offer = null
  try {
    const out = ((data && Array.isArray(data.content) ? data.content : []).find((b) => b && b.type === 'text') || {}).text || ''
    offer = JSON.parse(out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1))
  } catch (_) { offer = null }
  const v = validateFunOffer(offer, packCounts(bot))
  try { console.log(`fun improv offer=${JSON.stringify(offer).slice(0, 160)} verdict=${v.ok ? v.act : v.why}`) } catch (_) { /* log best-effort */ }
  if (!v.ok) { stepDone(ctx); return } // honest skip on anything outside the allowlist
  if (v.act === 'gift') await doGift(bot, ctx, v.item, CHAT_IMPROV)
  else await doFolly(bot, ctx, v.block, v.count, CHAT_IMPROV)
}

// Fire-and-forget like every other behaviour (applyDecision does not
// await): the busy flag owns the async window, the cooldown was stamped
// at pick time, and stepStatus ends the step.
async function run(bot, ctx, target, state) {
  if (!ctx || ctx.funBusy) return
  ctx.funBusy = true
  stampFun(ctx)
  try {
    const facts = { player: 'none', castle: 'none' }
    try {
      if (state && typeof state.player !== 'undefined') facts.player = state.player !== 'none' && state.player ? 'seen' : 'none'
      else if (target && target.position) facts.player = 'seen'
    } catch (_) { /* facts best-effort */ }
    try {
      if (ctx.castle && ctx.castle.site && !ctx.castle.parked && ctx.castle.phase !== 'complete') facts.castle = 'ordered'
    } catch (_) { /* castle best-effort */ }
    const act = pickAct(bot, facts, ctx, Math.random)
    if (act === 'gift') {
      const g = giftPick(bot)
      if (!g) stepFailed(ctx, 'fun-no-gift')
      else await doGift(bot, ctx, g, CHAT_GIFT)
    } else if (act === 'improv') {
      await doImprov(bot, ctx)
    } else if (act === 'folly') {
      const m = follyMats(bot)
      if (!m) stepFailed(ctx, 'fun-no-mats')
      else await doFolly(bot, ctx, m, MAX_PLACE, CHAT_FOLLY)
    } else stepFailed(ctx, 'fun-no-mats')
  } finally {
    try { ctx.funBusy = false } catch (_) { /* flag best-effort */ }
  }
}

module.exports = run
module.exports.run = run
module.exports.funFeasible = funFeasible
module.exports.pickAct = pickAct
module.exports.availActs = availActs
module.exports.validateFunOffer = validateFunOffer
module.exports.packSummary = packSummary
module.exports.giftPick = giftPick
module.exports.follyMats = follyMats
module.exports.improvReady = improvReady
module.exports.stampFun = stampFun
module.exports.findFollySpot = findFollySpot
module.exports.FUN_MIN_MS = FUN_MIN_MS
module.exports.FUN_JITTER_MS = FUN_JITTER_MS
module.exports.MAX_PLACE = MAX_PLACE
module.exports.CHEAP_BLOCKS = CHEAP_BLOCKS
module.exports.GIFT_ALLOW = GIFT_ALLOW
module.exports.CHAT_GIFT = CHAT_GIFT
module.exports.CHAT_FOLLY = CHAT_FOLLY
module.exports.CHAT_IMPROV = CHAT_IMPROV
module.exports.FUN_SYSTEM = FUN_SYSTEM
