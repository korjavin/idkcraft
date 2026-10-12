'use strict'

// Castle stairs part 2 (idkcraft-g0z.48): the 'castle upgrade' order relays
// a live complete v2 castle to v3 — phase body, fresh blocked keys, the
// residence kept — the body converts the step cells to stair blocks and the
// tail re-completes. (The bead says 72 steps; the v3 plan g0z.47 merged has
// 60 stairs cells — stone->stairs x51, planks->stairs x9 — and these tests
// pin the real count.)

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const Vec3 = require('vec3')
const blueprint = require('../src/castle')
const castleMod = require('../src/behaviours/castle')
const goal = require('../src/goal')
const memory = require('../src/memory')
const residence = require('../src/residence')
const stockpile = require('../src/behaviours/stockpile')
const { taskKind } = require('../src/task')
const { createTicker, handleChat } = require('../src/index')

const SITE = { x: 100, y: 64, z: 200 }
const k3 = (x, y, z) => `${x},${y},${z}`
const settle = async (n = 6) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)) }

// The rig's v2 paint (castle-replay SEED_PAINT, oak frame here — any log matches).
const V2_PAINT = { stone: 'cobblestone', planks: 'oak_planks', frame: 'oak_log', fence: 'oak_fence', door: 'oak_door', chest: 'chest', torch: 'torch' }

// A finished v2 castle as the world: every place cell laid, moat dug —
// and glazed (core-1): a lived-in complete castle has its decor, and the
// 44 panes sit on plan air cells the relay must never touch.
function paintV2(world) {
  for (const c of blueprint.absPlan(SITE, 0, 2).cells) {
    world.set(k3(c.x, c.y, c.z), blueprint.isPlaceTarget(c.kind) ? { name: V2_PAINT[c.kind], props: {} } : { name: 'air', props: {} })
  }
  for (const c of blueprint.decorPlan(SITE, 0, 2).cells) {
    if (c.kind === 'pane') world.set(k3(c.x, c.y, c.z), { name: 'glass_pane', props: {} })
  }
}
function paneCells() {
  return blueprint.decorPlan(SITE, 0, 2).cells.filter((c) => c.kind === 'pane')
}

function block(name, x, y, z, props) {
  return {
    name,
    position: new Vec3(x, y, z),
    boundingBox: name === 'air' ? 'empty' : 'block',
    getProperties: () => ({ ...(props || {}) }),
  }
}

function pos(x, y, z) {
  const p = { x, y, z, distanceTo: (q) => Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z), clone: () => pos(x, y, z), floored: () => pos(Math.floor(x), Math.floor(y), Math.floor(z)) }
  return p
}

function worldBot(world, { items = [], at = pos(SITE.x + 15.5, SITE.y, SITE.z + 13.5) } = {}) {
  return {
    username: 'IdkBot',
    chats: [],
    chat(m) { this.chats.push(String(m)) },
    entity: { position: at },
    inventory: { items: () => items },
    players: {},
    world: { getBlock: () => null },
    time: { timeOfDay: 6000, day: 1 },
    spawnPoint: pos(0, 64, 0),
    blockAt: (p) => {
      const k = k3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z))
      if (world.has(k)) {
        const e = world.get(k)
        return block(e.name, Math.floor(p.x), Math.floor(p.y), Math.floor(p.z), e.props)
      }
      const n = Math.floor(p.y) <= 63 ? 'dirt' : 'air'
      return block(n, Math.floor(p.x), Math.floor(p.y), Math.floor(p.z), {})
    },
    look: async () => {},
    lookAt: async () => {},
    equip: async () => {},
    dig: async (b) => { world.set(k3(b.position.x, b.position.y, b.position.z), { name: 'air', props: {} }) },
    _placeBlockWithOptions: async () => {},
    placeBlock: async () => {},
    pathfinder: { isMoving: () => false, setGoal() {}, stop() {}, goal: null, movements: { exclusionAreasBreak: [], exclusionAreasPlace: [] }, setMovements() {} },
    clearControlStates() {},
    on() {},
    once() {},
  }
}

