'use strict'

// prod_free: one dig-start under the feet (stopped after ~100 ms, never
// breaks) clears Paper's move suppression, then a short self-driven step
// proves displacement (idkcraft-7tr). Rig EP1: aborted prod restored
// movement 2/2 (disp 5.74/4.89) where jump/look stayed at 0.00. Wired as a
// sidestep-failure escalation (menu + order + FSM + criteria + ticker);
// this file pins the runner, the target guard, feasibility, and the menu
// slot.

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { Vec3 } = require('vec3')
const recover = require('../src/behaviours/recover')

function pos(x, y, z) {
  return {
    x, y, z,
    distanceTo: (q) => Math.hypot(x - q.x, y - q.y, z - q.z),
    clone() { return pos(x, y, z) },
  }
}

function key(x, y, z) { return `${x},${y},${z}` }

// Flat grass disc at y=60, open air above. cells overrides names per key.
function prodBot(cells, opts) {
  const o = opts || {}
  const bot = {
    username: 'IdkBot',
    players: {},
    entities: {},
    entity: { position: pos(0.5, 61, 0.5), onGround: true },
    controls: {},
    setControlState(c, v) { this.controls[c] = !!v },
    clearControlStates() { this.controls = {} },
    blockAt(p) {
      const k = key(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z))
      const n = cells[k] || (Math.floor(p.y) <= 60 ? 'grass_block' : 'air')
      const full = n !== 'air' && n !== 'cave_air' && n !== 'water' && n !== 'lava'
      return { name: n, position: new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)), boundingBox: full ? 'block' : 'empty' }
    },
    digs: [],
    stops: 0,
    async dig(block) {
      bot.digs.push(block.name)
      await new Promise((r) => setTimeout(r, 5))
      throw new Error('Digging aborted')
    },
    stopDigging() { bot.stops++ },
    pathfinder: {
      goal: null,
      setGoal(g) { this.goal = g },
      stop() {},
      isMoving: () => false,
    },
    chat(m) { void m },
  }
  if (o.noDig) { delete bot.dig; delete bot.stopDigging }
  if (o.canDigBlock === false) bot.canDigBlock = () => false
  return bot
}

function prodCtx() {
  return { stuck: { by: 'follow', goal: { x: 10, y: 61, z: 0 } }, recovery: { action: 'prod_free', status: 'running', st: null } }
}

async function flush(ms) {
  await new Promise((r) => setTimeout(r, ms || 150))
}

describe('prod_free runner (idkcraft-7tr)', () => {
  it('prods the block below then stops: dig-start sent, block intact', async () => {
    const cells = {}
    const bot = prodBot(cells)
    const ctx = prodCtx()
    assert.equal(recover.prodFreeRun(bot, ctx), 'running')
    await flush()
    assert.deepEqual(bot.digs, ['grass_block'])
    assert.equal(bot.stops, 1)
    assert.equal(bot.blockAt(new Vec3(0, 60, 0)).name, 'grass_block')
  })

  it('displacement after the prod reports done (F2 rule)', async () => {
    const bot = prodBot({})
    const ctx = prodCtx()
    assert.equal(recover.prodFreeRun(bot, ctx), 'running')
    await flush()
    assert.equal(recover.prodFreeRun(bot, ctx), 'running') // prod done -> step issued
    assert.ok(bot.pathfinder.goal)
    bot.entity.position = pos(1.5, 61, 0.5) // unfrozen body walks
    assert.equal(recover.prodFreeRun(bot, ctx), 'done')
  })

  it('still frozen after the prod fails no-progress, never blind done', async () => {
    const bot = prodBot({})
    const ctx = prodCtx()
    assert.equal(recover.prodFreeRun(bot, ctx), 'running')
    await flush()
    let out = 'running'
    for (let i = 0; i < 12 && out === 'running'; i++) out = recover.prodFreeRun(bot, ctx)
    assert.equal(out, 'failed:no-progress')
  })

  it('air below and around: failed:no-target without touching dig', () => {
    const bot = prodBot({ '0,60,0': 'air', '0,59,0': 'air' })
    const ctx = prodCtx()
    assert.equal(recover.prodFreeRun(bot, ctx), 'failed:no-target')
    assert.deepEqual(bot.digs, [])
  })

  it('mid-air freeze with a side wall: prods the wall, block intact', async () => {
    const bot = prodBot({ '0,62,1': 'stone' })
    bot.entity.position = pos(0.5, 62, 0.5) // below (0,61,0) is air
    const ctx = prodCtx()
    assert.equal(recover.prodFreeRun(bot, ctx), 'running')
    await flush()
    assert.deepEqual(bot.digs, ['stone'])
    assert.equal(bot.stops, 1)
    assert.equal(bot.blockAt(new Vec3(0, 62, 1)).name, 'stone')
  })

  it('mid-air over a deep floor: prods below-2', async () => {
    const bot = prodBot({})
    bot.entity.position = pos(0.5, 62, 0.5) // below air, below-2 grass
    const ctx = prodCtx()
    assert.equal(recover.prodFreeRun(bot, ctx), 'running')
    await flush()
    assert.deepEqual(bot.digs, ['grass_block'])
    assert.equal(bot.stops, 1)
  })

  it('torch below: failed:protected, never prods instant-break flora', () => {
    const bot = prodBot({ '0,60,0': 'torch' })
    bot.blockAt = (p) => {
      const k = key(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z))
      if (k === '0,60,0') return { name: 'torch', position: new Vec3(0, 60, 0) } // no boundingBox: name rule decides
      const n = Math.floor(p.y) <= 60 && k !== '0,60,0' ? 'grass_block' : 'air'
      return { name: n, position: new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)) }
    }
    const ctx = prodCtx()
    assert.equal(recover.prodFreeRun(bot, ctx), 'failed:protected')
    assert.deepEqual(bot.digs, [])
  })

  it('client veto (canDigBlock false): failed:protected', () => {
    const bot = prodBot({}, { canDigBlock: false })
    const ctx = prodCtx()
    assert.equal(recover.prodFreeRun(bot, ctx), 'failed:protected')
    assert.deepEqual(bot.digs, [])
  })

  it('no dig API: failed:no-dig', () => {
    const bot = prodBot({}, { noDig: true })
    const ctx = prodCtx()
    assert.equal(recover.prodFreeRun(bot, ctx), 'failed:no-dig')
  })
})

