'use strict'
const { describe, it } = require('node:test')
const assert = require('node:assert')
const enclosed = require('../src/enclosed')

// Bot at (3,64,8) boxed in: the castle wall plan cell (3,64,7)+(3,65,7) to the
// north (laid stone, protected), foreign bedrock on the other three sides.
function world(wall = 'stone') {
  const blocks = new Map()
  const set = (x, y, z, name) => blocks.set(`${x},${y},${z}`, name)
  for (let x = 0; x < 8; x++) for (let z = 4; z < 12; z++) set(x, 63, z, 'stone')
  for (const [x, z] of [[4, 8], [2, 8], [3, 9]]) { set(x, 64, z, 'bedrock'); set(x, 65, z, 'bedrock') }
  set(3, 64, 7, wall); set(3, 65, 7, wall)
  const at = (p) => {
    const name = blocks.get(`${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`) || 'air'
    return { name, position: { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) }, boundingBox: name === 'air' ? 'empty' : 'block' }
  }
  let goal = null
  const bot = {
    entity: { position: { x: 3.5, y: 64, z: 8.5 }, onGround: true },
    blockAt: at,
    dig: async (b) => { blocks.delete(`${b.position.x},${b.position.y},${b.position.z}`) },
    equip: async () => {},
    pathfinder: { get goal() { return goal }, setGoal: (g) => { goal = g } },
  }
  const ctx = { castle: { site: { x: 0, y: 64, z: 0 }, rot: 0 }, lastPathStatus: 'noPath' }
  return { bot, ctx, blocks }
}
const flush = () => new Promise((r) => setImmediate(r))

describe('enclosed escape (prod 2026-11-15 bot3 trapped in its castle)', () => {
  it('noPath on one target never trips; 3 distinct targets in 60 s does, and the own wall opens', async () => {
    const { bot, ctx, blocks } = world()
    const logs = []
    const orig = console.log
    console.log = (m) => logs.push(String(m))
    try {
      bot.pathfinder.setGoal({ x: 50, y: 64, z: 50 })
      assert.equal(enclosed.tick(bot, ctx, 1000), false)
      assert.equal(enclosed.tick(bot, ctx, 2000), false) // same target again
      bot.pathfinder.setGoal({ x: -50, y: 64, z: 0 })
      assert.equal(enclosed.tick(bot, ctx, 3000), false)
      bot.pathfinder.setGoal({ x: 0, y: 70, z: 90 })
      assert.equal(enclosed.tick(bot, ctx, 4000), true)
      assert.ok(logs.includes('enclosed at 3,64,8'))
      for (let i = 0; i < 4; i++) { enclosed.tick(bot, ctx, 5000 + i); await flush() }
      assert.ok(!blocks.has('3,64,7') && !blocks.has('3,65,7'), 'own wall doorway opened')
      assert.equal(blocks.get('4,64,8'), 'bedrock', 'foreign blocks untouched')
      assert.deepStrictEqual(ctx.enclosedEscapes.map((c) => `${c.x},${c.y},${c.z}`).sort(), ['3,64,7', '3,65,7'])
      assert.equal(ctx.castleCursor, 0) // re-lay pass
      assert.deepStrictEqual({ x: bot.pathfinder.goal.x, z: bot.pathfinder.goal.z }, { x: 3, z: 6 })
      bot.entity.position = { x: 3.5, y: 64, z: 6.5 }
      assert.equal(enclosed.tick(bot, ctx, 9000), false)
      assert.ok(logs.some((l) => l.startsWith('enclosed escape outcome=out')))
    } finally { console.log = orig }
  })
  it('refuses when only foreign (player) builds surround it', () => {
    const { bot, ctx, blocks } = world('oak_planks') // not a castle plan match: someone else's
    const orig = console.log
    const logs = []
    console.log = (m) => logs.push(String(m))
    try {
      for (const [i, g] of [[0, 1], [1, 2], [2, 3]]) { bot.pathfinder.setGoal({ x: g * 10, y: 64, z: 0 }); enclosed.tick(bot, ctx, 1000 + i) }
      assert.ok(logs.includes('enclosed escape refused: no own-build doorway'))
      assert.equal(blocks.get('3,64,7'), 'oak_planks')
    } finally { console.log = orig }
  })
  it('never opens over a drop', () => {
    const { bot, ctx, blocks } = world()
    blocks.delete('3,63,7')
    assert.equal(enclosed.pickExit(bot, ctx, { x: 3, y: 64, z: 8 }), null)
  })
})
