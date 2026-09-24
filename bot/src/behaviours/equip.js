'use strict'

const { goals } = require('mineflayer-pathfinder')
const Vec3 = require('vec3')
const { countItems } = require('../perception')
const craftMod = require('./craft')
const fightMod = require('./fight')

// equip: rebuild the starter kit after death (idkcraft-atl.6, owner
// 2026-09-24: stone_pickaxe, stone_sword, ~32 scaffold blocks). Order is
// pickaxe -> sword -> blocks: the pickaxe is ef3's hands (dig_up needs it),
// the sword goes to the hand for fight/meleeReflex via equipGear, blocks
// dig by hand when poor and from stone once the pickaxe lands.
// Registered in BEHAVIOURS under 'equip' so the goal arbiter can pick it.
// Reports via ctx.stepStatus, one op per tick with ctx.equipInFlight (same
// shape as craft). Recipes come from bot.recipesFor/bot.craft through the
// shared craft.js helpers; a table from the inventory is placed at the feet,
// a placed ctx.home.table is walked to like the craft step does.

const TABLE_REACH = craftMod.TABLE_REACH
const DIG_REACH = 4
// Drops land where the block stood: digging past pickup reach (~2) leaves
// every drop on the ground and the kit never fills (live lesson — the stall
// below fired with a full field of uncollected dirt). Walk closer first.
const PICKUP_REACH = 2
// Below this the bot digs more scaffold nearby; digging stops here.
const SCAFFOLD_LOW = 16
const SCAFFOLD_FULL = 32
// Same craft succeeding this often without the item landing means the result
// never reaches the inventory (lag/full): fail loudly, the atl.4 hold keeps
// the menu from re-picking us at the same facts (no eternal loop).
const CRAFT_STALL_STRIKES = 3
// Dig attempts before giving up (drops lost, no dirt near): fail, hold, rest.
const DIG_STALL_STRIKES = 64

function scaffoldCount(bot) {
  return countItems(bot, (n) => n === 'dirt' || n === 'cobblestone')
}

function hasSword(bot) {
  return countItems(bot, (n) => n.endsWith('_sword')) > 0
}

function hasPickaxe(bot) {
  return countItems(bot, (n) => n.endsWith('_pickaxe')) > 0
}

function itemsOf(bot) {
  try {
    const items = bot.inventory && typeof bot.inventory.items === 'function' && bot.inventory.items()
    return Array.isArray(items) ? items : []
  } catch (_) {
    return []
  }
}

function dist3(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
}

function fail(ctx, item, err) {
  ctx.stepStatus = `failed:equip-${item}`
  try {
    console.error(`equip failed item=${item} error=${err && err.message ? err.message : err}`)
  } catch (_) { /* logging best-effort */ }
}

