'use strict'

// Bead idkcraft-vmzq.35 (prod 2026-10-07 18:31-18:54Z): a respawn ~500 off
// the castle. castlefetch's y-aware site walk failed unreachable, the
// watchdog fallback re-chose the running castle step twice (a no-op), and
// the walk back read as a flat stall.

const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const { goals } = require('mineflayer-pathfinder')
const taskMod = require('../src/task')
const fetch = require('../src/behaviours/castlefetch')
const { createTicker } = require('../src/index')

function pos(x, y, z) {
  return { x, y, z, distanceTo: (q) => Math.hypot(x - q.x, y - q.y, z - q.z), floored: () => pos(Math.floor(x), Math.floor(y), Math.floor(z)) }
}

const SITE = { x: 100, y: 64, z: 200 }

let lines = []
let origLog
let savedWd
beforeEach(() => {
  lines = []
  origLog = console.log
  console.log = (m) => { lines.push(String(m)) }
  savedWd = process.env.GOAL_WATCHDOG_MS
  delete process.env.GOAL_WATCHDOG_MS
})
afterEach(() => {
  console.log = origLog
  if (savedWd === undefined) delete process.env.GOAL_WATCHDOG_MS
  else process.env.GOAL_WATCHDOG_MS = savedWd
})

describe('vmzq.35 far castle respawn', () => {
  it('1: the fallback never re-picks the running step (prod: castle,equip,park -> castle twice)', () => {
    const o = (id, step = null) => ({ id, step, unlock: null })
    const hist = [{ choice: 'castle', outcome: 'flat', dur_s: 120, delta: 'x' }]
    const fb = taskMod.fallbackRank('castle', [o('castle', 'castle'), o('equip', 'equip'), o('park')], hist, 'castle', new Set(['equip']))
    assert.equal(fb && fb.id, 'equip', 'the held equip still changes circumstances; castle is the no-op')
    assert.equal(taskMod.fallbackRank('castle', [o('castle', 'castle'), o('park')], null, 'castle'), null, 'only the running step: no pick')
    // A far option of the running step is a different leg, still allowed.
    assert.equal(taskMod.fallbackRank('castle', [o('castlefetch', 'castlefetch'), o('castlefetch-far', 'castlefetch')], null, 'castlefetch').id, 'castlefetch-far')
  })

  it('2: the far walk back to the site is progress; standing still is not', () => {
    const inv = [{ name: 'cobblestone', count: 73 }, { name: 'stone_pickaxe', count: 1 }]
    const bot = {
      username: 'IdkBot',
      chats: [],
      chat(m) { this.chats.push(String(m)) },
      entity: { position: pos(SITE.x + 500, 64, SITE.z), onGround: true, isInWater: false },
      inventory: { items: () => inv },
      time: { timeOfDay: 6000, day: 1 },
      health: 20,
      food: 20,
      oxygenLevel: 20,
      spawnPoint: pos(0, 64, 0),
      players: {},
      entities: {},
      blockAt: () => null,
      pathfinder: { isMoving: () => false, setGoal() {}, stop() {}, goal: null },
      clearControlStates() {},
    }
    const ticker = createTicker({ bot, brain: null, tickMs: 10, idleTickMs: 10 })
    ticker.setCastle({ site: { ...SITE }, rot: 0, phase: 'body', blocked: {}, parked: false, progress: { done: 328, total: 1722 } })
    ticker.work()
    const ctx = bot._tickerCtx
    ctx.brain = null
    ctx.castleWord = { kind: 'stone', left: 747 }
    ctx.step = 'castle'
    ctx.stepStatus = 'running'
    ctx.stepPick = { step: 'castle', at: Date.now(), source: 'castle-rule', why: 'facts-changed' }
    let t = 1000000000000
    taskMod.taskTick(bot, ctx, t)
    let x = SITE.x + 500
    for (let i = 0; i < 30; i++) { // 300 s walking 4 blocks/10 s
      t += 10000
      x -= 4
      bot.entity.position = pos(x, 64, SITE.z)
      taskMod.taskTick(bot, ctx, t)
    }
    const st = ctx.task.castle
    assert.ok(st.stallMs <= 20000, `walking back never accrues a stall: ${st.stallMs}`)
    assert.ok(lines.some((l) => l === 'goal reset kind=castle why=travel'), JSON.stringify(lines.filter((l) => l.startsWith('goal'))))
    assert.ok(!lines.some((l) => l.startsWith('goal watchdog')), 'no watchdog round while closing in')
    // Wedged: the clock runs again.
    for (let i = 0; i < 9; i++) {
      t += 10000
      taskMod.taskTick(bot, ctx, t)
    }
    assert.ok(st.stallMs >= 80000, `a wedge stalls: ${st.stallMs}`)
  })

  it('3: castlefetch 500 off walks to the site with an XZ goal (prod: failed:castlefetch-unreachable)', () => {
    const goalsSet = []
    const bot = {
      username: 'IdkBot',
      chats: [],
      chat(m) { this.chats.push(String(m)) },
      entity: { position: pos(SITE.x + 500, 36, SITE.z) },
      inventory: { items: () => [{ name: 'stone_pickaxe', count: 1 }, { name: 'dirt', count: 32 }] },
      time: { timeOfDay: 6000, day: 1 },
      spawnPoint: pos(0, 64, 0),
      players: {},
      registry: { blocksByName: { stone: { id: 1 }, chest: { id: 2 } }, itemsByName: {} },
      blockAt: (p) => ({ name: Math.floor(p.y) <= 63 ? 'dirt' : 'air', position: pos(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)), boundingBox: 'block' }),
      findBlocks: () => [],
      pathfinder: { isMoving: () => true, setGoal(g) { goalsSet.push(g); bot.pathfinder.goal = g }, stop() {}, goal: null, movements: null, setMovements() {} },
      clearControlStates() {},
      on() {},
      once() {},
    }
    const ctx = { castle: { site: { ...SITE }, rot: 0, blueprintVersion: 1, phase: 'body', blocked: {}, parked: false } }
    fetch(bot, ctx)
    const g = goalsSet[goalsSet.length - 1]
    assert.ok(g instanceof goals.GoalNearXZ, `far site walk is ${g && g.constructor.name}`)
    assert.equal(ctx.stepStatus, undefined, 'no instant failure')
  })
})
