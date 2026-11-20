'use strict'

const { it } = require('node:test')
const assert = require('node:assert/strict')
const Vec3 = require('vec3')
const danger = require('../src/danger')
const projects = require('../src/behaviours/fun-projects')
const light = require('../src/behaviours/light')

function flatBot(ctx) {
  return {
    entity: { position: new Vec3(0.5, 64, 0.5) },
    _tickerCtx: ctx,
    blockAt(p) { return { name: p.y < 64 ? 'grass_block' : 'air', position: p, boundingBox: p.y < 64 ? 'block' : 'empty' } },
  }
}
function dieAt(ctx, t, ...xz) {
  for (const [x, z] of xz) danger.noteDeath({ entity: { position: new Vec3(x, 64, z) } }, ctx, t)
}

it('three deaths in 40 blocks make a zone; each extra death doubles it', () => {
  const ctx = {}
  const t = Date.now()
  dieAt(ctx, t - 30 * 60000, [0, 0], [10, 5])
  assert.equal(danger.deathZone(ctx, { x: 0, z: 0 }, t), null)
  dieAt(ctx, t, [-20, 10])
  assert.equal(danger.deathZone(ctx, { x: 0, z: 0 }, t).deaths, 3)
  assert.equal(danger.deathZone(ctx, { x: 0, z: 0 }, t + 21 * 60000), null)
  assert.equal(danger.deathZone(ctx, { x: 200, z: 0 }, t), null)
  dieAt(ctx, t, [5, 5])
  assert.ok(danger.deathZone(ctx, { x: 0, z: 0 }, t + 39 * 60000))
})

it('a fun project site is picked outside a death zone', () => {
  const ctx = {}
  const bot = flatBot(ctx)
  const before = projects.gradedSite(bot, ctx, { w: 5, d: 5 })
  assert.ok(Math.hypot(before.x, before.z) < 20)
  dieAt(ctx, Date.now(), [0, 0], [4, 4], [-4, 2])
  const site = projects.gradedSite(bot, ctx, { w: 5, d: 5 })
  assert.ok(site)
  assert.ok(!danger.deathZone(ctx, { x: site.x + 2.5, z: site.z + 2.5 }), `site ${site.x},${site.z} in zone`)
})

it('own farm in a death zone queues lighting', () => {
  const ctx = { farmBuild: { site: { x: 0, y: 64, z: 0 } } }
  const bot = flatBot(ctx)
  assert.equal(light.zoneUnlit(bot, ctx), 0)
  dieAt(ctx, Date.now(), [10, 4], [12, 6], [8, 2])
  assert.ok(light.zoneUnlit(bot, ctx) > 5)
})
