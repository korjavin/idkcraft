'use strict'

// E2E scenarios, batch 2 (idkcraft-ckz): closed work-cycle bugs replayed
// through work-mode ticks (createTicker + ticker.tick with the goal arbiter
// dispatching). The behaviour-level tests drive gather/build/craft/decide
// directly; the prod symptoms were all tick loops — a step re-picked
// forever, a grid hung across steps, a menu deadlocked, an approach eating
// its own house — visible only across decide->run->status->re-decide.

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { createTicker, createLifecycle } = require('../src/index')
const { fakeClock, record, golden } = require('./characterize-util')

function pos(x, y, z) {
  const p = {
    x, y, z,
    distanceTo: (q) => Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z),
    clone() { return pos(p.x, p.y, p.z) },
    floored() { return pos(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)) },
    offset(ox, oy, oz) { return pos(p.x + ox, p.y + oy, p.z + oz) },
  }
  return p
}

function capture() {
  const lines = []
  const origLog = console.log
  const origErr = console.error
  console.log = (m) => { lines.push(String(m)) }
  console.error = (m) => { lines.push(String(m)) }
  return { lines, release() { console.log = origLog; console.error = origErr } }
}

async function settle(n = 4) {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r))
}

// xg9: paced batches take real time (60 ms/op); poll for N craft calls.
async function untilCrafts(bot, n, timeoutMs = 12000) {
  const t0 = Date.now()
  while (bot.calls.craft < n) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`craft calls stuck at ${bot.calls.craft}, want ${n}`)
    await new Promise((r) => setTimeout(r, 10))
  }
  await settle()
}

// Work-mode brain: the arbiter owns every non-fight tick, so the brain
// answer only needs to stay out of the way.
function workBrain() {
  return { async decide() { return { action: 'idle', sprint: false, source: 'stub' } } }
}

describe('atl.4: failed gather holds instead of livelocking the arbiter', () => {
  // Prod atl.4: after 'cannot reach the trees' with 0<logs<14 the arbiter
  // re-picked gather forever and the bot stood still. Fixed twice: the
  // menu-wide stepFail hold (same facts + same spot) and gather's own
  // final replay. E2E: fail through real ticks, watch the escape episode,
  // then the rotation to rest with named reasons — and the release.
  const LOGREG = { oak_log: 17, birch_log: 18, stone: 1 }

  function gatherBot(spots, names, items = []) {
    const blocksByName = {}
    for (const [name, id] of Object.entries(LOGREG)) blocksByName[name] = { id }
    const lines = []
    const calls = { setGoal: 0, goals: [] }
    const bot = {
      lines,
      calls,
      username: 'IdkBot',
      players: { Steve: { username: 'Steve' } }, // roster online, target unseen
      entities: {},
      // No spawnPoint: the adoption gate would hold work for 60 ticks
      // waiting on spawn chunks the mock never loads; rest safely idles
      // without a site.
      entity: { position: pos(0, 64, 5) },
      registry: { blocksByName },
      _moving: true, // wedged executor: drives while the body stands still
      _items: items,
      pathfinder: {
        goal: null,
        setGoal: (goal) => { calls.setGoal++; calls.goals.push(goal); bot.pathfinder.goal = goal },
        stop() {},
        isMoving: () => bot._moving,
      },
      inventory: { items: () => bot._items },
      findBlocks(opts) {
        const want = new Set(Array.isArray(opts.matching) ? opts.matching : [opts.matching])
        return spots.filter((q) => {
          const n = names[`${q.x},${q.y},${q.z}`]
          const id = n && blocksByName[n] ? blocksByName[n].id : undefined
          return want.has(id)
        })
      },
      blockAt(p) {
        const n = names[`${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`]
        return n ? { name: n, position: pos(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)) } : null
      },
      canDigBlock: () => true,
      dig: async () => {},
      setControlState() {},
      getControlState: () => false,
      clearControlStates() {},
      chat(line) { lines.push(String(line)) },
    }
    return bot
  }

  it('unreachable final -> escape episode -> rest with reasons -> release on logs', async () => {
    const names = {}
    const spots = []
    for (const cx of [2, 6, 9]) {
      for (const cy of [64, 65]) {
        names[`${cx},${cy},0`] = 'oak_log'
        spots.push(pos(cx, cy, 0))
      }
      names[`${cx},66,0`] = 'oak_leaves' // a crown: trees, not decor (m7ke selection guard)
    }
    const bot = gatherBot(spots, names)
    const clock = fakeClock() // oqul.2: controlled clock + seeded random for the journal
    bot.pathfinder.movements = { canDig: true, allowSprinting: false, allowParkour: true } // journal: flags at goal issue
    const ticker = createTicker({ bot, brain: workBrain(), tickMs: 10, idleTickMs: 10 })
    const ctx = bot._tickerCtx
    const journal = record(bot, ctx, { ticker, clock })
    ctx.work = true // work mode: the goal arbiter dispatches gather
    const cap = capture()
    const actions = []
    try {
      // 1. Three columns stall (tower jumps + place_error): the unreachable
      // final through real ticks, exactly the yvi treadmill.
      let jumps = 0
      let t = 0
      // Cap 24 < 3xSTALL_TICKS: only the place_error fast path (4 ticks per
      // column) reaches the final in time — displacement-only needs 30+.
      for (; t < 24 && ctx.stepStatus !== 'failed:unreachable'; t++) {
        bot.entity.position = pos(0, jumps % 2 ? 65.2 : 64, 5)
        bot.entity.onGround = !(jumps % 2)
        jumps++
        ticker.setPathReset('place_error')
        const r = await ticker.tick()
        actions.push(r.decision && r.decision.action)
      }
      assert.ok(t < 24, 'gather fails through ticks (place_error fast path)')
      assert.deepEqual(bot.lines.filter((l) => l === 'cannot reach the trees'),
        ['cannot reach the trees'], 'one chat at the final')
      assert.equal(ctx.stuck && ctx.stuck.by, 'gather', 'detector raises, menu gets one shot')
      assert.equal(bot.pathfinder.goal, null, 'dead goal dropped at the final (yvi)')
      assert.equal(ctx.lastGoalKey, '', 'goal key cleared with it')

      // 2. The escape episode plays out: sidestep walks free sideways.
      bot.entity.position = pos(0, 64, 5)
      const stepBody = () => {
        const g = bot.pathfinder.goal
        if (!g || typeof g.x !== 'number') return
        const bp = bot.entity.position
        const dx = g.x - bp.x
        const dz = g.z - bp.z
        const d = Math.hypot(dx, dz)
        if (d < 0.05) return
        const s = Math.min(0.4, d) / d
        bot.entity.position = pos(bp.x + dx * s, 64, bp.z + dz * s)
      }
      let e = 0
      for (; e < 40 && (ctx.stuck || ctx.recovery); e++) {
        const r = await ticker.tick()
        actions.push(r.decision && r.decision.action)
        if (ctx.recovery) stepBody()
      }
      assert.ok(e < 40, 'episode ends')
      assert.equal(ctx.recoverLatch && ctx.recoverLatch.by, 'gather', 'release latches the spot')
      bot._moving = false // executor parked: rest strolls below

      // 3. The arbiter rotates to rest and names the hold; gather is never
      // re-picked while the facts stand (the atl.4 livelock, gone).
      const r = await ticker.tick()
      actions.push(r.decision && r.decision.action)
      assert.equal(r.decision.action, 'rest')
      const holdStart = actions.length - 1
      assert.ok(bot.lines.some((l) => l.includes('gather holds after failure')),
        `rest names the hold: ${bot.lines.join(' | ')}`)
      for (let i = 0; i < 10; i++) {
        const rr = await ticker.tick()
        actions.push(rr.decision && rr.decision.action)
      }
      assert.ok(!actions.slice(holdStart).includes('gather'),
        `no gather re-pick after the final: ${actions.slice(holdStart).join(',')}`)
      assert.equal(actions[actions.length - 1], 'rest')
      assert.deepEqual(bot.lines.filter((l) => l === 'cannot reach the trees'),
        ['cannot reach the trees'], 'still exactly one chat')

      // 4. New facts release the step: one picked-up log re-arms gather.
      bot._items.push({ name: 'oak_log', count: 1 })
      const g = await ticker.tick()
      assert.equal(g.decision.action, 'gather', 'fresh facts retry gather')
      assert.match(ctx.lastGoalKey, /^gather:/, 'walking again')
      golden('scenarios-work', 'atl.4 unreachable final -> escape -> rest -> release', journal.events)
    } finally {
      cap.release()
      clock.restore()
      ticker.destroy()
    }
  })
})

