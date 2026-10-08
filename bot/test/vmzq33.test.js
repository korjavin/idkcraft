'use strict'

// Bead idkcraft-vmzq.33: the castle site bed — fetch wool once, sleep at the
// site nightly. Sleeping skips the night, resets the phantom timer, and sets
// the spawn AT the site; without a bed the #351/#347 shelter stays the
// fallback. The bed sits outside the castle footprint and off the door path.

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { Vec3 } = require('vec3')
const blueprint = require('../src/castle')
const castleMod = require('../src/behaviours/castle')
const castlebed = require('../src/behaviours/castlebed')
const bedsMod = require('../src/behaviours/beds')
const goal = require('../src/goal')
const memory = require('../src/memory')
const { respawnLine } = require('../src/index')

const SITE = { x: 100, y: 64, z: 200 }
const flush = () => new Promise((r) => setImmediate(r))

function pos(x, y, z) {
  return { x, y, z, distanceTo: (q) => Math.hypot(x - q.x, y - q.y, z - q.z), clone: () => pos(x, y, z), floored: () => pos(Math.floor(x), Math.floor(y), Math.floor(z)) }
}

function castleState(extra) {
  return { site: { ...SITE }, rot: 0, blueprintVersion: 1, phase: 'body', blocked: {}, parked: false, ...extra }
}

function farHome() {
  return { site: { x: 400, y: 64, z: 400 }, built: true, v: 2, interior: { min: { x: 401, y: 64, z: 401 }, max: { x: 405, y: 65, z: 404 } }, door: { x: 403, y: 64, z: 400 } }
}

// Flat world with an override set: dirt at y<=63, air above, bed/ground
// overrides by key. blockAt takes Vec3 or plain points.
function makeBot({ items = [], timeOfDay = 6000, at = pos(SITE.x + 15.5, 64, SITE.z + 13.5), set = new Map() } = {}) {
  const bot = {
    username: 'IdkBot',
    chats: [],
    chat(m) { this.chats.push(String(m)) },
    entity: { position: at },
    inventory: { items: () => items.filter((i) => i.count > 0) },
    time: { timeOfDay, day: 5 },
    players: {},
    spawnPoint: pos(0, 64, 0),
    blockAt: (p) => {
      const k = `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`
      const name = set.has(k) ? set.get(k) : (Math.floor(p.y) <= 63 ? 'dirt' : 'air')
      if (name === null) return null // dark chunk
      return { name, position: p, boundingBox: name === 'air' || name === 'cave_air' || name === 'void_air' ? 'empty' : 'block' }
    },
    pathfinder: { isMoving: () => false, setGoal() {}, stop() {}, goal: null, movements: null, setMovements() {} },
    clearControlStates() {},
    on() {},
    once() {},
  }
  bot._world = set
  return bot
}

function putBed(set, x, y, z, color = 'white') {
  set.set(`${x},${y},${z}`, `${color}_bed`)
  set.set(`${x + 1},${y},${z}`, `${color}_bed`)
}

describe('vmzq.33 site-bed geometry', () => {
  it('onDoorPath marks the entrance way out, 2 to either side', () => {
    const st = castleState()
    const ent = castleMod.entrance(st)
    assert.ok(castlebed && ent, 'entrance resolves')
    // North exit for rot 0 (reach 6): along the path reads on, 3 aside reads off.
    assert.equal(castleMod.onDoorPath(st, ent.x, ent.z - 3), true)
    assert.equal(castleMod.onDoorPath(st, ent.x + 3, ent.z - 3), false)
    assert.equal(castleMod.onDoorPath(st, ent.x, ent.z + 5), false, 'behind the entrance is off')
  })

  it('siteBedSpot sits outside the footprint and off the door path', () => {
    const bot = makeBot()
    const st = castleState()
    const spot = castlebed.siteBedSpot(bot, st, null)
    assert.ok(spot, 'a spot exists on flat ground')
    for (const dx of [0, 1]) {
      const c = { x: spot.x + dx, y: spot.y, z: spot.z }
      assert.equal(blueprint.inFootprint(st, c), false, `foot+${dx} outside the footprint`)
      assert.equal(castleMod.onDoorPath(st, c.x, c.z), false, `foot+${dx} off the door path`)
    }
  })

  it('siteBedSpot skips bad spots', () => {
    const bot = makeBot()
    const st = castleState()
    const first = castlebed.siteBedSpot(bot, st, null)
    assert.ok(first, 'a spot exists')
    const bad = new Set([`${first.x},${first.y},${first.z}`])
    const second = castlebed.siteBedSpot(bot, st, bad)
    assert.ok(second, 'another spot exists')
    assert.notDeepEqual({ x: second.x, z: second.z }, { x: first.x, z: first.z }, 'bad foot skipped')
  })
})

