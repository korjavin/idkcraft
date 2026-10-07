'use strict'

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const body = require('../src/body')
const { createTicker } = require('../src/index')

function pos(x, y, z) {
  const p = {
    x, y, z,
    distanceTo: (q) => Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z),
    clone() { return pos(p.x, p.y, p.z) },
    floored() { return pos(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)) }
  }
  return p
}

function mockBot() {
  const calls = { setGoal: 0, stop: 0, jump: 0, goals: [], clears: 0 }
  const controls = {}
  const bot = {
    calls,
    controls,
    username: 'IdkBot',
    players: {},
    entities: {},
    health: 20,
    food: 20,
    entity: { position: pos(0, 64, 0) },
    pathfinder: {
      goal: null,
      setGoal: (g) => {
        calls.setGoal++
        calls.goals.push(g)
        bot.pathfinder.goal = g
        // NOTE: deliberately does not clear controls (unlike tick.test.js):
        // the switch tests below pin claimBody's explicit clear.
      },
      stop: () => { calls.stop++ },
      isMoving: () => false,
      setMovements: (m) => { calls.movements = m }
    },
    setControlState: (control, val) => {
      controls[control] = !!val
      if (control === 'jump') calls.jump = val ? 1 : 0
    },
    clearControlStates: () => {
      calls.clears++
      for (const k in controls) controls[k] = false
      calls.jump = 0
    },
    getControlState: (control) => !!controls[control],
    chat: () => {}
  }
  return bot
}

function mockBrain(decision) {
  return {
    calls: 0,
    async decide() {
      this.calls++
      return decision || { action: 'follow', sprint: false, source: 'jev' }
    }
  }
}

describe('pickOwner', () => {
  const cases = [
    [{ paused: true, work: true }, 'stop'],
    [{ breath: true, bring: {} }, 'breath'],
    [{ stuck: { by: 'follow' }, lead: {} }, 'recover'],
    [{ comehome: { phase: 'walk' }, lead: {} }, 'comehome'],
    [{ lead: {}, bring: {} }, 'lead'],
    [{ bring: {}, work: true }, 'bring'],
    [{ flat: {}, work: true }, 'flat'],
    [{ flat: { parked: true }, work: true }, 'work'], // parked flat never dispatches
    [{ inShelter: true, work: true }, 'shelter'],
    [{ work: true }, 'work'],
    [{}, 'idle'],
    [null, 'idle'],
  ]
  for (const [ctx, want] of cases) {
    it(`picks ${want} for ${JSON.stringify(ctx)}`, () => {
      assert.equal(body.pickOwner(ctx), want)
    })
  }
})

