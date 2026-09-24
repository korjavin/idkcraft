'use strict'

const { goals } = require('mineflayer-pathfinder')
const { findNearest, loadedSearchRadius, startFarSearch, stepFarSearch } = require('./scout')
const { countItems } = require('../perception')
const fightMod = require('./fight')
const exploreMod = require('./explore')
const metrics = require('../metrics')

// Bring: the 'bring me <block> [count]' order. The bot walks to the nearest
// matching block alone, digs up to N drops, walks back to the requesting
// player and tosses the drops nearby.
//
// Explicit player ORDER (like ctx.lead), not a brain choice: while ctx.bring
// is set the ticker dispatches here instead of the brain/work, except fight
// which still preempts. Primitives reused, not reinvented: findNearest
// (scout) for search, GoalNear + dig-in-flight + GoalBlock pickup (gather),
// player approach (follow), honest-unseen answer (3a7).
//
// Owner direction: no branching rescue logic. Failure points refuse with a
// message (the ef3/rw4.6 stuck menu owns the choices); the FSM reserve is a
// plain refusal. Bring explicitly raises NO stuck facts: a stall refuses and
// ends the order instead of starting an episode (unlike follow/roam/lead,
// whose detectors feed the menu, and gather, which reports at its final).
// The ticker place_error/no-displacement backstops still catch a bring that
// loops without refusing, and release() resumes ctx.bring untouched.
const FIND_RADIUS = 48
const WANT_ORE = 3
const WANT_LOGS = 4
const WANT_FOOD = 3
const WANT_MAX = 16
const WALK_STALL_TICKS = 10 // stationary ticks before refusing an unreachable target
const MOVE_TOLERANCE = 0.5
const RETURN_RANGE = 2

// Search legs (idkcraft-atl.8): when the local find comes up empty the
// order walks explore legs (primitive atl.1) instead of refusing, re-finding
// after each arrival — up to K legs or N minutes, then an honest refusal.
// The bead's defaults; env tunes the stand and the far-find test.
function searchLegs() {
  const raw = parseInt((process.env && process.env.BRING_SEARCH_LEGS) || '4', 10)
  return Number.isFinite(raw) && raw >= 0 ? raw : 4
}
function searchMinutes() {
  const raw = parseFloat((process.env && process.env.BRING_SEARCH_MINUTES) || '3')
  return Number.isFinite(raw) && raw > 0 ? raw : 3
}

function dropFor(blockName) {
  if (blockName.endsWith('_log')) return blockName
  const base = blockName.endsWith('_ore') ? blockName.slice(0, -'_ore'.length) : blockName
  const raw = base.match(/(iron|copper|gold)$/)
  if (raw) return `raw_${raw[1]}`
  if (base === 'lapis' || base.endsWith('_lapis')) return 'lapis_lazuli'
  return base // coal, diamond, emerald, redstone, quartz, dirt, ...
}

// Only ores and logs are fetchable (the bead's resources): anything else
// (stone->cobble, grass->dirt, ...) drops a different item, so the drop
// count would never grow and the order would mine the area forever.
function isBringable(blockName) {
  return blockName.endsWith('_ore') || blockName.endsWith('_log')
}

// Share keep-list (idkcraft-ah9): tools, weapons, armour, plus a 32-block
// dirt/cobblestone reserve — without it the bot cannot pillar out (ef3
// pillar_up). Dirt fills the reserve first, cobblestone the remainder.
const SHARE_RESERVE = 32
const SHARE_EXACT_KEEP = new Set(['shears', 'flint_and_steel', 'bow', 'crossbow', 'trident', 'arrow', 'shield'])
function isShareKeep(name) {
  if (typeof name !== 'string') return true
  if (SHARE_EXACT_KEEP.has(name)) return true
  return /_(pickaxe|axe|shovel|hoe|sword|helmet|chestplate|leggings|boots)$/.test(name)
}

