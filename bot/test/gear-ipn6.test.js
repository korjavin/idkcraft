'use strict'

// Gear follow-ups (idkcraft-ipn.6): armour rungs in the RUNGS table (self set
// worn at the forge, owner spares through the existing haul) and the pantry
// withdraw (stranded ladder mats drawn from the home chest before the rung
// yields to the fetchers or the deep leg).

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const gear = require('../src/behaviours/gear')
const stockpile = require('../src/behaviours/stockpile')
const resources = require('../src/resources')
const deliver = require('../src/behaviours/deliver')
const { wornItems } = require('../src/perception')

const tick = (ms) => new Promise((resolve) => setTimeout(resolve, ms || 30))

function pos(x, y, z) {
  return {
    x, y, z,
    distanceTo: (q) => Math.hypot(x - q.x, y - q.y, z - q.z),
    clone() { return pos(x, y, z) },
    floored() { return { x: Math.floor(x), y: Math.floor(y), z: Math.floor(z) } },
  }
}

function mockBot({ items = [], ids = {}, recipes = {}, craftImpl = null, cells = {}, slots = null, equipImpl = null, at = null, chestStacks = null } = {}) {
  const lines = []
  const calls = { craft: [], goals: [], equip: [] }
  const itemsByName = {}
  for (const [name, id] of Object.entries(ids)) itemsByName[name] = { id }
  const bot = {
    lines, calls,
    _items: items,
    entity: { position: at || pos(0, 64, 0), onGround: true },
    registry: { itemsByName },
    inventory: { items: () => bot._items, slots },
    recipesFor: (id) => {
      const name = Object.keys(ids).find((n) => ids[n] === id)
      if (!(name in recipes)) throw new Error(`unexpected recipesFor(${name})`)
      const r = recipes[name]
      return r ? [r] : []
    },
    craft: craftImpl || (async (recipe, count, table) => {
      calls.craft.push({ recipe, count, table: !!table })
      if (recipe && recipe.provides) bot._items.push({ name: recipe.provides, count: (recipe.n || 1) * count })
    }),
    equip: equipImpl || (async (item, dest) => {
      calls.equip.push({ name: item && item.name, dest })
    }),
    blockAt: (p) => {
      const name = cells[`${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`]
      if (!name) return null
      return { name, position: pos(p.x, p.y, p.z) }
    },
    pathfinder: {
      setGoal: (goal) => { calls.goals.push(goal) },
      isMoving: () => false,
    },
    time: { timeOfDay: 6000 },
    players: {},
    chat: (line) => { lines.push(String(line)) },
  }
  if (chestStacks) {
    bot.openChest = async () => ({
      containerItems: () => chestStacks,
      withdraw: async (type, meta, take) => {
        const s = chestStacks.find((c) => c && c.type === type && (c.metadata || null) === (meta || null) && (c.count || 0) > 0)
        if (!s) return
        const n = Math.min(s.count, take)
        s.count -= n
        bot._items.push({ name: s.name, count: n })
      },
      close: () => {},
    })
  }
  return bot
}

const home = (over) => ({ site: { x: 0, y: 64, z: 0 }, built: true, table: { x: 0, y: 64, z: 0 }, ...(over || {}) })
// Adopted chest one east of the table, inside withdraw reach of the pad.
const homeChest = (over) => home({ chest: { x: 1, y: 64, z: 0 }, ...(over || {}) })

const TOOLS = [{ name: 'iron_pickaxe', count: 1 }, { name: 'water_bucket', count: 2 }]
const TOOLS_GIVEN = { water_bucket: 2, iron_sword: 1, iron_pickaxe: 1 }
const IRON_ARMOR_GIVEN = { iron_helmet: 1, iron_chestplate: 1, iron_leggings: 1, iron_boots: 1 }
const IRON_SELF_PACK = [
  { name: 'iron_helmet', count: 1 }, { name: 'iron_chestplate', count: 1 },
  { name: 'iron_leggings', count: 1 }, { name: 'iron_boots', count: 1 },
]
// Worn set in the mineflayer armour slots (head=5..feet=8), by suffix.
function wornSet(names) {
  const slots = new Array(46).fill(null)
  for (const n of names) {
    if (n.endsWith('_helmet')) slots[5] = { name: n }
    else if (n.endsWith('_chestplate')) slots[6] = { name: n }
    else if (n.endsWith('_leggings')) slots[7] = { name: n }
    else if (n.endsWith('_boots')) slots[8] = { name: n }
  }
  return slots
}
const IRON_WORN = ['iron_helmet', 'iron_chestplate', 'iron_leggings', 'iron_boots']
const DIAMOND_WORN = ['diamond_helmet', 'diamond_chestplate', 'diamond_leggings', 'diamond_boots']

describe('ipn.6 worn counting', () => {
  it('wornItems reads slots 5-8, nothing else', () => {
    const slots = new Array(46).fill(null)
    slots[5] = { name: 'iron_helmet' }
    slots[8] = { name: 'iron_boots' }
    slots[9] = { name: 'iron_helmet' } // pack slot: not worn
    slots[36] = { name: 'iron_boots' } // hotbar: not worn
    const bot = mockBot({ slots })
    assert.equal(wornItems(bot, 'iron_helmet'), 1)
    assert.equal(wornItems(bot, 'iron_boots'), 1)
    assert.equal(wornItems(bot, 'iron_chestplate'), 0)
  })
  it('wornItems is best-effort 0 without slots', () => {
    assert.equal(wornItems(mockBot(), 'iron_helmet'), 0)
    assert.equal(wornItems(null, 'iron_helmet'), 0)
    assert.equal(wornItems(mockBot({ slots: {} }), 'iron_helmet'), 0)
  })
})

