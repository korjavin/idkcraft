'use strict'

// Bead idkcraft-vmzq.33, minimal take: the castle spawn bed. Prod run 8 lost
// 83 min to world-spawn walkbacks (7 deaths, beds=none). When the bot HAS a
// bed (pack, or the adopted home chest already within reach — no walks,
// hunts, crafts, or sleep goal), this step places it outside the footprint
// and off the door path, clicks it to set the spawn, and finishes. Without
// a bed the step is infeasible by construction: the castle chain decides
// exactly as master.

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { Vec3 } = require('vec3')
const blueprint = require('../src/castle')
const castleMod = require('../src/behaviours/castle')
const sitebed = require('../src/behaviours/sitebed')
const goal = require('../src/goal')
const { respawnLine } = require('../src/index')

const SITE = { x: 100, y: 64, z: 200 }
const flush = () => new Promise((r) => setImmediate(r))

function pos(x, y, z) {
  return { x, y, z, distanceTo: (q) => Math.hypot(x - q.x, y - q.y, z - q.z), clone: () => pos(x, y, z), floored: () => pos(Math.floor(x), Math.floor(y), Math.floor(z)) }
}

function castleState(extra) {
  return { site: { ...SITE }, rot: 0, blueprintVersion: 1, phase: 'body', blocked: {}, parked: false, ...extra }
}

function farHome(extra) {
  return { site: { x: 400, y: 64, z: 400 }, built: true, v: 2, interior: { min: { x: 401, y: 64, z: 401 }, max: { x: 405, y: 65, z: 404 } }, door: { x: 403, y: 64, z: 400 }, ...extra }
}

// Flat world with an override set: dirt at y<=63, air above, blockAt takes
// Vec3 or plain points.
function makeBot({ items = [], timeOfDay = 6000, day = 5, at = pos(SITE.x + 15.5, 64, SITE.z + 13.5), set = new Map(), goals = null } = {}) {
  const bot = {
    username: 'IdkBot',
    chats: [],
    chat(m) { this.chats.push(String(m)) },
    entity: { position: at },
    entities: {},
    inventory: { items: () => items.filter((i) => i.count > 0) },
    time: { timeOfDay, day },
    players: {},
    spawnPoint: pos(0, 64, 0),
    blockAt: (p) => {
      const k = `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`
      const name = set.has(k) ? set.get(k) : (Math.floor(p.y) <= 63 ? 'dirt' : 'air')
      if (name === null) return null // dark chunk
      return { name, position: p, boundingBox: name === 'air' || name === 'cave_air' || name === 'void_air' ? 'empty' : 'block' }
    },
    pathfinder: { isMoving: () => false, setGoal(g) { if (goals) goals.push(g) }, stop() {}, goal: null, movements: null, setMovements() {} },
    clearControlStates() {},
    on() {},
    once() {},
  }
  bot._world = set
  bot._items = items
  return bot
}

function putBed(set, x, y, z, color = 'white') {
  set.set(`${x},${y},${z}`, `${color}_bed`)
  set.set(`${x + 1},${y},${z}`, `${color}_bed`)
}

describe('sitebed geometry', () => {
  it('the spot sits outside the footprint and off the door path, foot+head', () => {
    const bot = makeBot()
    const st = castleState()
    const spot = sitebed.siteBedSpot(bot, st, null)
    assert.ok(spot, 'a spot exists on flat ground')
    for (const dx of [0, 1]) {
      const c = { x: spot.x + dx, y: spot.y, z: spot.z }
      assert.equal(blueprint.inFootprint(st, c), false, `foot+${dx} outside the footprint`)
      assert.equal(castleMod.onDoorPath(st, c.x, c.z), false, `foot+${dx} off the door path`)
    }
  })

  it('bad spots lose', () => {
    const bot = makeBot()
    const st = castleState()
    const first = sitebed.siteBedSpot(bot, st, null)
    assert.ok(first, 'a spot exists')
    const second = sitebed.siteBedSpot(bot, st, new Set([`${first.x},${first.y},${first.z}`]))
    assert.ok(second, 'another spot exists')
    assert.notDeepEqual({ x: second.x, z: second.z }, { x: first.x, z: first.z }, 'bad foot skipped')
  })
})

