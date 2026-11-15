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
      assert.deepStrictEqual({ x: bot.pathfinder.goal.x, z: bot.pathfinder.goal.z }, { x: 3, z: 7 })
      bot.entity.position = { x: 3.5, y: 64, z: 7.5 }
      assert.equal(enclosed.tick(bot, ctx, 9000), false)
      assert.ok(logs.some((l) => l.startsWith('enclosed escape mode=door broken=2 outcome=out')))
    } finally { console.log = orig }
  })
  it('a thick own wall under a roof: never breaks more than MAX_OWN own cells (prod 12:00 tore up 20)', async () => {
    const { bot, ctx, blocks } = world()
    for (const z of [5, 6]) { blocks.set(`3,64,${z}`, 'stone'); blocks.set(`3,65,${z}`, 'stone') }
    for (const z of [5, 6, 7, 8]) blocks.set(`3,66,${z}`, 'stone') // roof: the tunnel is still inside
    const goTo = bot.pathfinder.setGoal
    bot.pathfinder.setGoal = (g) => { goTo(g); if (g && !Number.isFinite(g.x)) return; if (g) bot.entity.position = { x: g.x + 0.5, y: g.y, z: g.z + 0.5 } }
    const logs = []
    const orig = console.log
    console.log = (m) => logs.push(String(m))
    try {
      for (const [i, g] of [[0, 1], [1, 2], [2, 3]]) { bot.pathfinder.setGoal({ x: g * 10, y: 64, z: 0 }); bot.entity.position = { x: 3.5, y: 64, z: 8.5 }; enclosed.tick(bot, ctx, 1000 + i) }
      assert.ok(logs.includes('enclosed at 3,64,8'))
      let t = 2000
      while (!logs.some((l) => l.startsWith('enclosed escape outcome=')) && t < 2100) { enclosed.tick(bot, ctx, t++); await flush() }
      assert.ok(ctx.enclosedEscapes.length <= enclosed.MAX_OWN, logs.join('\n'))
      assert.equal(blocks.get('3,64,5'), 'stone', 'third layer untouched')
      assert.ok(logs.some((l) => /^enclosed escape mode=door broken=[0-4] outcome=refused/.test(l)), logs.join('\n'))
      assert.equal(blocks.get('3,66,6'), 'stone', 'roof untouched')
    } finally { console.log = orig }
  })
  it('recover digs share the own-castle allowance only while enclosed', () => {
    const { bot, ctx } = world()
    const { denyReason } = require('../src/behaviours/util')
    const wall = bot.blockAt({ x: 3, y: 65, z: 7 })
    const rctx = { ...ctx, recovery: {} }
    assert.equal(denyReason(bot, wall, rctx), 'protected')
    rctx.enclosedUntil = Date.now() + 60000
    assert.equal(denyReason(bot, wall, rctx), null)
    assert.equal(denyReason(bot, wall, { ...rctx, recovery: null }), 'protected')
  })
  it('refuses when only foreign (player) builds surround it', () => {
    const { bot, ctx, blocks } = world('oak_planks') // not a castle plan match: someone else's
    const orig = console.log
    const logs = []
    console.log = (m) => logs.push(String(m))
    try {
      for (const [i, g] of [[0, 1], [1, 2], [2, 3]]) { bot.pathfinder.setGoal({ x: g * 10, y: 64, z: 0 }); enclosed.tick(bot, ctx, 1000 + i) }
      assert.ok(logs.includes('enclosed escape refused: no breakable doorway, no climb'))
      assert.equal(blocks.get('3,64,7'), 'oak_planks')
    } finally { console.log = orig }
  })
  it('never opens over a drop', () => {
    const { bot, ctx, blocks } = world()
    blocks.delete('3,63,7')
    assert.equal(enclosed.pickExit(bot, ctx, { x: 3, y: 64, z: 8 }), null)
  })
  it('open sky + scaffold: climbs onto the wall top first, breaks nothing', async () => {
    const { bot, ctx, blocks } = world()
    for (const [x, z] of [[4, 8], [2, 8], [3, 9]]) blocks.set(`${x},66,${z}`, 'bedrock') // 3-high foreign sides
    bot.inventory = { items: () => [{ name: 'dirt', count: 8 }] }
    const goTo = bot.pathfinder.setGoal
    bot.pathfinder.setGoal = (g) => { goTo(g); if (g && Number.isFinite(g.x) && g.y === 66) bot.entity.position = { x: g.x + 0.5, y: g.y, z: g.z + 0.5 } }
    const orig = enclosed.pillar
    let placed = 0
    enclosed.pillar = (b) => { const y = Math.floor(b.entity.position.y); blocks.set(`3,${y},8`, 'dirt'); b.entity.position = { x: 3.5, y: y + 1, z: 8.5 }; placed++; return 'done' }
    const logs = []
    const log = console.log
    console.log = (m) => logs.push(String(m))
    try {
      for (const [i, g] of [[0, 1], [1, 2], [2, 3]]) { bot.pathfinder.setGoal({ x: g * 10, y: 64, z: 0 }); enclosed.tick(bot, ctx, 1000 + i) }
      for (let t = 2000; t < 2020 && !logs.some((l) => l.includes('outcome=')); t++) { enclosed.tick(bot, ctx, t); await flush() }
      assert.equal(placed, 2)
      assert.equal(blocks.get('3,64,7'), 'stone', 'own wall kept')
      assert.ok(logs.some((l) => l.startsWith('enclosed escape mode=up broken=0 outcome=out')), logs.join('\n'))
      assert.equal(ctx.recovery, null)
    } finally { console.log = log; enclosed.pillar = orig }
  })
  it('trapsSelf: the cell that closes the last gap is deferred, with an exit stance outside', () => {
    // Bot at (3,64,8) in a 1-wide corridor: bedrock both sides along z, open to -z and +z.
    const { bot, blocks } = world()
    blocks.delete('3,64,7'); blocks.delete('3,65,7'); blocks.delete('3,64,9'); blocks.delete('3,65,9')
    for (let z = 4; z < 12; z++) for (const x of [2, 4]) { blocks.set(`${x},64,${z}`, 'bedrock'); blocks.set(`${x},65,${z}`, 'bedrock') }
    for (const x of [2, 3, 4]) { blocks.set(`${x},64,11`, 'bedrock'); blocks.set(`${x},65,11`, 'bedrock') } // +z dead end
    for (let z = -20; z < 4; z++) for (let x = -20; x < 20; x++) blocks.set(`${x},63,${z}`, 'stone') // open floor beyond -z
    assert.equal(enclosed.trapsSelf(bot, { x: 3, y: 65, z: 2 }), null, 'far side placement: harmless')
    const exit = enclosed.trapsSelf(bot, { x: 3, y: 64, z: 6 })
    assert.ok(exit && exit.z < 6, `exit beyond the cell, got ${JSON.stringify(exit)}`)
  })
  it('castle progress: escape-opened cells re-lay without a damage line', () => {
    const castle = require('../src/behaviours/castle')
    const cells = [0, 1, 2].map((i) => ({ idx: i, kind: 'stone', x: i, y: 65, z: 7 }))
    const w = new Map(cells.map((c) => [`${c.x},${c.y},${c.z}`, 'stone']))
    const bot = { blockAt: (p) => ({ name: w.get(`${p.x},${p.y},${p.z}`) || 'air' }) }
    const st = { site: { x: 0, y: 64, z: 0 }, rot: 0 }
    const ctx = {}
    const logs = []
    const log = console.log
    console.log = (m) => logs.push(String(m))
    try {
      castle.progress(bot, st, cells, ctx)
      w.delete('1,65,7')
      ctx.enclosedEscapes = [{ x: 1, y: 65, z: 7, name: 'stone' }]
      ctx.castleCursor = 3
      castle.progress(bot, st, cells, ctx)
    } finally { console.log = log }
    assert.ok(logs.includes('castle relay escape=1'), logs.join('\n'))
    assert.ok(!logs.some((l) => l.startsWith('castle damage')))
    assert.equal(ctx.castleDangerAt, undefined)
    assert.equal(ctx.castleCursor, 0, 'scan re-reads from 0: the cell is queued again')
    assert.deepStrictEqual(ctx.enclosedEscapes, [])
  })
  it('yard-protected natural dirt is a cheaper doorway than an own wall (prod 13:00 refused:protected)', async () => {
    const { bot, ctx, blocks } = world()
    blocks.set('2,64,8', 'dirt'); blocks.set('2,65,8', 'dirt')
    const { denyReason } = require('../src/behaviours/util')
    assert.equal(denyReason(bot, bot.blockAt({ x: 2, y: 64, z: 8 }), ctx), 'protected', 'work rules keep yard dirt')
    const [first] = enclosed.pickExits(bot, ctx, { x: 3, y: 64, z: 8 })
    assert.deepStrictEqual({ dx: first.dx, dz: first.dz }, { dx: -1, dz: 0 })
    const log = console.log
    console.log = () => {}
    try {
      for (const [i, g] of [[0, 1], [1, 2], [2, 3]]) { bot.pathfinder.setGoal({ x: g * 10, y: 64, z: 0 }); enclosed.tick(bot, ctx, 1000 + i) }
      for (let t = 2000; t < 2006; t++) { enclosed.tick(bot, ctx, t); await flush() }
    } finally { console.log = log }
    assert.ok(!blocks.has('2,64,8') && !blocks.has('2,65,8'), 'dirt doorway dug')
    assert.equal(blocks.get('3,64,7'), 'stone', 'own wall kept')
    assert.equal(ctx.enclosedEscapes, undefined, 'nothing to re-lay')
  })
  it('roofed + scaffold: digs the roof cell over the head, then climbs', async () => {
    const { bot, ctx, blocks } = world()
    for (const [x, z] of [[4, 8], [2, 8], [3, 9]]) blocks.set(`${x},66,${z}`, 'bedrock')
    blocks.set('3,66,8', 'dirt') // roof over the head (yard dirt: work-protected)
    bot.inventory = { items: () => [{ name: 'dirt', count: 8 }] }
    const goTo = bot.pathfinder.setGoal
    bot.pathfinder.setGoal = (g) => { goTo(g); if (g && Number.isFinite(g.x) && g.y === 66) bot.entity.position = { x: g.x + 0.5, y: g.y, z: g.z + 0.5 } }
    const orig = enclosed.pillar
    enclosed.pillar = (b) => { const y = Math.floor(b.entity.position.y); blocks.set(`3,${y},8`, 'dirt'); b.entity.position = { x: 3.5, y: y + 1, z: 8.5 }; return 'done' }
    const logs = []
    const log = console.log
    console.log = (m) => logs.push(String(m))
    try {
      for (const [i, g] of [[0, 1], [1, 2], [2, 3]]) { bot.pathfinder.setGoal({ x: g * 10, y: 64, z: 0 }); enclosed.tick(bot, ctx, 1000 + i) }
      for (let t = 2000; t < 2020 && !logs.some((l) => l.includes('outcome=')); t++) { enclosed.tick(bot, ctx, t); await flush() }
    } finally { console.log = log; enclosed.pillar = orig }
    assert.ok(logs.some((l) => l.startsWith('enclosed escape mode=up broken=0 outcome=out')), logs.join('\n'))
    assert.equal(blocks.get('3,64,7'), 'stone', 'own wall kept')
  })
  it('still stuck after a refusal: re-tries at the cooldown without new noPath targets; recover drops sidestep', () => {
    const { bot, ctx } = world('oak_planks')
    const logs = []
    const log = console.log
    console.log = (m) => logs.push(String(m))
    try {
      for (const [i, g] of [[0, 1], [1, 2], [2, 3]]) { bot.pathfinder.setGoal({ x: g * 10, y: 64, z: 0 }); enclosed.tick(bot, ctx, 1000 + i) }
      ctx.lastPathStatus = null
      ctx.stuck = true
      enclosed.tick(bot, ctx, 2000) // inside the cooldown
      enclosed.tick(bot, ctx, 1002 + enclosed.WINDOW_MS + 1)
    } finally { console.log = log }
    assert.equal(logs.filter((l) => l === 'enclosed at 3,64,8').length, 2)
    const { RECOVER_MENU } = require('../src/behaviours/recover')
    assert.equal(RECOVER_MENU.sidestep.feasible({ walls: 2 }, ctx), false, 'no shuffle while enclosed')
    assert.equal(RECOVER_MENU.sidestep.feasible({ walls: 2 }, {}), true)
  })
})
