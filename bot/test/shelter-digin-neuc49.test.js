'use strict'

// Bead idkcraft-neuc.49: SHELTER-WATER on the v2 (Baritone) body held OPEN —
// the body slid one column off the dug column during dig-in (setGoal(null)
// only sends #stop, the real client keeps momentum), so the cap scan above
// the head found no solid side neighbour (failed:no-cap-ref) and shelter
// held instead of re-picking. digInRun now settles stationary AND centred
// before pinning the dig column (v2 only) and walks one step back to it
// when a later tick finds the body off it (bounded).

const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const { Vec3 } = require('vec3')
const recover = require('../src/behaviours/recover')

function key(x, y, z) { return `${x},${y},${z}` }

function pos(x, y, z) {
  const p = { x, y, z, distanceTo: (q) => Math.hypot(x - q.x, y - q.y, z - q.z) }
  p.clone = () => pos(p.x, p.y, p.z)
  p.floored = () => pos(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z))
  return p
}

// Flat grass world like the ed88 harness, but the dig is deferred: the
// promise resolves when the test says so, so the test can slide the body
// mid-dig the way Baritone momentum does on v2.
function v2bot(at, opts = {}) {
  const dug = new Set()
  const placed = new Set()
  const items = []
  const resolvers = []
  const digCalls = []
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
    goals: [],
    pathfinder: {
      goal: null,
      setGoal(g) { bot.pathfinder.goal = g; if (g) bot.goals.push(g) },
      isMoving: () => false,
      stop: () => {},
    },
    setControlState(c, v) { this.controls[c] = !!v },
    clearControlStates() { this.controls = {} },
    findBlocks: () => [],
    chat: () => {},
    blockAt(p) {
      const x = Math.floor(p.x); const y = Math.floor(p.y); const z = Math.floor(p.z)
      const s = solidAt(x, y, z)
      const name = s ? ((opts.groundAt && opts.groundAt(x, y, z)) || (y === 63 ? 'grass_block' : 'dirt')) : 'air'
      return { name, position: new Vec3(x, y, z), boundingBox: s ? 'block' : 'empty' }
    },
    dig(b) {
      digCalls.push(key(b.position.x, b.position.y, b.position.z))
      return new Promise((resolve) => { resolvers.push(() => {
        dug.add(key(b.position.x, b.position.y, b.position.z))
        const d = items.find((i) => i.name === 'dirt')
        if (d) d.count++
        else items.push({ name: 'dirt', count: 1 })
        const e = bot.entity.position
        let y = Math.floor(e.y)
        while (!solidAt(Math.floor(e.x), y - 1, Math.floor(e.z))) y--
        bot.entity.position = pos(e.x, y, e.z)
        resolve()
      }) })
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
  bot.resolvers = resolvers
  bot.digCalls = digCalls
  return bot
}

const flush = () => new Promise((r) => setImmediate(r))
const resolveAll = async (bot) => { while (bot.resolvers.length) bot.resolvers.shift()(); await flush() }

function closedIn(bot) {
  const p = bot.entity.position
  const x = Math.floor(p.x); const y = Math.floor(p.y); const z = Math.floor(p.z)
  const sides = [[1, 0], [-1, 0], [0, 1], [0, -1]]
  for (const dy of [0, 1]) for (const [dx, dz] of sides) if (!bot.solidAt(x + dx, y + dy, z + dz)) return false
  return bot.solidAt(x, y - 1, z) && bot.solidAt(x, y + 2, z)
}

let prevBody
beforeEach(() => { prevBody = process.env.BOT_BODY; process.env.BOT_BODY = 'baritone' })
afterEach(() => {
  if (prevBody == null) delete process.env.BOT_BODY
  else process.env.BOT_BODY = prevBody
})

describe('neuc.49 v2 dig-in slide: settle pins the stopped column', () => {
  it('no dig while the body still slides after walk arrival', () => {
    const bot = v2bot({ x: 96.5, y: 64, z: 0.5 })
    const st = { walk: { x: 96, y: 64, z: 0 }, walkTicks: 0 }
    assert.equal(recover.digInRun(bot, {}, st), 'running') // arrival
    assert.equal(st.walk, null)
    // Momentum carries the body across the boundary; nothing may dig yet.
    bot.entity.position = pos(96.9, 64, 0.5)
    assert.equal(recover.digInRun(bot, {}, st), 'running')
    bot.entity.position = pos(97.3, 64, 0.5)
    assert.equal(recover.digInRun(bot, {}, st), 'running')
    assert.equal(bot.digCalls.length, 0, 'no dig off the arrival column')
  })

  it('slide mid-dig walks one step back to the dug column and closes', async () => {
    const bot = v2bot({ x: 96.5, y: 64, z: 0.5 })
    const st = {}
    assert.equal(recover.digInRun(bot, {}, st), 'running') // settle tick 1
    assert.equal(recover.digInRun(bot, {}, st), 'running') // pinned, first dig dispatched
    assert.equal(bot.digCalls.length, 1)
    assert.equal(bot.digCalls[0], key(96, 63, 0))
    // The client slides off mid-dig; the break lands on the dug column.
    bot.entity.position = pos(97.4, 64, 0.5)
    await resolveAll(bot)
    assert.equal(recover.digInRun(bot, {}, st), 'running') // walk-back, not a neighbour dig
    assert.equal(bot.digCalls.length, 1, 'never digs under the neighbour')
    assert.equal(st.returns, 1)
    const g = bot.pathfinder.goal
    assert.ok(g && g.x === 96 && g.z === 0, `walks back to the dug column: ${JSON.stringify(g)}`)
    // A real body stepping back over the mouth falls in: arrival takes
    // x/z with the feet at or below the mouth, and the depth still counts
    // from the mouth level.
    bot.entity.position = pos(96.5, 63, 0.5)
    assert.equal(recover.digInRun(bot, {}, st), 'running') // arrival re-settles
    assert.equal(st.walk, null)
    assert.equal(st.floor0, 64, 'mouth level kept, not the fallen feet')
    let r = 'running'
    for (let t = 0; t < 20 && r === 'running'; t++) {
      r = recover.digInRun(bot, {}, st)
      await resolveAll(bot)
    }
    assert.equal(r, 'done')
    assert.equal(bot.digCalls[1], key(96, 62, 0), 'descent continues in the dug column')
    assert.ok(closedIn(bot), 'closed pit on the dug column')
  })

  it('stone stance pins the walked-to column, never walks back to the refusal', async () => {
    // Core-1: the veto refuses the stance column, digInSpot walks to dirt;
    // the pin must land on the first dispatched dig, not the stance.
    const bot = v2bot({ x: 0.5, y: 64, z: 0.5 }, { groundAt: (x, y, z) => (x === 3 && z === 0 ? null : 'stone') })
    const st = {}
    assert.equal(recover.digInRun(bot, {}, st), 'running') // settle tick 1
    assert.equal(recover.digInRun(bot, {}, st), 'running') // settled, veto refuses, walks
    assert.ok(!st.col, 'no pin before the first dig')
    assert.ok(st.walk && st.walk.x === 3, `walks to the dirt column: ${JSON.stringify(st.walk)}`)
    bot.entity.position = pos(3.5, 64, 0.5) // the pathfinder walked it
    assert.equal(recover.digInRun(bot, {}, st), 'running') // arrival re-settles
    let r = 'running'
    for (let t = 0; t < 20 && r === 'running'; t++) {
      r = recover.digInRun(bot, {}, st)
      await resolveAll(bot)
    }
    assert.equal(r, 'done')
    assert.deepEqual([st.col.x, st.col.z], [3, 0], 'pinned where it dug')
    assert.ok(!st.returns, 'never walks back to the refused stance')
    assert.ok(closedIn(bot), 'closed pit at the dirt column')
  })

  it('over-air stance never pulses toward the overhang centre', () => {
    // Body-2: grounded over an edge, the settle must not steer into the drop.
    const bot = v2bot({ x: 0.2, y: 65, z: 0.5 }) // off-centre over air: the old pulse aimed at 0.5, past the rim
    const st = {}
    assert.equal(recover.digInRun(bot, {}, st), 'running') // settle tick 1
    assert.equal(recover.digInRun(bot, {}, st), 'failed:edge') // edge branch owns it, never stepped off
    assert.ok(!bot.controls.forward, 'no centre pulse off the ledge')
  })

  it('a body that never re-reaches the column fails bounded, never paces', async () => {
    const bot = v2bot({ x: 96.5, y: 64, z: 0.5 })
    const st = {}
    recover.digInRun(bot, {}, st)
    recover.digInRun(bot, {}, st)
    assert.equal(bot.digCalls.length, 1)
    await resolveAll(bot) // the first break lands, the body drops into the mouth
    // Slides far and keeps walking away: the walk-back cannot arrive.
    let r = 'running'
    for (let t = 0; t < 10 && r === 'running'; t++) {
      bot.entity.position = pos(101.5 + t * 0.1, 64, 0.5)
      r = recover.digInRun(bot, {}, st)
    }
    assert.equal(r, 'failed:no-walk')
    assert.equal(st.returns, 1, 'one walk-back only')
  })
})
