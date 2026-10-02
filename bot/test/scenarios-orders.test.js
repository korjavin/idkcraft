'use strict'

// E2E scenarios, batch 3a (idkcraft-ngf): closed order/fight bugs replayed
// through chat + ticks (handleChat -> createTicker + ticker.tick with order
// dispatch). The behaviour-level tests call lead()/fight() directly or stop
// at handleChat; the prod symptoms were tick loops — a lead hanging on a
// lying isMoving, a build order answered but never dispatched, a warning
// never sent, a fallback stopping the body it just re-tasked.

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { goals } = require('mineflayer-pathfinder')
const { createTicker, handleChat } = require('../src/index')

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

// Flat world (dirt below y=64) plus scripted extras by coord key.
function orderBot(extras = {}, regIds = {}) {
  const key = (x, y, z) => `${Math.floor(x)},${Math.floor(y)},${Math.floor(z)}`
  const bot = {
    username: 'IdkBot',
    players: {},
    entities: {},
    health: 20,
    food: 20,
    entity: { position: pos(0, 64, 0), onGround: true },
    registry: { blocksByName: regIds },
    _moving: false,
    _goals: [],
    _stops: 0,
    _attacks: 0,
    _items: [],
    chats: [],
    controls: {},
    pathfinder: {
      goal: null,
      setGoal(g) { bot._goals.push(g); bot.pathfinder.goal = g || null },
      stop() { bot._stops++ },
      isMoving: () => bot._moving,
      setMovements(m) { bot._movements = m },
    },
    setControlState(c, v) { bot.controls[c] = !!v },
    getControlState(c) { return !!bot.controls[c] },
    clearControlStates() { bot.controls = {} },
    chat(m) { bot.chats.push(String(m)) },
    attack() { bot._attacks++ },
    lookAt() {},
    equip() {},
    inventory: { items: () => bot._items },
    blockAt(p) {
      const k = key(p.x, p.y, p.z)
      if (extras[k]) return { name: extras[k], boundingBox: 'block', position: p }
      const y = Math.floor(p.y)
      return y < 64 ? { name: 'dirt', boundingBox: 'block', position: p } : { name: 'air', boundingBox: 'empty', position: p }
    },
    findBlocks(opts) {
      const want = new Set(Array.isArray(opts.matching) ? opts.matching : [opts.matching])
      const out = []
      for (const [k, name] of Object.entries(extras)) {
        const id = regIds[name] && regIds[name].id
        if (want.has(id)) {
          const [x, y, z] = k.split(',').map(Number)
          out.push(pos(x, y, z))
        }
      }
      return out
    },
  }
  return bot
}

function visiblePlayer(name, x, y = 64, z = 0) {
  return { username: name, entity: { id: 7, username: name, position: pos(x, y, z) } }
}

describe('gk6: lead gives up by displacement while isMoving lies', () => {
  it('shallow find -> stall -> nudge episode -> cannot reach, moving all along', async () => {
    // Prod gk6: the bot stood still writing 'N blocks left' — give-up
    // trusted isMoving(), which stays true on a partial/timed-out path.
    // Fixed: the stall counts entity displacement, one nudge episode gets a
    // second attempt, then the order is abandoned out loud.
    const bot = orderBot(
      { '10,64,0': 'diamond_ore' },
      { diamond_ore: { id: 56 } },
    )
    bot.players = { Steve: visiblePlayer('Steve', 5) }
    bot._moving = true // the lying executor: drives while the body stands
    const ticker = createTicker({
      bot,
      brain: { async decide() { return { action: 'follow', sprint: false, source: 'stub' } } },
      tickMs: 10,
      idleTickMs: 10,
    })
    const ctx = bot._tickerCtx
    const cap = capture()
    try {
      handleChat(bot, ticker, 'Steve', 'find me diamond_ore')
      assert.ok(bot.chats.some((c) => c === 'leading you to diamond_ore, 10 blocks, follow me'),
        `order taken: ${bot.chats.join(' | ')}`)
      assert.ok(ctx.lead, 'lead set')
      // The nudge episode walks free sideways (a gave-up would clear the
      // order itself; the second strike needs a done episode in between).
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
      let t = 0
      for (; t < 80 && ctx.lead; t++) {
        await ticker.tick()
        if (ctx.recovery) stepBody() // lead legs stand still; the episode walks
      }
      assert.ok(t < 80, 'order ends')
      assert.ok(cap.lines.some((l) => l.includes('stuck reason=nudge')), 'first strike nudges')
      assert.ok(cap.lines.some((l) => /recover action=sidestep .* outcome=done/.test(l)), 'episode walks free')
      assert.deepEqual(
        bot.chats.filter((c) => c.startsWith('cannot reach diamond_ore')),
        ['cannot reach diamond_ore at 10 64 0; following you again'],
        `one give-up out loud: ${bot.chats.join(' | ')}`)
      assert.equal(bot._moving, true, 'isMoving lied the whole time')
    } finally {
      cap.release()
      ticker.destroy()
    }
  })
})

