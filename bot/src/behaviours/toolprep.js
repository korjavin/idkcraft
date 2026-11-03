'use strict'

// Bulk work keeps its own order object. The existing bring ladder runs a
// private prerequisite, with the same world/safety state but its own terminal.
// The driver is wired by bring.js to keep the behaviour dependency graph acyclic.
const { stepGen } = require('../step')
const { clearGoal } = require('./util')
let drive = null
function setDriver(fn) { drive = fn }
const LIMIT_MS = 120000
const BACKOFF_MS = 60000
const RANK = { wooden: 0, golden: 0, stone: 1, iron: 2, diamond: 3, netherite: 4 }

function requirement(block) {
  const name = (block && block.name) || ''
  if (/(?:_log|_hyphae|_wood|_planks)$/.test(name) || /^(?:stripped_)?(?:crimson|warped)_stem$/.test(name)) return { kind: 'axe', tier: 0, hand: true }
  if (/^(?:dirt|coarse_dirt|rooted_dirt|grass_block|podzol|mycelium|sand|red_sand|gravel|clay|snow|snow_block|soul_sand|soul_soil|mud)$/.test(name) || name.endsWith('_concrete_powder')) return { kind: 'shovel', tier: 0, hand: true }
  if (name === 'obsidian') return { kind: 'pickaxe', tier: 3, hand: false }
  if (/^(?:deepslate_)?coal_ore$/.test(name) || name === 'nether_quartz_ore' || name === 'nether_gold_ore') return { kind: 'pickaxe', tier: 0, hand: false }
  if (name.endsWith('_ore')) return { kind: 'pickaxe', tier: /(?:gold|diamond|redstone|emerald)_ore$/.test(name) ? 2 : 1, hand: false }
  if (/(?:_button|_pressure_plate|_wire|_torch)$/.test(name)) return null
  if (/^(?:[a-z]+_)*(?:stone|cobblestone|sandstone|deepslate|granite|diorite|andesite|tuff|calcite|blackstone|basalt|netherrack|terracotta|bricks|concrete)(?:_[a-z]+)*$/.test(name)) return { kind: 'pickaxe', tier: 0, hand: false }
  return null
}

function carried(bot, req) {
  let items = []
  try { items = bot.inventory.items() || [] } catch (_) { /* no pack */ }
  return items.filter((it) => {
    if (!it || !(it.count > 0)) return false
    const m = String(it.name).match(/^(wooden|golden|stone|iron|diamond|netherite)_(pickaxe|axe|shovel)$/)
    if (!m || m[2] !== req.kind || RANK[m[1]] < req.tier) return false
    if (req.kind === 'pickaxe' && blockHarvest(req, it) === false) return false
    return usable(bot, it)
  }).sort((a, b) => RANK[b.name.split('_')[0]] - RANK[a.name.split('_')[0]])[0] || null
}
function usable(bot, it) {
  const def = bot.registry && bot.registry.itemsByName && bot.registry.itemsByName[it.name]
  return !(def && def.maxDurability && it.durabilityUsed >= def.maxDurability)
}
function blockHarvest(req, it) {
  return !req.harvestTools || !!req.harvestTools[it.type]
}
function enabled(ctx) { return process.env.BOT_BODY === 'baritone' && !ctx.internalTool }

function unavailable(owner, req) {
  owner.toolPrepBackoff = owner.toolPrepBackoff || {}
  owner.toolPrepFailures = owner.toolPrepFailures || {}
  const failures = owner.toolPrepFailures[req.kind] = (owner.toolPrepFailures[req.kind] || 0) + 1
  const delay = BACKOFF_MS * Math.min(30, 2 ** Math.min(5, Math.max(0, failures - 2)))
  owner.toolPrepBackoff[req.kind] = Date.now() + delay
  console.log(`tool prep unavailable ${req.kind}; ${failures >= 2 && !req.hand ? 'ending blocked work; ' : ''}retry available in ${delay}ms`)
}

function finish(bot, ctx, owner, p) {
  const alive = p.alive()
  p.cancelled = true
  if (owner.toolPrep === p) owner.toolPrep = null
  if (ctx.toolPrepActive && ctx.toolPrepActive.p === p) ctx.toolPrepActive = null
  if (alive) {
    clearGoal(bot, ctx) // resume by reissuing the parent's original target
    if (p.equipFailed || !carried(bot, p.req)) {
      unavailable(p.budget, p.req)
      if (p.equipFailed) p.budget.toolEquipBackoff[p.req.kind] = p.budget.toolPrepBackoff[p.req.kind]
    } else {
      if (p.budget.toolPrepFailures) p.budget.toolPrepFailures[p.req.kind] = 0
      if (p.budget.toolPrepBackoff) delete p.budget.toolPrepBackoff[p.req.kind]
      if (p.budget.toolEquipBackoff) delete p.budget.toolEquipBackoff[p.req.kind]
    }
  }
}

// true means the prerequisite owns this tick. Called before parent budgets,
// no-gain counters or terminal checks, including while a child craft is flying.
function hold(bot, ctx, owner) {
  const p = owner && owner.toolPrep
  if (!p) return false
  if (!p.alive()) { unavailable(p.budget, p.req); p.cancelled = true; owner.toolPrep = null; return true }
  if (p.flight) return true
  if (Date.now() - p.started >= LIMIT_MS || !p.order) { finish(bot, ctx, owner, p); return true }
  p.flight = true
  Promise.resolve(drive(bot, p.context)).catch(() => { p.order = null }).finally(() => { p.flight = false })
  return true
}

