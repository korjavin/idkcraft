'use strict'

// Bead idkcraft-vmzq.55: the castle gauge was blind to the 326 moat 'dig'
// cells (prod 2026-10-09: 1613/1722 flat 25 min while the bot dug the moat,
// 7 JEV rounds and a plan-B on real progress). progress() now counts dig
// cells (done = world block is air), keep-clear 'air' cells stay out, and
// castleCurrent hands the executive the combined value.

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const blueprint = require('../src/castle')
const castle = require('../src/behaviours/castle')
const task = require('../src/task')

const SITE = { x: 100, y: 64, z: 200 }
const NAME = { stone: 'cobblestone', planks: 'oak_planks', frame: 'oak_log', door: 'oak_door', torch: 'torch', fence: 'oak_fence', chest: 'chest', air: 'air', dig: 'dirt' }

function k(x, y, z) { return `${x},${y},${z}` }

// Every place cell laid, every moat cell still dirt, keep-clear air clear.
function world() {
  const { cells } = blueprint.absPlan(SITE, 0, 2)
  const w = new Map()
  for (const c of cells) w.set(k(c.x, c.y, c.z), NAME[c.kind])
  return { cells, w }
}

function botOf(w) {
  return {
    entity: { position: { x: SITE.x + 2, y: 65, z: SITE.z + 2 } },
    inventory: { items: () => [] },
    blockAt: (p) => ({ name: w.get(k(p.x, p.y, p.z)) || 'air', boundingBox: 'block', position: p }),
  }
}

function quiet(fn) {
  const logs = []
  const orig = console.log
  console.log = (...a) => logs.push(a.join(' '))
  try { fn() } finally { console.log = orig }
  return logs
}

describe('vmzq.55 castle gauge counts the moat dig cells', () => {
  it('place cells done, moat undug: done < total; one dug cell raises done by 1 with a new line', () => {
    const { cells, w } = world()
    const digs = cells.filter((c) => c.kind === 'dig')
    const place = cells.filter((c) => blueprint.isPlaceTarget(c.kind)).length
    assert.equal(digs.length, 326)
    const bot = botOf(w)
    const ctx = { castle: { site: { ...SITE }, rot: 0, blueprintVersion: 2, phase: 'body', blocked: {} } }
    let now = 1e9
    let logs = quiet(() => castle.menuFact(bot, ctx, now))
    assert.deepEqual(ctx.castle.progress, { done: place, total: place + 326 })
    assert.ok(logs.includes(`castle ${place}/${place + 326}`), JSON.stringify(logs))

    w.set(k(digs[0].x, digs[0].y, digs[0].z), 'air')
    now += castle.FULL_RESCAN_MS
    logs = quiet(() => castle.menuFact(bot, ctx, now))
    assert.equal(ctx.castle.progress.done, place + 1)
    assert.ok(logs.includes(`castle ${place + 1}/${place + 326}`), JSON.stringify(logs))

    // The executive's clock reads the combined value.
    const cur = task.castleCurrent(bot, ctx, ctx.castle, now)
    assert.equal(cur.done, place + 1)
    assert.equal(cur.total, place + 326)

    // Owner chat breakdown: the moat reads dug/total beside the materials.
    assert.deepEqual(castle.progressByKind(bot, ctx.castle).moat, { done: 1, total: 326 })
  })

  it('a refilled moat cell keeps its count: refill -> re-dig is not growth', () => {
    const { cells, w } = world()
    const dig = cells.find((c) => c.kind === 'dig')
    const bot = botOf(w)
    const ctx = { castle: { site: { ...SITE }, rot: 0, blueprintVersion: 2, phase: 'body', blocked: {} } }
    let now = 1e9
    w.set(k(dig.x, dig.y, dig.z), 'air')
    quiet(() => castle.menuFact(bot, ctx, now))
    const dug = ctx.castle.progress.done
    for (const name of ['cobblestone', 'air']) {
      w.set(k(dig.x, dig.y, dig.z), name)
      now += castle.FULL_RESCAN_MS
      quiet(() => castle.menuFact(bot, ctx, now))
      assert.equal(ctx.castle.progress.done, dug, name)
    }
  })

  it('a keep-clear air cell does not move the gauge', () => {
    const { cells, w } = world()
    const air = cells.find((c) => c.kind === 'air')
    w.set(k(air.x, air.y, air.z), 'dirt')
    const bot = botOf(w)
    const ctx = { castle: { site: { ...SITE }, rot: 0, blueprintVersion: 2, phase: 'body', blocked: {} } }
    let now = 1e9
    quiet(() => castle.menuFact(bot, ctx, now))
    const before = { ...ctx.castle.progress }
    w.set(k(air.x, air.y, air.z), 'air')
    now += castle.FULL_RESCAN_MS
    const logs = quiet(() => castle.menuFact(bot, ctx, now))
    assert.deepEqual(ctx.castle.progress, before)
    assert.ok(!logs.some((m) => /^castle \d+\/\d+$/.test(m)), JSON.stringify(logs))
  })
})
