'use strict'

// Bead idkcraft-neuc.42: the v2 rig ended two runs at 129/130 with one
// failed:skipped-cells hole each. s1b: wall cell 54,63,-33 over a dip
// re-skipped no-ref on the last-pass retry, because its references (the
// next wall cell and the cell above) were holes retried AFTER it. s3: dirt
// appeared in wall cell 51,64,-28 (the Baritone body's untracked scaffold)
// and the place flow refused it 3x. Also the rest line read 'need
// table/door item' with only holes left.

const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const goal = require('../src/goal')
const build = require('../src/behaviours/build')

function pos(x, y, z) {
  const p = { x, y, z, distanceTo: (q) => Math.hypot(x - q.x, y - q.y, z - q.z) }
  p.clone = () => pos(p.x, p.y, p.z)
  p.floored = () => pos(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z))
  return p
}

function makeWorld() {
  const cells = new Map()
  const key = (x, y, z) => `${Math.floor(x)},${Math.floor(y)},${Math.floor(z)}`
  return {
    set(x, y, z, name) { cells.set(key(x, y, z), name) },
    get(x, y, z) { return cells.get(key(x, y, z)) },
    blockAt(p) {
      const fx = Math.floor(p.x)
      const fy = Math.floor(p.y)
      const fz = Math.floor(p.z)
      const k = key(fx, fy, fz)
      const name = cells.has(k) ? cells.get(k) : (fy <= 63 ? 'dirt' : 'air')
      return { name, boundingBox: name === 'air' ? 'empty' : 'block', position: { x: fx, y: fy, z: fz } }
    },
  }
}

// A server-like body: placement into an occupied cell is refused.
function mockBot(world, at) {
  const calls = { digs: [] }
  const bot = {
    calls,
    chats: [],
    spawnPoint: pos(0, 64, 0),
    entity: { position: at },
    world: { getBlock: () => null },
    players: {},
    inventory: { items: () => [{ name: 'oak_planks', count: 40 }] },
    blockAt: (p) => world.blockAt(p),
    findBlocks: () => [],
    pathfinder: { isMoving: () => false, setGoal: () => {} },
    equip: async () => {},
    dig: async (b) => {
      calls.digs.push(b.name)
      world.set(b.position.x, b.position.y, b.position.z, 'air')
    },
    placeBlock: async (ref, face) => {
      const p = ref.position
      const x = p.x + face.x
      const y = p.y + face.y
      const z = p.z + face.z
      const cur = world.blockAt({ x, y, z }).name
      if (cur !== 'air') throw new Error(`refused: still ${cur}`)
      world.set(x, y, z, 'oak_planks')
    },
    chat: (m) => { bot.chats.push(String(m)) },
  }
  return bot
}

function paintHouse(world, home, leaveOut = []) {
  const skip = new Set(leaveOut)
  build.blueprintFor(home).forEach((cell, i) => {
    if (skip.has(i) || cell.kind === 'clear') return
    const name = cell.kind === 'table' ? 'crafting_table' : cell.kind === 'door' ? 'oak_door' : 'oak_planks'
    world.set(home.site.x + cell.dx, home.site.y + cell.dy, home.site.z + cell.dz, name)
  })
}

const settle = async (n = 5) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)) }
const cellIdx = (plan, dx, dy, dz) => plan.findIndex((c) => c.kind === 'planks' && c.dx === dx && c.dy === dy && c.dz === dz)

async function drive(bot, ctx) {
  for (let i = 0; i < 80 && ctx.stepStatus !== 'done' && ctx.stepStatus !== 'failed:skipped-cells'; i++) {
    build(bot, ctx, null, null)
    await settle()
  }
}

