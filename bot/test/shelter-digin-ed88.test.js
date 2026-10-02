'use strict'

// Bead idkcraft-ed88: respawn at world spawn at night with an empty kit —
// shelter's pillar failed:no-scaffold and the bot "held on the ground",
// 7 deaths in 3 min. Shelter now digs in by hand (3 down, dug dirt caps
// the head), and a death drops the night-step phase records so gohome
// re-walks from the respawn instead of resuming 'enter' 200 blocks away.

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { Vec3 } = require('vec3')
const home = require('../src/behaviours/home')
const recover = require('../src/behaviours/recover')
const { handleDeath } = require('../src/index')

function key(x, y, z) { return `${x},${y},${z}` }

function pos(x, y, z) {
  const p = { x, y, z, distanceTo: (q) => Math.hypot(x - q.x, y - q.y, z - q.z) }
  p.clone = () => pos(p.x, p.y, p.z)
  p.floored = () => pos(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z))
  return p
}

// Flat grass world: ground y<=63 (grass on top, dirt under), air above.
// dig breaks the cell, drops one dirt into the inventory and lets the body
// fall to the next solid floor (centred body, the prod spawn stance).
function flatBot(at, opts = {}) {
  const dug = new Set()
  const placed = new Set()
  const items = []
  const solidAt = (x, y, z) => placed.has(key(x, y, z)) || (y <= 63 && !dug.has(key(x, y, z)))
  const bot = {
    username: 'IdkBot',
    players: {},
    entities: {},
    health: 20,
    food: 20,
    time: { timeOfDay: 15000, day: 5 },
    entity: { position: pos(at.x, at.y, at.z), onGround: true },
    inventory: { items: () => items.filter((i) => i.count > 0) },
    heldItem: null,
    controls: {},
    pathfinder: { goal: null, setGoal: () => {}, isMoving: () => false, stop: () => {} },
    setControlState(c, v) { this.controls[c] = !!v },
    clearControlStates() { this.controls = {} },
    findBlocks: () => [],
    chat: () => {},
    blockAt(p) {
      const x = Math.floor(p.x); const y = Math.floor(p.y); const z = Math.floor(p.z)
      const s = solidAt(x, y, z)
      const name = s ? (opts.ground || (y === 63 ? 'grass_block' : 'dirt')) : 'air'
      return { name, position: new Vec3(x, y, z), boundingBox: s ? 'block' : 'empty' }
    },
    async dig(b) {
      dug.add(key(b.position.x, b.position.y, b.position.z))
      const d = items.find((i) => i.name === 'dirt')
      if (d) d.count++
      else items.push({ name: 'dirt', count: 1 })
      const e = bot.entity.position
      let y = Math.floor(e.y)
      while (!solidAt(Math.floor(e.x), y - 1, Math.floor(e.z))) y--
      bot.entity.position = pos(e.x, y, e.z)
    },
    async equip(item) { bot.heldItem = item },
    async placeBlock(ref, face) {
      if (!bot.heldItem || bot.heldItem.name !== 'dirt' || bot.heldItem.count < 1) throw new Error('no block')
      const d = ref.position.plus(face)
      placed.add(key(d.x, d.y, d.z))
      bot.heldItem.count--
    },
  }
  bot.solidAt = solidAt
  return bot
}

const flush = () => new Promise((r) => setImmediate(r))

function v2home(site) {
  return {
    site: { ...site },
    built: true,
    v: 2,
    interior: { min: { x: site.x + 1, y: site.y, z: site.z + 1 }, max: { x: site.x + 5, y: site.y + 1, z: site.z + 4 } },
    door: { x: site.x + 3, y: site.y, z: site.z },
  }
}

function closedIn(bot) {
  const p = bot.entity.position
  const x = Math.floor(p.x); const y = Math.floor(p.y); const z = Math.floor(p.z)
  const sides = [[1, 0], [-1, 0], [0, 1], [0, -1]]
  for (const dy of [0, 1]) for (const [dx, dz] of sides) if (!bot.solidAt(x + dx, y + dy, z + dz)) return false
  return bot.solidAt(x, y - 1, z) && bot.solidAt(x, y + 2, z)
}

