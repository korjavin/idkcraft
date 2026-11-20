'use strict'

const { it } = require('node:test')
const assert = require('node:assert/strict')
const Vec3 = require('vec3')
const projects = require('../src/behaviours/fun-projects')
const { isFlower, isSapling } = require('../src/behaviours/fun-nature')

function body(items) {
  return {
    entity: { position: new Vec3(0.5, 64, 0.5) },
    inventory: { items: () => items },
    pathfinder: { isMoving: () => false, setGoal() {} },
    blockAt(p) {
      const name = p.y < 64 ? 'grass_block' : 'air'
      return { name, position: p, boundingBox: name === 'air' ? 'empty' : 'block' }
    },
  }
}

function pickWith(items, roll, ctx = {}) {
  const c = { step: 'fun', stepStatus: 'running', ...ctx }
  t0.mock.method(console, 'log', () => {})
  projects.run(body(items), c, 'idle', () => roll)
  return c.funProject
}
let t0

const plants = (p) => p.blueprint.filter((c) => c.kind === 'block')

it('registers the oasis and the flower field and picks both by the weighted roll', (t) => {
  t0 = t
  const items = [{ name: 'oak_sapling', count: 3 }, { name: 'birch_sapling', count: 2 }, { name: 'poppy', count: 30 }]
  const ids = new Set([0.01, 0.99].map((r) => pickWith(items, r).id))
  assert.deepEqual([...ids].sort(), ['flowers', 'oasis'])
  assert.equal(projects.available(body([]), {}), false)
  assert.equal(projects.available(body([{ name: 'oak_sapling', count: 1 }]), {}), false)
  // Chest stock counts: the runner's resolver fetches it.
  assert.equal(projects.available(body([]), { chests: [{ x: 1, y: 64, z: 1, contents: { dandelion: 6 } }] }), true)
})

it('oasis: spaced saplings on soil, a centre pool only with a bucket', (t) => {
  t0 = t
  const p = pickWith([{ name: 'oak_sapling', count: 9 }, { name: 'dark_oak_sapling', count: 9 }], 0)
  assert.equal(p.id, 'oasis')
  const trees = plants(p)
  assert.equal(trees.length, 5)
  assert.ok(trees.every((c) => c.block === 'oak_sapling' && c.dy === 0))
  for (const a of trees) for (const b of trees) if (a !== b) assert.ok(Math.max(Math.abs(a.dx - b.dx), Math.abs(a.dz - b.dz)) >= 2)
  assert.ok(!p.blueprint.some((c) => c.kind === 'water'))
  const wet = pickWith([{ name: 'oak_sapling', count: 9 }, { name: 'bucket', count: 1 }], 0)
  assert.equal(plants(wet).length, 4)
  assert.deepEqual(wet.blueprint.filter((c) => c.kind === 'water').map((c) => [c.dx, c.dy, c.dz]), [[3, -1, 3]])
})

it('flower field: any single flower on a walkable checkerboard inside 9x5', (t) => {
  t0 = t
  const p = pickWith([{ name: 'poppy', count: 4 }, { name: 'cornflower', count: 40 }, { name: 'sunflower', count: 9 }], 0)
  assert.equal(p.id, 'flowers')
  const fl = plants(p)
  assert.equal(fl.length, 23)
  assert.ok(fl.every((c) => isFlower(c.block) && c.dy === 0 && (c.dx + c.dz) % 2 === 0 && c.dx < 9 && c.dz < 5))
  assert.equal(fl.filter((c) => c.block === 'poppy').length, 4)
  assert.ok(!isFlower('sunflower') && !isSapling('dark_oak_sapling'))
})
