'use strict'

// idkcraft-qwyl: chest-first for castlefetch wood legs with cross-bot
// reuse. Before a gather leg or a craft step for a stocked material
// (planks first), the leg withdraws from a remembered chest in radius —
// own sightings plus peer bots' memory files (read-only, the
// BOT_CASTLE_PEER precedent); gather/craft cover only what chests cannot.

const { describe, it, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const fetch = require('../src/behaviours/castlefetch')
const stockpile = require('../src/behaviours/stockpile')

const SITE = { x: 100, y: 64, z: 200 }

function makeBot({ items = [], at = { x: SITE.x - 4, y: 64, z: SITE.z - 4 } } = {}) {
  return {
    username: 'IdkBot',
    entity: { position: { ...at } },
    inventory: { items: () => items },
    spawnPoint: { x: 0, y: 64, z: 0 },
    registry: { blocksByName: { chest: { id: 54 } } },
    findBlocks: () => [], // no footprint chest on the site
  }
}

function castleState() {
  return { site: { ...SITE }, rot: 0, blueprintVersion: 1, phase: 'body', blocked: {}, parked: false }
}

// Temp memory dir with BOT_MEMORY_FILE pointed at BotA.json; restored after.
let prevEnv
let tmpDir
afterEach(() => {
  if (prevEnv === undefined) delete process.env.BOT_MEMORY_FILE
  else process.env.BOT_MEMORY_FILE = prevEnv
  if (tmpDir) { try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch (_) { /* best-effort */ } tmpDir = null }
})

function memoryDir(peerDocs) {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwyl-'))
  prevEnv = process.env.BOT_MEMORY_FILE
  process.env.BOT_MEMORY_FILE = path.join(tmpDir, 'BotA.json')
  const docs = { 'BotA.json': { v: 1 }, ...(peerDocs || {}) }
  for (const [name, doc] of Object.entries(docs)) {
    fs.writeFileSync(path.join(tmpDir, name), JSON.stringify(doc))
  }
  return tmpDir
}

function worldOf(bot) {
  return require('../src/memory').worldKey(bot)
}

describe('qwyl chest-first: remembered chests spare the gather/craft legs', () => {
  it('stocked planks: pickChest takes the remembered sighting in radius (no chop)', () => {
    const bot = makeBot()
    const chest = { x: SITE.x - 10, y: 64, z: SITE.z - 10 } // ~8 blocks away
    const ctx = { castle: castleState(), chests: [chest] }
    const f = {}
    const picked = fetch.pickChest(bot, ctx, f, 'planks')
    assert.ok(picked, 'a remembered chest in radius is picked')
    assert.equal(picked.bank, true, 'remembered chests draw like bank chests')
    assert.deepEqual([picked.at.x, picked.at.y, picked.at.z], [chest.x, chest.y, chest.z])
    assert.ok(f.chestTried.has(`${chest.x},${chest.y},${chest.z}`), 'tried stamped, never re-opened')
  })

  it('unstocked: no remembered chest in radius -> null, gather as today', () => {
    const bot = makeBot()
    const ctx = { castle: castleState(), chests: [{ x: SITE.x + 200, y: 64, z: SITE.z }] }
    assert.equal(fetch.pickChest(bot, ctx, {}, 'planks'), null, 'far sighting out of radius: no chest leg')
    assert.equal(fetch.pickChest(bot, { castle: castleState() }, {}, 'planks'), null, 'no sightings at all: no chest leg')
  })

  it('tried sightings stay skipped', () => {
    const bot = makeBot()
    const chest = { x: SITE.x - 10, y: 64, z: SITE.z - 10 }
    const ctx = { castle: castleState(), chests: [chest] }
    const f = { chestTried: new Set([`${chest.x},${chest.y},${chest.z}`]) }
    assert.equal(fetch.pickChest(bot, ctx, f, 'planks'), null, 'drained chest never re-walked in-leg')
  })

  it('cross-bot: a peer memory chest is picked, peer file untouched', () => {
    const bot = makeBot()
    const world = worldOf(bot)
    const peerChest = { x: SITE.x - 6, y: 64, z: SITE.z - 6 }
    memoryDir({ 'BotB.json': { v: 1, world, chests: [peerChest] } })
    const before = fs.readFileSync(path.join(tmpDir, 'BotB.json'), 'utf8')
    const ctx = { castle: castleState() }
    const picked = fetch.pickChest(bot, ctx, {}, 'planks')
    assert.ok(picked, 'peer chest picked without any own sighting')
    assert.deepEqual([picked.at.x, picked.at.y, picked.at.z], [peerChest.x, peerChest.y, peerChest.z])
    assert.deepEqual(ctx.peerChests, [peerChest], 'peer sightings cached on ctx')
    assert.equal(fs.readFileSync(path.join(tmpDir, 'BotB.json'), 'utf8'), before, 'peer file never written')
  })

  it('peer scan skips own, other-world and corrupt files; dedupes and caps', () => {
    const bot = makeBot()
    const world = worldOf(bot)
    const dup = { x: 10, y: 64, z: 10 }
    const many = []
    for (let i = 0; i < 40; i++) many.push({ x: 1000 + i, y: 64, z: 1000 })
    memoryDir({
      'BotB.json': { v: 1, world, chests: [dup, { x: 11, y: 64, z: 11 }] },
      'BotC.json': { v: 1, world, chests: [dup, ...many] },
      'BotD.json': { v: 1, world: 'spawn:9,9,9', chests: [{ x: 12, y: 64, z: 12 }] },
    })
    fs.writeFileSync(path.join(tmpDir, 'BotE.json'), '{ corrupt')
    const ctx = {}
    const peers = stockpile.refreshPeerChests(bot, ctx)
    assert.equal(peers.length, 32, 'CHESTS_MAX cap holds across peers')
    assert.deepEqual(peers[0], dup, 'first peer sighting kept once')
    assert.equal(peers.filter((c) => c.x === dup.x && c.z === dup.z).length, 1, 'cross-file dupe dropped')
    assert.ok(!peers.some((c) => c.x === 12), 'other-world file ignored')
  })

  it('nearbyChestsAll merges own + peer, nearest first, home excluded', () => {
    const bot = makeBot()
    const home = { x: SITE.x - 4, y: 64, z: SITE.z - 4 }
    const ctx = {
      home: { chest: home },
      chests: [{ x: SITE.x - 20, y: 64, z: SITE.z - 20 }, home],
      peerChests: [{ x: SITE.x - 6, y: 64, z: SITE.z - 6 }],
      peerChestsAt: Date.now(),
    }
    const all = stockpile.nearbyChestsAll(bot, ctx, [])
    assert.deepEqual(all.map((c) => c.x), [SITE.x - 6, SITE.x - 20], 'peer-first by distance, home excluded')
    const own = stockpile.nearbyChests(bot, ctx, [])
    assert.deepEqual(own.map((c) => c.x), [SITE.x - 20], 'bring path (own only) unchanged')
  })
})