// Inventory items -> toss list in inventory order, keep-list skipped.
function sharePlan(items) {
  const list = Array.isArray(items) ? items : []
  let dirt = 0
  let cobble = 0
  for (const i of list) {
    if (!i || typeof i.name !== 'string') continue
    if (i.name === 'dirt') dirt += i.count || 0
    if (i.name === 'cobblestone') cobble += i.count || 0
  }
  let keepDirt = Math.min(SHARE_RESERVE, dirt)
  let keepCobble = Math.min(SHARE_RESERVE - keepDirt, cobble)
  const toss = []
  const at = new Map()
  const add = (name, count) => {
    if (count <= 0) return
    if (at.has(name)) toss[at.get(name)].count += count
    else { at.set(name, toss.length); toss.push({ name, count }) }
  }
  for (const i of list) {
    if (!i || typeof i.name !== 'string') continue
    if (isShareKeep(i.name)) continue
    const n = i.count || 0
    if (i.name === 'dirt') {
      const k = Math.min(keepDirt, n)
      keepDirt -= k
      add(i.name, n - k)
    } else if (i.name === 'cobblestone') {
      const k = Math.min(keepCobble, n)
      keepCobble -= k
      add(i.name, n - k)
    } else {
      add(i.name, n)
    }
  }
  return toss
}

function needsPickaxe(blockName) {
  return blockName.endsWith('_ore')
}

// Harvest tiers (vanilla): coal/iron/copper/lapis/quartz need stone or
// better; gold/diamond/redstone/emerald need iron or better. Wooden and
// golden are refused for everything. The refusal names the required tier.
const PICKAXE_RANK = { wooden: 0, golden: 0, stone: 1, iron: 2, diamond: 3, netherite: 4 }
function requiredTier(blockName) {
  const base = blockName.endsWith('_ore') ? blockName.slice(0, -'_ore'.length) : blockName
  if (/(gold|diamond|redstone|emerald)$/.test(base)) return 'iron'
  return 'stone'
}
function hasPickaxe(bot, blockName) {
  const need = blockName && blockName.endsWith('_ore') ? (requiredTier(blockName) === 'iron' ? 2 : 1) : 0
  let best = -1
  try {
    const items = bot && bot.inventory && typeof bot.inventory.items === 'function' ? bot.inventory.items() : []
    for (const i of items) {
      const m = typeof i.name === 'string' && i.name.match(/^(wooden|golden|stone|iron|diamond|netherite)_pickaxe$/)
      if (m) best = Math.max(best, PICKAXE_RANK[m[1]])
    }
  } catch (_) { return false }
  return best >= need
}
function tierArticle(tier) {
  return tier === 'iron' ? 'an' : 'a'
}

function say(bot, line) {
  try { bot.chat(line) } catch (_) { /* chat best-effort, like goal.js */ }
}

function countDrop(bot, drop) {
  try {
    return countItems(bot, (n) => n === drop)
  } catch (_) {
    return 0
  }
}

// Drop a dead order goal without stop(): its latch would swallow the next
// setGoal issued on the same tick (same lesson as gather.js clearGoal).
function clearGoal(bot, ctx) {
  try {
    if (bot.pathfinder && bot.pathfinder.goal && typeof bot.pathfinder.setGoal === 'function') {
      bot.pathfinder.setGoal(null)
    }
  } catch (_) { /* body best-effort */ }
  ctx.lastGoalKey = ''
}

function bringKind(ctx) {
  return (ctx.bring && ctx.bring.kind) || 'block'
}

function refuse(bot, ctx, line) {
  say(bot, line)
  metrics.bring.inc({ outcome: 'refused', kind: bringKind(ctx) })
  ctx.bring = null
  clearGoal(bot, ctx)
}

function done(bot, ctx) {
  metrics.bring.inc({ outcome: 'done', kind: bringKind(ctx) })
  ctx.bring = null
  clearGoal(bot, ctx)
}

// Food (idkcraft-n7k): 'bring me food [N]' + 'meat' / 'something to eat'.
// Inventory first (any edible incl. raw meat), else hunt the nearest passive
// animal with the fight swing. No cooking, no rescue branches — refusals.
const FOOD_NAMES = new Set([
  'bread', 'baked_potato', 'apple', 'carrot',
  'cooked_beef', 'cooked_porkchop', 'cooked_chicken', 'cooked_mutton', 'cooked_rabbit',
  'beef', 'porkchop', 'mutton', 'chicken', 'rabbit',
])
const PREY_NAMES = new Set(['cow', 'pig', 'sheep', 'chicken', 'rabbit'])
const PREY_DROPS = { cow: 'beef', pig: 'porkchop', sheep: 'mutton', chicken: 'chicken', rabbit: 'rabbit' }