describe('ipn.6 armour derivation', () => {
  it('armour order per tier: self helmet..boots, then owner spares', () => {
    const order = []
    const bot = mockBot({ items: [...TOOLS] })
    const ctx = { gearGiven: { ...TOOLS_GIVEN } }
    // Walk the rung machine by completing each derived piece: self pieces
    // land in the pack (pre-wear counts), owner pieces in the ledger.
    for (let i = 0; i < 8; i++) {
      const next = gear.deriveNext(bot, ctx)
      order.push(`${next.owner ? 'give' : 'self'}:${next.name}`)
      if (next.owner) ctx.gearGiven[next.name] = 1
      else bot._items.push({ name: next.name, count: 1 })
    }
    assert.deepEqual(order, [
      'self:iron_helmet', 'self:iron_chestplate', 'self:iron_leggings', 'self:iron_boots',
      'give:iron_helmet', 'give:iron_chestplate', 'give:iron_leggings', 'give:iron_boots',
    ])
  })
  it('a worn piece satisfies the self rung with an empty pack', () => {
    // Only the helmet worn: chestplate derives (helmet skipped on worn).
    const bot = mockBot({ items: [...TOOLS], slots: wornSet(['iron_helmet']) })
    const next = gear.deriveNext(bot, { gearGiven: { ...TOOLS_GIVEN } })
    assert.equal(next.name, 'iron_chestplate')
    assert.equal(next.owner, false)
  })
  it('pack-only self armour counts (mid-wear never reforges)', () => {
    const bot = mockBot({ items: [...TOOLS, { name: 'iron_helmet', count: 1 }] })
    const next = gear.deriveNext(bot, { gearGiven: { ...TOOLS_GIVEN } })
    assert.equal(next.name, 'iron_chestplate')
  })
  it('a worn self piece never satisfies an owner want', () => {
    // Self set worn, owner helmet unforged: the owner rung still derives.
    const bot = mockBot({ items: [...TOOLS], slots: wornSet(IRON_WORN) })
    const next = gear.deriveNext(bot, { gearGiven: { ...TOOLS_GIVEN } })
    assert.equal(next.name, 'iron_helmet')
    assert.equal(next.owner, true)
  })
  it('mat needs: 5/8/7/4, no sticks', () => {
    const wants = {}
    const bot = mockBot({ items: [...TOOLS] })
    const ctx = { gearGiven: { ...TOOLS_GIVEN } }
    for (let i = 0; i < 4; i++) {
      const next = gear.deriveNext(bot, ctx)
      wants[next.kind] = [next.needMat, next.needSticks]
      bot._items.push({ name: next.name, count: 1 })
    }
    assert.deepEqual(wants, { helmet: [5, 0], chestplate: [8, 0], leggings: [7, 0], boots: [4, 0] })
  })
  it('diamond armour trails diamond tools, full ladder reads complete', () => {
    const tools = [...TOOLS, { name: 'diamond_pickaxe', count: 1 }]
    const given = { ...TOOLS_GIVEN, ...IRON_ARMOR_GIVEN, diamond_sword: 1, diamond_pickaxe: 1 }
    const first = gear.deriveNext(mockBot({ items: tools, slots: wornSet(IRON_WORN) }), { gearGiven: given })
    assert.equal(first.name, 'diamond_helmet')
    assert.equal(first.owner, false)
    // End of ladder: diamond worn, iron swapped to the pack, all handed.
    const end = mockBot({ items: [...tools, ...IRON_SELF_PACK], slots: wornSet(DIAMOND_WORN) })
    const endCtx = {
      gearGiven: {
        ...given,
        diamond_helmet: 1, diamond_chestplate: 1, diamond_leggings: 1, diamond_boots: 1,
      },
    }
    assert.equal(gear.deriveNext(end, endCtx), null)
  })
  it('a lost set re-derives from the helmet (death regression)', () => {
    const bot = mockBot({ items: [...TOOLS] })
    const ctx = { gearGiven: { ...TOOLS_GIVEN, ...IRON_ARMOR_GIVEN } }
    const next = gear.deriveNext(bot, ctx)
    assert.equal(next.name, 'iron_helmet')
    assert.equal(next.owner, false)
  })
})

