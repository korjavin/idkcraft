'use strict'

// Wood self-sufficiency (idkcraft-gc3j): when the bot fells a tree near home
// it replants a sapling on the stump cell, and far-search log hits are noted
// into resource memory (persisted like finds) so gather routes there when
// the near search is empty. The protected-log rule is untouched: owner
// pillars stay refused and never dug.

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
// revmux 01 core-6: stub the staged far search BEFORE gather loads —
// gather destructures scout at require time, so the wrappers must be in
// place first. Null ctl entries call through to the real search.
const scout = require('../src/behaviours/scout')
const origStartFar = scout.startFarSearch
const origStepFar = scout.stepFarSearch
const farCtl = { start: null, step: null }
scout.startFarSearch = (...a) => (farCtl.start ? farCtl.start(...a) : origStartFar(...a))
scout.stepFarSearch = (...a) => (farCtl.step ? farCtl.step(...a) : origStepFar(...a))
const gather = require('../src/behaviours/gather')
const resources = require('../src/resources')
const { NEED_LOGS } = require('../src/budget')

function pos(x, y, z) {
  const p = {
    x, y, z,
    distanceTo: (q) => Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z),
    clone() { return pos(p.x, p.y, p.z) },
    offset(ox, oy, oz) { return pos(p.x + ox, p.y + oy, p.z + oz) },
    floored() { return pos(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)) },
  }
  return p
}

const LOGREG = { oak_log: 17, oak_leaves: 18, stone: 1, dirt: 2 }
const FIND_MD = 48

function mockBot({ names = {}, items = [], syncHits = null, stubbornDig = false, onEquip = null } = {}) {
  const lines = []
  const blocksByName = {}
  for (const [name, id] of Object.entries(LOGREG)) blocksByName[name] = { id }
  const calls = { setGoal: 0, goals: [] }
  const bot = {
    lines,
    calls,
    players: { Owner: {} }, // owner online: no alone-idle leash on far memory
    entity: { position: pos(0, 64, 0) },
    registry: { blocksByName },
    _moving: false,
    _items: items,
    digCalls: 0,
    placeCalls: 0,
    equipped: null,
    pathfinder: {
      goal: null,
      setGoal: (goal) => { calls.setGoal++; calls.goals.push(goal); bot.pathfinder.goal = goal },
      isMoving: () => bot._moving,
    },
    inventory: { items: () => bot._items },
    findBlocks: (opts = {}) => {
      if (Array.isArray(syncHits)) return syncHits.map((c) => pos(c.x, c.y, c.z))
      // Live-world read like the real scan: loaded oak logs in range.
      const md = typeof opts.maxDistance === 'number' ? opts.maxDistance : FIND_MD
      const e = bot.entity.position
      const out = []
      for (const [k, n] of Object.entries(names)) {
        if (n !== 'oak_log') continue
        const [x, y, z] = k.split(',').map(Number)
        if (Math.hypot(x - e.x, y - e.y, z - e.z) <= md) out.push(pos(x, y, z))
      }
      return out.slice(0, typeof opts.count === 'number' ? opts.count : out.length)
    },
    blockAt(p) {
      if (!p || typeof p.x !== 'number') return null
      const n = names[`${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`]
      if (!n) return null // unloaded, like the real thing
      if (typeof p.floored !== 'function') throw new TypeError('pos.floored is not a function (plain g.pos)')
      return { name: n, position: pos(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)), boundingBox: 'block' }
    },
    canDigBlock(block) {
      if (!block || !block.position) return false
      const e = bot.entity.position
      const dx = block.position.x + 0.5 - e.x
      const dy = block.position.y + 0.5 - (e.y + 1.65)
      const dz = block.position.z + 0.5 - e.z
      return Math.hypot(dx, dy, dz) <= 5.1
    },
    dig: async (block) => {
      bot.digCalls++
      const bp = block && block.position
      if (bp && !stubbornDig) names[`${bp.x},${bp.y},${bp.z}`] = 'air' // chopped: loaded, stale
      bot._items.push({ name: 'oak_log', count: 1 })
    },
    equip: async (item) => {
      bot.equipped = item && item.name
      if (onEquip) await onEquip(item) // state can change across the await
    },
    placeBlock: async (ref, face) => {
      bot.placeCalls++
      const rp = ref && ref.position
      const cell = rp ? `${rp.x + face.x},${rp.y + face.y},${rp.z + face.z}` : null
      // A real placement consumes one of the EQUIPPED stack into the cell.
      const want = bot.equipped
      const i = bot._items.findIndex((it) => it && it.name === want)
      if (i === -1) throw new Error(`no ${want}`)
      bot._items.splice(i, 1)
      if (cell) names[cell] = want
    },
    chat(line) { lines.push(String(line)) },
  }
  return bot
}