function isFoodRequest(name) {
  const n = String(name || '').toLowerCase().trim()
  return n === 'food' || n === 'meat' || n === 'something to eat'
}

function findEdible(bot) {
  try {
    const items = bot && bot.inventory && typeof bot.inventory.items === 'function' ? bot.inventory.items() : []
    if (Array.isArray(items)) {
      for (const i of items) {
        if (i && typeof i.name === 'string' && FOOD_NAMES.has(i.name)) {
          return { name: i.name, count: typeof i.count === 'number' ? i.count : 1 }
        }
      }
    }
  } catch (_) { /* no inventory: hunt */ }
  return null
}

function animalDist(bp, epos) {
  try {
    return typeof bp.distanceTo === 'function'
      ? bp.distanceTo(epos)
      : Math.hypot(bp.x - epos.x, bp.y - epos.y, bp.z - epos.z)
  } catch (_) { return null }
}

// Nearest passive animal within 48; when drop is set (second+ kill of one
// order) only animals dropping it, so one order tosses one food kind.
function findAnimal(bot, drop) {
  const bp = bot && bot.entity && bot.entity.position
  if (!bp) return null
  let best = null
  let bestDist = Infinity
  for (const e of Object.values(bot.entities || {})) {
    if (!e || !e.position || e.isValid === false) continue
    if (!PREY_NAMES.has(e.name)) continue
    if (drop && PREY_DROPS[e.name] !== drop) continue
    const d = animalDist(bp, e.position)
    if (typeof d !== 'number' || d > FIND_RADIUS) continue
    if (d < bestDist) { bestDist = d; best = e }
  }
  if (!best) return null
  return { name: best.name, id: best.id, position: best.position, distance: Math.round(bestDist) }
}

function entityById(bot, id) {
  for (const e of Object.values(bot.entities || {})) {
    if (e && e.id === id && e.isValid !== false && e.position) return e
  }
  return null
}

// Fence fact (n7k): log only — whether the prey stands near player fences
// is a future model choice, never a branch here.
function fenceFact(bot, animal) {
  try {
    const p = animal.position
    const around = [[0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]]
    for (const [ox, oy, oz] of around) {
      const b = bot.blockAt && bot.blockAt({ x: Math.floor(p.x) + ox, y: Math.floor(p.y) + oy, z: Math.floor(p.z) + oz })
      if (b && typeof b.name === 'string' && b.name.endsWith('_fence')) {
        console.log(`hunt animal near fences: ${animal.name} at ${Math.round(p.x)} ${Math.round(p.y)} ${Math.round(p.z)}`)
        return
      }
    }
  } catch (_) { /* fact best-effort */ }
}

// Progress is horizontal displacement or a new standing level — the same
// rule as gather.js: tower jumps in place are standing still.
function progressed(bp, last, grounded) {
  if (!last) return true
  if (Math.hypot(bp.x - last.x, bp.z - last.z) > MOVE_TOLERANCE) return true
  return !!grounded && Math.floor(bp.y) !== Math.floor(last.y)
}

function atPos(bot) {
  const bp = bot.entity && bot.entity.position
  return bp ? `${Math.round(bp.x)} ${Math.round(bp.y)} ${Math.round(bp.z)}` : 'unknown'
}

// Per-leg model choice (ef3/rw4.6 shape): exactly two labels — laya answers
// reliably only with <=2 options (brain.js ask). give_up refuses honestly
// with the legs covered; the FSM reserve is search_more until K.
const SEARCH_INSTRUCTIONS = 'Choose whether the bring order keeps searching'
const SEARCH_CRITERIA = {
  search_more: 'legs remain: walk another area and look again',
  give_up: 'no hope nearby: refuse with the areas covered',
}

function searchText(o, s) {
  const what = (o.kind || 'block') === 'food' ? 'food' : (o.name || 'block')
  return `search=${what} legs=${s.legs}/${searchLegs()} last=${s.last || 'empty'}`
}

