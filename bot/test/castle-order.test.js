'use strict'

// idkcraft-g0z.3: the 'build castle' order — chat parse, persistence, the
// owner progress line and the work-arbiter step (goal.js).

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const blueprint = require('../src/castle')
const castleMod = require('../src/behaviours/castle')
const goal = require('../src/goal')
const memory = require('../src/memory')
const stockpile = require('../src/behaviours/stockpile')
const { createTicker, handleChat } = require('../src/index')
const { castleSite } = require('../src/chat')

const SITE = { x: 100, y: 64, z: 200 }
const KIT = [
  { name: 'cobblestone', count: 64 },
  { name: 'stone_pickaxe', count: 1 }, { name: 'stone_sword', count: 1 },
]

function pos(x, y, z) {
  const p = { x, y, z, distanceTo: (q) => Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z), clone: () => pos(x, y, z), floored: () => pos(Math.floor(x), Math.floor(y), Math.floor(z)) }
  return p
}

function makeBot({ items = KIT, timeOfDay = 6000, set = new Map(), at = pos(SITE.x - 4, 64, SITE.z - 4) } = {}) {
  const bot = {
    username: 'IdkBot',
    chats: [],
    chat(m) { this.chats.push(String(m)) },
    entity: { position: at },
    inventory: { items: () => items },
    time: { timeOfDay, day: 1 },
    spawnPoint: pos(0, 64, 0),
    players: { Steve: { username: 'Steve', entity: { position: pos(SITE.x + 5.5, 64, SITE.z - 1.5), yaw: Math.PI } } },
    blockAt: (p) => {
      const k = `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`
      const name = set.has(k) ? set.get(k) : (Math.floor(p.y) <= 63 ? 'dirt' : 'air')
      return { name, position: p, boundingBox: name === 'air' ? 'empty' : 'block' }
    },
    pathfinder: { isMoving: () => false, setGoal() {}, stop() {}, goal: null, movements: null, setMovements() {} },
    clearControlStates() {},
    on() {},
    once() {},
  }
  return bot
}

function castleState(extra) {
  return { site: { ...SITE }, rot: 0, blueprintVersion: 1, phase: 'body', blocked: {}, parked: false, ...extra }
}