describe('movementsFor', () => {
  function ctxWithMov(over = {}) {
    return {
      movements: { canDig: true, allowSprinting: false, allowParkour: true },
      lastGoalKey: '',
      lastPathNodes: null,
      ...over,
    }
  }
  const bot = { entity: { position: pos(0, 64, 0) } }

  it('applies defaults on a plain ctx', () => {
    const ctx = ctxWithMov()
    ctx.movements.allowSprinting = true
    ctx.movements.allowParkour = false
    ctx.movements.canDig = false
    body.movementsFor('idle', bot, ctx)
    assert.equal(ctx.movements.canDig, true)
    assert.equal(ctx.movements.allowSprinting, false)
    assert.equal(ctx.movements.allowParkour, true)
  })

  it('g0z.18: castle step above the reserve scaffolds with dirt only; cobble returns at the reserve or off the step', () => {
    const DIRT = 9
    const COBBLE = 14
    let cobble = 48
    const b = {
      entity: { position: pos(0, 64, 0) },
      registry: { itemsByName: { dirt: { id: DIRT }, cobblestone: { id: COBBLE } } },
      inventory: { items: () => [{ name: 'cobblestone', count: cobble }, { name: 'dirt', count: 3 }] },
    }
    const ctx = ctxWithMov({ work: true, step: 'castle', castle: { site: { x: 0, y: 64, z: 0 } } })
    ctx.movements.scafoldingBlocks = [DIRT, COBBLE]
    body.movementsFor('work', b, ctx)
    assert.deepEqual(ctx.movements.scafoldingBlocks, [DIRT], '48 cobble on the castle step: no cobble scaffold')
    cobble = 16 // at the SCAFFOLD_LOW reserve: the reserve is scaffold again
    body.movementsFor('work', b, ctx)
    assert.deepEqual(ctx.movements.scafoldingBlocks, [DIRT, COBBLE])
    cobble = 48
    body.movementsFor('work', b, ctx)
    ctx.step = 'forage'
    body.movementsFor('work', b, ctx)
    assert.deepEqual(ctx.movements.scafoldingBlocks, [DIRT, COBBLE], 'other steps keep the default')
  })

  it('vmzq.29: castle step with cobble above the reserve but no dirt keeps cobble as scaffold', () => {
    const DIRT = 9
    const COBBLE = 14
    let items = [{ name: 'cobblestone', count: 40 }]
    const b = {
      entity: { position: pos(0, 64, 0) },
      registry: { itemsByName: { dirt: { id: DIRT }, cobblestone: { id: COBBLE } } },
      inventory: { items: () => items },
    }
    const ctx = ctxWithMov({ work: true, step: 'castle', castle: { site: { x: 0, y: 64, z: 0 } } })
    ctx.movements.scafoldingBlocks = [DIRT, COBBLE]
    body.movementsFor('work', b, ctx)
    assert.deepEqual(ctx.movements.scafoldingBlocks, [DIRT, COBBLE], 'no dirt: cobble stays scaffold (never an empty set)')
    items = [{ name: 'cobblestone', count: 40 }, { name: 'dirt', count: 2 }]
    body.movementsFor('work', b, ctx)
    assert.deepEqual(ctx.movements.scafoldingBlocks, [DIRT], 'dirt on hand: g0z.18 rule holds')
    items = [{ name: 'cobblestone', count: 40 }]
    body.movementsFor('work', b, ctx)
    assert.deepEqual(ctx.movements.scafoldingBlocks, [DIRT, COBBLE], 'dirt spent: cobble returns')
  })

  it('no-ops without movements', () => {
    assert.doesNotThrow(() => body.movementsFor('work', bot, {}))
  })

  it('borrows no-dig on the gohome walk', () => {
    const ctx = ctxWithMov({ work: true, step: 'gohome', gohome: { phase: 'walk' }, home: { site: { x: 0, y: 64, z: 0 } } })
    body.movementsFor('work', bot, ctx)
    assert.equal(ctx.movements.canDig, false)
  })

  it('re-opens the drill when the walk phase moves or the home is gone', () => {
    const walk = { work: true, step: 'gohome', gohome: { phase: 'open' }, home: { site: { x: 0, y: 64, z: 0 } } }
    const ctx = ctxWithMov(walk)
    ctx.movements.canDig = false
    body.movementsFor('work', bot, ctx)
    assert.equal(ctx.movements.canDig, true)
    const noHome = ctxWithMov({ work: true, step: 'gohome', gohome: { phase: 'walk' }, home: null })
    noHome.movements.canDig = false
    body.movementsFor('work', bot, noHome)
    assert.equal(noHome.movements.canDig, true)
  })

  it('borrows no-dig on the comehome walk and seat, releases elsewhere', () => {
    for (const phase of ['walk', 'seat']) {
      const ctx = ctxWithMov({ comehome: { phase, exiting: false } })
      body.movementsFor('comehome', bot, ctx)
      assert.equal(ctx.movements.canDig, false, phase)
    }
    for (const order of [{ phase: 'open', exiting: false }, { phase: 'walk', exiting: true }, null]) {
      const ctx = ctxWithMov({ comehome: order })
      ctx.movements.canDig = false
      body.movementsFor('comehome', bot, ctx)
      assert.equal(ctx.movements.canDig, true, JSON.stringify(order))
    }
  })

  it('borrows no-dig on the deep dispatch stash, never from ctx', () => {
    const ctx = ctxWithMov({ deep: { phase: 'dig' } })
    body.movementsFor('work', bot, ctx)
    assert.equal(ctx.movements.canDig, true) // stale ctx.deep alone borrows nothing
    ctx.deepRan = true // deep() dispatched this tick
    body.movementsFor('work', bot, ctx)
    assert.equal(ctx.movements.canDig, false)
    // The applyDecision post-dispatch refresh must not reopen it (core-1):
    // deep runs inside applyDecision, after the pre-claim.
    body.movementsFor('work', bot, ctx, { sprint: true })
    assert.equal(ctx.movements.canDig, false)
  })

  it('opens the follow gate only far, flat, fresh and asked', () => {
    const base = {
      followRan: true,
      lastGoalKey: 'follow:Steve',
      lastPathNodes: [{ x: 3, y: 64, z: 0 }, { x: 5, y: 64, z: 0 }],
    }
    const extra = { sprint: true, target: { position: pos(25, 64, 0) }, dist: 25 }
    const open = ctxWithMov(base)
    body.movementsFor('idle', bot, open, extra)
    assert.equal(open.movements.allowSprinting, true)
    assert.equal(open.movements.allowParkour, false)
    const closed = [
      [{ ...base, followRan: false }, extra, 'stale key without dispatch'],
      [{ ...base, lastGoalKey: 'fight:9' }, extra, 'fight key'],
      [base, { sprint: true, target: null, dist: 25 }, 'no target'],
      [base, { sprint: true, target: extra.target, dist: 5 }, 'near'],
      [{ ...base, lastPathNodes: [{ x: 3, y: 65, z: 0 }] }, extra, 'unlevel node'],
      [{ ...base, lastPathNodes: null }, extra, 'no plan'],
      [base, undefined, 'tick-start mode applies no sprint'],
    ]
    for (const [over, ex, why] of closed) {
      const ctx = ctxWithMov(over)
      body.movementsFor('idle', bot, ctx, ex)
      assert.equal(ctx.movements.allowSprinting, false, why)
      assert.equal(ctx.movements.allowParkour, true, why)
    }
  })

  it('opens the shelter gate off the stashed leg anchor', () => {
    const leg = { x: 30, y: 64, z: 0 }
    const nodes = [{ x: 3, y: 64, z: 0 }, { x: 5, y: 64, z: 0 }]
    const open = ctxWithMov({ shelterLeg: leg, lastGoalKey: 'gohome-walk', lastPathNodes: nodes })
    body.movementsFor('work', bot, open, { sprint: true })
    assert.equal(open.movements.allowSprinting, true)
    assert.equal(open.movements.allowParkour, false)
    const near = ctxWithMov({ shelterLeg: { x: 2, y: 64, z: 0 }, lastGoalKey: 'gohome-walk', lastPathNodes: nodes })
    body.movementsFor('work', bot, near, { sprint: true })
    assert.equal(near.movements.allowSprinting, false)
    const wrongKey = ctxWithMov({ shelterLeg: leg, lastGoalKey: 'gather:oak', lastPathNodes: nodes })
    body.movementsFor('work', bot, wrongKey, { sprint: true })
    assert.equal(wrongKey.movements.allowSprinting, false)
    const noStash = ctxWithMov({ lastGoalKey: 'gohome-walk', lastPathNodes: nodes })
    body.movementsFor('work', bot, noStash, { sprint: true })
    assert.equal(noStash.movements.allowSprinting, false)
  })
})