describe('vmzq.33 sitebed fact', () => {
  it('none with no claim and no packed bed', () => {
    const bot = makeBot()
    assert.equal(castlebed.sitebedFact(bot, { castle: castleState() }), 'none')
  })

  it('packed with a bed item, no claim', () => {
    const bot = makeBot({ items: [{ name: 'white_bed', count: 1 }] })
    assert.equal(castlebed.sitebedFact(bot, { castle: castleState() }), 'packed')
  })

  it('placed with a claimed whole bed', () => {
    const set = new Map()
    putBed(set, 90, 64, 190)
    const bot = makeBot({ set })
    const ctx = { castle: castleState({ siteBed: { x: 90, y: 64, z: 190 } }) }
    assert.equal(castlebed.sitebedFact(bot, ctx), 'placed')
  })

  it('a mined claim reads none (loaded air, no trust)', () => {
    const bot = makeBot()
    const ctx = { castle: castleState({ siteBed: { x: 90, y: 64, z: 190 } }) }
    assert.equal(castlebed.sitebedFact(bot, ctx), 'none')
  })
})

describe('vmzq.33 menu', () => {
  const day = { time: 'day', home: 'built', inside: 'no', rearm: false, castle: 'stone-none' }
  const night = { time: 'night', home: 'built', inside: 'no', rearm: false, castle: 'stone-none' }

  it('day fetches with planks, no bed, unlatched sheep', () => {
    const bot = makeBot({ items: [{ name: 'oak_planks', count: 8 }] })
    const ctx = { castle: castleState() }
    assert.equal(goal.MENU.castlebed.feasible(day, bot, ctx), true)
  })

  it('day yields: packed bed, latch, no planks, rearm, no castle', () => {
    const ctx = { castle: castleState() }
    assert.equal(goal.MENU.castlebed.feasible(day, makeBot({ items: [{ name: 'white_bed', count: 1 }] }), ctx), false, 'packed awaits dusk')
    assert.equal(goal.MENU.castlebed.feasible(day, makeBot(), ctx), false, 'no planks, no hunt')
    const latched = { castle: castleState(), beds: { noWool: { fails: 2, at: Date.now() } } }
    assert.equal(goal.MENU.castlebed.feasible(day, makeBot({ items: [{ name: 'oak_planks', count: 8 }] }), latched), false, 'sheepless latch')
    assert.equal(goal.MENU.castlebed.feasible({ ...day, rearm: true }, makeBot({ items: [{ name: 'oak_planks', count: 8 }] }), ctx), false, 'rearm first')
    assert.equal(goal.MENU.castlebed.feasible(day, makeBot({ items: [{ name: 'oak_planks', count: 8 }] }), {}), false, 'no castle')
  })

  it('day yields to an unarmed kit (the vmzq.17 chain equips first)', () => {
    const bot = makeBot({ items: [{ name: 'oak_planks', count: 32 }, { name: 'crafting_table', count: 1 }, { name: 'stick', count: 4 }] })
    const ctx = { castle: castleState(), home: farHome() }
    const facts = goal.goalFacts(bot, ctx)
    assert.equal(goal.MENU.equip.feasible(facts, bot, ctx), true, 'the kit still wants arming')
    assert.equal(goal.MENU.castlebed.feasible(facts, bot, ctx), false, 'kit first, sheep later')
  })

  it('night sleeps in a placed bed at the site', () => {
    const set = new Map()
    putBed(set, 90, 64, 190)
    const bot = makeBot({ timeOfDay: 18000, set })
    const ctx = { castle: castleState({ siteBed: { x: 90, y: 64, z: 190 } }), home: farHome() }
    assert.equal(goal.MENU.castlebed.feasible(night, bot, ctx), true)
  })

  it('night yields: far from site, inside, no bed', () => {
    const set = new Map()
    putBed(set, 90, 64, 190)
    const ctx = { castle: castleState({ siteBed: { x: 90, y: 64, z: 190 } }), home: farHome() }
    const far = makeBot({ timeOfDay: 18000, at: pos(0.5, 64, 0.5), set })
    assert.equal(goal.MENU.castlebed.feasible(night, far, ctx), false, 'too far: shelter holds here')
    assert.equal(goal.MENU.castlebed.feasible({ ...night, inside: 'yes' }, makeBot({ timeOfDay: 18000, set }), ctx), false, 'inside: stay wins')
    const bare = { castle: castleState(), home: farHome() }
    assert.equal(goal.MENU.castlebed.feasible(night, makeBot({ timeOfDay: 18000 }), bare), false, 'no bed: shelter runs')
  })

  it('night places a packed bed', () => {
    const bot = makeBot({ timeOfDay: 18000, items: [{ name: 'white_bed', count: 1 }] })
    const ctx = { castle: castleState(), home: farHome() }
    assert.equal(goal.MENU.castlebed.feasible(night, bot, ctx), true)
  })

  it('shelter yields to a ready site bed, runs without one', () => {
    const set = new Map()
    putBed(set, 90, 64, 190)
    const ready = { castle: castleState({ siteBed: { x: 90, y: 64, z: 190 } }), home: farHome() }
    const bot = makeBot({ timeOfDay: 18000, set })
    assert.equal(goal.MENU.castlebed.feasible(night, bot, ready), true, 'bed ready')
    assert.equal(goal.MENU.shelter.feasible(night, bot, ready), false, 'shelter yields')
    const bare = { castle: castleState(), home: farHome() }
    const bot2 = makeBot({ timeOfDay: 18000 })
    assert.equal(goal.MENU.castlebed.feasible(night, bot2, bare), false, 'no bed')
    assert.equal(goal.MENU.shelter.feasible(night, bot2, bare), true, 'shelter runs')
  })

  it('goalFsm ranks castlebed below castle, above the day steps', () => {
    const facts = { ...day }
    assert.equal(goal.goalFsm(facts, ['castle', 'castlebed', 'craft']), 'castle')
    assert.equal(goal.goalFsm(facts, ['castlebed', 'craft', 'rest']), 'castlebed')
    assert.equal(goal.goalFsm({ ...night }, ['shelter', 'castlebed', 'craft']), 'shelter', 'shelter still first when both feasible (yield decides)')
  })

  it('chooseStep never asks the model for a runnable site bed', async () => {
    let asked = 0
    const brain = { source: 'laya', async ask() { asked++; return { choice: 'rest' } } }
    const r = await goal.chooseStep(brain, { ...day }, ['castlebed', 'craft', 'rest'], null)
    assert.equal(r.step, 'castlebed')
    assert.equal(r.source, 'castlebed-rule')
    assert.equal(asked, 0, 'the model never overrides the rule')
  })

  it('goalText carries sitebed with the castle word, castle stays last', () => {
    const withCastle = goal.goalText({ time: 'day', home: 'built', inside: 'no', known: 'near', haul: 'none', player: 'none', chest: 'none', surplus: 'no', gearHandover: 'no', gear: 'done', beds: 'both', sitebed: 'packed', castle: 'stone-none', sword: 1, pickaxe: 1 })
    assert.ok(withCastle.includes('sitebed=packed'), `sitebed rides along, got: ${withCastle}`)
    assert.ok(withCastle.endsWith('castle=stone-none'), `castle word stays last, got: ${withCastle}`)
    const bare = goal.goalText({ time: 'day', home: 'built', inside: 'no', known: 'near', haul: 'none', player: 'none', chest: 'none', surplus: 'no', gearHandover: 'no', gear: 'done', beds: 'both', castle: 'none' })
    assert.ok(!bare.includes('sitebed'), `castle-less text byte-identical, got: ${bare}`)
  })
})

