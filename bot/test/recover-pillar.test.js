'use strict'

// pillar_up places the block it stands on (idkcraft-17b): prod 2026-09-27
// chose pillar_up 67 times and failed all 67 with failed:place-error — the
// primitive never equipped a scaffold block, so mineflayer threw 'must be
// holding an item to place' (empty hand) or the server refused (tool/food in
// hand). The mocks below pin the real client's hand rule: placeBlock
// rejects unless the hand holds dirt/cobblestone.

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { Vec3 } = require('vec3')
const recover = require('../src/behaviours/recover')
const { createTicker } = require('../src/index')

function pos(x, y, z) {
  return {
    x, y, z,
    distanceTo: (q) => Math.hypot(x - q.x, y - q.y, z - q.z),
    clone() { return pos(x, y, z) },
  }
}

function key(x, y, z) { return `${x},${y},${z}` }

// 1x1 shaft like the logged ravine spot: solid floor at y=60, air inside,
// goal above the mouth.
function pitWorld() {
  const solids = new Set()
  for (let x = -2; x <= 2; x++) {
    for (let z = -2; z <= 2; z++) solids.add(key(x, 60, z))
  }
  for (let y = 61; y <= 66; y++) {
    solids.add(key(1, y, 0)); solids.add(key(-1, y, 0))
    solids.add(key(0, y, 1)); solids.add(key(0, y, -1))
  }
  solids.delete(key(0, 61, 0)); solids.delete(key(0, 62, 0)); solids.delete(key(0, 63, 0))
  return solids
}

// Mock bot with the real client's hand rule: placeBlock throws 'must be
// holding an item to place' on an empty hand (mineflayer _genericPlace) and
// 'Server refused ...' when the hand holds no placeable block. opts:
// held = starting heldItem, refusePlace = server refuses every placement.
function strictBot(solids, items, opts) {
  const o = opts || {}
  const bot = {
    username: 'IdkBot',
    players: {},
    entities: {},
    health: 20,
    food: 20,
    entity: { position: pos(0.5, 61, 0.5), onGround: true },
    inventory: { items: () => items },
    heldItem: o.held || null,
    controls: {},
    setControlState(c, v) { this.controls[c] = !!v },
    getControlState(c) { return !!this.controls[c] },
    clearControlStates() { this.controls = {} },
    blockAt(p) {
      const k = key(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z))
      const solidCell = solids.has(k)
      return { name: solidCell ? 'dirt' : 'air', position: new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)), boundingBox: solidCell ? 'block' : 'empty' }
    },
    async equip(item, dest) {
      bot._equips.push([item && item.name, dest])
      bot.heldItem = item
    },
    async placeBlock(ref, face) {
      bot._places++
      const h = bot.heldItem
      if (!h) throw new Error('must be holding an item to place')
      if (h.name !== 'dirt' && h.name !== 'cobblestone') {
        throw new Error(`Server refused to place ${h.name}: not a placeable block`)
      }
      if (o.refusePlace) throw new Error('Server refused to place dirt at (0, 61, 0): the block is still air')
      const d = ref.position.plus(face)
      solids.add(key(d.x, d.y, d.z))
      if (typeof h.count === 'number') h.count--
    },
    async dig(block) {
      await Promise.resolve()
      solids.delete(key(block.position.x, block.position.y, block.position.z))
    },
    pathfinder: {
      goal: null,
      setGoal(g) { this.goal = g },
      stop() {},
      isMoving: () => false,
    },
    chats: [],
    chat(m) { this.chats.push(String(m)) },
    _places: 0,
    _equips: [],
  }
  return bot
}

function pillarCtx(extraSt) {
  return {
    stuck: { by: 'follow', goal: { x: 0, y: 64, z: 0 } },
    recovery: {
      action: 'pillar_up', source: 'stub', model: null, status: 'running',
      st: Object.assign({ phase: 'place', startFloor: 61, waited: 0, placeInFlight: false, placed: false, placeError: false }, extraSt || {}),
    },
  }
}

async function flush() {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r))
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

function captureLog() {
  const lines = []
  const orig = console.log
  console.log = (l) => { lines.push(String(l)) }
  return { lines, done() { console.log = orig } }
}

