'use strict'

// E2E scenarios, batch 3b (idkcraft-8s7): closed rest/memory bugs replayed
// through work-mode ticks. The behaviour-level tests drive rest()/roam-back/
// save()/restore() directly; the prod symptoms were tick cycles — a rest
// step pulling into a pit for 82 min without escalation, a restart walking
// away from the player to a site trap, a deploy forgetting an unfinished
// home.

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const os = require('node:os')
const path = require('node:path')
const fs = require('node:fs')
const { createTicker } = require('../src/index')

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

async function flush(n = 2) {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r))
}

function workBrain() {
  return { async decide() { return { action: 'idle', sprint: false, source: 'stub' } } }
}

describe('q0h: rest pit escalates instead of spinning episodes', () => {
  // Prod q0h: 82 min of rest pulling into a low pit, 388 recover choices,
  // 26 gave-ups, step never failed. Fixed: the roam-back walk raises WITH
  // the site goal (the menu climbs toward it instead of blind), and
  // consecutive rest gave-ups fail the step + mark the point, so the
  // arbiter reconsiders and no new episode starts there until relocation.
  const key = (x, y, z) => `${x},${y},${z}`

  function pitBot() {
    // 1x3 dirt pit (fja shape): two walls, so sidestep stays feasible next
    // to dig_step — the 4-wall pit offers only dig+wait and wait-done ends
    // every episode before any gave-up can land.
    const solids = new Set()
    for (let x = -3; x <= 3; x++) {
      for (let z = -1; z <= 1; z++) solids.add(key(x, 60, z))
    }
    for (let y = 61; y <= 64; y++) {
      for (let x = -2; x <= 2; x++) { solids.add(key(x, y, -1)); solids.add(key(x, y, 1)) }
      solids.add(key(-2, y, 0)); solids.add(key(2, y, 0))
    }
    const calls = { setGoal: 0, goals: [] }
    const bot = {
      calls,
      username: 'IdkBot',
      players: {}, // autonomous: nobody online, like the prod window
      entities: {},
      entity: { position: pos(0.5, 61, 0.5), onGround: true },
      inventory: { items: () => [] }, // no scaffold, no pickaxe
      _moving: true, // wedged executor: drives while the body stands
      chats: [],
      controls: {},
      pathfinder: {
        goal: null,
        setGoal: (g) => { calls.setGoal++; calls.goals.push(g); bot.pathfinder.goal = g || null },
        stop() {},
        isMoving: () => bot._moving,
      },
      blockAt(p) {
        const k = key(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z))
        const solidCell = solids.has(k)
        return {
          name: solidCell ? 'dirt' : 'air',
          position: { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) },
          boundingBox: solidCell ? 'block' : 'empty',
        }
      },
      async dig(block) { solids.delete(key(block.position.x, block.position.y, block.position.z)) },
      chat(m) { bot.chats.push(String(m)) },
      setControlState(c, v) { bot.controls[c] = !!v },
      getControlState(c) { return !!bot.controls[c] },
      clearControlStates() { bot.controls = {} },
      look() {},
    }
    return bot
  }

  it('roam-back raises with the site goal; 2nd gave-up fails rest and holds the point', async () => {
    const bot = pitBot()
    // The model answers like prod laya (dig/side churn: 42 dig_step, 187
    // sidestep in the prod window): without failing picks the menu falls to
    // wait-done and no gave-up ever lands. The script walks dig -> side ->
    // dig; the 4jr exclusion + FSM fallback keep every answer honest (an
    // invalid label would fall back, not crash).
    const asks = []
    const brain = {
      async decide() { return { action: 'idle', sprint: false, source: 'stub' } },
      async ask(q) {
        asks.push(Object.keys(q.criteria))
        return ['dig_step', 'sidestep', 'dig_step'][asks.length - 1] || 'dig_step'
      },
    }
    const ticker = createTicker({ bot, brain, tickMs: 10, idleTickMs: 10, autonomous: true })
    const ctx = bot._tickerCtx
    // Post-'cannot reach the trees' state (the prod precondition): gather
    // held, rest running, one gave-up already counted. Night pin (gyw): an
    // alone day with a holding gather now explores, but the wedge/gave-up
    // mechanics under test are time-blind — night keeps the steady rest.
    bot.time = { timeOfDay: 18000 }
    ctx.work = true
    ctx.home = { site: { x: 20, y: 65, z: 0 } }
    ctx.step = 'rest'
    ctx.stepStatus = 'running'
    ctx.restGaveUps = 1
    ctx.gather = { final: 'failed:unreachable', atLogs: 0 }
    const cap = capture()
    const actions = []
    try {
      const r1 = await ticker.tick()
      actions.push(r1.decision.action)
      assert.equal(r1.decision.action, 'rest')
      assert.match(ctx.lastGoalKey, /^roam-back:/, 'rest walks back to the site')
      ticker.setPathReset('stuck')
      ticker.setPathReset('stuck')
      await ticker.tick()
      const wedge = cap.lines.filter((l) => l.includes('stuck reason=wedge'))
      assert.equal(wedge.length, 1, 'roam-back raises on the wedge')
      assert.deepEqual(ctx.stuck && ctx.stuck.goal, { x: 20, y: 65, z: 0 }, 'fact carries the site goal')
      assert.equal(ctx.stuck.by, 'roam')
      // The episode fails its prims on the static body; the gave-up is the
      // second, so the step fails and the point is marked.
      let t = 0
      for (; t < 160 && ctx.stepStatus !== 'failed:cannot-reach-home'; t++) {
        const r = await ticker.tick()
        actions.push(r.decision.action)
        await flush()
      }
      assert.ok(t < 160, `escalation fails the step (t=${t})`)
      assert.ok(ctx.restGaveUpAt, 'gave-up point marked')
      const wedgesAfterMark = cap.lines.filter((l) => l.includes('stuck reason=wedge')).length
      // The mark holds: wedged ticks stay silent, no new episode starts.
      for (let i = 0; i < 10; i++) {
        if (i === 5) { ticker.setPathReset('stuck'); ticker.setPathReset('stuck') }
        const r = await ticker.tick()
        actions.push(r.decision.action)
        await flush()
      }
      assert.equal(cap.lines.filter((l) => l.includes('stuck reason=wedge')).length, wedgesAfterMark,
        'no re-raise at the marked point')
      assert.equal(ctx.stuck || null, null, 'no fact while marked')
      // Relocation re-arms the detectors through ticks: one settle tick
      // (the move itself zeroes the wedge counter), then a fresh wedge.
      bot.entity.position = pos(6.5, 61, 0.5)
      await ticker.tick()
      assert.equal(ctx.stuck || null, null, 'settle tick raises nothing')
      ticker.setPathReset('stuck')
      ticker.setPathReset('stuck')
      await ticker.tick()
      assert.equal(cap.lines.filter((l) => l.includes('stuck reason=wedge')).length, wedgesAfterMark + 1,
        'relocation re-arms the roam-back detector')
      assert.ok(ctx.stuck, 'fact raises again past the mark')
    } finally {
      cap.release()
      ticker.destroy()
    }
  })
})