// Placed table for the tool recipes: the walked-to ctx.home.table first
// (craft-step contract), else a table from the inventory placed beside the
// body. Resolves { block, pos }, resolves null while walking into reach,
// and REJECTS when no table can be had (fail loudly, the atl.4 hold keeps
// the menu from re-picking us). Name checks are load-bearing: an air or
// wrong block reads truthy, and activating it waits out the window timeout
// instead of failing (live 26.1 lesson).
function tableFor(bot, ctx) {
  const nope = (why) => Promise.reject(new Error(why))
  const bp = bot.entity && bot.entity.position
  if (!bp) return nope('no-table')
  const st = (ctx.equip && typeof ctx.equip === 'object') ? ctx.equip : (ctx.equip = {})
  // Our own placed station doubles as the home table when homeless (the
  // claim above only sticks while ctx.home exists).
  const homeTable = (ctx.home && ctx.home.table) || (st.tablePos)
  if (homeTable) {
    let block = null
    try { block = bot.blockAt && bot.blockAt(homeTable) } catch (_) { block = null }
    if (block && block.name === 'crafting_table' && dist3(bp, homeTable) <= TABLE_REACH) {
      st.walkWaits = 0
      return Promise.resolve({ block, pos: homeTable })
    }
    if (block && block.name === 'crafting_table') {
      const key = `equip-table:${homeTable.x},${homeTable.y},${homeTable.z}`
      if (key !== ctx.lastGoalKey && bot.pathfinder && typeof bot.pathfinder.setGoal === 'function') {
        bot.pathfinder.setGoal(new goals.GoalNear(homeTable.x, homeTable.y, homeTable.z, 3), false)
        ctx.lastGoalKey = key
      }
      st.walkWaits = (st.walkWaits || 0) + 1
      // Walking that never arrives is a stall, not progress: fail so the
      // menu holds us instead of idling here forever.
      if (st.walkWaits > 20) return nope('table-unreachable')
      return Promise.resolve(null) // walking: retry on a later tick
    }
    // Ghost table (mined away): fall through to the inventory branch.
  }
  const tableItem = itemsOf(bot).find((i) => i && i.name === 'crafting_table')
  if (!tableItem || typeof bot.placeBlock !== 'function' || !bot.blockAt) return nope('no-table')
  // Beside the body, not under it: the feet cell collides with the bot and
  // the server rejects the placement. First free neighbour with solid
  // ground wins.
  const bx = Math.floor(bp.x)
  const by = Math.floor(bp.y)
  const bz = Math.floor(bp.z)
  let ref = null
  let at = null
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    let below = null
    let cell = null
    try {
      below = bot.blockAt(new Vec3(bx + dx, by - 1, bz + dz))
      cell = bot.blockAt(new Vec3(bx + dx, by, bz + dz))
    } catch (_) { below = null; cell = null }
    if (!below || !below.position || !below.name || below.name === 'air') continue
    if (cell && cell.name && cell.name !== 'air') continue
    ref = below
    at = new Vec3(below.position.x, below.position.y + 1, below.position.z)
    break
  }
  if (!ref) return nope('no-table')
  // mineflayer places the HELD item: hold the table or a planks block lands
  // (and reads truthy) where the table should be.
  const run = async () => {
    if (typeof bot.equip === 'function') {
      try {
        await bot.equip(tableItem, 'hand')
      } catch (_) { /* held already or bust: placement decides */ }
    }
    await bot.placeBlock(ref, new Vec3(0, 1, 0))
    let block = null
    try { block = bot.blockAt(at) } catch (_) { block = null }
    if (!block || block.name !== 'crafting_table') throw new Error('table-place')
    // Claim the placed station (craft-step contract): the menu's table
    // clause sees it and stops rebuilding tables from planks while we arm.
    // Build overwrites the claim with its own site table when it lands one.
    try {
      st.tablePos = { x: at.x, y: at.y, z: at.z }
      if (ctx.home && typeof ctx.home === 'object') ctx.home.table = at
    } catch (_) { /* claim best-effort */ }
    return { block, pos: at }
  }
  // A hung placement must not wedge the menu (see the in-flight stickiness
  // in decide()): time out into the loud failure instead.
  const timeout = new Promise((_, reject) => {
    const t = setTimeout(() => reject(new Error('table-timeout')), 15000)
    if (t && typeof t.unref === 'function') t.unref()
  })
  return Promise.race([run(), timeout])
}

// One craft op (sticks, planks or the tool itself). Returns the op, null
// when the tool is complete, or { fail: reason } when stuck.
function toolOp(bot, kind) {
  const logs = craftMod.tally(bot, '_log')
  const planks = craftMod.sortedWoods(craftMod.tally(bot, '_planks'))
  const sticks = countItems(bot, (n) => n === 'stick')
  const cobble = countItems(bot, (n) => n === 'cobblestone')
  const needSticks = kind === 'pickaxe' ? 2 : 1
  const needRock = kind === 'pickaxe' ? 3 : 2
  if (sticks < needSticks) {
    if (planks.length > 0 && planks[0][1] >= 2) {
      const found = craftMod.recipes(bot, 'stick', null)
      if (found.length > 0) return { item: 'stick', recipe: found[0], count: 1, table: null }
      return { fail: 'no-stick-recipe' }
    }
    if (logs.size > 0) {
      const [wood] = craftMod.sortedWoods(logs)[0]
      const found = craftMod.recipes(bot, `${wood}_planks`, null)
      if (found.length > 0) return { item: `${wood}_planks`, recipe: found[0], count: 1, table: null }
      return { fail: 'no-planks-recipe' }
    }
    return { fail: 'no-materials' }
  }
  const stone = cobble >= needRock
  // Any planks do: wooden tools share one name whatever the wood (there is
  // no oak_pickaxe — the recipe lookup would miss it).
  const wood = planks.length > 0 && planks[0][1] >= needRock
  if (!stone && !wood) return { fail: 'no-materials' }
  const tool = kind === 'pickaxe' ? 'pickaxe' : 'sword'
  return { item: stone ? `stone_${tool}` : `wooden_${tool}`, stone, tabled: true }
}