describe('gxk: stranded grid converts fully instead of hanging the craft', () => {
  // Prod gxk: one log stranded in the 2x2 grid made every later bot.craft
  // time out on updateSlot:0 (the server only answers on result change),
  // logs churned 14->13 per attempt, gather<->craft looped forever. Fixed:
  // the grid is cleared up front and one log converts per op inside one
  // step. E2E: the slot-level fake through work-mode ticks.
  const TIMEOUT_MSG = 'Event updateSlot:0 did not fire within timeout of 20000ms'

  function fakeWindow() {
    const slots = new Array(46).fill(null)
    return {
      slots,
      selectedItem: null,
      inventoryStart: 9,
      inventoryEnd: 45,
      items: () => slots.slice(9, 45).filter(Boolean),
    }
  }

  const logItem = (count) => ({ name: 'oak_log', type: 17, count, stackSize: 64 })
  const planksItem = (count) => ({ name: 'oak_planks', type: 18, count, stackSize: 64 })

  function stash(win, item) {
    for (let i = 9; i < 45; i++) {
      const cur = win.slots[i]
      if (cur && cur.name === item.name && cur.count < (cur.stackSize || 64)) {
        const room = (cur.stackSize || 64) - cur.count
        const take = Math.min(room, item.count)
        cur.count += take
        item.count -= take
        if (item.count <= 0) return
      }
    }
    for (let i = 9; i < 45; i++) {
      if (!win.slots[i]) { item.slot = i; win.slots[i] = item; return }
    }
    throw new Error('fake inventory full')
  }

  const countIn = (win, name) => win.items().reduce((n, it) => (it && it.name === name ? n + it.count : n), 0)
  const gridOf = (win) => [1, 2, 3, 4].map((s) => win.slots[s]).filter(Boolean)

  function craftBot({ gridLogs = 0, invLogs = 0 } = {}) {
    const win = fakeWindow()
    if (gridLogs > 0) {
      const g = logItem(gridLogs)
      g.slot = 1
      win.slots[1] = g
    }
    if (invLogs > 0) {
      const s = logItem(invLogs)
      s.slot = 9
      win.slots[9] = s
    }
    let lastResult = gridLogs > 0 ? 'planks' : null
    const resultNow = () => gridOf(win).length > 0 ? 'planks' : null
    const lines = []
    const calls = { craft: 0 }
    const bot = {
      lines,
      calls,
      username: 'IdkBot',
      players: { Steve: { username: 'Steve' } }, // roster online, target unseen
      entities: {},
      entity: { position: pos(0, 64, 0) },
      registry: { itemsByName: { oak_log: { id: 17 }, oak_planks: { id: 18 } } },
      inventory: win,
      pathfinder: { goal: null, setGoal() {}, stop() {}, isMoving: () => false },
      recipesFor: (id) => (id === 18 ? [{ result: { name: 'oak_planks', count: 4 } }] : []),
      craft: async (recipe, count) => {
        for (let k = 0; k < count; k++) {
          calls.craft++
          const src = win.slots.findIndex((it, i) => i >= 9 && it && it.name === 'oak_log')
          if (src < 0) throw new Error('missing ingredient')
          const stack = win.slots[src]
          win.slots[src] = null
          stack.count -= 1
          if (win.slots[4] && win.slots[4].name === 'oak_log') win.slots[4].count += 1
          else {
            const dest = logItem(1)
            dest.slot = 4
            win.slots[4] = dest
          }
          const after = resultNow()
          if (after === lastResult) {
            if (stack.count > 0) stash(win, stack)
            throw new Error(TIMEOUT_MSG)
          }
          lastResult = after
          if (stack.count > 0) stash(win, stack)
          win.slots[4].count -= 1
          if (win.slots[4].count <= 0) win.slots[4] = null
          stash(win, planksItem(4))
          lastResult = resultNow()
        }
      },
      clickWindow: async (slot, button, mode) => {
        assert.equal(mode, 1) // the clearer only shift-clicks
        const item = win.slots[slot]
        if (!item) return
        win.slots[slot] = null
        stash(win, item)
        const after = resultNow()
        if (after === lastResult) throw new Error(TIMEOUT_MSG)
        lastResult = after
      },
      putSelectedItemRange: async () => {},
      closeWindow: async () => {},
      blockAt: () => null,
      chat: (line) => { lines.push(String(line)) },
    }
    return bot
  }

  it('14 + 1 stranded log convert to 60 planks in one step, then done', async () => {
    const bot = craftBot({ gridLogs: 1, invLogs: 14 })
    const ticker = createTicker({ bot, brain: workBrain(), tickMs: 10, idleTickMs: 10 })
    const ctx = bot._tickerCtx
    ctx.work = true
    const cap = capture()
    try {
      const r1 = await ticker.tick()
      assert.equal(r1.decision.action, 'craft', 'a full load crafts first')
      await untilCrafts(bot, 15)
      assert.deepEqual(gridOf(bot.inventory), [], 'stranded log returned, grid clear')
      assert.equal(countIn(bot.inventory, 'oak_log'), 0, 'whole batch converted')
      assert.equal(countIn(bot.inventory, 'oak_planks'), 60)
      assert.equal(bot.calls.craft, 15, 'one count=1 op per log')
      assert.ok(bot.lines.some((l) => l === 'crafted 60 oak_planks (planks 60, logs 0)'),
        `one chat with the total: ${bot.lines.join(' | ')}`)
      const r2 = await ticker.tick() // facts flipped: table attempt, no recipe, done
      await settle()
      assert.equal(ctx.stepStatus, 'done')
      assert.equal(r2.decision.action, 'craft')
      assert.ok(!String(ctx.stepStatus).startsWith('failed'), 'never failed')
    } finally {
      cap.release()
      ticker.destroy()
    }
  })

  // oqul.2 characterization: an interruption lands while craft awaits
  // bot.craft, then the old op settles. idkcraft-oqul.7 flipped stop and
  // 'go work': both bump ctx.stepGen (resetNightStep), so the late failure
  // of the op craft started under the old gen drops. destroy bumps nothing
  // (a dead ctx) and a late success writes no stepStatus, so those stand.
  async function interrupted(interrupt, settleWith) {
    const bot = craftBot({ invLogs: 14 })
    let release = null
    const realCraft = bot.craft
    bot.craft = async (...args) => {
      if (!release) await new Promise((resolve, reject) => { release = { resolve, reject } })
      return realCraft(...args)
    }
    const ticker = createTicker({ bot, brain: workBrain(), tickMs: 10, idleTickMs: 10 })
    const ctx = bot._tickerCtx
    ctx.work = true
    const cap = capture()
    try {
      const r1 = await ticker.tick()
      assert.equal(r1.decision.action, 'craft')
      for (let i = 0; i < 200 && !release; i++) await new Promise((r) => setTimeout(r, 5))
      assert.ok(release, 'craft parked inside bot.craft')
      assert.equal(ctx.craftInFlight, true)
      interrupt(bot, ticker, ctx)
      const after = { step: ctx.step, stepStatus: ctx.stepStatus, craftInFlight: ctx.craftInFlight }
      if (settleWith === 'reject') release.reject(new Error(TIMEOUT_MSG))
      else release.resolve()
      await untilSettled(ctx)
      return { after, late: { step: ctx.step, stepStatus: ctx.stepStatus, craftInFlight: ctx.craftInFlight }, lines: bot.lines.slice() }
    } finally {
      cap.release()
      ticker.destroy()
    }
  }

  async function untilSettled(ctx) {
    for (let i = 0; i < 400 && ctx.craftInFlight; i++) await new Promise((r) => setTimeout(r, 5))
    await settle()
  }

  it('stop mid-craft: the late failure drops (oqul.7)', async () => {
    const { after, late } = await interrupted((bot, ticker) => ticker.stop(), 'reject')
    assert.equal(after.craftInFlight, true, 'stop leaves the op in flight')
    assert.equal(late.stepStatus, after.stepStatus, 'stale completion drops: the stopped episode keeps its status')
    assert.equal(late.craftInFlight, false)
  })

  it("a new order ('go work') mid-craft: reset step, the late failure drops (oqul.7)", async () => {
    const { after, late } = await interrupted((bot, ticker) => ticker.work(), 'reject')
    assert.equal(after.step, null, 'the order reset the step')
    assert.equal(after.stepStatus, null)
    assert.equal(late.step, null, 'no new step picked between')
    assert.equal(late.stepStatus, null, 'the old craft no longer writes into the fresh episode')
  })

  it('death + respawn mid-craft: the late success still chats and frees the latch (pinned, oqul.7)', async () => {
    const { after, late, lines } = await interrupted((bot, ticker) => {
      const life = createLifecycle(ticker)
      life.onDeath(bot)
      life.onRespawn(bot)
    }, 'resolve')
    assert.equal(after.craftInFlight, true, 'the respawn does not cancel the op')
    assert.equal(late.craftInFlight, false)
    assert.equal(late.stepStatus, after.stepStatus, 'a successful late op writes no stepStatus')
    assert.ok(lines.some((l) => /^crafted \d+ oak_planks/.test(l)), `the dead body's op still chats: ${lines.join(' | ')}`)
  })

  it('destroy mid-craft: the late failure still writes into the dead ticker ctx (pinned, oqul.7)', async () => {
    const { late } = await interrupted((bot, ticker) => ticker.destroy(), 'reject')
    assert.equal(late.stepStatus, 'failed:craft-oak_planks')
    assert.equal(late.craftInFlight, false)
  })
})