async function quiet(fn) {
  const orig = console.log
  const logs = []
  console.log = (m) => { logs.push(String(m)) }
  try { await fn() } finally { console.log = orig }
  return logs
}

describe('ed88 shelter dig-in: no scaffold still closes the bot in', () => {
  it('digInRun: three hand digs down, dug dirt caps the head', async () => {
    const bot = flatBot({ x: -47.5, y: 64, z: -207.5 })
    const st = {}
    let r = 'running'
    for (let t = 0; t < 15 && r === 'running'; t++) {
      r = recover.digInRun(bot, {}, st)
      await flush()
    }
    assert.equal(r, 'done')
    assert.equal(Math.floor(bot.entity.position.y), 61, 'three deep')
    assert.ok(closedIn(bot), 'walled on all sides, floored and capped')
  })

  it('ledge edge (air under the centre, nothing dug): fails, never steps off', () => {
    const bot = flatBot({ x: 0.5, y: 65, z: 0.5 }) // one block above the ground: below reads air
    assert.equal(recover.digInRun(bot, {}, {}), 'failed:edge')
    assert.ok(!bot.controls.forward, 'no walk toward the drop')
  })

  it('a server that reverts every break: bounded, fails', async () => {
    const bot = flatBot({ x: 0.5, y: 64, z: 0.5 })
    bot.dig = async () => {} // the block comes back
    const st = {}
    let r = 'running'
    for (let t = 0; t < 20 && r === 'running'; t++) {
      r = recover.digInRun(bot, {}, st)
      await flush()
    }
    assert.equal(r, 'failed:dig-refused')
  })

  it('shelter, scaffold=0, night, outside: digs in and holds sheltered', async () => {
    const bot = flatBot({ x: -47.5, y: 64, z: -207.5 })
    const ctx = { home: v2home({ x: 100, y: 71, z: -356 }), step: 'shelter', stepStatus: 'running' }
    const logs = await quiet(async () => {
      for (let t = 0; t < 15; t++) {
        home.shelter(bot, ctx, null, null)
        await flush()
      }
    })
    assert.ok(!String(ctx.stepStatus).startsWith('failed'), ctx.stepStatus)
    assert.equal(ctx.inShelter, true)
    assert.ok(closedIn(bot), 'closed pit')
    assert.ok(logs.includes('shelter dig-in done'), JSON.stringify(logs))
    assert.ok(!logs.some((m) => m.includes('holding on the ground')), 'no ground hold')
  })

  it('stone ground: refuses at the top and holds (never fails the step)', async () => {
    const bot = flatBot({ x: 0.5, y: 64, z: 0.5 }, { ground: 'stone' })
    const ctx = { home: v2home({ x: 200, y: 64, z: 200 }), step: 'shelter', stepStatus: 'running' }
    const logs = await quiet(() => home.shelter(bot, ctx, null, null))
    assert.equal(ctx.inShelter, true)
    assert.equal(ctx.shelter.pillared, true)
    assert.ok(logs.includes('shelter dig-in failed:undiggable'), JSON.stringify(logs))
  })
})

describe('ed88 death drops the night-step phase records', () => {
  it('gohome/stay/shelter reset; the shelter climb episode goes with it', () => {
    const ctx = {
      gohome: { phase: 'enter' },
      stay: { phase: 'hold' },
      shelter: { pillared: true, pillarAt: { x: 0, z: 0 } },
      recovery: { action: 'pillar_up', source: 'shelter', status: 'running' },
    }
    const bot = { _tickerCtx: ctx, health: 0, entity: { position: pos(0, 64, 0) }, entities: {} }
    quiet(() => handleDeath(bot))
    assert.equal(ctx.gohome, null)
    assert.equal(ctx.stay, null)
    assert.equal(ctx.shelter, null)
    assert.equal(ctx.recovery, null)
  })

  it('a foreign recovery episode survives the death reset', () => {
    const ctx = { gohome: { phase: 'walk' }, recovery: { action: 'dig_up', source: 'stuck', status: 'running' } }
    const bot = { _tickerCtx: ctx, health: 0, entity: { position: pos(0, 64, 0) }, entities: {} }
    quiet(() => handleDeath(bot))
    assert.equal(ctx.gohome, null)
    assert.equal(ctx.recovery.action, 'dig_up')
  })
})