describe('castle order chat (g0z.3)', () => {
  it('gate faces the speaker: site in the look direction, apron two blocks ahead', () => {
    // mineflayer yaw: look = (-sin, -cos). Facing south (+z) -> gate north (rot 0).
    for (const [yaw, rot, ax, az] of [[Math.PI, 0, 0, 2], [0, 2, 0, -2], [-Math.PI / 2, 3, 2, 0], [Math.PI / 2, 1, -2, 0]]) {
      const { site, rot: r } = castleSite({ x: 10.5, y: 64, z: 20.5 }, yaw)
      assert.equal(r, rot, `yaw ${yaw}`)
      const bp = blueprint.blueprintOf(blueprint.BLUEPRINT_VERSION)
      const e = blueprint.rotatePlan([{ ...bp.ENTRANCE, kind: 'air' }], r, bp.version)[0]
      assert.deepEqual({ x: site.x + e.dx, z: site.z + e.dz }, { x: 10 + ax, z: 20 + az }, `apron for yaw ${yaw}`)
      const door = blueprint.rotatePlan([{ ...bp.DOOR, kind: 'door' }], r, bp.version)[0]
      // The door is further from the speaker than the apron: the gate opens toward them.
      const dApron = Math.hypot(site.x + e.dx - 10, site.z + e.dz - 20)
      const dDoor = Math.hypot(site.x + door.dx - 10, site.z + door.dz - 20)
      assert.ok(dDoor > dApron, `door behind the apron for yaw ${yaw}`)
    }
  })

  it('in range: sets the castle, starts work, answers with coords and size', () => {
    const bot = makeBot()
    const ticker = createTicker({ bot, brain: null, tickMs: 10, idleTickMs: 10 })
    ticker.setFollow('Steve')
    handleChat(bot, ticker, 'Steve', 'build castle')
    const ctx = bot._tickerCtx
    assert.ok(ctx.castle, 'castle set')
    assert.equal(ctx.castle.rot, 0)
    assert.equal(ctx.castle.parked, false)
    assert.equal(ctx.castle.blueprintVersion, blueprint.BLUEPRINT_VERSION)
    assert.equal(ctx.work, true, 'work mode starts like build here')
    assert.equal(ticker.getFollowName(), '')
    const s = ctx.castle.site
    assert.match(bot.chats[bot.chats.length - 1], new RegExp(`^castle at ${s.x} ${s.y} ${s.z}, ~\\d+ blocks, this will take many hours`))
  })

  it("out of range: 'I can't see you, come closer' and no castle", () => {
    const bot = makeBot()
    bot.players = { Steve: { username: 'Steve' } }
    const ticker = createTicker({ bot, brain: null, tickMs: 10, idleTickMs: 10 })
    handleChat(bot, ticker, 'Steve', 'build castle')
    assert.deepEqual(bot.chats, ["I can't see you, come closer"])
    assert.ok(!bot._tickerCtx.castle)
  })

  it("refuses a site on the house, and a second castle until 'castle forget'", () => {
    const bot = makeBot()
    const ticker = createTicker({ bot, brain: null, tickMs: 10, idleTickMs: 10 })
    ticker.setHome({ site: pos(SITE.x + 3, 64, SITE.z + 4), interior: { min: pos(SITE.x + 4, 64, SITE.z + 5), max: pos(SITE.x + 8, 65, SITE.z + 8) }, built: true, v: 2 })
    handleChat(bot, ticker, 'Steve', 'build castle')
    assert.match(bot.chats.pop(), /would sit on my house/)
    assert.ok(!bot._tickerCtx.castle)
    ticker.setHome(null)
    handleChat(bot, ticker, 'Steve', 'build castle')
    const first = bot._tickerCtx.castle
    assert.ok(first)
    handleChat(bot, ticker, 'Steve', 'build castle')
    assert.match(bot.chats.pop(), /already have a castle .* castle forget first/)
    assert.equal(bot._tickerCtx.castle, first)
    handleChat(bot, ticker, 'Steve', 'castle forget')
    assert.match(bot.chats.pop(), /forgotten/)
    assert.equal(bot._tickerCtx.castle, null)
    handleChat(bot, ticker, 'Steve', 'build castle')
    assert.ok(bot._tickerCtx.castle && bot._tickerCtx.castle !== first)
  })

  it("'castle' reports per-kind progress; stop/go park and resume", () => {
    const bot = makeBot()
    const ticker = createTicker({ bot, brain: null, tickMs: 10, idleTickMs: 10 })
    handleChat(bot, ticker, 'Steve', 'castle')
    assert.equal(bot.chats.pop(), 'no castle yet — say build castle')
    bot._tickerCtx.castle = castleState()
    handleChat(bot, ticker, 'Steve', 'castle')
    const line = bot.chats.pop()
    assert.match(line, /^castle at 100 64 200: 0% \(stone 0\/\d+, door 0\/1, torch 0\/\d+, planks 0\/\d+\); now: waiting for its turn; blocked 0$/)
    assert.ok(line.length <= 256)
    handleChat(bot, ticker, 'Steve', 'castle stop')
    assert.equal(bot.chats.pop(), 'castle parked — say castle go to resume')
    assert.equal(bot._tickerCtx.castle.parked, true)
    handleChat(bot, ticker, 'Steve', 'castle')
    assert.match(bot.chats.pop(), /now: parked — say castle go/)
    handleChat(bot, ticker, 'Steve', 'castle go')
    assert.equal(bot.chats.pop(), 'castle resumed')
    assert.equal(bot._tickerCtx.castle.parked, false)
    handleChat(bot, ticker, 'Steve', 'castle dance')
    assert.match(bot.chats.pop(), /^try: castle/)
  })
})

