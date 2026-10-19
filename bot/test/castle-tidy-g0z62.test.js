'use strict'

// idkcraft-g0z.62: the owner bot walks back to its complete castle once the
// last visit is CASTLE_TIDY_MS old ('tidy' word), the real words win on a
// loaded site, and the visit stamp persists.

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const blueprint = require('../src/castle')
const castleMod = require('../src/behaviours/castle')
const goal = require('../src/goal')
const memory = require('../src/memory')
const { createTicker, handleChat } = require('../src/index')

const SITE = { x: 100, y: 64, z: 200 }
const NAME = { stone: 'cobblestone', planks: 'oak_planks', frame: 'oak_log', fence: 'oak_fence', door: 'oak_door', torch: 'torch', chest: 'chest' }
const H = 3600000

function pos(x, y, z) {
  const p = { x, y, z, distanceTo: (q) => Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z), clone: () => pos(x, y, z), floored: () => pos(Math.floor(x), Math.floor(y), Math.floor(z)) }
  return p
}
function completeSet() {
  const set = new Map()
  for (const c of blueprint.absPlan(SITE, 0, 2).cells) {
    if (blueprint.isPlaceTarget(c.kind)) set.set(`${c.x},${c.y},${c.z}`, NAME[c.kind])
    else if (c.kind === 'dig') set.set(`${c.x},${c.y},${c.z}`, 'air')
  }
  return set
}
// loaded=false: every blockAt is null (chunks unloaded).
// Mirrors only what castle.js menuFact/castleGo and chat.js read, per the
// installed contracts: mineflayer 4.39 docs/api.md — bot.entity.position (Vec3),
// inventory.items() -> Item[], time.timeOfDay/day, chat(message);
// blockAt(point) -> Block | null when the chunk is not loaded (prismarine-block:
// name, integer position, boundingBox 'block'|'empty'). mineflayer-pathfinder
// readme: setGoal(goal), isMoving(), stop(), setMovements(movements); the
// tests never move the bot, so isMoving is always false.
function makeBot({ set = completeSet(), loaded = true, at = pos(SITE.x - 4, 64, SITE.z - 4), items = [] } = {}) {
  return {
    username: 'IdkBot',
    chats: [],
    chat(m) { this.chats.push(String(m)) },
    entity: { position: at },
    inventory: { items: () => items },
    time: { timeOfDay: 6000, day: 1 },
    spawnPoint: pos(0, 64, 0),
    players: {},
    blockAt: (p) => {
      if (!loaded) return null
      const k = `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`
      const name = set.has(k) ? set.get(k) : (Math.floor(p.y) <= 63 ? 'dirt' : 'air')
      return { name, position: pos(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)), boundingBox: name === 'air' ? 'empty' : 'block' }
    },
    pathfinder: { isMoving: () => false, setGoal() {}, stop() {}, goal: null, movements: null, setMovements() {} },
    clearControlStates() {},
    on() {},
    once() {},
  }
}
function castleState(extra) {
  return { site: { ...SITE }, rot: 0, blueprintVersion: 2, phase: 'complete', blocked: {}, parked: false, ...extra }
}
const FAR = () => pos(SITE.x - 230, 64, SITE.z)