function digTargets(bot) {
  const names = ['dirt', 'grass_block']
  if (hasPickaxe(bot)) names.push('stone', 'cobblestone')
  return names
}

function equip(bot, ctx) {
  if (ctx.equipInFlight) return // exactly one op at a time
  const bp = bot.entity && bot.entity.position
  if (!bp) return
  const st = (ctx.equip && typeof ctx.equip === 'object') ? ctx.equip : (ctx.equip = {})
  const kind = !hasPickaxe(bot) ? 'pickaxe' : !hasSword(bot) ? 'sword' : null
  if (!kind) {
    if (scaffoldCount(bot) >= SCAFFOLD_FULL) {
      ctx.stepStatus = 'done'
      return
    }
    digTick(bot, ctx, st, bp)
    return
  }
  const op = toolOp(bot, kind)
  if (!op) return
  if (op.fail) {
    fail(ctx, kind, new Error(op.fail))
    return
  }
  if (op.tabled) {
    ctx.equipInFlight = true
    void tableFor(bot, ctx).then(
      (t) => {
        ctx.equipInFlight = false
        if (!t) return // walking into reach: stay silent, retry next tick
        const found = craftMod.recipes(bot, op.item, t.block)
        if (found.length === 0) {
          fail(ctx, op.item, new Error('no-recipe'))
          return
        }
        craftOne(bot, ctx, { item: op.item, recipe: found[0], count: 1, table: t.block })
      },
      (err) => {
        ctx.equipInFlight = false
        fail(ctx, op.item, err)
      },
    )
    return
  }
  craftOne(bot, ctx, op)
}

function craftOne(bot, ctx, op) {
  if (typeof bot.craft !== 'function') {
    fail(ctx, op.item, new Error('bot.craft missing'))
    return
  }
  const st = (ctx.equip && typeof ctx.equip === 'object') ? ctx.equip : (ctx.equip = {})
  ctx.equipInFlight = true
  const run = async () => {
    try {
      await bot.craft(op.recipe, op.count, op.table)
    } catch (err) {
      ctx.equipInFlight = false
      fail(ctx, op.item, err)
      return
    }
    ctx.equipInFlight = false
    const strikes = (st.made && st.made[op.item]) || 0
    const landed = op.item === 'stick' ? countItems(bot, (n) => n === 'stick') > 0
      : op.item.endsWith('_planks') ? true // planks feed the next op, not the kit
      : op.item.endsWith('_pickaxe') ? hasPickaxe(bot) : hasSword(bot)
    if (!landed) {
      st.made = st.made || {}
      st.made[op.item] = strikes + 1
      if (st.made[op.item] >= CRAFT_STALL_STRIKES) {
        fail(ctx, op.item, new Error('craft-stall'))
        return
      }
    } else if (st.made) {
      try { delete st.made[op.item] } catch (_) { /* guard best-effort */ }
    }
    if (op.item.endsWith('_sword')) {
      try { fightMod.equipGear(bot) } catch (_) { /* best-effort: fight equips anyway */ }
    }
    try { bot.chat(`equipped ${op.item}`) } catch (_) { /* chat best-effort */ }
  }
  void run()
}

