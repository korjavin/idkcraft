'use strict'

// idkcraft-akze: the torch repair at a far castle smelts its charcoal in a
// field furnace on site. Before the fix the rung failed fast as no-torch
// away from the home furnace (TORCH_HOME_DIST) while the bot was pinned at
// the castle by the open torch demand — repair stuck at 18/22 and the sweep
// never ran. Plus: the repair seed's own knockdown is not regress.

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const blueprint = require('../src/castle')
const castleMod = require('../src/behaviours/castle')
const fetch = require('../src/behaviours/castlefetch')

const SITE = { x: 285, y: 63, z: 287 }
const HOME = { x: 407, y: 63, z: 289 } // the tidy start house, 100+ off

function key(x, y, z) { return `${x},${y},${z}` }

function makeWorld() {
  const cells = new Map()
  return {
    get(x, y, z) { return cells.has(key(x, y, z)) ? cells.get(key(x, y, z)) : (y <= 62 ? 'dirt' : 'air') },
    set(x, y, z, name) { cells.set(key(x, y, z), name) },
  }
}

function makeBot(world, items, at) {
  const bot = {
    entity: { position: { x: at.x, y: at.y, z: at.z } },
    inventory: { items: () => items },
    registry: {
      itemsByName: {
        oak_log: { id: 1 }, oak_planks: { id: 2 }, furnace: { id: 3 }, coal: { id: 4 }, cobblestone: { id: 5 },
      },
    },
    blockAt: (p) => {
      const x = Math.floor(p.x)
      const y = Math.floor(p.y)
      const z = Math.floor(p.z)
      const name = world.get(x, y, z)
      return { name, position: { x, y, z }, boundingBox: name === 'air' || name === 'cave_air' ? 'empty' : 'block' }
    },
    equip: async () => {},
    closeWindow: async () => {},
    placeBlock: async (ref, face) => {
      world.set(ref.position.x + face.x, ref.position.y + face.y, ref.position.z + face.z, 'furnace')
    },
    dig: async (block) => {
      world.set(Math.floor(block.position.x), Math.floor(block.position.y), Math.floor(block.position.z), 'air')
    },
    openFurnace: async (block) => {
      assert.equal(block.name, 'furnace')
      const st = { input: null, fuel: null, taken: false }
      const take = (name, n) => {
        const it = items.find((i) => i.name === name)
        assert.ok(it && it.count >= n, `want ${n}x ${name}`)
        it.count -= n
        // Prod drops emptied stacks (mineflayer clears the slot): a consumed
        // last log reads absent, which is what the field-first routing covers.
        for (let k = items.length - 1; k >= 0; k--) if (items[k].count <= 0) items.splice(k, 1)
      }
      return {
        inputItem: () => (st.input ? { name: st.input, count: 1 } : null),
        fuelItem: () => (st.fuel ? { name: st.fuel, count: 1 } : null),
        outputItem: () => (st.input && st.fuel && !st.taken ? { name: 'charcoal', count: 1 } : null),
        putInput: async (id, meta, n) => { assert.equal(id, 1); take('oak_log', n); st.input = 'oak_log' },
        putFuel: async (id, meta, n) => {
          if (id === 2) { take('oak_planks', n); st.fuel = 'oak_planks' }
          else { assert.equal(id, 4); take('coal', n); st.fuel = 'coal' }
        },
        takeOutput: async () => {
          st.taken = true
          items.push({ name: 'charcoal', count: 1 })
          return { name: 'charcoal', count: 1 }
        },
      }
    },
  }
  return bot
}

function makeCtx() {
  return {
    bring: null,
    furnace: null,
    castle: { site: { ...SITE }, rot: 0, blueprintVersion: 2 },
    home: { site: { ...HOME } },
  }
}

// Pump torchTick the way the leg does: craftTick runs before it every tick
// and consumes a ready charcoal, so a completed field smelt must not see a
// second torchTick before the simulated craft takes the charcoal.
async function pump(bot, ctx, f, d, items, maxTicks = 1000) {
  for (let i = 0; i < maxTicks; i++) {
    if (f.craftOut === false && f.field == null) {
      const charcoal = items.find((x) => x.name === 'charcoal')
      if (charcoal && charcoal.count > 0) {
        charcoal.count -= 1 // craftTick's torch craft, simulated
        return true
      }
    }
    fetch.torchTick(bot, ctx, f, d, null, null)
    await new Promise((r) => setTimeout(r, 10))
  }
  return false
}

