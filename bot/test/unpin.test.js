'use strict'

// Hover-arrest watchdog (idkcraft-1cj): airborne + teleport storm + zero
// displacement fires one cloned-packet nudge per second toward open air,
// verified per attempt, bounded then stood down. Rig shape pinned here:
// the -37.3,65.2,-212.6 pin (grass face east, box.maxX exactly on -37.0)
// storms 10/s idle with 0.00 disp; a 1 cm -x nudge calms it 3/3.

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const unpin = require('../src/unpin')
const { createTicker } = require('../src/index')

function pos(x, y, z) {
  return { x, y, z }
}

// Spot-A shape: open feet/head cells, grass face on +x (east).
function spotABot() {
  return {
    entity: { position: pos(-37.3, 65.2, -212.6), onGround: false },
    blockAt: (p) => {
      if (p.x === -37 && (p.y === 65 || p.y === 64) && (p.z === -213 || p.z === -212)) {
        return { name: p.y === 65 ? 'grass_block' : 'dirt', boundingBox: 'block' }
      }
      return { name: 'air', boundingBox: 'empty' }
    },
  }
}

const PIN_POS = { x: -37.3, y: 65.2, z: -212.6 }

function feedStorm(ctx, t0, n = 10, at = PIN_POS) {
  for (let i = 0; i < n; i++) unpin.noteTeleport(ctx, t0 + i * 100, { ...at })
}

// Same rate, but the server targets scatter (a walking body under lag
// corrections): the spread gate must hold fire.
function feedScatter(ctx, t0, n = 10) {
  for (let i = 0; i < n; i++) unpin.noteTeleport(ctx, t0 + i * 100, { x: -37.3 + i * 0.1, y: 64.4, z: -212.0 })
}

function armedCtx() {
  const ctx = {}
  const sent = []
  const st = { teleports: [], lastMove: null, sendNudge: null, anchor: null, tries: [], stoodDown: null, wins: [] }
  ctx.unpin = st
  unpin.noteMoveParams(ctx, 'position', { x: -37.3, y: 65.1216, z: -212.6, yaw: 0, pitch: 0, onGround: false, flags: { onGround: false } })
  st.sendNudge = (dx, dz, p) => { sent.push({ dx, dz, x: p.x, y: p.y, z: p.z }); return true }
  return { ctx, sent }
}

