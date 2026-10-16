// idkcraft-neuc.54: bot.buildCells over baritone.build (FakeTransport = the mod).
'use strict'

const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const Vec3 = require('vec3')

const { BaritoneBot } = require('../src/bridge/index')
const { FakeTransport } = require('../src/bridge/transport')

const REGISTRY = require('minecraft-data')('26.1.2')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function makeBot(state = {}) {
  const transport = new FakeTransport({
    pos: { x: 100.5, y: 64, z: -39.5, yaw: 0, pitch: 0, onGround: true },
    blocks: {},
    fakeColumns: [{ cx: 6, cz: -3 }], // the (100, *, -40) build site
    inventory: [{ slot: 36, name: 'oak_planks', count: 64 }],
    ...state,
  })
  const bot = new BaritoneBot(transport, { Vec3, registry: REGISTRY, username: 'IdkBody' })
  return { transport, bot }
}

const CELLS = [
  { dx: 0, dy: 0, dz: 0, block: 'oak_planks' },
  { dx: 1, dy: 0, dz: 0, block: 'oak_planks' },
  { dx: 0, dy: 1, dz: 0, block: 'cobblestone' },
]

describe('bridge buildCells (idkcraft-neuc.54)', () => {
  let transport
  let bot
  beforeEach(async () => {
    ({ transport, bot } = makeBot({
      inventory: [
        { slot: 36, name: 'oak_planks', count: 64 },
        { slot: 37, name: 'cobblestone', count: 64 },
      ],
    }))
    await bot.start({ pollMs: 0 })
  })
  afterEach(async () => { await bot.stop() })

  it('lays the batch and resolves {placed, missing}; one wire call carries name/origin/cells', async () => {
    const res = await bot.buildCells('house', { x: 100, y: 64, z: -40 }, CELLS)
    assert.deepEqual(res, { placed: 3, missing: 0 })
    assert.equal(transport.state.buildLog.length, 1)
    assert.ok(transport.state.buildLog[0].name.startsWith('house#'), 'unique wire name per call')
    assert.deepEqual(transport.state.buildLog[0].origin, { x: 100, y: 64, z: -40 })
    assert.deepEqual(transport.state.buildLog[0].cells, CELLS)
    assert.equal(bot.blockAt(new Vec3(100, 64, -40)).name, 'oak_planks')
    assert.equal(bot.blockAt(new Vec3(101, 64, -40)).name, 'oak_planks')
    assert.equal(bot.blockAt(new Vec3(100, 65, -40)).name, 'cobblestone')
  })

  it('forbid crosses the wire', async () => {
    await bot.buildCells('house', { x: 100, y: 64, z: -40 }, CELLS.slice(0, 1), { forbid: ['oak_planks'] })
    assert.deepEqual(transport.state.buildLog[0].forbid, ['oak_planks'])
  })

  it('a same-class wood variant in hand lays the cell (substitutes)', async () => {
    await bot.stop()
    ;({ transport, bot } = makeBot({ inventory: [{ slot: 36, name: 'birch_planks', count: 64 }] }))
    await bot.start({ pollMs: 0 })
    const res = await bot.buildCells('house', { x: 100, y: 64, z: -40 }, CELLS.slice(0, 2))
    assert.deepEqual(res, { placed: 2, missing: 0 })
    assert.equal(bot.blockAt(new Vec3(100, 64, -40)).name, 'birch_planks')
  })

  it('material exhausted resolves missing so the FSM fetches (nothing hangs)', async () => {
    await bot.stop()
    ;({ transport, bot } = makeBot({ inventory: [{ slot: 36, name: 'oak_planks', count: 1 }] }))
    await bot.start({ pollMs: 0 })
    const res = await bot.buildCells('house', { x: 100, y: 64, z: -40 }, CELLS.slice(0, 2))
    assert.equal(res.placed, 1)
    assert.equal(res.missing, 1)
    assert.equal(bot.blockAt(new Vec3(101, 64, -40)).name, 'air')
  })

  it('a wedged builder with material on hand rejects build-stall', async () => {
    transport.state.buildScript = 'stall'
    bot._buildTiming = { stallMs: 30, watchMs: 5 }
    await assert.rejects(
      bot.buildCells('house', { x: 100, y: 64, z: -40 }, CELLS.slice(0, 1)),
      /^Error: build-stall$/,
    )
  })

  it('the stall verdict names the still-missing cells (r185 stall diagnosis)', async () => {
    transport.state.buildScript = 'stall'
    bot._buildTiming = { stallMs: 30, watchMs: 5 }
    const logged = []
    const origLog = console.log
    console.log = (m) => { logged.push(String(m)) }
    try {
      await assert.rejects(
        bot.buildCells('house', { x: 100, y: 64, z: -40 }, CELLS.slice(0, 1)),
        /^Error: build-stall$/,
      )
    } finally {
      console.log = origLog
    }
    const line = logged.find((m) => m.startsWith('build-stall house:'))
    assert.ok(line, `stall-site line logged, got: ${logged.join(' | ').slice(0, 200)}`)
    assert.ok(/100,64,-40:oak_planks/.test(line), `site reads back: ${line}`)
  })

  it('a silent builder with no material resolves missing (starved, not wedged)', async () => {
    await bot.stop()
    ;({ transport, bot } = makeBot({ inventory: [] }))
    await bot.start({ pollMs: 0 })
    bot._buildTiming = { stallMs: 30, watchMs: 5 }
    transport.state.buildScript = 'stall'
    const res = await bot.buildCells('house', { x: 100, y: 64, z: -40 }, CELLS.slice(0, 1))
    assert.deepEqual(res, { placed: 0, missing: 1 })
  })

  it('#stop cancels the build and settles the promise', async () => {
    transport.state.buildScript = 'stall'
    const p = bot.buildCells('house', { x: 100, y: 64, z: -40 }, CELLS)
    await sleep(10)
    await bot.stopBuild()
    // Our own #stop preempts our own build (round-3 core-2): rejects
    // build-preempted, never hangs, never settles starved.
    await assert.rejects(p, /^Error: build-preempted$/)
    assert.equal(bot._build, null)
  })

  it('a second build while one runs rejects build-busy', async () => {
    transport.state.buildScript = 'stall'
    bot._buildTiming = { stallMs: 30, watchMs: 5 }
    const p = bot.buildCells('house', { x: 100, y: 64, z: -40 }, CELLS.slice(0, 1))
    await assert.rejects(bot.buildCells('house', { x: 100, y: 64, z: -40 }, CELLS.slice(0, 1)), /^Error: build-busy$/)
    await assert.rejects(p, /^Error: build-stall$/)
  })

  it('bad params reject: empty cells, bad origin, bad cell', async () => {
    await assert.rejects(bot.buildCells('house', { x: 100, y: 64, z: -40 }, []), /cells must hold/)
    await assert.rejects(bot.buildCells('house', null, CELLS.slice(0, 1)), /bad origin/)
    await assert.rejects(bot.buildCells('house', { x: 100, y: 64, z: -40 }, [{ dx: 0, dy: 0 }]), /bad cell/)
    assert.equal(transport.state.buildLog, undefined) // nothing crossed the wire
  })

  it('a mod refusal (unknown block) rejects', async () => {
    transport.state.buildRefuse = 'unobtainium'
    await assert.rejects(bot.buildCells('house', { x: 100, y: 64, z: -40 }, CELLS.slice(0, 1)), /unknown block/)
  })

  it('starvation is exact-name: a variant on hand still starves (round-2 core-5)', async () => {
    await bot.stop()
    ;({ transport, bot } = makeBot({ inventory: [{ slot: 36, name: 'cobbled_deepslate', count: 64 }] }))
    await bot.start({ pollMs: 0 })
    bot._buildTiming = { stallMs: 30, watchMs: 5 }
    transport.state.buildScript = 'stall'
    // The builder cannot lay cobblestone from deepslate; that is starved
    // (fetch the named stone), not a wedged builder.
    const res = await bot.buildCells('castle', { x: 100, y: 64, z: -40 }, [{ dx: 0, dy: 0, dz: 0, block: 'cobblestone' }])
    assert.deepEqual(res, { placed: 0, missing: 1 })
  })

  it('a live builder is stopped by pathfinder.stop and by an in-reach goal (round-2 core-3)', async () => {
    transport.state.buildScript = 'stall'
    const p = bot.buildCells('house', { x: 100, y: 64, z: -40 }, CELLS.slice(0, 1))
    await sleep(10)
    assert.ok(bot._build !== null)
    bot.pathfinder.stop() // no goal live: only the builder keeps it live
    assert.equal(transport.state.baritone, '#stop')
    // Our own #stop preempts our own build (round-3 core-2): the final
    // rejects build-preempted instead of settling starved.
    await assert.rejects(p, /^Error: build-preempted$/)
    const q = bot.buildCells('house', { x: 100, y: 64, z: -40 }, CELLS.slice(0, 1))
    await sleep(10)
    // An already-satisfied goal sends no walk — but still stops the builder.
    bot.pathfinder.setGoal({ constructor: { name: 'GoalBlock' }, isEnd: () => true })
    assert.equal(transport.state.baritone, '#stop')
    await assert.rejects(q, /^Error: build-preempted$/)
  })

  it('wire names are unique per call; a foreign final never settles the live build (core-2)', async () => {
    transport.state.buildScript = 'stall'
    bot._buildTiming = { stallMs: 40, watchMs: 5 }
    const a = bot.buildCells('house', { x: 100, y: 64, z: -40 }, CELLS.slice(0, 1))
    // A replaced build's late final (a different wire name) lands mid-flight…
    transport.inject('baritone.event', { kind: 'build', name: `${transport.state.buildLog[0].name}-old`, placed: 0, missing: 1, active: false })
    await sleep(10)
    assert.ok(bot._build !== null, 'live build survives a foreign final')
    await assert.rejects(a, /^Error: build-stall$/) // …then the watchdog owns the verdict
    const b = bot.buildCells('house', { x: 100, y: 64, z: -40 }, CELLS.slice(0, 1))
    await assert.rejects(b, /^Error: build-stall$/)
    const names = transport.state.buildLog.map((e) => e.name)
    assert.equal(new Set(names).size, names.length, 'every call mints its own wire name')
  })
})