// NEED_LOGS trunks at x0+2i: 3-log oaks with leaves over the crown (the
// tree-guard shape) on a dirt floor, so a replant lands beside the stump
// it replaces (qfus R1 never plants under standing wood).
// The atop leaf matters: once the lower logs are dug, the trunk-remnant
// rule only still reads the top as a tree with leaves above, so tops stay
// diggable while the trunk comes down.
function grove(names, x0, n = NEED_LOGS) {
  for (let x = x0 - 2; x < x0 + 2 * n + 2; x++) {
    for (let z = -2; z <= 2; z++) names[`${x},63,${z}`] = 'dirt'
  }
  for (let i = 0; i < n; i++) {
    const x = x0 + 2 * i
    names[`${x},64,0`] = 'oak_log'
    names[`${x},65,0`] = 'oak_log'
    names[`${x},66,0`] = 'oak_log'
    names[`${x},67,0`] = 'oak_leaves'
    names[`${x + 1},66,0`] = 'oak_leaves'
  }
  // A worked stand is loaded ground: dirt under, air around. Unset cells
  // read as unloaded (null) in the mock, which the vetted-spot rule
  // correctly refuses — so the stand's air is modelled, not assumed.
  for (let x = x0 - 3; x < x0 + 2 * n + 3; x++) {
    for (let y = 64; y <= 68; y++) {
      for (let z = -3; z <= 3; z++) {
        if (names[`${x},${y},${z}`] === undefined) names[`${x},${y},${z}`] = 'air'
      }
    }
  }
}

function homeCtx(over = {}) {
  return { lastGoalKey: '', stepStatus: 'running', home: { site: { x: 0, y: 64, z: 0 } }, ...over }
}

// Drive the step; teleport along gather walks, hold still for digs/pickup.
// onTick runs after gather each tick, before dig landings flush (lets a
// test steal the body mid-dig like fight does).
// Prod bodies fall: pickup walks onto the dug column (GoalBlock) and
// gravity drops the body back down the hollow trunk, so the next find
// sees bottoms first again. The mock teleports, so it settles the same
// way — otherwise it floats at canopy level, digs tops first, and the
// trunk-remnant rule protects the bottoms below (a mock-only pathology).
function settle(names, x, y, z) {
  let yy = y
  while (yy > 1 && names[`${x},${yy - 1},${z}`] === 'air') yy--
  return pos(x, yy, z)
}

async function drive(bot, ctx, names, maxTicks = 1200, onTick = null) {
  for (let i = 0; i < maxTicks; i++) {
    gather(bot, ctx, null, {})
    if (onTick) onTick(bot, ctx, i)
    await new Promise((resolve) => setImmediate(resolve)) // flush dig landings
    const g = ctx.gather
    if (!g || g.final) break
    const gk = ctx.lastGoalKey
    if (gk.startsWith('gather:') && g.pos) {
      bot.entity.position = settle(names, g.pos.x + 1, g.pos.y, g.pos.z)
      bot._moving = false
    } else if (gk.startsWith('gather-pickup') && g.pos) {
      bot.entity.position = settle(names, g.pos.x, g.pos.y, g.pos.z)
      bot._moving = false
    }
  }
  for (let i = 0; i < 30; i++) await new Promise((resolve) => setImmediate(resolve)) // land replant flights
}