describe('xoj: fresh site builds instead of deadlocking the menu', () => {
  // Prod xoj: on an empty site build waited for the door, the door waited
  // for a placed table, the table was placed only by build — build feasible
  // in 0 of 37 goal steps. Fixed: only the NEXT cell's item gates, and the
  // table lays first. E2E: the table->door chain through work-mode ticks.
  const build = require('../src/behaviours/build')
  const BLUEPRINT_V2 = build.BLUEPRINT_V2
  const goal = require('../src/goal')

  function makeWorld() {
    const cells = new Map()
    const key = (x, y, z) => `${Math.floor(x)},${Math.floor(y)},${Math.floor(z)}`
    return {
      set(x, y, z, name) { cells.set(key(x, y, z), name) },
      get(x, y, z) { return cells.get(key(x, y, z)) },
      blockAt(p) {
        const fx = Math.floor(p.x)
        const fy = Math.floor(p.y)
        const fz = Math.floor(p.z)
        const k = key(fx, fy, fz)
        const name = cells.has(k) ? cells.get(k) : (fy <= 63 ? 'dirt' : 'air')
        return { name, boundingBox: name === 'air' ? 'empty' : 'block', position: { x: fx, y: fy, z: fz } }
      },
    }
  }

  function workBot(world, items) {
    const chats = []
    const calls = { goals: [], places: [], digs: [], equips: [] }
    const bot = {
      chats,
      calls,
      username: 'IdkBot',
      players: { Steve: { username: 'Steve' } }, // roster online, target unseen
      entities: {},
      spawnPoint: pos(0, 64, 0),
      entity: { position: pos(11, 64, 2) }, // next to the table cell
      world: { getBlock: () => null },
      held: null,
      inventory: { items: () => items },
      blockAt: (p) => world.blockAt(p),
      findBlocks: () => [],
      pathfinder: {
        goal: null,
        setGoal(g) { calls.goals.push(g); bot.pathfinder.goal = g },
        stop() {},
        isMoving: () => false,
      },
      equip: async (item, dest) => { calls.equips.push([item.name, dest]); bot.held = item.name },
      dig: async (b) => {
        calls.digs.push(b.name)
        world.set(b.position.x, b.position.y, b.position.z, 'air')
      },
      placeBlock: async (ref, face) => {
        calls.places.push([ref, face])
        const rp = (ref && ref.position) || ref
        world.set(rp.x + face.x, rp.y + face.y, rp.z + face.z, bot.held)
      },
      chat: (m) => { chats.push(String(m)) },
    }
    return bot
  }

  function paintHouse(world, home) {
    for (const cell of build.blueprintFor(home)) {
      const name = cell.kind === 'table' ? 'crafting_table' : cell.kind === 'door' ? 'oak_door' : 'oak_planks'
      world.set(home.site.x + cell.dx, home.site.y + cell.dy, home.site.z + cell.dz, name)
    }
  }

  it('table lays, door crafts at it, door lays — build picked throughout', async () => {
    const world = makeWorld()
    const items = [
      { name: 'oak_planks', count: 45 },
      { name: 'crafting_table', count: 1 },
      // Geared (atl.6): without tools the arbiter rearms first, which is a
      // different step, not the xoj deadlock.
      { name: 'stone_sword', count: 1 },
      { name: 'stone_pickaxe', count: 1 },
      { name: 'dirt', count: 32 },
    ]
    const bot = workBot(world, items)
    bot.registry = { itemsByName: { oak_door: { id: 19 } } }
    bot.recipesFor = (id) => (id === 19 ? [{ result: { name: 'oak_door', count: 1 } }] : [])
    const crafted = []
    bot.craft = async (recipe, count, table) => {
      crafted.push({ recipe, count, table: table && table.name })
      items.push({ name: 'oak_door', count: 1 })
    }
    const ticker = createTicker({ bot, brain: workBrain(), tickMs: 10, idleTickMs: 10 })
    const ctx = bot._tickerCtx
    ctx.work = true
    ctx.home = goal.siteFor(bot, pos(0, 64, 0)) // fresh site, nothing built
    const s = ctx.home.site
    const cap = capture()
    const actions = []
    const step = async () => {
      const r = await ticker.tick()
      actions.push(r.decision && r.decision.action)
      await settle(2)
      return r
    }
    try {
      // 1. Fresh site with a table item but no door: build, not deadlock.
      const r1 = await step()
      assert.equal(r1.decision.action, 'build', 'fresh site builds (table first)')
      let t = 0
      for (; t < 20 && !ctx.home.table; t++) await step()
      assert.ok(ctx.home.table, 'table placed and claimed')
      assert.equal(world.get(s.x + 5, s.y, s.z + 1), 'crafting_table')

      // 2. Ring done elsewhere, door cell next, no door: craft makes it.
      paintHouse(world, ctx.home)
      world.set(s.x + 3, s.y, s.z, 'air') // only the door cell is open
      t = 0
      for (; t < 20 && !items.some((i) => i.name === 'oak_door'); t++) await step()
      assert.ok(actions.includes('craft'), `craft picked for the door: ${actions.join(',')}`)
      assert.equal(crafted.length, 1)
      assert.equal(crafted[0].recipe.result.name, 'oak_door')
      assert.equal(crafted[0].table, 'crafting_table', 'door crafts at the placed table')

      // 3. Door in hand: build lays it, the chain completes.
      t = 0
      for (; t < 20 && world.get(s.x + 3, s.y, s.z) !== 'oak_door'; t++) await step()
      assert.equal(world.get(s.x + 3, s.y, s.z), 'oak_door', 'door laid')
      assert.ok(!actions.includes('rest'), `never deadlocked to rest: ${actions.join(',')}`)
    } finally {
      cap.release()
      ticker.destroy()
    }
  })
})