describe('sitebed menu', () => {
  const day = { time: 'day', home: 'built', inside: 'no', rearm: false, castle: 'stone-none', pickaxe: 1 }

  it('no bed anywhere: infeasible (master-identical by construction)', () => {
    const bot = makeBot({ items: [{ name: 'oak_planks', count: 32 }, { name: 'stone_pickaxe', count: 1 }] })
    assert.equal(goal.MENU.sitebed.feasible(day, bot, { castle: castleState() }), false, 'pack without bed')
    const far = { castle: castleState(), home: farHome({ chest: { x: 402, y: 64, z: 402 } }) }
    assert.equal(goal.MENU.sitebed.feasible(day, bot, far), false, 'a far chest never counts: no walks')
    assert.equal(goal.MENU.sitebed.feasible(day, bot, {}), false, 'no castle')
    assert.equal(goal.MENU.sitebed.feasible({ ...day, time: 'night' }, makeBot({ items: [{ name: 'white_bed', count: 1 }] }), { castle: castleState() }), false, 'nights belong to shelter')
  })

  it('a pack bed is feasible by day and dusk', () => {
    const bot = makeBot({ items: [{ name: 'white_bed', count: 1 }] })
    const ctx = { castle: castleState() }
    assert.equal(goal.MENU.sitebed.feasible(day, bot, ctx), true)
    assert.equal(goal.MENU.sitebed.feasible({ ...day, time: 'dusk' }, bot, ctx), true)
  })

  it('a near adopted chest counts without a pack bed', () => {
    const at = pos(402.5, 64, 402.5)
    const bot = makeBot({ at })
    const ctx = { castle: castleState(), home: farHome({ chest: { x: 402, y: 64, z: 402 } }) }
    assert.equal(goal.MENU.sitebed.feasible(day, bot, ctx), true)
  })

  it('placed, or yielded today: infeasible', () => {
    const set = new Map()
    putBed(set, 90, 64, 190)
    const bot = makeBot({ items: [{ name: 'white_bed', count: 1 }], set })
    const placed = { castle: castleState({ siteBed: { x: 90, y: 64, z: 190 } }) }
    assert.equal(goal.MENU.sitebed.feasible(day, bot, placed), false, 'one bed is enough')
    const yielded = { castle: castleState(), sitebed: { deadDay: 5 } }
    assert.equal(goal.MENU.sitebed.feasible(day, bot, yielded), false, 'tomorrow retries')
  })

  it('with no bed the decide sequence equals master', async () => {
    const index = require('../src/index')
    const kits = [
      [],
      [{ name: 'oak_planks', count: 52 }, { name: 'crafting_table', count: 1 }, { name: 'wooden_pickaxe', count: 1 }],
      [{ name: 'oak_planks', count: 52 }, { name: 'crafting_table', count: 1 }, { name: 'stone_pickaxe', count: 1 }, { name: 'cobblestone', count: 64 }],
    ]
    const keepMenu = goal.MENU.sitebed
    const keepBeh = index.BEHAVIOURS.sitebed
    for (const [i, items] of kits.entries()) {
      const mk = () => [{ bot: makeBot({ items: items.map((x) => ({ ...x })) }), ctx: { castle: castleState(), home: farHome(), work: true } }]
      const [a] = mk()
      const withStep = await goal.decide(a.bot, a.ctx)
      assert.notEqual(withStep.action, 'sitebed', `kit ${i}: the bed never decides without a bed`)
      delete goal.MENU.sitebed
      delete index.BEHAVIOURS.sitebed
      let masterAction
      try {
        const [m] = mk()
        masterAction = (await goal.decide(m.bot, m.ctx)).action
      } finally {
        goal.MENU.sitebed = keepMenu
        index.BEHAVIOURS.sitebed = keepBeh
      }
      assert.equal(withStep.action, masterAction, `kit ${i}: branch ${withStep.action}, master ${masterAction}`)
    }
  })
})