describe('castle tidy (g0z.62)', () => {
  it("menuFact: unloaded + visit 2 h old -> 'tidy'; 10 min old -> 'done'; never visited -> 'tidy'", () => {
    const now = Date.now()
    const bot = makeBot({ loaded: false, at: FAR() })
    assert.equal(castleMod.menuFact(bot, { castle: castleState({ visitedAt: now - 2 * H }) }, now), 'tidy')
    assert.equal(castleMod.menuFact(bot, { castle: castleState({ visitedAt: now - 600000 }) }, now), 'done')
    assert.equal(castleMod.menuFact(bot, { castle: castleState() }, now), 'tidy')
    // Parked or unfinished castles never tidy.
    assert.equal(castleMod.menuFact(bot, { castle: castleState({ parked: true }) }, now), 'parked')
    assert.equal(castleMod.tidyDue(castleState({ phase: 'body' }), now), false)
  })

  it('CASTLE_TIDY_MS=0 turns the trip off', () => {
    const saved = process.env.CASTLE_TIDY_MS
    process.env.CASTLE_TIDY_MS = '0'
    try {
      assert.equal(castleMod.menuFact(makeBot({ loaded: false, at: FAR() }), { castle: castleState() }), 'done')
    } finally {
      if (saved === undefined) delete process.env.CASTLE_TIDY_MS
      else process.env.CASTLE_TIDY_MS = saved
    }
  })

  it("loaded site: the real words win ('clear'/'holes' kinds), and the visit stamp refreshes near the castle", () => {
    const now = Date.now()
    const set = completeSet()
    const fence = blueprint.absPlan(SITE, 0, 2).cells.filter((c) => c.kind === 'fence').slice(0, 3)
    for (const c of fence) set.set(`${c.x},${c.y},${c.z}`, 'air')
    const st = castleState({ visitedAt: now - 2 * H })
    const w = castleMod.menuFact(makeBot({ set }), { castle: st }, now)
    assert.match(w, /^fence-/)
    assert.equal(st.visitedAt, now)
    // Intact walls: the real (decor) word, never 'tidy', and the stamp is
    // fresh, so the far word reads 'done' once the bot leaves.
    const st2 = castleState({ visitedAt: now - 2 * H })
    assert.notEqual(castleMod.menuFact(makeBot(), { castle: st2 }, now), 'tidy')
    assert.equal(st2.visitedAt, now)
    assert.equal(castleMod.menuFact(makeBot({ loaded: false, at: FAR() }), { castle: st2 }, now + 60000), 'done')
    // Loaded but past the visit radius: no stamp (the walk is not over).
    const st3 = castleState({ visitedAt: now - 2 * H })
    castleMod.menuFact(makeBot({ at: pos(SITE.x - 90, 64, SITE.z) }), { castle: st3 }, now)
    assert.equal(st3.visitedAt, now - 2 * H)
  })

  it("castleGo('tidy') day true, night false; castlefetch never reads it as a kind", () => {
    const ctx = { castle: castleState() }
    assert.equal(goal.MENU.castle.feasible({ castle: 'tidy', time: 'day', health: 20 }, makeBot(), ctx), true)
    assert.equal(goal.MENU.castle.feasible({ castle: 'tidy', time: 'night', health: 20 }, makeBot(), ctx), false)
    assert.equal(goal.MENU.castlefetch.feasible({ castle: 'tidy', time: 'day', health: 20, pickaxe: 1 }, makeBot(), ctx), false)
  })

  it('a due tidy displaces the bot from its complete castle by day only', () => {
    const now = Date.now()
    const bot = makeBot({ loaded: false, at: FAR() })
    assert.equal(goal.displacedFromCastle(bot, { castle: castleState({ visitedAt: now - 2 * H }) }), true)
    assert.equal(goal.displacedFromCastle(bot, { castle: castleState({ visitedAt: now - 600000 }) }), false)
    const ctx = { castle: castleState() }
    assert.equal(goal.MENU.gocastle.feasible({ castle: 'tidy', time: 'day', health: 20 }, bot, ctx), true)
    assert.equal(goal.MENU.gocastle.feasible({ castle: 'tidy', time: 'dusk', health: 20 }, bot, ctx), false)
  })

  it('revmux 01: a failed trip leg counts as the visit — no re-walk to an unreachable castle', async () => {
    const bot = makeBot({ loaded: false, at: FAR(), items: [{ name: 'stone_pickaxe', count: 1 }, { name: 'stone_sword', count: 1 }] })
    const ctx = { castle: castleState(), step: 'gocastle', stepStatus: 'running' }
    assert.equal(goal.goalFacts(bot, ctx).castle, 'tidy')
    ctx.stepStatus = 'failed:cannot-reach-castle'
    const r = await goal.decide(bot, ctx)
    assert.ok(typeof ctx.castle.visitedAt === 'number' && ctx.castle.visitedAt > 0)
    assert.ok(!['gocastle', 'castle'].includes(r.action), r.action)
    assert.equal(goal.goalFacts(bot, ctx).castle, 'done')
    assert.equal(goal.displacedFromCastle(bot, ctx), false)
  })

  it('revmux 02: a leg that keeps moving but never arrives ends after 10 min of leg time; night gaps do not count', () => {
    const bot = makeBot({ loaded: false, at: FAR() })
    const ctx = { castle: castleState(), step: 'gocastle', stepStatus: 'running' }
    const t0 = Date.now()
    let t = t0
    for (; t < t0 + 9 * 60000; t += 1000) assert.equal(castleMod.menuFact(bot, ctx, t), 'tidy')
    // A night with the leg off: the clock holds.
    ctx.step = 'shelter'
    for (const end = t + 10 * 60000; t < end; t += 1000) castleMod.menuFact(bot, ctx, t)
    ctx.step = 'gocastle'
    assert.equal(castleMod.menuFact(bot, ctx, t), 'tidy')
    for (const end = t + 2 * 60000; t < end; t += 1000) castleMod.menuFact(bot, ctx, t)
    assert.equal(castleMod.menuFact(bot, ctx, t), 'done')
    assert.ok(ctx.castle.visitedAt > t0 + 19 * 60000)
    // revmux 03: a stop/go cycle hands the next trip a fresh clock.
    ctx.tidyLegMs = 5 * 60000
    ctx.castle.parked = true
    assert.equal(castleMod.menuFact(bot, ctx, t), 'parked')
    assert.equal(ctx.tidyLegMs, 0)
  })

  it('visitedAt persists through memory save/restore (future stamps clamp to now)', () => {
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'g0z62-')), 'IdkBot.json')
    const bot = { username: 'IdkBot', spawnPoint: { x: 0, y: 64, z: 0 } }
    const roundTrip = (visitedAt) => {
      assert.equal(memory.save(bot, { castle: castleState({ visitedAt }) }, f), true)
      const ctx = {}
      memory.restore(bot, ctx, f)
      return ctx.castle.visitedAt
    }
    const now = Date.now()
    assert.equal(roundTrip(now - 5000), now - 5000)
    assert.ok(roundTrip(now + 10 * H) <= Date.now())
    assert.equal(roundTrip('x'), undefined)
  })

  it("chat: 'castle' shows the cadence; 'castle tidy' forces the trip", () => {
    const bot = makeBot()
    const ticker = createTicker({ bot, brain: null, tickMs: 10, idleTickMs: 10 })
    const ctx = bot._tickerCtx
    ctx.castle = castleState({ visitedAt: Date.now() - 10 * 60000, parked: true })
    handleChat(bot, ticker, 'Steve', 'castle')
    assert.match(bot.chats.pop(), /; last visit 10 min ago; next tidy in 50 min$/)
    let worked = 0
    ticker.work = () => { worked++ }
    handleChat(bot, ticker, 'Steve', 'castle tidy')
    assert.equal(bot.chats.pop(), 'castle: going to tidy it')
    assert.equal(ctx.castle.parked, false)
    assert.equal(ctx.castle.visitedAt, 0)
    assert.equal(worked, 1)
    assert.equal(castleMod.tidyDue(ctx.castle), true)
    ctx.castle.phase = 'body'
    handleChat(bot, ticker, 'Steve', 'castle tidy')
    assert.equal(bot.chats.pop(), 'the castle is not finished yet — say castle go to resume')
  })
})