describe('castle persistence (g0z.3)', () => {
  const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'g0z3-')), 'IdkBot.json')
  const bot = { username: 'IdkBot', spawnPoint: { x: 0, y: 64, z: 0 } }

  it('round-trips site/rot/phase/blocked/parked; restart resumes', () => {
    const f = tmp()
    const now = Date.now()
    const st = castleState({ rot: 2, parked: true, blocked: { '1:7': { tries: 2, until: now + 60000, why: 'no-ref' } }, status: 'building', progress: { done: 1, total: 2 } })
    assert.equal(memory.save(bot, { castle: st }, f, now), true, 'a castle alone is worth a write')
    const ctx = {}
    const out = memory.restore(bot, ctx, f, now)
    assert.equal(out.castle, 1)
    assert.deepEqual(ctx.castle, { site: SITE, rot: 2, phase: 'body', blocked: { '1:7': { tries: 2, until: now + 60000 } }, parked: true, blueprintVersion: 1 })
  })

  it('undefined keeps the stored castle; forget (null) drops it', () => {
    const f = tmp()
    memory.save(bot, { castle: castleState(), home: { site: pos(1, 64, 1), built: true } }, f)
    memory.save(bot, { home: { site: pos(1, 64, 1), built: true } }, f) // unrestored ctx
    assert.ok(JSON.parse(fs.readFileSync(f, 'utf8')).castle, 'kept')
    memory.save(bot, { castle: null }, f)
    assert.ok(!JSON.parse(fs.readFileSync(f, 'utf8')).castle, 'dropped')
    const ctx = {}
    memory.restore(bot, ctx, f)
    assert.equal(ctx.castle, undefined)
  })

  it('a hand-edited record is sanitized', () => {
    const f = tmp()
    fs.writeFileSync(f, JSON.stringify({ v: 1, world: memory.worldKey(bot), homes: [], castle: { site: { x: 1.5, y: 2, z: 3 }, rot: 0 } }))
    const a = {}
    memory.restore(bot, a, f)
    assert.equal(a.castle, undefined, 'non-integer site rejected')
    fs.writeFileSync(f, JSON.stringify({ v: 1, world: memory.worldKey(bot), homes: [], castle: { site: SITE, rot: 9, phase: 'x', blocked: { bad: { tries: 1, until: 1 }, '1:3': { tries: 1, until: Date.now() + 1e12 } } } }))
    const b = {}
    memory.restore(bot, b, f)
    assert.equal(b.castle.rot, 0)
    assert.equal(b.castle.phase, 'body')
    assert.deepEqual(Object.keys(b.castle.blocked), ['1:3'])
    assert.ok(b.castle.blocked['1:3'].until <= Date.now() + 600000, 'far-future stamp clamped')
  })
})

