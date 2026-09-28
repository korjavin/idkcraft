'use strict'

// 1wj: sidestep swims AWAY from the wall when stuck in water against one.
// The shore current pushes every tick's prediction back into face-touch and
// Paper 26.x rejects the whole move on any touch — a random side swims
// along the face and re-touches forever (rig: 10-20/s storm, disp 0.00).
// Away clears the face and frees the body in ~2 s. Dry keeps the random
// pick (along-wall can round the obstacle); corners and open water too.

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { Vec3 } = require('vec3')
const recover = require('../src/behaviours/recover')

function pos(x, y, z) {
  return {
    x, y, z,
    distanceTo: (q) => Math.hypot(x - q.x, y - q.y, z - q.z),
    clone() { return pos(x, y, z) },
  }
}

function key(x, y, z) { return `${x},${y},${z}` }

// cells: Map key -> block name ('dirt' solid, 'water' wet, default 'air').
// Bot floats at (0.5, 61, 0.5): feet cell (0,61,0).
function waterBot(cells, inWater) {
  const bot = {
    username: 'IdkBot',
    players: {},
    entities: {},
    health: 20,
    entity: { position: pos(0.5, 61, 0.5), onGround: false, isInWater: inWater },
    inventory: { items: () => [] },
    controls: {},
    chats: [],
    chat(m) { this.chats.push(m) },
    setControlState(c, v) { this.controls[c] = !!v },
    getControlState(c) { return !!this.controls[c] },
    blockAt(p) {
      const n = cells.get(key(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z))) || 'air'
      return {
        name: n,
        position: new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)),
        boundingBox: n === 'dirt' ? 'block' : 'empty',
      }
    },
    pathfinder: { goal: null, setGoal(g) { this.goal = g } },
  }
  return bot
}

function stuckCtx() {
  return {
    stuck: { by: 'follow', goal: { x: 10, y: 61, z: 0 }, key: 'follow:Steve' },
    brain: { source: 'stub', ask: async () => 'sidestep' },
  }
}

// Drive decide() + one run() tick with Math.random pinned, return the
// sidestep state. restores Math.random.
async function sidestepDir(bot, rand) {
  const ctx = stuckCtx()
  const orig = Math.random
  Math.random = () => rand
  try {
    await recover.decide(bot, ctx, null, null)
    assert.equal(ctx.recovery && ctx.recovery.action, 'sidestep', 'stub brain picks sidestep')
    recover.run(bot, ctx)
    return { dir: ctx.recovery.st && ctx.recovery.st.dir, goal: bot.pathfinder.goal }
  } finally {
    Math.random = orig
  }
}

describe('recover 1wj: wet sidestep swims away from the wall', () => {
  // Shore: +x is a 2-high dirt bank (no hop step), feet are water.
  function shoreCells() {
    const cells = new Map()
    cells.set(key(0, 61, 0), 'water')
    cells.set(key(1, 61, 0), 'dirt')
    cells.set(key(1, 62, 0), 'dirt')
    return cells
  }

  it('wet single wall: away even when random points along the face', async () => {
    const bot = waterBot(shoreCells(), true)
    // free (SIDES order) = [[-1,0],[0,1],[0,-1]]: rand 0.99 takes [0,-1]
    // (along the face) without the fix.
    const { dir, goal } = await sidestepDir(bot, 0.99)
    assert.deepEqual(dir, [-1, 0], `swims away (-x), got ${JSON.stringify(dir)}`)
    assert.ok(goal && goal.x < 0.5, `goal is west of the body, got ${goal && goal.x}`)
  })

  it('dry single wall: random pick preserved', async () => {
    const cells = shoreCells()
    cells.set(key(0, 61, 0), 'air')
    const bot = waterBot(cells, false)
    const { dir } = await sidestepDir(bot, 0.99)
    assert.deepEqual(dir, [0, -1], `dry keeps random, got ${JSON.stringify(dir)}`)
  })

  it('wet corner: random pick preserved (no single face)', async () => {
    const cells = shoreCells()
    cells.set(key(0, 61, 1), 'dirt')
    cells.set(key(0, 62, 1), 'dirt')
    const bot = waterBot(cells, true)
    // free = [[-1,0],[0,-1]]: rand 0.99 takes [0,-1].
    const { dir } = await sidestepDir(bot, 0.99)
    assert.deepEqual(dir, [0, -1], `corner keeps random, got ${JSON.stringify(dir)}`)
  })

  it('wet open water: random pick preserved', async () => {
    const cells = new Map()
    cells.set(key(0, 61, 0), 'water')
    const bot = waterBot(cells, true)
    const { dir } = await sidestepDir(bot, 0)
    assert.deepEqual(dir, [1, 0], `open water keeps random, got ${JSON.stringify(dir)}`)
  })
})
