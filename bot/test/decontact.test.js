'use strict'

// Face epsilon (idkcraft-ik7): outgoing move packets shift a hair off
// contacted side faces; everything else passes bit-identical. Rig shape
// pinned here: wallA (-58.7,59,-209.2, -x face on -59.0), wallB
// (-51.5,60,-213.7, -z face on -214.0), shaft (-58.5,59,-208.3, +z face on
// -208.0), aspot (-37.3,65.2,-212.6 hover, +x face), shore
// (-51.3,61.4,-196.5, +x face). Baselines storm 10-20/s with disp 0.00;
// with the wrapper all five free with fm=0.

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const dc = require('../src/decontact')

const AIR = { name: 'air', boundingBox: 'empty', shapes: [] }
function cube(name = 'stone') {
  return { name, boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]] }
}

// World: a -x wall (cell x=10, face x=11.0), open elsewhere. Body at
// x=11.3 touches it with x0=11.0 bit-exact — the prismarine-physics clamp
// residue shape.
function wallXBot() {
  return {
    version: '26.1',
    blockAt: (p) => {
      if (p.x === 10 && (p.y === 59 || p.y === 60) && p.z === -209) return cube()
      return AIR
    },
  }
}

describe('decontact shifts', () => {
  it('lifts an exact -x touch out to EPS', () => {
    const bot = wallXBot()
    const r = dc.decontact(bot, 11.3, 59, -208.5) // x0 = 11.0 exact
    assert.equal(r.x, 11.3 + dc.EPS)
    assert.equal(r.z, -208.5)
  })

  it('lifts an exact +x touch (aspot/shore shape)', () => {
    const bot = {
      version: '26.1',
      blockAt: (p) => (p.x === -37 && p.y === 65 && p.z === -213 ? cube('grass_block') : AIR),
    }
    const r = dc.decontact(bot, -37.3, 65.2, -212.6) // x1 = -37.0 exact
    assert.equal(r.x, -37.3 - dc.EPS)
    assert.equal(r.z, -212.6)
  })

  it('passes a clear packet bit-identical', () => {
    const bot = wallXBot()
    const r = dc.decontact(bot, 10.0, 59, -208.5) // x0 = 9.7, gap 1.3
    assert.equal(r.x, 10.0)
    assert.equal(r.z, -208.5)
  })

  it('leaves a 1 mm clearance alone (above EPS)', () => {
    const bot = wallXBot()
    const r = dc.decontact(bot, 11.3 + 0.001, 59, -208.5)
    assert.equal(r.x, 11.3 + 0.001)
  })

  it('lifts dust-scale overlap (negative, within DUST)', () => {
    const bot = wallXBot()
    const r = dc.decontact(bot, 11.3 - 5e-4, 59, -208.5) // x0 0.5 mm inside
    assert.ok(Math.abs(r.x - (11.3 + dc.EPS)) < 1e-12) // out to EPS past the face
  })

  it('leaves a real overlap alone (deeper than DUST)', () => {
    const bot = wallXBot()
    const r = dc.decontact(bot, 11.3 - 0.05, 59, -208.5) // 5 cm inside solid
    assert.equal(r.x, 11.3 - 0.05)
  })

  it('shifts both axes at a corner touch', () => {
    const bot = {
      version: '26.1',
      blockAt: (p) => {
        if (p.x === 10 && p.y === 59 && p.z === -209) return cube() // -x wall (face 11.0)
        if (p.x === 11 && p.y === 59 && p.z === -208) return cube() // +z wall (face -208.0)
        return AIR
      },
    }
    const r = dc.decontact(bot, 11.3, 59, -208.3) // x0=11.0, z1=-208.0
    assert.equal(r.x, 11.3 + dc.EPS)
    assert.equal(r.z, -208.3 - dc.EPS)
  })

  it('pinch (both opposite faces) nets to ~zero: documented limit', () => {
    const bot = {
      version: '26.1',
      blockAt: (p) => {
        if (p.x === 10 && p.y === 59 && p.z === -209) return cube() // -x wall, gap 0
        if (p.x === 11 && p.y === 59 && p.z === -209) {
          return { name: 'stone', boundingBox: 'block', shapes: [[0.6, 0, 0, 1, 1, 1]] } // +x slab, gap 0
        }
        return AIR
      },
    }
    // x0 = 11.0 and x1 = 11.6 both touch: +EPS and -EPS cancel
    const r = dc.decontact(bot, 11.3, 59, -208.5)
    assert.ok(Math.abs(r.x - 11.3) < 1e-12) // cannot clear both; stays for unpin/recover
  })

  it('ignores a tangentially-missing wall (no side overlap)', () => {
    const bot = {
      version: '26.1',
      blockAt: (p) => (p.x === 10 && p.y === 59 && p.z === -207 ? cube() : AIR), // 2 cells south
    }
    const r = dc.decontact(bot, 11.3, 59, -208.5)
    assert.equal(r.x, 11.3)
    assert.equal(r.z, -208.5)
  })

  it('a behind-plane shape cannot mask a facing touch', () => {
    const bot = {
      version: '26.1',
      blockAt: (p) => {
        if (p.x === 10 && (p.y === 59 || p.y === 60) && p.z === -209) return cube() // facing, gap 0
        if (p.x === 12 && p.y === 59 && p.z === -209) return cube() // behind the +x face
        return AIR
      },
    }
    const r = dc.decontact(bot, 11.3, 59, -208.5)
    assert.equal(r.x, 11.3 + dc.EPS) // the -x touch still lifts
    assert.equal(r.z, -208.5)
  })

  it('a deep overlap cannot mask a neighbouring dust touch', () => {
    const bot = {
      version: '26.1',
      blockAt: (p) => {
        if (p.x === 10 && p.y === 59 && p.z === -209) return cube() // facing wall, gap 0
        if (p.x === 10 && p.y === 60 && p.z === -209) {
          return { name: 'stone', boundingBox: 'block', shapes: [[0.2, 0, 0, 1.5, 1, 1]] } // deep overlap, same side
        }
        return AIR
      },
    }
    const r = dc.decontact(bot, 11.3, 59, -208.5)
    assert.equal(r.x, 11.3 + dc.EPS)
  })

  it('unknown cells (null/throw) send as-is', () => {
    const nullBot = { version: '26.1', blockAt: () => null }
    const r1 = dc.decontact(nullBot, 11.3, 59, -208.5)
    assert.deepEqual([r1.x, r1.z], [11.3, -208.5])
    const throwBot = { version: '26.1', blockAt: () => { throw new Error('hole') } }
    const r2 = dc.decontact(throwBot, 11.3, 59, -208.5)
    assert.deepEqual([r2.x, r2.z], [11.3, -208.5])
  })

  it('water and lava are not faces', () => {
    for (const name of ['water', 'lava']) {
      const bot = { version: '26.1', blockAt: () => ({ name, boundingBox: 'empty' }) }
      const r = dc.decontact(bot, 11.3, 59, -208.5)
      assert.deepEqual([r.x, r.z], [11.3, -208.5])
    }
  })

  it('shapeless solid fakes fall back to a full cube', () => {
    const bot = {
      version: '26.1',
      blockAt: (p) => (p.x === 10 && p.y === 59 && p.z === -209 ? { name: 'stone', boundingBox: 'block' } : AIR),
    }
    const r = dc.decontact(bot, 11.3, 59, -208.5)
    assert.equal(r.x, 11.3 + dc.EPS)
  })

  it('thin shapes (door slab in a straddled body cell) count', () => {
    const bot = {
      version: '26.1',
      blockAt: (p) => {
        if (p.x === 10 && p.y === 59 && p.z === -209) {
          return { name: 'oak_door', boundingBox: 'block', shapes: [[0.3, 0, 0.4, 0.6, 1, 0.6]] }
        }
        return AIR
      },
    }
    // x0 = 10.6 touches the slab maxX plane 10.6 (slab lives in body cell 10)
    const r = dc.decontact(bot, 10.9, 59, -208.5)
    assert.equal(r.x, 10.9 + dc.EPS)
  })
})