function completeV2(extra) {
  return { site: { ...SITE }, rot: 0, blueprintVersion: 2, phase: 'complete', blocked: {}, parked: false, ...extra }
}

describe('upgrade diff (g0z.48)', () => {
  it('a laid v2 castle has exactly 60 undone v3 place cells, all stairs — plus 44 glazed air cells the relay skips', () => {
    const world = new Map()
    paintV2(world)
    const bot = worldBot(world)
    const v2 = blueprint.absPlan(SITE, 0, 2).cells
    const v3 = blueprint.absPlan(SITE, 0, 3).cells
    assert.equal(v2.length, v3.length)
    assert.ok(v2.every((c, i) => c.x === v3[i].x && c.y === v3[i].y && c.z === v3[i].z && c.idx === v3[i].idx), 'same coords, same order, same idx')
    assert.equal(paneCells().length, 44)
    const undone = v3.filter((c) => !castleMod.done(bot, c))
    const place = undone.filter((c) => blueprint.isPlaceTarget(c.kind))
    assert.equal(place.length, 60)
    assert.ok(place.every((c) => c.kind === 'stairs' && c.face), 'every undone place cell is a faced stairs cell')
    const air = undone.filter((c) => !blueprint.isPlaceTarget(c.kind))
    assert.equal(air.length, 44, 'the glazing reads undone — pick() must skip it, not clear it')
    assert.ok(air.every((c) => c.kind === 'air'))
    const from = {}
    for (const c of place) {
      const was = v2[c.idx].kind
      from[was] = (from[was] || 0) + 1
    }
    assert.deepEqual(from, { stone: 51, planks: 9 })
  })
})