describe('cww: roof approach leaves its own wall standing', () => {
  // Prod cww: the first roof-cell approach dug a wall corner through
  // GoalPlaceBlock + canDig, and the rebuild took priority every other tick
  // (23/40<->24/40 for 10+ min). Fixed: guardOwnWalls vetoes breaking the
  // house. E2E: the roof drive with a digging executor through work ticks.
  const BLUEPRINT_V2 = require('../src/behaviours/build').BLUEPRINT_V2
  const goal = require('../src/goal')

  const REG = { oak_planks: { id: 5 }, oak_log: { id: 17 }, dirt: { id: 3 }, oak_door: { id: 64 }, crafting_table: { id: 998 } }

  function makeWorld() {
    const cells = new Map()
    const key = (x, y, z) => `${Math.floor(x)},${Math.floor(y)},${Math.floor(z)}`
    return {
      set(x, y, z, name) { cells.set(key(x, y, z), name) },
      get(x, y, z) { return cells.get(key(x, y, z)) },
      blockAt(p) {
        const fx = Math.floor(p.x)
        const fy = Math.floor(p.y)
        const fz = Math.floor(p.z)
        const k = key(fx, fy, fz)
        const name = cells.has(k) ? cells.get(k) : (fy <= 63 ? 'dirt' : 'air')
        return { name, boundingBox: name === 'air' ? 'empty' : 'block', position: { x: fx, y: fy, z: fz } }
      },
    }
  }

  function breakVetoed(mov, name, id, x, y, z) {
    if (id != null && mov && mov.blocksCantBreak && mov.blocksCantBreak.has(id)) return true
    if (mov && Array.isArray(mov.exclusionAreasBreak)) {
      const block = { type: id, name, position: { x, y, z } }
      for (const f of mov.exclusionAreasBreak) {
        try { if (f(block) >= 100) return true } catch (_) { /* veto best-effort */ }
      }
    }
    return false
  }

  // Fake executor with canDig pathing: on a GoalPlaceBlock it breaks into
  // the path at once (first solid cell on the straight segment) unless the
  // guard vetoes the break — then walks one more tick and arrives.
  function diggingSetGoal(bot, world, transit) {
    return (g) => {
      bot.calls.goals.push(g)
      bot.pathfinder.goal = g || null
      if (!g || g.constructor.name !== 'GoalPlaceBlock' || !g.pos) return
      const mov = bot.pathfinder.movements
      const bp = bot.entity.position
      const solidAt = (x, y, z) => {
        const name = world.get(x, y, z) ?? (y <= 63 ? 'dirt' : 'air')
        return name !== 'air' ? name : null
      }
      for (let t = 0.05; t < 1; t += 0.05) {
        const x = Math.floor(bp.x + (g.pos.x - bp.x) * t)
        const z = Math.floor(bp.z + (g.pos.z - bp.z) * t)
        for (const y of [Math.floor(bp.y), Math.floor(bp.y) + 1]) {
          const name = solidAt(x, y, z)
          if (!name || name.endsWith('_door') || name === 'crafting_table') continue
          const id = REG[name] != null ? REG[name].id : null
          if (breakVetoed(mov, name, id, x, y, z)) continue // routes around
          world.set(x, y, z, 'air')
          bot.calls.digs.push(name)
          bot._moving = true
          transit.n = 1
          return
        }
      }
      bot._moving = true
      transit.n = 1
    }
  }

  it('roof completes with walls standing, build never flaps away', async () => {
    const world = makeWorld()
    const items = [
      { name: 'oak_planks', count: 40 },
      { name: 'crafting_table', count: 1 },
      { name: 'oak_door', count: 1 },
      { name: 'stone_sword', count: 1 },
      { name: 'stone_pickaxe', count: 1 },
      { name: 'dirt', count: 32 },
    ]
    const chats = []
    const calls = { goals: [], places: [], digs: [], equips: [] }
    const bot = {
      chats,
      calls,
      username: 'IdkBot',
      players: { Steve: { username: 'Steve' } },
      entities: {},
      spawnPoint: pos(0, 64, 0),
      entity: { position: pos(0, 65, 0) },
      world: { getBlock: () => null },
      registry: { blocksByName: REG },
      held: null,
      inventory: { items: () => items },
      blockAt: (p) => world.blockAt(p),
      findBlocks: () => [],
      _moving: false,
      pathfinder: {
        goal: null,
        setGoal(g) { calls.goals.push(g); bot.pathfinder.goal = g || null },
        stop() {},
        isMoving: () => bot._moving,
        movements: { blocksCantBreak: new Set(), exclusionAreasBreak: [] },
      },
      equip: async (item, dest) => { calls.equips.push([item.name, dest]); bot.held = item.name },
      dig: async (b) => {
        calls.digs.push(b.name)
        world.set(b.position.x, b.position.y, b.position.z, 'air')
      },
      placeBlock: async (ref, face) => {
        calls.places.push([ref, face])
        const rp = (ref && ref.position) || ref
        world.set(rp.x + face.x, rp.y + face.y, rp.z + face.z, bot.held)
      },
      chat: (m) => { chats.push(String(m)) },
    }
    const ticker = createTicker({ bot, brain: workBrain(), tickMs: 10, idleTickMs: 10 })
    const ctx = bot._tickerCtx
    ctx.work = true
    ctx.home = goal.siteFor(bot, pos(0, 64, 0))
    const s = ctx.home.site
    for (const cell of BLUEPRINT_V2) {
      if (cell.dy === 2) continue // roof not started
      world.set(s.x + cell.dx, s.y + cell.dy, s.z + cell.dz,
        cell.kind === 'table' ? 'crafting_table' : cell.kind === 'door' ? 'oak_door' : 'oak_planks')
    }
    bot.entity.position = pos(s.x + 3, s.y, s.z + 2) // inside: the static body must reach the whole roof
    const transit = { n: 0 }
    bot.pathfinder.setGoal = diggingSetGoal(bot, world, transit)
    const cap = capture()
    const actions = []
    try {
      let t = 0
      for (; t < 400 && !ctx.home.built; t++) {
        if (transit.n > 0 && --transit.n === 0) bot._moving = false
        const r = await ticker.tick()
        actions.push(r.decision && r.decision.action)
        await settle(2)
      }
      assert.ok(ctx.home.built, `roof completes in ${t} ticks`)
      assert.equal(ctx.stepStatus, 'done')
      assert.deepEqual(bot.calls.digs.filter((n) => n.endsWith('_planks')), [], 'no wall plank dug')
      for (let dz = 0; dz <= 5; dz++) {
        for (let dx = 0; dx <= 6; dx++) {
          assert.equal(world.get(s.x + dx, s.y + 2, s.z + dz), 'oak_planks', `roof ${dx},${dz} laid`)
        }
      }
      assert.ok(actions.length > 0 && actions.every((a) => a === 'build'),
        `build owns every tick, no flap: ${[...new Set(actions)].join(',')}`)
    } finally {
      cap.release()
      ticker.destroy()
    }
  })
})