// Model leg choice with the FSM as fallback and disagreement reference,
// exactly like recover chooseRecovery: { action, source, fsm, model }.
async function chooseBringSearch(brain, text, legsLeft) {
  const feasible = legsLeft > 0 ? ['search_more', 'give_up'] : ['give_up']
  const fsm = legsLeft > 0 ? 'search_more' : 'give_up'
  if (feasible.length <= 1) return { action: 'give_up', source: 'only-option', fsm, model: null }
  if (!brain || typeof brain.ask !== 'function') return { action: fsm, source: 'fsm', fsm, model: null }
  const model = brain.source || brain.name || 'model'
  const criteria = {}
  for (const n of feasible) criteria[n] = SEARCH_CRITERIA[n]
  const fail = (reason) => {
    metrics.escalation.inc({ from: model, to: 'fsm', reason })
    return { action: fsm, source: 'fsm-fallback', fsm, model }
  }
  try {
    const label = await brain.ask({ state: text, instructions: SEARCH_INSTRUCTIONS, criteria, situation: text })
    if (label !== fsm) {
      console.error(`brain disagree source=${model} model=${label} fsm=${fsm} reason=bring-search facts=${text}`)
    }
    if (!feasible.includes(label)) return fail('invalid')
    return { action: label, source: model, fsm, model }
  } catch (err) {
    const msg = String((err && err.message) || err)
    const reason = (err && err.name === 'TimeoutError') ? 'timeout'
      : msg.startsWith('jev missing') ? 'invalid'
      : 'error'
    return fail(reason)
  }
}

// Honest end of a spent search: the legs walked, then what was found.
function refuseExhausted(bot, ctx, o) {
  const n = o.searchLegs ? o.searchLegs.legs : 0
  const food = (o.kind || 'block') === 'food'
  const base = o.have > 0 ? `only got ${o.have} ${o.drop}` : (food ? 'no animals' : `no ${o.name}`)
  refuse(bot, ctx, `searched ${n} areas, ${base}`)
}

// Drop a cancelled mid-leg explore pursuit (stop/follow/work/lead): the
// visited memory stays (shared exploration), the stale target must not leak
// into the next owner's walk.
function clearSearchLeg(ctx) {
  try {
    if (ctx && ctx.explore && typeof ctx.explore === 'object') {
      ctx.explore.target = null
      ctx.explore.issuedKey = null
    }
  } catch (_) { /* cleanup best-effort */ }
}

// atl.8: an empty find opens search legs instead of refusing. Async: the
// per-leg model choice awaits ask(); the tick (index.js) awaits bring.
// legacy is today's refusal line, kept for anchorless worlds (no spiral
// without home or spawn — production always has spawn).
// Anchor probe for order creation (index.js setBring): legs need a spiral.
function canSearch(bot, ctx) {
  try {
    return !!exploreMod.anchorOf(bot, ctx)
  } catch (_) {
    return false
  }
}

async function enterSearch(bot, ctx, o, legacy) {
  const s = o.searchLegs || (o.searchLegs = { legs: 0, startedAt: Date.now(), announced: false, last: 'empty' })
  if (!exploreMod.anchorOf(bot, ctx)) {
    refuse(bot, ctx, legacy)
    return
  }
  if (s.legs >= searchLegs() || Date.now() - s.startedAt >= searchMinutes() * 60 * 1000) {
    refuseExhausted(bot, ctx, o)
    return
  }
  const text = searchText(o, s)
  const c = await chooseBringSearch(ctx && ctx.brain, text, searchLegs() - s.legs)
  if (c.action !== 'search_more') {
    refuseExhausted(bot, ctx, o)
    return
  }
  if (!s.announced) {
    s.announced = true
    say(bot, (o.kind || 'block') === 'food' ? 'no animals nearby, searching…' : `no ${o.name} nearby, searching…`)
  }
  o.phase = 'searchwalk'
  ctx.stepStatus = 'running'
}

