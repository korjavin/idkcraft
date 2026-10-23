'use strict'

// Generated-skill runtime (idkcraft-vf8e.2): flag off = tables untouched;
// the vm sandbox blocks require/escape/protected digs/busy loops; a skill
// loaded from SKILLS_DIR reaches the recover menu, plan() criteria and the
// goal step tables. Blocks run in order: the flag-off block reads the hand
// tables before the load block mutates them (one process per test file).

const { describe, it, before } = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
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
// Mirrors only what skills.js OPS touch, per the installed contracts:
// mineflayer 4.39 docs/api.md — bot.entity/entities/health/food/time.timeOfDay/
// inventory.items(); blockAt(point) -> Block|null (prismarine-block:
// boundingBox 'block'|'empty', integer position); findBlocks({matching(block),
// maxDistance, count}) -> Vec3 coordinates, not blocks; setControlState;
// lookAt(point, force) / equip(item, destination) / dig(block) /
// placeBlock(referenceBlock, faceVector) -> Promise (the block lands at
// ref.position + face). mineflayer-pathfinder readme + index.js: setGoal(goal)
// (null stops), isMoving(), and `goal` is a read-only getter over the last
// setGoal (index.js defineProperties) — so the fake has no writable goal.
function fakeBot(cells = new Map()) {
  const dug = []
  const placed = []
  const cellName = (x, y, z) => cells.get(key(x, y, z)) || (Math.floor(y) <= 60 ? 'dirt' : 'air')
  const block = (x, y, z) => {
    const n = cellName(x, y, z)
    return { name: n, position: new Vec3(Math.floor(x), Math.floor(y), Math.floor(z)), boundingBox: n === 'air' ? 'empty' : 'block' }
  }
  let goal = null
  const bot = {
    username: 'IdkBot',
    players: {},
    entities: {},
    health: 20,
    food: 20,
    time: { timeOfDay: 1000 },
    entity: { position: new Vec3(0.5, 61, 0.5), onGround: true },
    items: [],
    inventory: { items: () => bot.items },
    heldItem: null,
    controls: {},
    setControlState(c, v) { this.controls[c] = !!v },
    getControlState(c) { return !!this.controls[c] },
    clearControlStates() { this.controls = {} },
    blockAt(p) { return block(p.x, p.y, p.z) },
    findBlocks({ matching, maxDistance = 16, count = 1 }) {
      const o = bot.entity.position.floored()
      const out = []
      for (const [k] of cells) {
        const [x, y, z] = k.split(',').map(Number)
        if (o.distanceTo(new Vec3(x, y, z)) <= maxDistance && matching(block(x, y, z))) out.push(new Vec3(x, y, z))
      }
      return out.sort((a, b) => o.distanceTo(a) - o.distanceTo(b)).slice(0, count)
    },
    async lookAt(p) { bot.looked = p },
    // activateItem(offHand=false): use_item on the held item, server raycast from the look (mineflayer api.md).
    used: [],
    activateItem() { bot.used.push({ item: bot.heldItem && bot.heldItem.name, at: bot.looked && key(bot.looked.x, bot.looked.y, bot.looked.z) }) },
    async equip(item, dest) { if (dest === 'hand') bot.heldItem = item },
    // dig resolves after its timer; stopDigging rejects the pending dig (mineflayer digging.js).
    stopped: 0,
    stopDigging() { bot.stopped++ },
    async dig(b) {
      await Promise.resolve()
      if (bot.stopped) throw new Error('Digging aborted')
      dug.push(key(b.position.x, b.position.y, b.position.z))
      cells.set(key(b.position.x, b.position.y, b.position.z), 'air')
    },
    async placeBlock(ref, face) {
      await Promise.resolve()
      const at = ref.position.plus(face)
      if (!bot.heldItem) throw new Error('must be holding an item to place')
      placed.push({ at: key(at.x, at.y, at.z), item: bot.heldItem.name })
      cells.set(key(at.x, at.y, at.z), bot.heldItem.name)
    },
    pathfinder: { setGoal(g) { goal = g }, get goal() { return goal }, isMoving: () => false },
    chats: [],
    chat(m) { this.chats.push(String(m)) },
    dug,
    placed,
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

  it('goto is idempotent under a skill: key, and a terminal tick clears the goal it left', () => {
    const bot = fakeBot()
    bot.pathfinder.calls = 0
    const set = bot.pathfinder.setGoal
    bot.pathfinder.setGoal = function (g) { set(g); this.calls++ }
    const sk = compiled('walker', 'const a = bot.goto(5, 61, 0); const b = bot.goto(5.7, 61.2, 0.4); st.n = (st.n || 0) + 1; ' +
      'if (st.n >= 3) return "done"; return a === (st.n === 1 ? "started" : "moving") && b === "moving" ? "running" : "failed:" + a + "-" + b')
    const ctx = { lastGoalKey: 'idle' }
    const st = { ticks: 0, hs: { busy: null, err: null } }
    assert.equal(sk.tick(bot, ctx, st), 'running')
    assert.equal(sk.tick(bot, ctx, st), 'running')
    assert.equal(bot.pathfinder.calls, 1, 'one setGoal for an unchanged target')
    assert.equal(ctx.lastGoalKey, 'skill:walker:5,61,0,1')
    set({ foreign: true }) // a raw-setGoal walker took the body under the stale key
    const st2 = { ticks: 0, hs: { busy: null, err: null } }
    sk.reset()
    assert.equal(sk.tick(bot, ctx, st2), 'running')
    assert.equal(bot.pathfinder.calls, 2, 'a foreign goal is never read as our own')
    assert.equal(sk.tick(bot, ctx, st2), 'running')
    assert.equal(sk.tick(bot, ctx, st2), 'done')
    assert.equal(bot.pathfinder.goal, null, 'terminal tick drops the skill goal')
    assert.equal(ctx.lastGoalKey, '')
  })

  it('place lands the held item in the cell against a solid ref; occupied/yard/apron/no-item are refused', async () => {
    const bot = fakeBot()
    bot.items = [{ name: 'cobblestone', count: 4 }]
    const one = (x, y, z, item, ctx = {}) => tick(compiled('placer',
      `const r = bot.place(${x}, ${y}, ${z}, ${JSON.stringify(item)}); return r === "started" ? "running" : "failed:" + r.replace(":", "-")`), bot, ctx)
    assert.equal(one(0, 61, 2, 'cobblestone'), 'running', 'air cell over dirt: placed against the floor')
    await flush()
    assert.deepEqual(bot.placed, [{ at: key(0, 61, 2), item: 'cobblestone' }])
    assert.equal(one(0, 60, 3, 'cobblestone'), 'failed:denied-occupied')
    assert.equal(one(0, 61, 4, 'dirt'), 'failed:denied-no-item')
    const site = { x: 10, y: 61, z: 0 }
    assert.equal(one(10, 61, 1, 'cobblestone', { castle: { site, rot: 0 } }), 'failed:denied-place-protected', 'yard ring')
    const apron = { castle: { site, rot: 0, phase: 'complete' } }
    assert.equal(one(7, 61, 1, 'cobblestone', apron), 'failed:denied-place-protected', 'complete castle apron')
    assert.equal(one(0, 70, 0, 'cobblestone'), 'failed:denied-no-reference', 'mid-air: no solid neighbour')
    assert.equal(bot.placed.length, 1)
  })

  it('use (vf8e.3) aims at the cell and activates a held bucket; other items, far cells and the castle are refused', async () => {
    const bot = fakeBot()
    const one = (x, y, z, ctx = {}) => tick(compiled('user',
      `const r = bot.use(${x}, ${y}, ${z}); return r === "started" ? "running" : "failed:" + r.replace(":", "-")`), bot, ctx)
    assert.equal(one(1, 61, 0), 'failed:denied-not-a-bucket', 'empty hand')
    bot.heldItem = { name: 'cobblestone' }
    assert.equal(one(1, 61, 0), 'failed:denied-not-a-bucket')
    bot.heldItem = { name: 'water_bucket' }
    assert.equal(one(1, 61, 0), 'running')
    await flush()
    assert.deepEqual(bot.used, [{ item: 'water_bucket', at: key(1, 61, 0) }])
    assert.equal(one(9, 61, 0), 'failed:denied-out-of-reach')
    assert.equal(one(1, 61, 1, { castle: { site: { x: 1, y: 61, z: 0 }, rot: 0 } }), 'failed:denied-use-protected', 'yard ring')
    assert.equal(bot.used.length, 1)
  })

  it('codex 03: rejected skill promises never crash, thrown getters stay timed, a lost episode never lands its place', async () => {
    const bot = fakeBot()
    // A child process (node:test has its own rejection hook): skill-realm
    // rejections are swallowed, a host rejection still kills the process.
    const child = (hostReject) => spawnSync(process.execPath, ['-e', `
      const skills = require(${JSON.stringify(path.join(__dirname, '..', 'src', 'skills'))})
      const { sk } = skills.compile('a.js', '/* skill {"name": "async_throw", "description": "x", "kind": "recover"} */\\n' +
        'function feasible() { return true }\\nfunction run() { Promise.reject(new Error("stray")); return (async () => { throw new Error("oops") })() }\\n', {})
      sk.reset()
      const out = sk.tick({ setControlState() {} }, {}, { ticks: 0, hs: { busy: null, err: null } })
      ${hostReject ? 'Promise.reject(new Error("host"))' : ''}
      setTimeout(() => { console.log('alive ' + out) }, 20)`], { encoding: 'utf8' })
    const ok = child(false)
    assert.equal(ok.status, 0, ok.stderr)
    assert.match(ok.stdout, /alive failed:skill-error/)
    assert.notEqual(child(true).status, 0, 'host rejections keep the default crash')
    const t0 = Date.now()
    assert.equal(tick(compiled('throw_getter', 'throw { get message() { while (true) {} }, get code() { while (true) {} } }'), bot), 'failed:skill-timeout')
    assert.ok(Date.now() - t0 < 190, 'getter cut at the call timeout')
    assert.throws(() => skills.compile('tg.js', '/* skill {"name": "top_getter", "description": "x", "kind": "recover"} */\n' +
      'throw { get message() { while (true) {} } }\n', {}), /top-level threw/)
    const feas = '/* skill {"name": "async_feas", "description": "x", "kind": "recover"} */\n' +
      'async function feasible() { return true }\nfunction run() { return "done" }\n'
    assert.equal(skills.compile('af.js', feas, {}).sk.feasible({}), false, 'a Promise is not true')

    bot.items = [{ name: 'cobblestone', count: 1 }]
    let owned = true
    const sk = compiled('placer_lost', 'return bot.place(0, 61, 2, "cobblestone") === "started" ? "running" : "failed:x"')
    const st = { ticks: 0, hs: { busy: null, err: null }, alive: () => owned }
    assert.equal(sk.tick(bot, {}, st), 'running')
    owned = false // step replaced while equip is pending
    await flush()
    assert.deepEqual(bot.placed, [])
    assert.match(st.hs.err, /episode over/)

    // A dig in flight at a terminal tick is cancelled.
    const digger = fakeBot(new Map([[key(0, 62, 0), 'dirt']]))
    const dsk = compiled('dig_end', 'st.n = (st.n || 0) + 1; if (st.n === 1) { bot.dig(0, 62, 0); return "running" } return "done"')
    const dst = { ticks: 0, hs: { busy: null, err: null } }
    assert.equal(dsk.tick(digger, {}, dst), 'running')
    assert.equal(dsk.tick(digger, {}, dst), 'done')
    assert.equal(digger.stopped, 1)
    await flush()
    assert.deepEqual(digger.dug, [])
  })

  it('findBlocks returns coordinates within the capped radius', () => {
    const bot = fakeBot(new Map([[key(3, 61, 0), 'oak_log'], [key(40, 61, 0), 'oak_log']]))
    const sk = compiled('finder', 'const r = bot.findBlocks(["oak_log"], 99, 99); return "failed:n" + r.length + "-x" + r[0].x')
    assert.equal(tick(sk, bot), 'failed:n1-x3', 'maxDistance capped at 32')
    assert.equal(tick(compiled('finder2', 'try { bot.findBlocks(new Array(65).fill("a")) } catch (e) { return "failed:refused" } return "done"'), bot), 'failed:refused')
  })

  it('a hostile skill cannot run code outside the call timeout or reach the host', () => {
    const bot = fakeBot()
    // A getter/setter on the globals the runtime used to read: never touched by the host.
    const getter = compiled('out_getter', 'Object.defineProperty(globalThis, "__out", { get() { while (true) {} } }); return "done"')
    assert.equal(tick(getter, bot), 'done')
    const st = compiled('st_setter', 'Object.defineProperty(globalThis, "__st", { set() { while (true) {} }, get() { return {} } }); return "running"')
    assert.equal(tick(st, bot), 'running')
    const t0 = Date.now()
    st.reset() // cut at the call timeout, never thrown into the tick
    assert.ok(Date.now() - t0 < 190)
    // A Proxy / object return never reaches host string checks.
    assert.equal(tick(compiled('proxy_ret', 'return new Proxy({}, { get() { while (true) {} } })'), bot), 'failed:skill-error')
    assert.equal(tick(compiled('async_ret', 'return (async () => "done")()'), bot), 'failed:skill-error')
    // feasible/run getters at load run under the timeout.
    assert.throws(() => skills.compile('lg.js', '/* skill {"name": "load_getter", "description": "x", "kind": "recover"} */\n' +
      'Object.defineProperty(globalThis, "feasible", { get() { while (true) {} } })\nfunction run() { return "done" }\n', {}), /timed out/)
    // Bad numbers and a hostile toJSON stay inside the context.
    assert.equal(tick(compiled('nan_dig', 'try { bot.dig(NaN, 0, Infinity) } catch (e) { return "failed:" + (/bad number/.test(e.message) ? "nan" : "other") } return "done"'), bot), 'failed:nan')
    assert.equal(tick(compiled('far_dig', 'return "failed:" + bot.dig(1e15, 61, 0).replace(":", "-")'), Object.assign(bot, { blockAt: () => null })), 'failed:denied-unloaded')
    assert.equal(tick(compiled('tojson', 'try { bot.dig({ toJSON() { return process } }, 0, 0) } catch (e) { return "failed:caught" } return "done"'), fakeBot()), 'failed:caught')
    // Error.prepareStackTrace in the context gets no host-realm function or receiver.
    const foreign = '(v) => (typeof v === "function" || (v && typeof v === "object")) && !(v instanceof Object)'
    assert.equal(tick(compiled('pst', `const fr = ${foreign}; Error.prepareStackTrace = (e, cs) => cs.some((c) => fr(c.getFunction()) || fr(c.getThis())) ? "host" : "none"; ` +
      'let s; try { bot.dig("x") } catch (e) { s = e.stack } return "failed:" + s'), fakeBot()), 'failed:none')
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

  it('vf8e.3: a step skill header `before` places it ahead of a hand step, never above shelter', () => {
    const place = (before) => {
      const order = STEP_ORDER.slice()
      const meta = { verb: 'x', description: 'd', ...(before === undefined ? {} : { before }) }
      skills.registerStep({ name: 'gen_t', meta, feasible: () => false }, { goal: { MENU: {}, STEP_CRITERIA: {} }, STEP_ORDER: order, BEHAVIOURS: {} })
      return order[order.indexOf('gen_t') + 1]
    }
    assert.equal(place(), 'rest')
    assert.equal(place('gocastle'), 'gocastle')
    assert.equal(place('shelter'), 'rest', 'night safety steps stay first')
    assert.equal(place('stay'), 'rest')
    assert.equal(place('nope'), 'rest')
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
    assert.deepEqual(names, ['broken_step_fixture', 'ledge_fixture', 'stroll_fixture'])
    assert.deepEqual(recover.RECOVER_ORDER, [...hand, 'ledge_fixture'])
    assert.equal(typeof BEHAVIOURS.ledge_fixture, 'function')
    assert.ok(recover.RECOVER_SKILLS.has('ledge_fixture'))
    assert.match(recover.RECOVER_CRITERIA.ledge_fixture, /fixture skill/)
    assert.deepEqual(skills.load({ BOT_SKILLS: '1', SKILLS_DIR: FIXTURES }), names, 'idempotent')
    assert.deepEqual(recover.RECOVER_ORDER, [...hand, 'ledge_fixture'])
    const rest = handSteps.indexOf('rest')
    assert.deepEqual(STEP_ORDER, [...handSteps.slice(0, rest), 'broken_step_fixture', 'stroll_fixture', 'rest'])
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

  it('cross-episode spot bans: same-spot fails and flat boxed dones take it off the menu', () => {
    const at = new Vec3(0.5, 61, 0.5)
    const failCtx = {}
    for (let i = 0; i < recover.RECOVER_BAN_FAILS; i++) recover.noteRecoverFail(failCtx, at, 'ledge_fixture', 'failed:protected')
    assert.equal(recover.RECOVER_MENU.ledge_fixture.feasible({ walls: 0 }, failCtx), false, 'fail streak')
    const doneCtx = {}
    for (let i = 0; i < recover.RECOVER_BAN_FAILS; i++) recover.noteRecoverDone(doneCtx, at, 'ledge_fixture', true)
    assert.equal(recover.RECOVER_MENU.ledge_fixture.feasible({ walls: 0 }, doneCtx), false, 'flat boxed dones')
    const freeCtx = {}
    for (let i = 0; i < recover.RECOVER_BAN_FAILS; i++) recover.noteRecoverDone(freeCtx, at, 'ledge_fixture', false)
    assert.equal(recover.RECOVER_MENU.ledge_fixture.feasible({ walls: 0 }, freeCtx), true, 'open-ground dones never ban')
  })

  it('a looping step feasible is switched off after the first timeout', () => {
    const f = goal.MENU.broken_step_fixture.feasible
    assert.equal(f({ time: 'day' }), false)
    const t0 = Date.now()
    assert.equal(f({ time: 'day' }), false)
    assert.ok(Date.now() - t0 < 20, 'no second 50 ms call')
  })

  it('a step skill is registered for the goal arbiter and finishes through step.js', () => {
    assert.equal(goal.registered('stroll_fixture'), true)
    // vf8e.17: order-only — feasible only under its own pin, day or night,
    // so the FSM never picks it unpinned (never before rest on its own).
    assert.equal(goal.MENU.stroll_fixture.feasible({ time: 'day' }), false)
    assert.equal(goal.MENU.stroll_fixture.feasible({ time: 'night' }), false)
    assert.equal(goal.MENU.stroll_fixture.feasible({ time: 'day', pinned: 'none' }), false)
    assert.equal(goal.MENU.stroll_fixture.feasible({ time: 'day', pinned: 'light' }), false)
    assert.equal(goal.MENU.stroll_fixture.feasible({ time: 'day', pinned: 'stroll_fixture' }), true)
    assert.equal(goal.MENU.stroll_fixture.feasible({ time: 'night', pinned: 'stroll_fixture' }), true)
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

describe('skills: promoted dir (vf8e.4)', () => {
  const fs = require('node:fs')
  const files = fs.readdirSync(skills.PROMOTED_DIR).filter((f) => f.endsWith('.js'))
  it('every bot/skills file carries verifiedBy {scenario, verdict, sha} and compiles', () => {
    for (const f of files) {
      const text = fs.readFileSync(path.join(skills.PROMOTED_DIR, f), 'utf8')
      const meta = skills.parseHeader(text)
      assert.equal(`${meta.name}.js`, f, 'file named after the skill')
      const v = meta.verifiedBy
      for (const k of ['scenario', 'verdict', 'sha']) assert.ok(v && typeof v[k] === 'string' && v[k].trim(), `${f}: verifiedBy.${k} missing (promote with tools/skill-promote.js)`)
      assert.ok(skills.compile(f, text, { BOT_BODY: 'baritone' }).sk || meta.body === 'mineflayer', `${f} compiles`)
    }
  })
})

describe('skills: digIn + use ray check (krup)', () => {
  const fresh = () => ({ ticks: 0, hs: { busy: null, err: null } })
  // The maneuver advances one digIn() per tick; the fake has no gravity, so
  // the test falls the body itself after each landed dig.
  async function fall(bot) {
    await flush()
    bot.entity.position = new Vec3(bot.entity.position.x, bot.entity.position.y - 1, bot.entity.position.z)
  }
  const relay = 'const r = bot.digIn(); return r === "started" ? "running" : r === "done" ? "done" : "failed:" + r.replace(/:/g, "-")'

  it('digIn runs the hand maneuver to a capped pit', async () => {
    const bot = fakeBot()
    bot.items = [{ name: 'dirt', count: 3 }]
    const sk = compiled('digin_pit', relay)
    const st = fresh()
    const ctx = {}
    assert.equal(sk.tick(bot, ctx, st), 'running') // dig 1
    await fall(bot)
    assert.equal(sk.tick(bot, ctx, st), 'running') // dig 2
    await fall(bot)
    assert.equal(sk.tick(bot, ctx, st), 'running') // dig 3
    await fall(bot)
    assert.equal(sk.tick(bot, ctx, st), 'running') // cap
    await flush()
    assert.equal(sk.tick(bot, ctx, st), 'done')
    assert.deepEqual(bot.dug, ['0,60,0', '0,59,0', '0,58,0'])
    assert.deepEqual(bot.placed, [{ at: key(0, 60, 0), item: 'dirt' }])
  })

  it('digIn walks to diggable ground first (stone stance)', async () => {
    const bot = fakeBot(new Map([[key(0, 60, 0), 'stone']]))
    const sk = compiled('digin_walk', relay)
    const st = fresh()
    const ctx = {}
    assert.equal(sk.tick(bot, ctx, st), 'running', 'vetoed on stone, walks')
    assert.equal(ctx.lastGoalKey, 'dig-in-walk')
    bot.entity.position = new Vec3(-0.5, 61, 0.5) // arrive at the walk target
    assert.equal(sk.tick(bot, ctx, st), 'running')
    assert.equal(sk.tick(bot, ctx, st), 'running', 'digs the new column')
    await flush()
    assert.deepEqual(bot.dug, ['-1,60,0'])
  })

  it('digIn refuses stone with no dirt column in reach', () => {
    const cells = new Map()
    for (let dx = -8; dx <= 8; dx++) for (let dz = -8; dz <= 8; dz++) cells.set(key(dx, 60, dz), 'stone')
    const bot = fakeBot(cells)
    const sk = compiled('digin_stone', 'return "failed:" + bot.digIn().replace(/:/g, "-")')
    assert.equal(sk.tick(bot, {}, fresh()), 'failed:denied-dig-in-undiggable-stone')
    assert.deepEqual(bot.dug, [])
    assert.equal(sk.tick(bot, {}, fresh()), 'failed:denied-dig-in-undiggable-stone', 'no stuck busy')
  })

  it('digIn descends walled-in where dig() refuses (below-feet)', async () => {
    const walls = new Map([[key(1, 61, 0), 'dirt'], [key(-1, 61, 0), 'dirt'], [key(0, 61, 1), 'dirt'], [key(0, 61, -1), 'dirt']])
    assert.equal(
      tick(compiled('walled_dig', 'return "failed:" + bot.dig(0, 60, 0).replace(":", "-")'), fakeBot(walls)),
      'failed:denied-below-feet', 'denyReason still refuses for generated code')
    const bot = fakeBot(walls)
    bot.items = [{ name: 'dirt', count: 3 }]
    const sk = compiled('walled_maneuver', relay)
    const st = fresh()
    const ctx = {}
    assert.equal(sk.tick(bot, ctx, st), 'running')
    await fall(bot)
    assert.equal(sk.tick(bot, ctx, st), 'running')
    await fall(bot)
    assert.equal(sk.tick(bot, ctx, st), 'running')
    await fall(bot)
    assert.equal(sk.tick(bot, ctx, st), 'running')
    await flush()
    assert.equal(sk.tick(bot, ctx, st), 'done')
    assert.deepEqual(bot.dug, ['0,60,0', '0,59,0', '0,58,0'])
  })

  it('a maneuver with no cap material fails loudly', async () => {
    const bot = fakeBot()
    const sk = compiled('digin_nocap', relay)
    const st = fresh()
    const ctx = {}
    for (let i = 0; i < 3; i++) { assert.equal(sk.tick(bot, ctx, st), 'running'); await fall(bot) }
    let out = 'running'
    for (let i = 0; i < 8 && out === 'running'; i++) out = sk.tick(bot, ctx, st)
    assert.equal(out, 'failed:denied-dig-in-no-cap')
  })

  it('digIn digs outside the house footprint instead of through the floor', async () => {
    const home = { site: { x: 0, y: 61, z: 0 }, interior: { min: { x: -2, y: 60, z: -2 }, max: { x: 2, y: 63, z: 2 } } }
    const bot = fakeBot()
    const sk = compiled('digin_home', relay)
    const st = fresh()
    const ctx = { home }
    assert.equal(sk.tick(bot, ctx, st), 'running', 'vetoed at home, walks out')
    assert.equal(ctx.lastGoalKey, 'dig-in-walk')
    bot.entity.position = new Vec3(-5.5, 61, 0.5) // arrive outside the apron
    assert.equal(sk.tick(bot, ctx, st), 'running')
    assert.equal(sk.tick(bot, ctx, st), 'running', 'digs the new column')
    await flush()
    assert.deepEqual(bot.dug, ['-6,60,0'])
  })

  it('other acts answer busy mid-maneuver and a terminal tick releases everything', async () => {
    const bot = fakeBot()
    bot.items = [{ name: 'cobblestone', count: 4 }]
    const both = compiled('digin_busy',
      'const d = bot.digIn(); const r = bot.place(0, 61, 2, "cobblestone"); ' +
      'return d === "started" && r === "busy" ? "running" : "failed:" + d + "-" + r.replace(/:/g, "-")')
    assert.equal(both.tick(bot, {}, fresh()), 'running', 'place waits while the maneuver digs')
    const ender = compiled('digin_end',
      'st.n = (st.n || 0) + 1; ' +
      'if (st.n === 1) { bot.digIn(); return "running" } ' +
      'if (st.n === 2) return "done"; ' +
      'const r = bot.place(0, 61, 2, "cobblestone"); const d = bot.digIn(); ' +
      'return r === "started" && d === "busy" ? "running" : "failed:" + r.replace(/:/g, "-") + "-" + d')
    const st2 = fresh()
    assert.equal(ender.tick(bot, {}, st2), 'running')
    assert.equal(ender.tick(bot, {}, st2), 'done')
    assert.equal(bot.stopped, 1, 'in-flight dig cancelled')
    await flush()
    assert.deepEqual(bot.dug, [])
    assert.equal(ender.tick(bot, {}, fresh()), 'running', 'terminal tick unlocked the acts')
    await flush()
    assert.deepEqual(bot.placed, [{ at: key(0, 61, 2), item: 'cobblestone' }])
  })

  it('a replaced episode does not inherit maneuver busy', async () => {
    const bot = fakeBot()
    bot.items = [{ name: 'cobblestone', count: 4 }]
    const sk = compiled('digin_replaced',
      'st.n = (st.n || 0) + 1; ' +
      'if (st.n === 1) { bot.digIn(); return "running" } ' +
      'if (st.n === 2) { st.r = bot.place(0, 61, 2, "cobblestone"); return "running" } ' +
      'return "failed:place-" + st.r')
    assert.equal(sk.tick(bot, {}, fresh()), 'running', 'first episode starts the maneuver')
    // No terminal tick: the arbiter replaces the episode outright.
    assert.equal(sk.tick(bot, {}, fresh()), 'running', 'fresh episode keeps running')
    await flush()
    assert.equal(sk.tick(bot, {}, fresh()), 'failed:place-started', 'fresh episode fired through the leftover busy')
    assert.deepEqual(bot.placed, [{ at: key(0, 61, 2), item: 'cobblestone' }])
  })

  it('a terminal tick drops a live dig-in walk goal', async () => {
    const bot = fakeBot(new Map([[key(0, 60, 0), 'stone']]))
    const sk = compiled('digin_walkend', 'st.n = (st.n || 0) + 1; if (st.n === 1) { bot.digIn(); return "running" } return "done"')
    const st = fresh()
    const ctx = {}
    assert.equal(sk.tick(bot, ctx, st), 'running')
    assert.equal(ctx.lastGoalKey, 'dig-in-walk')
    assert.ok(bot.pathfinder.goal, 'walk goal live')
    assert.equal(sk.tick(bot, ctx, st), 'done')
    assert.equal(bot.pathfinder.goal, null, 'walk goal dropped with the episode')
    assert.equal(ctx.lastGoalKey, '', 'walk key cleared')
    await flush()
  })

  it('a pour aims a ray-visible face into the dest and lands there', async () => {
    const bot = fakeBot()
    bot.heldItem = { name: 'water_bucket' }
    const sk = compiled('pour_face', 'const r = bot.use(1, 61, 0); return r === "started" ? "running" : "failed:" + r.replace(":", "-")')
    assert.equal(sk.tick(bot, {}, fresh()), 'running')
    await flush()
    assert.deepEqual(bot.used, [{ item: 'water_bucket', at: key(1, 61, 0) }])
    assert.deepEqual(bot.looked, new Vec3(1.5, 61, 0.5), 'aims the verified face, not the cell centre')
  })

  it('a pour that loses its face after the look never activates', async () => {
    const bot = fakeBot()
    bot.heldItem = { name: 'water_bucket' }
    bot.lookAt = async (p) => { bot.looked = p; bot.entity.position = new Vec3(10.5, 61, 10.5) }
    const st = fresh()
    const sk = compiled('pour_stale', 'const r = bot.use(1, 61, 0); return r === "started" ? "running" : "failed:" + r.replace(":", "-")')
    assert.equal(sk.tick(bot, {}, st), 'running')
    await flush()
    assert.deepEqual(bot.used, [], 'no pour on a stale aim')
    assert.match(st.hs.err || '', /ray-miss/)
  })

  it('a pour past an occluding wall refuses instead of landing elsewhere', async () => {
    const bot = fakeBot(new Map([[key(0, 61, 0), 'dirt']]))
    bot.heldItem = { name: 'water_bucket' }
    assert.equal(
      tick(compiled('pour_occl', 'return "failed:" + bot.use(1, 61, 0).replace(":", "-")'), bot),
      'failed:denied-no-face')
    await flush()
    assert.deepEqual(bot.used, [], 'no pour on a refused aim')
  })

  it('a scoop reaches a clear target but refuses past a wall', async () => {
    const open = fakeBot(new Map([[key(1, 61, 0), 'water']]))
    open.heldItem = { name: 'bucket' }
    const ok = compiled('scoop_ok', 'const r = bot.use(1, 61, 0); return r === "started" ? "running" : "failed:" + r.replace(":", "-")')
    assert.equal(ok.tick(open, {}, fresh()), 'running')
    await flush()
    assert.deepEqual(open.used, [{ item: 'bucket', at: key(1, 61, 0) }])
    const shut = fakeBot(new Map([[key(1, 62, 0), 'dirt'], [key(2, 61, 0), 'water']]))
    shut.heldItem = { name: 'bucket' }
    assert.equal(
      tick(compiled('scoop_shut', 'return "failed:" + bot.use(2, 61, 0).replace(":", "-")'), shut),
      'failed:denied-ray-miss')
    await flush()
    assert.deepEqual(shut.used, [])
  })
})

describe('skills: digIn cap episode guard (vf8e.21)', () => {
  const fresh = () => ({ ticks: 0, hs: { busy: null, err: null } })
  async function fall(bot) {
    await flush()
    bot.entity.position = new Vec3(bot.entity.position.x, bot.entity.position.y - 1, bot.entity.position.z)
  }
  // Four digIn() calls to the cap, then done: the 5th tick ends the
  // episode with the cap in flight. The equip gate holds the cap leg on
  // the await so the test controls which side of the terminal it lands.
  const QUIT_AT_CAP = 'st.n = (st.n || 0) + 1; ' +
    'if (st.n <= 4) { const r = bot.digIn(); return r === "started" ? "running" : "failed:" + r.replace(/:/g, "-") } ' +
    'return "done"'
  function gated(bot) {
    let release = null
    const gate = new Promise((r) => { release = r })
    const equip = bot.equip.bind(bot)
    bot.equip = async (item, dest) => { await gate; return equip(item, dest) }
    return () => release()
  }

  it('a cap whose episode ends mid-flight never lands', async () => {
    const bot = fakeBot()
    bot.items = [{ name: 'dirt', count: 3 }]
    const release = gated(bot)
    const sk = compiled('digin_capdead', QUIT_AT_CAP)
    const st = fresh()
    const ctx = {}
    assert.equal(sk.tick(bot, ctx, st), 'running') // dig 1
    await fall(bot)
    assert.equal(sk.tick(bot, ctx, st), 'running') // dig 2
    await fall(bot)
    assert.equal(sk.tick(bot, ctx, st), 'running') // dig 3
    await fall(bot)
    assert.equal(sk.tick(bot, ctx, st), 'running') // cap launched, held on the equip
    assert.equal(sk.tick(bot, ctx, st), 'done') // terminal tick with the cap in flight
    release()
    await flush()
    assert.deepEqual(bot.placed, [], 'a dead episode never lands its cap')
  })

  it('a cap whose episode is replaced mid-flight never lands', async () => {
    const bot = fakeBot()
    bot.items = [{ name: 'dirt', count: 3 }]
    const release = gated(bot)
    const sk = compiled('digin_capreplaced',
      'const r = bot.digIn(); return r === "started" ? "running" : "failed:" + r.replace(/:/g, "-")')
    const st = fresh()
    let live = true
    st.alive = () => live // the arbiter's ownership hook, flipped on replace
    const ctx = {}
    assert.equal(sk.tick(bot, ctx, st), 'running') // dig 1
    await fall(bot)
    assert.equal(sk.tick(bot, ctx, st), 'running') // dig 2
    await fall(bot)
    assert.equal(sk.tick(bot, ctx, st), 'running') // dig 3
    await fall(bot)
    assert.equal(sk.tick(bot, ctx, st), 'running') // cap launched, held on the equip
    live = false // the episode is replaced outright: no terminal tick
    release()
    await flush()
    assert.deepEqual(bot.placed, [], 'a replaced episode never lands its cap')
  })
})

describe('skills: order-only step skills (vf8e.17)', () => {
  it('stepSkills() reports the loaded step skills, never recover ones', () => {
    assert.deepEqual(skills.stepSkills(), ['broken_step_fixture', 'stroll_fixture'])
  })

  it('the arbiter never picks the fixture unpinned, over real decide ticks', async () => {
    const bot = fakeBot()
    const ctx = { work: true }
    const cap = []
    const orig = console.log
    console.log = (m) => cap.push(String(m))
    try {
      const picks = []
      for (let i = 0; i < 5; i++) {
        await goal.decide(bot, ctx)
        picks.push(ctx.step)
      }
      assert.equal(picks.length, 5)
      assert.ok(picks.every((p) => typeof p === 'string'), `decided: ${picks.join(',')}`)
      assert.ok(!picks.includes('stroll_fixture'), `unpinned picks: ${picks.join(',')}`)
    } finally {
      console.log = orig
    }
  })

  it('entities() carries the dropped-item name, null otherwise', () => {
    const bot = fakeBot()
    bot.entities = {
      1: { name: 'Item', type: 'object', position: new Vec3(2, 61, 0), getDroppedItem: () => ({ name: 'oak_sapling', count: 1 }) },
      2: { name: 'Zombie', type: 'hostile', position: new Vec3(3, 61, 0) },
    }
    const sk = compiled('ent_item', 'const es = bot.entities(16); const drop = es.find((e) => e.item); ' +
      'return drop && drop.item === "oak_sapling" && es.every((e) => "item" in e) ? "done" : "failed:no-item"')
    assert.equal(tick(sk, bot), 'done')
  })

  it('drops() watches named drops and scans the fold once per tick', () => {
    const bot = fakeBot()
    const backing = {
      1: { name: 'Item', type: 'object', position: new Vec3(2, 61, 0.5), getDroppedItem: () => ({ name: 'oak_sapling', count: 1 }) },
      2: { name: 'Item', type: 'object', position: new Vec3(4, 61, 0.5), getDroppedItem: () => ({ name: 'stick', count: 2 }) },
      // v2 fold shape without the method (bridge carries the item field)
      4: { name: 'item', type: 'object', position: new Vec3(3, 61, 1.5), item: 'birch_sapling' },
      3: { name: 'Zombie', type: 'hostile', position: new Vec3(3, 61, 0.5) },
    }
    // The bot's own entry never reads as a drop, even when it carries one.
    bot.entity.getDroppedItem = () => ({ name: 'oak_sapling', count: 1 })
    let reads = 0
    Object.defineProperty(bot, 'entities', { configurable: true, get() { reads++; return backing } })
    const sk = compiled('drops_watch',
      'const all = bot.drops(); const saps = bot.drops("oak_sapling"); const pair = bot.drops(["oak_sapling", "stick"]); ' +
      'const near = bot.drops(null, 2); const none = bot.drops("diamond"); const birch = bot.drops("birch_sapling"); ' +
      'if (all.length !== 3) return "failed:all-" + all.length; ' +
      'if (saps.length !== 1 || saps[0].item !== "oak_sapling") return "failed:saps"; ' +
      'if (pair.length !== 2) return "failed:pair"; ' +
      'if (near.length !== 1 || near[0].item !== "oak_sapling") return "failed:near"; ' +
      'if (none.length !== 0) return "failed:none"; ' +
      'if (birch.length !== 1 || typeof birch[0].x !== "number") return "failed:birch"; ' +
      'return "done"')
    const st = { ticks: 0, hs: { busy: null, err: null } }
    assert.equal(tick(sk, bot, {}, st), 'done')
    assert.equal(reads, 1, 'five drops() calls in one tick pay one fold scan')
    assert.equal(tick(sk, bot, {}, st), 'done')
    assert.equal(reads, 2, 'the next tick re-scans')
  })

  it('an ordered run reads st.count/st.by; anything else reads nulls', () => {
    const echoSrc = '/* skill {"name": "args_echo", "description": "echo order args", "kind": "step"} */\n' +
      'function feasible(facts) { return facts.pinned === "args_echo" }\n' +
      'function run(bot, st) { return "failed:count-" + st.count + "-by-" + (st.by === null ? "none" : st.by) }\n'
    const { sk } = skills.compile('args_echo.js', echoSrc, {})
    sk.reset()
    const tables = { goal: { MENU: {}, STEP_CRITERIA: {} }, STEP_ORDER: STEP_ORDER.slice(), BEHAVIOURS: {} }
    skills.registerStep(sk, tables)
    const runIt = (args) => {
      const ctx = { stepGen: 7, stepStatus: null, step: 'args_echo', taskPlanArgs: args }
      tables.BEHAVIOURS.args_echo(fakeBot(), ctx)
      return ctx.stepStatus
    }
    assert.equal(runIt({ step: 'args_echo', count: 3, by: 'steve' }), 'failed:count-3-by-steve')
    assert.equal(runIt(undefined), 'failed:count-null-by-none')
    assert.equal(runIt({ step: 'args_echo', count: 999, by: 'steve' }), 'failed:count-null-by-steve', 'out-of-range count never reaches the skill')
    assert.equal(runIt({ step: 'args_echo', count: 2, by: 'x'.repeat(40) }), 'failed:count-2-by-none', 'an overlong name never reaches the skill')
  })

  it('a same-step re-order with new args restarts the episode (codex P2)', () => {
    const echoSrc = '/* skill {"name": "args_reorder", "description": "echo order args twice", "kind": "step"} */\n' +
      'function feasible(facts) { return facts.pinned === "args_reorder" }\n' +
      'function run(bot, st) { st.n = (st.n || 0) + 1; if (st.n < 2) return "running"; return "failed:count-" + st.count }\n'
    const { sk } = skills.compile('args_reorder.js', echoSrc, {})
    sk.reset()
    const tables = { goal: { MENU: {}, STEP_CRITERIA: {} }, STEP_ORDER: STEP_ORDER.slice(), BEHAVIOURS: {} }
    skills.registerStep(sk, tables)
    // One episode across both orders (same step, same gen): do gen_park 2,
    // then do gen_park 9 while it still runs.
    const ctx = { stepGen: 7, stepStatus: null, step: 'args_reorder', taskPlanArgs: { step: 'args_reorder', count: 2, by: 'steve' } }
    tables.BEHAVIOURS.args_reorder(fakeBot(), ctx)
    assert.equal(ctx.stepStatus, null, 'first tick runs')
    ctx.taskPlanArgs = { step: 'args_reorder', count: 9, by: 'steve' } // the re-order
    tables.BEHAVIOURS.args_reorder(fakeBot(), ctx)
    assert.equal(ctx.stepStatus, null, 'rebuilt on the new args, running again — not terminal on the stale count')
    tables.BEHAVIOURS.args_reorder(fakeBot(), ctx)
    assert.equal(ctx.stepStatus, 'failed:count-9', 'the episode carries the new count')
  })

  it("a skill never inherits another step's args (codex P2)", () => {
    const echoSrc = '/* skill {"name": "args_other", "description": "echo order args guarded", "kind": "step"} */\n' +
      'function feasible(facts) { return true }\n' +
      'function run(bot, st) { return "failed:count-" + st.count + "-by-" + (st.by === null ? "none" : st.by) }\n'
    const { sk } = skills.compile('args_other.js', echoSrc, {})
    sk.reset()
    const tables = { goal: { MENU: {}, STEP_CRITERIA: {} }, STEP_ORDER: STEP_ORDER.slice(), BEHAVIOURS: {} }
    skills.registerStep(sk, tables)
    const runIt = (args) => {
      const ctx = { stepGen: 11, stepStatus: null, step: 'args_other', taskPlanArgs: args }
      tables.BEHAVIOURS.args_other(fakeBot(), ctx)
      return ctx.stepStatus
    }
    // A degraded pin for another step (the arbiter did not apply it) while
    // this autonomous skill is picked: it must see nulls, not light's args.
    assert.equal(runIt({ step: 'light', count: 3, by: 'steve' }), 'failed:count-null-by-none')
    assert.equal(runIt({ step: 'args_other', count: 3, by: 'steve' }), 'failed:count-3-by-steve')
    assert.equal(runIt(undefined), 'failed:count-null-by-none')
  })
})

describe('skills: craft + withdraw facade (vf8e.12)', () => {
  const fresh = () => ({ ticks: 0, hs: { busy: null, err: null } })
  function stubDeps(craftFn, withdrawFn) {
    const d = skills.deps
    const keep = { craftItem: d.craftItem, withdraw: d.withdraw }
    if (craftFn) d.craftItem = craftFn
    if (withdrawFn) d.withdraw = withdrawFn
    return () => { d.craftItem = keep.craftItem; d.withdraw = keep.withdraw }
  }
  function chestBot() {
    return fakeBot(new Map([[key(0, 61, 2), 'chest']]))
  }

  it('bot.craft and bot.withdraw are facade functions', () => {
    const bot = fakeBot()
    assert.equal(tick(compiled('facade_fns', 'return typeof bot.craft === "function" && typeof bot.withdraw === "function" ? "done" : "failed:missing"'), bot), 'done')
  })

  it('craft advances one craftany tick per call and restores the hand run slot', () => {
    const calls = []
    const restore = stubDeps((bot, ctx, name, count) => {
      calls.push([name, count])
      ctx.craftany = ctx.craftany || { key: `${name}x${count}`, plan: {} }
      return calls.length < 2 ? 'running' : { done: true, target: name }
    })
    try {
      const bot = fakeBot()
      const sk = compiled('craft_run', 'const r = bot.craft("stick", 4); return r === "started" ? "running" : r === "done" ? "done" : "failed:" + r.replace(/:/g, "-")')
      const hand = { key: 'hand-plan' }
      const ctx = { craftany: hand }
      const st = fresh()
      assert.equal(sk.tick(bot, ctx, st), 'running')
      assert.deepEqual(ctx.craftany, hand, 'the hand run slot is restored every tick')
      assert.equal(sk.tick(bot, ctx, st), 'done', 'the landed product ends the act')
      assert.deepEqual(calls, [['stick', 4], ['stick', 4]])
      assert.deepEqual(ctx.craftany, hand)
    } finally {
      restore()
    }
  })

  it('craft maps hand refusals to denied lines', () => {
    const lines = ['need a crafting table', "can't reach the crafting table", "can't make stick: need 2 oak_planks (have 0)",
      "can't make stick: crafting failed", "can't make stick: no recipe", 'boom']
    const want = ['failed:denied-no-table', 'failed:denied-table-unreachable', 'failed:denied-no-mats',
      'failed:denied-craft-failed', 'failed:denied-craft-failed', 'failed:denied-craft-failed']
    lines.forEach((line, i) => {
      const restore = stubDeps(() => ({ done: false, line }))
      try {
        assert.equal(tick(compiled(`craft_map${i}`, 'return "failed:" + bot.craft("stick", 1).replace(/:/g, "-")'), fakeBot()), want[i], line)
      } finally {
        restore()
      }
    })
    const restore = stubDeps(() => { throw new Error('no registry') })
    try {
      assert.equal(tick(compiled('craft_throw', 'return "failed:" + bot.craft("stick", 1).replace(/:/g, "-")'), fakeBot()), 'failed:denied-craft-failed')
    } finally {
      restore()
    }
  })

  it('craft refuses a planks target past the wood ceiling but converts logs below it', () => {
    let calls = 0
    const restore = stubDeps(() => { calls++; return { done: true } })
    try {
      const capped = fakeBot()
      capped.items = [{ name: 'oak_planks', count: 64 }]
      assert.equal(
        tick(compiled('craft_cap', 'return "failed:" + bot.craft("oak_planks", 1).replace(/:/g, "-")'), capped, { home: { built: true } }),
        'failed:denied-wood-capped')
      assert.equal(calls, 0, 'the ceiling refuses before craftany plans')
      const open = fakeBot()
      open.items = [{ name: 'oak_log', count: 4 }]
      assert.equal(
        tick(compiled('craft_logs', 'const r = bot.craft("oak_planks", 1); return r === "done" ? "done" : "failed:" + r.replace(/:/g, "-")'), open, { home: { built: true } }),
        'done')
    } finally {
      restore()
    }
  })

  it('other firing acts answer busy while craft runs, and the next episode runs free', () => {
    const restore = stubDeps(() => 'running')
    try {
      const bot = chestBot()
      const sk = compiled('craft_busy',
        'st.n = (st.n || 0) + 1; ' +
        'if (st.n === 1) { const r = bot.craft("stick", 1); return r === "started" ? "running" : "failed:" + r.replace(/:/g, "-") } ' +
        'if (st.n === 2) { const r = bot.withdraw({x: 0, y: 61, z: 2}, "oak_planks", 1); return r === "busy" ? "running" : "failed:" + r.replace(/:/g, "-") } ' +
        'return "done"')
      const st = fresh()
      assert.equal(sk.tick(bot, {}, st), 'running')
      assert.equal(sk.tick(bot, {}, st), 'running', 'withdraw waits while craft holds the body')
      assert.equal(sk.tick(bot, {}, st), 'done', 'a terminal tick releases the craft busy')
      sk.reset()
      const st2 = fresh()
      const sk2 = compiled('craft_free', 'const r = bot.craft("stick", 1); return r === "started" ? "running" : "failed:" + r.replace(/:/g, "-")')
      assert.equal(sk2.tick(bot, {}, st2), 'running', 'a fresh episode crafts again')
    } finally {
      restore()
    }
  })

  it('withdraw refuses a missing chest, a far chest and a full keep', () => {
    const far = fakeBot(new Map([[key(10, 61, 0), 'chest']]))
    const one = (bot, chest, item, n, ctx = {}) => tick(compiled('wd_one',
      `const r = bot.withdraw(${JSON.stringify(chest)}, ${JSON.stringify(item)}, ${n}); return "failed:" + r.replace(/:/g, "-")`), bot, ctx)
    assert.equal(one(fakeBot(), { x: 0, y: 61, z: 2 }, 'oak_planks', 1), 'failed:denied-not-a-chest')
    assert.equal(one(far, { x: 10, y: 61, z: 0 }, 'oak_planks', 1), 'failed:denied-out-of-reach')
    const full = chestBot()
    full.items = [{ name: 'oak_planks', count: 64 }]
    assert.equal(one(full, { x: 0, y: 61, z: 2 }, 'oak_planks', 1, { home: { built: true } }), 'failed:denied-bank-keep')
  })

  it('withdraw validates args like every other act', () => {
    const bot = chestBot()
    const bad = (expr) => tick(compiled('wd_bad', `try { bot.${expr}; return "failed:no-throw" } catch (e) { return "failed:threw" }`), bot)
    assert.equal(bad('withdraw({x: 0, y: 61, z: 2}, "", 1)'), 'failed:threw')
    assert.equal(bad('withdraw({x: 0, y: 61, z: 2}, "oak_planks", 0)'), 'failed:threw')
    assert.equal(bad('craft("stick", 0)'), 'failed:threw')
    assert.equal(bad('craft("", 1)'), 'failed:threw')
    assert.equal(tick(compiled('wd_uncaught', 'bot.craft("stick", 0); return "done"'), bot), 'failed:skill-error')
  })

  it('withdraw takes x, y, z cells too', async () => {
    const draws = []
    const restore = stubDeps(null, async (bot, ctx, names, count, at) => {
      draws.push([names, count, { x: at.x, y: at.y, z: at.z }])
      return { got: 1, name: names[0] }
    })
    try {
      const bot = chestBot()
      const sk = compiled('wd_xyz', 'const r = bot.withdraw(0, 61, 2, "oak_planks", 1); return r === "started" ? "running" : "failed:" + r.replace(/:/g, "-")')
      assert.equal(sk.tick(bot, {}, fresh()), 'running')
      await flush()
      assert.deepEqual(draws, [[['oak_planks'], 1, { x: 0, y: 61, z: 2 }]])
    } finally {
      restore()
    }
    await flush()
  })

  it('withdraw opens one window; an empty chest lands in status().err', async () => {
    const draws = []
    const restore = stubDeps(null, async (bot, ctx, names, count, at) => {
      draws.push([names, count, { x: at.x, y: at.y, z: at.z }])
      return { got: 2, name: names[0] }
    })
    try {
      const bot = chestBot()
      const sk = compiled('wd_ok',
        'st.n = (st.n || 0) + 1; ' +
        'if (st.n === 1) { const r = bot.withdraw({x: 0, y: 61, z: 2}, "oak_planks", 2); return r === "started" ? "running" : "failed:" + r.replace(/:/g, "-") } ' +
        'const s = bot.status(); return s.busy === null && s.err === null ? "done" : "failed:busy-" + s.busy + "-err-" + s.err')
      const st = fresh()
      assert.equal(sk.tick(bot, {}, st), 'running')
      await flush()
      assert.deepEqual(draws, [[['oak_planks'], 2, { x: 0, y: 61, z: 2 }]])
      assert.equal(sk.tick(bot, {}, st), 'done', 'the window op clears busy with no err')
    } finally {
      restore()
    }
    const restore2 = stubDeps(null, async () => ({ got: 0, name: null }))
    try {
      const bot = chestBot()
      const sk = compiled('wd_empty',
        'st.n = (st.n || 0) + 1; ' +
        'if (st.n === 1) { const r = bot.withdraw({x: 0, y: 61, z: 2}, "oak_planks", 2); return r === "started" ? "running" : "failed:" + r.replace(/:/g, "-") } ' +
        'const s = bot.status(); return s.err && s.err.indexOf("withdraw") === 0 ? "done" : "failed:err-" + s.err')
      const st = fresh()
      assert.equal(sk.tick(bot, {}, st), 'running')
      await flush()
      assert.equal(sk.tick(bot, {}, st), 'done', 'an empty chest surfaces, never spins')
    } finally {
      restore2()
    }
  })

  it('a replaced craft episode releases the busy for the next episode', async () => {
    const restore = stubDeps((bot, ctx) => {
      ctx.craftany = ctx.craftany || { key: 'stickx1', plan: {} }
      return 'running'
    }, async () => ({ got: 1, name: 'oak_planks' }))
    try {
      const bot = chestBot()
      const sk = compiled('craft_replaced',
        'st.n = (st.n || 0) + 1; ' +
        'if (st.n === 1) { const r = bot.craft("stick", 1); return r === "started" ? "running" : "failed:" + r.replace(/:/g, "-") } ' +
        'const r = bot.withdraw({x: 0, y: 61, z: 2}, "oak_planks", 1); return r === "started" ? "running" : "failed:" + r.replace(/:/g, "-")')
      assert.equal(sk.tick(bot, {}, fresh()), 'running', 'first episode starts the run')
      // No terminal tick: the arbiter replaces the episode outright.
      assert.equal(sk.tick(bot, {}, fresh()), 'running', 'the next episode draws through the leftover busy')
      const sk2 = compiled('craft_replace2',
        'st.n = (st.n || 0) + 1; ' +
        'if (st.n === 1) { const r = bot.craft("stick", 1); return r === "started" ? "running" : "failed:" + r.replace(/:/g, "-") } ' +
        'const r = bot.digIn(); return r === "busy" ? "failed:busy" : "done"')
      const bot2 = chestBot()
      assert.equal(sk2.tick(bot2, {}, fresh()), 'running', 'first episode starts the run')
      assert.equal(sk2.tick(bot2, {}, fresh()), 'done', 'digIn runs through the leftover craft busy too')
    } finally {
      restore()
    }
    await flush()
  })

  it('a gear failure between ticks ends the episode terminal, never leaks the status', () => {
    const restore = stubDeps((bot, ctx, name, count) => {
      ctx.craftany = ctx.craftany || { key: `${name}x${count}`, plan: {} }
      return 'running'
    })
    try {
      const bot = fakeBot()
      const sk = compiled('craft_gearfail', 'const r = bot.craft("stick", 1); return r === "started" ? "running" : "failed:" + r.replace(/:/g, "-")')
      const ctx = { stepStatus: null }
      const st = fresh()
      assert.equal(sk.tick(bot, ctx, st), 'running')
      ctx.stepStatus = 'failed:gear-stick' // the async op fails between ticks
      assert.equal(sk.tick(bot, ctx, st), 'failed:denied-craft-failed', 'consumed into the terminal path')
      assert.equal(ctx.stepStatus, null, 'never leaks to decide()')
      assert.equal(sk.tick(bot, {}, fresh()), 'running', 'a fresh episode crafts again')
    } finally {
      restore()
    }
  })

  it('a terminal tick drops the table walk goal of an episode that crafted', () => {
    const restore = stubDeps((bot, ctx) => {
      ctx.craftany = ctx.craftany || { key: 'stickx1', plan: {} }
      ctx.lastGoalKey = 'craftany-table:5,60,0'
      try { bot.pathfinder.setGoal({ table: true }) } catch (_) { /* best-effort */ }
      return 'running'
    })
    try {
      const bot = fakeBot()
      const sk = compiled('craft_walkend',
        'st.n = (st.n || 0) + 1; ' +
        'if (st.n === 1) { const r = bot.craft("stick", 1); return r === "started" ? "running" : "failed:" + r.replace(/:/g, "-") } ' +
        'return "done"')
      const ctx = {}
      const st = fresh()
      assert.equal(sk.tick(bot, ctx, st), 'running')
      assert.equal(ctx.lastGoalKey, 'craftany-table:5,60,0')
      assert.equal(sk.tick(bot, ctx, st), 'done')
      assert.equal(bot.pathfinder.goal, null, 'table walk goal dropped with the episode')
      assert.equal(ctx.lastGoalKey, '')
      // A stale hand key on an episode that never crafted is left alone.
      const bot2 = fakeBot()
      const ctx2 = { lastGoalKey: 'craftany-table:5,60,0' }
      try { bot2.pathfinder.setGoal({ table: true }) } catch (_) { /* best-effort */ }
      assert.equal(tick(compiled('craft_nocraft', 'return "done"'), bot2, ctx2), 'done')
      assert.equal(ctx2.lastGoalKey, 'craftany-table:5,60,0', 'not ours to clear')
    } finally {
      restore()
    }
  })

  it('withdraw counts every wood against the keeps and caps the draw', async () => {
    const draws = []
    const restore = stubDeps(null, async (bot, ctx, names, count, at) => {
      draws.push([names, count])
      return { got: count, name: names[0] }
    })
    try {
      const ctx = { home: { built: true } }
      // 70 planks across two woods: no room for any more.
      const full = chestBot()
      full.items = [{ name: 'birch_planks', count: 60 }, { name: 'oak_planks', count: 10 }]
      assert.equal(tick(compiled('wd_mixed', 'return "failed:" + bot.withdraw({x: 0, y: 61, z: 2}, "oak_planks", 4).replace(/:/g, "-")'), full, ctx), 'failed:denied-bank-keep')
      // 20 logs across two woods: no room for more.
      const logs = chestBot()
      logs.items = [{ name: 'spruce_log', count: 10 }, { name: 'oak_log', count: 10 }]
      assert.equal(tick(compiled('wd_mixedlog', 'return "failed:" + bot.withdraw({x: 0, y: 61, z: 2}, "oak_log", 4).replace(/:/g, "-")'), logs, ctx), 'failed:denied-bank-keep')
      // 60 birch planks: the oak draw is capped to the 4 left, not refused.
      const roomy = chestBot()
      roomy.items = [{ name: 'birch_planks', count: 60 }]
      const sk = compiled('wd_cap', 'const r = bot.withdraw({x: 0, y: 61, z: 2}, "oak_planks", 10); return r === "started" ? "running" : "failed:" + r.replace(/:/g, "-")')
      assert.equal(sk.tick(roomy, ctx, fresh()), 'running')
      await flush()
      assert.deepEqual(draws, [[['oak_planks'], 4]])
    } finally {
      restore()
    }
    await flush()
  })

  it('a withdraw window in flight survives the terminal tick, then frees the next draw', async () => {
    let release = null
    const gate = new Promise((r) => { release = r })
    const restore = stubDeps(null, async () => { await gate; return { got: 1, name: 'oak_planks' } })
    try {
      const bot = chestBot()
      // One skill: withdraw, end with the window in flight, draw again.
      const sk = compiled('wd_end',
        'st.n = (st.n || 0) + 1; ' +
        'if (st.n === 1 || st.n >= 3) { const r = bot.withdraw({x: 0, y: 61, z: 2}, "oak_planks", 1); return r === "started" ? "running" : "failed:" + r.replace(/:/g, "-") } ' +
        'return "done"')
      const st = fresh()
      assert.equal(sk.tick(bot, {}, st), 'running')
      assert.equal(sk.tick(bot, {}, st), 'done', 'terminal tick with the window in flight')
      assert.equal(sk.tick(bot, {}, st), 'failed:busy', 'the next draw waits for the open window')
      release()
      await flush()
      assert.equal(sk.tick(bot, {}, st), 'running', 'the closed window frees the next draw')
    } finally {
      restore()
    }
  })
})

// Last: the ban and the off switch are process-wide.
describe('skills: auto-ban and chat skills off (vf8e.4)', () => {
  it(`a skill that fails ${skills.BAN_FAILS} times is banned until restart`, () => {
    const logs = []
    const orig = console.log
    console.log = (m) => logs.push(String(m))
    try {
      // An earlier test already failed it once: fail it until it is off.
      for (let i = 0; i < skills.BAN_FAILS; i++) {
        const ctx = { recovery: { action: 'ledge_fixture', st: null, status: 'running' } }
        if (!recover.RECOVER_MENU.ledge_fixture.feasible({ walls: 0 }, ctx)) break
        recover.run(fakeBot(new Map([[key(0, 62, 0), 'oak_planks']])), ctx)
        assert.equal(ctx.recovery.status, 'failed:protected')
      }
    } finally {
      console.log = orig
    }
    assert.equal(recover.RECOVER_MENU.ledge_fixture.feasible({ walls: 0 }, { recovery: {} }), false, 'a new episode does not offer it')
    assert.match(skills.state(), /banned=.*\bledge_fixture\b/)
  })

  it('chat skills off takes every skill off the menus', () => {
    const { handleChat } = require('../src/index')
    // vf8e.17: the fixture is order-only — gate on its pin for this check.
    const pinned = { time: 'day', pinned: 'stroll_fixture' }
    assert.equal(goal.MENU.stroll_fixture.feasible(pinned), true)
    const bot = fakeBot()
    handleChat(bot, null, 'Steve', 'skills off')
    assert.deepEqual(bot.chats, ['skills: off (until restart)'])
    assert.equal(goal.MENU.stroll_fixture.feasible(pinned), false)
  })
})