describe('ipn.6 armour planning', () => {
  const C = (over) => ({
    ironOre: 0, ingots: 0, diamonds: 0, sticks: 0, planks: 0, logs: 0,
    iron_pickaxe: 0, iron_sword: 0, diamond_pickaxe: 0, diamond_sword: 0,
    tablePlaced: false, furnaceClaim: false, furnaceItem: 0, cobble: 0, fuel: 0,
    ...(over || {}),
  })
  const TOOLS_CTX = { gearGiven: { ...TOOLS_GIVEN } }
  const TOOLS_COUNTS = { iron_pickaxe: 1, water_bucket: 2 }
  it('5 ingots and a table craft the helmet with no sticks on hand', () => {
    const p = gear.planFor(C({ ...TOOLS_COUNTS, ingots: 5, tablePlaced: true }), TOOLS_CTX, {})
    assert.deepEqual([p.state, p.action], ['ready', 'craft'])
  })
  it('4 ingots smelt from ore, else want the shortfall', () => {
    const smelt = gear.planFor(
      C({ ...TOOLS_COUNTS, ingots: 4, ironOre: 2, fuel: 5, furnaceClaim: true }),
      TOOLS_CTX, { furnace: true },
    )
    assert.deepEqual([smelt.state, smelt.action], ['ready', 'smelt'])
    const want = gear.planFor(C({ ...TOOLS_COUNTS, ingots: 4 }), TOOLS_CTX, {})
    assert.deepEqual([want.state, want.key], ['want', 'want-ore'])
    assert.ok(want.line.includes('1 more raw iron'))
  })
  it('chestplate prices 8: 7 ingots still want ore', () => {
    const p = gear.planFor(
      C({ ...TOOLS_COUNTS, ingots: 7, tablePlaced: true, iron_helmet: 1 }),
      TOOLS_CTX, {},
    )
    assert.deepEqual([p.state, p.key], ['want', 'want-ore'])
  })
  it('liveCounts splits pack and worn armour (revmux 01 core-1/body-1)', () => {
    const bot = mockBot({
      items: [...TOOLS, { name: 'iron_leggings', count: 1 }],
      slots: wornSet(['iron_helmet', 'iron_chestplate']),
    })
    const c = gear.liveCounts(bot, { home: home() })
    assert.equal(c.iron_helmet, 0, 'pack only under the item name')
    assert.equal(c.iron_leggings, 1)
    assert.equal(c.worn_iron_helmet, 1, 'worn rides beside the pack')
    assert.equal(c.worn_iron_chestplate, 1)
    assert.equal(c.worn_iron_leggings, 0)
  })
  it('menuPlan maps armour facts and reads done only on the full set', () => {
    const facts = {
      ironPick: 1, waterBucket: 2, diamondPick: 1, ingots: 8, tablePlaced: true,
      ironHelmet: 0, wornIronHelmet: 1,
    }
    const ctx = { gearGiven: { ...TOOLS_GIVEN } }
    assert.equal(gear.menuPlan(facts, ctx).state, 'ready')
    // Worn-only completion reads done: the self branch adds worn.
    const full = {
      ...facts,
      wornIronChestplate: 1, wornIronLeggings: 1, wornIronBoots: 1,
      wornDiamondHelmet: 1, wornDiamondChestplate: 1, wornDiamondLeggings: 1, wornDiamondBoots: 1,
    }
    const fullCtx = {
      gearGiven: {
        ...TOOLS_GIVEN, ...IRON_ARMOR_GIVEN, diamond_sword: 1, diamond_pickaxe: 1,
        diamond_helmet: 1, diamond_chestplate: 1, diamond_leggings: 1, diamond_boots: 1,
      },
    }
    assert.equal(gear.menuPlan(full, fullCtx).state, 'done')
  })
  it('a tossed spare with the self twin worn never reads hand (core-1/body-1)', () => {
    // The deadlock: worn-inclusive counts held the tossed spare in 'hand',
    // gear went infeasible, the tick never reconciled, the ladder froze.
    // Routed through goalFacts like prod: pre-fix facts inflated the pack
    // count with the worn twin and the menu read 'hand' forever.
    const goal = require('../src/goal')
    const bot = mockBot({ items: [...TOOLS], slots: wornSet(['iron_helmet']) })
    const ctx = {
      home: { built: true },
      gearGiven: { ...TOOLS_GIVEN },
      gear: { made: { iron_helmet: true } }, gearFinished: { iron_helmet: 1 },
      haul: { iron_helmet: 0 }, // tossed to the online owner
    }
    const facts = goal.goalFacts(bot, ctx)
    assert.equal(facts.ironHelmet, 0, 'pack only, the worn twin excluded')
    assert.equal(facts.wornIronHelmet, 1)
    const p = gear.menuPlan(facts, ctx)
    assert.notEqual(p.state, 'hand', 'tossed spare must not hold handover')
    assert.equal(goal.MENU.gear.feasible(facts, mockBot(), ctx), true, 'gear runs and reconciles')
    // And the tick settles the ledger: given lands, the ladder advances.
    const tctx = { ...ctx, home: home(), stepStatus: 'running' }
    gear(bot, tctx)
    assert.equal(tctx.gearGiven.iron_helmet, 1, 'reconcile marks the toss handed')
    assert.equal(gear.deriveNext(bot, tctx).name, 'iron_chestplate')
  })
})