function digTick(bot, ctx, st, bp) {
  if (st.digs == null) st.digs = 0
  if (st.digs >= DIG_STALL_STRIKES) {
    fail(ctx, 'blocks', new Error('dig-stall'))
    return
  }
  const names = digTargets(bot)
  let found = null
  try {
    found = bot.findBlocks && bot.findBlocks({
      matching: (b) => !!b && typeof b.name === 'string' && names.includes(b.name),
      maxDistance: 12,
      count: 8,
    })
  } catch (_) { found = null }
  if (!found || !found.length) {
    fail(ctx, 'blocks', new Error('no-dirt'))
    return
  }
  // Never dig the ground under our own feet: dig around, not down.
  // Hand-diggable dirt first: stone needs the pickaxe in hand, so it is the
  // fallback when no dirt is near. findBlocks yields positions, so resolve
  // names through blockAt (unit mocks may carry the name already).
  const feetX = Math.floor(bp.x)
  const feetY = Math.floor(bp.y) - 1
  const feetZ = Math.floor(bp.z)
  const cands = []
  for (const v of found) {
    if (!v || typeof v.x !== 'number') continue
    if (Math.floor(v.x) === feetX && Math.floor(v.y) === feetY && Math.floor(v.z) === feetZ) continue
    let name = typeof v.name === 'string' ? v.name : null
    let blk = null
    if (!name && bot.blockAt) {
      try { blk = bot.blockAt(new Vec3(v.x, v.y, v.z)) } catch (_) { blk = null }
      if (blk && typeof blk.name === 'string') name = blk.name
    }
    if (!name || !names.includes(name)) continue
    const hard = name === 'stone' || name === 'cobblestone'
    cands.push({ v, blk, name, hard, d: Math.hypot(v.x - bp.x, v.y - bp.y, v.z - bp.z) })
  }
  cands.sort((a, b) => ((a.hard ? 1 : 0) - (b.hard ? 1 : 0)) || (a.d - b.d))
  const pick = cands[0]
  if (!pick) {
    fail(ctx, 'blocks', new Error('no-dirt'))
    return
  }
  const block = pick.v
  if (pick.d > DIG_REACH) {
    const key = `equip-dig:${Math.floor(block.x)},${Math.floor(block.y)},${Math.floor(block.z)}`
    if (key !== ctx.lastGoalKey && bot.pathfinder && typeof bot.pathfinder.setGoal === 'function') {
      bot.pathfinder.setGoal(new goals.GoalNear(block.x, block.y, block.z, 3), false)
      ctx.lastGoalKey = key
    }
    return // walk into reach, then dig on a later tick
  }
  if (pick.d > PICKUP_REACH) {
    // Close enough to dig, too far to collect: step in so the drops land
    // at the feet (see PICKUP_REACH above).
    const key = `equip-pickup:${Math.floor(block.x)},${Math.floor(block.y)},${Math.floor(block.z)}`
    if (key !== ctx.lastGoalKey && bot.pathfinder && typeof bot.pathfinder.setGoal === 'function') {
      bot.pathfinder.setGoal(new goals.GoalNear(block.x, block.y, block.z, 1), false)
      ctx.lastGoalKey = key
    }
    return
  }
  if (ctx.equipDigInFlight || typeof bot.dig !== 'function') return
  ctx.equipDigInFlight = true
  st.digs++
  const run = async () => {
    try {
      const target = pick.blk || block
      // Stone dug by hand drops nothing: hold the pickaxe first.
      if (pick.hard && typeof bot.equip === 'function') {
        const held = itemsOf(bot).find((i) => i && typeof i.name === 'string' && i.name.endsWith('_pickaxe'))
        if (held) await bot.equip(held, 'hand')
      }
      await bot.dig(target)
    } catch (err) {
      ctx.equipDigInFlight = false
      fail(ctx, 'blocks', err)
      return
    }
    ctx.equipDigInFlight = false
  }
  void run()
}

module.exports = equip
module.exports.SCAFFOLD_LOW = SCAFFOLD_LOW
module.exports.SCAFFOLD_FULL = SCAFFOLD_FULL
