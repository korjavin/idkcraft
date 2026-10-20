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
    assert.equal(goal.MENU.stroll_fixture.feasible({ time: 'day' }), true)
    const bot = fakeBot()
    handleChat(bot, null, 'Steve', 'skills off')
    assert.deepEqual(bot.chats, ['skills: off (until restart)'])
    assert.equal(goal.MENU.stroll_fixture.feasible({ time: 'day' }), false)
  })
})