describe('ipn.6 wear at the forge', () => {
  const SLOT = { head: 5, torso: 6, legs: 7, feet: 8 }
  // Live-shaped equip: moves one unit from the pack to the armour slot.
  function wearingBot(bot) {
    const slots = bot.inventory.slots
    bot.equip = async (item, dest) => {
      bot.calls.equip.push({ name: item && item.name, dest })
      const i = bot._items.findIndex((e) => e && e.name === item.name && (e.count || 0) > 0)
      if (i >= 0) {
        bot._items[i].count -= 1
        if (bot._items[i].count <= 0) bot._items.splice(i, 1)
      }
      const prev = slots[SLOT[dest]]
      slots[SLOT[dest]] = { name: item.name }
      if (prev && prev.name) bot._items.push({ name: prev.name, count: 1 })
    }
    return bot
  }
  it('self armour forge equips the piece, banks nothing', async () => {
    const bot = wearingBot(mockBot({
      items: [...TOOLS, { name: 'iron_ingot', count: 5 }],
      ids: { iron_helmet: 31 },
      recipes: { iron_helmet: { provides: 'iron_helmet' } },
      cells: { '0,64,0': 'crafting_table' },
      slots: new Array(46).fill(null),
    }))
    const ctx = { home: home(), stepStatus: 'running', gearGiven: { ...TOOLS_GIVEN } }
    gear(bot, ctx)
    assert.equal(ctx.gearInFlight, true)
    await tick(1300) // craft settle + wear settle
    assert.equal(ctx.gearInFlight, false)
    assert.deepEqual(bot.calls.equip, [{ name: 'iron_helmet', dest: 'head' }])
    assert.equal(bot.inventory.slots[5].name, 'iron_helmet')
    assert.deepEqual(ctx.haul || {}, {})
    assert.deepEqual(ctx.gearFinished || {}, {})
    assert.ok(bot.lines.some((l) => l.includes('forged iron_helmet for me')))
    // Worn reads complete: the rung advances without a reforge.
    const next = gear.deriveNext(bot, ctx)
    assert.equal(next.name, 'iron_chestplate')
  })
  it('owner armour forge never equips: haul and finished record instead', async () => {
    const bot = mockBot({
      items: [...TOOLS, { name: 'iron_ingot', count: 5 }],
      ids: { iron_helmet: 31 },
      recipes: { iron_helmet: { provides: 'iron_helmet' } },
      cells: { '0,64,0': 'crafting_table' },
      slots: wornSet(IRON_WORN),
    })
    const ctx = { home: home(), stepStatus: 'running', gearGiven: { ...TOOLS_GIVEN } }
    gear(bot, ctx)
    await tick(900)
    assert.equal(bot.calls.equip.length, 0)
    assert.deepEqual(ctx.haul, { iron_helmet: 1 })
    assert.deepEqual(ctx.gearFinished, { iron_helmet: 1 })
    assert.equal(ctx.gear.made.iron_helmet, true)
    assert.ok(bot.lines.some((l) => l.includes('forged iron_helmet for you')))
  })
  it('diamond over iron swaps the old tier to the pack', async () => {
    const bot = wearingBot(mockBot({
      items: [
        ...TOOLS, { name: 'diamond_pickaxe', count: 1 }, { name: 'diamond', count: 5 },
      ],
      ids: { diamond_helmet: 32 },
      recipes: { diamond_helmet: { provides: 'diamond_helmet' } },
      cells: { '0,64,0': 'crafting_table' },
      slots: wornSet(IRON_WORN),
    }))
    const ctx = {
      home: home(), stepStatus: 'running',
      gearGiven: { ...TOOLS_GIVEN, ...IRON_ARMOR_GIVEN, diamond_sword: 1, diamond_pickaxe: 1 },
    }
    gear(bot, ctx)
    await tick(1300)
    assert.deepEqual(bot.calls.equip, [{ name: 'diamond_helmet', dest: 'head' }])
    assert.equal(bot.inventory.slots[5].name, 'diamond_helmet')
    assert.ok(bot._items.some((i) => i.name === 'iron_helmet'), 'old tier swaps to the pack')
    // Both rungs read complete: no iron reforge, no diamond reforge.
    const next = gear.deriveNext(bot, ctx)
    assert.equal(next.name, 'diamond_chestplate')
  })
  it('the second piece equips to its own slot, not the first', async () => {
    // A wrong kind->destination table wears the chestplate as a helmet and
    // the rung silently completes — forge the chestplate and read slot 6.
    const bot = wearingBot(mockBot({
      items: [...TOOLS, { name: 'iron_ingot', count: 8 }],
      ids: { iron_chestplate: 33 },
      recipes: { iron_chestplate: { provides: 'iron_chestplate' } },
      cells: { '0,64,0': 'crafting_table' },
      slots: wornSet(['iron_helmet']),
    }))
    const ctx = { home: home(), stepStatus: 'running', gearGiven: { ...TOOLS_GIVEN } }
    gear(bot, ctx)
    await tick(1300)
    assert.deepEqual(bot.calls.equip, [{ name: 'iron_chestplate', dest: 'torso' }])
    assert.equal(bot.inventory.slots[6].name, 'iron_chestplate')
    assert.equal(bot.inventory.slots[5].name, 'iron_helmet')
  })
  it('a lag-rejected equip retries until worn (core-2)', async () => {
    const slots = new Array(46).fill(null)
    let tries = 0
    const bot = mockBot({
      items: [...TOOLS, { name: 'iron_ingot', count: 5 }],
      ids: { iron_helmet: 31 },
      recipes: { iron_helmet: { provides: 'iron_helmet' } },
      cells: { '0,64,0': 'crafting_table' },
      slots,
      equipImpl: async (item, dest) => {
        tries += 1
        if (tries < 3) throw new Error('window lag')
        const i = bot._items.findIndex((e) => e && e.name === item.name)
        if (i >= 0) bot._items.splice(i, 1)
        slots[5] = { name: item.name }
      },
    })
    const ctx = { home: home(), stepStatus: 'running', gearGiven: { ...TOOLS_GIVEN } }
    gear(bot, ctx)
    await tick(2600) // craft settle + 3 wear settles
    assert.equal(tries, 3)
    assert.equal(slots[5].name, 'iron_helmet')
    assert.equal(ctx.gearInFlight, false)
  })
  it('a persistently failing equip strands loudly, never hangs (core-2)', async () => {
    const errs = []
    const orig = console.error
    console.error = (...a) => { errs.push(a.join(' ')) }
    try {
      const bot = mockBot({
        items: [...TOOLS, { name: 'iron_ingot', count: 5 }],
        ids: { iron_helmet: 31 },
        recipes: { iron_helmet: { provides: 'iron_helmet' } },
        cells: { '0,64,0': 'crafting_table' },
        slots: new Array(46).fill(null),
        equipImpl: async () => { throw new Error('slot jammed') },
      })
      const ctx = { home: home(), stepStatus: 'running', gearGiven: { ...TOOLS_GIVEN } }
      gear(bot, ctx)
      await tick(2600)
      assert.equal(ctx.gearInFlight, false)
      assert.ok(bot._items.some((i) => i.name === 'iron_helmet'), 'stranded in the pack')
      assert.ok(errs.some((l) => l.includes('gear wear failed item=iron_helmet')), 'logged, not silent')
    } finally {
      console.error = orig
    }
  })
})