describe('p4s: playerless rest stays with the player, not the far site', () => {
  // Prod p4s: after a mid-session deploy the bot walked away from its owner
  // (dist 5.8 -> 64 in 20 s) to a site trap. Fixed: rest with a visible
  // player strolls near them; the site pull only applies with nobody
  // around. E2E: gather fails, rest strolls, the site never gets a goal.
  function restBot() {
    const bot = {
      username: 'IdkBot',
      players: {},
      entities: {},
      health: 20,
      food: 20,
      entity: { position: pos(0, 64, 0), onGround: true },
      registry: { blocksByName: { oak_log: { id: 17 } } },
      _moving: false,
      _goals: [],
      chats: [],
      controls: {},
      pathfinder: {
        goal: null,
        setGoal(g) { bot._goals.push(g); bot.pathfinder.goal = g || null },
        stop() {},
        isMoving: () => bot._moving,
        setMovements(m) { bot._movements = m },
      },
      setControlState(c, v) { bot.controls[c] = !!v },
      getControlState(c) { return !!bot.controls[c] },
      clearControlStates() { bot.controls = {} },
      chat(m) { bot.chats.push(String(m)) },
      inventory: { items: () => [] },
      blockAt(p) {
        const y = Math.floor(p.y)
        return y < 64 ? { name: 'dirt', boundingBox: 'block' } : { name: 'air', boundingBox: 'empty' }
      },
      findBlocks: () => [], // no trees anywhere
    }
    return bot
  }

  it('gather fails with no trees, rest strolls near the player', async () => {
    const bot = restBot()
    bot.players = { Steve: { username: 'Steve', entity: { id: 7, username: 'Steve', position: pos(3, 64, 0) } } }
    const ticker = createTicker({ bot, brain: workBrain(), tickMs: 10, idleTickMs: 10 })
    const ctx = bot._tickerCtx
    ctx.work = true
    ctx.home = { site: { x: 100, y: 64, z: 0 } } // the far trap
    const cap = capture()
    const actions = []
    try {
      let t = 0
      for (; t < 10 && ctx.step !== 'rest'; t++) {
        const r = await ticker.tick()
        actions.push(r.decision.action)
      }
      assert.ok(actions.includes('gather'), `gather tried first: ${actions.join(',')}`)
      assert.equal(ctx.step, 'rest', 'no trees -> rest')
      const mark = bot._goals.length
      for (let i = 0; i < 6; i++) {
        const r = await ticker.tick()
        actions.push(r.decision.action)
      }
      assert.ok(actions.slice(-6).every((a) => a === 'rest'), `rest holds: ${actions.join(',')}`)
      const strolls = bot._goals.slice(mark)
      assert.ok(strolls.length > 0, 'rest strolls')
      for (const g of strolls) {
        assert.equal(g.constructor.name, 'GoalNear', `stroll, not roam-back: ${g.constructor.name}`)
        assert.ok(Math.hypot(g.x - 3, g.z - 0) <= 10, `stroll stays near the player: ${g.x},${g.z}`)
      }
      assert.ok(!String(ctx.lastGoalKey).startsWith('roam-back'), `never walks to the site: ${ctx.lastGoalKey}`)
    } finally {
      cap.release()
      ticker.destroy()
    }
  })
})