describe('unpin detection', () => {
  it('fires on the pin signature: airborne + storm + zero disp', () => {
    const bot = spotABot()
    const { ctx, sent } = armedCtx()
    feedStorm(ctx, 10000, 10)
    // Mute the fire log line (prod greps it; the test asserts the send).
    const r = unpin.unpinTick(bot, ctx, 12000)
    assert.equal(r, 'nudged')
    assert.equal(sent.length, 1)
  })

  it('stays quiet on calm traffic (2 teleports)', () => {
    const bot = spotABot()
    const { ctx, sent } = armedCtx()
    feedStorm(ctx, 10000, 2)
    const r = unpin.unpinTick(bot, ctx, 12000)
    assert.ok(r === 'idle' || r === 'watching')
    assert.equal(sent.length, 0)
  })

  it('stays quiet when the body moves (laggy walk, not a pin)', () => {
    const bot = spotABot()
    const { ctx, sent } = armedCtx()
    feedScatter(ctx, 10000, 10) // 10 teleports, 0.9 spread
    bot.entity.position = pos(-36.4, 64.4, -212.0)
    const r = unpin.unpinTick(bot, ctx, 12000)
    assert.equal(r, 'watching')
    assert.equal(sent.length, 0)
  })

  it('stays quiet when teleport targets are missing (no verdict)', () => {
    const bot = spotABot()
    const { ctx, sent } = armedCtx()
    for (let i = 0; i < 10; i++) unpin.noteTeleport(ctx, 10000 + i * 100) // no pos
    assert.equal(unpin.unpinTick(bot, ctx, 12000), 'watching')
    assert.equal(sent.length, 0)
  })

  it('never fires grounded (presses stay recover job)', () => {
    const bot = spotABot()
    bot.entity.onGround = true
    const { ctx, sent } = armedCtx()
    feedStorm(ctx, 10000, 20) // even a 20/s press storm
    const r = unpin.unpinTick(bot, ctx, 12000)
    assert.equal(r, 'watching')
    assert.equal(sent.length, 0)
  })

  it('never fires wet: isInWater storm stays a swim problem', () => {
    const bot = spotABot()
    bot.entity.isInWater = true
    const { ctx, sent } = armedCtx()
    feedStorm(ctx, 10000, 17) // the wild water-pin rate
    assert.equal(unpin.unpinTick(bot, ctx, 12000), 'watching')
    assert.equal(sent.length, 0)
  })

  it('never fires wet: feet=water storm stays a swim problem', () => {
    const bot = spotABot()
    bot.blockAt = () => ({ name: 'water', boundingBox: 'empty' })
    const { ctx, sent } = armedCtx()
    feedStorm(ctx, 10000, 17)
    assert.equal(unpin.unpinTick(bot, ctx, 12000), 'watching')
    assert.equal(sent.length, 0)
  })

  it('defers without a cloned packet shape (no blind sends)', () => {
    const bot = spotABot()
    const ctx = {} // no lastMove, no sendNudge
    feedStorm(ctx, 10000, 10)
    const r = unpin.unpinTick(bot, ctx, 12000)
    assert.equal(r, 'watching')
  })

  it('lastMove guard alone blocks the send (mutant-grade)', () => {
    // sendNudge present but no cloned shape: deleting `!st.lastMove` fires.
    const bot = spotABot()
    const ctx = {}
    const sent = []
    ctx.unpin = { teleports: [], lastMove: null, sendNudge: (dx, dz) => { sent.push([dx, dz]); return true }, anchor: null, tries: [], stoodDown: null, wins: [] }
    feedStorm(ctx, 10000, 10)
    assert.equal(unpin.unpinTick(bot, ctx, 12000), 'watching')
    assert.equal(sent.length, 0)
  })

  it('missing sender neither throws nor sends (robustness, not a guard)', () => {
    // NOTE (equivalent mutant, retired): with lastMove present but no
    // sendNudge, deleting the detection-side sendNudge check is
    // unobservable — sendTry re-checks and returns 'watching' either way.
    // This test pins only the robustness half (no throw, no send).
    const bot = spotABot()
    const { ctx } = armedCtx()
    ctx.unpin.sendNudge = null
    feedStorm(ctx, 10000, 10)
    assert.equal(unpin.unpinTick(bot, ctx, 12000), 'watching')
  })

  it('no position, no crash, no send', () => {
    const { ctx } = armedCtx()
    feedStorm(ctx, 10000, 10)
    assert.equal(unpin.unpinTick({}, ctx, 12000), 'idle')
    assert.equal(unpin.unpinTick({ entity: {} }, ctx, 12000), 'idle')
  })
})