describe('ipn.6 pantry planning', () => {
  const C = (over) => ({
    ironOre: 0, ingots: 0, diamonds: 0, sticks: 0, planks: 0, logs: 0,
    iron_pickaxe: 0, iron_sword: 0, diamond_pickaxe: 0, diamond_sword: 0,
    tablePlaced: false, furnaceClaim: false, furnaceItem: 0, cobble: 0, fuel: 0,
    ...(over || {}),
  })
  const HELMET_COUNTS = { iron_pickaxe: 1, water_bucket: 2 }
  const HELMET_CTX = (over) => ({ gearGiven: { ...TOOLS_GIVEN }, ...(over || {}) })
  it('iron short with a fresh pantry draws before the fetchers walk', () => {
    const ctx = HELMET_CTX({ home: { chest: { x: 1, y: 64, z: 0 } }, gearPantryBanked: 1 })
    const p = gear.planFor(C(HELMET_COUNTS), ctx, {})
    assert.deepEqual([p.state, p.action], ['ready', 'withdraw'])
  })
  it('an unlatched session draws once (pre-restart strands)', () => {
    const ctx = HELMET_CTX({ home: { chest: { x: 1, y: 64, z: 0 } } })
    const p = gear.planFor(C(HELMET_COUNTS), ctx, {})
    assert.deepEqual([p.state, p.action], ['ready', 'withdraw'])
  })
  it('a drawn pantry yields the old want-ore line', () => {
    const ctx = HELMET_CTX({ home: { chest: { x: 1, y: 64, z: 0 } }, gearPantryBanked: 1, gear: { pantrySeen: 1 } })
    const p = gear.planFor(C(HELMET_COUNTS), ctx, {})
    assert.deepEqual([p.state, p.key], ['want', 'want-ore'])
  })
  it('no adopted chest never withdraws', () => {
    const p = gear.planFor(C(HELMET_COUNTS), HELMET_CTX({ gearPantryBanked: 3 }), {})
    assert.deepEqual([p.state, p.key], ['want', 'want-ore'])
  })
  it('a new bank re-arms the drawn latch', () => {
    const ctx = HELMET_CTX({ home: { chest: { x: 1, y: 64, z: 0 } }, gearPantryBanked: 2, gear: { pantrySeen: 1 } })
    const p = gear.planFor(C(HELMET_COUNTS), ctx, {})
    assert.deepEqual([p.state, p.action], ['ready', 'withdraw'])
  })
  it('diamond short draws before the deep expedition, then yields to it', () => {
    const counts = C({ iron_pickaxe: 1, water_bucket: 2, diamonds: 1, sticks: 2, iron_helmet: 1, iron_chestplate: 1, iron_leggings: 1, iron_boots: 1 })
    const ctx = {
      gearGiven: { ...TOOLS_GIVEN, ...IRON_ARMOR_GIVEN },
      home: { chest: { x: 1, y: 64, z: 0 } },
    }
    const fresh = gear.planFor(counts, ctx, { deep: true })
    assert.deepEqual([fresh.state, fresh.action], ['ready', 'withdraw'])
    const drawn = gear.planFor(counts, { ...ctx, gearPantryBanked: 0, gear: { pantrySeen: 0 } }, { deep: true })
    assert.deepEqual([drawn.state, drawn.action], ['ready', 'deep'])
    const waiting = gear.planFor(counts, { ...ctx, gearPantryBanked: 0, gear: { pantrySeen: 0 } }, {})
    assert.deepEqual([waiting.state, waiting.key], ['wait', 'wait-deep'])
  })
  it('ore on hand smelts, pantry or not (withdraw only fills empty hands)', () => {
    const ctx = HELMET_CTX({ home: { chest: { x: 1, y: 64, z: 0 } } })
    const p = gear.planFor(C({ ...HELMET_COUNTS, ironOre: 3, fuel: 5, furnaceClaim: true }), ctx, { furnace: true })
    assert.deepEqual([p.state, p.action], ['ready', 'smelt'])
  })
})