describe('vmzq.33 day fetch', () => {
  it('a packed bed is done (dusk places)', () => {
    const bot = makeBot({ items: [{ name: 'white_bed', count: 1 }] })
    const ctx = { castle: castleState() }
    castlebed(bot, ctx)
    assert.equal(ctx.stepStatus, 'done')
    assert.equal(ctx.inShelter, false)
  })

  it('wool-short opens a self wool hunt, dusk-cancellable like beds', () => {
    const bot = makeBot({ items: [{ name: 'oak_planks', count: 8 }] })
    const ctx = { castle: castleState() }
    castlebed(bot, ctx)
    assert.ok(ctx.bring, 'hunt opened')
    assert.equal(ctx.bring.self, 'castlebed')
    assert.equal(ctx.bring.name, 'wool')
    assert.equal(ctx.stepStatus, undefined, 'running, not finished')
  })

  it('a short cancelled hunt reopens, an exhausted one latches and fails', () => {
    const pack = [{ name: 'oak_planks', count: 8 }]
    const bot = makeBot({ items: pack })
    const ctx = { castle: castleState(), castlebed: { hunt: { searchLegs: { legs: 5 } }, reopens: 0 } }
    castlebed(bot, ctx)
    assert.ok(ctx.bring, 'short hunt reopens in the morning')
    assert.equal(ctx.castlebed.reopens, 1)
    const ctx2 = { castle: castleState(), beds: {}, castlebed: { hunt: { searchLegs: { legs: 24 } }, reopens: 0 } }
    castlebed(makeBot({ items: pack }), ctx2)
    assert.equal(ctx2.stepStatus, 'failed:no-wool')
    assert.ok(ctx2.beds.noWool && ctx2.beds.noWool.fails >= 1, 'the shared latch notes the failure')
  })
})