describe('gather replant (idkcraft-gc3j)', () => {
  it('replants one pack sapling beside the first home stump and hauls to done', async () => {
    const names = {}
    grove(names, 10)
    const bot = mockBot({ names, items: [{ name: 'oak_sapling', count: 1 }] })
    const ctx = homeCtx()
    await drive(bot, ctx, names)
    assert.equal(ctx.stepStatus, 'done')
    assert.equal(ctx.gather.replanted, 1)
    assert.equal(bot.placeCalls, 1)
    assert.equal(bot.equipped, 'oak_sapling')
    // qfus R1: never under the standing trunk — the clear neighbour west
    // of the stump (the body stands east of it) takes the sapling.
    assert.equal(names['10,64,0'], 'air')
    assert.equal(names['9,64,0'], 'oak_sapling')
  })

  it('no sapling in pack: no placement, still done', async () => {
    const names = {}
    grove(names, 10)
    const bot = mockBot({ names, items: [] })
    const ctx = homeCtx()
    await drive(bot, ctx, names)
    assert.equal(ctx.stepStatus, 'done')
    assert.equal(bot.placeCalls, 0)
    assert.equal(ctx.gather.replanted || 0, 0)
  })

  it('a memory-routed stand past 160 is chopped AND replanted (qfus R1: no radius gate)', async () => {
    const names = {}
    grove(names, 200)
    const bot = mockBot({ names, items: [{ name: 'oak_sapling', count: 1 }] })
    const ctx = homeCtx()
    resources.noteSpots(ctx, [{ x: 200, y: 64, z: 0, name: 'oak_log' }], Date.now())
    await drive(bot, ctx, names)
    assert.equal(ctx.stepStatus, 'done')
    // The first felled bottom plants (one sapling, one attempt) wherever
    // it falls — the count never depended on the radius, now neither does
    // the plant. Never under the standing trunk: the clear neighbour west
    // of the stump (the body stands east of it) takes the sapling.
    assert.equal(bot.placeCalls, 1)
    assert.equal(ctx.gather.replanted, 1)
    assert.equal(bot._items.filter((it) => it.name === 'oak_sapling').length, 0)
    assert.equal(names['200,64,0'], 'air')
    assert.equal(names['199,64,0'], 'oak_sapling')
    // revmux 01 core-1: the hike out taught the stand — an un-dug upper
    // log of the last trunk is in memory now (arrival scan) ...
    assert.ok(memCells(ctx).has('224,65,0'), `stand noted: ${[...memCells(ctx)].slice(0, 8)}`)
    // ... while the dug stumps left it again (revmux 01 core-5).
    assert.ok(!memCells(ctx).has('200,64,0'), 'dug stump forgotten')
  })

  function memCells(ctx) {
    const out = new Set()
    try {
      for (const r of ctx.resources.items.values()) out.add(`${r.x},${r.y},${r.z}`)
    } catch (_) { /* empty */ }
    return out
  }

  it('a loaded-stale far point is forgotten, not re-walked', async () => {
    // revmux 01 core-5: the memory cell reads back as air (loaded) — the
    // retry must come from live ground, never the dead cell.
    const names = { '150,64,0': 'air' }
    grove(names, 200)
    const bot = mockBot({ names, items: [] })
    const ctx = homeCtx()
    resources.noteSpots(ctx, [
      { x: 150, y: 64, z: 0, name: 'oak_log' },
      { x: 200, y: 64, z: 0, name: 'oak_log' },
    ], Date.now())
    await drive(bot, ctx, names)
    assert.equal(ctx.stepStatus, 'done')
    assert.ok(!memCells(ctx).has('150,64,0'), 'stale far cell forgotten')
  })

  it('a stolen body keeps its sword: no replant after fight takes over', async () => {
    // revmux 01 core-4: fight re-issues the goal mid-dig — the landing must
    // not equip a sapling over the sword.
    const names = {}
    grove(names, 10)
    const bot = mockBot({ names, items: [{ name: 'oak_sapling', count: 1 }] })
    const ctx = homeCtx()
    let steals = 0
    await drive(bot, ctx, names, 1200, (b, c) => {
      // Every landing happens under a foreign goal: no landing may plant.
      if (c.gather && c.digInFlight) {
        steals++
        c.lastGoalKey = 'fight:zombie' // fight took the body mid-dig
      }
    })
    assert.ok(steals > 0, 'steals fired')
    assert.equal(ctx.stepStatus, 'done')
    assert.equal(bot.placeCalls, 0)
    assert.equal(bot.equipped, null)
  })

  it('a steal across the equip await aborts the place', async () => {
    // revmux verify #610 (codex P2): fight takes the body between equip
    // and place — the re-check pins the dig goal, so no sapling lands.
    const names = {}
    grove(names, 10)
    const bot = mockBot({
      names,
      items: [{ name: 'oak_sapling', count: 1 }],
      onEquip: async () => { ctx.lastGoalKey = 'fight:zombie' },
    })
    const ctx = homeCtx()
    await drive(bot, ctx, names)
    assert.equal(ctx.stepStatus, 'done')
    assert.equal(bot.equipped, 'oak_sapling')
    assert.equal(bot.placeCalls, 0)
  })

  it('a filled stump across the equip await is skipped, the neighbour takes it', async () => {
    // revmux verify #610 (codex P2): dirt lands in the first stump hole
    // between equip and place — the air re-check refuses onto the taken
    // cell, so the flight takes the next clear neighbour instead (later
    // stumps still plant, so the haul is unaffected).
    const names = {}
    grove(names, 10)
    let poisoned = false
    const bot = mockBot({
      names,
      items: [{ name: 'oak_sapling', count: 3 }],
      onEquip: async () => {
        if (!poisoned) {
          poisoned = true
          names['10,64,0'] = 'dirt'
        }
      },
    })
    const ctx = homeCtx()
    await drive(bot, ctx, names)
    assert.equal(ctx.stepStatus, 'done')
    assert.equal(names['10,64,0'], 'dirt', 'taken stump never planted over')
    assert.equal(names['9,64,0'], 'oak_sapling', 'clear neighbour takes it instead')
    assert.ok(poisoned, 'poison fired')
  })

  it('a dark-oak-only pack never replants (2x2-only sapling)', async () => {
    // revmux verify #610 (codex P2): a lone dark oak never grows — planting
    // it wastes the item, so the loop leaves the pack alone.
    const names = {}
    grove(names, 10)
    const bot = mockBot({ names, items: [{ name: 'dark_oak_sapling', count: 3 }] })
    const ctx = homeCtx()
    await drive(bot, ctx, names)
    assert.equal(ctx.stepStatus, 'done')
    assert.equal(bot.placeCalls, 0)
    assert.equal(bot._items.filter((it) => it.name === 'dark_oak_sapling').length, 1)
  })

  it('a mixed pack plants the lone-grower, never the dark oak', async () => {
    const names = {}
    grove(names, 10)
    const bot = mockBot({
      names,
      items: [{ name: 'dark_oak_sapling', count: 1 }, { name: 'oak_sapling', count: 1 }],
    })
    const ctx = homeCtx()
    await drive(bot, ctx, names)
    assert.equal(ctx.stepStatus, 'done')
    assert.equal(bot.equipped, 'oak_sapling')
    assert.ok(bot._items.some((it) => it.name === 'dark_oak_sapling'), 'dark oak stays packed')
  })

  it('an interrupted dig leaves the log standing: no replant onto wood', async () => {
    // revmux 01 core-4: the dig resolved without clearing the cell — the
    // stump is not air, so no sapling is placed onto the standing log.
    const names = {}
    grove(names, 10)
    const bot = mockBot({ names, items: [{ name: 'oak_sapling', count: 3 }], stubbornDig: true })
    const ctx = homeCtx()
    await drive(bot, ctx, names, 60)
    assert.ok(bot.digCalls > 0, 'digs happened')
    assert.equal(bot.placeCalls, 0)
  })

  it('the searchfar call site notes live hits and never the protected cell', async () => {
    // revmux 01 core-6: empty near search, a staged search whose shells hold
    // two live trunks and one leafless (protected) pillar. Deleting the
    // noteFarWood call, or an exclude without the guard, fails this.
    const names = {}
    for (const x of [100, 108]) {
      names[`${x},63,0`] = 'dirt'
      names[`${x},64,0`] = 'oak_log'
      names[`${x},65,0`] = 'oak_log'
      names[`${x},66,0`] = 'oak_log'
      names[`${x + 1},66,0`] = 'oak_leaves'
    }
    names['104,63,0'] = 'dirt'
    names['104,64,0'] = 'oak_log'
    names['104,65,0'] = 'oak_log' // no leaves: an owner pillar, protected
    const bot = mockBot({ names, items: [] })
    const ctx = homeCtx()
    const hits = new Map([
      ['100,64,0', { x: 100, y: 64, z: 0 }],
      ['104,64,0', { x: 104, y: 64, z: 0 }],
      ['108,64,0', { x: 108, y: 64, z: 0 }],
    ])
    farCtl.start = () => ({ hits, queue: [], at: 0, origin: { x: 0, y: 64, z: 0 }, edge: 160 })
    farCtl.step = () => ({ done: true, result: { position: pos(108, 64, 0), name: 'oak_log' }, edge: 160 })
    try {
      // Three ticks only: start, complete+note+commit — asserted before any
      // walk arrival scan can add its own cells.
      await drive(bot, ctx, names, 3)
    } finally {
      farCtl.start = null
      farCtl.step = null
    }
    assert.match(ctx.lastGoalKey, /^gather:108,64,0$/, 'walks the live far hit, not the pillar')
    assert.ok(memCells(ctx).has('100,64,0'), 'live far hit noted')
    assert.ok(memCells(ctx).has('108,64,0'), 'walk target noted')
    assert.ok(!memCells(ctx).has('104,64,0'), 'protected cell never noted')
  })

  it('a stump inside the house footprint is not replanted', async () => {
    const names = {}
    grove(names, 10)
    const bot = mockBot({ names, items: [{ name: 'oak_sapling', count: 1 }] })
    const ctx = homeCtx({
      home: {
        site: { x: 0, y: 64, z: 0 },
        interior: { min: { x: 8, y: 63, z: -2 }, max: { x: 40, y: 67, z: 2 } },
      },
    })
    await drive(bot, ctx, names)
    assert.equal(ctx.stepStatus, 'done')
    assert.equal(bot.placeCalls, 0)
  })

  it('a leafless owner pillar stays protected: never dug, never planted', async () => {
    // revmux 02 core-2: the pillar is unloaded at commit time (a memory
    // stand past view) and streams in as an owner build by the dig — the
    // dig-deny forgets it, so no later run walks it again.
    const names = { '200,63,0': 'dirt', '200,64,0': 'oak_log', '200,65,0': 'oak_log' }
    const bot = mockBot({ names, items: [{ name: 'oak_sapling', count: 1 }] })
    const rawAt = bot.blockAt
    bot.blockAt = (p) => (
      Math.abs(Math.floor(p.x) - bot.entity.position.x) > 100 ? null : rawAt(p)
    )
    const ctx = homeCtx()
    resources.noteSpots(ctx, [{ x: 200, y: 64, z: 0, name: 'oak_log' }], Date.now())
    await drive(bot, ctx, names, 60)
    assert.equal(bot.digCalls, 0)
    assert.equal(bot.placeCalls, 0)
    assert.ok(!memCells(ctx).has('200,64,0'), 'protected cell forgotten on deny')
  })
})

