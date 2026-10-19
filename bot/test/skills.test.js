'use strict'

// Generated-skill runtime (idkcraft-vf8e.2): flag off = tables untouched;
// the vm sandbox blocks require/escape/protected digs/busy loops; a skill
// loaded from SKILLS_DIR reaches the recover menu, plan() criteria and the
// goal step tables. Blocks run in order: the flag-off block reads the hand
// tables before the load block mutates them (one process per test file).

const { describe, it, before } = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { Vec3 } = require('vec3')
const skills = require('../src/skills')
const recover = require('../src/behaviours/recover')
const goal = require('../src/goal')
const { STEP_ORDER } = require('../src/plan-consts')
const { BEHAVIOURS } = require('../src/behaviours/index')
const { createTicker } = require('../src/index')
const metrics = require('../src/metrics')

const FIXTURES = path.join(__dirname, 'fixtures', 'skills')

function key(x, y, z) { return `${Math.floor(x)},${Math.floor(y)},${Math.floor(z)}` }

// Open ground: dirt at y<=60, air above, `cells` overrides.
function fakeBot(cells = new Map()) {
  const dug = []
  const bot = {
    username: 'IdkBot',
    players: {},
    entities: {},
    health: 20,
    food: 20,
    time: { timeOfDay: 1000 },
    entity: { position: new Vec3(0.5, 61, 0.5), onGround: true },
    inventory: { items: () => [] },
    controls: {},
    setControlState(c, v) { this.controls[c] = !!v },
    getControlState(c) { return !!this.controls[c] },
    clearControlStates() { this.controls = {} },
    blockAt(p) {
      const k = key(p.x, p.y, p.z)
      const n = cells.get(k) || (Math.floor(p.y) <= 60 ? 'dirt' : 'air')
      return { name: n, position: new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)), boundingBox: n === 'air' ? 'empty' : 'block' }
    },
    async dig(b) {
      await Promise.resolve()
      dug.push(key(b.position.x, b.position.y, b.position.z))
      cells.set(key(b.position.x, b.position.y, b.position.z), 'air')
    },
    pathfinder: { goal: null, setGoal(g) { this.goal = g }, isMoving: () => false },
    chats: [],
    chat(m) { this.chats.push(String(m)) },
    dug,
  }
  return bot
}

function src(name, body, extra = '') {
  return `/* skill {"name": "${name}", "description": "test skill", "kind": "recover"${extra}} */\n` +
    'function feasible(facts) { return true }\n' +
    `function run(bot, st) { ${body} }\n`
}

function compiled(name, body, extra) {
  const { sk, skip } = skills.compile(`${name}.js`, src(name, body, extra), {})
  assert.equal(skip, undefined)
  sk.reset()
  return sk
}

function tick(sk, bot, ctx = {}, st = { ticks: 0, hs: { busy: null, err: null } }) {
  return sk.tick(bot, ctx, st)
}

async function flush() {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r))
}

async function runCount(skill, outcome) {
  const m = await metrics.skillRuns.get()
  const v = m.values.find((e) => e.labels.skill === skill && e.labels.outcome === outcome)
  return v ? v.value : 0
}