describe('vmzq.33 night place and sleep', () => {
  it('places the packed bed outside the site and off the door path', async () => {
    const set = new Map()
    const at = pos(SITE.x + 15.5, 64, SITE.z + 13.5)
    const bot = makeBot({ timeOfDay: 18000, items: [{ name: 'white_bed', count: 1 }], at, set })
    bot.equip = async () => {}
    bot.look = async () => {}
    bot._placeBlockWithOptions = async (ref) => {
      const fx = Math.floor(ref.position.x)
      const fy = Math.floor(ref.position.y) + 1
      const fz = Math.floor(ref.position.z)
      putBed(set, fx, fy, fz)
    }
    const ctx = { castle: castleState(), home: farHome() }
    castlebed(bot, ctx) // picks the spot, starts the walk
    assert.ok(ctx.castlebed.at, 'a spot was picked')
    bot.entity.position = pos(ctx.castlebed.at.x + 0.5, 64, ctx.castlebed.at.z + 0.5) // the walk arrives
    castlebed(bot, ctx) // in reach: the place flight runs
    await flush()
    await flush()
    castlebed(bot, ctx) // the verify pass claims the placed bed
    const claim = ctx.castle.siteBed
    assert.ok(claim, 'placed bed claimed')
    for (const dx of [0, 1]) {
      assert.equal(blueprint.inFootprint(ctx.castle, { x: claim.x + dx, y: claim.y, z: claim.z }), false, 'outside the footprint')
      assert.equal(castleMod.onDoorPath(ctx.castle, claim.x + dx, claim.z), false, 'off the door path')
    }
    assert.ok(bot.chats.some((c) => c.includes('site bed is in')), `place chatted, got: ${bot.chats.join(' | ')}`)
  })

  it('sleeps in the placed bed and sets the site spawn', async () => {
    const set = new Map()
    putBed(set, 90, 64, 190)
    const bot = makeBot({ timeOfDay: 18000, at: pos(90.5, 64, 190.5), set })
    bot.isSleeping = false
    bot.sleep = async () => {}
    const ctx = { castle: castleState({ siteBed: { x: 90, y: 64, z: 190 } }), home: { ...farHome(), sleptA: true }, castlebed: {} }
    castlebed(bot, ctx)
    await flush()
    assert.equal(ctx.castle.sleptSite, true, 'site sleep claims the spawn')
    assert.equal(ctx.home.sleptA, undefined, 'the site spawn wins over home')
    assert.ok(bot.chats.some((c) => c.includes('sleeping at the site')), `sleep chatted, got: ${bot.chats.join(' | ')}`)
    bot.isSleeping = true
    castlebed(bot, ctx)
    assert.equal(ctx.inShelter, true, 'a sleeping body suppresses the fight')
  })

  it('monsters nearby back off with the fight unsuppressed', async () => {
    const set = new Map()
    putBed(set, 90, 64, 190)
    const bot = makeBot({ timeOfDay: 18000, at: pos(90.5, 64, 190.5), set })
    bot.isSleeping = false
    bot.sleep = async () => { throw new Error('monsters nearby') }
    const ctx = { castle: castleState({ siteBed: { x: 90, y: 64, z: 190 } }), home: farHome(), castlebed: {} }
    castlebed(bot, ctx)
    await flush()
    assert.ok((ctx.castlebed.sleepCooldown || 0) > 0, 'transient backoff armed')
    castlebed(bot, ctx)
    assert.equal(ctx.inShelter, false, 'awake and waiting: fight clears the mobs')
    assert.equal(ctx.stepStatus, undefined, 'retrying, not failed')
  })

  it('no bed at night yields to the shelter (done, no hold past dawn)', () => {
    const bot = makeBot({ timeOfDay: 18000 })
    const ctx = { castle: castleState(), home: farHome(), castlebed: {} }
    castlebed(bot, ctx)
    assert.equal(ctx.stepStatus, 'done')
    assert.equal(ctx.castlebed.deadNight, 5, 'tonight only')
    assert.equal(ctx.stepFail && ctx.stepFail.castlebed, undefined, 'no hold stands into the next night')
  })

  it('a yielded night re-decides to shelter, the next night retries the bed', async () => {
    const set = new Map()
    putBed(set, 90, 64, 190)
    const bot = makeBot({ timeOfDay: 18000, at: pos(90.5, 64, 190.5), set })
    bot.isSleeping = false
    bot.sleep = async () => { throw new Error('occupied by another player') }
    const ctx = { castle: castleState({ siteBed: { x: 90, y: 64, z: 190 } }), home: farHome(), castlebed: {}, work: true, step: 'castlebed', stepStatus: 'running' }
    castlebed(bot, ctx) // night 1: the sleep refuses, tonight yields
    await flush()
    await flush()
    castlebed(bot, ctx)
    assert.equal(ctx.stepStatus, 'done')
    assert.equal(goal.MENU.castlebed.feasible(goal.goalFacts(bot, ctx), bot, ctx), false, 'yielded tonight')
    assert.equal((await goal.decide(bot, ctx)).action, 'shelter', 'the shelter holds the rest of the night')
    bot.time.day = 6 // night 2: the flags re-arm, the sleep lands
    bot.sleep = async () => {}
    ctx.step = 'shelter'
    ctx.stepStatus = 'done'
    assert.equal(goal.MENU.castlebed.feasible(goal.goalFacts(bot, ctx), bot, ctx), true, 'the next night retries')
    castlebed(bot, ctx)
    await flush()
    assert.equal(ctx.castle.sleptSite, true, 'night 2 sleeps')
  })
})

describe('vmzq.33 spawn line and memory', () => {
  it('respawnLine reports the site bed', () => {
    const bot = makeBot()
    bot._tickerCtx = { castle: castleState({ siteBed: { x: 90, y: 64, z: 191 }, sleptSite: true }) }
    const line = respawnLine(bot)
    assert.ok(line.includes('(bed)'), `bed spawn, got: ${line}`)
    assert.ok(line.includes('90 64 191'), `site coords, got: ${line}`)
  })

  it('the site-bed claim survives a restart', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vmzq33-'))
    const f = path.join(dir, 'IdkBot.json')
    const bot = makeBot()
    const st = castleState({ siteBed: { x: 90, y: 64, z: 191 }, sleptSite: true })
    assert.equal(memory.save(bot, { castle: st }, f, Date.now()), true)
    const ctx = {}
    memory.restore(bot, ctx, f, Date.now())
    assert.deepEqual(ctx.castle.siteBed, { x: 90, y: 64, z: 191 })
    assert.equal(ctx.castle.sleptSite, true)
    fs.rmSync(dir, { recursive: true, force: true })
  })
})