describe('pillar_up equips scaffold (idkcraft-17b)', () => {
  it('empty hand + dirt in inventory: equips dirt and places', async () => {
    // Pre-fix this fails: no equip call, place throws, failed:place-error.
    const bot = strictBot(pitWorld(), [{ name: 'dirt', count: 10 }])
    bot.entity.position = pos(0.5, 62, 0.5) // apex for startFloor 61
    const ctx = pillarCtx()
    recover.run(bot, ctx)
    assert.equal(ctx.recovery.status, 'running')
    await flush()
    recover.run(bot, ctx)
    assert.deepEqual(bot._equips, [['dirt', 'hand']])
    assert.equal(bot._places, 1)
    assert.equal(ctx.recovery.status, 'done')
  })

  it('held tool: equips dirt over the pickaxe, never places the tool', async () => {
    const pick = { name: 'iron_pickaxe', count: 1 }
    const dirt = { name: 'dirt', count: 10 }
    const bot = strictBot(pitWorld(), [pick, dirt], { held: pick })
    bot.entity.position = pos(0.5, 62, 0.5)
    const ctx = pillarCtx()
    recover.run(bot, ctx)
    await flush()
    recover.run(bot, ctx)
    assert.deepEqual(bot._equips, [['dirt', 'hand']])
    assert.equal(bot.heldItem, dirt)
    assert.equal(ctx.recovery.status, 'done')
  })

  it('no scaffold: honest failed:no-scaffold without a place attempt', () => {
    const bot = strictBot(pitWorld(), [{ name: 'iron_pickaxe', count: 1 }])
    bot.entity.position = pos(0.5, 62, 0.5)
    const ctx = pillarCtx()
    recover.run(bot, ctx)
    assert.equal(ctx.recovery.status, 'failed:no-scaffold')
    assert.equal(bot._places, 0)
    assert.deepEqual(bot._equips, [])
  })

  it('place error reason reaches the log line, outcome stays failed:place-error', async () => {
    const bot = strictBot(pitWorld(), [{ name: 'dirt', count: 10 }], { refusePlace: true })
    bot.entity.position = pos(0.5, 62, 0.5)
    const ctx = pillarCtx()
    const cap = captureLog()
    try {
      recover.run(bot, ctx)
      await flush()
      recover.run(bot, ctx)
      assert.equal(ctx.recovery.status, 'failed:place-error')
      await recover.decide(bot, ctx, {}, null)
    } finally {
      cap.done()
    }
    const line = cap.lines.find((l) => l.includes('recover action=pillar_up') && l.includes('outcome=failed:place-error'))
    assert.ok(line, `place-error logged, got: ${cap.lines.join(' | ')}`)
    assert.ok(line.includes('err=Server_refused_to_place_dirt'), `reason attached, got: ${line}`)
  })
})

