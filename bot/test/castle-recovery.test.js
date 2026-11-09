'use strict'

// qxql.19: fake-world oracle for the builder miss family. The body API
// mirrors bridge/build.js and bridge/index.js; resolved RPCs alone do not
// change this world's blocks or satisfy a recovery effect.
const { describe, it, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const Vec3 = require('vec3')
const blueprint = require('../src/castle')
const castle = require('../src/behaviours/castle')
const recovery = require('../src/behaviours/castlerecovery')
const toolPrep = require('../src/behaviours/toolprep')
const { nextStepGen } = require('../src/step')
const oldBody = process.env.BOT_BODY
afterEach(() => { if (oldBody === undefined) delete process.env.BOT_BODY; else process.env.BOT_BODY = oldBody })
const settle = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r)) }

function fixture({ occupant = 'dirt', choose = 'clear', missingSupport = false, ineffective = false, stanceProblem = false } = {}) {
  process.env.BOT_BODY = 'baritone'
  const site = { x: 100, y: 64, z: 200 }
  const st = { site, rot: 0, blueprintVersion: 3, phase: 'body', blocked: {} }
  const { cells } = blueprint.absPlan(site, 0, 3)
  const target = cells.find((c) => c.kind === 'stone' && c.y === site.y)
  const map = new Map(), key = (p) => `${p.x},${p.y},${p.z}`
  const set = (p, n) => map.set(key(p), n)
  const names = { stone: 'cobblestone', planks: 'oak_planks', frame: 'oak_log', fence: 'oak_fence', door: 'oak_door', torch: 'torch', stairs: 'cobblestone_stairs', chest: 'chest', gate: 'oak_fence_gate' }
  for (const c of cells) if (names[c.kind]) set(c, names[c.kind])
  set(target, occupant)
  const below = { x: target.x, y: target.y - 1, z: target.z }
  if (missingSupport) set(below, 'air')
  const calls = { plans: [], digs: [], places: [], goals: [], builds: [], stops: 0 }
  const pick = { name: 'stone_pickaxe', type: 274, count: 1 }
  const shovel = { name: 'stone_shovel', type: 273, count: 1 }
  const items = [pick, shovel, { name: 'cobblestone', type: 4, count: 128 }, { name: 'dirt', type: 3, count: 32 }]
  const bot = {
    entity: { position: new Vec3(target.x - 1.5, target.y, target.z + 0.5) },
    inventory: { items: () => items }, heldItem: shovel, players: {}, world: {},
    blockAt: (p) => {
      const name = map.get(key(p)) || (p.y < site.y ? 'dirt' : 'air')
      return { name, position: new Vec3(p.x, p.y, p.z), boundingBox: /^(air|torch)$/.test(name) ? 'empty' : 'block' }
    },
    pathfinder: {
      goal: null, isMoving: () => false,
      movements: { exclusionAreasBreak: [], exclusionAreasPlace: [] },
      setGoal(g) { this.goal = g; calls.goals.push(g); if (g && !ineffective) bot.entity.position = new Vec3(g.x + 0.5, g.y, g.z + 0.5) },
      bestHarvestTool: () => shovel,
    },
    equip: async (it) => { bot.heldItem = it },
    dig: async (b) => { calls.digs.push(key(b.position)); if (!ineffective) set(b.position, 'air') },
    placeBlock: async (ref, face) => {
      const p = ref.position.plus(face); calls.places.push(key(p))
      if (!ineffective && !(stanceProblem && Math.floor(bot.entity.position.x) === target.x - 2 && Math.floor(bot.entity.position.z) === target.z)) set(p, bot.heldItem.name)
    },
    stopBuild: async () => { calls.stops++ },
    buildCells: async (name, origin, batch) => {
      calls.builds.push(batch)
      if (bot.blockAt(target).name !== 'air' || bot.blockAt(below).boundingBox !== 'block' || ineffective ||
          (stanceProblem && Math.floor(bot.entity.position.x) === target.x - 2 && Math.floor(bot.entity.position.z) === target.z)) return { placed: 0, missing: batch.length }
      for (const c of batch) set({ x: origin.x + c.dx, y: origin.y + c.dy, z: origin.z + c.dz }, c.block)
      return { placed: batch.length, missing: 0 }
    },
    chat: () => {},
  }
  const ctx = {
    castle: st, work: true, step: 'castle', stepStatus: 'running', body: { owner: 'work' },
    brain: { plan: async (q) => { calls.plans.push(q); return { step: Object.keys(q.criteria).find((k) => k.startsWith(choose)) || 'defer' } } },
  }
  return { bot, ctx, st, target, below, calls, set, key, items }
}