// One search leg: drive the explore primitive, count the finished leg
// (arrival or failure) and re-find. The status sentinel keeps a stale
// recover done from ever reading as an arrival.
function walkSearch(bot, ctx, o) {
  ctx.stepStatus = 'running'
  try {
    exploreMod(bot, ctx, null, {})
  } catch (_) {
    ctx.stepStatus = 'failed:bring-search'
  }
  const st = ctx.stepStatus
  if (st === 'done' || (typeof st === 'string' && st.indexOf('failed') === 0)) {
    ctx.stepStatus = null
    if (o.searchLegs) {
      o.searchLegs.legs += 1
      o.searchLegs.last = st === 'done' ? 'empty' : 'failed'
    }
    o.phase = 'find'
  }
}

async function findFood(bot, ctx, o) {
  const res = findAnimal(bot, o.drop || null)
  if (!res) {
    await enterSearch(bot, ctx, o, o.have > 0 ? `only got ${o.have} ${o.drop}` : 'no animals within 48 blocks')
    return
  }
  o.animal = { name: res.name, id: res.id }
  o.pos = res.position
  o.drop = PREY_DROPS[res.name]
  o.lastPos = { x: res.position.x, y: res.position.y, z: res.position.z }
  fenceFact(bot, res)
  if (!o.announced) {
    o.announced = true
    say(bot, `going hunting: ${res.name} ${res.distance} blocks away`)
  }
  o.phase = 'walk'
  o.stalls = 0
  o.armedId = null
}

function walkFood(bot, ctx, o, bp, grounded) {
  const ent = o.animal ? entityById(bot, o.animal.id) : null
  if (!ent) { o.animal = null; o.phase = 'find'; return }
  o.pos = ent.position
  o.lastPos = { x: ent.position.x, y: ent.position.y, z: ent.position.z }
  const key = `bring-hunt:${Math.round(ent.position.x)},${Math.round(ent.position.y)},${Math.round(ent.position.z)}`
  const d = animalDist(bp, ent.position)
  if (d !== null && d <= fightMod.SWING_RANGE) { o.phase = 'kill'; return }
  if (key !== ctx.lastGoalKey) {
    bot.pathfinder.setGoal(new goals.GoalNear(ent.position.x, ent.position.y, ent.position.z, 2), false)
    ctx.lastGoalKey = key
  }
  // Stall accounting runs every tick, not just on a settled key: a
  // moving-but-unreachable animal (pen, water) re-keys constantly, and only
  // the bot's own displacement clears the counter — otherwise the body is
  // held forever, one block per tick.
  if (progressed(bp, o.lastBotPos, grounded)) {
    o.stalls = 0
    o.lastBotPos = { x: bp.x, y: bp.y, z: bp.z }
  } else if (++o.stalls >= WALK_STALL_TICKS) {
    refuse(bot, ctx, `could not reach ${o.animal.name}`)
  }
}

function killFood(bot, ctx, o, bp) {
  const ent = o.animal ? entityById(bot, o.animal.id) : null
  if (!ent) { // dead or gone: collect whatever dropped at the last spot
    o.dropPos = o.lastPos
    o.phase = 'pickup'
    return
  }
  o.lastPos = { x: ent.position.x, y: ent.position.y, z: ent.position.z }
  const d = animalDist(bp, ent.position)
  if (d === null || d > fightMod.SWING_RANGE) { o.phase = 'walk'; return }
  if (o.armedId !== ent.id) {
    o.armedId = ent.id
    try { fightMod.equipGear(bot) } catch (_) { /* fists are fine */ }
  }
  try { fightMod.swing(bot, ent) } catch (_) { /* mock bots may lack lookAt/attack */ }
}

function pickupFood(bot, ctx, o, bp, grounded) {
  const dp = o.dropPos
  if (!dp) { o.animal = null; o.phase = 'find'; return }
  const key = `bring-food-pickup:${Math.round(dp.x)},${Math.round(dp.y)},${Math.round(dp.z)}`
  if (key !== ctx.lastGoalKey) {
    bot.pathfinder.setGoal(new goals.GoalNear(dp.x, dp.y, dp.z, 1), false)
    ctx.lastGoalKey = key
    o.stalls = 0
    o.lastBotPos = { x: bp.x, y: bp.y, z: bp.z }
    return
  }
  const d = animalDist(bp, dp)
  if (d === null || d > 2) {
    if (progressed(bp, o.lastBotPos, grounded)) {
      o.stalls = 0
      o.lastBotPos = { x: bp.x, y: bp.y, z: bp.z }
    } else if (++o.stalls >= WALK_STALL_TICKS) {
      refuse(bot, ctx, `could not pick up ${o.drop}`)
    }
    return
  }
  // Walked over the drops: the inventory count is the truth.
  o.have = countDrop(bot, o.drop)
  if (o.have >= o.want) {
    o.phase = 'return'
    o.saidWaiting = false
  } else {
    o.animal = null
    o.phase = 'find'
  }
}

