'use strict'

// idkcraft-vf8e.21: the v2 facade proof scenario stays runnable — the skill
// compiles on both bodies, the spots file parses, and the skill walks the
// facade sequence (goto GoalNear under a skill: key, dig leaves, place the
// sapling, done) on a fake. The rig (REPLAY_BODY=baritone) is the verdict;
// this is the fast rot gate.

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { Vec3 } = require('vec3')
const skills = require('../src/skills')

const DIR = path.join(__dirname, '..', 'tools', 'goals', 'v2-facade')
const key = (x, y, z) => `${Math.floor(x)},${Math.floor(y)},${Math.floor(z)}`

const LEAVES = [[67, 66, -193], [69, 66, -193], [68, 66, -192], [68, 66, -194],
  [67, 66, -192], [69, 66, -194], [68, 67, -193], [67, 67, -193]]

function fakeBot() {
  const cells = new Map()
  for (let y = 64; y <= 68; y++) cells.set(key(68, y, -193), 'oak_log')
  for (const [x, y, z] of LEAVES) cells.set(key(x, y, z), 'oak_leaves')
  const name = (x, y, z) => cells.get(key(x, y, z)) || (Math.floor(y) <= 63 ? 'dirt' : 'air')
  const block = (x, y, z) => {
    const n = name(x, y, z)
    return { name: n, position: new Vec3(Math.floor(x), Math.floor(y), Math.floor(z)), boundingBox: n === 'air' ? 'empty' : 'block' }
  }
  let goal = null
  const dug = []
  const placed = []
  const bot = {
    entity: { position: new Vec3(59.5, 64, -205.5), onGround: true },
    players: {},
    entities: {},
    health: 20,
    food: 20,
    time: { timeOfDay: 1000 },
    items: [{ name: 'oak_sapling', count: 4 }],
    inventory: { items: () => bot.items },
    heldItem: null,
    setControlState() {},
    clearControlStates() {},
    blockAt(p) { return block(p.x, p.y, p.z) },
    findBlocks({ matching, maxDistance = 16, count = 16 }) {
      const o = bot.entity.position.floored()
      const out = []
      for (const [k] of cells) {
        const [x, y, z] = k.split(',').map(Number)
        if (o.distanceTo(new Vec3(x, y, z)) <= maxDistance && matching(block(x, y, z))) out.push(new Vec3(x, y, z))
      }
      return out.sort((a, b) => o.distanceTo(a) - o.distanceTo(b)).slice(0, count)
    },
    async lookAt() {},
    async equip(item, dest) { if (dest === 'hand') bot.heldItem = item },
    stopDigging() {},
    async dig(b) {
      await Promise.resolve()
      dug.push(key(b.position.x, b.position.y, b.position.z))
      cells.set(key(b.position.x, b.position.y, b.position.z), 'air')
    },
    async placeBlock(ref, face) {
      await Promise.resolve()
      const at = ref.position.plus(face)
      placed.push({ at: key(at.x, at.y, at.z), item: bot.heldItem.name })
      cells.set(key(at.x, at.y, at.z), bot.heldItem.name)
    },
    pathfinder: { setGoal(g) { goal = g }, get goal() { return goal }, isMoving: () => false },
    chat() {},
    dug,
    placed,
  }
  return bot
}

async function flush() {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r))
}

describe('v2-facade scenario (vf8e.21)', () => {
  it('the proof skill compiles on both bodies with the scenario header', () => {
    const text = fs.readFileSync(path.join(DIR, 'gen_v2_facade.js'), 'utf8')
    for (const body of ['mineflayer', 'baritone']) {
      const { meta, skip } = skills.compile('gen_v2_facade.js', text, { BOT_BODY: body })
      assert.equal(skip, undefined, body)
      assert.equal(meta.name, 'gen_v2_facade')
      assert.equal(meta.kind, 'step')
    }
    const sc = JSON.parse(fs.readFileSync(path.join(DIR, 'scenario.json'), 'utf8'))
    assert.equal(sc[0].skill, 'gen_v2_facade')
    assert.equal(sc[0].kind, 'step')
  })

  it('the spots file parses and the walk starts 10+ blocks out', () => {
    const prev = process.env.REPLAY_SPOTS
    process.env.REPLAY_SPOTS = path.join(DIR, 'spots.json')
    let spots
    try {
      spots = require('../tools/stuck-replay.js').loadSpots()
    } finally {
      if (prev === undefined) delete process.env.REPLAY_SPOTS
      else process.env.REPLAY_SPOTS = prev
    }
    assert.equal(spots.length, 1)
    const s = spots[0]
    assert.equal(s.mode, 'order')
    assert.ok(s.verify, 'the world verdict watches the planting')
    const walk = Math.hypot(s.goal[0] - s.spawn[0], s.goal[2] - s.spawn[2])
    assert.ok(walk >= 10, `goto walks ${walk.toFixed(1)} blocks`)
  })

  it('the skill goes to the oak, digs leaves and plants the sapling', async () => {
    const text = fs.readFileSync(path.join(DIR, 'gen_v2_facade.js'), 'utf8')
    const { sk } = skills.compile('gen_v2_facade.js', text, { BOT_BODY: 'baritone' })
    sk.reset({ count: null, by: null })
    const bot = fakeBot()
    const st = { ticks: 0, hs: { busy: null, err: null } }
    const ctx = {}
    assert.equal(sk.tick(bot, ctx, st), 'running')
    assert.equal(bot.pathfinder.goal.constructor.name, 'GoalNear')
    assert.deepEqual({ x: bot.pathfinder.goal.x, y: bot.pathfinder.goal.y, z: bot.pathfinder.goal.z },
      { x: 68, y: 64, z: -193 })
    assert.ok(String(ctx.lastGoalKey).startsWith('skill:'), 'the goal rides a skill: key')
    bot.entity.position = new Vec3(67.5, 64, -192.5) // the walk lands
    let out = 'running'
    for (let i = 0; i < 60 && out === 'running'; i++) { out = sk.tick(bot, ctx, st); await flush() }
    assert.equal(out, 'done')
    assert.ok(bot.dug.length >= 1 && bot.dug.every((k) => LEAVES.map(([x, y, z]) => key(x, y, z)).includes(k)),
      `only leaves dug, got ${JSON.stringify(bot.dug)}`)
    assert.deepEqual(bot.placed, [{ at: key(69, 64, -193), item: 'oak_sapling' }])
  })

  it('unreadable leaves fail loudly instead of planting past the dig', async () => {
    const text = fs.readFileSync(path.join(DIR, 'gen_v2_facade.js'), 'utf8')
    const { sk } = skills.compile('gen_v2_facade.js', text, { BOT_BODY: 'baritone' })
    sk.reset({ count: null, by: null })
    const bot = fakeBot()
    const air = { name: 'air', position: new Vec3(0, 0, 0), boundingBox: 'empty' }
    const seen = bot.blockAt.bind(bot)
    bot.blockAt = (p) => (Math.floor(p.y) >= 64 ? air : seen(p)) // every leaf decayed
    const st = { ticks: 0, hs: { busy: null, err: null } }
    bot.entity.position = new Vec3(67.5, 64, -192.5) // already at the oak
    let out = 'running'
    for (let i = 0; i < 60 && out === 'running'; i++) { out = sk.tick(bot, {}, st); await flush() }
    assert.equal(out, 'failed:no-leaf-dig')
    assert.deepEqual(bot.placed, [], 'no sapling without a proven dig')
  })
})