describe('8si: the house drive keeps the door and the doorway', () => {
  // Prod 8si: the approach dug the oak door (breaking adopt — no door near
  // spawn) and misplaced planks into the doorway. Fixed: the guard covers
  // door/workbench cells and the doorway-interior invariant skips plank
  // targets there. E2E: the full hostile-executor drive through work ticks,
  // with one interior planks cell injected into the plan so the invariant
  // half is reachable (stock BLUEPRINT has no interior targets).
  const BLUEPRINT_V2 = require('../src/behaviours/build').BLUEPRINT_V2
  const goal = require('../src/goal')

  const REG = { oak_planks: { id: 5 }, oak_log: { id: 17 }, dirt: { id: 3 }, oak_door: { id: 64 }, crafting_table: { id: 998 } }

  function makeWorld() {
    const cells = new Map()
    const key = (x, y, z) => `${Math.floor(x)},${Math.floor(y)},${Math.floor(z)}`
    return {
      set(x, y, z, name) { cells.set(key(x, y, z), name) },
      get(x, y, z) { return cells.get(key(x, y, z)) },
      blockAt(p) {
        const fx = Math.floor(p.x)
        const fy = Math.floor(p.y)
        const fz = Math.floor(p.z)
        const k = key(fx, fy, fz)
        const name = cells.has(k) ? cells.get(k) : (fy <= 63 ? 'dirt' : 'air')
        return { name, boundingBox: name === 'air' ? 'empty' : 'block', position: { x: fx, y: fy, z: fz } }
      },
    }
  }

  function breakVetoed(mov, name, id, x, y, z) {
    if (id != null && mov && mov.blocksCantBreak && mov.blocksCantBreak.has(id)) return true
    if (mov && Array.isArray(mov.exclusionAreasBreak)) {
      const block = { type: id, name, position: { x, y, z } }
      for (const f of mov.exclusionAreasBreak) {
        try { if (f(block) >= 100) return true } catch (_) { /* veto best-effort */ }
      }
    }
    return false
  }

  // Hostile executor: digs anything breakable on the segment (doors and
  // tables included — cww's harness exempted them, live the door got eaten).
  // Guarded ids route around. Arrival overshoots east, so later segments
  // cross the standing house past the table cell and the door.
  function hostileSetGoal(bot, world, transit) {
    return (g) => {
      bot.calls.goals.push(g)
      bot.pathfinder.goal = g || null
      if (!g || g.constructor.name !== 'GoalPlaceBlock' || !g.pos) return
      const mov = bot.pathfinder.movements
      const bp = bot.entity.position
      const solidAt = (x, y, z) => {
        const name = world.get(x, y, z) ?? (y <= 63 ? 'dirt' : 'air')
        return name !== 'air' ? name : null
      }
      for (let t = 0.05; t < 1; t += 0.05) {
        const x = Math.floor(bp.x + (g.pos.x - bp.x) * t)
        const z = Math.floor(bp.z + (g.pos.z - bp.z) * t)
        for (const y of [Math.floor(bp.y), Math.floor(bp.y) + 1]) {
          const name = solidAt(x, y, z)
          if (!name) continue
          const id = REG[name] != null ? REG[name].id : null
          if (breakVetoed(mov, name, id, x, y, z)) continue // routes around
          world.set(x, y, z, 'air')
          bot.calls.digs.push(name)
          bot._moving = true
          transit.n = 1
          return
        }
      }
      bot.entity.position = pos(Math.floor(g.pos.x) + 2, g.pos.y, Math.floor(g.pos.z))
      bot._moving = true
      transit.n = 1
    }
  }

  it('full drive: door stands, doorway and interior plank-free, adopt stable', async () => {
    const world = makeWorld()
    const items = [
      { name: 'oak_planks', count: 40 },
      { name: 'crafting_table', count: 1 },
      { name: 'oak_door', count: 1 },
      { name: 'stone_sword', count: 1 },
      { name: 'stone_pickaxe', count: 1 },
      { name: 'dirt', count: 32 },
    ]
    const chats = []
    const calls = { goals: [], places: [], digs: [], equips: [] }
    const bot = {
      chats,
      calls,
      username: 'IdkBot',
      players: { Steve: { username: 'Steve' } },
      entities: {},
      spawnPoint: pos(0, 64, 0),
      entity: { position: pos(0, 65, 0) },
      world: { getBlock: () => null },
      registry: { blocksByName: REG },
      held: null,
      inventory: { items: () => items },
      blockAt: (p) => world.blockAt(p),
      findBlocks: () => [],
      _moving: false,
      pathfinder: {
        goal: null,
        setGoal(g) { calls.goals.push(g); bot.pathfinder.goal = g || null },
        stop() {},
        isMoving: () => bot._moving,
        movements: { blocksCantBreak: new Set(), exclusionAreasBreak: [] },
      },
      equip: async (item, dest) => { calls.equips.push([item.name, dest]); bot.held = item.name },
      dig: async (b) => {
        calls.digs.push(b.name)
        world.set(b.position.x, b.position.y, b.position.z, 'air')
      },
      placeBlock: async (ref, face) => {
        calls.places.push([ref, face])
        const rp = (ref && ref.position) || ref
        world.set(rp.x + face.x, rp.y + face.y, rp.z + face.z, bot.held)
      },
      chat: (m) => { chats.push(String(m)) },
    }
    const ticker = createTicker({ bot, brain: workBrain(), tickMs: 10, idleTickMs: 10 })
    const ctx = bot._tickerCtx
    ctx.work = true
    ctx.home = goal.siteFor(bot, pos(0, 64, 0))
    const s = ctx.home.site
    bot.entity.position = pos(s.x + 5, s.y, s.z + 1)
    const transit = { n: 0 }
    bot.pathfinder.setGoal = hostileSetGoal(bot, world, transit)
    const cap = capture()
    const actions = []
    const injected = { dx: 2, dy: 0, dz: 1, kind: 'planks' } // common-room target
    BLUEPRINT_V2.splice(1, 0, injected)
    try {
      let t = 0
      for (; t < 1200 && !ctx.home.built; t++) {
        if (transit.n > 0 && --transit.n === 0) bot._moving = false
        const r = await ticker.tick()
        actions.push(r.decision && r.decision.action)
        await settle(2)
      }
      assert.ok(ctx.home.built, `house completes in ${t} ticks`)
      assert.ok(ctx.buildSkip.includes(1), 'interior cell skipped by the invariant')
      // Drive over: restore the plan before adopt (it scans every cell).
      BLUEPRINT_V2.splice(BLUEPRINT_V2.indexOf(injected), 1)
      assert.deepEqual(bot.calls.digs.filter((n) => n.endsWith('_door') || n === 'crafting_table'),
        [], 'door and workbench never dug')
      assert.equal(world.get(s.x + 3, s.y, s.z), 'oak_door', 'doorway holds the door')
      for (const [dx, dz] of [[1, 1], [2, 1], [3, 1], [4, 1], [5, 1], [1, 2], [2, 2], [3, 2], [4, 2], [5, 2], [2, 3], [4, 3], [1, 4], [2, 4], [4, 4], [5, 4]]) {
        assert.ok(world.get(s.x + dx, s.y, s.z + dz) !== 'oak_planks', `interior ${dx},${dz} plank-free`)
        assert.ok(world.get(s.x + dx, s.y + 1, s.z + dz) !== 'oak_planks', `interior ${dx},${dz}+1 plank-free`)
      }
      bot.spawnPoint = pos(s.x, s.y, s.z)
      bot.findBlocks = () => {
        const out = []
        for (const [x, y, z] of [[s.x + 3, s.y, s.z], [s.x + 3, s.y + 1, s.z]]) {
          if (String(world.get(x, y, z) || '').endsWith('_door')) out.push(pos(x, y, z))
        }
        return out
      }
      const adopted = goal.adoptHome(bot)
      assert.ok(adopted, 'adopt finds the house after the drive')
      assert.equal(adopted.built, true, 'adopt sees it complete')
      assert.ok(actions.every((a) => a === 'build'), `build owns every tick: ${[...new Set(actions)].join(',')}`)
    } finally {
      const ix = BLUEPRINT_V2.indexOf(injected) // idempotent: already restored above unless an assert threw
      if (ix >= 0) BLUEPRINT_V2.splice(ix, 1)
      cap.release()
      ticker.destroy()
    }
  })
})