describe('pillar_up issues only inside the apex window (idkcraft-17b)', () => {
  it('falling sample at apex: no placement this tick', () => {
    // 1 Hz ticks sample the 0.6 s jump at a random phase: issuing while
    // already falling lets the server apply the placement after the feet
    // are back in the cell, which it refuses as self-intersection.
    const bot = strictBot(pitWorld(), [{ name: 'dirt', count: 10 }])
    bot.entity.position = pos(0.5, 62.05, 0.5)
    bot.entity.velocity = { x: 0, y: -0.3, z: 0 }
    const ctx = pillarCtx({ phase: 'jump' })
    recover.run(bot, ctx)
    assert.equal(bot._places, 0)
    assert.equal(ctx.recovery.status, 'running')
    assert.equal(ctx.recovery.st.phase, 'jump')
    assert.equal(bot.getControlState('jump'), true)
  })

  it('near-apex fall (vy=-0.05): no placement, waits for the next rise', () => {
    // 2bh: the old apex window issued here, but the async apply then lands
    // on the fall (feet back in the cell) and the server refuses it as
    // self-intersection (rig: +450 ms refused 3/3). Falling samples wait;
    // the wider ascent window below keeps 1 Hz sampling covered.
    const bot = strictBot(pitWorld(), [{ name: 'dirt', count: 10 }])
    bot.entity.position = pos(0.5, 62.2, 0.5)
    bot.entity.velocity = { x: 0, y: -0.05, z: 0 }
    const ctx = pillarCtx({ phase: 'jump' })
    recover.run(bot, ctx)
    assert.equal(bot._places, 0)
    assert.equal(ctx.recovery.st.phase, 'jump')
  })

  it('rising sample mid-ascent (+0.7): tick holds jump, the +150 ms timer issues', async () => {
    // lzw core: issuance is physics-timed, not tick-phased. The tick must
    // not place even with a perfect in-window sample (deleting the timer
    // and re-adding a tick trigger fails the first assertion).
    const bot = strictBot(pitWorld(), [{ name: 'dirt', count: 10 }])
    bot.entity.position = pos(0.5, 61.7, 0.5)
    bot.entity.velocity = { x: 0, y: 0.3, z: 0 }
    const ctx = pillarCtx({ phase: 'jump' })
    recover.run(bot, ctx)
    await flush()
    assert.equal(bot._places, 0, 'no tick-phase issue')
    assert.equal(ctx.recovery.st.phase, 'jump')
    assert.equal(bot.getControlState('jump'), true)
    await sleep(250)
    await flush()
    assert.equal(bot._places, 1, 'the +150 ms timer issues')
    assert.equal(ctx.recovery.st.phase, 'place')
  })

  it('fresh read at fire time: below the trigger at tick, risen by fire', async () => {
    // lzw core: the timer reads height/velocity at fire time, not at arm
    // time. The body rises between the tick and the fire; old tick-phase
    // code with no second tick would never issue here.
    const bot = strictBot(pitWorld(), [{ name: 'dirt', count: 10 }])
    bot.entity.position = pos(0.5, 61.3, 0.5) // below the +0.6 trigger
    bot.entity.velocity = { x: 0, y: 0.4, z: 0 }
    const ctx = pillarCtx({ phase: 'jump' })
    recover.run(bot, ctx)
    assert.equal(bot._places, 0)
    bot.entity.position = pos(0.5, 61.8, 0.5) // the jump rises before the fire
    await sleep(250)
    await flush()
    assert.equal(bot._places, 1, 'fire-time read sees the risen body')
  })

  it('stall at cycle start: grounded fires slide the ceiling, the late rise still issues', async () => {
    // Liftoff-anchored patience (rig: a jump that left 750 ms late burned
    // the fixed ceiling into no-apex). Fires while grounded re-anchor the
    // clock; when the body finally rises, the next fire issues. Old
    // tick-phase code with no second tick would never issue here.
    const bot = strictBot(pitWorld(), [{ name: 'dirt', count: 10 }])
    bot.entity.position = pos(0.5, 61, 0.5) // grounded at the start height
    bot.entity.velocity = { x: 0, y: 0, z: 0 }
    const ctx = pillarCtx({ phase: 'jump' })
    recover.run(bot, ctx)
    await sleep(350) // past the +300 ceiling, still grounded: no give-up
    assert.equal(bot._places, 0)
    assert.equal(ctx.recovery.st.phase, 'jump')
    bot.entity.position = pos(0.5, 61.8, 0.5) // the stall clears, the jump rises
    bot.entity.velocity = { x: 0, y: 0.25, z: 0 }
    await sleep(150)
    await flush()
    assert.equal(bot._places, 1, 'a held jump issues into the late rise')
  })

  it('jump that never rises: the no-apex tick budget still fails the cycle', () => {
    // The liftoff slide must not spin forever: 21 jump-phase ticks with a
    // body that never rises fail no-apex, and the episode retries fresh.
    const bot = strictBot(pitWorld(), [{ name: 'dirt', count: 10 }])
    bot.entity.position = pos(0.5, 61, 0.5)
    bot.entity.velocity = { x: 0, y: 0, z: 0 }
    const ctx = pillarCtx({ phase: 'jump' })
    for (let i = 0; i < 21; i++) recover.run(bot, ctx)
    assert.equal(ctx.recovery.status, 'failed:no-apex')
    assert.equal(bot._places, 0)
  })

  it('chain died by the ceiling: the next jump tick re-arms and a later rise issues', async () => {
    // Revmux body-1: a mid-air arm catches apex/fall only, so the chain
    // dies — but the cycle must not jump to no-apex. The dead chain yields
    // (timerArmed=false) and the next jump-phase tick arms fresh.
    const bot = strictBot(pitWorld(), [{ name: 'dirt', count: 10 }])
    bot.entity.position = pos(0.5, 62.05, 0.5) // airborne falling
    bot.entity.velocity = { x: 0, y: -0.3, z: 0 }
    const ctx = pillarCtx({ phase: 'jump' })
    recover.run(bot, ctx)
    await sleep(450) // past the +300 ceiling: chain dead, nothing issued
    assert.equal(bot._places, 0)
    assert.equal(ctx.recovery.st.timerArmed, false, 'dead chain yields')
    bot.entity.position = pos(0.5, 61.8, 0.5) // the next rise (jump held)
    bot.entity.velocity = { x: 0, y: 0.25, z: 0 }
    recover.run(bot, ctx)
    assert.equal(ctx.recovery.st.timerArmed, true, 'next jump tick re-arms')
    await sleep(250)
    await flush()
    assert.equal(bot._places, 1, 'a later rise still issues')
  })

  it('stall past absolute patience yields the chain (quit bounds it)', async () => {
    // Revmux core-3: the liftoff slide must not poll forever — past 5 s
    // per arm the chain yields; with no ticks (quit) nothing re-arms.
    // (armedAt faked: waiting out 5 s of wall clock is not a unit test.)
    const bot = strictBot(pitWorld(), [{ name: 'dirt', count: 10 }])
    bot.entity.position = pos(0.5, 61, 0.5)
    bot.entity.velocity = { x: 0, y: 0, z: 0 }
    const ctx = pillarCtx({ phase: 'jump' })
    recover.run(bot, ctx)
    ctx.recovery.st.armedAt = Date.now() - 6000
    await sleep(250)
    assert.equal(bot._places, 0)
    assert.equal(ctx.recovery.st.timerArmed, false, 'exhausted chain yields')
  })

  it('timer-path sync failure surfaces as failed:no-reference on the next tick', async () => {
    // Revmux core-1: air everywhere means no reference block; the timer
    // records syncFail and the next tick fails honestly instead of
    // re-jumping into a 20 s no-apex stall (the body lands first, so the
    // guard would take a syncFail-less chain back to jump).
    const bot = strictBot(new Set(), [{ name: 'dirt', count: 10 }])
    bot.entity.position = pos(0.5, 61.8, 0.5)
    bot.entity.velocity = { x: 0, y: 0.25, z: 0 }
    const ctx = pillarCtx({ phase: 'jump' })
    recover.run(bot, ctx)
    await sleep(250)
    assert.equal(bot._places, 0)
    bot.entity.position = pos(0.5, 61, 0.5) // landed before the next tick
    recover.run(bot, ctx)
    assert.equal(ctx.recovery.status, 'failed:no-reference')
  })

  it('stale timer after release or chain never issues (identity guard)', async () => {
    // Revmux core-2: the fire between arm and +150 ms must die when the
    // episode moved on — released (stop/follow me) or chained (fresh st).
    const bot1 = strictBot(pitWorld(), [{ name: 'dirt', count: 10 }])
    bot1.entity.position = pos(0.5, 61.8, 0.5)
    bot1.entity.velocity = { x: 0, y: 0.25, z: 0 }
    const ctx1 = pillarCtx({ phase: 'jump' })
    recover.run(bot1, ctx1)
    ctx1.recovery = null
    await sleep(250)
    await flush()
    assert.equal(bot1._places, 0, 'released episode never issues')
    assert.deepEqual(bot1._equips, [], 'released episode never equips')
    const bot2 = strictBot(pitWorld(), [{ name: 'dirt', count: 10 }])
    bot2.entity.position = pos(0.5, 61.8, 0.5)
    bot2.entity.velocity = { x: 0, y: 0.25, z: 0 }
    const ctx2 = pillarCtx({ phase: 'jump' })
    recover.run(bot2, ctx2)
    ctx2.recovery.st = { phase: 'jump', waited: 0, placeInFlight: false, placed: false, placeError: false, startFloor: 61 }
    await sleep(250)
    await flush()
    assert.equal(bot2._places, 0, 'chained episode never issues from the stale fire')
  })

  it('falling at fire time and past the ceiling: never issues', async () => {
    // A falling body at every fire (static mock) re-arms until the +300 ms
    // ceiling, then gives up the cycle: no placement, still jumping.
    const bot = strictBot(pitWorld(), [{ name: 'dirt', count: 10 }])
    bot.entity.position = pos(0.5, 62.05, 0.5)
    bot.entity.velocity = { x: 0, y: -0.3, z: 0 }
    const ctx = pillarCtx({ phase: 'jump' })
    recover.run(bot, ctx)
    await sleep(450)
    await flush()
    assert.equal(bot._places, 0)
    assert.equal(ctx.recovery.st.phase, 'jump')
    assert.equal(ctx.recovery.status, 'running')
  })

  it('fast path (dirt in hand): t2 sample waits for t3+', () => {
    // Round-3: in-hand scaffold means a fast apply (no equip/look waits),
    // so a +100 ms issue would apply before the feet exit (rig +100 2/3).
    // The trigger moves to +0.9 for the fast path.
    const dirt = { name: 'dirt', count: 10 }
    const bot = strictBot(pitWorld(), [dirt], { held: dirt })
    bot.entity.position = pos(0.5, 61.75, 0.5)
    bot.entity.velocity = { x: 0, y: 0.25, z: 0 }
    const ctx = pillarCtx({ phase: 'jump' })
    recover.run(bot, ctx)
    assert.equal(bot._places, 0)
    assert.equal(ctx.recovery.st.phase, 'jump')
  })

  it('fast path equips the held stack, not main inventory', async () => {
    // Round-3 core-1/body-2: with scaffold held AND a stack in main
    // inventory, the apply must use the held one (instant) — a window
    // move would make it the slow path the +0.9 trigger did not budget.
    const heldDirt = { name: 'dirt', count: 5 }
    const mainDirt = { name: 'dirt', count: 10 }
    const bot = strictBot(pitWorld(), [mainDirt], { held: heldDirt })
    bot.entity.position = pos(0.5, 62.0, 0.5)
    bot.entity.velocity = { x: 0, y: 0.16, z: 0 }
    const ctx = pillarCtx({ phase: 'jump' })
    recover.run(bot, ctx)
    await sleep(250) // lzw: the +150 ms timer issues, not the tick
    await flush()
    assert.equal(bot._places, 1)
    assert.strictEqual(bot.heldItem, heldDirt)
  })

  it('fast path at t3 (+1.0): issues the placement', async () => {
    const dirt = { name: 'dirt', count: 10 }
    const bot = strictBot(pitWorld(), [dirt], { held: dirt })
    bot.entity.position = pos(0.5, 62.0, 0.5)
    bot.entity.velocity = { x: 0, y: 0.16, z: 0 }
    const ctx = pillarCtx({ phase: 'jump' })
    recover.run(bot, ctx)
    await sleep(250) // lzw: the +150 ms timer issues, not the tick
    await flush()
    assert.equal(bot._places, 1)
  })

  it('stale place phase below the trigger: back to jump, never places', () => {
    // Round-2 body-1: fell back (knockback, slow server) with nothing in
    // flight — re-jump instead of placing from below.
    const bot = strictBot(pitWorld(), [{ name: 'dirt', count: 10 }])
    bot.entity.position = pos(0.5, 61.5, 0.5)
    bot.entity.velocity = { x: 0, y: -0.2, z: 0 }
    const ctx = pillarCtx({ phase: 'place', startFloor: 61 })
    recover.run(bot, ctx)
    assert.equal(bot._places, 0)
    assert.equal(ctx.recovery.st.phase, 'jump')
  })

  it('low rise (+0.3): keeps jumping, below the issue height', () => {
    const bot = strictBot(pitWorld(), [{ name: 'dirt', count: 10 }])
    bot.entity.position = pos(0.5, 61.3, 0.5)
    bot.entity.velocity = { x: 0, y: 0.4, z: 0 }
    const ctx = pillarCtx({ phase: 'jump' })
    recover.run(bot, ctx)
    assert.equal(bot._places, 0)
    assert.equal(ctx.recovery.st.phase, 'jump')
    assert.equal(bot.getControlState('jump'), true)
  })

  it('rising sample at apex: issues the placement', async () => {
    const bot = strictBot(pitWorld(), [{ name: 'dirt', count: 10 }])
    bot.entity.position = pos(0.5, 62.05, 0.5)
    bot.entity.velocity = { x: 0, y: 0.3, z: 0 }
    const ctx = pillarCtx({ phase: 'jump' })
    recover.run(bot, ctx)
    await sleep(250) // lzw: the +150 ms timer issues, not the tick
    await flush() // equip runs first, the place lands a microtask later
    assert.equal(bot._places, 1)
  })

  it('missing velocity reads as rising (lenient mocks keep working)', async () => {
    const bot = strictBot(pitWorld(), [{ name: 'dirt', count: 10 }])
    bot.entity.position = pos(0.5, 62.05, 0.5)
    assert.equal(bot.entity.velocity, undefined)
    const ctx = pillarCtx({ phase: 'jump' })
    recover.run(bot, ctx)
    await sleep(250) // lzw: the +150 ms timer issues, not the tick
    await flush() // equip runs first, the place lands a microtask later
    assert.equal(bot._places, 1)
  })
})

