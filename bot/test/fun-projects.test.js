'use strict'

const { it } = require('node:test')
const assert = require('node:assert/strict')
const Vec3 = require('vec3')
const projects = require('../src/behaviours/fun-projects')
const fun = require('../src/behaviours/fun')
const goal = require('../src/goal')
const consts = require('../src/plan-consts')
const task = require('../src/task')
const { savedProject } = require('../src/fun-project-plan')

const settle = () => new Promise((resolve) => setImmediate(resolve))
function body() {
  const cells = new Map()
  const bot = {
    entity: { position: new Vec3(0.5, 64, 0.5) },
    time: { timeOfDay: 6000, day: 1 },
    entities: {}, players: {}, health: 20, food: 20,
    inventory: { items: () => [{ name: 'dandelion', count: 8 }] },
    pathfinder: { isMoving: () => false, setGoal() {} },
    blockAt(p) {
      const name = cells.get(`${p.x},${p.y},${p.z}`) || (p.y < 64 ? 'dirt' : 'air')
      return { name, position: p, boundingBox: name === 'air' ? 'empty' : 'block' }
    },
    async equip() {},
    async placeBlock(ref, face) {
      const p = ref.position.plus(face)
      cells.set(`${p.x},${p.y},${p.z}`, 'dandelion')
    },
  }
  return bot
}

function register(id, weight, x) {
  projects.register({
    id, weight,
    feasible: () => true,
    pickSite: () => ({ x, y: 64, z: 0, w: 2, d: 1, cost: 0 }),
    plan: () => [0, 1].map((dx) => ({ dx, dy: 0, dz: 0, kind: 'block', block: 'dandelion' })),
  })
}
register('small', 1, 1)
register('large', 3, 2)

it('weights the roll, resumes the same site, and leaves the residence and its skips alone', async (t) => {
  const messages = []
  t.mock.method(console, 'log', (msg) => messages.push(msg))
  const bot = body()
  const home = { site: { x: 100, y: 64, z: 100 } }
  const ctx = { home, step: 'fun', stepStatus: 'running', buildSkip: [0] }
  projects.run(bot, ctx, 'idle', () => 0.5)
  assert.equal(ctx.funProject.id, 'large')
  // Simulate a restart using only what disk memory keeps.
  ctx.funProject = savedProject(JSON.parse(JSON.stringify(ctx.funProject)))
  for (let i = 0; i < 12 && ctx.stepStatus === 'running'; i++) {
    projects.run(bot, ctx, 'idle', () => { throw new Error('rolled again') })
    await settle()
  }
  assert.equal(ctx.stepStatus, 'done')
  assert.equal(ctx.home, home)
  assert.deepEqual(ctx.buildSkip, [0])
  assert.ok(messages.includes('fun project pick id=large site=2,64,0 cost=0 why=idle'))
  assert.ok(messages.includes('fun project progress id=large placed=2/2'))
})

it('surveys a variable footprint, steering clear of existing residences', () => {
  const bot = body()
  const ctx = { home: { site: { x: -1, y: 64, z: -1 } } }
  const site = projects.gradedSite(bot, ctx, { w: 2, d: 3, radius: 12, maxRadius: 12, step: 1 })
  assert.equal(site.w, 2)
  assert.equal(site.d, 3)
  assert.equal(site.cost, 0)
  assert.ok(site.x + site.w < -3 || site.x > 8 || site.z + site.d < -3 || site.z > 7)
})

it('enters the idle menu immediately and accepts the watchdog’s own pin', async () => {
  fun.registerInto(goal, consts)
  const bot = body()
  // Exercise registered menu semantics with only fallback work available.
  const idle = { step: 'rest', stepStatus: 'running' }
  // Isolate runnable work for this check, restoring the real menu afterward.
  const methods = []
  for (const [name, entry] of Object.entries(goal.MENU)) {
    if (['fun', 'explore', 'rest'].includes(name)) continue
    methods.push([entry, entry.feasible])
    entry.feasible = () => false
  }
  try {
    assert.equal(fun.funFeasible({ time: 'day' }, bot, idle), true)
    assert.equal(idle.funProjectIdle, true)
  } finally {
    for (const [entry, feasible] of methods) entry.feasible = feasible
  }

  const now = Date.now()
  const ctx = { work: true, step: 'explore', stepStatus: 'running' }
  ctx.brain = { plan: async ({ criteria }) => {
    assert.ok('fun' in criteria)
    return { step: 'fun', confidence: 1 }
  } }
  task.genericTick(bot, ctx, now)
  task.genericTick(bot, ctx, now + task.goalWatchdogMs() + 1)
  await settle()
  task.genericTick(bot, ctx, now + task.goalWatchdogMs() + 2)
  assert.equal(ctx.taskPlanStep, 'fun')
  assert.equal(fun.funFeasible({ time: 'day', pinned: 'fun' }, bot, ctx, now + task.goalWatchdogMs() + 2), true)
  ctx.taskPlanStep = null
  ctx.step = 'fun'
  await fun.run(bot, ctx)
  assert.equal(ctx.funProject.why, 'stall')
})