describe('noteFarWood (idkcraft-gc3j)', () => {
  function farBot(cells) {
    return {
      entity: { position: pos(0, 64, 0) },
      blockAt(p) {
        const n = cells[`${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`]
        return n ? { name: n } : null
      },
    }
  }

  it('notes the nearest live logs up to the cap, skipping stale and stone cells', () => {
    const cells = {}
    for (let i = 0; i < 20; i++) cells[`${100 + i},64,0`] = 'oak_log'
    cells['105,64,0'] = 'air' // chopped since the scan: stale, skipped
    cells['110,64,0'] = 'stone' // not wood: skipped
    const bot = farBot(cells)
    const ctx = {}
    const hits = new Map()
    for (let i = 0; i < 20; i++) hits.set(`${100 + i},64,0`, { x: 100 + i, y: 64, z: 0 })
    const n = gather.noteFarWood(bot, ctx, { x: 0, y: 64, z: 0 }, { hits }, () => false)
    assert.equal(n, 16)
    assert.equal(resources.count(ctx), 16)
    const near = resources.nearest(ctx, { x: 0, y: 64, z: 0 }, ['oak_log'])
    assert.equal(near.x, 100)
  })

  it('an excluded stand is never remembered', () => {
    const cells = { '100,64,0': 'oak_log' }
    const bot = farBot(cells)
    const ctx = {}
    const hits = new Map([['100,64,0', { x: 100, y: 64, z: 0 }]])
    const n = gather.noteFarWood(bot, ctx, { x: 0, y: 64, z: 0 }, { hits }, () => true)
    assert.equal(n, 0)
    assert.equal(resources.count(ctx), 0)
  })
})