describe('castle arbiter step (g0z.3)', () => {
  const decide = (bot, ctx) => goal.decide(bot, ctx)

  it('sits after the house chain, before gather/deliver/forage', () => {
    const o = goal.STEP_ORDER
    assert.equal(o.indexOf('castle'), o.indexOf('light') + 2) // castlefetch (g0z.4) between
    assert.ok(o.indexOf('castle') < o.indexOf('gather'))
    assert.ok(goal.STEP_CRITERIA.castle.includes('stone-batch'))
  })

  it('castle-less facts text is unchanged; a castle adds its word', () => {
    const bot = makeBot()
    const plain = goal.goalText(goal.goalFacts(bot, {}), null)
    assert.ok(!plain.includes('castle'))
    const f = goal.goalFacts(bot, { castle: castleState() })
    assert.equal(f.castle, 'stone-batch')
    assert.ok(goal.goalText(f, null).endsWith(' castle=stone-batch'))
  })

  it('picks castle by day with a stone batch above the reserve', async () => {
    const bot = makeBot()
    const ctx = { castle: castleState() }
    const r = await decide(bot, ctx)
    assert.equal(r.action, 'castle')
    assert.ok(bot.chats.includes('next: building the castle (goal-fsm)'))
  })

  it('g0z.17: a torch cell next in plan order, no torch, no coal: stone goes on, torch-none never gates', async () => {
    const set = new Map()
    const { cells } = blueprint.absPlan(SITE, 0)
    const NAME = { stone: 'cobblestone', planks: 'oak_planks' }
    const t = cells.findIndex((c) => c.kind === 'torch')
    for (const c of cells.slice(0, t)) if (NAME[c.kind]) set.set(`${c.x},${c.y},${c.z}`, NAME[c.kind])
    assert.ok(cells.slice(t + 1).some((c) => c.kind === 'stone'), 'stone left behind the torch')
    const bot = makeBot({ set })
    const ctx = { castle: castleState() }
    assert.equal(goal.goalFacts(bot, ctx).castle, 'stone-batch')
    assert.equal((await decide(bot, ctx)).action, 'castle')
    // Every other place cell laid: only then the torch word.
    for (const c of cells) if (NAME[c.kind]) set.set(`${c.x},${c.y},${c.z}`, NAME[c.kind])
    assert.equal(goal.goalFacts(bot, ctx).castle, 'torch-none')
  })

  it('g0z.17 (revmux 01): torchless, the moat and fence go on; the door waits with the torches', () => {
    const set = new Map()
    const { cells } = blueprint.absPlan(SITE, 0, 2)
    const NAME = { stone: 'cobblestone', planks: 'oak_planks', frame: 'oak_log', chest: 'chest' }
    for (const c of cells) if (NAME[c.kind]) set.set(`${c.x},${c.y},${c.z}`, NAME[c.kind])
    const bot = makeBot({ set })
    const ctx = { castle: castleState({ blueprintVersion: 2 }) }
    assert.equal(goal.goalFacts(bot, ctx).castle, 'clear', 'a moat dig, not torch-none')
    assert.equal(ctx.castleWord.word, 'clear')
    // Moat dug, fence up: only then the torch word (castlefetch retries it).
    for (const c of cells) {
      if (c.kind === 'dig') set.set(`${c.x},${c.y},${c.z}`, 'air')
      if (c.kind === 'fence') set.set(`${c.x},${c.y},${c.z}`, 'oak_fence')
    }
    assert.equal(goal.goalFacts(bot, ctx).castle, 'torch-none')
    // Torches laid: the door is next.
    for (const c of cells) if (c.kind === 'torch') set.set(`${c.x},${c.y},${c.z}`, 'torch')
    assert.equal(goal.goalFacts(bot, ctx).castle, 'door-none')
  })

  it('never at dusk or night (no castle step after dark)', async () => {
    for (const tod of [12500, 18000]) {
      const bot = makeBot({ timeOfDay: tod })
      const r = await decide(bot, { castle: castleState() })
      assert.notEqual(r.action, 'castle', `tod ${tod}`)
    }
  })

  it('dusk return and morning re-entry: castle -> gohome -> stay -> castle', async () => {
    // v1: no bedroom beds owed, so nothing but the night chain competes.
    const home = { site: pos(SITE.x - 20, 64, SITE.z), interior: { min: pos(SITE.x - 19, 64, SITE.z + 1), max: pos(SITE.x - 15, 65, SITE.z + 4) }, built: true, v: 1, chest: pos(SITE.x - 18, 64, SITE.z + 2), table: null }
    const bot = makeBot()
    const ctx = { castle: castleState(), home }
    assert.equal((await decide(bot, ctx)).action, 'castle')
    bot.time.timeOfDay = 12500
    assert.equal((await decide(bot, ctx)).action, 'gohome', 'dusk re-decides off the running castle')
    ctx.stepStatus = 'done'
    bot.entity.position = pos(SITE.x - 17, 64, SITE.z + 2)
    assert.equal((await decide(bot, ctx)).action, 'stay')
    bot.time.timeOfDay = 1000
    bot.time.day = 2
    ctx.stepStatus = 'done'
    assert.equal((await decide(bot, ctx)).action, 'castle', 'morning re-enters the castle')
  })

  it('yields to equip (rearm first)', async () => {
    const bot = makeBot({ items: [{ name: 'cobblestone', count: 64 }, { name: 'stick', count: 4 }, { name: 'crafting_table', count: 1 }] })
    const r = await decide(bot, { castle: castleState() })
    assert.equal(r.action, 'equip')
  })

  it('stone at or below the scaffold reserve is not castle material', async () => {
    const bot = makeBot({ items: [{ name: 'cobblestone', count: 16 }, { name: 'stone_pickaxe', count: 1 }, { name: 'stone_sword', count: 1 }, { name: 'dirt', count: 32 }] })
    const ctx = { castle: castleState() }
    assert.equal(goal.goalFacts(bot, ctx).castle, 'stone-none')
    assert.equal(castleMod.usable(bot, 'stone'), 0)
    assert.notEqual((await decide(bot, ctx)).action, 'castle')
    assert.match(goal.stepWhy('castle', goal.goalFacts(bot, ctx), bot, ctx, ''), /castle: need stone/)
  })

  it('a running leg finishes a partial batch; a fresh pick needs a full one', async () => {
    const items = [{ name: 'cobblestone', count: 26 }, { name: 'stone_pickaxe', count: 1 }, { name: 'stone_sword', count: 1 }]
    const bot = makeBot({ items })
    const ctx = { castle: castleState(), step: 'castle', stepStatus: 'running', goalText: 'stale' }
    assert.equal(goal.goalFacts(bot, ctx).castle, 'stone-some')
    assert.equal((await decide(bot, ctx)).action, 'castle', 'running leg continues')
    const fresh = { castle: castleState() }
    assert.notEqual((await decide(bot, fresh)).action, 'castle', 'no fresh leg on a partial batch')
  })

  it('parked never gets the step; go re-arms it', async () => {
    const bot = makeBot()
    const ctx = { castle: castleState({ parked: true }) }
    assert.notEqual((await decide(bot, ctx)).action, 'castle')
    ctx.castle.parked = false
    assert.equal((await decide(bot, ctx)).action, 'castle', 'the facts word flips, the decision follows')
  })

  it('a no-stone failure holds until restock moves the word', async () => {
    const items = [{ name: 'cobblestone', count: 64 }, { name: 'stone_pickaxe', count: 1 }, { name: 'stone_sword', count: 1 }]
    const bot = makeBot({ items })
    const ctx = { castle: castleState() }
    assert.equal((await decide(bot, ctx)).action, 'castle')
    items[0].count = 10 // laid down to the reserve
    ctx.stepStatus = 'failed:no-stone'
    assert.notEqual((await decide(bot, ctx)).action, 'castle')
    ctx.stepStatus = 'done'
    assert.notEqual((await decide(bot, ctx)).action, 'castle', 'still short')
    items[0].count = 64 // restocked
    ctx.stepStatus = 'done'
    assert.equal((await decide(bot, ctx)).action, 'castle')
  })

  it('demand-kind change: stone laid, the next kind needs its own batch', () => {
    const set = new Map()
    const { cells } = blueprint.absPlan(SITE, 0)
    // Lay every stone cell up to the first non-stone place cell.
    for (const c of cells) {
      if (c.kind === 'door' || c.kind === 'torch') continue // door and torches go last (work order, g0z.17)
      if (c.kind !== 'stone') break
      set.set(`${c.x},${c.y},${c.z}`, 'cobblestone')
    }
    const bot = makeBot({ set, items: [{ name: 'cobblestone', count: 64 }] })
    const w = goal.goalFacts(bot, { castle: castleState() }).castle
    assert.notEqual(w, 'stone-batch')
    assert.match(w, /^(planks|torch|door)-none$/)
  })

  it('completion reads done and the step is never offered', () => {
    const set = new Map()
    for (const c of blueprint.absPlan(SITE, 0).cells) {
      if (!blueprint.isPlaceTarget(c.kind)) continue
      set.set(`${c.x},${c.y},${c.z}`, c.kind === 'stone' ? 'cobblestone' : c.kind === 'planks' ? 'oak_planks' : c.kind === 'door' ? 'oak_door' : 'torch')
    }
    const bot = makeBot({ set })
    const ctx = { castle: castleState({ phase: 'complete' }) }
    const f = goal.goalFacts(bot, ctx)
    assert.equal(f.castle, 'done')
    assert.equal(goal.MENU.castle.feasible(f, bot, ctx), false)
    assert.equal(goal.stepWhy('castle', f, bot, ctx, ''), 'castle: complete')
  })

  it("revmux 01: all laid but not yet complete reads 'finish'; one castle tick completes it", async () => {
    const set = new Map()
    for (const c of blueprint.absPlan(SITE, 0).cells) {
      if (!blueprint.isPlaceTarget(c.kind)) continue
      set.set(`${c.x},${c.y},${c.z}`, c.kind === 'stone' ? 'cobblestone' : c.kind === 'planks' ? 'oak_planks' : c.kind === 'door' ? 'oak_door' : 'torch')
    }
    const bot = makeBot({ set })
    const ctx = { castle: castleState() }
    assert.equal(goal.goalFacts(bot, ctx).castle, 'finish')
    assert.equal((await decide(bot, ctx)).action, 'castle')
    castleMod(bot, ctx)
    assert.equal(ctx.castle.phase, 'complete')
    assert.equal(ctx.stepStatus, 'done')
    assert.ok(bot.chats.some((m) => m.startsWith('castle done at')))
    assert.equal(goal.goalFacts(bot, ctx).castle, 'done')
    assert.notEqual((await decide(bot, ctx)).action, 'castle')
  })

  it('revmux 01: an unloaded site never reads as all-undone', () => {
    const bot = makeBot()
    const real = bot.blockAt
    bot.blockAt = () => null // chunks gone (bot far away)
    assert.equal(goal.goalFacts(bot, { castle: castleState({ phase: 'complete' }) }).castle, 'done', 'complete stays done far away')
    // Mid-build: the last on-site word holds (stock re-read), not a fresh stone guess.
    const ctx = { castle: castleState() }
    bot.blockAt = real
    const set = new Map()
    const near = makeBot({ set })
    for (const c of blueprint.absPlan(SITE, 0).cells) {
      if (c.kind === 'door' || c.kind === 'torch') continue
      if (c.kind !== 'stone') break
      set.set(`${c.x},${c.y},${c.z}`, 'cobblestone')
    }
    const w = goal.goalFacts(near, ctx).castle
    assert.match(w, /^(planks|torch)-none$/)
    const nearAt = near.blockAt
    near.blockAt = (p) => (p.x >= SITE.x + 5 ? null : nearAt(p)) // revmux 02: east chunk (with laid tower cells) gone, origin still loaded
    assert.equal(goal.goalFacts(near, ctx).castle, w, 'partly loaded site = last on-site word')
    near.blockAt = () => null
    assert.equal(goal.goalFacts(near, ctx).castle, w, 'far word = last on-site word')
    // Never seen this session: the first plan cell's kind (walk back and build).
    bot.blockAt = () => null
    assert.equal(goal.goalFacts(bot, { castle: castleState() }).castle, 'stone-batch')
  })

  it('deliver and forage yield to a workable castle leg', () => {
    const facts = { time: 'day', haul: 'waiting', player: 'near', known: 'near', health: 20, castle: 'stone-batch' }
    assert.equal(goal.MENU.deliver.feasible(facts, null, {}), false)
    assert.equal(goal.MENU.forage.feasible(facts, null, {}), false)
    facts.castle = 'stone-none'
    assert.equal(goal.MENU.deliver.feasible(facts, null, {}), true)
    assert.equal(goal.MENU.forage.feasible(facts, null, {}), true)
  })

  it('stockpile keeps castle material packed while the castle is open', () => {
    const items = [{ name: 'cobblestone', count: 64 }, { name: 'oak_planks', count: 40 }, { name: 'raw_iron', count: 20 }]
    const bot = makeBot({ items })
    const open = stockpile.depositPlan(bot, { castle: castleState() }).map((p) => p.name)
    assert.ok(!open.includes('cobblestone') && !open.includes('oak_planks'), `banked ${open}`)
    assert.ok(open.includes('raw_iron'))
    const done = stockpile.depositPlan(bot, { castle: castleState({ phase: 'complete' }) }).map((p) => p.name)
    assert.ok(done.includes('cobblestone'))
  })
})