describe('ipn.6 pantry tick', () => {
  const CELLS = { '0,64,0': 'crafting_table', '1,64,0': 'chest' }
  function chestOf(stacks) {
    return stacks.map(([name, count], i) => ({ name, count, type: 100 + i, metadata: null }))
  }
  it('near chest: draws the ingot shortfall, latches, re-plans to craft', async () => {
    const stacks = chestOf([['iron_ingot', 8]])
    const slots = new Array(46).fill(null)
    const bot = mockBot({
      items: [...TOOLS],
      ids: { iron_helmet: 31 },
      recipes: { iron_helmet: { provides: 'iron_helmet' } },
      cells: CELLS,
      slots,
      chestStacks: stacks,
      equipImpl: async (item, dest) => {
        const at = { head: 5, torso: 6, legs: 7, feet: 8 }[dest]
        const i = bot._items.findIndex((e) => e && e.name === item.name)
        if (i >= 0) bot._items.splice(i, 1)
        slots[at] = { name: item.name }
      },
    })
    const ctx = { home: homeChest(), stepStatus: 'running', gearGiven: { ...TOOLS_GIVEN }, gearPantryBanked: 1 }
    gear(bot, ctx)
    assert.equal(ctx.gearInFlight, true, 'withdraw holds the window')
    await tick(300)
    assert.equal(ctx.gearInFlight, false)
    assert.equal(ctx.gear.pantrySeen, undefined, 'full draw keeps the batch open (body-2)')
    assert.equal(stacks[0].count, 3, 'drew 5 of 8, the shortfall exactly')
    // The next mat-short rung draws from the same batch, no new bank.
    const p2 = gear.planFor({
      ironOre: 0, ingots: 0, diamonds: 0, sticks: 0, planks: 0, logs: 0,
      iron_pickaxe: 1, water_bucket: 2, iron_helmet: 1,
    }, ctx, {})
    assert.deepEqual([p2.state, p2.action], ['ready', 'withdraw'])
    // Re-plan on stock: the helmet crafts at the table.
    ctx.stepStatus = 'running'
    gear(bot, ctx)
    assert.equal(ctx.gearInFlight, true)
    await tick(1300)
    assert.ok(bot.calls.craft.some((c) => c.recipe && c.recipe.provides === 'iron_helmet'))
    assert.equal(bot.inventory.slots[5].name, 'iron_helmet', 'worn at the forge')
  })
  it('near chest: ore draws when ingots run out, up to the shortfall', async () => {
    const stacks = chestOf([['iron_ingot', 2], ['raw_iron', 9]])
    const bot = mockBot({ items: [...TOOLS, { name: 'coal', count: 5 }], cells: CELLS, chestStacks: stacks })
    const ctx = { home: homeChest({ furnace: { x: 2, y: 64, z: 0 } }), stepStatus: 'running', gearGiven: { ...TOOLS_GIVEN }, gearPantryBanked: 4 }
    gear(bot, ctx)
    await tick(300)
    assert.equal(ctx.gear.pantrySeen, undefined, 'covered rung stays fresh (revmux 02)')
    assert.equal(stacks[0].count, 0, 'ingots first')
    assert.equal(stacks[1].count, 6, 'then ore to the 5-mat shortfall')
    assert.equal(ctx.stepStatus, 'running', 'no yield: re-plan next tick')
    // Re-plan on stock: ore on hand smelts (furnace fake), never want-ore.
    const counts = gear.liveCounts(bot, ctx)
    assert.equal(counts.ingots, 2)
    assert.equal(counts.ironOre, 3)
    const p = gear.planFor(counts, ctx, { furnace: true })
    assert.deepEqual([p.state, p.action], ['ready', 'smelt'])
  })
  it('an ore-only pantry covers the rung and stays fresh (revmux 02)', async () => {
    // The normal stranded batch: surplus banks raw_iron, not ingots. The
    // empty ingot draw must not count as a short draw — the end state
    // (5 ore on hand) covers the helmet, so the batch stays open.
    const stacks = chestOf([['raw_iron', 16]])
    const bot = mockBot({ items: [...TOOLS], cells: CELLS, chestStacks: stacks })
    const ctx = { home: homeChest(), stepStatus: 'running', gearGiven: { ...TOOLS_GIVEN }, gearPantryBanked: 1 }
    gear(bot, ctx)
    await tick(300)
    assert.equal(stacks[0].count, 11)
    assert.equal(ctx.gear.pantrySeen, undefined, 'covered rung stays fresh')
    const counts = gear.liveCounts(bot, ctx)
    assert.equal(counts.ironOre, 5)
    assert.equal(counts.ingots, 0)
  })
  it('a short draw latches: the chest ran dry (body-2)', async () => {
    // Ingots run out mid-draw (2 of 5, no ore): got < requested latches,
    // the rung stays short and yields want-ore on re-plan.
    const stacks = chestOf([['iron_ingot', 2]])
    const bot = mockBot({ items: [...TOOLS], cells: CELLS, chestStacks: stacks })
    const ctx = { home: homeChest(), stepStatus: 'running', gearGiven: { ...TOOLS_GIVEN }, gearPantryBanked: 1 }
    gear(bot, ctx)
    await tick(300)
    assert.equal(ctx.gear.pantrySeen, 1)
    assert.equal(stacks[0].count, 0)
  })
  it('empty chest latches and yields want-ore exactly once', async () => {
    const bot = mockBot({ items: [...TOOLS], cells: CELLS, chestStacks: chestOf([]) })
    const ctx = { home: homeChest(), stepStatus: 'running', gearGiven: { ...TOOLS_GIVEN }, gearPantryBanked: 1 }
    resources.noteSpots(ctx, [{ x: 60, y: 60, z: 0, name: 'iron_ore' }], 1000) // ipn.9: diggable iron keeps the promise line
    gear(bot, ctx)
    await tick(300)
    assert.equal(ctx.gear.pantrySeen, 1)
    ctx.stepStatus = 'running'
    gear(bot, ctx)
    assert.equal(ctx.stepStatus, 'done')
    assert.ok(bot.lines.some((l) => l.includes('need 5 more raw iron')), 'latched want announces')
    const said = bot.lines.length
    ctx.stepStatus = 'running'
    gear(bot, ctx)
    assert.equal(ctx.stepStatus, 'done')
    assert.equal(bot.lines.length, said, 'no withdraw loop, no repeat announce')
  })
  it('far from the chest walks first, opens nothing', () => {
    const stacks = chestOf([['iron_ingot', 8]])
    const bot = mockBot({ items: [...TOOLS], cells: CELLS, chestStacks: stacks, at: pos(30, 64, 30) })
    const ctx = { home: homeChest(), stepStatus: 'running', gearGiven: { ...TOOLS_GIVEN }, gearPantryBanked: 1 }
    gear(bot, ctx)
    assert.equal(bot.calls.goals.length, 1)
    assert.equal(stacks[0].count, 8, 'no window before arrival')
    assert.equal(ctx.stepStatus, 'running')
  })
  it('an unreachable chest latches on give-up, then degrades to want (body-3)', () => {
    const stacks = chestOf([['iron_ingot', 8]])
    const bot = mockBot({ items: [...TOOLS], cells: CELLS, chestStacks: stacks, at: pos(30, 64, 30) })
    const atBest = Math.hypot(30 - 1, 0, 30 - 0) // stalled at the same spot: no progress next tick
    const ctx = { home: homeChest(), stepStatus: 'running', gearGiven: { ...TOOLS_GIVEN }, gearPantryBanked: 1, gearRun: { walkKey: 'gear-chest:1,64,0', walkBest: atBest, walkTicks: 20, walkTotal: 20 } }
    gear(bot, ctx)
    assert.equal(ctx.stepStatus, 'failed:gear-chest-far')
    assert.equal(ctx.gear.pantrySeen, 1, 'give-up latches the pantry')
    assert.equal(stacks[0].count, 8, 'no window on a failed walk')
    // Next pick degrades to the fetchers instead of re-walking.
    const p = gear.planFor({
      ironOre: 0, ingots: 0, diamonds: 0, sticks: 0, planks: 0, logs: 0,
      iron_pickaxe: 1, water_bucket: 2,
    }, ctx, {})
    assert.deepEqual([p.state, p.key], ['want', 'want-ore'])
  })
  it('diamond shortfall draws exact from the chest', async () => {
    const stacks = chestOf([['diamond', 6]])
    const bot = mockBot({
      items: [...TOOLS, { name: 'diamond', count: 1 }, { name: 'stick', count: 2 }],
      cells: CELLS,
      chestStacks: stacks,
    })
    const ctx = {
      home: homeChest(), stepStatus: 'running',
      gearGiven: { ...TOOLS_GIVEN, ...IRON_ARMOR_GIVEN },
      gearPantryBanked: 2,
    }
    // Self iron set packed so the diamond pick derives (need 3, have 1).
    bot._items.push(...IRON_SELF_PACK)
    gear(bot, ctx)
    await tick(300)
    assert.equal(stacks[0].count, 4, 'drew 2 of 6, the shortfall exactly')
    assert.equal(ctx.gear.pantrySeen, undefined, 'exact draw stays fresh for the next rung')
  })
})