describe('prod_free feasibility (idkcraft-7tr)', () => {
  const OPEN = { headBlocked: false, walls: 0, lavaNear: false }
  const AFTER_SIDESTEP = { ...OPEN, last: 'sidestep:failed:no-progress' }

  it('after a sidestep failure, head free + <=1 wall + no lava: feasible', () => {
    assert.equal(recover.prodFreeFeasible(AFTER_SIDESTEP), true)
    assert.equal(recover.prodFreeFeasible({ ...AFTER_SIDESTEP, walls: 1 }), true)
  })

  it('fresh episode or other last: never offered (sidestep stays primary)', () => {
    assert.equal(recover.prodFreeFeasible({ ...OPEN, last: 'none' }), false)
    assert.equal(recover.prodFreeFeasible({ ...OPEN }), false)
    assert.equal(recover.prodFreeFeasible({ ...OPEN, last: 'hop_step:failed:no-progress' }), false)
    assert.equal(recover.prodFreeFeasible({ ...OPEN, last: 'sidestep:done' }), false)
  })

  it('head blocked, 2+ walls, lava, or no facts: infeasible', () => {
    assert.equal(recover.prodFreeFeasible({ ...AFTER_SIDESTEP, headBlocked: true }), false)
    assert.equal(recover.prodFreeFeasible({ ...AFTER_SIDESTEP, walls: 2 }), false)
    assert.equal(recover.prodFreeFeasible({ ...AFTER_SIDESTEP, lavaNear: true }), false)
    assert.equal(recover.prodFreeFeasible(null), false)
  })
})

describe('prod_free menu integration (idkcraft-7tr)', () => {
  function feasibleNames(facts) {
    return recover.RECOVER_ORDER.filter((n) => {
      try { return recover.RECOVER_MENU[n].feasible(facts, {}) } catch (_) { return false }
    })
  }

  it('sits right after sidestep in RECOVER_ORDER', () => {
    const o = recover.RECOVER_ORDER
    assert.equal(o.indexOf('prod_free'), o.indexOf('sidestep') + 1)
  })

  it('menu entry: feasible + run + verb, criteria clause defined', () => {
    const e = recover.RECOVER_MENU.prod_free
    assert.equal(typeof e.feasible, 'function')
    assert.equal(typeof e.run, 'function')
    assert.equal(typeof e.verb, 'string')
    assert.match(recover.RECOVER_CRITERIA.prod_free, /unfreeze/)
  })

  it('fresh open stuck: sidestep first, prod_free not in the menu', () => {
    const facts = { goalDy: 0, goalDist: 5, walls: 0, lavaNear: false, headBlocked: false, pickaxe: false, playerOnline: false, last: 'none' }
    const names = feasibleNames(facts)
    assert.ok(!names.includes('prod_free'))
    assert.equal(recover.recoverFsm(facts, names), 'sidestep')
  })

  it('after sidestep fails: FSM escalates to prod_free', () => {
    const facts = { goalDy: 0, goalDist: 5, walls: 0, lavaNear: false, headBlocked: false, pickaxe: false, playerOnline: false, last: 'sidestep:failed:no-progress' }
    const names = feasibleNames(facts)
    assert.ok(names.includes('prod_free'))
    assert.equal(recover.recoverFsm(facts, names), 'prod_free')
  })

  it('after prod_free fails: out of the menu (no blind re-offer)', () => {
    const facts = { goalDy: 0, goalDist: 5, walls: 0, lavaNear: false, headBlocked: false, pickaxe: false, playerOnline: false, last: 'prod_free:failed:no-progress' }
    assert.ok(!feasibleNames(facts).includes('prod_free'))
  })
})