describe('pillar_up ravine climb e2e (idkcraft-17b)', () => {
  it('ticker climbs out of the logged pit with a strict hand', async () => {
    // Logged geometry: stuck in a pit at y≈52-54, goal high, scaffold on
    // hand, empty hand. Pre-fix the climb never starts (every pillar_up
    // fails place-error); post-fix the bot pillars out.
    const bot = strictBot(pitWorld(), [{ name: 'dirt', count: 10 }])
    bot.players = { Steve: { username: 'Steve', entity: { id: 7, position: pos(50, 64, 0) } } }
    const brain = { source: 'stub', ask: async () => 'pillar_up' }
    const ticker = createTicker({ bot, brain, tickMs: 10, idleTickMs: 10 })
    bot._tickerCtx.stuck = { by: 'follow', goal: { x: 0, y: 64, z: 0 } }
    let ticks = 0
    for (; ticks < 80 && Math.floor(bot.entity.position.y) < 64; ticks++) {
      await ticker.tick()
      await flush()
      // Harness physics: jump lifts (honest: at most one block above the
      // cycle start floor), gravity settles onto solid ground. Real airtime
      // between ticks: the +150 ms pillar timer fires on wall clock (lzw).
      const st = bot._tickerCtx.recovery && bot._tickerCtx.recovery.st
      const capY = st && typeof st.startFloor === 'number' ? st.startFloor + 1.05 : 61.05
      if (bot.getControlState('jump') && bot.entity.position.y < capY) {
        bot.entity.position.y = Math.min(bot.entity.position.y + 0.5, capY)
      }
      const below = bot.blockAt({ x: bot.entity.position.x, y: bot.entity.position.y - 0.1, z: bot.entity.position.z })
      if ((!below || below.boundingBox === 'empty') && !bot.getControlState('jump')) {
        bot.entity.position.y = Math.max(60.5, bot.entity.position.y - 0.5)
      }
      await sleep(25)
    }
    assert.equal(Math.floor(bot.entity.position.y), 64, `pillared out in ${ticks} ticks`)
    assert.ok(bot._equips.length >= 1, 'equipped scaffold at least once')
    // The loop exits mid-jump at mouth height, so the third cycle's
    // placement is still queued: two landed blocks prove the climb.
    assert.ok(bot._places >= 2, `placed ${bot._places} pillar blocks`)
  })
})