describe('ipn.6 pantry signal', () => {
  // Chest-step mock: deposits land (pack shrinks), the step completes.
  function bankBot(items) {
    const ids = {}
    let next = 1
    const idOf = (name) => (ids[name] = ids[name] || next++)
    for (const i of items) idOf(i.name)
    const bot = mockBot({ items })
    bot.entity.position = pos(5.5, 64.5, 1.5)
    bot.registry = { itemsByName: new Proxy({}, { get: (_, n) => ({ id: idOf(n) }) }) }
    bot.blockAt = () => ({ name: 'chest', position: pos(5, 64, 1) })
    bot.openChest = async () => ({
      containerItems: () => [],
      deposit: async (type, _meta, count) => {
        const name = Object.keys(ids).find((k) => ids[k] === type)
        let n = count
        for (let k = bot._items.length - 1; k >= 0 && n > 0; k--) {
          const it = bot._items[k]
          if (!it || it.name !== name) continue
          const take = Math.min(it.count, n)
          it.count -= take
          n -= take
          if (it.count <= 0) bot._items.splice(k, 1)
        }
      },
      close: () => {},
    })
    return bot
  }
  async function bank(bot, ctx) {
    ctx.stepStatus = 'running'
    ctx.lastGoalKey = `stockpile:${ctx.home.chest.x},${ctx.home.chest.y},${ctx.home.chest.z}`
    stockpile(bot, ctx, null, {})
    await tick(300)
    assert.equal(ctx.stockpileInFlight, false)
    return ctx.stepStatus
  }
  const chestCtx = () => ({ home: { site: { x: 0, y: 64, z: 0 }, built: true, chest: { x: 5, y: 64, z: 1 } } })
  it('banking ladder mats bumps the pantry counter', async () => {
    const bot = bankBot([{ name: 'raw_iron', count: 20 }])
    const ctx = chestCtx()
    assert.equal(await bank(bot, ctx), 'done')
    assert.equal(ctx.gearPantryBanked, 1)
    assert.ok(bot.lines.some((l) => l.includes('stockpiled 20 raw_iron')))
  })
  it('banking ingots or diamonds bumps too, dirt does not', async () => {
    const ingots = bankBot([{ name: 'iron_ingot', count: 20 }])
    const c1 = chestCtx()
    assert.equal(await bank(ingots, c1), 'done')
    assert.equal(c1.gearPantryBanked, 1)
    const gems = bankBot([{ name: 'diamond', count: 3 }])
    const c2 = chestCtx()
    assert.equal(await bank(gems, c2), 'done')
    assert.equal(c2.gearPantryBanked, 1)
    const dirt = bankBot([{ name: 'dirt', count: 40 }])
    const c3 = chestCtx()
    assert.equal(await bank(dirt, c3), 'done')
    assert.equal(c3.gearPantryBanked, undefined, 'no ladder mats, no signal')
  })
  it('the signal flips a latched rung back to withdraw', () => {
    const counts = {
      ironOre: 0, ingots: 0, diamonds: 0, sticks: 0, planks: 0, logs: 0,
      iron_pickaxe: 1, water_bucket: 2, tablePlaced: true,
    }
    const ctx = {
      gearGiven: { ...TOOLS_GIVEN },
      home: { chest: { x: 5, y: 64, z: 1 } },
      gearPantryBanked: 1, gear: { pantrySeen: 1 },
    }
    assert.equal(gear.planFor(counts, ctx, {}).state, 'want')
    ctx.gearPantryBanked = 2 // stockpile banked mid-rung
    const p = gear.planFor(counts, ctx, {})
    assert.deepEqual([p.state, p.action], ['ready', 'withdraw'])
  })
})