describe('castle upgrade order (g0z.48)', () => {
  function upgradedBot() {
    const world = new Map()
    paintV2(world)
    const bot = worldBot(world, { items: [{ name: 'cobblestone_stairs', count: 60 }, { name: 'stone_pickaxe', count: 1 }, { name: 'stone_sword', count: 1 }] })
    bot.players = { Steve: { username: 'Steve', entity: { position: pos(SITE.x + 15.5, 64, SITE.z + 5.5), yaw: Math.PI } } }
    const ticker = createTicker({ bot, brain: null, tickMs: 10, idleTickMs: 10 })
    const st = completeV2({ residence: true, blocked: { '2:7': { tries: 2, until: Date.now() + 60000, why: 'no-ref' } } })
    bot._tickerCtx.castle = st
    bot._tickerCtx.home = residence.castleHome(st)
    bot._tickerCtx.castleCursor = 99 // the setCastle seam resets the scratch
    return { bot, ticker, ctx: bot._tickerCtx }
  }

  it("'castle upgrade' relays: version 3, phase body, fresh blocked, residence kept", () => {
    const { bot, ticker, ctx } = upgradedBot()
    const home = ctx.home
    handleChat(bot, ticker, 'Steve', 'castle upgrade')
    assert.equal(bot.chats.pop(), 'upgrading the castle to stair blocks: ~60 steps, I keep sleeping inside')
    const st = ctx.castle
    assert.equal(st.blueprintVersion, 3)
    assert.equal(st.phase, 'body')
    assert.deepEqual(st.blocked, {})
    assert.equal(st.residence, true)
    assert.equal(st.upgrade.from, 2)
    assert.ok(typeof st.upgrade.at === 'number')
    assert.equal(ctx.home, home, 'the home object stays')
    assert.equal(ctx.castleCursor, 0, 'executor scratch resets')
    assert.equal(ctx.work, true)
    assert.equal(taskKind(ctx), 'castle', 'the goal clock runs again')
  })

  it('guards: upgrading, unfinished and latest castles answer a one-liner and change nothing', () => {
    const { bot, ticker, ctx } = upgradedBot()
    // No castle at all: the existing line.
    ctx.castle = null
    handleChat(bot, ticker, 'Steve', 'castle upgrade')
    assert.equal(bot.chats.pop(), 'no castle yet — say build castle')
    // Unfinished: nothing moves.
    ctx.castle = completeV2({ phase: 'body' })
    handleChat(bot, ticker, 'Steve', 'castle upgrade')
    assert.equal(bot.chats.pop(), 'the castle is not finished yet — upgrade needs a complete castle')
    assert.deepEqual(ctx.castle, completeV2({ phase: 'body' }))
    // Already latest: nothing moves.
    ctx.castle = completeV2({ blueprintVersion: 3 })
    handleChat(bot, ticker, 'Steve', 'castle upgrade')
    assert.equal(bot.chats.pop(), 'the castle is already on the latest blueprint (v3)')
    assert.deepEqual(ctx.castle, completeV2({ blueprintVersion: 3 }))
    // Mid-upgrade: the second order is a no-op one-liner.
    ctx.castle = completeV2({ residence: true })
    handleChat(bot, ticker, 'Steve', 'castle upgrade')
    assert.match(bot.chats.pop(), /^upgrading the castle/)
    const snap = JSON.parse(JSON.stringify(ctx.castle))
    handleChat(bot, ticker, 'Steve', 'castle upgrade')
    assert.equal(bot.chats.pop(), 'already upgrading the castle — say castle for progress')
    assert.deepEqual(JSON.parse(JSON.stringify(ctx.castle)), snap)
    // And once re-completed, the latest line again.
    ctx.castle.phase = 'complete'
    delete ctx.castle.upgrade
    handleChat(bot, ticker, 'Steve', 'castle upgrade')
    assert.equal(bot.chats.pop(), 'the castle is already on the latest blueprint (v3)')
  })

  it("'castle' reports the upgrade with live remaining steps", () => {
    const { bot, ticker, ctx } = upgradedBot()
    handleChat(bot, ticker, 'Steve', 'castle upgrade')
    bot.chats.length = 0
    handleChat(bot, ticker, 'Steve', 'castle')
    const line = bot.chats.pop()
    assert.match(line, /now: castle upgrading v2 -> v3, 60 steps; blocked 0$/)
    assert.match(line, /stairs 0\/60/)
    assert.ok(line.length <= 256)
    // Three converted: the countdown follows.
    const world = new Map()
    paintV2(world)
    let n = 0
    for (const c of blueprint.absPlan(SITE, 0, 3).cells) {
      if (c.kind !== 'stairs' || n >= 3) continue
      n++
      world.set(k3(c.x, c.y, c.z), { name: 'cobblestone_stairs', props: { facing: blueprint.faceName(c.face), half: 'bottom' } })
    }
    const bot2 = worldBot(world)
    bot2.players = bot.players
    const t2 = createTicker({ bot: bot2, brain: null, tickMs: 10, idleTickMs: 10 })
    bot2._tickerCtx.castle = ctx.castle
    handleChat(bot2, t2, 'Steve', 'castle')
    assert.match(bot2.chats.pop(), /now: castle upgrading v2 -> v3, 57 steps; blocked 0$/)
    // Too far to count: the plan total stands.
    const far = worldBot(world)
    far.players = bot.players
    far.blockAt = () => null
    const t3 = createTicker({ bot: far, brain: null, tickMs: 10, idleTickMs: 10 })
    far._tickerCtx.castle = ctx.castle
    handleChat(far, t3, 'Steve', 'castle')
    assert.match(far.chats.pop(), /too far to count; now: castle upgrading v2 -> v3, 60 steps/)
  })

  it('the body picks a stairs cell as building — no prep, no hole', async () => {
    const world = new Map()
    paintV2(world)
    const st = completeV2({ residence: true })
    const first = blueprint.absPlan(SITE, 0, 3).cells.find((c) => c.kind === 'stairs')
    const bot = worldBot(world, {
      items: [{ name: 'cobblestone_stairs', count: 60 }, { name: 'stone_pickaxe', count: 1 }, { name: 'stone_sword', count: 1 }],
      at: pos(first.x + 0.5, first.y, first.z + 2.5), // beside the cell: standing on it sidesteps (g0z.47 loop)
    })
    bot.players = { Steve: { username: 'Steve', entity: { position: pos(SITE.x + 15.5, 64, SITE.z + 5.5), yaw: Math.PI } } }
    const ticker = createTicker({ bot, brain: null, tickMs: 10, idleTickMs: 10 })
    bot._tickerCtx.castle = st
    handleChat(bot, ticker, 'Steve', 'castle upgrade')
    bot.chats.length = 0
    const ctx = bot._tickerCtx
    castleMod(bot, ctx) // tick 1: the approach goal arms
    assert.equal(ctx.castle.phase, 'body', 'no prep phase')
    assert.equal(ctx.castle.status, 'building')
    assert.ok(!bot.chats.some((m) => m.startsWith('preparing the castle site')), 'no prep cuts, no site chat')
    castleMod(bot, ctx) // tick 2: the dig flight lands on the cell
    assert.ok(ctx.castleFlight, 'a flight started')
    assert.equal(ctx.castleFlight.cell.kind, 'stairs')
    const dug = { ...ctx.castleFlight.cell }
    await settle()
    assert.equal(world.get(k3(dug.x, dug.y, dug.z)).name, 'air', 'the v2 step clears')
    for (const p of paneCells()) assert.equal(world.get(k3(p.x, p.y, p.z)).name, 'glass_pane', 'glazing intact')
    assert.deepEqual(Object.keys(ctx.castle.blocked), [], 'no hole left behind')
  })

  it('the tail re-completes past the glazing: phase complete, upgrade cleared, no residence flap', () => {
    const world = new Map()
    paintV2(world)
    for (const c of blueprint.absPlan(SITE, 0, 3).cells) {
      if (c.kind !== 'stairs') continue
      world.set(k3(c.x, c.y, c.z), { name: 'cobblestone_stairs', props: { facing: blueprint.faceName(c.face), half: 'bottom' } })
    }
    const bot = worldBot(world)
    const ticker = createTicker({ bot, brain: null, tickMs: 10, idleTickMs: 10 })
    const st = completeV2({ blueprintVersion: 3, phase: 'body', residence: true, upgrade: { from: 2, at: Date.now() } })
    bot._tickerCtx.castle = st
    bot._tickerCtx.home = residence.castleHome(st)
    castleMod(bot, bot._tickerCtx)
    assert.equal(st.phase, 'complete')
    assert.equal(st.upgrade, undefined)
    assert.equal(st.status, 'complete')
    assert.equal(bot._tickerCtx.stepStatus, 'done')
    assert.ok(bot.chats.some((m) => m.startsWith('castle done at')))
    for (const p of paneCells()) assert.equal(world.get(k3(p.x, p.y, p.z)).name, 'glass_pane', 'glazing intact')
    assert.deepEqual(Object.keys(st.blocked), [], 'no pane hole')
    assert.equal(residence.wanted(bot._tickerCtx), undefined, 'same castle re-adopted: no flap')
    handleChat(bot, ticker, 'Steve', 'castle')
    assert.doesNotMatch(bot.chats.pop(), /upgrading/)
  })

  it("'castle upgrade' unparks a parked complete castle (core-3)", () => {
    const { bot, ticker, ctx } = upgradedBot()
    ctx.castle = completeV2({ residence: true, parked: true })
    handleChat(bot, ticker, 'Steve', 'castle upgrade')
    assert.match(bot.chats.pop(), /^upgrading the castle/)
    assert.equal(ctx.castle.parked, false)
  })

  it('the relay tail sweeps own box scaffold, never the owner cobble (revmux 02)', async () => {
    const world = new Map()
    paintV2(world)
    for (const c of blueprint.absPlan(SITE, 0, 3).cells) {
      if (c.kind !== 'stairs') continue
      world.set(k3(c.x, c.y, c.z), { name: 'cobblestone_stairs', props: { facing: blueprint.faceName(c.face), half: 'bottom' } })
    }
    // Two off-plan ground cobbles in box-scan order: the owner's first.
    const at = blueprint.absPlan(SITE, 0, 3).at
    const dt = blueprint.decorPlan(SITE, 0, 3).at
    const off = []
    for (let dx = 1; dx <= 3 && off.length < 2; dx++) {
      for (let dz = 12; dz <= 14 && off.length < 2; dz++) {
        const k = k3(SITE.x + dx, SITE.y, SITE.z + dz)
        if (!at.has(k) && !dt.has(k)) off.push({ x: SITE.x + dx, y: SITE.y, z: SITE.z + dz, k })
      }
    }
    assert.equal(off.length, 2)
    const [owner, own] = off
    world.set(owner.k, { name: 'cobblestone', props: {} })
    world.set(own.k, { name: 'cobblestone', props: {} })
    const bot = worldBot(world, {
      items: [{ name: 'stone_pickaxe', count: 1 }, { name: 'stone_sword', count: 1 }],
      at: pos(owner.x + 0.5, owner.y, owner.z + 2.5),
    })
    const ticker = createTicker({ bot, brain: null, tickMs: 10, idleTickMs: 10 })
    const st = completeV2({ blueprintVersion: 3, phase: 'body', residence: true, upgrade: { from: 2, at: Date.now() } })
    bot._tickerCtx.castle = st
    bot._tickerCtx.home = residence.castleHome(st)
    bot._tickerCtx.placedByBot = new Set([own.k])
    const ctx = bot._tickerCtx
    for (let i = 0; i < 8 && st.phase !== 'complete'; i++) { castleMod(bot, ctx); await settle() }
    assert.equal(st.phase, 'complete')
    assert.equal(world.get(owner.k).name, 'cobblestone', 'owner cobble survives the relay')
    assert.equal(world.get(own.k).name, 'air', 'own scaffold is swept')
  })

  it('the goal word is stairs-batch with a kit, and the castle step runs it', async () => {
    const { bot, ticker, ctx } = upgradedBot()
    handleChat(bot, ticker, 'Steve', 'castle upgrade')
    assert.equal(goal.goalFacts(bot, ctx).castle, 'stairs-batch')
    const r = await goal.decide(bot, ctx)
    assert.equal(r.action, 'castle')
  })

  it('stockpile keeps stairs packed during the upgrade, banks them past complete', () => {
    const items = [{ name: 'cobblestone_stairs', count: 60 }, { name: 'raw_iron', count: 20 }]
    const bot = worldBot(new Map(), { items })
    const open = stockpile.depositPlan(bot, { castle: completeV2({ blueprintVersion: 3, phase: 'body', upgrade: { from: 2, at: 1 } }) }).map((p) => p.name)
    assert.ok(!open.includes('cobblestone_stairs'), `banked ${open}`)
    assert.ok(open.includes('raw_iron'))
    const done = stockpile.depositPlan(bot, { castle: completeV2({ blueprintVersion: 3, phase: 'complete' }) }).map((p) => p.name)
    assert.ok(done.includes('cobblestone_stairs'), `kept ${done}`)
  })
})

