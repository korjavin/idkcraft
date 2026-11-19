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
  it('recover stuck digs share the ladder (prod 2026-11-16 bot3 dig_through failed:protected x41): own cell digs + re-lay, danger refuses, cheapest first', () => {
    const { bot, ctx } = world()
    ctx.recovery = { action: 'dig_through' }
    const logs = []
    const orig = console.log
    console.log = (m) => logs.push(String(m))
    try {
      const wall = bot.blockAt({ x: 3, y: 65, z: 7 })
      assert.equal(enclosed.stuckDeny(bot, ctx, wall), null, 'own castle cell no longer refused')
      assert.deepStrictEqual(ctx.enclosedEscapes.map((c) => `${c.x},${c.y},${c.z}`), ['3,65,7'])
      assert.equal(ctx.castleCursor, 0)
      assert.ok(ctx.ownBreakUntil > Date.now(), 'pathfinder own-break window opens')
      assert.equal(enclosed.stuckDeny(bot, ctx, bot.blockAt({ x: 4, y: 64, z: 8 })), 'unbreakable')
      assert.equal(enclosed.stuckDeny(bot, ctx, { name: 'lava', position: { x: 0, y: 64, z: 0 }, boundingBox: 'empty' }), 'liquid')
      assert.ok(enclosed.stuckCost(bot, ctx, wall) > enclosed.stuckCost(bot, ctx, { name: 'dirt', position: { x: 9, y: 64, z: 9 }, boundingBox: 'block' }))
    } finally { console.log = orig }
  })
  it('refuses only on physics: unbreakable walls all round', () => {
    const { bot, ctx, blocks } = world('bedrock')
    const orig = console.log
    const logs = []
    console.log = (m) => logs.push(String(m))
    try {
      for (const [i, g] of [[0, 1], [1, 2], [2, 3]]) { bot.pathfinder.setGoal({ x: g * 10, y: 64, z: 0 }); enclosed.tick(bot, ctx, 1000 + i) }
      assert.ok(logs.some((l) => l.startsWith('enclosed escape refused: no breakable doorway, no climb, no descent')))
      assert.equal(blocks.get('3,64,7'), 'bedrock')
    } finally { console.log = orig }
  })
  it('foreign builds and containers are candidates, last resort: natural < own < foreign < chest', () => {
    const { bot, ctx, blocks } = world('oak_planks') // north: someone else's planks
    blocks.set('2,64,8', 'chest'); blocks.set('2,65,8', 'air') // west: a chest
    blocks.set('4,64,8', 'stone'); blocks.set('4,65,8', 'stone') // east: own? no, natural stone off plan
    const order = enclosed.pickExits(bot, ctx, { x: 3, y: 64, z: 8 }).map((d) => `${d.dx},${d.dz}`)
    assert.deepStrictEqual(order, ['1,0', '0,-1', '-1,0'])
  })
  it('a broken chest: walks over its drops before going on', async () => {
    const { bot, ctx, blocks } = world('bedrock')
    blocks.set('2,64,8', 'chest'); blocks.delete('2,65,8')
    bot.entities = {}
    bot.dig = async (b) => { blocks.delete(`${b.position.x},${b.position.y},${b.position.z}`); bot.entities[1] = { name: 'item', position: { x: 2.5, y: 64, z: 8.5 } } }
    const log = console.log
    const logs = []
    console.log = (m) => logs.push(String(m))
    try {
      for (const [i, g] of [[0, 1], [1, 2], [2, 3]]) { bot.pathfinder.setGoal({ x: g * 10, y: 64, z: 0 }); enclosed.tick(bot, ctx, 1000 + i) }
      await flush()
      enclosed.tick(bot, ctx, 2000)
    } finally { console.log = log }
    assert.ok(logs.some((l) => l.startsWith('enclosed escape broke keep chest at 2,64,8')), logs.join('\n'))
    assert.deepStrictEqual({ x: bot.pathfinder.goal.x, y: bot.pathfinder.goal.y, z: bot.pathfinder.goal.z }, { x: 2, y: 64, z: 8 })
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
  it('own-dug cell in any phase: retired strike cleared, requeued, integrity counts the restore', () => {
    const castle = require('../src/behaviours/castle')
    const cells = [0, 1].map((i) => ({ idx: i, kind: 'stone', x: i, y: 65, z: 7 }))
    const w = new Map(cells.map((c) => [`${c.x},${c.y},${c.z}`, 'stone']))
    const bot = { blockAt: (p) => ({ name: w.get(`${p.x},${p.y},${p.z}`) || 'air' }) }
    const st = { site: { x: 0, y: 64, z: 0 }, rot: 0, phase: 'body', blocked: {} }
    const ctx = {}
    const logs = []
    const log = console.log
    console.log = (m) => logs.push(String(m))
    try {
      castle.progress(bot, st, cells, ctx)
      w.delete('1,65,7')
      const bk = `${require('../src/castle').blueprintOf().version}:1`
      st.blocked[bk] = { tries: 1, until: Date.now() + 60000 }
      ctx.ownBreakUntil = Date.now() + 60000
      castle.progress(bot, st, cells, ctx)
      assert.ok(logs.includes('castle own-dug cell=1,65,7 by=ownbreak requeued'), logs.join('\n'))
      assert.equal(st.blocked[bk], undefined, 'stale strike cleared: fresh ladder')
      // struck out while dug: the integrity tick re-arms it, then counts the re-lay
      st.blocked[bk] = { tries: 3, until: 0, retired: true }
      ctx.castleIntegrity.at = 0
      castle.progress(bot, st, cells, ctx)
      assert.ok(!Object.values(st.blocked).some((e) => e && e.retired), JSON.stringify(st.blocked))
      w.set('1,65,7', 'stone')
      ctx.castleIntegrity.at = 0
      castle.progress(bot, st, cells, ctx)
    } finally { console.log = log }
    assert.ok(logs.includes('castle integrity built=2 dug=1 restored=1'), logs.join('\n'))
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
    const { bot, ctx } = world('bedrock')
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
  it('on a tall pillar top (every side a drop): digs down the pillar until it can walk off', async () => {
    // Pillar column x=3,z=8 from y=64 to y=70 over the stone floor (y=63); the bot stands on it at y=71.
    const { bot, ctx, blocks } = world()
    for (const k of ['3,64,7', '3,65,7', '4,64,8', '4,65,8', '2,64,8', '2,65,8', '3,64,9', '3,65,9']) blocks.delete(k)
    for (let y = 64; y <= 70; y++) blocks.set(`3,${y},8`, 'dirt')
    for (let x = -10; x < 17; x++) for (let z = -5; z < 22; z++) blocks.set(`${x},63,${z}`, 'stone') // open ground
    bot.entity.position = { x: 3.5, y: 71, z: 8.5 }
    bot.health = 20
    const dig = bot.dig
    bot.dig = async (b) => { await dig(b); bot.entity.position = { x: 3.5, y: b.position.y, z: 8.5 } } // falls one cell
    const logs = []
    const log = console.log
    console.log = (m) => logs.push(String(m))
    try {
      for (const [i, g] of [[0, 1], [1, 2], [2, 3]]) { bot.pathfinder.setGoal({ x: g * 10, y: 64, z: 0 }); enclosed.tick(bot, ctx, 1000 + i) }
      for (let t = 2000; t < 2100 && !logs.some((l) => l.includes('outcome=')); t++) { enclosed.tick(bot, ctx, t); await flush() }
    } finally { console.log = log }
    assert.ok(logs.some((l) => l.startsWith('enclosed escape mode=down') && l.includes('outcome=out')), logs.join('\n'))
    assert.ok(bot.entity.position.y <= 65, 'within a step of the ground')
    assert.equal(blocks.get('3,63,8'), 'stone', 'never dug below the ground once out')
  })
  it('never descends into lava or a lethal fall; logs the 3x3x3 cage after repeated refusals', () => {
    const { bot, ctx, blocks } = world('bedrock')
    blocks.set('3,63,8', 'dirt'); blocks.set('3,62,8', 'lava')
    for (const [x, z] of [[4, 8], [2, 8], [3, 9]]) blocks.set(`${x},66,${z}`, 'bedrock')
    const logs = []
    const log = console.log
    console.log = (m) => logs.push(String(m))
    try {
      for (let r = 0; r < 3; r++) for (const [i, g] of [[0, 1], [1, 2], [2, 3]]) { bot.pathfinder.setGoal({ x: g * 10 + r * 100, y: 64, z: 0 }); enclosed.tick(bot, ctx, 1000 + r * 70000 + i) }
    } finally { console.log = log }
    assert.equal(blocks.get('3,63,8'), 'dirt')
    assert.ok(logs.some((l) => l.includes('no descent (lava)')), logs.join('\n'))
    assert.equal(logs.filter((l) => l.startsWith('enclosed cage at 3,64,8: y-1=[')).length, 1)
  })
  it('a room with a wooden door is not enclosed: nothing broken (prod 2026-11-18 bot3 own planks re-laid 10x)', () => {
    const { bot, ctx, blocks } = world('oak_door')
    for (let z = 4; z < 40; z++) for (let x = 0; x < 8; x++) blocks.set(`${x},63,${z}`, 'stone')
    for (let z = 0; z < 4; z++) for (let x = 0; x < 8; x++) blocks.set(`${x},63,${z}`, 'stone')
    const logs = []
    const orig = console.log
    console.log = (m) => logs.push(String(m))
    try {
      for (const [i, g] of [[0, 1], [1, 2], [2, 3]]) { bot.pathfinder.setGoal({ x: g * 10, y: 64, z: 0 }); enclosed.tick(bot, ctx, 1000 + i) }
      assert.ok(logs.includes('enclosed skip at 3,64,8: walkable exit'), logs.join('\n'))
      assert.ok(!logs.includes('enclosed at 3,64,8'))
      assert.equal(blocks.get('3,64,7'), 'oak_door')
    } finally { console.log = orig }
  })
  it('an own cell dug and re-laid 3 times refuses the 4th stuck dig (prod bot3 stair dug 18x)', () => {
    const { bot, ctx } = world()
    ctx.recovery = { action: 'dig_through' }
    const orig = console.log
    console.log = () => {}
    try {
      const wall = bot.blockAt({ x: 3, y: 65, z: 7 })
      for (let i = 0; i < 3; i++) assert.equal(enclosed.stuckDeny(bot, ctx, wall), null)
      assert.equal(enclosed.stuckDeny(bot, ctx, wall), 'relooped')
    } finally { console.log = orig }
  })
})