describe('ipn.6 armour handover', () => {
  it('depositPlan banks finished owner armour, keeps the rest', () => {
    const bot = mockBot({
      items: [
        ...TOOLS, { name: 'iron_helmet', count: 1 }, { name: 'iron_chestplate', count: 1 },
        { name: 'cobblestone', count: 40 },
      ],
    })
    const ctx = { gearFinished: { iron_helmet: 1 } }
    const plan = stockpile.depositPlan(bot, ctx)
    assert.ok(plan.some((p) => p.name === 'iron_helmet' && p.count === 1), 'finished spare banks')
    assert.ok(!plan.some((p) => p.name === 'iron_chestplate'), 'unfinished piece stays')
    assert.ok(!plan.some((p) => p.name === 'iron_pickaxe'), 'self pick stays')
  })
  it('deliver tosses the full owner spare: armour reserve is zero', () => {
    const bot = mockBot({ items: [...TOOLS, { name: 'iron_chestplate', count: 1 }] })
    const live = deliver.haulLive(bot, { haul: { iron_chestplate: 1 } })
    assert.deepEqual(live.items, { iron_chestplate: 1 })
  })
  it('forged-then-vanished owner armour reads as handed over, silently', () => {
    const bot = mockBot({ items: [...TOOLS], slots: wornSet(IRON_WORN) })
    const ctx = {
      gear: { made: { iron_helmet: true } }, gearFinished: { iron_helmet: 1 },
      gearGiven: { ...TOOLS_GIVEN }, haul: { iron_helmet: 0 },
    }
    gear.reconcile(ctx, bot)
    assert.equal(ctx.gearGiven.iron_helmet, 1, 'vanished spare counts handed')
    assert.equal(gear.handoverWaiting(bot, ctx), false)
    assert.equal(bot.lines.length, 0, 'silent: the channels speak for themselves')
  })
  it('a held owner spare reads as handover, never a mat want', () => {
    const bot = mockBot({ items: [...TOOLS, { name: 'iron_helmet', count: 1 }], slots: wornSet(IRON_WORN) })
    const ctx = {
      gear: { made: { iron_helmet: true } }, gearFinished: { iron_helmet: 1 },
      gearGiven: { ...TOOLS_GIVEN },
    }
    assert.equal(gear.handoverWaiting(bot, ctx), true)
    const p = gear.planFor(gear.liveCounts(bot, ctx), ctx, {})
    assert.deepEqual([p.state, p.key], ['hand', 'hand-iron_helmet'])
  })
})

describe('ipn.6 goal facts', () => {
  const goal = require('../src/goal')
  it('goalFacts splits pack and worn armour (core-1/body-1)', () => {
    const bot = mockBot({
      items: [...TOOLS, { name: 'iron_leggings', count: 1 }],
      slots: wornSet(['iron_helmet', 'iron_chestplate']),
    })
    const facts = goal.goalFacts(bot, { home: { built: true } })
    assert.equal(facts.ironHelmet, 0, 'pack only')
    assert.equal(facts.ironLeggings, 1)
    assert.equal(facts.wornIronHelmet, 1, 'worn beside the pack')
    assert.equal(facts.wornIronChestplate, 1)
    assert.equal(facts.wornIronLeggings, 0)
    assert.equal(facts.diamondHelmet, 0)
  })
  it('facts.gear reads done on the full worn set, ready without it', () => {
    const fullCtx = {
      home: { built: true },
      gearGiven: {
        ...TOOLS_GIVEN, ...IRON_ARMOR_GIVEN, diamond_sword: 1, diamond_pickaxe: 1,
        diamond_helmet: 1, diamond_chestplate: 1, diamond_leggings: 1, diamond_boots: 1,
      },
    }
    const bare = mockBot({ items: [...TOOLS, { name: 'diamond_pickaxe', count: 1 }] })
    assert.notEqual(goal.goalFacts(bare, fullCtx).gear, 'done')
    const geared = mockBot({
      items: [...TOOLS, { name: 'diamond_pickaxe', count: 1 }, ...IRON_SELF_PACK],
      slots: wornSet(DIAMOND_WORN),
    })
    assert.equal(goal.goalFacts(geared, fullCtx).gear, 'done')
  })
  it('MENU.gear.feasible refuses the complete ladder, offers the rest', () => {
    const F = goal.MENU.gear.feasible
    const fullCtx = {
      gearGiven: {
        ...TOOLS_GIVEN, ...IRON_ARMOR_GIVEN, diamond_sword: 1, diamond_pickaxe: 1,
        diamond_helmet: 1, diamond_chestplate: 1, diamond_leggings: 1, diamond_boots: 1,
      },
    }
    const fullFacts = {
      home: 'built', ironPick: 1, diamondPick: 1, waterBucket: 2,
      ironHelmet: 1, ironChestplate: 1, ironLeggings: 1, ironBoots: 1,
      diamondHelmet: 1, diamondChestplate: 1, diamondLeggings: 1, diamondBoots: 1,
    }
    assert.equal(F(fullFacts, mockBot(), fullCtx), false)
    // One boot short with stock: ready works now.
    const shortFacts = { ...fullFacts, diamondBoots: 0, diamonds: 4, tablePlaced: true }
    assert.equal(F(shortFacts, mockBot(), fullCtx), true)
  })
})