// false holds the first dig until equipment settles or a bounded acquisition
// finishes. Hand-harvestable materials can proceed during failure backoff.
function ready(bot, ctx, owner, block, onUnavailable) {
  // Bootstrap acquisition may hand-cut its small log gap, but even the
  // child must have a harvesting pick before its cobble/ore sub can dig.
  if (process.env.BOT_BODY === 'baritone' && ctx.internalTool) {
    const req = requirement(block)
    return !req || req.hand || !!carried(bot, { ...req, harvestTools: block.harvestTools })
  }
  if (!enabled(ctx) || !owner) return true
  const previous = ctx.toolPrepActive
  if (previous && !previous.p.alive()) {
    if (!previous.p.cancelled) unavailable(previous.p.budget, previous.p.req)
    previous.p.cancelled = true
    previous.owner.toolPrep = null
    ctx.toolPrepActive = null
  }
  if (hold(bot, ctx, owner)) return false
  const req = requirement(block)
  if (!req) return true
  req.harvestTools = block && block.harvestTools
  // Fetch legs are replaced on a goal switch. Their acquisition budget
  // belongs to the castle, so switching steps cannot mint fresh retries.
  const budget = ctx.castleFetch === owner && ctx.castle ? ctx.castle : owner
  const ownerKey = ['bring', 'flat', 'gather', 'castleFetch', 'castle'].find((key) => ctx[key] === owner)
  const tool = carried(bot, req)
  if (tool) {
    if (bot.heldItem === tool || (bot.heldItem && bot.heldItem.name === tool.name)) {
      if (budget.toolPrepFailures) budget.toolPrepFailures[req.kind] = 0
      if (budget.toolPrepBackoff) delete budget.toolPrepBackoff[req.kind]
      if (budget.toolEquipBackoff) delete budget.toolEquipBackoff[req.kind]
      return true
    }
    if ((budget.toolEquipBackoff && budget.toolEquipBackoff[req.kind]) > Date.now()) {
      if (budget.toolPrepFailures && budget.toolPrepFailures[req.kind] >= 2 && onUnavailable) onUnavailable()
      return false
    }
    const gen = stepGen(ctx), parentBring = ctx.bring, parentFlat = ctx.flat, work = ctx.work
    const p = { req, budget, started: Date.now(), order: null, flight: true, cancelled: false }
    p.alive = () => stepGen(ctx) === gen && !p.cancelled && ctx.bring === parentBring && ctx.flat === parentFlat && ctx.work === work && (!ownerKey || ctx[ownerKey] === owner)
    owner.toolPrep = p
    ctx.toolPrepActive = { owner, p }
    Promise.resolve().then(() => p.alive() && bot.equip(tool, 'hand')).catch(() => {
      if (!p.alive()) return
      p.equipFailed = true
      budget.toolEquipBackoff = budget.toolEquipBackoff || {}
      budget.toolEquipBackoff[req.kind] = Date.now() + BACKOFF_MS
    }).finally(() => { p.flight = false })
    return false
  }
  const until = budget.toolPrepBackoff && budget.toolPrepBackoff[req.kind]
  if (until > Date.now()) {
    if (!req.hand && budget.toolPrepFailures && budget.toolPrepFailures[req.kind] >= 2 && onUnavailable) onUnavailable()
    return req.hand
  }
  if (!drive) return req.hand
  const gen = stepGen(ctx), parentBring = ctx.bring, parentFlat = ctx.flat, work = ctx.work
  const tier = req.tier >= 3 ? 'diamond' : req.tier >= 2 ? 'iron' : 'stone'
  const name = `${tier}_${req.kind}`
  const order = { kind: 'item', name, names: [name], toolName: name, want: 1, have: 0,
    phase: 'chestfetch', internalTool: true, packBase: {} }
  order.toolChoices = Object.keys(RANK).filter((t) => RANK[t] >= req.tier).sort((a, b) => RANK[b] - RANK[a]).map((t) => `${t}_${req.kind}`)
  order.names = order.toolChoices
  const p = { req, budget, order, started: Date.now(), flight: false, cancelled: false }
  p.alive = () => !p.cancelled && stepGen(ctx) === gen && ctx.bring === parentBring && ctx.flat === parentFlat && ctx.work === work && (!ownerKey || ctx[ownerKey] === owner)
  // Async cleanup from a cancelled child must neither clear a replacement
  // operation's flight flags nor leave a shared flag stuck true forever.
  const local = { internalTool: true, bringEnd: null, stepStatus: null, craftany: null,
    digInFlight: false, placeInFlight: false, gearInFlight: false }
  p.context = new Proxy(ctx, {
    get(target, key) {
      if (key === 'bring') return p.alive() ? p.order : null
      return Object.hasOwn(local, key) ? local[key] : target[key]
    },
    set(target, key, value) {
      if (key === 'bring') { p.order = value; return true }
      if (Object.hasOwn(local, key)) local[key] = value
      else if (p.alive()) target[key] = value
      return true
    },
  })
  owner.toolPrep = p
  ctx.toolPrepActive = { owner, p }
  clearGoal(bot, ctx)
  console.log(`tool prep ${name} before ${block.name}`)
  return false
}

module.exports = { ready, hold, requirement, carried, usable, setDriver, LIMIT_MS, BACKOFF_MS }