describe('upgrade persistence (g0z.48)', () => {
  const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'g0z48-')), 'IdkBot.json')
  const bot = { username: 'IdkBot', spawnPoint: { x: 0, y: 64, z: 0 } }

  it('round-trips the upgrade record with the relayed castle', () => {
    const f = tmp()
    const st = completeV2({ blueprintVersion: 3, phase: 'body', residence: true, upgrade: { from: 2, at: 123456789 } })
    assert.equal(memory.save(bot, { castle: st }, f), true)
    const ctx = {}
    assert.equal(memory.restore(bot, ctx, f).castle, 1)
    assert.deepEqual(ctx.castle.upgrade, { from: 2, at: 123456789 })
    assert.equal(ctx.castle.blueprintVersion, 3)
    assert.equal(ctx.castle.phase, 'body')
    assert.equal(ctx.castle.residence, true)
  })

  it('a hand-edited upgrade record is sanitized', () => {
    const f = tmp()
    for (const upgrade of ['yes', { from: '2', at: 1 }, { from: 2 }, { from: 0, at: 1 }]) {
      fs.writeFileSync(f, JSON.stringify({ v: 1, world: memory.worldKey(bot), homes: [], castle: { ...completeV2(), upgrade } }))
      const ctx = {}
      memory.restore(bot, ctx, f)
      assert.equal(ctx.castle.upgrade, undefined, `dropped ${JSON.stringify(upgrade)}`)
    }
  })
})