async function ticks(f, n = 5) { for (let i = 0; i < n; i++) { castle(f.bot, f.ctx); await settle() } }
function retire(f, why = 'build-miss') { f.st.blocked[`3:${f.target.idx}`] = { why, tries: 3, until: Date.now() - 1, retired: true } }

describe('castle cell recovery (qxql.19)', () => {
  it('recovers a persisted builder-miss obstruction and resumes actual builder progress', async () => {
    const f = fixture()
    retire(f)
    assert.equal(castle.menuFact(f.bot, f.ctx), 'clear', 'retired miss is visible to the arbiter')
    await ticks(f)
    assert.ok(f.calls.plans.length > 0)
    assert.deepEqual(f.calls.plans[0].state.target, { x: f.target.x, y: f.target.y, z: f.target.z, kind: 'stone', expected: 'cobblestone', occupant: 'dirt' })
    assert.ok(f.calls.digs.includes(f.key(f.target)))
    assert.ok(f.calls.stops > 0, 'builder ownership released first')
    assert.equal(f.bot.blockAt(f.target).name, 'cobblestone')
    assert.equal(f.st.blocked[`3:${f.target.idx}`], undefined)
  })

  it('offers and executes safe missing-support placement selected by the model', async () => {
    const f = fixture({ occupant: 'air', missingSupport: true, choose: 'support' })
    retire(f)
    await ticks(f)
    assert.ok(f.calls.places.includes(f.key(f.below)))
    assert.equal(f.bot.blockAt(f.target).name, 'cobblestone')
    assert.ok(f.ctx.placedByBot.has(f.key(f.below)), 'temporary support is owned')
  })

  it('offers alternative target-centered standable stances and verifies displacement', async () => {
    const f = fixture({ occupant: 'air', choose: 'stance', stanceProblem: true })
    const before = await f.bot.buildCells('before', f.st.site, [{ dx: f.target.x - f.st.site.x, dy: 0, dz: f.target.z - f.st.site.z, block: 'cobblestone' }])
    assert.equal(before.missing, 1, 'the bad starting column genuinely prevents placement')
    retire(f)
    await ticks(f)
    assert.ok(f.calls.plans[0].state.stances.length)
    assert.ok(f.calls.goals.some((g) => g && g.constructor.name === 'GoalBlock'))
    assert.ok(f.calls.places.includes(f.key(f.target)), 'placement succeeds from the changed stance')
    assert.equal(f.bot.blockAt(f.target).name, 'cobblestone')
  })

  it('starts only after repeated builder refusal; a progressing builder never plans', async () => {
    const f = fixture({ occupant: 'air' })
    await ticks(f, 2)
    assert.equal(f.calls.plans.length, 0)
    assert.equal(f.bot.blockAt(f.target).name, 'cobblestone')
    const stuck = fixture()
    await ticks(stuck, 3)
    assert.equal(stuck.calls.plans.length, 0, 'the normal blocked-cell backoff is respected')
    stuck.st.blocked[`3:${stuck.target.idx}`].until = Date.now() - 1
    await ticks(stuck, 3)
    assert.ok(stuck.calls.plans.length > 0, 'real repeated misses enter recovery')
  })

  it('retries a supported open cell directly and verifies world correctness', async () => {
    const f = fixture({ occupant: 'air', choose: 'retry' }); retire(f)
    await ticks(f, 3)
    assert.ok(f.calls.places.includes(f.key(f.target)))
    assert.equal(f.bot.blockAt(f.target).name, 'cobblestone')
    assert.equal(f.st.blocked[`3:${f.target.idx}`], undefined)
  })

  it('does not rearm protected retirement, starving material or unloaded targets', async () => {
    for (const why of ['protected', 'kept-chest', 'no-tool-stone']) {
      const f = fixture(); retire(f, why); await ticks(f, 2)
      assert.equal(f.calls.plans.length, 0, why)
      assert.ok(f.st.blocked[`3:${f.target.idx}`].retired)
    }
    const f = fixture(); retire(f); f.items.length = 0; await ticks(f, 2)
    assert.equal(f.calls.plans.length, 0)
    const u = fixture(); retire(u); u.bot.blockAt = () => null; await ticks(u, 2)
    assert.equal(u.calls.plans.length, 0)
  })

  it('revalidates occupant after the model answer; containers and completed cells never dig', async () => {
    const f = fixture(); retire(f)
    let answer
    f.ctx.brain.plan = (q) => { f.calls.plans.push(q); return new Promise((r) => { answer = r }) }
    await ticks(f, 1)
    f.set(f.target, 'chest')
    answer({ step: Object.keys(f.calls.plans[0].criteria).find((k) => k.startsWith('clear')) })
    await settle(); await ticks(f, 2)
    assert.equal(f.calls.digs.length, 0)
    assert.equal(f.bot.blockAt(f.target).name, 'chest')
    assert.ok(!Object.keys(f.calls.plans.at(-1).criteria).some((k) => k.startsWith('clear')))
  })

  it('drops stale model answers on stop, replacement, fight and castle replacement', async () => {
    for (const cancel of [
      (ctx) => { ctx.paused = true; nextStepGen(ctx) },
      (ctx) => { ctx.work = false; ctx.lead = {} },
      (ctx) => { ctx.lastDecision = { action: 'fight' } },
      (ctx) => { ctx.castle = { ...ctx.castle } },
    ]) {
      const f = fixture(); retire(f); let answer
      f.ctx.brain.plan = (q) => { f.calls.plans.push(q); return new Promise((r) => { answer = r }) }
      await ticks(f, 1); cancel(f.ctx)
      answer({ step: Object.keys(f.calls.plans[0].criteria).find((k) => k.startsWith('clear')) })
      await settle(); await ticks(f, 1)
      assert.equal(f.calls.digs.length, 0)
    }
  })

  it('does not treat resolved no-op RPCs as effects and suppresses failed choices', async () => {
    const f = fixture({ ineffective: true }); retire(f)
    await ticks(f, 12)
    assert.equal(f.calls.digs.length, 1, 'unchanged clear candidate is not repeated')
    assert.ok(f.calls.plans.length <= recovery.MAX_CALLS)
    assert.ok(f.calls.plans.some((q) => q.state.recent.some((a) => a.outcome === 'unchanged')))
    assert.ok(f.st.blocked[`3:${f.target.idx}`].retired, 'no RPC-only progress')
  })

  it('invalid/no planner/error choices cause no action and back off', async () => {
    for (const planner of [null, async () => ({ step: 'dig 999 99 999' }), async () => { throw new Error('budget') }]) {
      const f = fixture(); retire(f)
      f.ctx.brain = planner ? { plan: async (q) => { f.calls.plans.push(q); return planner(q) } } : {}
      await ticks(f, 8)
      assert.equal(f.calls.digs.length, 0)
      assert.ok(f.calls.plans.length <= 1)
    }
  })

  it('times out a hanging plan, drops its late result and retains an honest hole', async () => {
    const f = fixture(); retire(f); let answer
    f.ctx.brain.plan = (q) => { f.calls.plans.push(q); return new Promise((r) => { answer = r }) }
    const clock = Date.now
    const now = clock()
    try {
      Date.now = () => now
      await ticks(f, 1)
      Date.now = () => now + 11000
      await ticks(f, 1)
      answer({ step: 'clear_target' })
      await settle(); await ticks(f, 4)
      assert.equal(f.calls.plans.length, 1)
      assert.equal(f.calls.digs.length, 0)
      assert.ok(f.st.blocked[`3:${f.target.idx}`].retired)
    } finally { Date.now = clock }
  })

  it('drops an in-flight equip result after stop and never digs the replacement task', async () => {
    const f = fixture(); retire(f)
    let equipped
    f.bot.equip = () => new Promise((r) => { equipped = r })
    await ticks(f, 2)
    assert.ok(equipped)
    f.ctx.work = false
    f.ctx.step = 'follow'
    nextStepGen(f.ctx)
    equipped()
    await settle()
    assert.equal(f.calls.digs.length, 0)
    assert.ok(f.st.blocked[`3:${f.target.idx}`].retired)
  })

  it('does not dig a completed blueprint block or newly protected obstacle after planning', async () => {
    for (const occupant of ['cobblestone', 'oak_planks', 'chest']) {
      const f = fixture(); retire(f); let answer
      f.ctx.brain.plan = (q) => { f.calls.plans.push(q); return new Promise((r) => { answer = r }) }
      await ticks(f, 1)
      f.set(f.target, occupant)
      answer({ step: 'clear_target' })
      await settle(); await ticks(f, 1)
      assert.equal(f.calls.digs.length, 0, occupant)
    }
  })

  it('backs off an empty menu without forcing a paid call', async () => {
    const f = fixture({ occupant: 'chest' }); retire(f)
    // qxql.29: every spot within place reach is a stance candidate now; fill them all.
    for (let dy = -3; dy <= 1; dy++) for (let dx = -3; dx <= 3; dx++) for (let dz = -3; dz <= 3; dz++) if (dx || dy || dz) f.set({ x: f.target.x + dx, y: f.target.y + dy, z: f.target.z + dz }, 'chest')
    await ticks(f, 6)
    assert.equal(f.calls.plans.length, 0)
    assert.equal(f.calls.digs.length, 0)
    assert.ok(f.st.blocked[`3:${f.target.idx}`].retired)
    assert.equal(f.st.blocked[`3:${f.target.idx}`].recoveries || 0, 0, 'no-safe-menu does not spend a lifetime planner episode')
  })

  it('charges recovery lifetime budget only when a planner invocation actually starts', async () => {
    const unpaid = fixture(); retire(unpaid)
    const unpaidEntry = unpaid.st.blocked[`3:${unpaid.target.idx}`]
    castle(unpaid.bot, unpaid.ctx)
    unpaid.ctx.lastDecision = { action: 'fight' }
    await settle(); await ticks(unpaid, 1)
    assert.equal(unpaid.calls.plans.length, 0, 'fight preempts before the planner microtask')
    assert.equal(unpaidEntry.recoveries || 0, 0, 'pre-invocation cancellation refunds the reservation')

    const paid = fixture(); retire(paid)
    paid.ctx.brain.plan = (q) => { paid.calls.plans.push(q); return new Promise(() => {}) }
    castle(paid.bot, paid.ctx)
    await settle()
    paid.ctx.lastDecision = { action: 'fight' }
    await ticks(paid, 1)
    assert.equal(paid.calls.plans.length, 1)
    assert.equal(paid.st.blocked[`3:${paid.target.idx}`].recoveries, 1, 'already invoked plans remain charged after preemption')
  })

  it('automatic tidy preserves recovery history and exhausted retirement; owner repair can reset it', () => {
    const f = fixture(); retire(f)
    const k = `3:${f.target.idx}`, entry = f.st.blocked[k]
    entry.recoveries = 1
    assert.equal(castle.reopenRepairs(f.bot, f.ctx, f.st, true), 1)
    assert.equal(f.st.blocked[k], entry, 'automatic tidy keeps the same bounded history')
    assert.equal(entry.tries, 3)
    assert.equal(entry.recoveries, 1)
    assert.equal(entry.retired, false)
    assert.equal(entry.until, 0)

    entry.retired = true
    entry.recoveries = recovery.MAX_EPISODES
    assert.equal(castle.reopenRepairs(f.bot, f.ctx, f.st, true), 0)
    assert.equal(entry.retired, true, 'automatic tidy cannot restore an exhausted budget')
    assert.equal(entry.tries, 3)
    assert.equal(castle.reopenRepairs(f.bot, f.ctx, f.st, false), 1, 'explicit owner repair still requests a fresh attempt')
    assert.equal(f.st.blocked[k], undefined)
  })

  it('caps calls/actions across unchanged clear, stance and retry promises', async () => {
    const f = fixture({ ineffective: true }); retire(f)
    f.ctx.brain.plan = async (q) => { f.calls.plans.push(q); return { step: Object.keys(q.criteria).find((k) => k !== 'defer') } }
    await ticks(f, 24)
    assert.ok(f.calls.plans.length >= 2 && f.calls.plans.length <= recovery.MAX_CALLS)
    assert.equal(f.calls.digs.length, 1)
    assert.equal(f.st.blocked[`3:${f.target.idx}`].retired, true)
    assert.equal(f.bot.blockAt(f.target).name, 'dirt')
  })

  it('does not plan for nonretired, still-backed-off or batch-wide wedge entries', async () => {
    for (const entry of [
      { why: 'unreachable', tries: 1, until: 0 },
      { why: 'build-miss', tries: 3, until: Date.now() + 60000, retired: true },
      { why: 'build-miss-wide', tries: 8, until: 0, retired: true },
    ]) {
      const f = fixture({ occupant: 'air' })
      f.st.blocked[`3:${f.target.idx}`] = entry
      await ticks(f, 2)
      assert.equal(f.calls.plans.length, 0, JSON.stringify(entry))
    }
  })

  it('ineffective stance arrival never reopens the cell and lifetime episodes are capped', async () => {
    const f = fixture({ occupant: 'air', choose: 'stance', stanceProblem: true, ineffective: true })
    retire(f)
    const k = `3:${f.target.idx}`, clock = Date.now
    let now = clock()
    try {
      Date.now = () => now
      for (let i = 0; i < recovery.MAX_EPISODES + 2; i++) {
        await ticks(f, 12)
        now += 700000
      }
      assert.equal(f.st.blocked[k].recoveries, recovery.MAX_EPISODES)
      assert.equal(f.st.blocked[k].tries, 3, 'the original retry history is retained')
      assert.equal(f.st.blocked[k].retired, true)
      assert.equal(f.bot.blockAt(f.target).name, 'air')
      assert.ok(f.calls.plans.length <= recovery.MAX_CALLS * recovery.MAX_EPISODES)
      assert.equal(f.calls.builds.length, 0, 'ineffective stance never re-arms normal builder')
    } finally { Date.now = clock }
  })

  it('observed clearing preserves retry history until the builder really lays the cell', async () => {
    const f = fixture(); retire(f)
    await ticks(f, 2)
    const entry = f.st.blocked[`3:${f.target.idx}`]
    assert.equal(f.bot.blockAt(f.target).name, 'air')
    assert.equal(entry.tries, 3)
    assert.equal(entry.recoveries, 1)
    assert.equal(entry.retired, false)
    await ticks(f, 2)
    assert.equal(f.bot.blockAt(f.target).name, 'cobblestone')
    assert.equal(f.st.blocked[`3:${f.target.idx}`], undefined)
  })

  it('ends geometry episode before a missing-tool child can hold the castle tick', async () => {
    const f = fixture(); retire(f)
    f.items.splice(f.items.findIndex((it) => it.name === 'stone_shovel'), 1)
    f.bot.heldItem = null
    toolPrep.setDriver(async () => new Promise(() => {}))
    const clock = Date.now, now = clock()
    try {
      Date.now = () => now
      await ticks(f, 2)
      assert.ok(f.st.toolPrep, 'the existing tool prerequisite is separate')
      assert.equal(f.calls.digs.length, 0)
      Date.now = () => now + 20000
      assert.notEqual(castle.menuFact(f.bot, f.ctx), 'clear', 'ended geometry episode does not override the normal material word while prerequisite holds')
      Date.now = () => now + 61000
      await ticks(f, 2)
      assert.equal(f.calls.plans.length, 1)
      assert.equal(f.st.blocked[`3:${f.target.idx}`].retired, true)
    } finally { Date.now = clock; toolPrep.setDriver(null) }
  })
})