describe('castle v2 default for new orders (g0z.12)', () => {
  it('a new order is v2: the 31x27 footprint is site-checked and the reply counts the v2 plan', () => {
    const bot = makeBot()
    const ticker = createTicker({ bot, brain: null, tickMs: 10, idleTickMs: 10 })
    handleChat(bot, ticker, 'Steve', 'build castle')
    const st = bot._tickerCtx.castle
    assert.equal(st.blueprintVersion, 2)
    const n = blueprint.BLUEPRINTS[2].PLAN.filter((c) => blueprint.isPlaceTarget(c.kind)).length
    assert.match(bot.chats.pop(), new RegExp(`~${n} blocks`))
    // Water in the far corner of the v2 site (outside any v1 11x11 box)
    // refuses the same spot.
    const { w, d } = blueprint.siteDimensions(st.rot, 2)
    const wet = makeBot({ set: new Map([[`${st.site.x + w - 1},63,${st.site.z + d - 1}`, 'water']]) })
    const t2 = createTicker({ bot: wet, brain: null, tickMs: 10, idleTickMs: 10 })
    handleChat(wet, t2, 'Steve', 'build castle')
    assert.match(wet.chats.pop(), /can't build a castle here: there is water/)
    assert.ok(!wet._tickerCtx.castle)
  })

  it('a castle already ordered on v1 keeps v1 (status counts the v1 plan)', () => {
    const bot = makeBot()
    const ticker = createTicker({ bot, brain: null, tickMs: 10, idleTickMs: 10 })
    bot._tickerCtx.castle = castleState({ blueprintVersion: undefined })
    handleChat(bot, ticker, 'Steve', 'castle')
    const stone = blueprint.BLUEPRINTS[1].PLAN.filter((c) => c.kind === 'stone').length
    assert.match(bot.chats.pop(), new RegExp(`stone 0/${stone},`))
  })

  it("'castle' status reads 'too far' while a far v2 corner is unloaded", () => {
    const bot = makeBot()
    const ticker = createTicker({ bot, brain: null, tickMs: 10, idleTickMs: 10 })
    bot._tickerCtx.castle = castleState({ blueprintVersion: 2 })
    const real = bot.blockAt
    bot.blockAt = (p) => (p.x >= SITE.x + 20 ? null : real(p))
    handleChat(bot, ticker, 'Steve', 'castle')
    assert.match(bot.chats.pop(), /too far to count/)
  })

  it('stockpile reserves logs and chests for a v2 castle only', () => {
    const items = [{ name: 'oak_log', count: 20 }, { name: 'chest', count: 1 }, { name: 'raw_iron', count: 20 }]
    const bot = makeBot({ items })
    const v1 = stockpile.depositPlan(bot, { castle: castleState() }).map((p) => p.name)
    assert.ok(v1.includes('oak_log') && v1.includes('chest'), `v1 banked ${v1}`)
    const v2 = stockpile.depositPlan(bot, { castle: castleState({ blueprintVersion: 2 }) }).map((p) => p.name)
    assert.ok(!v2.includes('oak_log') && !v2.includes('chest'), `v2 banked ${v2}`)
  })
})
