'use strict'

// idkcraft-vmzq.42: a buried pickless body flailed ~135s before recover
// entered — pocket digs fed the uqhp dig hold and shuffles reset the slow
// count. Buried with no working path now fast-enters (BURIED_STILLS_ENTRY
// consecutive flail stills) and pocket shuffles don't reset.

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const stuck = require('../src/stuck')
const recover = require('../src/behaviours/recover')

function pos(x, y, z) {
  return {
    x, y, z,
    distanceTo: (q) => Math.hypot(x - q.x, y - q.y, z - q.z),
    clone() { return pos(x, y, z) },
    floored() { return pos(Math.floor(x), Math.floor(y), Math.floor(z)) },
    offset(ox, oy, oz) { return pos(x + ox, y + oy, z + oz) },
  }
}

// A buried body: solid rock over the head column (capped), executor
// driving with no working path (partial). blocks maps 'x,y,z' -> name.
function buriedBot({ at = [0.5, 45, 0.5], status = 'partial', digging = false, ceiling = true } = {}) {
  const blocks = {}
  if (ceiling) {
    // Four thick: tunnel crawls stay capped after climbing a block.
    for (let x = -2; x <= 2; x++) {
      for (let z = -2; z <= 2; z++) {
        for (let y = 47; y <= 50; y++) blocks[`${x},${y},${z}`] = 'stone'
      }
    }
  }
  const bot = {
    username: 'IdkBot',
    players: {},
    entities: {},
    entity: { position: pos(at[0], at[1], at[2]), onGround: true },
    pathfinder: {
      goal: null,
      setGoal(g) { bot.pathfinder.goal = g || null },
      stop() {},
      isMoving: () => true,
    },
    blockAt(p) {
      const f = p.floored()
      const n = blocks[`${f.x},${f.y},${f.z}`]
      return n ? { name: n, position: f, boundingBox: 'block' } : null
    },
  }
  if (digging) bot.targetDigBlock = { name: 'stone', position: pos(1, 45, 0) }
  const ctx = { lastGoalKey: '', lastPos: { x: at[0], y: at[1], z: at[2] }, lastPathStatus: status }
  return { bot, ctx }
}

function capture() {
  const lines = []
  const orig = console.log
  console.log = (m) => { lines.push(String(m)) }
  return { lines, release() { console.log = orig } }
}