describe('sitebed place and spawn', () => {
  it('a pack bed places outside the site and the click sets the spawn', async () => {
    const set = new Map()
    const bot = makeBot({ items: [{ name: 'white_bed', count: 1 }], set })
    const activated = []
    bot.activateBlock = async (b) => { activated.push(b.name) }
    bot.equip = async () => {}
    bot.look = async () => {}
    bot.placeBlock = async (ref) => {
      const foot = { x: ref.position.x, y: ref.position.y + 1, z: ref.position.z }
      putBed(set, foot.x, foot.y, foot.z)
      const i = bot._items.findIndex((s) => s.name === 'white_bed')
      if (i >= 0) bot._items.splice(i, 1) // the flight consumes the item
    }
    const ctx = { castle: castleState(), home: farHome(), sitebed: {} }
    sitebed(bot, ctx) // picks the spot, starts the walk
    assert.ok(ctx.sitebed.at, 'a spot is picked')
    bot.entity.position = pos(ctx.sitebed.at.x + 0.5, ctx.sitebed.at.y, ctx.sitebed.at.z + 0.5)
    sitebed(bot, ctx) // arrived: the flight places
    await new Promise((r) => setTimeout(r, 1200)) // flight + head sync
    await flush()
    sitebed(bot, ctx) // verify pass claims on the standing bed
    await flush()
    await flush()
    assert.deepEqual(ctx.castle.siteBed, { x: ctx.sitebed.at.x, y: ctx.sitebed.at.y, z: ctx.sitebed.at.z }, 'claimed')
    assert.ok(sitebed.siteBedStands(bot, ctx), 'the world shows the bed')
    assert.deepEqual(activated, ['white_bed'], 'the claim clicks the bed')
    assert.equal(ctx.castle.siteSpawnSet, true, 'spawn flag set')
    assert.ok(bot.chats.join(' ').includes('site bed is in'), `logged, got: ${bot.chats.join(' | ')}`)
    assert.ok(bot.chats.join(' ').includes('site spawn set'), `logged, got: ${bot.chats.join(' | ')}`)
    assert.equal(ctx.stepStatus, 'done')
  })

  it('an empty near chest yields the day without looping', async () => {
    const at = pos(402.5, 64, 402.5)
    const set = new Map()
    set.set('402,64,402', 'chest')
    const bot = makeBot({ at, set })
    const chestItems = []
    bot.openChest = async () => ({
      containerItems: () => chestItems,
      withdraw: async () => {},
      close: () => {},
    })
    const ctx = { castle: castleState(), home: farHome({ chest: { x: 402, y: 64, z: 402 } }), sitebed: {} }
    sitebed(bot, ctx) // pull flight starts
    assert.equal(ctx.stepStatus, undefined, 'the pull owns the tick')
    await flush()
    await flush()
    sitebed(bot, ctx) // recount: still no bed
    assert.equal(ctx.stepStatus, 'done', 'yields, no fail ping-pong')
    assert.equal(ctx.sitebed.deadDay, 5, 'the menu cannot re-pick today')
    const day = { time: 'day', home: 'built', inside: 'no', rearm: false, castle: 'stone-none', pickaxe: 1 }
    assert.equal(goal.MENU.sitebed.feasible(day, bot, ctx), false)
  })

  it('respawnLine reports the clicked site bed', () => {
    const bot = makeBot()
    bot._tickerCtx = { castle: castleState({ siteBed: { x: 90, y: 64, z: 191 }, siteSpawnSet: true }) }
    const line = respawnLine(bot)
    assert.ok(line.includes('(bed)'), `bed spawn, got: ${line}`)
    assert.ok(line.includes('90 64 191'), `site coords, got: ${line}`)
  })
})