describe('qxql.29 recovery menu on the prod wall geometry', () => {
  // Prod 2026-11-08: 20 retired build-miss cells (11 torch, 5 frame, 3 stone,
  // 1 planks) on site 199,64,-51 rot 2; nights ended no-safe-action calls=0.
  function wall(kind, at) {
    const f = fixture({ occupant: 'air' })
    const { cells } = blueprint.absPlan(f.st.site, 0, 3)
    const c = cells.find((x) => x.kind === kind && (!at || at(x)))
    f.set(c, 'air')
    f.st.blocked = { [`3:${c.idx}`]: { why: 'build-miss', tries: 3, until: Date.now() - 1, retired: true } }
    return { ...f, c }
  }
  const ids = (f, c) => recovery.menu(f.bot, f.ctx, { cell: c, castle: f.st, recent: [] }, castle.RECOVERY_HOOKS).actions.map((a) => a.id)
  it('a torch cell gets a placement retry and stances, not only defer', () => {
    const f = wall('torch')
    f.items.push({ name: 'torch', type: 50, count: 4 })
    f.bot.entity.position = new Vec3(f.c.x + 1.5, f.c.y, f.c.z + 0.5)
    const a = ids(f, f.c)
    assert.ok(a.includes('retry_cell') || a.some((x) => x.startsWith('stance_')), a.join(','))
  })
  it('an off-plan dry spot is a stance (old check refused every off-blueprint cell)', () => {
    const f = wall('frame', (x) => x.y > 64 + 2)
    const a = ids(f, f.c)
    assert.ok(a.some((x) => x.startsWith('stance_')), a.join(','))
  })
})