async function bring(bot, ctx, target, state) {
  const o = ctx.bring
  if (!o) return
  const bp = bot.entity && bot.entity.position
  if (!bp) return
  const grounded = !bot.entity || bot.entity.onGround !== false
  const food = (o.kind || 'block') === 'food'

  if (o.phase === 'searchwalk') { walkSearch(bot, ctx, o); return }

  if (o.phase === 'find') {
    if (food) { await findFood(bot, ctx, o); return }
    if (o.searchSkipFar) { // pending far search just came up empty: skip the re-scan
      o.searchSkipFar = false
      await enterSearch(bot, ctx, o, `no ${o.name} within ${loadedSearchRadius(bot)} blocks (loaded area)`)
      return
    }
    const res = findNearest(bot, o.name)
    if (res === 'unknown') {
      refuse(bot, ctx, `unknown block: ${o.name}`)
      return
    }
    if (!res) {
      if (o.have > 0) {
        await enterSearch(bot, ctx, o, `only got ${o.have} ${o.drop}`)
        return
      }
      // Sync 48 is empty: the 96/160 shells run sliced across ticks (amb),
      // one order holds one cursor, no new scan starts while it runs.
      o.search = startFarSearch(bot, o.name)
      if (o.search === 'unknown') {
        refuse(bot, ctx, `unknown block: ${o.name}`)
        return
      }
      if (!o.search) {
        // No wider shell to scan (edge 48): legs still walk new ground.
        await enterSearch(bot, ctx, o, `no ${o.name} within ${loadedSearchRadius(bot)} blocks (loaded area)`)
        return
      }
      o.phase = 'searchfar'
      return
    }
    o.pos = res.position
    o.block = res.name
    o.exposed = res.exposed !== false
    o.drop = dropFor(res.name)
    if (needsPickaxe(res.name) && !hasPickaxe(bot, res.name)) {
      const tier = requiredTier(res.name)
      refuse(bot, ctx, `need ${tierArticle(tier)} ${tier} pickaxe for ${res.name}`)
      return
    }
    if (!o.announced) {
      o.announced = true
      say(bot, `going for ${o.want} ${res.name}, ${res.distance} blocks away`)
    }
    o.phase = 'walk'
    o.stalls = 0
    o.lastPos = null
    return
  }

  if (o.phase === 'searchfar') {
    if (food) { await findFood(bot, ctx, o); return }
    const r = stepFarSearch(bot, o.search)
    if (!r.done) return
    o.search = null
    if (r.result === 'unknown') {
      refuse(bot, ctx, `unknown block: ${o.name}`)
      return
    }
    if (!r.result) {
      const edge = (r && typeof r.edge === 'number') ? r.edge : loadedSearchRadius(bot)
      await enterSearch(bot, ctx, o, o.have > 0 ? `only got ${o.have} ${o.drop}` : `no ${o.name} within ${edge} blocks (loaded area)`)
      return
    }
    o.pos = r.result.position
    o.block = r.result.name
    o.exposed = r.result.exposed !== false
    o.drop = dropFor(r.result.name)
    if (needsPickaxe(r.result.name) && !hasPickaxe(bot, r.result.name)) {
      const tier = requiredTier(r.result.name)
      refuse(bot, ctx, `need ${tierArticle(tier)} ${tier} pickaxe for ${r.result.name}`)
      return
    }
    if (!o.announced) {
      o.announced = true
      say(bot, `going for ${o.want} ${r.result.name}, ${r.result.distance} blocks away`)
    }
    o.phase = 'walk'
    o.stalls = 0
    o.lastPos = null
    return
  }

  if (o.phase === 'walk') {
    if (food) { walkFood(bot, ctx, o, bp, grounded); return }
    const key = `bring:${o.pos.x},${o.pos.y},${o.pos.z}`
    if (key !== ctx.lastGoalKey) {
      bot.pathfinder.setGoal(new goals.GoalNear(o.pos.x, o.pos.y, o.pos.z, 2), false)
      ctx.lastGoalKey = key
      o.stalls = 0
      o.lastPos = { x: bp.x, y: bp.y, z: bp.z }
      return
    }
    let block = null
    try { block = bot.blockAt && bot.blockAt(o.pos) } catch (_) { block = null }
    if (!block || !block.name || block.name !== o.block) {
      o.pos = null // mined by someone else: search again
      o.phase = 'find'
      return
    }
    if (!bot.pathfinder.isMoving()) {
      let diggable = true
      try { diggable = typeof bot.canDigBlock === 'function' ? bot.canDigBlock(block) : true } catch (_) { diggable = false }
      if (diggable) o.phase = 'dig'
    }
    if (o.phase === 'walk') {
      if (progressed(bp, o.lastPos, grounded)) {
        o.stalls = 0
        o.lastPos = { x: bp.x, y: bp.y, z: bp.z }
      } else if (++o.stalls >= WALK_STALL_TICKS) {
        refuse(bot, ctx, `could not reach ${o.block}` + (o.exposed === false ? ' (buried, no path in)' : ''))
      }
      return
    }
  }

  if (o.phase === 'dig') {
    // Exactly one dig at a time: while it is in flight, wait (gather.js rule).
    if (ctx.digInFlight) return
    if (typeof bot.dig !== 'function') {
      refuse(bot, ctx, `could not break ${o.block}`)
      return
    }
    let block = null
    try { block = bot.blockAt && bot.blockAt(o.pos) } catch (_) { block = null }
    if (!block || block.name !== o.block) {
      o.pos = null // vanished mid-order: search again
      o.phase = 'find'
      return
    }
    ctx.digInFlight = true
    void (async () => {
      try {
        // Ore dug with the sword in hand drops nothing: hold the best
        // harvest tool first (guarded: fake bots may lack either method).
        let tool = null
        try { tool = bot.pathfinder && typeof bot.pathfinder.bestHarvestTool === 'function' ? bot.pathfinder.bestHarvestTool(block) : null } catch (_) { tool = null }
        if (tool && typeof bot.equip === 'function') await bot.equip(tool, 'hand')
        await bot.dig(block)
      } catch (_) { /* gone or interrupted: pickup anyway */ }
      ctx.digInFlight = false
      o.phase = 'pickup'
    })()
    return
  }

  if (o.phase === 'kill') {
    if (food) { killFood(bot, ctx, o, bp); return }
    refuse(bot, ctx, `could not bring ${o.block || o.name}`)
    return
  }

  if (o.phase === 'pickup') {
    if (food) { pickupFood(bot, ctx, o, bp, grounded); return }
    const key = `bring-pickup:${o.pos.x},${o.pos.y},${o.pos.z}`
    if (key !== ctx.lastGoalKey) {
      bot.pathfinder.setGoal(new goals.GoalBlock(o.pos.x, o.pos.y, o.pos.z), false)
      ctx.lastGoalKey = key
      return
    }
    // Reached or gave up getting there: the inventory count is the truth.
    o.have = countDrop(bot, o.drop)
    if (o.have >= o.want) {
      o.phase = 'return'
      o.saidWaiting = false
    } else {
      o.pos = null
      o.phase = 'find'
    }
    return
  }

  if (o.phase === 'return') {
    const p = bot.players && bot.players[o.by] && bot.players[o.by].entity
    if (!p || !p.position) {
      // 3a7 honesty: no coordinates for an out-of-range player — say where
      // the bot is and hold the drops until the player is back.
      if (!o.saidWaiting) {
        o.saidWaiting = true
        say(bot, o.kind === 'share'
          ? `I can't see you — I'm at ${atPos(bot)}; come closer`
          : `I can't see you — I'm at ${atPos(bot)} with your ${o.have} ${o.drop}; come closer`)
      }
      return
    }
    o.saidWaiting = false
    const pp = p.position
    const key = `bring-return:${Math.round(pp.x)},${Math.round(pp.y)},${Math.round(pp.z)}`
    if (key !== ctx.lastGoalKey) {
      bot.pathfinder.setGoal(new goals.GoalNear(pp.x, pp.y, pp.z, RETURN_RANGE), false)
      ctx.lastGoalKey = key
    }
    let d = null
    try { d = typeof bp.distanceTo === 'function' ? bp.distanceTo(pp) : Math.hypot(bp.x - pp.x, bp.y - pp.y, bp.z - pp.z) } catch (_) { d = null }
    if (d !== null && d <= RETURN_RANGE + 0.5) {
      if (o.kind === 'share') { shareToss(bot, ctx, o); return }
      if (o.tossInFlight) return
      let id = null
      try {
        const entry = bot.registry && bot.registry.itemsByName && bot.registry.itemsByName[o.drop]
        id = entry && entry.id
      } catch (_) { id = null }
      if (typeof id !== 'number' || typeof bot.toss !== 'function') {
        refuse(bot, ctx, `could not toss ${o.drop}`)
        return
      }
      const n = Math.min(o.have, o.want)
      o.tossInFlight = true
      void (async () => {
        try {
          await bot.toss(id, null, n)
          say(bot, `here are ${n} ${o.drop}`)
          done(bot, ctx)
        } catch (_) {
          refuse(bot, ctx, `could not toss ${o.drop}`)
        } finally {
          o.tossInFlight = false
        }
      })()
    }
  }
}