describe('cra: deep find warns first, leads on consent, shallow walks', () => {
  it('14-down warns and holds; lead anyway walks; shallow find arrives', async () => {
    // Prod cra: the owner followed the bot to an underground ore and fell
    // to their death. Fixed: a find more than 8 down warns and waits for
    // 'lead anyway'; the lead itself walks on consent.
    const bot = orderBot(
      { '10,50,0': 'diamond_ore', '6,64,0': 'oak_log', '6,65,0': 'oak_log' },
      { diamond_ore: { id: 56 }, oak_log: { id: 17 } },
    )
    bot.players = { Steve: visiblePlayer('Steve', 2) }
    const ticker = createTicker({
      bot,
      brain: { async decide() { return { action: 'follow', sprint: false, source: 'stub' } } },
      tickMs: 10,
      idleTickMs: 10,
    })
    const ctx = bot._tickerCtx
    const stepBody = () => {
      const g = bot.pathfinder.goal
      if (!g || typeof g.x !== 'number') return
      const bp = bot.entity.position
      const dx = g.x - bp.x
      const dz = g.z - bp.z
      const d = Math.hypot(dx, dz)
      if (d < 0.05) return
      const s = Math.min(0.5, d) / d
      bot.entity.position = pos(bp.x + dx * s, bp.y, bp.z + dz * s)
    }
    const cap = capture()
    try {
      handleChat(bot, ticker, 'Steve', 'find me diamond_ore')
      assert.ok(bot.chats.some((c) => c === 'diamond_ore is 14 blocks down, dig carefully'),
        `depth warning: ${bot.chats.join(' | ')}`)
      assert.equal(ctx.lead, null, 'deep find holds the lead')
      handleChat(bot, ticker, 'Steve', 'lead anyway')
      assert.ok(bot.chats.some((c) => c === 'leading you to diamond_ore, 17 blocks, follow me'),
        `consent leads: ${bot.chats.join(' | ')}`)
      assert.ok(ctx.lead, 'order set on consent')
      const d0 = Math.hypot(10 - bot.entity.position.x, bot.entity.position.z)
      for (let i = 0; i < 3; i++) { await ticker.tick(); stepBody() }
      const d1 = Math.hypot(10 - bot.entity.position.x, bot.entity.position.z)
      assert.ok(d1 < d0, `walking to the ore: ${d0.toFixed(1)} -> ${d1.toFixed(1)}`)
      handleChat(bot, ticker, 'Steve', 'find me oak_log')
      assert.ok(bot.chats.some((c) => c.startsWith('leading you to oak_log,')),
        `shallow find leads at once: ${bot.chats.join(' | ')}`)
      let t = 0
      for (; t < 30 && ctx.lead; t++) { await ticker.tick(); stepBody() }
      assert.ok(t < 30, 'lead arrives')
      assert.ok(bot.chats.some((c) => c === 'here: oak_log at 6 64 0; following you again'),
        `arrival out loud: ${bot.chats.join(' | ')}`)
    } finally {
      cap.release()
      ticker.destroy()
    }
  })
})