describe('claimBody', () => {
  it('boots silently and applies the flags', () => {
    const bot = mockBot()
    const ctx = { movements: { canDig: true, allowSprinting: true, allowParkour: true } }
    body.claimBody(bot, ctx, 'idle')
    assert.deepEqual(ctx.body, { owner: 'idle' })
    assert.equal(ctx.movements.allowSprinting, false)
    assert.equal(bot.calls.setGoal, 0) // no live goal: no null call
  })

  it('a switch nulls the live goal, clears controls and logs once', () => {
    const bot = mockBot()
    const ctx = { movements: { canDig: true, allowSprinting: false, allowParkour: true } }
    bot.pathfinder.goal = { kind: 'live' }
    bot.setControlState('forward', true)
    const lines = []
    const origLog = console.log
    console.log = (m) => { lines.push(String(m)) }
    try {
      body.claimBody(bot, ctx, 'idle')
      body.claimBody(bot, ctx, 'bring')
    } finally {
      console.log = origLog
    }
    assert.equal(bot.pathfinder.goal, null)
    assert.ok(bot.calls.goals.includes(null))
    assert.equal(bot.getControlState('forward'), false)
    assert.ok(bot.calls.clears >= 1)
    assert.deepEqual(lines, ['body owner idle -> bring'])
  })

  it('a switch clears controls without nulling a moving goal', () => {
    const bot = mockBot()
    bot.pathfinder.isMoving = () => true
    const ctx = { movements: { canDig: true, allowSprinting: false, allowParkour: true } }
    body.claimBody(bot, ctx, 'idle')
    const goal = { kind: 'live' }
    bot.pathfinder.goal = goal
    bot.setControlState('forward', true)
    const clears = bot.calls.clears
    body.claimBody(bot, ctx, 'bring')
    assert.equal(bot.pathfinder.goal, goal) // moving executor untouched (latch safety)
    assert.ok(!bot.calls.goals.includes(null))
    assert.equal(bot.getControlState('forward'), false) // explicit clear only
    assert.equal(bot.calls.clears, clears + 1)
  })

  it('same owner refreshes flags without touching goal or controls', () => {
    const bot = mockBot()
    const ctx = { movements: { canDig: true, allowSprinting: false, allowParkour: true } }
    body.claimBody(bot, ctx, 'idle')
    const goal = { kind: 'live' }
    bot.pathfinder.goal = goal
    bot.setControlState('forward', true)
    const setGoals = bot.calls.setGoal
    const clears = bot.calls.clears
    body.claimBody(bot, ctx, 'idle')
    assert.equal(bot.calls.setGoal, setGoals)
    assert.equal(bot.calls.clears, clears)
    assert.equal(bot.pathfinder.goal, goal)
    assert.equal(bot.getControlState('forward'), true)
  })

  it('the tripwire warns once when flags move behind the lease', () => {
    const bot = mockBot()
    const ctx = { movements: { canDig: true, allowSprinting: false, allowParkour: true } }
    body.claimBody(bot, ctx, 'idle')
    const warns = []
    const origWarn = console.warn
    console.warn = (m) => { warns.push(String(m)) }
    try {
      ctx.movements.canDig = false // outside writer
      body.claimBody(bot, ctx, 'idle')
      ctx.movements.canDig = true // flip back: still the same flag
      body.claimBody(bot, ctx, 'idle')
    } finally {
      console.warn = origWarn
    }
    assert.equal(warns.length, 1)
    assert.match(warns[0], /body lease violation: canDig flipped outside movementsFor/)
  })

  it('resetTick clears the dispatch stashes', () => {
    const ctx = { followRan: true, shelterLeg: { x: 1, y: 2, z: 3 }, deepRan: true }
    body.resetTick(ctx)
    assert.equal(ctx.followRan, false)
    assert.equal(ctx.shelterLeg, null)
    assert.equal(ctx.deepRan, false)
  })
})