describe('unpin verify + bounds', () => {
  it('frees on storm silence after the nudge', () => {
    const bot = spotABot()
    const { ctx, sent } = armedCtx()
    feedStorm(ctx, 10000, 10)
    assert.equal(unpin.unpinTick(bot, ctx, 12000), 'nudged')
    // 1 s later, no new teleports: the server accepted the step-off.
    const r = unpin.unpinTick(bot, ctx, 13000)
    assert.equal(r, 'freed')
    assert.equal(sent.length, 1)
  })

  it('still storming: next direction on the same cadence', () => {
    const bot = spotABot()
    const { ctx, sent } = armedCtx()
    feedStorm(ctx, 10000, 10)
    assert.equal(unpin.unpinTick(bot, ctx, 12000), 'nudged')
    feedStorm(ctx, 12200, 10) // storm continues past the settle gap
    const r = unpin.unpinTick(bot, ctx, 13000)
    assert.equal(r, 'nudged')
    assert.equal(sent.length, 2)
    assert.ok(sent[0].dx !== sent[1].dx || sent[0].dz !== sent[1].dz)
  })

  it('stands down after 8 tries, re-arms 1+ blocks away', () => {
    const bot = spotABot()
    const { ctx, sent } = armedCtx()
    feedStorm(ctx, 10000, 10)
    assert.equal(unpin.unpinTick(bot, ctx, 12000), 'nudged') // try 1
    for (let k = 1; k <= 7; k++) {
      const t = 12000 + k * 1000
      feedStorm(ctx, t - 800, 10) // storm persists through the verify gap
      assert.equal(unpin.unpinTick(bot, ctx, t), 'nudged') // tries 2..8
    }
    feedStorm(ctx, 19200, 10)
    assert.equal(unpin.unpinTick(bot, ctx, 20000), 'stood-down')
    assert.equal(sent.length, 8)
    // Still pinned here: no more sends, however loud the storm.
    feedStorm(ctx, 20500, 10)
    assert.equal(unpin.unpinTick(bot, ctx, 21000), 'watching')
    assert.equal(sent.length, 8)
    // Owner /tp out: stale + fresh mix gives no verdict yet ...
    bot.entity.position = pos(-30, 65.2, -212.6)
    feedStorm(ctx, 21500, 10, { x: -30, y: 65.2, z: -212.6 })
    assert.equal(unpin.unpinTick(bot, ctx, 22000), 'watching')
    assert.equal(sent.length, 8)
    // ... then the stale evidence expires and the watchdog re-arms.
    feedStorm(ctx, 23000, 10, { x: -30, y: 65.2, z: -212.6 })
    assert.equal(unpin.unpinTick(bot, ctx, 24000), 'nudged')
    assert.equal(sent.length, 9)
  })

  it('mid-episode escape drops the episode (displacement gate)', () => {
    const bot = spotABot()
    const { ctx, sent } = armedCtx()
    feedStorm(ctx, 10000, 10)
    assert.equal(unpin.unpinTick(bot, ctx, 12000), 'nudged')
    // A grind breaks free between tries: no second nudge, episode dropped.
    bot.entity.position = pos(-37.3, 64.6, -212.0) // 0.67 from the anchor
    feedStorm(ctx, 12200, 5) // storm persists, but the body is out: drop it
    assert.equal(unpin.unpinTick(bot, ctx, 13000), 'idle')
    assert.equal(sent.length, 1)
  })

  it('re-pin at exact rest (floor adjacent, flag down) still fires', () => {
    // The accepted revmux-01 semantics: a down flag is no verdict, and the
    // 64.0 landing lock (proven cure on the rig) must not be gated out.
    const bot = spotABot()
    bot.entity.position = pos(-37.3, 64.0, -212.6) // exactly on the grass top
    const { ctx, sent } = armedCtx()
    feedStorm(ctx, 10000, 20, { x: -37.3, y: 64.0, z: -212.6 })
    assert.equal(unpin.unpinTick(bot, ctx, 12000), 'nudged')
    assert.equal(sent.length, 1)
  })

  it('verifying state holds inside the 700 ms gap', () => {
    const bot = spotABot()
    const { ctx, sent } = armedCtx()
    feedStorm(ctx, 10000, 10)
    assert.equal(unpin.unpinTick(bot, ctx, 12000), 'nudged')
    assert.equal(unpin.unpinTick(bot, ctx, 12300), 'verifying')
    assert.equal(sent.length, 1)
  })

  it('re-scans the guide per try, never repeats a direction', () => {
    // Scan flips mid-episode (the body ground onto a new face): try 2 must
    // follow the FRESH guide, not the stale order.
    let flip = false
    const bot = spotABot()
    const baseScan = bot.blockAt
    bot.blockAt = (p) => {
      if (!flip) return baseScan(p)
      return (p.x === -38 && p.z === -212 && (p.y === 65 || p.y === 66))
        ? { name: 'stone', boundingBox: 'block' } // +z face now
        : { name: 'air', boundingBox: 'empty' }
    }
    const { ctx, sent } = armedCtx()
    feedStorm(ctx, 10000, 10)
    assert.equal(unpin.unpinTick(bot, ctx, 12000), 'nudged')
    assert.deepEqual([sent[0].dx, sent[0].dz], [-0.01, 0]) // stale guide: -x
    flip = true
    feedStorm(ctx, 12200, 10)
    assert.equal(unpin.unpinTick(bot, ctx, 13000), 'nudged')
    assert.deepEqual([sent[1].dx, sent[1].dz], [0, -0.01]) // fresh guide: -z
  })

  it('press-loop: 3 rapid re-wins stand down, spaced re-pins keep curing', () => {
    const bot = spotABot()
    const { ctx, sent } = armedCtx()
    // Three pin freed cycles 5 s apart (a sustained press re-plants).
    for (const t0 of [10000, 15000, 20000]) {
      feedStorm(ctx, t0, 10)
      assert.equal(unpin.unpinTick(bot, ctx, t0 + 2000), 'nudged')
      assert.equal(unpin.unpinTick(bot, ctx, t0 + 3000), 'freed')
    }
    // Fourth storm inside 20 s of the wins: rest, defer to stuck flow.
    feedStorm(ctx, 25000, 10)
    assert.equal(unpin.unpinTick(bot, ctx, 27000), 'stood-down')
    assert.equal(sent.length, 3)
    // A minute later the window clears: legit re-pins cure again.
    feedStorm(ctx, 90000, 10)
    assert.equal(unpin.unpinTick(bot, ctx, 92000), 'nudged')
    assert.equal(sent.length, 4)
  })
})