describe('b2o: build here starts work in ticks, not just in the reply', () => {
  it('follow -> build here -> work steps dispatch through ticks', async () => {
    // Bead b2o wired the chat transition (follow clears, site sets, coords
    // answered) and checked goal.decide directly. E2E: the ticks after the
    // chat really dispatch the work loop — gather first on an empty
    // inventory, then rest with reasons when the only column skips.
    const bot = orderBot({ '20,64,0': 'oak_log', '20,65,0': 'oak_log', '20,66,0': 'oak_leaves' }, { oak_log: { id: 17 } })
    bot.players = { Steve: visiblePlayer('Steve', 10) }
    const ticker = createTicker({
      bot,
      brain: { async decide() { return { action: 'follow', sprint: false, source: 'stub' } } },
      tickMs: 10,
      idleTickMs: 10,
    })
    ticker.setFollow('Steve')
    const ctx = bot._tickerCtx
    const cap = capture()
    const actions = []
    try {
      const r0 = await ticker.tick()
      actions.push(r0.decision.action)
      assert.equal(r0.decision.action, 'follow', 'trailing the owner first')
      handleChat(bot, ticker, 'Steve', 'build here')
      assert.equal(ticker.getFollowName(), '', 'follow dropped')
      assert.ok(ctx.home && ctx.home.site, 'site set')
      assert.ok(bot.chats.some((c) => c.startsWith('building a home at ')), 'coords answered')
      assert.equal(ctx.work, true, 'work mode on')
      const r1 = await ticker.tick()
      actions.push(r1.decision.action)
      assert.equal(r1.decision.action, 'gather', 'empty hands chop first')
      assert.match(ctx.lastGoalKey, /^gather:/, 'walking to trees')
      let t = 0
      for (; t < 20 && r1.decision && ctx.step !== 'rest'; t++) {
        const r = await ticker.tick()
        actions.push(r.decision.action)
      }
      assert.ok(actions.includes('rest'), `nothing to chop -> rest: ${actions.join(',')}`)
      assert.ok(!actions.slice(1).includes('follow'), `never trails again: ${actions.join(',')}`)
    } finally {
      cap.release()
      ticker.destroy()
    }
  })
})

describe('3nt.23: fight without a hostile follows, never stops', () => {
  it('hostile dies mid-fight -> GoalFollow takes over, stop untouched', async () => {
    // Regression shape: stop() latches stopPathing and the next setGoal in
    // the same tick nulls it — a body parked while the brain still says
    // fight. Fixed: the no-hostile fallback delegates to follow.js (one
    // follow implementation), no stop, and follow spaces its re-issues.
    const bot = orderBot()
    bot.players = { Steve: visiblePlayer('Steve', 10) }
    bot.entities = { 1: { id: 1, name: 'zombie', type: 'mob', position: pos(5, 64, 0), height: 1.95 } }
    const ticker = createTicker({
      bot,
      brain: { async decide() { return { action: 'fight', sprint: false, source: 'stub' } } },
      tickMs: 10,
      idleTickMs: 10,
    })
    const ctx = bot._tickerCtx
    const cap = capture()
    try {
      const r1 = await ticker.tick()
      assert.equal(r1.decision.action, 'fight')
      assert.match(ctx.lastGoalKey, /^fight:1$/, 'engaged the zombie')
      bot.entities = {} // the zombie dies
      const goalsBefore = bot._goals.length
      const r2 = await ticker.tick()
      assert.equal(r2.decision.action, 'fight', 'brain still says fight')
      assert.equal(ctx.lastGoalKey, 'follow:Steve', 'body delegates to follow')
      assert.equal(bot._stops, 0, 'never stopped')
      assert.ok(bot._goals[bot._goals.length - 1] instanceof goals.GoalFollow, 'one follow goal')
      assert.equal(bot._goals[bot._goals.length - 1].entity.username, 'Steve', 'bodyguards the player')
      const r3 = await ticker.tick()
      assert.equal(r3.decision.action, 'fight')
      assert.equal(bot._goals.length, goalsBefore + 1, 'follow spaces re-issues')
      assert.equal(bot._stops, 0, 'still never stopped')
    } finally {
      cap.release()
      ticker.destroy()
    }
  })
})