describe('neuc.42 single wall holes close', () => {
  let origLog
  let lines
  beforeEach(() => { origLog = console.log; lines = []; console.log = (l) => { lines.push(String(l)) } })
  afterEach(() => { console.log = origLog })

  it('s1b: a hole whose refs are later holes lays on a second retry pass', async () => {
    const world = makeWorld()
    const bot = mockBot(world, pos(10.5, 64, -1.5))
    const home = goal.siteFor(bot, pos(0, 64, 0))
    assert.deepEqual(home.site, { x: 6, y: 64, z: 0 })
    const plan = build.blueprintFor(home)
    const a = cellIdx(plan, 4, 0, 0) // beside the doorway: no ref but B or C
    const b = cellIdx(plan, 5, 0, 0)
    const c = cellIdx(plan, 4, 1, 0)
    assert.ok(a >= 0 && b > a && c > b)
    paintHouse(world, home, [a, b, c])
    world.set(10, 63, 0, 'air') // the dip under A and B
    world.set(11, 63, 0, 'air')
    const t = Date.now()
    const ctx = { home, step: 'build', stepStatus: 'running', buildSkip: [a, b, c], buildSkipAt: { [a]: t, [b]: t, [c]: t }, buildLastProgressLog: Date.now() }
    await drive(bot, ctx)
    assert.ok(lines.some((l) => l === 'build skip 10 64 0 after 3 refusals (no-ref)'), lines.join(' | '))
    assert.equal(lines.filter((l) => l.startsWith('build holes: retrying')).length, 2, lines.join(' | '))
    assert.equal(ctx.stepStatus, 'done', lines.join(' | '))
    assert.equal(world.get(10, 64, 0), 'oak_planks')
  })

  it('a pass that closes nothing ends the retries (bounded)', async () => {
    const world = makeWorld()
    const bot = mockBot(world, pos(10.5, 64, -1.5))
    const home = goal.siteFor(bot, pos(0, 64, 0))
    const plan = build.blueprintFor(home)
    const a = cellIdx(plan, 4, 0, 0)
    paintHouse(world, home, [a])
    bot.placeBlock = async () => { throw new Error('refused') }
    const ctx = { home, step: 'build', stepStatus: 'running', buildSkip: [a], buildSkipAt: { [a]: Date.now() }, buildLastProgressLog: Date.now() }
    await drive(bot, ctx)
    assert.equal(ctx.stepStatus, 'failed:skipped-cells')
    assert.equal(lines.filter((l) => l.startsWith('build holes: retrying')).length, 1)
  })

  it('s3: foreign dirt in a wall cell is dug and planked, not skipped', async () => {
    const world = makeWorld()
    const bot = mockBot(world, pos(7.5, 64, 6.5))
    const home = goal.siteFor(bot, pos(0, 64, 0))
    const plan = build.blueprintFor(home)
    const w = cellIdx(plan, 1, 1, 5)
    paintHouse(world, home, [w])
    world.set(7, 65, 5, 'dirt') // not ours: the bridge body's scaffold
    const ctx = { home, step: 'build', stepStatus: 'running', buildSkip: [], buildLastProgressLog: Date.now() }
    await drive(bot, ctx)
    assert.equal(ctx.stepStatus, 'done', lines.join(' | '))
    assert.deepEqual(bot.calls.digs, ['dirt'])
    assert.equal(world.get(7, 65, 5), 'oak_planks')
  })

  it('rest line: only holes left names the holes, not a table/door item', () => {
    const world = makeWorld()
    const bot = mockBot(world, pos(10.5, 64, -1.5))
    const home = goal.siteFor(bot, pos(0, 64, 0))
    const plan = build.blueprintFor(home)
    const a = cellIdx(plan, 4, 0, 0)
    paintHouse(world, home, [a])
    const ctx = { home, buildSkip: [a] }
    const facts = { time: 'day', home: 'site', inside: 'no', planks: 40, maxPlanks: 40, table: 0, door: 0, tablePlaced: true }
    assert.equal(goal.stepWhy('build', facts, bot, ctx, ''), 'build: only skipped cells left')
  })
})