describe('qxql.27 recovery word vs a running fence fetch', () => {
  // Prod 2026-11-08: 8 logs drawn as 16 fence-equivalents funded a retired
  // frame (log) hole; the word flipped to 'clear' and cut the fetch leg
  // before its fence craft, then the castle failed no-fence: a refetch loop.
  function fenceFixture() {
    const f = fixture({ occupant: 'air' })
    const { cells } = blueprint.absPlan(f.st.site, 0, 3)
    const frame = cells.find((c) => c.kind === 'frame')
    for (const c of cells.filter((x) => x.kind === 'fence')) f.set(c, 'air')
    f.set(frame, 'air')
    f.st.blocked[`3:${frame.idx}`] = { why: 'build-miss', tries: 3, until: Date.now() - 1, retired: true }
    f.items.push({ name: 'oak_log', type: 17, count: 8 })
    f.bot.entity.position = new Vec3(frame.x - 1.5, frame.y, frame.z + 0.5)
    return { ...f, frame }
  }
  it('a running fetch keeps its word; the same pack outside the leg still recovers', () => {
    const f = fenceFixture()
    f.ctx.step = 'castlefetch'
    assert.notEqual(castle.menuFact(f.bot, f.ctx), 'clear', 'the fence leg is not cut for a frame recovery')
    f.ctx.step = 'explore'
    assert.equal(castle.menuFact(f.bot, f.ctx), 'clear', 'recovery stays reachable when no leg runs')
  })
  it('a recovery the castle step would not start is not advertised, and says why', () => {
    const f = fenceFixture()
    f.ctx.step = 'explore'
    f.ctx.bring = { by: 'P' }
    const logs = []
    const orig = console.log
    console.log = (m) => logs.push(String(m))
    try { assert.notEqual(castle.menuFact(f.bot, f.ctx), 'clear') } finally { console.log = orig }
    assert.ok(logs.some((m) => m === `castle recovery target=${f.frame.x},${f.frame.y},${f.frame.z} not startable: bring`), logs.join('\n'))
    assert.equal(recovery.blocker(f.bot, { work: true, body: { owner: 'work' } }), null)
  })
  it('prod 2026-11-08 23:34: a stub follow (owner online, work tick runs) does not block; fight does', () => {
    const f = fenceFixture()
    f.ctx.step = 'explore'
    f.ctx.lastDecision = { action: 'follow', source: 'stub' }
    assert.equal(castle.menuFact(f.bot, f.ctx), 'clear')
    assert.equal(recovery.blocker(f.bot, { work: true, body: { owner: 'work' }, lastDecision: { action: 'follow' } }), null)
    assert.equal(recovery.blocker(f.bot, { work: true, body: { owner: 'work' }, lastDecision: { action: 'fight' } }), 'fight')
  })
})