describe('skills: flag off (vf8e.2)', () => {
  it('BOT_SKILLS parses like BOT_AUTONOMOUS', () => {
    for (const v of ['1', 'true', 'yes', ' YES ']) assert.equal(skills.enabled({ BOT_SKILLS: v }), true, v)
    for (const v of [undefined, '', '0', 'on', 'no']) assert.equal(skills.enabled({ BOT_SKILLS: v }), false, String(v))
  })

  it('createTicker without BOT_SKILLS leaves every table identical, even with SKILLS_DIR set', () => {
    const before = {
      menu: Object.keys(recover.RECOVER_MENU),
      order: recover.RECOVER_ORDER.slice(),
      crit: Object.keys(recover.RECOVER_CRITERIA),
      beh: Object.keys(BEHAVIOURS),
      gmenu: Object.keys(goal.MENU),
      steps: STEP_ORDER.slice(),
    }
    const saved = { s: process.env.BOT_SKILLS, d: process.env.SKILLS_DIR }
    delete process.env.BOT_SKILLS
    process.env.SKILLS_DIR = FIXTURES
    try {
      createTicker({ bot: fakeBot(), brain: { decide: async () => ({ action: 'idle', sprint: false, source: 'stub' }) }, tickMs: 10, idleTickMs: 10 })
    } finally {
      if (saved.s === undefined) delete process.env.BOT_SKILLS; else process.env.BOT_SKILLS = saved.s
      if (saved.d === undefined) delete process.env.SKILLS_DIR; else process.env.SKILLS_DIR = saved.d
    }
    assert.deepEqual(Object.keys(recover.RECOVER_MENU), before.menu)
    assert.deepEqual(recover.RECOVER_ORDER, before.order)
    assert.deepEqual(Object.keys(recover.RECOVER_CRITERIA), before.crit)
    assert.deepEqual(Object.keys(BEHAVIOURS), before.beh)
    assert.deepEqual(Object.keys(goal.MENU), before.gmenu)
    assert.deepEqual(STEP_ORDER, before.steps)
    assert.equal(recover.RECOVER_SKILLS.size, 0)
  })
})

describe('skills: sandbox (vf8e.2)', () => {
  it('blocks require and the host globals', () => {
    const bot = fakeBot()
    assert.equal(tick(compiled('req_skill', 'require("fs"); return "done"'), bot), 'failed:skill-error')
    assert.equal(tick(compiled('globals_skill', 'return "failed:" + typeof require + "-" + typeof process + "-" + typeof setTimeout'), bot),
      'failed:undefined-undefined-undefined')
  })

  it('blocks the constructor escape through facade functions', () => {
    const bot = fakeBot()
    assert.equal(tick(compiled('esc1', 'return bot.pos.constructor.constructor("return process")() ? "done" : "done"'), bot), 'failed:skill-error')
    assert.equal(tick(compiled('esc2', 'return globalThis.constructor.constructor("return process")() ? "done" : "done"'), bot), 'failed:skill-error')
    assert.equal(tick(compiled('esc3', 'try { bot.dig("x") } catch (e) { return e.constructor.constructor("return process")() ? "done" : "done" } return "done"'), bot), 'failed:skill-error')
  })

  it('refuses a protected dig through denyReason and never calls bot.dig', async () => {
    const bot = fakeBot(new Map([[key(0, 62, 0), 'oak_planks']]))
    const sk = compiled('dig_prot', 'return "failed:" + bot.dig(0, 62, 0).replace("denied:", "")')
    assert.equal(tick(sk, bot), 'failed:protected')
    await flush()
    assert.deepEqual(bot.dug, [])
  })

  it('a natural dig runs, one act in flight at a time', async () => {
    const bot = fakeBot(new Map([[key(0, 62, 0), 'dirt']]))
    const sk = compiled('dig_ok', 'const a = bot.dig(0, 62, 0); const b = bot.dig(0, 62, 0); return a === "started" && b === "busy" ? "running" : "failed:" + a + "-" + b')
    assert.equal(tick(sk, bot), 'running')
    await flush()
    assert.deepEqual(bot.dug, [key(0, 62, 0)])
  })

  it('a 200 ms busy loop is cut at the call timeout -> failed:skill-timeout', async () => {
    const before = await runCount('busy_skill', 'skill-timeout')
    const sk = compiled('busy_skill', 'const t = Date.now(); while (Date.now() - t < 200) {} return "done"')
    const t0 = Date.now()
    assert.equal(tick(sk, fakeBot()), 'failed:skill-timeout')
    assert.ok(Date.now() - t0 < 190, `cut early: ${Date.now() - t0} ms`)
    assert.equal(await runCount('busy_skill', 'skill-timeout'), before + 1)
  })

  it('the per-episode tick budget ends a forever-running skill', () => {
    const sk = compiled('forever', 'return "running"')
    const st = { ticks: 0, hs: { busy: null, err: null } }
    const bot = fakeBot()
    let out = 'running'
    let n = 0
    while (out === 'running' && n < 1000) { out = sk.tick(bot, {}, st); n++ }
    assert.equal(out, 'failed:skill-timeout')
    assert.equal(n, skills.TICK_BUDGET.recover + 1)
  })

  it('a bad return value and a releasing terminal tick', () => {
    const bot = fakeBot()
    assert.equal(tick(compiled('bad_ret', 'return "yay"'), bot), 'failed:skill-error')
    const sk = compiled('held', 'bot.control("forward", true); return "done"')
    assert.equal(tick(sk, bot), 'done')
    assert.equal(bot.controls.forward, false, 'controls released on a terminal outcome')
  })

  it('a looping feasible is an error, not a hang', () => {
    const text = '/* skill {"name": "loop_feas", "description": "x", "kind": "recover"} */\n' +
      'function feasible(f) { while (true) {} }\nfunction run(bot, st) { return "done" }\n'
    const { sk } = skills.compile('loop_feas.js', text, {})
    assert.deepEqual(sk.feasible({}), { error: 'skill-timeout' })
  })

  it('header validation and the body filter', () => {
    assert.throws(() => skills.parseHeader('function run() {}'), /no header/)
    assert.throws(() => skills.parseHeader('/* skill {"name": "Bad Name", "description": "x", "kind": "recover"} */'), /bad name/)
    assert.throws(() => skills.parseHeader('/* skill {"name": "ok_name", "description": "x", "kind": "fly"} */'), /bad kind/)
    const v2only = src('v2_only', 'return "done"', ', "body": "baritone"')
    assert.equal(skills.compile('v2_only.js', v2only, {}).skip, 'body=baritone')
    assert.equal(skills.compile('v2_only.js', v2only, { BOT_BODY: 'baritone' }).skip, undefined)
  })
})