describe('vmzq.65: stranded-wood walk-out for a build order', () => {
  const taskMod = require('../src/task')
  const goal = require('../src/goal')
  const { goalOptions } = require('../src/goal-options')
  const { goalUnlock } = require('../src/goal-unlock')
  const resources = require('../src/resources')
  const gather = require('../src/behaviours/gather')
  const explore = require('../src/behaviours/explore')

  // Mountain site (0,64,0), no trees within 160; one oak stand 200 north.
  // Flat stone plain under air: loaded everywhere, honest distances.
  const OAKS = [[0, 64, -200], [0, 65, -200], [0, 66, -200]]
  const LEAVES = [[0, 67, -200], [1, 66, -200], [-1, 66, -200], [1, 67, -200], [-1, 67, -200]]
  const WATCHDOG_ENV = ['GOAL_WATCHDOG_MS', 'GOAL_COMMIT_MS', 'GOAL_WATCHDOG_MAX_ROUNDS', 'GOAL_TRAVEL_GRACE_MS', 'GOAL_PLANB_SWITCH_MS']

  function worldBot() {
    const names = {}
    for (const [x, y, z] of OAKS) names[`${x},${y},${z}`] = 'oak_log'
    for (const [x, y, z] of LEAVES) names[`${x},${y},${z}`] = 'oak_leaves'
    const spots = OAKS.map(([x, y, z]) => pos(x, y, z))
    const blocksByName = { oak_log: { id: 17 }, birch_log: { id: 18 }, stone: { id: 1 }, iron_ore: { id: 2 }, coal_ore: { id: 3 } }
    const lines = []
    const calls = { setGoal: 0, goals: [] }
    const bot = {
      lines,
      calls,
      username: 'IdkBot',
      players: { Steve: {} }, // roster online, entity unseen: player reads far
      entities: {},
      entity: { position: pos(0, 64, 0), onGround: true, isInWater: false },
      registry: { blocksByName },
      _moving: false,
      _items: [{ name: 'stone_pickaxe', count: 1 }], // the planForage ore gate
      spawnPoint: pos(0, 64, 0),
      time: { timeOfDay: 6000, day: 1 }, // stays day for the whole walk
      health: 20,
      food: 20,
      oxygenLevel: 20,
      pathfinder: {
        goal: null,
        setGoal: (g) => { calls.setGoal++; calls.goals.push(g); bot.pathfinder.goal = g },
        stop() {},
        isMoving: () => bot._moving,
        isMining: () => false,
        isBuilding: () => false,
      },
      inventory: { items: () => bot._items },
      findBlocks(opts) {
        const want = new Set(Array.isArray(opts.matching) ? opts.matching : [opts.matching])
        const origin = opts.point || bot.entity.position
        const maxD = typeof opts.maxDistance === 'number' ? opts.maxDistance : Infinity
        const out = []
        for (const q of spots) {
          const n = names[`${q.x},${q.y},${q.z}`]
          const id = n && blocksByName[n] ? blocksByName[n].id : undefined
          if (!want.has(id)) continue
          if (Math.hypot(q.x - origin.x, q.y - origin.y, q.z - origin.z) > maxD) continue
          out.push(q)
        }
        return typeof opts.count === 'number' ? out.slice(0, opts.count) : out
      },
      blockAt(p) {
        const x = Math.floor(p.x)
        const y = Math.floor(p.y)
        const z = Math.floor(p.z)
        const name = names[`${x},${y},${z}`] || (y <= 64 ? 'stone' : 'air')
        return { name, position: pos(x, y, z), boundingBox: name === 'air' ? 'empty' : 'block' }
      },
      canDigBlock: () => true,
      dig: async () => {},
      setControlState() {},
      getControlState: () => false,
      clearControlStates() {},
      chat(line) { lines.push(String(line)) },
    }
    return bot
  }

  it('watchdog commits explore-far, the bot relocates, gather takes the 200-block log with no unlock', async () => {
    const bot = worldBot()
    const clock = fakeClock(1000000000000)
    const cap = capture()
    const transitions = []
    const mark = (line) => { transitions.push(line); console.log(line) } // one console line per transition
    const statuses = [] // every stepStatus seen across the behaviour ticks
    const savedEnv = {}
    for (const k of WATCHDOG_ENV) {
      savedEnv[k] = process.env[k]
      delete process.env[k]
    }
    const ticker = createTicker({ bot, brain: workBrain(), tickMs: 10, idleTickMs: 10 })
    let t = 1000000000000
    try {
      ticker.setHome({ site: { x: 0, y: 64, z: 0 }, built: false, v: 2 })
      ticker.work()
      const ctx = bot._tickerCtx
      ctx.step = 'gather'
      ctx.stepStatus = 'running'
      taskMod.taskTick(bot, ctx, t)
      assert.equal(ctx.task.active, 'house')

      // Phase A: gather runs the staged search, finds nothing, fails honest.
      for (let i = 0; i < 200 && !(ctx.gather && ctx.gather.final); i++) {
        t += 1000
        clock.advance(1000)
        gather(bot, ctx, null, {})
        statuses.push(ctx.stepStatus)
      }
      assert.equal(ctx.stepStatus, 'failed:no-trees')
      assert.equal(ctx.gather.farEmpty, true, 'stranded record set')
      mark(`T1 gather failed:no-trees at t+${Math.round((t - 1000000000000) / 1000)}s, farEmpty set`)
      // The stranded menu opens with the owner online (fix 1, menu side).
      assert.equal((await goal.decide(bot, ctx)).action, 'explore')
      ctx.step = 'gather' // the stall stays on gather for the watchdog rounds
      ctx.stepStatus = 'failed:no-trees'

      // Phase B: a remembered ore past 64 joins the table; two undecided
      // rounds fall back to explore-far (fixes 1+3, table side).
      resources.noteSpots(ctx, [{ x: 100, y: 64, z: 0, name: 'iron_ore', exposed: true }], t)
      const skips = []
      const ids = goalOptions(bot, ctx, 'house', skips).map((o) => o.id)
      assert.ok(ids.includes('explore-far'), `explore-far offered: ${ids}`)
      assert.ok(!skips.some((s) => s.id === 'explore-far'), `no explore-far skip: ${JSON.stringify(skips)}`)
      assert.equal(goalOptions(bot, ctx, 'house').find((o) => o.id === 'forage-far').wood, false)
      const lowConf = { step: 'gather', confidence: 0.2, probabilities: { gather: 0.3 }, source: 'jev' }
      for (const round of [1, 2]) {
        ctx.brain = { plan: async () => lowConf }
        let guard = 0
        while (!(ctx.task.house.wd && ctx.task.house.wd.pending) && guard++ < 60) {
          t += 10000
          clock.advance(10000)
          taskMod.taskTick(bot, ctx, t)
        }
        assert.ok(ctx.task.house.wd.pending, `round ${round} fired`)
        await settle()
        t += 10000
        clock.advance(10000)
        taskMod.taskTick(bot, ctx, t) // consume
      }
      const commit = ctx.goal && ctx.goal.commit
      assert.ok(commit, 'fallback applied')
      assert.equal(commit.optionId, 'explore-far')
      assert.equal(commit.unlock && commit.unlock.radius, 256)
      mark(`T2 watchdog fallback committed explore-far at t+${Math.round((t - 1000000000000) / 1000)}s`)

      // Phase C: the walk outlasts the 120 s window — run it out, then
      // relocate north with no unlock live (fix 4 needs no window).
      let guard = 0
      while (ctx.goal && ctx.goal.commit && guard++ < 40) {
        t += 10000
        clock.advance(10000)
        taskMod.taskTick(bot, ctx, t)
      }
      assert.equal((ctx.goal && ctx.goal.commit) || null, null, 'window ended')
      assert.equal(goalUnlock(ctx, 'radius'), null, 'no unlock live for the walk')
      // Home ground already walked: rings 16-64 visited, so the relocation
      // leg leaves at ring 128 — past the 64 leash, only on the lift.
      ctx.explore = { visited: new Set(), target: null, lastPos: null, stalls: 0, markStart: 0, chatAt: 0 }
      for (const r of [16, 32, 64]) {
        for (let a = 0; a < 8; a++) {
          const x = Math.round(r * Math.sin(a * Math.PI / 4))
          const z = Math.round(-r * Math.cos(a * Math.PI / 4))
          ctx.explore.visited.add(`${Math.floor(x / 16)},${Math.floor(z / 16)}`)
        }
      }
      const failPos = ctx.gather.failPos
      for (let i = 0; i < 60; i++) {
        t += 1000
        clock.advance(1000)
        explore(bot, ctx, null, null)
        statuses.push(ctx.stepStatus)
        const target = ctx.explore && ctx.explore.target
        if (target) {
          const bp = bot.entity.position
          const dx = target.x - bp.x
          const dz = target.z - bp.z
          const d = Math.hypot(dx, dz)
          if (d > 0.01) {
            const step = Math.min(16, d)
            bot.entity.position = pos(bp.x + (dx / d) * step, 64, bp.z + (dz / d) * step)
          }
        }
        const bp = bot.entity.position
        if (Math.hypot(bp.x - failPos.x, bp.z - failPos.z) > 32 && Math.hypot(bp.x, bp.z + 200) <= 160) break
      }
      const relocated = bot.entity.position
      assert.ok(Math.hypot(relocated.x - failPos.x, relocated.z - failPos.z) > 32, 'relocated past the failure point')
      mark(`T3 relocated to ${Math.round(relocated.x)} ${Math.round(relocated.z)}, oaks ${Math.round(Math.hypot(relocated.x, relocated.z + 200))} away`)

      // Phase D: gather retries at new ground and takes the far log.
      ctx.step = 'gather'
      ctx.stepStatus = 'running' // decide() marks running on every pick
      for (let i = 0; i < 200 && !/^gather:/.test(ctx.lastGoalKey || ''); i++) {
        t += 1000
        clock.advance(1000)
        gather(bot, ctx, null, {})
        statuses.push(ctx.stepStatus)
      }
      assert.match(ctx.lastGoalKey, /^gather:0,6[456],-200$/, 'a trunk cell of the 200-block stand')
      assert.equal(goalUnlock(ctx, 'radius'), null, 'the far pick rode the stranded lift, not a window')
      assert.equal(ctx.stepStatus, 'running')
      mark(`T4 ${ctx.lastGoalKey} committed with no unlock live`)

      // failed:unreachable never surfaces — on the status channel the
      // behaviours report through, and in chat (revmux 01 minor).
      assert.ok(!statuses.includes('failed:unreachable'), `statuses: ${[...new Set(statuses)].join(',')}`)
      assert.ok(!bot.lines.some((l) => l === 'cannot reach the trees'), `chat: ${bot.lines.join(' | ')}`)
      // Bot-own evidence per transition, not the mark lines themselves.
      assert.ok(bot.lines.includes('no trees within 48 blocks'), `give-up chat: ${bot.lines.join(' | ')}`)
      assert.ok(cap.lines.some((l) => l.includes('choice=explore-far') && l.includes('source=fallback')), 'fallback watchdog line')
      assert.ok(bot.lines.some((l) => /^going for oak_log, \d+ blocks away$/.test(l)), `far commit chat: ${bot.lines.join(' | ')}`)
    } finally {
      for (const k of WATCHDOG_ENV) {
        if (savedEnv[k] === undefined) delete process.env[k]
        else process.env[k] = savedEnv[k]
      }
      cap.release()
      clock.restore()
      ticker.destroy()
      for (const line of transitions) console.log(line)
    }
  })
})
