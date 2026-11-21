'use strict'

// Own/peer structure cells are never dug (castle holes and farm cells kept
// growing in prod 2026-11-21): the shared bot.dig guard, the peer castle in
// protectedReason, and acquire's Baritone mine never targeting built-only
// blocks (cobblestone walls, farmland).

const { describe, it } = require('node:test')
const assert = require('node:assert')
const { Vec3 } = require('vec3')
const castle = require('../src/castle')
const util = require('../src/behaviours/util')

const site = { x: 100, y: 64, z: 100 }
const state = { site, rot: 0, blueprintVersion: 2, phase: 'complete' }
const plan = castle.absPlan(site, 0, 2)
const [key, cell] = [...plan.at.entries()].find(([, c]) => c.kind === 'cobblestone' || castle.matches(c.kind, 'cobblestone'))
const [x, y, z] = key.split(',').map(Number)
const block = (name, p) => ({ name, position: new Vec3(p[0], p[1], p[2]), getProperties: () => ({}) })
const fakeBot = () => {
  const dug = []
  return { dug, dig: async (b) => { dug.push(b.name) }, entity: { position: new Vec3(0, 64, 0) }, blockAt: () => null }
}

describe('structure dig guard', () => {
  it('found a cobblestone castle cell', () => assert.ok(cell))

  it('refuses a laid own castle cell for any caller, logs protect skip', async () => {
    const bot = fakeBot()
    const ctx = { castle: state, step: 'gather' }
    util.installDigGuard(bot, ctx)
    const lines = []
    const log = console.log
    console.log = (l) => lines.push(l)
    try { await assert.rejects(bot.dig(block('cobblestone', [x, y, z])), /protected/) } finally { console.log = log }
    assert.deepStrictEqual(bot.dug, [])
    assert.match(lines.join('\n'), new RegExp(`protect skip ${x},${y},${z} cobblestone owner=castle by=gather/`))
  })

  it('refuses a peer castle cell, lets a wrong cell and outside blocks through', async () => {
    const bot = fakeBot()
    util.installDigGuard(bot, { knownCastles: [state], step: 'recover' })
    const log = console.log
    console.log = () => {}
    try { await assert.rejects(bot.dig(block('cobblestone', [x, y, z])), /protected/) } finally { console.log = log }
    await bot.dig(block('dirt', [x, y, z])) // a wrong occupant: the repair digs it
    await bot.dig(block('cobblestone', [0, 64, 0]))
    assert.deepStrictEqual(bot.dug, ['dirt', 'cobblestone'])
  })

  it('protectedReason refuses a peer castle cell', () => {
    assert.strictEqual(util.protectedReason(fakeBot(), block('cobblestone', [x, y, z]), { knownCastles: [state] }), 'protected')
  })

  it('refuses a laid farm cell (farmland)', async () => {
    const bot = fakeBot()
    const fb = { site: { x: 0, y: 64, z: 0 } }
    util.installDigGuard(bot, { farmBuild: fb, step: 'acquire' })
    const log = console.log
    console.log = () => {}
    try { await assert.rejects(bot.dig(block('farmland', [18, 63, 0])), /protected/) } finally { console.log = log }
    assert.deepStrictEqual(bot.dug, [])
  })

  it('built-only names never become mine targets', () => {
    for (const n of ['cobblestone', 'farmland', 'oak_planks', 'stone_bricks', 'oak_fence', 'dirt_path', 'stripped_oak_log']) assert.ok(util.BUILT_ONLY.test(n), n)
    for (const n of ['stone', 'dirt', 'grass_block', 'oak_log', 'coal_ore', 'sand', 'wheat']) assert.ok(!util.BUILT_ONLY.test(n), n)
  })
})
