'use strict'

// Castle upkeep on a tall castle (owner 2026-11-17, prod bot3: nothing above
// y73 was ever swept): a litter column clears top-down from its own top, and
// a target the body cannot get closer to retires so the next one is picked.

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { Vec3 } = require('vec3')
const blueprint = require('../src/castle')
const castle = require('../src/behaviours/castle')

const SITE = { x: 100, y: 64, z: 200 }
const V = 2
const own = (extra) => ({ site: { ...SITE }, rot: 0, blueprintVersion: V, phase: 'complete', blocked: {}, ...extra })
const key = (x, y, z) => `${Math.floor(x)},${Math.floor(y)},${Math.floor(z)}`
const LAID = { stone: 'cobblestone', planks: 'oak_planks', frame: 'oak_log', fence: 'oak_fence', door: 'oak_door', torch: 'torch', chest: 'chest' }
const DECOR_LAID = { pane: 'glass_pane', banner: 'white_wall_banner', gate: 'oak_fence_gate', bookshelf: 'bookshelf', enchanting_table: 'enchanting_table', blast_furnace: 'blast_furnace', fence: 'oak_fence' }
function painted() {
  const cells = new Map()
  for (const c of blueprint.absPlan(SITE, 0, V).cells) cells.set(key(c.x, c.y, c.z), blueprint.isPlaceTarget(c.kind) ? LAID[c.kind] : 'air')
  for (const c of blueprint.decorPlan(SITE, 0, V).cells) if (DECOR_LAID[c.kind]) cells.set(key(c.x, c.y, c.z), DECOR_LAID[c.kind])
  return cells
}
function worldBot(cells, pos) {
  return {
    entity: { position: new Vec3(pos.x, pos.y, pos.z) },
    inventory: { items: () => [{ name: 'dirt', count: 64 }] },
    players: {},
    pathfinder: { goal: null, setGoal(g) { this.goal = g }, isMoving: () => false, stop() {} },
    setControlState() {},
    clearControlStates() {},
    chat() {},
    equip: async () => {},
    blockAt(p) {
      const x = Math.floor(p.x); const y = Math.floor(p.y); const z = Math.floor(p.z)
      const k = key(x, y, z)
      const name = cells.has(k) ? cells.get(k) : (y < SITE.y ? 'dirt' : 'air')
      return { name, position: new Vec3(x, y, z), boundingBox: name === 'air' ? 'empty' : 'block' }
    },
  }
}
const quiet = (fn) => async () => {
  const logs = []
  const log = console.log
  console.log = (m) => logs.push(String(m))
  try { await fn(logs) } finally { console.log = log }
}
const tick = () => new Promise((r) => setImmediate(r))

describe('castle upkeep on a tall castle', () => {
  it('a 10-high litter column next to a wall clears top-down from its top', quiet(async (logs) => {
    const cells = painted()
    const at = blueprint.absPlan(SITE, 0, V).at
    // the column hugs the west wall from outside (wall at SITE.x + 7, column at SITE.x + 6)
    const z = SITE.z + 10
    const x = SITE.x + 6
    assert.ok(at.has(key(SITE.x + 7, SITE.y + 1, z)) && !at.has(key(x, SITE.y, z)))
    for (let y = SITE.y; y < SITE.y + 10; y++) cells.set(key(x, y, z), 'dirt')
    const bot = worldBot(cells, { x: x + 0.5, y: SITE.y + 10, z: z + 0.5 }) // standing on its top
    const dug = []
    bot.dig = async (b) => {
      dug.push(b.position.y)
      cells.set(key(b.position.x, b.position.y, b.position.z), 'air')
      if (Math.floor(bot.entity.position.y) - 1 === b.position.y) bot.entity.position.y -= 1 // drop onto the next block
    }
    const ctx = { castle: own({ visitedAt: Date.now() }) }
    for (let i = 0; i < 80 && dug.length < 10; i++) { castle(bot, ctx); await tick() }
    assert.deepEqual(dug, Array.from({ length: 10 }, (_, i) => SITE.y + 9 - i), logs.filter((l) => /castle/.test(l)).slice(-5).join('|'))
    castle(bot, ctx)
    assert.ok(logs.includes(`castle upkeep kind=litter cell=${x},${SITE.y + 9},${z} result=ok`))
  }))

  it('an unreachable high target is retired and the next target is picked', quiet(async (logs) => {
    const st = own()
    const high = { x: SITE.x + 2, y: SITE.y + 25, z: SITE.z + 2, kind: 'air', idx: castle.LITTER_BOX_BASE + 7 }
    const next = { x: SITE.x + 9, y: SITE.y, z: SITE.z + 9, kind: 'air', idx: castle.LITTER_BOX_BASE + 8 }
    const list = [high, next]
    const bot = worldBot(new Map([[key(high.x, high.y, high.z), 'dirt'], [key(next.x, next.y, next.z), 'dirt']]), { x: SITE.x + 2.5, y: SITE.y, z: SITE.z + 2.5 })
    const ctx = { castle: st, castleUpkeep: high, castleGoalIdx: high.idx }
    let now = 1000000
    assert.equal(castle.nextLitter(st, list, now, bot, ctx).idx, high.idx, 'latched on the high target')
    // the walk never ends (isMoving latched): only the stall guard can strike
    bot.pathfinder.isMoving = () => true
    assert.equal(castle.upkeepDone(bot, ctx, st, now, high), false, 'arms the watch')
    now += 91000
    assert.equal(castle.upkeepDone(bot, ctx, st, now, high), true, 'struck after the stall window')
    assert.equal(st.blocked[`2:${high.idx}`].why, 'unreachable')
    assert.ok(logs.some((l) => l.startsWith(`castle upkeep kind=litter cell=${high.x},${high.y},${high.z} result=fail:unreachable`)))
    assert.equal(castle.nextLitter(st, list, now, bot, ctx).idx, next.idx, 'next target picked right away')
  }))
})