describe('castlefetch torch field furnace (idkcraft-akze)', () => {
  it('far from home smelts charcoal on site, breaks the furnace, and re-arms the craft', async () => {
    const world = makeWorld()
    const at = { x: SITE.x + 15, y: SITE.y, z: SITE.z + 13 }
    const items = [
      { name: 'oak_log', count: 10 },
      { name: 'cobblestone', count: 64 },
      { name: 'oak_planks', count: 32 },
      { name: 'stone_pickaxe', count: 1 },
    ]
    const bot = makeBot(world, items, at)
    const ctx = makeCtx()
    const realCraft = fetch.deps.craftItem
    fetch.deps.craftItem = () => {
      items.push({ name: 'furnace', count: 1 })
      return { done: true }
    }
    try {
      const f = {}
      const d = { kind: 'torch', short: 3 }
      const done = await pump(bot, ctx, f, d, items)
      assert.equal(done, true, 'the field smelt completes and re-arms craftTick')
      const log = items.find((i) => i.name === 'oak_log')
      assert.equal(log && log.count, 9, 'one log smelted to charcoal (craftTick consumed it): ' + JSON.stringify(items))
      assert.equal(ctx.stepStatus, undefined, 'the leg never fails no-torch')
      // The furnace is gone: no extra block left at the castle.
      let standing = 0
      for (let dx = -2; dx <= 2; dx++) {
        for (let dz = -2; dz <= 2; dz++) {
          if (world.get(at.x + dx, at.y, at.z + dz) === 'furnace') standing++
        }
      }
      assert.equal(standing, 0, 'the field furnace is dug up after the smelt')
    } finally {
      fetch.deps.craftItem = realCraft
    }
  })

  it('a smelt give-up still digs the furnace up (no standing extras)', async () => {
    const world = makeWorld()
    const at = { x: SITE.x + 15, y: SITE.y, z: SITE.z + 13 }
    const items = [
      { name: 'oak_log', count: 10 },
      { name: 'cobblestone', count: 64 },
      { name: 'oak_planks', count: 32 },
      { name: 'stone_pickaxe', count: 1 },
    ]
    const bot = makeBot(world, items, at)
    bot.openFurnace = async () => { throw new Error('window refused') } // the mod never opens
    const ctx = makeCtx()
    const realCraft = fetch.deps.craftItem
    fetch.deps.craftItem = () => {
      items.push({ name: 'furnace', count: 1 })
      return { done: true }
    }
    try {
      const f = {}
      const d = { kind: 'torch', short: 3 }
      for (let i = 0; i < 60; i++) {
        fetch.torchTick(bot, ctx, f, d, null, null)
        await new Promise((r) => setTimeout(r, 10))
      }
      let standing = 0
      for (let dx = -2; dx <= 2; dx++) {
        for (let dz = -2; dz <= 2; dz++) {
          if (world.get(at.x + dx, at.y, at.z + dz) === 'furnace') standing++
        }
      }
      assert.equal(standing, 0, 'every gave-up furnace is dug up, none stand')
      assert.equal(ctx.stepStatus, undefined, 'the leg keeps failing no-torch, never a new failed: string')
      // Poisoned: the next tick fails instead of starting a fresh field cycle.
      assert.equal(fetch.torchTick(bot, ctx, f, { kind: 'torch', short: 3 }, null, null), false)
    } finally {
      fetch.deps.craftItem = realCraft
    }
  })

  it('one log smelts and the break still runs with an empty pack', async () => {
    const world = makeWorld()
    const at = { x: SITE.x + 15, y: SITE.y, z: SITE.z + 13 }
    const items = [
      { name: 'oak_log', count: 1 },
      { name: 'cobblestone', count: 64 },
      { name: 'oak_planks', count: 32 },
      { name: 'stone_pickaxe', count: 1 },
    ]
    const bot = makeBot(world, items, at)
    const ctx = makeCtx()
    const realCraft = fetch.deps.craftItem
    fetch.deps.craftItem = () => {
      items.push({ name: 'furnace', count: 1 })
      return { done: true }
    }
    try {
      const f = {}
      const d = { kind: 'torch', short: 3 }
      const done = await pump(bot, ctx, f, d, items)
      assert.equal(done, true, 'the single-log smelt completes and re-arms craftTick')
      const log = items.find((i) => i.name === 'oak_log')
      assert.ok(!log || log.count === 0, 'the only log went into the furnace: ' + JSON.stringify(items))
      let standing = 0
      for (let dx = -2; dx <= 2; dx++) {
        for (let dz = -2; dz <= 2; dz++) {
          if (world.get(at.x + dx, at.y, at.z + dz) === 'furnace') standing++
        }
      }
      assert.equal(standing, 0, 'the furnace is dug up even with the pack log gone')
      assert.equal(ctx.stepStatus, undefined, 'the leg never fails')
    } finally {
      fetch.deps.craftItem = realCraft
    }
  })

  it('an orphaned field furnace is reclaimed, not stacked', async () => {
    const world = makeWorld()
    const at = { x: SITE.x + 15, y: SITE.y, z: SITE.z + 13 }
    world.set(at.x + 1, at.y, at.z, 'furnace') // left standing by a step switch
    const items = [
      { name: 'oak_log', count: 10 },
      { name: 'cobblestone', count: 64 },
      { name: 'oak_planks', count: 32 },
      { name: 'stone_pickaxe', count: 1 },
    ]
    const bot = makeBot(world, items, at)
    const ctx = makeCtx()
    ctx.castleFieldFurnace = { x: at.x + 1, y: at.y, z: at.z }
    const realCraft = fetch.deps.craftItem
    let crafted = 0
    fetch.deps.craftItem = () => {
      crafted++
      items.push({ name: 'furnace', count: 1 })
      return { done: true }
    }
    try {
      const f = {}
      const d = { kind: 'torch', short: 3 }
      for (let i = 0; i < 40; i++) {
        fetch.torchTick(bot, ctx, f, d, null, null)
        await new Promise((r) => setTimeout(r, 10))
        if (ctx.castleFieldFurnace == null && world.get(at.x + 1, at.y, at.z) !== 'furnace') break
      }
      assert.equal(world.get(at.x + 1, at.y, at.z) !== 'furnace', true, 'the orphan is dug up first')
      assert.equal(ctx.castleFieldFurnace, null, 'the record clears')
    } finally {
      fetch.deps.craftItem = realCraft
    }
  })

  it('one log and no other fuel fails fast without burning the log', () => {
    const world = makeWorld()
    const at = { x: SITE.x + 15, y: SITE.y, z: SITE.z + 13 }
    const items = [{ name: 'oak_log', count: 1 }, { name: 'stick', count: 4 }]
    const bot = makeBot(world, items, at)
    const ctx = makeCtx()
    const f = {}
    const r = fetch.torchTick(bot, ctx, f, { kind: 'torch', short: 3 }, null, null)
    assert.equal(r, false, 'no-torch: the only log is input, fuel must come from elsewhere')
    assert.equal(items.find((i) => i.name === 'oak_log').count, 1, 'the log is not burned into planks')
    assert.equal(world.get(at.x + 1, at.y, at.z) !== 'furnace', true, 'no furnace is placed for a smelt that cannot run')
  })

  it('no safe cell beside the body falls back to no-torch (the old path)', () => {
    const world = makeWorld()
    const at = { x: SITE.x + 15, y: SITE.y, z: SITE.z + 13 }
    // Every neighbour reads solid: no air cell to place on.
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) world.set(at.x + dx, at.y, at.z + dz, 'dirt')
    const items = [
      { name: 'oak_log', count: 10 },
      { name: 'cobblestone', count: 64 },
      { name: 'oak_planks', count: 32 },
    ]
    const bot = makeBot(world, items, at)
    const ctx = makeCtx()
    const f = {}
    const r = fetch.torchTick(bot, ctx, f, { kind: 'torch', short: 3 }, null, null)
    assert.equal(r, false, 'returns false so the leg fails no-torch as before')
  })

  it('a seed knock across an away gap re-baselines, logs no regress', () => {
    const cells = [
      { kind: 'fence', x: 10, y: 64, z: 20, idx: 1 },
      { kind: 'fence', x: 11, y: 64, z: 20, idx: 2 },
    ]
    const world = new Map([['10,64,20', 'oak_fence'], ['11,64,20', 'oak_fence']])
    const bot = {
      blockAt: (p) => {
        const k = `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`
        const name = world.has(k) ? world.get(k) : 'air'
        return { name, position: { x: 0, y: 0, z: 0 }, boundingBox: name === 'air' ? 'empty' : 'block' }
      },
    }
    const st = { site: { ...SITE }, rot: 0, blueprintVersion: 2, progress: null }
    const ctx = {}
    const lines = []
    const realLog = console.log
    console.log = (m, ...a) => { lines.push(String(m)) }
    try {
      castleMod.progress(bot, st, cells, ctx) // 2/2, high-water 2
      world.set('11,64,20', 'air') // the seed knocks while the bot is away
      ctx.castleDug.lastScan = Date.now() - 10 * 60 * 1000 // a 10-min away gap
      castleMod.progress(bot, st, cells, ctx) // 1/2 — re-baselines, no line
    } finally {
      console.log = realLog
    }
    assert.ok(!lines.some((l) => l.startsWith('castle regress ')), 'no regress line: ' + JSON.stringify(lines))
    assert.equal(st.progress.done, 1)
  })

  it('a break between loaded scans still names itself', () => {
    const cells = [
      { kind: 'fence', x: 10, y: 64, z: 20, idx: 1 },
      { kind: 'fence', x: 11, y: 64, z: 20, idx: 2 },
    ]
    const world = new Map([['10,64,20', 'oak_fence'], ['11,64,20', 'oak_fence']])
    const bot = {
      blockAt: (p) => {
        const k = `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`
        const name = world.has(k) ? world.get(k) : 'air'
        return { name, position: { x: 0, y: 0, z: 0 }, boundingBox: name === 'air' ? 'empty' : 'block' }
      },
    }
    const st = { site: { ...SITE }, rot: 0, blueprintVersion: 2, progress: null }
    const ctx = {}
    const lines = []
    const realLog = console.log
    console.log = (m, ...a) => { lines.push(String(m)) }
    try {
      castleMod.progress(bot, st, cells, ctx) // 2/2, high-water 2
      world.set('11,64,20', 'air') // a cell breaks while loaded
      castleMod.progress(bot, st, cells, ctx) // 1/2, consecutive scan: names it
    } finally {
      console.log = realLog
    }
    assert.ok(lines.some((l) => l.startsWith('castle regress ') && l.includes('fence@11,64,20')), 'names the cell: ' + JSON.stringify(lines))
  })

  it('fieldSpot never offers a castle plan or decor cell', () => {
    const world = makeWorld()
    const cells = blueprint.absPlan(SITE, 0, 2).cells
    assert.ok(cells.length > 0)
    const plan = cells[0]
    // Stand beside the first plan cell with solid footing and air around.
    const bot = makeBot(world, [], { x: plan.x - 1, y: plan.y, z: plan.z })
    const ctx = makeCtx()
    const spot = fetch.fieldSpot(bot, ctx)
    if (spot) {
      const at = blueprint.absPlan(SITE, 0, 2).at
      const dt = blueprint.decorPlan(SITE, 0, 2).at
      assert.ok(!at.has(`${spot.x},${spot.y},${spot.z}`), 'not a plan cell')
      assert.ok(!dt.has(`${spot.x},${spot.y},${spot.z}`), 'not a decor cell')
    }
    // The plan cell itself is never offered even though it reads air.
    for (let i = 0; i < 4; i++) {
      const b = makeBot(world, [], { x: plan.x - 1, y: plan.y, z: plan.z })
      const s = fetch.fieldSpot(b, ctx)
      if (s) assert.notEqual(`${s.x},${s.y},${s.z}`, `${plan.x},${plan.y},${plan.z}`)
    }
  })
})