describe('recover digs equip the pickaxe (idkcraft-17b revmux 01 body-1)', () => {
  function digRunBot() {
    const solids = pitWorld()
    solids.add(key(0, 62, 0)) // stone-equivalent headroom over the shaft
    const dirt = { name: 'dirt', count: 10 }
    const pick = { name: 'stone_pickaxe', count: 1 }
    const bot = strictBot(solids, [dirt, pick], { held: dirt })
    bot.pathfinder.bestHarvestTool = () => pick
    const digs = []
    const origDig = bot.dig
    bot.dig = async (b) => { digs.push([b.position.x, b.position.y, b.position.z]); return origDig(b) }
    return { bot, digs, pick }
  }

  it('dig_up equips the pickaxe over held dirt', async () => {
    const { bot, digs, pick } = digRunBot()
    const ctx = { stuck: { by: 'follow', goal: { x: 0, y: 64, z: 0 } }, recovery: { action: 'dig_up', status: 'running', st: null } }
    recover.run(bot, ctx)
    await flush()
    assert.deepEqual(bot._equips, [[pick.name, 'hand']])
    assert.deepEqual(digs, [[0, 62, 0]])
    recover.run(bot, ctx)
    assert.equal(ctx.recovery.status, 'running', 'dug open but the body never moved (9sq F2)')
    bot.entity.position = pos(0.5, 62, 0.5)
    recover.run(bot, ctx)
    assert.equal(ctx.recovery.status, 'done')
  })

  it('dig_through equips the pickaxe over held dirt', async () => {
    const { bot, digs, pick } = digRunBot()
    const ctx = { stuck: { by: 'follow', goal: { x: 5, y: 61, z: 0 } }, recovery: { action: 'dig_through', status: 'running', st: null } }
    recover.run(bot, ctx)
    await flush()
    assert.deepEqual(bot._equips, [[pick.name, 'hand']])
    assert.deepEqual(digs, [[1, 61, 0]])
  })

  it('dig_up without bestHarvestTool digs with the hand (lenient clients)', async () => {
    const { bot, digs } = digRunBot()
    delete bot.pathfinder.bestHarvestTool
    const ctx = { stuck: { by: 'follow', goal: { x: 0, y: 64, z: 0 } }, recovery: { action: 'dig_up', status: 'running', st: null } }
    recover.run(bot, ctx)
    await flush()
    assert.deepEqual(bot._equips, [])
    assert.deepEqual(digs, [[0, 62, 0]])
  })
})