// Share toss (idkcraft-ah9): one stack per item in plan order, counted
// against the live inventory (it may have shifted since the order). Reports
// what actually left; an empty toss refuses like the single-drop path.
function shareToss(bot, ctx, o) {
  if (o.tossInFlight) return
  let live = []
  try {
    live = bot && bot.inventory && typeof bot.inventory.items === 'function' ? bot.inventory.items() : []
  } catch (_) { live = [] }
  const items = sharePlan(live)
  if (items.length === 0) {
    refuse(bot, ctx, 'nothing to share')
    return
  }
  o.tossInFlight = true
  void (async () => {
    const got = []
    try {
      for (const item of items) {
        let id = null
        try {
          const entry = bot.registry && bot.registry.itemsByName && bot.registry.itemsByName[item.name]
          id = entry && entry.id
        } catch (_) { id = null }
        if (typeof id !== 'number' || typeof bot.toss !== 'function') continue
        let have = 0
        try { have = countItems(bot, (n) => n === item.name) } catch (_) { have = 0 }
        const n = Math.min(have, item.count)
        if (n <= 0) continue
        try {
          await bot.toss(id, null, n)
          got.push(`${n} ${item.name}`)
        } catch (_) { /* next item */ }
      }
    } finally {
      o.tossInFlight = false
    }
    if (got.length === 0) {
      refuse(bot, ctx, `could not toss ${(items[0] && items[0].name) || 'items'}`)
      return
    }
    say(bot, `shared: ${got.join(', ')}`)
    done(bot, ctx)
  })()
}

module.exports = bring
module.exports.dropFor = dropFor
module.exports.isBringable = isBringable
module.exports.requiredTier = requiredTier
module.exports.needsPickaxe = needsPickaxe
module.exports.hasPickaxe = hasPickaxe
module.exports.WANT_ORE = WANT_ORE
module.exports.WANT_LOGS = WANT_LOGS
module.exports.WANT_FOOD = WANT_FOOD
module.exports.WANT_MAX = WANT_MAX
module.exports.isFoodRequest = isFoodRequest
module.exports.findEdible = findEdible
module.exports.findAnimal = findAnimal
module.exports.sharePlan = sharePlan
module.exports.chooseBringSearch = chooseBringSearch
module.exports.clearSearchLeg = clearSearchLeg
module.exports.canSearch = canSearch
module.exports.SEARCH_INSTRUCTIONS = SEARCH_INSTRUCTIONS
module.exports.SEARCH_CRITERIA = SEARCH_CRITERIA