describe('ticker body lease', () => {
  it('an owner change clears the goal and control states', async () => {
    const bot = mockBot()
    bot.players = { Steve: { username: 'Steve', entity: { id: 7, position: pos(10, 64, 0) } } }
    const ticker = createTicker({ bot, brain: mockBrain(), tickMs: 10, idleTickMs: 10 })
    ticker.setMovements({ canDig: true, allowSprinting: false, allowParkour: true })
    await ticker.tick() // follow owns: live follow goal
    assert.equal(bot._tickerCtx.body.owner, 'idle')
    assert.ok(bot.pathfinder.goal)
    assert.match(bot._tickerCtx.lastGoalKey, /^follow:/)
    bot.setControlState('forward', true)
    ticker.setLead({ name: 'coal', pos: pos(10, 64, 0) }) // order takes the body next tick
    await ticker.tick()
    assert.equal(bot._tickerCtx.body.owner, 'lead')
    assert.ok(bot.calls.goals.includes(null)) // the follow goal died on the switch
    assert.equal(bot.getControlState('forward'), false)
    assert.match(bot._tickerCtx.lastGoalKey, /^lead:/) // the new owner re-issued
  })

  it('a switch to an order clears controls but never nulls a moving goal', async () => {
    const bot = mockBot()
    bot.players = { Steve: { username: 'Steve', entity: { id: 7, position: pos(10, 64, 0) } } }
    const ticker = createTicker({ bot, brain: mockBrain(), tickMs: 10, idleTickMs: 10 })
    ticker.setMovements({ canDig: true, allowSprinting: false, allowParkour: true })
    await ticker.tick() // follow owns: live follow goal
    bot.setControlState('forward', true)
    bot.pathfinder.isMoving = () => true
    ticker.setLead({ name: 'coal', pos: pos(10, 64, 0) })
    await ticker.tick()
    assert.equal(bot._tickerCtx.body.owner, 'lead')
    assert.ok(!bot.calls.goals.includes(null)) // moving executor untouched (latch safety)
    assert.equal(bot.getControlState('forward'), false) // explicit clear only
    assert.match(bot._tickerCtx.lastGoalKey, /^lead:/) // the new owner overwrote on issue
  })
})