describe('buried flail gate (vmzq.42)', () => {
  it('buriedFlail: capped + no working path, never a success leg', () => {
    const open = buriedBot({ ceiling: false })
    assert.equal(recover.buriedFlail(open.bot, open.ctx), false, 'open headroom: a walk, not a flail')
    const ok = buriedBot({ status: 'success', digging: true })
    assert.equal(recover.buriedFlail(ok.bot, ok.ctx), false, 'working dig leg reads success')
    for (const s of ['partial', 'noPath', 'timeout', 'none', undefined]) {
      const f = buriedBot({ status: s })
      assert.equal(recover.buriedFlail(f.bot, f.ctx), true, `capped + ${s}: flail`)
    }
  })

  it('buried + digging raises at the fast entry, beating the dig hold', () => {
    const { bot, ctx } = buriedBot({ digging: true })
    const cap = capture()
    try {
      for (let i = 0; i < stuck.BURIED_STILLS_ENTRY; i++) stuck.update(bot, ctx)
    } finally { cap.release() }
    assert.equal(ctx.stuckState, 'STUCK')
    assert.equal(ctx.stuck && ctx.stuck.by, 'no-displacement')
    assert.equal(ctx.digStills, stuck.BURIED_STILLS_ENTRY, 'hold accrues but the fast entry beats it')
    assert.equal(ctx.stuckTicks || 0, 0)
    assert.ok((ctx.buriedStills || 0) >= stuck.BURIED_STILLS_ENTRY)
  })

  it('no raise before the streak fills', () => {
    const { bot, ctx } = buriedBot({ digging: true })
    for (let i = 0; i < 14; i++) stuck.update(bot, ctx) // one tick short of the streak
    assert.equal(ctx.stuck || null, null)
    assert.equal(stuck.verdict(ctx).state, 'SUSPECT')
  })

  it('a pocket shuffle neither resets the streak nor the slow count', () => {
    const { bot, ctx } = buriedBot({})
    for (let i = 0; i < 10; i++) stuck.update(bot, ctx)
    bot.entity.position = pos(1.5, 45, 0.5) // 1 block sideways, inside the pocket bar
    const cap = capture()
    try {
      for (let i = 0; i < 5; i++) stuck.update(bot, ctx)
    } finally { cap.release() }
    assert.equal(ctx.stuckState, 'STUCK', 'streak survives the shuffle')
    assert.equal(ctx.stuckTicks, 15)
  })

  it('leaving the pocket still resets like before', () => {
    const { bot, ctx } = buriedBot({})
    for (let i = 0; i < 10; i++) stuck.update(bot, ctx)
    bot.entity.position = pos(5.5, 45, 0.5) // past the buried bar: a real walk
    stuck.update(bot, ctx)
    assert.equal(ctx.buriedStills || 0, 0)
    assert.equal(ctx.stuckTicks || 0, 0)
    assert.equal(stuck.verdict(ctx).state, 'MOVING')
  })

  it('a tunnel crawl (floor change) does not reset the buried streak', () => {
    // r2: the rig tunneled up 2 blocks in a minute while the detector
    // slept — a crawl toward an unreachable goal never arrives.
    const { bot, ctx } = buriedBot({})
    for (let i = 0; i < 10; i++) stuck.update(bot, ctx)
    bot.entity.position = pos(0.5, 46.2, 0.5) // crawled up a block
    const cap = capture()
    try {
      for (let i = 0; i < 5; i++) stuck.update(bot, ctx)
    } finally { cap.release() }
    assert.equal(ctx.stuckState, 'STUCK', 'streak survives the crawl')
    assert.equal(ctx.stuckTicks, 15)
  })

  it('a crawl with sideways drift does not reset either', () => {
    const { bot, ctx } = buriedBot({})
    for (let i = 0; i < 10; i++) stuck.update(bot, ctx)
    bot.entity.position = pos(1.5, 46.2, 0.5) // drifted 1 and rose a floor
    const cap = capture()
    try {
      for (let i = 0; i < 5; i++) stuck.update(bot, ctx)
    } finally { cap.release() }
    assert.equal(ctx.stuckState, 'STUCK')
  })

  it('a floor change still resets on open ground (master parity)', () => {
    const { bot, ctx } = buriedBot({ ceiling: false })
    for (let i = 0; i < 10; i++) stuck.update(bot, ctx)
    bot.entity.position = pos(0.5, 46.2, 0.5)
    stuck.update(bot, ctx)
    assert.equal(ctx.stuckTicks || 0, 0)
    assert.equal(stuck.verdict(ctx).state, 'MOVING')
  })

  it('a working dig leg keeps the hold and never accrues the streak', () => {
    const { bot, ctx } = buriedBot({ status: 'success', digging: true })
    for (let i = 0; i < 20; i++) stuck.update(bot, ctx)
    assert.equal(ctx.digStills, 20, 'uqhp hold intact')
    assert.equal(ctx.buriedStills || 0, 0)
    assert.equal(ctx.stuck || null, null)
  })

  it('open ground counts exactly as before, streak stays zero', () => {
    const { bot, ctx } = buriedBot({ ceiling: false })
    for (let i = 0; i < 10; i++) stuck.update(bot, ctx)
    assert.equal(ctx.stuckTicks, 10)
    assert.equal(ctx.buriedStills || 0, 0)
    assert.equal(ctx.stuck || null, null)
  })

  it('the raise respects the stuck exemptions', () => {
    const { bot, ctx } = buriedBot({ digging: true })
    ctx.work = { task: 'x' }
    ctx.step = 'stay' // stay owns its own stalls: no raise
    for (let i = 0; i < 20; i++) stuck.update(bot, ctx) // past the streak
    assert.equal(ctx.stuck || null, null)
    assert.equal(stuck.verdict(ctx).state, 'SUSPECT')
  })

  it('release resets the streak: the next episode takes the full entry', () => {
    // r2 (revmux 01 major): release() left buriedStills alone, so every
    // buried episode after the first re-raised on its first counting tick.
    // Airtight stone around a 3x3 pocket: boxed, so release skips the
    // latch and the ticks below measure the streak, not the latch.
    const { bot, ctx } = buriedBot({})
    const keep = bot.blockAt
    bot.blockAt = (p) => {
      const hit = keep(p)
      if (hit) return hit
      const f = p.floored()
      if (Math.abs(f.x) <= 6 && Math.abs(f.z) <= 6 && f.y >= 44 && f.y <= 49 &&
        !(Math.abs(f.x) <= 1 && Math.abs(f.z) <= 1 && (f.y === 45 || f.y === 46))) {
        return { name: 'stone', position: f, boundingBox: 'block' }
      }
      return null
    }
    const cap = capture()
    try {
      for (let i = 0; i < stuck.BURIED_STILLS_ENTRY; i++) stuck.update(bot, ctx)
      assert.equal(ctx.stuckState, 'STUCK')
      recover.release(bot, ctx, 'gave-up')
      assert.equal(ctx.buriedStills || 0, 0)
      for (let i = 0; i < stuck.BURIED_STILLS_ENTRY - 1; i++) stuck.update(bot, ctx)
      assert.equal(ctx.stuck || null, null, 'no instant re-raise')
      stuck.update(bot, ctx)
      assert.equal(ctx.stuckState, 'STUCK', 'the streak refills and raises')
    } finally { cap.release() }
  })
})