describe('hlk: a deploy keeps the unfinished home', () => {
  // Prod hlk: ctx.home lived in memory only; a deploy mid-build forgot the
  // new site and adoptHome re-adopted the old door. Fixed: setHome saves a
  // JSON doc, the spawn handler restores it before adoption. E2E: home B
  // saved, ticker replaced, the restored site drives the very next build
  // tick (no goal at all without it — build returns with no site).
  const { goals } = require('mineflayer-pathfinder')

  function memBot() {
    return {
      username: 'IdkBot',
      game: { levelName: 'world' },
      spawnPoint: pos(0, 64, 0),
      players: {},
      entities: {},
      health: 20,
      food: 20,
      entity: { position: pos(48, 64, 48), onGround: true },
      world: { getBlock: () => null },
      _goals: [],
      chats: [],
      controls: {},
      pathfinder: {
        goal: null,
        setGoal(g) { this.goal = g },
        stop() {},
        isMoving: () => false,
        setMovements() {},
      },
      setControlState() {},
      getControlState: () => false,
      clearControlStates() {},
      chat() {},
      inventory: { items: () => [] },
      blockAt(p) {
        const y = Math.floor(p.y)
        return y < 64 ? { name: 'dirt', boundingBox: 'block' } : { name: 'air', boundingBox: 'empty' }
      },
      findBlocks: () => [],
    }
  }

  it('setHome saves; a new ticker restores site B and builds on it', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idkcraft-mem-'))
    const file = path.join(dir, 'IdkBot.json')
    const prevEnv = process.env.BOT_MEMORY_FILE
    process.env.BOT_MEMORY_FILE = file
    const cap = capture()
    try {
      const siteB = { x: 50, y: 64, z: 50 }
      const bot1 = memBot()
      const ticker1 = createTicker({ bot: bot1, brain: workBrain(), tickMs: 10, idleTickMs: 10 })
      ticker1.setHome({ site: siteB, built: false })
      assert.ok(fs.existsSync(file), 'setHome saved the doc')
      assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).homes.length, 1)
      ticker1.destroy() // deploy kills the process here
      const bot2 = memBot()
      bot2._items = [
        { name: 'oak_planks', count: 40 },
        { name: 'crafting_table', count: 1 },
        { name: 'oak_door', count: 1 },
        { name: 'stone_sword', count: 1 },
        { name: 'stone_pickaxe', count: 1 },
        { name: 'dirt', count: 32 },
      ]
      bot2.inventory = { items: () => bot2._items }
      const ticker2 = createTicker({ bot: bot2, brain: workBrain(), tickMs: 10, idleTickMs: 10, autonomous: true })
      const restored = ticker2.loadMemory() // the spawn handler restores first
      assert.ok(restored && restored.homes >= 1, `doc restored: ${JSON.stringify(restored)}`)
      const ctx2 = bot2._tickerCtx
      const rs = ctx2.home && ctx2.home.site
      assert.ok(rs && rs.x === 50 && rs.y === 64 && rs.z === 50,
        `site B back before any adopt, got ${JSON.stringify(rs)}`)
      ctx2.work = true
      const r = await ticker2.tick()
      assert.equal(r.decision.action, 'build', 'restored home builds at once')
      const g = bot2.pathfinder.goal
      assert.ok(g, 'approach goal issued')
      assert.ok(Math.hypot(g.pos.x - 54, g.pos.z - 51) <= 6, `goal at site B, got ${g.pos.x},${g.pos.z}`)
      ticker2.destroy()
    } finally {
      cap.release()
      if (prevEnv === undefined) delete process.env.BOT_MEMORY_FILE
      else process.env.BOT_MEMORY_FILE = prevEnv
      try { fs.rmSync(dir, { recursive: true, force: true }) } catch (_) { /* tmp best-effort */ }
    }
  })
})