describe('pillar_up descending floor anchor (idkcraft-cm0.2)', () => {
  it('mid-flight arm seeds high, the grounded landing re-seeds and the next rise issues', async () => {
    // Rig 3/3: the first tick samples the inherited flight at y=62.0 and
    // seeds startFloor=62; the +0.6 trigger (62.6) clears the 62.25 apex,
    // so the baseline jumps to no-apex. The anchor follows the grounded
    // body down to 61 and the next rise issues into the true feet cell.
    const bot = strictBot(pitWorld(), [{ name: 'dirt', count: 10 }])
    bot.entity.position = pos(0.5, 62.0, 0.5) // inherited flight, still high
    bot.entity.velocity = { x: 0, y: -0.2, z: 0 }
    bot.entity.onGround = false
    const ctx = pillarCtx({ phase: 'jump', startFloor: null })
    recover.run(bot, ctx)
    assert.equal(ctx.recovery.st.startFloor, 62, 'first tick seeds the airborne sample')
    assert.equal(ctx.recovery.status, 'running')
    bot.entity.position = pos(0.5, 61, 0.5) // the flight lands
    bot.entity.velocity = { x: 0, y: 0, z: 0 }
    bot.entity.onGround = true
    recover.run(bot, ctx)
    assert.equal(ctx.recovery.st.startFloor, 61, 'grounded landing re-seeds down')
    bot.entity.position = pos(0.5, 61.7, 0.5) // the held jump rises again
    bot.entity.velocity = { x: 0, y: 0.3, z: 0 }
    bot.entity.onGround = false
    await sleep(250) // the +150 ms timer fires on the corrected floor
    await flush()
    assert.equal(bot._places, 1, 'the next rise issues')
    assert.equal(ctx.recovery.st.phase, 'place')
    recover.run(bot, ctx)
    assert.equal(ctx.recovery.status, 'done', 'the feet cell verifies solid')
  })

  it('a single mid-air dip below the seeded floor does not re-seed (blip guard)', () => {
    // A declining client/correction sample is not a landing (Codex q6/7):
    // one airborne dip keeps the anchor, but two in a row re-seed (1 Hz
    // ticks can miss the grounded window between bunny-hops entirely).
    const bot = strictBot(pitWorld(), [{ name: 'dirt', count: 10 }])
    bot.entity.position = pos(0.5, 62.0, 0.5)
    bot.entity.velocity = { x: 0, y: -0.2, z: 0 }
    bot.entity.onGround = false
    const ctx = pillarCtx({ phase: 'jump', startFloor: null })
    recover.run(bot, ctx)
    assert.equal(ctx.recovery.st.startFloor, 62)
    bot.entity.position = pos(0.5, 61.5, 0.5) // dips below, still airborne
    bot.entity.onGround = false
    recover.run(bot, ctx)
    assert.equal(ctx.recovery.st.startFloor, 62, 'one airborne dip keeps the seeded floor')
    recover.run(bot, ctx) // second consecutive dip, still airborne
    assert.equal(ctx.recovery.st.startFloor, 61, 'two airborne dips re-seed down')
  })

  it('non-consecutive dips do not re-seed (counter resets at seed)', () => {
    // Dip, back at the seed, dip again: the middle sample clears the
    // counter, so the second dip is a fresh first strike, not a re-seed.
    const bot = strictBot(pitWorld(), [{ name: 'dirt', count: 10 }])
    bot.entity.position = pos(0.5, 62.0, 0.5)
    bot.entity.velocity = { x: 0, y: -0.2, z: 0 }
    bot.entity.onGround = false
    const ctx = pillarCtx({ phase: 'jump', startFloor: null })
    recover.run(bot, ctx)
    assert.equal(ctx.recovery.st.startFloor, 62)
    bot.entity.position = pos(0.5, 61.5, 0.5)
    recover.run(bot, ctx)
    assert.equal(ctx.recovery.st.startFloor, 62)
    bot.entity.position = pos(0.5, 62.1, 0.5) // back at the seed: reset
    recover.run(bot, ctx)
    bot.entity.position = pos(0.5, 61.5, 0.5)
    recover.run(bot, ctx)
    assert.equal(ctx.recovery.st.startFloor, 62, 'split dips never confirm each other')
  })

  it('every airborne re-seed needs its own confirmation (counter restarts)', () => {
    // After one two-dip re-seed, a lone dip below the new seed must not
    // re-seed again at once — otherwise a single correction blip after a
    // real descent walks the anchor into the floor and fakes a done.
    const bot = strictBot(pitWorld(), [{ name: 'dirt', count: 10 }])
    bot.entity.position = pos(0.5, 63.0, 0.5)
    bot.entity.velocity = { x: 0, y: -0.2, z: 0 }
    bot.entity.onGround = false
    const ctx = pillarCtx({ phase: 'jump', startFloor: null })
    recover.run(bot, ctx)
    assert.equal(ctx.recovery.st.startFloor, 63)
    bot.entity.position = pos(0.5, 62.5, 0.5)
    recover.run(bot, ctx)
    recover.run(bot, ctx)
    assert.equal(ctx.recovery.st.startFloor, 62, 'two dips re-seed')
    bot.entity.position = pos(0.5, 61.5, 0.5)
    recover.run(bot, ctx)
    assert.equal(ctx.recovery.st.startFloor, 62, 'one dip after a re-seed is not enough')
    recover.run(bot, ctx)
    assert.equal(ctx.recovery.st.startFloor, 61, 'two dips confirm the next re-seed')
  })

  it('a rise above the seeded floor never re-seeds up (normal case untouched)', () => {
    // Grounded arm: the jump's own rise must not chase the anchor up —
    // the timer times that rise against the seeded floor.
    const bot = strictBot(pitWorld(), [{ name: 'dirt', count: 10 }])
    const ctx = pillarCtx({ phase: 'jump', startFloor: null })
    recover.run(bot, ctx)
    assert.equal(ctx.recovery.st.startFloor, 61)
    bot.entity.position = pos(0.5, 61.9, 0.5) // the jump rises through 61.x
    bot.entity.velocity = { x: 0, y: 0.3, z: 0 }
    bot.entity.onGround = false
    recover.run(bot, ctx)
    assert.equal(ctx.recovery.st.startFloor, 61, 'rises never move the anchor up')
  })
})