describe('skills: SKILLS_DIR load (vf8e.2)', () => {
  let hand, handSteps, names
  before(() => {
    hand = recover.RECOVER_ORDER.slice()
    handSteps = STEP_ORDER.slice()
    names = skills.load({ BOT_SKILLS: '1', SKILLS_DIR: FIXTURES }, { force: true, promotedDir: path.join(FIXTURES, 'none') })
  })

  it('registers both kinds once, after the hand entries', () => {
    assert.deepEqual(names, ['ledge_fixture', 'stroll_fixture'])
    assert.deepEqual(recover.RECOVER_ORDER, [...hand, 'ledge_fixture'])
    assert.equal(typeof BEHAVIOURS.ledge_fixture, 'function')
    assert.ok(recover.RECOVER_SKILLS.has('ledge_fixture'))
    assert.match(recover.RECOVER_CRITERIA.ledge_fixture, /fixture skill/)
    assert.deepEqual(skills.load({ BOT_SKILLS: '1', SKILLS_DIR: FIXTURES }), names, 'idempotent')
    assert.deepEqual(recover.RECOVER_ORDER, [...hand, 'ledge_fixture'])
    const rest = handSteps.indexOf('rest')
    assert.deepEqual(STEP_ORDER, [...handSteps.slice(0, rest), 'stroll_fixture', 'rest'])
  })

  it('the skill is on the recover model menu with its description', async () => {
    const bot = fakeBot()
    const ctx = { stuck: { by: 'gather', goal: { x: 10, y: 61, z: 0 }, key: 'gather' } }
    const facts = recover.recoverFacts(bot, ctx, null, null)
    let asked = null
    const brain = { name: 'stub', ask: async (req) => { asked = req; return 'ledge_fixture' } }
    const feasible = recover.RECOVER_ORDER.filter((n) => recover.RECOVER_MENU[n].feasible(facts, ctx))
    assert.ok(feasible.includes('ledge_fixture'))
    const r = await recover.chooseRecovery(brain, facts, feasible)
    assert.equal(r.action, 'ledge_fixture')
    assert.equal(asked.criteria.ledge_fixture, recover.RECOVER_CRITERIA.ledge_fixture)
  })

  it('the FSM picks it after the hand escapes, before the generic fallbacks', () => {
    const facts = { goalDy: 0, walls: 4, last: 'none', boxed: false }
    assert.equal(recover.recoverFsm(facts, ['ledge_fixture', 'dig_through', 'wait']), 'ledge_fixture')
    assert.equal(recover.recoverFsm(facts, ['sidestep', 'ledge_fixture', 'wait']), 'sidestep')
  })

  it('plan() criteria carry it', async () => {
    const bot = fakeBot()
    const calls = []
    const brain = { name: 'stub', plan: (req) => { calls.push(req); return new Promise(() => {}) } }
    const ctx = {
      stuck: { by: 'gather', goal: { x: 10, y: 61, z: 0 }, key: 'gather' },
      brain,
      recovery: { action: 'sidestep', source: 'fsm', model: null, status: 'failed:no-progress', st: null, attempts: 1, fails: 0, repeats: 0, last: null, calledPlayer: false, endEpisode: false, lastDy: null },
    }
    const r = await recover.decide(bot, ctx, null, null)
    assert.equal(r.source, 'plan-wait')
    assert.equal(calls.length, 1)
    assert.equal(calls[0].criteria.ledge_fixture, recover.RECOVER_CRITERIA.ledge_fixture)
  })

  it('runs through recover.run: a dig lands done; a refused dig fails and bans it for the episode', async () => {
    const okBot = fakeBot(new Map([[key(0, 62, 0), 'dirt']]))
    const ctx = { recovery: { action: 'ledge_fixture', st: null, status: 'running' } }
    BEHAVIOURS.ledge_fixture(okBot, ctx)
    assert.equal(ctx.recovery.status, 'running')
    await flush()
    BEHAVIOURS.ledge_fixture(okBot, ctx)
    assert.equal(ctx.recovery.status, 'done')

    const bad = fakeBot(new Map([[key(0, 62, 0), 'oak_planks']]))
    const ctx2 = { recovery: { action: 'ledge_fixture', st: null, status: 'running' } }
    recover.run(bad, ctx2)
    assert.equal(ctx2.recovery.status, 'failed:protected')
    assert.equal(recover.RECOVER_MENU.ledge_fixture.feasible({ walls: 0 }, ctx2), false, 'banned this episode')
    assert.equal(recover.RECOVER_MENU.ledge_fixture.feasible({ walls: 0 }, { recovery: {} }), true, 'a new episode offers it again')
  })

  it('a step skill is registered for the goal arbiter and finishes through step.js', () => {
    assert.equal(goal.registered('stroll_fixture'), true)
    assert.equal(goal.MENU.stroll_fixture.feasible({ time: 'day' }), true)
    assert.equal(goal.MENU.stroll_fixture.feasible({ time: 'night' }), false)
    assert.match(goal.STEP_CRITERIA.stroll_fixture, /fixture step/)
    const ctx = { stepGen: 3, stepStatus: null, step: 'stroll_fixture' }
    BEHAVIOURS.stroll_fixture(fakeBot(), ctx)
    assert.equal(ctx.stepStatus, null)
    BEHAVIOURS.stroll_fixture(fakeBot(), ctx)
    assert.equal(ctx.stepStatus, 'done')
    ctx.stepGen = 4
    ctx.stepStatus = null
    BEHAVIOURS.stroll_fixture(fakeBot(), ctx)
    assert.equal(ctx.stepStatus, null, 'a new step instance starts fresh state')
  })
})