describe('unpin direction guide', () => {
  it('spot A: grass east -> first nudge goes -x', () => {
    const dirs = unpin.orderNudgeDirs(spotABot())
    assert.deepEqual(dirs[0], [-0.01, 0])
    assert.equal(dirs.length, 8)
  })

  it('open air: fixed order starting -x, 8 unique dirs', () => {
    const bot = { entity: { position: pos(0, 70, 0), onGround: false }, blockAt: () => ({ name: 'air', boundingBox: 'empty' }) }
    const dirs = unpin.orderNudgeDirs(bot)
    assert.deepEqual(dirs[0], [-0.01, 0])
    assert.equal(new Set(dirs.map((d) => d.join(','))).size, 8)
  })

  it('corner: axis-aways first, corner diagonal among the first tries', () => {
    const bot = {
      entity: { position: pos(0.2, 70, 0.2), onGround: false },
      blockAt: (p) => ((p.x === 1 && p.z === 0) || (p.x === 0 && p.z === 1)) && (p.y === 70 || p.y === 71)
        ? { name: 'stone', boundingBox: 'block' }
        : { name: 'air', boundingBox: 'empty' },
    }
    const dirs = unpin.orderNudgeDirs(bot)
    assert.deepEqual(dirs[0], [-0.01, 0])
    assert.deepEqual(dirs[1], [0, -0.01])
    assert.ok(dirs.slice(2, 5).some(([x, z]) => x === -0.01 && z === -0.01))
  })

  it('no blockAt (blind mock): falls back to fixed order, no throw', () => {
    const dirs = unpin.orderNudgeDirs({ entity: { position: pos(0, 70, 0) } })
    assert.deepEqual(dirs[0], [-0.01, 0])
    assert.equal(dirs.length, 8)
  })
})

