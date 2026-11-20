'use strict'

const { it } = require('node:test')
const assert = require('node:assert/strict')
const Vec3 = require('vec3')
const mobTrap = require('../src/fun-mob-trap')
const { run, gradedSite } = require('../src/behaviours/fun-projects')
const { savedProject } = require('../src/fun-project-plan')

it('builds the roof before the closures and seals it only from the outside apron', async (t) => {
  t.mock.method(console, 'log', () => {})
  const site = { x: 0, y: 64, z: 0, w: 5, d: 6, cost: 0 }
  const project = mobTrap()
  const blueprint = project.plan(site)
  const closures = blueprint.slice(-2)
  assert.equal(blueprint.length, 57)
  assert.equal(blueprint.filter((c) => c.dy === 2).length, 25)
  assert.ok(closures.every((c) => c.dz === 1 && c.stand.dz === 0))
  const blocks = new Map()
  const reaches = []
  const bot = {
    entity: { position: new Vec3(2.5, 64, 2.5) },
    inventory: { items: () => [{ name: 'cobblestone', count: 57 }] },
    pathfinder: { isMoving: () => false, setGoal: (goal) => reaches.push(goal) },
    blockAt(p) {
      const name = blocks.get(`${p.x},${p.y},${p.z}`) || (p.y < 64 ? 'stone' : 'air')
      return { name, position: p, boundingBox: name === 'air' ? 'empty' : 'block' }
    },
    async equip() {},
    async placeBlock(ref, face) {
      const p = ref.position.plus(face)
      blocks.set(`${p.x},${p.y},${p.z}`, 'cobblestone')
    },
  }
  assert.equal(project.feasible(bot, {}), true)
  const ctx = { step: 'fun', stepStatus: 'running', funProject: savedProject({ id: project.id, site, blueprint }) }
  const tick = async () => {
    run(bot, ctx, 'idle')
    await new Promise((resolve) => setImmediate(resolve))
  }
  for (let i = 0; i < 170 && reaches.at(-1)?.constructor.name !== 'GoalBlock'; i++) await tick()

  assert.equal(blocks.size, 55)
  assert.ok(reaches.at(-1).isEnd(new Vec3(2, 64, 0)))
  await tick()
  assert.equal(blocks.size, 55, 'an in-reach bot inside the chamber cannot seal it')

  bot.entity.position = new Vec3(2.5, 64, 0.5)
  for (let i = 0; i < 10 && ctx.stepStatus === 'running'; i++) await tick()
  assert.equal(blocks.size, 57)
  assert.equal(ctx.stepStatus, 'done')
  for (const y of [64, 65]) assert.equal(bot.blockAt(new Vec3(2, y, 3)).name, 'air')
})


it('tries a different exterior stand after obstruction or no path', async (t) => {
  t.mock.method(console, 'log', () => {})
  const site = { x: 0, y: 64, z: 0, w: 5, d: 6, cost: 0 }
  const cell = mobTrap().plan().at(-1)
  const blocks = new Map([['2,64,0', 'stone'], ['2,64,1', 'cobblestone']])
  const goals = []
  const bot = {
    entity: { position: new Vec3(2.5, 64, 2.5) },
    inventory: { items: () => [{ name: 'cobblestone', count: 1 }] },
    pathfinder: { isMoving: () => false, setGoal: (goal) => goals.push(goal) },
    blockAt(p) {
      const name = blocks.get(p.toArray().join(',')) || (p.y < 64 ? 'stone' : 'air')
      return { name, position: p, boundingBox: name === 'air' ? 'empty' : 'block' }
    },
    async equip() {},
    async placeBlock(ref, face) { blocks.set(ref.position.plus(face).toArray().join(','), 'cobblestone') },
  }
  const ctx = {
    step: 'fun', stepStatus: 'running',
    funProject: savedProject({ id: 'mob-trap', site, blueprint: [cell] }),
  }
  run(bot, ctx, 'idle')
  assert.ok(goals.at(-1).isEnd(new Vec3(1, 64, 0)))
  ctx.lastPathStatus = 'noPath'
  run(bot, ctx, 'idle')
  assert.ok(goals.at(-1).isEnd(new Vec3(3, 64, 0)))
  assert.equal(blocks.has('2,65,1'), false)

  bot.entity.position = new Vec3(3.5, 64, 0.5)
  run(bot, ctx, 'idle')
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(blocks.get('2,65,1'), 'cobblestone')
})

it('rejects a flooded chamber footprint', () => {
  const project = mobTrap((bot, ctx, opts) => gradedSite(bot, ctx, { ...opts, radius: 6, maxRadius: 6 }))
  const bot = {
    entity: { position: new Vec3(0, 64, 0) },
    blockAt(p) { return { name: p.y >= 64 ? 'air' : p.y === 63 ? 'water' : 'stone' } },
  }
  assert.equal(project.pickSite(bot, {}), null)
})
