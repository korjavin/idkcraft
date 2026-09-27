'use strict'

// Blacksmith step (idkcraft-ipn.3): ladder derivation, rung planning, the
// handover ledger, the tick, menu/goal glue, and the stockpile exception.

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const gear = require('../src/behaviours/gear')
const stockpile = require('../src/behaviours/stockpile')

const tick = (ms) => new Promise((resolve) => setTimeout(resolve, ms || 30))

function pos(x, y, z) {
  return {
    x, y, z,
    distanceTo: (q) => Math.hypot(x - q.x, y - q.y, z - q.z),
    clone() { return pos(x, y, z) },
    floored() { return { x: Math.floor(x), y: Math.floor(y), z: Math.floor(z) } },
  }
}

function mockBot({ items = [], ids = {}, recipes = {}, craftImpl = null, cells = {} } = {}) {
  const lines = []
  const calls = { craft: [], goals: [] }
  const itemsByName = {}
  for (const [name, id] of Object.entries(ids)) itemsByName[name] = { id }
  const bot = {
    lines, calls,
    _items: items,
    entity: { position: pos(0, 64, 0), onGround: true },
    registry: { itemsByName },
    inventory: { items: () => bot._items },
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
  return bot
}

const home = (over) => ({ site: { x: 0, y: 64, z: 0 }, built: true, table: { x: 0, y: 64, z: 0 }, ...(over || {}) })

describe('gear ladder derivation', () => {
  it('fresh pack wants the iron self pickaxe first', () => {
    const next = gear.deriveNext(mockBot(), {})
    assert.equal(next.name, 'iron_pickaxe')
    assert.equal(next.owner, false)
    assert.equal(next.needMat, 3)
    assert.equal(next.needSticks, 2)
  })
  it('carried self pick advances to the owner sword', () => {
    const bot = mockBot({ items: [{ name: 'iron_pickaxe', count: 1 }] })
    const next = gear.deriveNext(bot, {})
    assert.equal(next.name, 'iron_sword')
    assert.equal(next.owner, true)
    assert.equal(next.needMat, 2)
    assert.equal(next.needSticks, 1)
  })
  it('given sword advances to the owner pickaxe', () => {
    const bot = mockBot({ items: [{ name: 'iron_pickaxe', count: 1 }] })
    const next = gear.deriveNext(bot, { gearGiven: { iron_sword: 1 } })
    assert.equal(next.name, 'iron_pickaxe')
    assert.equal(next.owner, true)
  })
  it('complete iron rung advances to the diamond self pickaxe', () => {
    const bot = mockBot({ items: [{ name: 'iron_pickaxe', count: 1 }] })
    const next = gear.deriveNext(bot, { gearGiven: { iron_sword: 1, iron_pickaxe: 1 } })
    assert.equal(next.name, 'diamond_pickaxe')
    assert.equal(next.owner, false)
  })
  it('a lost self pick regresses the ladder to iron', () => {
    // Diamond rung "complete" on paper, but the iron hands are gone: the
    // scan hits the iron self pick first, so the need-iron-pick failure
    // the deep leg would raise cannot fire (ipn.2 structural gate).
    const next = gear.deriveNext(mockBot(), { gearGiven: { iron_sword: 1, iron_pickaxe: 1 } })
    assert.equal(next.name, 'iron_pickaxe')
    assert.equal(next.owner, false)
  })
  it('full ladder plus carried picks reads complete', () => {
    const bot = mockBot({ items: [{ name: 'iron_pickaxe', count: 1 }, { name: 'diamond_pickaxe', count: 1 }] })
    const ctx = { gearGiven: { iron_sword: 1, iron_pickaxe: 1, diamond_sword: 1, diamond_pickaxe: 1 } }
    assert.equal(gear.deriveNext(bot, ctx), null)
  })
})

describe('gear planFor', () => {
  const C = (over) => ({
    ironOre: 0, ingots: 0, diamonds: 0, sticks: 0, planks: 0, logs: 0,
    iron_pickaxe: 0, iron_sword: 0, diamond_pickaxe: 0, diamond_sword: 0,
    tablePlaced: false, furnaceClaim: false, furnaceItem: 0, cobble: 0, fuel: 0,
    ...(over || {}),
  })
  it('stick shortfall crafts sticks from planks, else planks from logs', () => {
    assert.equal(gear.planFor(C({ planks: 4 }), {}, {}).action, 'sticks')
    assert.equal(gear.planFor(C({ logs: 2 }), {}, {}).action, 'planks')
  })
  it('stick shortfall with no wood wants logs', () => {
    const p = gear.planFor(C({}), {}, {})
    assert.equal(p.state, 'want')
    assert.equal(p.key, 'want-logs')
  })
  it('mats on hand craft at the table, else wait on it', () => {
    assert.equal(gear.planFor(C({ sticks: 2, ingots: 3, tablePlaced: true }), {}, {}).action, 'craft')
    const p = gear.planFor(C({ sticks: 2, ingots: 3 }), {}, {})
    assert.equal(p.state, 'wait')
    assert.equal(p.key, 'wait-table')
  })
  it('ore plus fuel plus furnace smelts', () => {
    const p = gear.planFor(C({ sticks: 2, ironOre: 5, fuel: 8, furnaceClaim: true }), {}, { furnace: true })
    assert.deepEqual([p.state, p.action], ['ready', 'smelt'])
  })
  it('ore at/below the reserve wants coal', () => {
    const p = gear.planFor(C({ sticks: 2, ironOre: 5, fuel: 4 }), {}, { furnace: true })
    assert.equal(p.key, 'want-coal')
  })
  it('ore without the slice waits on the furnace', () => {
    const p = gear.planFor(C({ sticks: 2, ironOre: 5, fuel: 8 }), {}, {})
    assert.deepEqual([p.state, p.key], ['wait', 'wait-furnace'])
  })
  it('ore without station or cobble wants cobble', () => {
    const p = gear.planFor(C({ sticks: 2, ironOre: 5, fuel: 8, cobble: 3 }), {}, { furnace: true })
    assert.equal(p.key, 'want-cobble')
  })
  it('no ore and no ingots wants ore with the shortfall', () => {
    const p = gear.planFor(C({ sticks: 2, fuel: 8 }), {}, { furnace: true })
    assert.equal(p.key, 'want-ore')
    assert.ok(p.line.includes('3 more raw iron'))
  })
  it('diamonds short drive the deep leg, else wait on the slice', () => {
    const ctx = { gearGiven: { iron_sword: 1, iron_pickaxe: 1 } }
    const counts = C({ sticks: 2, diamonds: 1, iron_pickaxe: 1 })
    assert.equal(gear.planFor(counts, ctx, { deep: true }).action, 'deep')
    const p = gear.planFor(counts, ctx, {})
    assert.deepEqual([p.state, p.key], ['wait', 'wait-deep'])
  })
  it('a mid-flight furnace run owns the tick', () => {
    const p = gear.planFor(C({ sticks: 2 }), {}, {}, true)
    assert.deepEqual([p.state, p.action], ['ready', 'smelt'])
  })
  it('complete ledger reads done', () => {
    const ctx = { gearGiven: { iron_sword: 1, iron_pickaxe: 1, diamond_sword: 1, diamond_pickaxe: 1 } }
    const counts = C({ iron_pickaxe: 1, diamond_pickaxe: 1 })
    assert.equal(gear.planFor(counts, ctx, {}).state, 'done')
  })
})

describe('gear ledger', () => {
  it('reconcile clamps the finished record to the live pack', () => {
    const bot = mockBot({ items: [{ name: 'iron_sword', count: 1 }] })
    const ctx = { gearFinished: { iron_sword: 2 } }
    gear.reconcile(ctx, bot)
    assert.equal(ctx.gearFinished.iron_sword, 1)
    assert.deepEqual(ctx.gearGiven || {}, {})
  })
  it('forged-then-vanished reads as handed over, silently', () => {
    const bot = mockBot({ items: [] })
    const ctx = { gear: { made: { iron_sword: true } }, gearFinished: { iron_sword: 1 }, gearGiven: {} }
    gear.reconcile(ctx, bot)
    assert.equal(ctx.gearFinished.iron_sword, 0)
    assert.equal(ctx.gearGiven.iron_sword, 1)
    assert.deepEqual(bot.lines, [])
  })
  it('never-made and absent never marks given', () => {
    const bot = mockBot({ items: [] })
    const ctx = {}
    gear.reconcile(ctx, bot)
    assert.deepEqual(ctx.gearGiven || {}, {})
  })
  it('handoverWaiting needs the record and the live tool', () => {
    const ctx = { gearFinished: { iron_sword: 1 } }
    assert.equal(gear.handoverWaiting(mockBot({ items: [{ name: 'iron_sword', count: 1 }] }), ctx), true)
    assert.equal(gear.handoverWaiting(mockBot({ items: [] }), ctx), false)
    assert.equal(gear.handoverWaiting(mockBot({ items: [{ name: 'iron_sword', count: 1 }] }), {}), false)
  })
})

describe('gear tick', () => {
  it('want announces once through the latch, then yields silently', () => {
    const bot = mockBot()
    const ctx = { home: home(), stepStatus: 'running' }
    gear(bot, ctx)
    assert.equal(ctx.stepStatus, 'done')
    assert.equal(ctx.gear.saidNeed, 'want-logs')
    assert.deepEqual(bot.lines, ['next gear: iron_pickaxe for me', 'need logs for sticks, going to chop'])
    gear(bot, ctx) // same need, latched: no new lines
    assert.equal(ctx.stepStatus, 'done')
    assert.equal(bot.lines.length, 2)
  })
  it('rung transition chats and logs on piece change only', () => {
    const logs = []
    const orig = console.log
    console.log = (m) => { logs.push(String(m)) }
    try {
      const bot = mockBot({ items: [{ name: 'iron_pickaxe', count: 1 }] })
      const ctx = { home: home(), stepStatus: 'running' }
      gear(bot, ctx)
      assert.ok(bot.lines[0].includes('next gear: iron_sword for you'))
      assert.ok(logs.some((l) => l.includes('gear rung iron:sword:give')))
      const n = bot.lines.length
      gear(bot, ctx)
      assert.equal(bot.lines.length, n, 'no repeat transition line')
    } finally {
      console.log = orig
    }
  })
  it('in-flight window ops and unbuilt homes hold the tick', () => {
    const bot = mockBot()
    gear(bot, { home: home(), stepStatus: 'running', gearInFlight: true })
    gear(bot, { home: home(), stepStatus: 'running', furnaceInFlight: true })
    gear(bot, { home: { site: { x: 0, y: 64, z: 0 } }, stepStatus: 'running' })
    assert.deepEqual(bot.lines, [])
    assert.deepEqual(bot.calls.goals, [])
  })
  it('ladder complete reports done', () => {
    const bot = mockBot({ items: [{ name: 'iron_pickaxe', count: 1 }, { name: 'diamond_pickaxe', count: 1 }] })
    const ctx = { home: home(), stepStatus: 'running', gearGiven: { iron_sword: 1, iron_pickaxe: 1, diamond_sword: 1, diamond_pickaxe: 1 } }
    gear(bot, ctx)
    assert.equal(ctx.stepStatus, 'done')
  })
  it('sticks op crafts 2x2 without a table', async () => {
    const bot = mockBot({
      items: [{ name: 'oak_planks', count: 4 }],
      ids: { stick: 11 },
      recipes: { stick: { provides: 'stick', n: 4 } },
    })
    const ctx = { home: home(), stepStatus: 'running' }
    gear(bot, ctx)
    assert.equal(ctx.gearInFlight, true)
    await tick(700)
    assert.equal(ctx.gearInFlight, false)
    assert.equal(bot.calls.craft.length, 1)
    assert.equal(bot.calls.craft[0].table, false)
  })
  it('owner craft banks the haul and the finished record', async () => {
    const bot = mockBot({
      items: [{ name: 'iron_pickaxe', count: 1 }, { name: 'iron_ingot', count: 2 }, { name: 'stick', count: 1 }],
      ids: { iron_sword: 21 },
      recipes: { iron_sword: { provides: 'iron_sword' } },
      cells: { '0,64,0': 'crafting_table' },
    })
    const ctx = { home: home(), stepStatus: 'running' }
    gear(bot, ctx)
    assert.equal(ctx.gearInFlight, true)
    await tick(700)
    assert.equal(ctx.gearInFlight, false)
    assert.equal(bot.calls.craft.length, 1)
    assert.equal(bot.calls.craft[0].table, true)
    assert.deepEqual(ctx.haul, { iron_sword: 1 })
    assert.deepEqual(ctx.gearFinished, { iron_sword: 1 })
    assert.equal(ctx.gear.made.iron_sword, true)
    assert.ok(bot.lines.some((l) => l.includes('forged iron_sword for you')))
  })
  it('self craft banks nothing', async () => {
    const bot = mockBot({
      items: [{ name: 'iron_ingot', count: 3 }, { name: 'stick', count: 2 }],
      ids: { iron_pickaxe: 22 },
      recipes: { iron_pickaxe: { provides: 'iron_pickaxe' } },
      cells: { '0,64,0': 'crafting_table' },
    })
    const ctx = { home: home(), stepStatus: 'running' }
    gear(bot, ctx)
    await tick(700)
    assert.deepEqual(ctx.haul || {}, {})
    assert.deepEqual(ctx.gearFinished || {}, {})
    assert.ok(bot.lines.some((l) => l.includes('forged iron_pickaxe for me')))
  })
  it('ghost table fails loud, far table walks then fails', async () => {
    const ghost = mockBot({ items: [{ name: 'iron_ingot', count: 3 }, { name: 'stick', count: 2 }] })
    const gctx = { home: home(), stepStatus: 'running' }
    gear(ghost, gctx) // claim stands, blockAt null: mined table
    assert.equal(gctx.stepStatus, 'failed:gear-no-table')
    const far = mockBot({
      items: [{ name: 'iron_ingot', count: 3 }, { name: 'stick', count: 2 }],
      cells: { '100,64,0': 'crafting_table' },
    })
    const fctx = { home: home({ table: { x: 100, y: 64, z: 0 } }), stepStatus: 'running' }
    for (let i = 0; i < 21; i++) {
      fctx.stepStatus = 'running'
      gear(far, fctx)
    }
    assert.equal(fctx.stepStatus, 'failed:gear-table-far')
    assert.equal(far.calls.goals.length, 1, 'one goal issue, then patience')
  })
  it('furnace leg: in-progress drives on, done continues, status preserved', () => {
    const mk = (leg) => {
      const bot = mockBot({ items: [{ name: 'raw_iron', count: 3 }, { name: 'stick', count: 2 }, { name: 'coal', count: 8 }] })
      const ctx = { home: home({ furnace: { x: 1, y: 64, z: 0 } }), stepStatus: 'running', gearLegs: { furnace: leg } }
      return { bot, ctx }
    }
    let phase = 0
    const prog = mk(() => { phase++ }) // no result: leg in progress
    gear(prog.bot, prog.ctx)
    assert.equal(phase, 1)
    assert.equal(prog.ctx.stepStatus, 'running')
    const done = mk((b, c) => { c.furnace = { settled: true, result: 'done' } })
    gear(done.bot, done.ctx)
    assert.equal(done.ctx.stepStatus, 'running', 'sub-done never ends the gear step')
  })
  it('furnace failures translate fetchable wants, fail the rest', () => {
    const mk = (result) => {
      const bot = mockBot({ items: [{ name: 'raw_iron', count: 3 }, { name: 'stick', count: 2 }, { name: 'coal', count: 8 }] })
      const ctx = { home: home({ furnace: { x: 1, y: 64, z: 0 } }), stepStatus: 'running', gearLegs: { furnace: (b, c) => { c.furnace = { settled: true, result } } } }
      return { bot, ctx }
    }
    const cobble = mk('failed:no-cobble')
    gear(cobble.bot, cobble.ctx)
    assert.equal(cobble.ctx.stepStatus, 'done', 'fetchable: yield, never hold')
    assert.ok(cobble.bot.lines.some((l) => l.includes('cobble')))
    const fuel = mk('failed:no-fuel')
    gear(fuel.bot, fuel.ctx)
    assert.equal(fuel.ctx.stepStatus, 'done')
    assert.ok(fuel.bot.lines.some((l) => l.includes('coal')))
    const stuck = mk('failed:smelt-stalled')
    gear(stuck.bot, stuck.ctx)
    assert.equal(stuck.ctx.stepStatus, 'failed:gear-furnace-smelt-stalled')
  })
  it('deep leg relays done and failures', () => {
    const mk = (status) => {
      const bot = mockBot({ items: [{ name: 'iron_pickaxe', count: 1 }, { name: 'stick', count: 2 }, { name: 'diamond', count: 1 }] })
      const ctx = {
        home: home(), stepStatus: 'running',
        gearGiven: { iron_sword: 1, iron_pickaxe: 1 },
        gearLegs: { deep: (b, c) => { c.stepStatus = status } },
      }
      return { bot, ctx }
    }
    const done = mk('done')
    gear(done.bot, done.ctx)
    assert.equal(done.ctx.stepStatus, 'running', 'sub-done never ends the gear step')
    const lava = mk('failed:lava')
    gear(lava.bot, lava.ctx)
    assert.equal(lava.ctx.stepStatus, 'failed:gear-deep-lava')
  })
})

describe('gear menu and goal glue', () => {
  const goal = require('../src/goal')
  it('gear slots after stockpile, before forage', () => {
    const o = goal.STEP_ORDER
    assert.ok(o.indexOf('gear') > o.indexOf('stockpile'))
    assert.ok(o.indexOf('gear') < o.indexOf('forage'))
    assert.equal(o.indexOf('gear'), o.indexOf('forage') - 1)
  })
  it('MENU.gear.feasible gates built/done/latch', () => {
    const F = goal.MENU.gear.feasible
    assert.equal(F({ home: 'site' }, mockBot(), {}), false)
    const doneCtx = { gearGiven: { iron_sword: 1, iron_pickaxe: 1, diamond_sword: 1, diamond_pickaxe: 1 } }
    assert.equal(F({ home: 'built', ironPick: 1, diamondPick: 1 }, mockBot(), doneCtx), false)
    assert.equal(F({ home: 'built', ingots: 3, sticks: 2, tablePlaced: true }, mockBot(), {}), true)
    assert.equal(F({ home: 'built' }, mockBot(), {}), true, 'unlatched want announces')
    assert.equal(F({ home: 'built' }, mockBot(), { gear: { saidNeed: 'want-logs' } }), false, 'latched want yields')
  })
  it('criteria and stepWhy mirror the plan', () => {
    assert.ok(goal.STEP_CRITERIA.gear.includes('forge'))
    assert.equal(goal.stepWhy('gear', { home: 'site' }, mockBot(), {}, ''), 'gear: house not built yet')
    const doneCtx = { gearGiven: { iron_sword: 1, iron_pickaxe: 1, diamond_sword: 1, diamond_pickaxe: 1 } }
    assert.equal(goal.stepWhy('gear', { home: 'built', ironPick: 1, diamondPick: 1 }, mockBot(), doneCtx, ''), 'gear: ladder complete')
    assert.equal(goal.stepWhy('gear', { home: 'built' }, mockBot(), { gear: { saidNeed: 'want-logs' } }, ''), 'gear: need logs for sticks, going to chop')
  })
  it('decide holds the step behind gear and furnace window ops', async () => {
    const bot = mockBot({ items: [{ name: 'iron_ingot', count: 3 }, { name: 'stick', count: 2 }] })
    for (const flag of ['gearInFlight', 'furnaceInFlight']) {
      const ctx = { home: home(), step: 'gear', stepStatus: 'running', brain: {}, [flag]: true }
      const r = await goal.decide(bot, ctx)
      assert.equal(r.action, 'gear', flag)
    }
  })
  it('fresh gear pick resets run counters, keeps the ledger', async () => {
    const bot = mockBot({ items: [{ name: 'iron_ingot', count: 3 }, { name: 'stick', count: 2 }] })
    const ctx = {
      home: { built: true, chest: { x: 5, y: 64, z: 1 }, table: { x: 0, y: 64, z: 0 } },
      step: 'explore', stepStatus: 'done', brain: {},
      gearRun: { walkTicks: 19 }, gearGiven: { iron_sword: 1 },
    }
    const r = await goal.decide(bot, ctx)
    assert.equal(r.action, 'gear')
    assert.deepEqual(ctx.gearRun, {})
    assert.deepEqual(ctx.gearGiven, { iron_sword: 1 })
  })
  it('goalFacts carries ladder counts, furnace, handover, and bucket', () => {
    const bot = mockBot({ items: [
      { name: 'raw_iron', count: 3 }, { name: 'iron_ingot', count: 2 }, { name: 'diamond', count: 1 },
      { name: 'iron_pickaxe', count: 1 }, { name: 'iron_sword', count: 1 }, { name: 'furnace', count: 1 },
    ] })
    const ctx = { home: { built: true, furnace: { x: 1, y: 64, z: 0 } }, gearFinished: { iron_sword: 1 } }
    const facts = goal.goalFacts(bot, ctx)
    assert.equal(facts.ironOre, 3)
    assert.equal(facts.ingots, 2)
    assert.equal(facts.diamonds, 1)
    assert.equal(facts.ironPick, 1)
    assert.equal(facts.furnaceItem, 1)
    assert.equal(facts.furnace, 'yes')
    assert.equal(facts.gearHandover, 'waiting')
    assert.equal(facts.gear, 'want')
  })
})

describe('gear finished-goods handover', () => {
  const chestBot = (items, finished) => {
    const ids = {}
    let next = 1
    const idOf = (name) => (ids[name] = ids[name] || next++)
    for (const i of items) idOf(i.name)
    const lines = []
    const bot = {
      lines,
      _items: items,
      entity: { position: pos(5.5, 64.5, 1.5), onGround: true },
      registry: { itemsByName: new Proxy({}, { get: (_, n) => ({ id: idOf(n) }) }) },
      inventory: { items: () => bot._items },
      blockAt: (p) => ({ name: 'chest', position: pos(p.x, p.y, p.z) }),
      pathfinder: { setGoal: () => {}, isMoving: () => false },
      openChest: async () => ({
        containerItems: () => [],
        deposit: async (type, _meta, count) => {
          const name = Object.keys(ids).find((k) => ids[k] === type)
          let n = count
          for (let k = bot._items.length - 1; k >= 0 && n > 0; k--) {
            if (bot._items[k].name !== name) continue
            const take = Math.min(bot._items[k].count, n)
            bot._items[k].count -= take
            n -= take
            if (bot._items[k].count <= 0) bot._items.splice(k, 1)
          }
        },
        close: async () => {},
      }),
      chat: (line) => { lines.push(String(line)) },
    }
    return bot
  }
  it('depositPlan banks finished tools only with ctx (mutant pair)', () => {
    // Mutant: deleting the finished-goods allowance fails the WITH case
    // while the WITHOUT case still passes — the pair pins the exception.
    const inv = () => [{ name: 'iron_sword', count: 1 }, { name: 'stone_pickaxe', count: 1 }, { name: 'cobblestone', count: 40 }]
    const withPlan = stockpile.depositPlan(mockBot({ items: inv() }), { gearFinished: { iron_sword: 1 } })
    assert.deepEqual(withPlan, [{ name: 'iron_sword', count: 1 }, { name: 'cobblestone', count: 8 }])
    const withoutPlan = stockpile.depositPlan(mockBot({ items: inv() }))
    assert.deepEqual(withoutPlan, [{ name: 'cobblestone', count: 8 }])
  })
  it('allowance clamps to the live pack and spans stacks', () => {
    const bot = mockBot({ items: [{ name: 'iron_sword', count: 1 }] })
    assert.deepEqual(stockpile.depositPlan(bot, { gearFinished: { iron_sword: 2 } }), [{ name: 'iron_sword', count: 1 }])
    const two = mockBot({ items: [{ name: 'iron_sword', count: 1 }, { name: 'iron_sword', count: 1 }] })
    const plan = stockpile.depositPlan(two, { gearFinished: { iron_sword: 1 } })
    assert.equal(plan.reduce((n, p) => n + p.count, 0), 1, 'exactly one banks across stacks')
  })
  it('surplus batch never fires on finished tools alone', () => {
    const bot = mockBot({ items: [{ name: 'iron_sword', count: 1 }] })
    assert.equal(stockpile.surplusCount(bot), 0)
  })
  it('stockpile banks the sword: given++, finished--, handover line', async () => {
    const logs = []
    const orig = console.log
    console.log = (m) => { logs.push(String(m)) }
    try {
      const bot = chestBot([{ name: 'iron_sword', count: 1 }])
      const ctx = {
        home: { site: { x: 0, y: 64, z: 0 }, built: true, chest: { x: 5, y: 64, z: 1 } },
        lastGoalKey: '', stepStatus: 'running',
        gear: { made: { iron_sword: true } }, gearFinished: { iron_sword: 1 }, gearGiven: {},
      }
      stockpile(bot, ctx) // issues the walk goal
      stockpile(bot, ctx) // arrived: banks behind the window op
      await tick(80)
      assert.deepEqual(bot._items, [], 'sword left the pack')
      assert.equal(ctx.gearFinished.iron_sword, 0)
      assert.equal(ctx.gearGiven.iron_sword, 1)
      assert.ok(bot.lines.some((l) => l.includes('stockpiled 1 iron_sword')))
      assert.ok(bot.lines.some((l) => l.includes('handed 1 iron_sword to the home chest')))
      assert.ok(logs.some((l) => l.includes('gear handed 1 iron_sword to chest')))
      assert.equal(ctx.stepStatus, 'done')
    } finally {
      console.log = orig
    }
  })
})

describe('gear round-2: collision, async legs, latch', () => {
  it('losing the self pick never completes the owner pick rung', async () => {
    const bot = mockBot({
      items: [{ name: 'iron_ingot', count: 3 }, { name: 'stick', count: 2 }],
      ids: { iron_pickaxe: 22 },
      recipes: { iron_pickaxe: { provides: 'iron_pickaxe' } },
      cells: { '0,64,0': 'crafting_table' },
    })
    const ctx = { home: home(), stepStatus: 'running' }
    gear(bot, ctx)
    await tick(700)
    assert.ok(!((ctx.gear.made || {}).iron_pickaxe), 'self forge leaves made empty')
    bot._items = bot._items.filter((i) => i.name !== 'iron_pickaxe') // worn out digging
    gear.reconcile(ctx, bot)
    assert.deepEqual(ctx.gearGiven || {}, {})
    const next = gear.deriveNext(bot, ctx)
    assert.equal(next.name, 'iron_pickaxe')
    assert.equal(next.owner, false)
  })
  it('toss then bank keeps the self pick and completes the rung', () => {
    // Review case 1: owner pick forged (pack 2, haul 1, finished 1), tossed
    // (pack 1, haul 0). The reserve must hold the bank and the empty haul
    // must read as handed — no reforge, ladder advances.
    const bot = mockBot({ items: [{ name: 'iron_pickaxe', count: 1 }] })
    const ctx = {
      gear: { made: { iron_pickaxe: true } }, gearFinished: { iron_pickaxe: 1 },
      gearGiven: { iron_sword: 1 }, haul: { iron_pickaxe: 0 },
    }
    gear.reconcile(ctx, bot)
    assert.equal(ctx.gearFinished.iron_pickaxe, 0, 'reserve clamps the stale claim')
    assert.equal(ctx.gearGiven.iron_pickaxe, 1, 'toss detected via the empty haul')
    assert.equal(gear.handoverWaiting(bot, ctx), false)
    assert.deepEqual(stockpile.depositPlan(bot, ctx), [], 'reserve holds the self pick')
    assert.equal(gear.deriveNext(bot, ctx).name, 'diamond_pickaxe', 'ladder advances, no reforge')
  })
  it('death with a stale haul reforges instead of forgiving', () => {
    const bot = mockBot({ items: [{ name: 'iron_pickaxe', count: 1 }] }) // self hands kept
    const ctx = { gear: { made: { iron_sword: true } }, gearFinished: { iron_sword: 1 }, gearGiven: {}, haul: { iron_sword: 1 } }
    gear.reconcile(ctx, bot)
    assert.equal(ctx.gearFinished.iron_sword, 0, 'clamped to the empty pack')
    assert.deepEqual(ctx.gearGiven, {}, 'stale haul: died, not handed')
    assert.equal(gear.deriveNext(bot, ctx).name, 'iron_sword', 'reforge the lost sword')
  })
  it('rung transition clears the latch: repeats announce again', () => {
    const bot = mockBot({ items: [{ name: 'stick', count: 2 }] })
    const ctx = { home: home(), stepStatus: 'running' }
    gear(bot, ctx) // rung 1: want-ore, announced
    assert.equal(ctx.gear.saidNeed, 'want-ore')
    bot._items.push({ name: 'iron_pickaxe', count: 1 }) // self pick forged
    ctx.stepStatus = 'running'
    gear(bot, ctx) // rung 2: same want-ore key, announced again
    assert.equal(bot.lines.filter((l) => l.includes('more raw iron')).length, 2)
  })
  it('a synchronously read furnace stamp is consumed once', () => {
    const bot = mockBot({ items: [{ name: 'raw_iron', count: 3 }, { name: 'stick', count: 2 }, { name: 'coal', count: 8 }] })
    const ctx = { home: home({ furnace: { x: 1, y: 64, z: 0 } }), stepStatus: 'running', gearLegs: { furnace: (b, c) => { c.furnace = { settled: true, result: 'done' } } } }
    gear(bot, ctx)
    assert.equal(ctx.furnace.result, null)
    assert.equal(ctx.stepStatus, 'running')
  })
  it('async furnace done continues the gear step silently', async () => {
    const goal = require('../src/goal')
    const bot = mockBot({ items: [{ name: 'iron_ingot', count: 3 }, { name: 'stick', count: 2 }] })
    const ctx = { home: home(), step: 'gear', stepStatus: 'done', brain: {}, furnace: { settled: true, result: 'done' }, stepFail: { gear: { status: 'failed:smelt-stalled' } } }
    const r = await goal.decide(bot, ctx)
    assert.equal(r.action, 'gear')
    assert.equal(ctx.stepStatus, 'running')
    assert.equal(ctx.furnace.result, null)
    assert.ok(!(ctx.stepFail && ctx.stepFail.gear), 'stale hold retired, not lingered')
  })
  it('async furnace no-fuel yields with an announce', async () => {
    const goal = require('../src/goal')
    const bot = mockBot({ items: [{ name: 'stick', count: 2 }, { name: 'raw_iron', count: 3 }] })
    const ctx = { home: { built: true, chest: { x: 5, y: 64, z: 1 } }, step: 'gear', stepStatus: 'failed:no-fuel', brain: {}, furnace: { settled: true, result: 'failed:no-fuel' } }
    const r = await goal.decide(bot, ctx)
    assert.equal(ctx.gear.saidNeed, 'want-coal')
    assert.ok(bot.lines.some((l) => l.includes('coal above the reserve')))
    assert.ok(!(ctx.stepFail && ctx.stepFail.gear), 'yield records no hold')
    assert.equal(r.action, 'explore', 'gear latched out, fetchers run')
  })
  it('async furnace stall fails under a gear name and holds', async () => {
    const goal = require('../src/goal')
    const bot = mockBot()
    const ctx = { home: { built: true, chest: { x: 5, y: 64, z: 1 } }, step: 'gear', stepStatus: 'failed:smelt-stalled', brain: {}, furnace: { settled: true, result: 'failed:smelt-stalled' } }
    const r = await goal.decide(bot, ctx)
    assert.equal(r.action, 'explore')
    assert.ok(ctx.stepFail && ctx.stepFail.gear, 'hold recorded')
    assert.equal(ctx.stepFail.gear.status, 'failed:gear-furnace-smelt-stalled')
  })
  it('async-settling leg fake: clobber between ticks is consumed', async () => {
    const goal = require('../src/goal')
    const bot = mockBot({ items: [{ name: 'raw_iron', count: 3 }, { name: 'stick', count: 2 }, { name: 'coal', count: 8 }] })
    const ctx = {
      home: home({ furnace: { x: 1, y: 64, z: 0 } }), step: 'gear', stepStatus: 'running', brain: {},
      gearLegs: {
        furnace: (b, c) => {
          if (c.furnace) return
          c.furnaceInFlight = true
          setTimeout(() => {
            c.furnace = { settled: true, result: 'done' }
            c.furnaceInFlight = false
            c.stepStatus = 'done' // the async clobber the review found
          }, 20)
        },
      },
    }
    gear(bot, ctx) // drives; the sync read sees nothing
    assert.equal(ctx.stepStatus, 'running')
    await tick(700) // async lands between ticks
    assert.equal(ctx.stepStatus, 'done', 'clobbered as the real leg does')
    const r = await goal.decide(bot, ctx)
    assert.equal(r.action, 'gear', 'consumed, step continues')
    assert.equal(ctx.stepStatus, 'running')
    assert.equal(ctx.furnace.result, null)
  })
  it('banking the owner pick clears its haul claim (no later toss)', async () => {
    // Review case 2 shape at the bank: the haul must settle with the bank.
    const ids = {}
    let next = 1
    const idOf = (name) => (ids[name] = ids[name] || next++)
    idOf('iron_pickaxe')
    const items = [{ name: 'iron_pickaxe', count: 2 }]
    const lines = []
    const bot = {
      lines,
      _items: items,
      entity: { position: pos(5.5, 64.5, 1.5), onGround: true },
      registry: { itemsByName: new Proxy({}, { get: (_, n) => ({ id: idOf(n) }) }) },
      inventory: { items: () => bot._items },
      blockAt: (p) => ({ name: 'chest', position: pos(p.x, p.y, p.z) }),
      pathfinder: { setGoal: () => {}, isMoving: () => false },
      openChest: async () => ({
        containerItems: () => [],
        deposit: async (type, _meta, count) => {
          const name = Object.keys(ids).find((k) => ids[k] === type)
          let n = count
          for (let k = bot._items.length - 1; k >= 0 && n > 0; k--) {
            if (bot._items[k].name !== name) continue
            const take = Math.min(bot._items[k].count, n)
            bot._items[k].count -= take
            n -= take
            if (bot._items[k].count <= 0) bot._items.splice(k, 1)
          }
        },
        close: async () => {},
      }),
      chat: (line) => { lines.push(String(line)) },
    }
    const ctx = {
      home: { site: { x: 0, y: 64, z: 0 }, built: true, chest: { x: 5, y: 64, z: 1 } },
      lastGoalKey: '', stepStatus: 'running',
      gear: { made: { iron_pickaxe: true } }, gearFinished: { iron_pickaxe: 1 }, gearGiven: {},
      haul: { iron_pickaxe: 1 },
    }
    stockpile(bot, ctx)
    stockpile(bot, ctx)
    await tick(80)
    assert.equal(bot._items.length, 1, 'one pick stays: the self twin')
    assert.equal(ctx.gearGiven.iron_pickaxe, 1)
    assert.equal(ctx.gearFinished.iron_pickaxe, 0)
    assert.equal(ctx.haul.iron_pickaxe, 0, 'haul settled with the bank')
  })
})

describe('gear round-2: phantom crafts', () => {
  it('death reforge keeps exactly one unhanded unit (idempotent forge)', async () => {
    // Forge, lose the sword with a stale haul (death), reforge: the second
    // landing must not stack haul+finished (with += the haul would read 2).
    const bot = mockBot({
      items: [{ name: 'iron_pickaxe', count: 1 }, { name: 'iron_ingot', count: 4 }, { name: 'stick', count: 2 }],
      ids: { iron_sword: 21 },
      recipes: { iron_sword: { provides: 'iron_sword' } },
      cells: { '0,64,0': 'crafting_table' },
    })
    const ctx = { home: home(), stepStatus: 'running' }
    gear(bot, ctx)
    await tick(700)
    assert.deepEqual(ctx.haul, { iron_sword: 1 })
    bot._items = bot._items.filter((i) => i.name !== 'iron_sword') // died; haul stays stale
    ctx.stepStatus = 'running'
    gear(bot, ctx)
    await tick(700)
    assert.equal(bot.calls.craft.length, 2)
    assert.deepEqual(ctx.haul, { iron_sword: 1 })
    assert.deepEqual(ctx.gearFinished, { iron_sword: 1 })
    assert.equal(ctx.gearRun.phantomTicks || 0, 0)
  })
  it('phantom crafts retry silently, then fail loud', async () => {
    // craftImpl resolves without adding anything (the live phantom): three
    // silent retries, the fourth fails so the hold can park a persistent
    // failure instead of looping forever.
    const bot = mockBot({
      items: [{ name: 'iron_ingot', count: 3 }, { name: 'stick', count: 2 }],
      ids: { iron_pickaxe: 22 },
      recipes: { iron_pickaxe: { ignored: true } },
      cells: { '0,64,0': 'crafting_table' },
    })
    bot.craft = async (...a) => { bot.calls.craft.push(a) } // resolves, lands nothing
    const ctx = { home: home(), stepStatus: 'running' }
    for (let i = 0; i < 3; i++) {
      ctx.stepStatus = 'running'
      gear(bot, ctx)
      await tick(700)
      assert.equal(ctx.stepStatus, 'running', `retry ${i + 1} stays silent`)
    }
    ctx.stepStatus = 'running'
    gear(bot, ctx)
    await tick(700)
    assert.equal(ctx.stepStatus, 'failed:gear-iron_pickaxe')
    assert.equal(bot.calls.craft.length, 4, 'three silent retries plus the loud one')
  })
})

describe('gear round-2: handover state and op span', () => {
  it('inFlight stays up through the settle window', async () => {
    const bot = mockBot({
      items: [{ name: 'iron_ingot', count: 3 }, { name: 'stick', count: 2 }],
      ids: { iron_pickaxe: 22 },
      recipes: { iron_pickaxe: { provides: 'iron_pickaxe' } },
      cells: { '0,64,0': 'crafting_table' },
    })
    const ctx = { home: home(), stepStatus: 'running' }
    gear(bot, ctx)
    await tick(100)
    assert.equal(ctx.gearInFlight, true, 'op still verifying')
    await tick(700)
    assert.equal(ctx.gearInFlight, false)
    assert.ok(bot.lines.some((l) => l.includes('forged iron_pickaxe for me')))
  })
  it('forged-and-held reads as handover, never a mat want', () => {
    const goal = require('../src/goal')
    const counts = {
      ironOre: 0, ingots: 0, diamonds: 0, sticks: 0, planks: 0, logs: 0,
      iron_pickaxe: 1, iron_sword: 1, diamond_pickaxe: 0, diamond_sword: 0,
      tablePlaced: true, furnaceClaim: false, furnaceItem: 0, cobble: 0, fuel: 0,
    }
    const ctx = { gear: { made: { iron_sword: true } }, gearGiven: {}, gearFinished: { iron_sword: 1 } }
    const plan = gear.planFor(counts, ctx, {})
    assert.equal(plan.state, 'hand')
    assert.equal(plan.key, 'hand-iron_sword')
    const facts = { home: 'built', ironPick: 1, ironSword: 1, tablePlaced: true }
    assert.equal(goal.MENU.gear.feasible(facts, mockBot(), ctx), false, 'handover steps own it')
    assert.equal(goal.stepWhy('gear', facts, mockBot(), ctx, ''), 'gear: handing over iron_sword')
  })
  it('hand tick yields silently', () => {
    const bot = mockBot({ items: [{ name: 'iron_pickaxe', count: 1 }, { name: 'iron_sword', count: 1 }] })
    const ctx = { home: home(), stepStatus: 'running', gear: { made: { iron_sword: true }, lastKey: 'iron:sword:give' }, gearFinished: { iron_sword: 1 }, gearGiven: {} }
    gear(bot, ctx)
    assert.equal(ctx.stepStatus, 'done')
    assert.deepEqual(bot.lines, [])
  })
})

describe('gear round-3: the unhanded claim survives a rejoin', () => {
  const memory = require('../src/memory')
  const fs = require('node:fs')
  const os = require('node:os')
  const path = require('node:path')
  // Save-then-restore across a fresh ctx, same world, same pack (the pack
  // lives server-side, so it survives the rejoin; the haul claim must too).
  function roundTrip(ctx, items) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gear-haul-'))
    const file = path.join(dir, 'mem.json')
    const spawn = { x: 100, y: 64, z: -200 }
    const bot = mockBot({ items })
    bot.spawnPoint = { ...spawn }
    assert.equal(memory.save(bot, ctx, file), true)
    const bot2 = mockBot({ items: items.map((i) => ({ ...i })) })
    bot2.spawnPoint = { ...spawn }
    const ctx2 = {}
    assert.ok(memory.restore(bot2, ctx2, file))
    return { bot2, ctx2 }
  }
  it('rejoin after a death reforges: the stale haul claim survives on disk', () => {
    const { bot2, ctx2 } = roundTrip(
      { home: home(), gear: { made: { iron_sword: true } }, gearFinished: {}, gearGiven: {}, haul: { iron_sword: 1 } },
      [{ name: 'iron_pickaxe', count: 1 }]
    )
    assert.equal(ctx2.haul && ctx2.haul.iron_sword, 1, 'stale haul restored')
    const next = gear.deriveNext(bot2, ctx2)
    assert.ok(next && next.name === 'iron_sword', 'death-loss reforges, not forgiven')
  })
  it('rejoin after a toss keeps the handover: the ladder stays advanced', () => {
    const { bot2, ctx2 } = roundTrip(
      { home: home(), gear: { made: { iron_sword: true } }, gearFinished: {}, gearGiven: {}, haul: { iron_sword: 0 } },
      [{ name: 'iron_pickaxe', count: 1 }]
    )
    assert.ok(!(ctx2.haul && ctx2.haul.iron_sword), 'zero haul not persisted')
    const next = gear.deriveNext(bot2, ctx2)
    assert.ok(next && next.name === 'iron_pickaxe', 'tossed sword stays handed, ladder advanced')
  })
  it('rejoin mid-handover keeps the finished claim: bank, not reforge', () => {
    const { bot2, ctx2 } = roundTrip(
      { home: home(), gear: { made: { iron_sword: true } }, gearFinished: { iron_sword: 1 }, gearGiven: {}, haul: { iron_sword: 1 } },
      [{ name: 'iron_pickaxe', count: 1 }, { name: 'iron_sword', count: 1 }]
    )
    assert.equal(gear.handoverWaiting(bot2, ctx2), true, 'finished claim rides the disk')
    gear.reconcile(ctx2, bot2)
    assert.deepEqual(ctx2.gearGiven || {}, {}, 'in-flight, not handed')
    const next = gear.deriveNext(bot2, ctx2)
    assert.ok(next && next.name === 'iron_sword', 'still the open want')
  })
  it('restore drops haul names outside the ledger (hand-written doc)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gear-haul-'))
    const file = path.join(dir, 'mem.json')
    const spawn = { x: 100, y: 64, z: -200 }
    const bot = mockBot({ items: [] })
    bot.spawnPoint = { ...spawn }
    fs.writeFileSync(file, JSON.stringify({
      v: 1, world: memory.worldKey(bot), savedAt: Date.now(),
      homes: [], resources: [], visited: [], danger: [], follow: null,
      gear: { given: {}, finished: {}, made: { iron_sword: true }, haul: { iron_sword: 1, raw_iron: 9 } },
    }))
    const ctx = {}
    assert.ok(memory.restore(bot, ctx, file))
    assert.equal(ctx.haul && ctx.haul.iron_sword, 1)
    assert.ok(!(ctx.haul && ctx.haul.raw_iron), 'foreign haul name dropped')
  })
  it('forage loot haul stays session-scoped: only ledger names persist', () => {
    const { ctx2 } = roundTrip(
      { home: home(), gear: { made: { iron_sword: true } }, gearFinished: {}, gearGiven: {}, haul: { iron_sword: 1, raw_iron: 9 } },
      [{ name: 'iron_pickaxe', count: 1 }]
    )
    assert.equal(ctx2.haul && ctx2.haul.iron_sword, 1)
    assert.ok(!(ctx2.haul && ctx2.haul.raw_iron), 'deliver-owned haul untouched')
  })
})