describe('enabledFor gate', () => {
  it('enables on 26.x, disables elsewhere, fails open when unknown', () => {
    assert.equal(dc.enabledFor({ version: '26.1' }), true)
    assert.equal(dc.enabledFor({ version: '26.1.2' }), true)
    assert.equal(dc.enabledFor({ version: '25.4' }), false)
    assert.equal(dc.enabledFor({ version: '' }), true)
    assert.equal(dc.enabledFor({}), true)
    assert.equal(dc.enabledFor(null), true)
  })
})

describe('installFaceEpsilon tap', () => {
  function tapBot() {
    const sent = []
    return {
      sent,
      bot: {
        version: '26.1',
        blockAt: (p) => (p.x === 10 && p.y === 59 && p.z === -209 ? cube() : AIR),
        _client: { write: (name, params) => { sent.push({ name, params }) } },
      },
    }
  }

  it('shifts position claims, preserves y and other packets', () => {
    const { bot, sent } = tapBot()
    assert.equal(dc.installFaceEpsilon(bot), true)
    bot._client.write('position', { x: 11.3, y: 59.5, z: -208.5, onGround: true })
    assert.equal(sent.length, 1)
    assert.equal(sent[0].params.x, 11.3 + dc.EPS)
    assert.equal(sent[0].params.y, 59.5) // y never touched
    assert.equal(sent[0].params.onGround, true)
    assert.equal(bot._faceEpsShifts, 1)
    bot._client.write('position', { x: 10.0, y: 59.5, z: -208.5, onGround: true })
    assert.equal(sent[1].params.x, 10.0) // clear: identical
    assert.equal(bot._faceEpsShifts, 1)
    bot._client.write('look', { yaw: 1, pitch: 2, onGround: true })
    assert.equal(sent[2].name, 'look') // untouched packet types pass through
  })

  it('is idempotent and gated by version', () => {
    const { bot, sent } = tapBot()
    assert.equal(dc.installFaceEpsilon(bot), true)
    assert.equal(dc.installFaceEpsilon(bot), false) // second install refuses
    bot.version = '25.4'
    bot._client.write('position', { x: 11.3, y: 59.5, z: -208.5, onGround: true })
    assert.equal(sent[0].params.x, 11.3) // gate closed: as-is
    assert.equal(bot._faceEpsShifts || 0, 0)
  })
})