describe('unpin packet clone', () => {
  it('sendNudge clones mineflayer shape, rebases coords to live pos', () => {
    const writes = []
    const bot = {
      _client: { write(name, params) { writes.push({ name, params }) } },
      on() {},
      entity: { position: pos(-37.3, 65.2, -212.6), onGround: false },
    }
    const ctx = {}
    unpin.installUnpinTap(bot, ctx)
    // Mineflayer's own storm send: a REJECTED fall claim (stale y).
    bot._client.write('position', { x: -37.3, y: 65.1216, z: -212.6, yaw: 1, pitch: 2, onGround: false, time: 99, flags: { onGround: false } })
    const st = ctx.unpin
    assert.ok(st && st.lastMove)
    assert.equal(typeof st.sendNudge, 'function')
    writes.length = 0
    assert.equal(st.sendNudge(-0.01, 0, { x: -37.3, y: 65.2, z: -212.6 }), true)
    assert.equal(writes.length, 1)
    const w = writes[0]
    assert.equal(w.name, 'position') // name cloned, not assumed
    assert.ok(Math.abs(w.params.x - -37.31) < 1e-9) // live pos + dx (NOT the stale claim)
    assert.equal(w.params.y, 65.2) // y untouched: pure-horizontal delta
    assert.equal(w.params.z, -212.6)
    assert.equal(w.params.yaw, 1) // shape fields preserved verbatim
    assert.equal(w.params.onGround, false) // copied, never forced
    assert.deepEqual(w.params.flags, { onGround: false })
  })

  it('install is idempotent and mock-safe (no _client, no .on)', () => {
    const ctx = {}
    assert.doesNotThrow(() => unpin.installUnpinTap({}, ctx))
    assert.doesNotThrow(() => unpin.installUnpinTap({ on() {} }, ctx))
    const bot = { on() {}, _client: { write() {} } }
    unpin.installUnpinTap(bot, ctx)
    const w = bot._client.write
    unpin.installUnpinTap(bot, ctx)
    assert.equal(bot._client.write, w)
  })
})

describe('unpin ticker hook', () => {
  it('runTick calls unpinTick (wiring proof, not a tautology)', async () => {
    // Deleting the `unpin.unpinTick(bot, ctx, now())` line from runTick must
    // fail this test: spy on the module function index.js dereferences.
    const bot = {
      username: 'IdkBot',
      players: {},
      entities: {},
      health: 20,
      food: 20,
      entity: { position: pos(0, 64, 0), onGround: true, effects: [] },
      spawnPoint: pos(0, 64, 0),
      registry: { blocksByName: {}, itemsByName: {} },
      inventory: { items: () => [] },
      pathfinder: { goal: null, setGoal() {}, stop() {}, isMoving: () => false, setMovements() {} },
      setControlState() {},
      clearControlStates() {},
      quit() {},
      chat() {},
      blockAt: () => null,
      blockAtCursor: () => null,
    }
    const brain = { async decide() { return { action: 'idle', sprint: false, source: 'stub' } } }
    const ticker = createTicker({ bot, brain, tickMs: 10, idleTickMs: 10, leaveAfterMs: 0 })
    const orig = unpin.unpinTick
    let calls = 0
    let sawCtx = false
    unpin.unpinTick = (...a) => { calls++; sawCtx = !!a[1] && a[1] === bot._tickerCtx; return orig(...a) }
    try {
      await ticker.tick()
    } finally {
      unpin.unpinTick = orig
    }
    assert.equal(calls, 1)
    assert.equal(sawCtx, true)
  })

  it('a calm tick runs the hook without firing or breaking the brain', async () => {
    const bot = {
      username: 'IdkBot',
      players: {},
      entities: {},
      health: 20,
      food: 20,
      entity: { position: pos(0, 64, 0), onGround: true, effects: [] },
      spawnPoint: pos(0, 64, 0),
      registry: { blocksByName: {}, itemsByName: {} },
      inventory: { items: () => [] },
      pathfinder: { goal: null, setGoal() {}, stop() {}, isMoving: () => false, setMovements() {} },
      setControlState() {},
      clearControlStates() {},
      quit() {},
      chat() {},
      blockAt: () => null,
      blockAtCursor: () => null,
    }
    const brain = { async decide() { return { action: 'idle', sprint: false, source: 'stub' } } }
    const ticker = createTicker({ bot, brain, tickMs: 10, idleTickMs: 10, leaveAfterMs: 0 })
    const r = await ticker.tick()
    assert.ok(r && r.decision)
    assert.equal(r.decision.action, 'idle')
  })
})
