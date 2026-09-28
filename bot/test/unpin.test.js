'use strict'

// Hover-arrest watchdog (idkcraft-1cj): storm + zero-spread + eligible fires
// one cloned-packet away-step per known face; freedom needs sustained calm +
// displacement; unknown terrain never nudges. Rig shape pinned here: the
// -37.3,65.2,-212.6 pin (grass face east, floor 1.2 below) storms 10/s idle
// with 0.00 disp; a 1 cm -x nudge calms it, then it falls free.

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const unpin = require('../src/unpin')
const { createTicker } = require('../src/index')

function pos(x, y, z) {
  return { x, y, z }
}

const PIN_POS = { x: -37.3, y: 65.2, z: -212.6 }

// Spot-A terrain: open feet/head cells, grass face +x (east), grass floor
// 1.2 below in the feet column (the survivable landing the gate requires).
function spotABot() {
  return {
    entity: { position: pos(-37.3, 65.2, -212.6), onGround: false },
    health: 20,
    blockAt: (p) => {
      if (p.x === -37 && p.y === 65 && p.z === -213) return { name: 'grass_block', boundingBox: 'block' }
      if (p.x === -38 && p.y === 63 && p.z === -213) return { name: 'grass_block', boundingBox: 'block' }
      return { name: 'air', boundingBox: 'empty' }
    },
  }
}

function feedStorm(ctx, t0, n = 10, at = PIN_POS) {
  for (let i = 0; i < n; i++) unpin.noteTeleport(ctx, t0 + i * 100, { ...at })
}

function feedScatter(ctx, t0, n = 10) {
  for (let i = 0; i < n; i++) unpin.noteTeleport(ctx, t0 + i * 100, { x: -37.3 + i * 0.1, y: 64.4, z: -212.0 })
}

function armedCtx() {
  const ctx = {}
  const sent = []
  ctx.unpin = { teleports: [], lastMove: null, sendNudge: null, anchor: null, tries: [], stoodDown: null, wins: [] }
  unpin.noteMoveParams(ctx, 'position', { x: -37.3, y: 65.1216, z: -212.6, yaw: 0, pitch: 0, onGround: false, flags: { onGround: false } })
  ctx.unpin.sendNudge = (dx, dz, p) => { sent.push({ dx, dz, x: p.x, y: p.y, z: p.z }); return true }
  return { ctx, sent }
}

describe('unpin detection', () => {
  it('fires on the pin signature: storm + zero spread + eligible', () => {
    const bot = spotABot()
    const { ctx, sent } = armedCtx()
    feedStorm(ctx, 10000, 10)
    assert.equal(unpin.unpinTick(bot, ctx, 12000), 'nudged')
    assert.equal(sent.length, 1)
    assert.deepEqual([sent[0].dx, sent[0].dz], [-0.01, 0]) // away from the known face
  })

  it('stays quiet on calm traffic (2 teleports)', () => {
    const bot = spotABot()
    const { ctx, sent } = armedCtx()
    feedStorm(ctx, 10000, 2)
    const r = unpin.unpinTick(bot, ctx, 12000)
    assert.ok(r === 'idle' || r === 'watching')
    assert.equal(sent.length, 0)
  })

  it('stays quiet when targets scatter (laggy walk, not a pin)', () => {
    const bot = spotABot()
    const { ctx, sent } = armedCtx()
    feedScatter(ctx, 10000, 10)
    bot.entity.position = pos(-36.4, 64.4, -212.0)
    assert.equal(unpin.unpinTick(bot, ctx, 12000), 'watching')
    assert.equal(sent.length, 0)
  })

  it('stays quiet when targets are missing (no verdict)', () => {
    const bot = spotABot()
    const { ctx, sent } = armedCtx()
    for (let i = 0; i < 10; i++) unpin.noteTeleport(ctx, 10000 + i * 100)
    assert.equal(unpin.unpinTick(bot, ctx, 12000), 'watching')
    assert.equal(sent.length, 0)
  })

  it('proven rest vetoes (flag true)', () => {
    const bot = spotABot()
    bot.entity.onGround = true
    const { ctx, sent } = armedCtx()
    feedStorm(ctx, 10000, 20)
    assert.equal(unpin.unpinTick(bot, ctx, 12000), 'watching')
    assert.equal(sent.length, 0)
  })

  it('wet vetoes: isInWater storm stays a swim problem', () => {
    const bot = spotABot()
    bot.entity.isInWater = true
    const { ctx, sent } = armedCtx()
    feedStorm(ctx, 10000, 17)
    assert.equal(unpin.unpinTick(bot, ctx, 12000), 'watching')
    assert.equal(sent.length, 0)
  })

  it('wet vetoes: feet=water storm stays a swim problem', () => {
    const bot = spotABot()
    bot.blockAt = (p) => (p.y === 65 ? { name: 'water', boundingBox: 'empty' } : { name: 'air', boundingBox: 'empty' })
    const { ctx, sent } = armedCtx()
    feedStorm(ctx, 10000, 17)
    assert.equal(unpin.unpinTick(bot, ctx, 12000), 'watching')
    assert.equal(sent.length, 0)
  })

  it('lava vetoes: entity flag and feet block', () => {
    for (const wet of ['flag', 'feet']) {
      const bot = spotABot()
      if (wet === 'flag') bot.entity.isInLava = true
      else bot.blockAt = (p) => (p.y === 65 ? { name: 'lava', boundingBox: 'empty' } : { name: 'air', boundingBox: 'empty' })
      const { ctx, sent } = armedCtx()
      feedStorm(ctx, 10000, 10)
      assert.equal(unpin.unpinTick(bot, ctx, 12000), 'watching', wet)
      assert.equal(sent.length, 0, wet)
    }
  })

  it('mounted vetoes (vehicle rides own their validation)', () => {
    const bot = spotABot()
    bot.entity.vehicle = { id: 99 }
    const { ctx, sent } = armedCtx()
    feedStorm(ctx, 10000, 10)
    assert.equal(unpin.unpinTick(bot, ctx, 12000), 'watching')
    assert.equal(sent.length, 0)
  })

  it('every climbable at the feet vetoes; glow lichen does not', () => {
    const members = ['ladder', 'vine', 'scaffolding', 'twisting_vines', 'twisting_vines_plant',
      'weeping_vines', 'weeping_vines_plant', 'cave_vines', 'cave_vines_plant']
    for (const m of members) {
      const bot = spotABot()
      const base = bot.blockAt
      bot.blockAt = (p) => (p.x === -38 && p.y === 65 && p.z === -213 ? { name: m, boundingBox: 'empty' } : base(p))
      const { ctx, sent } = armedCtx()
      feedStorm(ctx, 10000, 10)
      assert.equal(unpin.unpinTick(bot, ctx, 12000), 'watching', m)
      assert.equal(sent.length, 0, m)
    }
    const bot = spotABot() // lichen is decor, not a climb: fires through it
    bot.blockAt = (p) => (p.x === -38 && p.y === 65 && p.z === -213
      ? { name: 'glow_lichen', boundingBox: 'empty' }
      : (p.x === -37 && p.y === 65 && p.z === -213
        ? { name: 'grass_block', boundingBox: 'block' }
        : (p.x === -38 && p.y === 63 && p.z === -213
          ? { name: 'grass_block', boundingBox: 'block' }
          : { name: 'air', boundingBox: 'empty' })))
    const { ctx, sent } = armedCtx()
    feedStorm(ctx, 10000, 10)
    assert.equal(unpin.unpinTick(bot, ctx, 12000), 'nudged')
    assert.equal(sent.length, 1)
  })

  it('no known face: unknown terrain never nudges', () => {
    const bot = spotABot() // open air all around, floor far below but present
    bot.blockAt = (p) => (p.y === 63 ? { name: 'grass_block', boundingBox: 'block' } : { name: 'air', boundingBox: 'empty' })
    const { ctx, sent } = armedCtx()
    feedStorm(ctx, 10000, 10)
    assert.equal(unpin.unpinTick(bot, ctx, 12000), 'watching')
    assert.equal(sent.length, 0)
  })

  it('landing feasibility: void/lava veto, water and survivable falls allow', () => {
    const face = (p) => (p.x === -37 && p.y === 65 && p.z === -213 ? { name: 'grass_block', boundingBox: 'block' } : null)
    const cases = [
      ['void below vetoes', (p) => face(p) || { name: 'air', boundingBox: 'empty' }, 20, 'watching', 0],
      ['lava below vetoes', (p) => face(p) || (p.y === 63 ? { name: 'lava', boundingBox: 'empty' } : { name: 'air', boundingBox: 'empty' }), 20, 'watching', 0],
      ['water below allows (splash)', (p) => face(p) || (p.y === 63 ? { name: 'water', boundingBox: 'empty' } : { name: 'air', boundingBox: 'empty' }), 20, 'nudged', 1],
    ]
    for (const [label, scan, hp, want, sends] of cases) {
      const bot = spotABot()
      bot.blockAt = scan
      bot.health = hp
      const { ctx, sent } = armedCtx()
      feedStorm(ctx, 10000, 10)
      assert.equal(unpin.unpinTick(bot, ctx, 12000), want, label)
      assert.equal(sent.length, sends, label)
    }
    // HP-aware lethal falls: 8-block fall kills at 5 hp, not at 20.
    for (const [hp, want] of [[5, 'watching'], [20, 'nudged']]) {
      const bot = { entity: { position: pos(0, 70, 0.5), onGround: false }, health: hp, blockAt: () => ({ name: 'air', boundingBox: 'empty' }) }
      bot.blockAt = (p) => {
        if (p.x === 0 && p.y === 70 && p.z === 0) return { name: 'stone', boundingBox: 'block', shapes: [[0.3, 0, 0, 1, 1, 1]] } // plane 0.3 = max-x: contact
        if ((p.x === -1 || p.x === 0) && p.y === 61 && p.z === 0) return { name: 'stone', boundingBox: 'block' } // top 62, dist 8, both footprint cols
        return { name: 'air', boundingBox: 'empty' }
      }
      const { ctx, sent } = armedCtx()
      feedStorm(ctx, 10000, 10, { x: 0, y: 70, z: 0.5 })
      assert.equal(unpin.unpinTick(bot, ctx, 12000), want, `hp${hp}`)
      assert.equal(sent.length, want === 'nudged' ? 1 : 0, `hp${hp}`)
    }
  })

  it('defers without sender or shape (no blind sends)', () => {
    const bot = spotABot()
    const ctx = {}
    feedStorm(ctx, 10000, 10)
    assert.equal(unpin.unpinTick(bot, ctx, 12000), 'watching')
  })

  it('lastMove guard alone blocks the send (mutant-grade)', () => {
    const bot = spotABot()
    const ctx = {}
    const sent = []
    ctx.unpin = { teleports: [], lastMove: null, sendNudge: (dx, dz) => { sent.push([dx, dz]); return true }, anchor: null, tries: [], stoodDown: null, wins: [] }
    feedStorm(ctx, 10000, 10)
    assert.equal(unpin.unpinTick(bot, ctx, 12000), 'watching')
    assert.equal(sent.length, 0)
  })

  it('missing sender neither throws nor sends (robustness, not a guard)', () => {
    // NOTE (equivalent mutant, retired): with lastMove present but no
    // sendNudge, deleting the detection-side sendNudge check is
    // unobservable — sendTry re-checks and returns 'watching' either way.
    const bot = spotABot()
    const { ctx } = armedCtx()
    ctx.unpin.sendNudge = null
    feedStorm(ctx, 10000, 10)
    assert.equal(unpin.unpinTick(bot, ctx, 12000), 'watching')
  })

  it('no position, no crash, no send', () => {
    const { ctx } = armedCtx()
    feedStorm(ctx, 10000, 10)
    assert.equal(unpin.unpinTick({}, ctx, 12000), 'idle')
    assert.equal(unpin.unpinTick({ entity: {} }, ctx, 12000), 'idle')
  })
})

describe('unpin verify + bounds', () => {
  it('freedom needs sustained calm + displacement (two ticks)', () => {
    const bot = spotABot()
    const { ctx, sent } = armedCtx()
    feedStorm(ctx, 10000, 10)
    assert.equal(unpin.unpinTick(bot, ctx, 12000), 'nudged')
    bot.entity.position = pos(-37.31, 64.7, -212.6) // fell 0.5, calm
    assert.equal(unpin.unpinTick(bot, ctx, 13000), 'verifying') // pending, NOT freed
    assert.equal(unpin.unpinTick(bot, ctx, 14000), 'freed') // held a second tick
    assert.equal(sent.length, 1)
  })

  it('calm without displacement drops (silence alone proves nothing)', () => {
    const bot = spotABot()
    const { ctx, sent } = armedCtx()
    feedStorm(ctx, 10000, 10)
    assert.equal(unpin.unpinTick(bot, ctx, 12000), 'nudged')
    assert.equal(unpin.unpinTick(bot, ctx, 13000), 'idle') // silent but still: not a lock
    assert.equal(sent.length, 1)
  })

  it('snapback drops (displacement must hold)', () => {
    const bot = spotABot()
    const { ctx, sent } = armedCtx()
    feedStorm(ctx, 10000, 10)
    assert.equal(unpin.unpinTick(bot, ctx, 12000), 'nudged')
    bot.entity.position = pos(-37.31, 64.7, -212.6)
    assert.equal(unpin.unpinTick(bot, ctx, 13000), 'verifying')
    bot.entity.position = pos(-37.3, 65.2, -212.6) // snapped back: reject won
    assert.equal(unpin.unpinTick(bot, ctx, 14000), 'idle')
    assert.equal(sent.length, 1)
  })

  it('still storming with no untried away stands down', () => {
    const bot = spotABot() // one face, one away
    const { ctx, sent } = armedCtx()
    feedStorm(ctx, 10000, 10)
    assert.equal(unpin.unpinTick(bot, ctx, 12000), 'nudged')
    feedStorm(ctx, 12200, 10)
    assert.equal(unpin.unpinTick(bot, ctx, 13000), 'stood-down')
    assert.equal(sent.length, 1)
    feedStorm(ctx, 13200, 10) // still pinned: rest holds, no more sends
    assert.equal(unpin.unpinTick(bot, ctx, 14000), 'watching')
    assert.equal(sent.length, 1)
  })

  it('re-arms 1+ blocks away from a failed anchor', () => {
    const bot = spotABot()
    const { ctx, sent } = armedCtx()
    feedStorm(ctx, 10000, 10)
    assert.equal(unpin.unpinTick(bot, ctx, 12000), 'nudged')
    feedStorm(ctx, 12200, 10)
    assert.equal(unpin.unpinTick(bot, ctx, 13000), 'stood-down')
    bot.entity.position = pos(-30, 65.2, -212.6) // owner /tp out
    feedStorm(ctx, 21500, 10, { x: -30, y: 65.2, z: -212.6 })
    assert.equal(unpin.unpinTick(bot, ctx, 22000), 'watching') // stale+fresh mix: no verdict
    feedStorm(ctx, 23000, 10, { x: -30, y: 65.2, z: -212.6 })
    bot.blockAt = (p) => { // fresh touching face + floor (both footprint cols) at the new spot
      if (p.x === -30 && p.y === 65 && p.z === -213) return { name: 'stone', boundingBox: 'block', shapes: [[0.3, 0, 0, 1, 1, 1]] } // plane -29.7 = max-x
      if ((p.x === -31 || p.x === -30) && p.y === 63 && p.z === -213) return { name: 'stone', boundingBox: 'block' }
      return { name: 'air', boundingBox: 'empty' }
    }
    assert.equal(unpin.unpinTick(bot, ctx, 24000), 'nudged')
    assert.equal(sent.length, 2)
  })

  it('re-scans the guide per try, never repeats a direction', () => {
    let flip = false
    const bot = spotABot()
    const baseScan = bot.blockAt
    bot.blockAt = (p) => {
      if (p.x === -38 && p.y === 63 && p.z === -213) return { name: 'grass_block', boundingBox: 'block' } // floor stays
      if (!flip) return baseScan(p)
      return (p.x === -38 && p.z === -213 && (p.y === 65 || p.y === 66))
        ? { name: 'stone', boundingBox: 'block', shapes: [[0, 0, 0.7, 1, 1, 1]] } // +z plane at max-z: contact now
        : { name: 'air', boundingBox: 'empty' }
    }
    const { ctx, sent } = armedCtx()
    feedStorm(ctx, 10000, 10)
    assert.equal(unpin.unpinTick(bot, ctx, 12000), 'nudged')
    assert.deepEqual([sent[0].dx, sent[0].dz], [-0.01, 0])
    flip = true
    feedStorm(ctx, 12200, 10)
    assert.equal(unpin.unpinTick(bot, ctx, 13000), 'nudged')
    assert.deepEqual([sent[1].dx, sent[1].dz], [0, -0.01]) // fresh guide, not a repeat
  })

  it('retry re-gates: wet/lava/mounted/climb mid-episode drops', () => {
    const cases = [
      ['wet', (b) => { b.entity.isInWater = true }],
      ['lava', (b) => { b.entity.isInLava = true }],
      ['mounted', (b) => { b.entity.vehicle = { id: 7 } }],
      ['climb', (b) => { const s = b.blockAt; b.blockAt = (p) => (p.y === 65 && p.x === -38 ? { name: 'ladder', boundingBox: 'block' } : s(p)) }],
    ]
    for (const [label, mutate] of cases) {
      const bot = spotABot()
      const { ctx, sent } = armedCtx()
      feedStorm(ctx, 10000, 10)
      assert.equal(unpin.unpinTick(bot, ctx, 12000), 'nudged', label)
      mutate(bot)
      feedStorm(ctx, 12200, 10)
      assert.equal(unpin.unpinTick(bot, ctx, 13000), 'idle', label) // dropped, no try 2
      assert.equal(sent.length, 1, label)
    }
  })

  it('flag flap mid-storm does not drop (no churn; revmux-01)', () => {
    const bot = spotABot()
    const { ctx, sent } = armedCtx()
    feedStorm(ctx, 10000, 10)
    assert.equal(unpin.unpinTick(bot, ctx, 12000), 'nudged')
    bot.entity.onGround = true // flap: a true read inside a live storm
    feedStorm(ctx, 12200, 10)
    assert.equal(unpin.unpinTick(bot, ctx, 13000), 'stood-down') // one away spent: rest, not drop
    assert.equal(sent.length, 1)
  })

  it('mid-episode escape drops the episode (displacement gate)', () => {
    const bot = spotABot()
    const { ctx, sent } = armedCtx()
    feedStorm(ctx, 10000, 10)
    assert.equal(unpin.unpinTick(bot, ctx, 12000), 'nudged')
    bot.entity.position = pos(-37.3, 64.6, -212.0) // 0.85 from the anchor
    // Face + floor at the escape cell (revmux-02): without the moved-drop,
    // the retry re-gate would pass and the tried-set would stand down —
    // the drop must win first, so this stays 'idle' with 1 send.
    bot.blockAt = (p) => {
      if (p.x === -37 && p.y === 64 && p.z === -212) return { name: 'stone', boundingBox: 'block' }
      if (p.x === -38 && p.y === 62 && p.z === -212) return { name: 'stone', boundingBox: 'block' }
      return { name: 'air', boundingBox: 'empty' }
    }
    feedStorm(ctx, 12200, 5)
    assert.equal(unpin.unpinTick(bot, ctx, 13000), 'idle')
    assert.equal(sent.length, 1)
  })

  it('re-pin at exact rest (floor adjacent, flag down) still fires', () => {
    const bot = spotABot()
    bot.entity.position = pos(-37.3, 64.0, -212.6)
    const { ctx, sent } = armedCtx()
    feedStorm(ctx, 10000, 20, { x: -37.3, y: 64.0, z: -212.6 })
    assert.equal(unpin.unpinTick(bot, ctx, 12000), 'nudged')
    assert.equal(sent.length, 1)
  })

  it('press-loop: 3 rapid re-wins rest, spaced re-pins cure', () => {
    const bot = spotABot()
    const { ctx, sent } = armedCtx()
    for (const t0 of [10000, 15000, 20000]) {
      bot.entity.position = pos(-37.3, 65.2, -212.6) // fresh pin each cycle
      feedStorm(ctx, t0, 10)
      assert.equal(unpin.unpinTick(bot, ctx, t0 + 2000), 'nudged')
      bot.entity.position = pos(-37.31, 64.7, -212.6) // freed fall
      assert.equal(unpin.unpinTick(bot, ctx, t0 + 3000), 'verifying')
      assert.equal(unpin.unpinTick(bot, ctx, t0 + 4000), 'freed')
    }
    bot.entity.position = pos(-37.3, 65.2, -212.6)
    feedStorm(ctx, 25000, 10)
    assert.equal(unpin.unpinTick(bot, ctx, 27000), 'stood-down')
    assert.equal(sent.length, 3)
    feedStorm(ctx, 90000, 10)
    assert.equal(unpin.unpinTick(bot, ctx, 92000), 'nudged')
    assert.equal(sent.length, 4)
  })

  it('verifying holds inside the 700 ms gap', () => {
    const bot = spotABot()
    const { ctx, sent } = armedCtx()
    feedStorm(ctx, 10000, 10)
    assert.equal(unpin.unpinTick(bot, ctx, 12000), 'nudged')
    assert.equal(unpin.unpinTick(bot, ctx, 12300), 'verifying')
    assert.equal(sent.length, 1)
  })
})

describe('unpin round-2 probes (F3/F4/F5)', () => {
  // Codex door probe: body x=0.4875 (min-x 0.1875) touches the east plane of
  // a door slab in its own cell; a full wall 0.2125 past max-x must not
  // generate a step back INTO the door.
  function doorBot() {
    return {
      entity: { position: pos(0.4875, 70, 0.5), onGround: false },
      health: 20,
      blockAt: (p) => {
        if (p.x === 0 && p.z === 0 && (p.y === 70 || p.y === 71)) {
          return { name: 'oak_door', boundingBox: 'block', shapes: [[0, 0, 0, 0.1875, 1, 1]] }
        }
        if (p.x === 1 && (p.y === 70 || p.y === 71)) return { name: 'stone', boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]] }
        if (p.x === 0 && p.y === 69 && p.z === 0) return { name: 'stone', boundingBox: 'block' }
        return { name: 'air', boundingBox: 'empty' }
      },
    }
  }

  it('door probe (F3): fires off the touching shape, never into it', () => {
    const bot = doorBot()
    const { ctx, sent } = armedCtx()
    feedStorm(ctx, 10000, 10, { x: 0.4875, y: 70, z: 0.5 })
    assert.equal(unpin.unpinTick(bot, ctx, 12000), 'nudged')
    assert.equal(sent.length, 1)
    assert.deepEqual([sent[0].dx, sent[0].dz], [0.01, 0]) // +x off the door; -x enters it
  })

  it('door guide (F3 unit): gap wall is not a face, door is', () => {
    assert.deepEqual(unpin.orderNudgeDirs(doorBot()), [[0.01, 0]])
  })

  it('slot veto (F3): touching both sides with no free step stays silent', () => {
    const bot = { // 0.6 body wedged between two slabs 0.6 apart: contact, no escape
      entity: { position: pos(0.5, 70, 0.5), onGround: false },
      health: 20,
      blockAt: (p) => {
        if (p.x === 0 && p.y === 70 && p.z === 0) return { name: 'stone', boundingBox: 'block', shapes: [[0, 0, 0, 0.2, 1, 1], [0.8, 0, 0, 1, 1, 1]] }
        if (p.x === 0 && p.y === 69 && p.z === 0) return { name: 'stone', boundingBox: 'block' }
        return { name: 'air', boundingBox: 'empty' }
      },
    }
    assert.deepEqual(unpin.orderNudgeDirs(bot), [])
    const { ctx, sent } = armedCtx()
    feedStorm(ctx, 10000, 10, { x: 0.5, y: 70, z: 0.5 })
    assert.equal(unpin.unpinTick(bot, ctx, 12000), 'watching')
    assert.equal(sent.length, 0)
  })

  it('burst capture (F4): six packets in one tick record six targets', () => {
    const handlers = {}
    const bot = {
      _client: { on(ev, fn) { (handlers[ev] = handlers[ev] || []).push(fn) }, write() {} },
      entity: { position: pos(0, 70, 0), onGround: false },
    }
    const ctx = {}
    unpin.installUnpinTap(bot, ctx)
    for (let i = 0; i < 6; i++) {
      bot.entity.position = pos(i, 70, 0) // physics applies each packet before the next
      for (const fn of handlers.position) fn({ x: i, y: 70, z: 0, flags: {} })
    }
    assert.equal(ctx.unpin.teleports.length, 6)
    assert.deepEqual(ctx.unpin.teleports.map((t) => t.pos.x), [0, 1, 2, 3, 4, 5])
  })

  it('position tap registers after spawn (F4: physics applies first)', () => {
    const handlers = {}
    let spawnFn = null
    const bot = {
      once(ev, fn) { if (ev === 'spawn') spawnFn = fn },
      _client: { on(ev, fn) { (handlers[ev] = handlers[ev] || []).push(fn) }, write() {} },
      entity: { position: pos(0, 70, 0), onGround: false },
    }
    const ctx = {}
    unpin.installUnpinTap(bot, ctx)
    assert.equal(handlers.position, undefined) // not before spawn: pre-apply reads
    assert.equal(typeof spawnFn, 'function')
    spawnFn()
    assert.equal((handlers.position || []).length, 1)
  })

  it('nudge rebases onto the last correction, not live prediction (F5)', () => {
    const bot = spotABot()
    bot.entity.position = pos(-37.3, 65.2, -212.55) // drifted 0.05 along the face
    const { ctx, sent } = armedCtx()
    feedStorm(ctx, 10000, 10) // corrections at PIN (-212.6)
    assert.equal(unpin.unpinTick(bot, ctx, 12000), 'nudged')
    assert.equal(sent.length, 1)
    assert.deepEqual([sent[0].dx, sent[0].dz], [-0.01, 0])
    assert.equal(sent[0].x, -37.3) // base passthrough (the real sender adds dx; see clone test)
    assert.equal(sent[0].z, -212.6) // server pos, not the drifted -212.55
  })

  it('no fresh correction mid-episode drops (F5: never send blind)', () => {
    const bot = spotABot()
    const base = bot.blockAt
    bot.blockAt = (p) => { // second touching face (+z plane at max-z), so try 2 exists to be denied
      if (p.x === -38 && p.z === -213 && (p.y === 65 || p.y === 66)) return { name: 'stone', boundingBox: 'block', shapes: [[0, 0, 0.7, 1, 1, 1]] }
      return base(p)
    }
    const { ctx, sent } = armedCtx()
    feedStorm(ctx, 10000, 10)
    assert.equal(unpin.unpinTick(bot, ctx, 12000), 'nudged')
    for (let i = 0; i < 10; i++) unpin.noteTeleport(ctx, 12200 + i * 100) // storm, no targets
    assert.equal(unpin.unpinTick(bot, ctx, 14000), 'idle') // old evidence pruned: drop
    assert.equal(sent.length, 1)
  })

  it('footprint below (F3): lava beside the landing vetoes', () => {
    const bot = {
      entity: { position: pos(1.0, 70, 0.5), onGround: false }, // straddles cols 0-1
      health: 20,
      blockAt: (p) => {
        if (p.x === 1 && p.y === 70 && p.z === 0) return { name: 'stone', boundingBox: 'block', shapes: [[0.3, 0, 0, 1, 1, 1]] } // plane 1.3 = max-x: contact
        if (p.x === 2 && p.y === 70) return { name: 'stone', boundingBox: 'block' } // adjacency only
        if (p.x === 0 && p.y === 65 && p.z === 0) return { name: 'lava', boundingBox: 'empty' } // off-centre, in the fall path
        if (p.x === 1 && p.y === 60 && p.z === 0) return { name: 'stone', boundingBox: 'block' } // centre landing
        return { name: 'air', boundingBox: 'empty' }
      },
    }
    const { ctx, sent } = armedCtx()
    feedStorm(ctx, 10000, 10, { x: 1.0, y: 70, z: 0.5 })
    assert.equal(unpin.unpinTick(bot, ctx, 12000), 'watching')
    assert.equal(sent.length, 0)
  })

  it('footprint below (R3 major): same-level water must not blind a lethal landing', () => {
    const bot = {
      entity: { position: pos(1.0, 70, 0.5), onGround: false }, // straddles cols 0-1
      health: 1,
      blockAt: (p) => {
        if (p.x === 1 && p.y === 70 && p.z === 0) return { name: 'stone', boundingBox: 'block', shapes: [[0.3, 0, 0, 1, 1, 1]] } // contact
        if (p.x === 0 && p.y === 65 && p.z === 0) return { name: 'water', boundingBox: 'empty' } // same level, earlier column
        if (p.x === 1 && p.y === 65 && p.z === 0) return { name: 'stone', boundingBox: 'block' } // top 66: fall 4, dmg 1
        return { name: 'air', boundingBox: 'empty' }
      },
    }
    const { ctx, sent } = armedCtx()
    feedStorm(ctx, 10000, 10, { x: 1.0, y: 70, z: 0.5 })
    assert.equal(unpin.unpinTick(bot, ctx, 12000), 'watching') // lethal solid decides, not the water
    assert.equal(sent.length, 0)
  })

  it('footprint below (R3 major): same-level water must not blind lava', () => {
    const bot = {
      entity: { position: pos(1.0, 70, 0.5), onGround: false },
      health: 20,
      blockAt: (p) => {
        if (p.x === 1 && p.y === 70 && p.z === 0) return { name: 'stone', boundingBox: 'block', shapes: [[0.3, 0, 0, 1, 1, 1]] } // contact
        if (p.x === 0 && p.y === 65 && p.z === 0) return { name: 'water', boundingBox: 'empty' } // earlier column
        if (p.x === 1 && p.y === 65 && p.z === 0) return { name: 'lava', boundingBox: 'empty' } // later column: veto
        return { name: 'air', boundingBox: 'empty' }
      },
    }
    const { ctx, sent } = armedCtx()
    feedStorm(ctx, 10000, 10, { x: 1.0, y: 70, z: 0.5 })
    assert.equal(unpin.unpinTick(bot, ctx, 12000), 'watching')
    assert.equal(sent.length, 0)
  })

  it('geometry runs at the correction (R3 minor): live off-face still fires', () => {
    const bot = spotABot()
    bot.entity.position = pos(-37.25, 65.2, -212.6) // live 0.05 off the face: no live contact
    const { ctx, sent } = armedCtx()
    feedStorm(ctx, 10000, 10) // base at PIN: touching
    assert.equal(unpin.unpinTick(bot, ctx, 12000), 'nudged')
    assert.equal(sent.length, 1)
    assert.deepEqual([sent[0].dx, sent[0].dz], [-0.01, 0])
  })

  it('fall measured from the server (R3 minor): live-allow + base-lethal vetoes', () => {
    const bot = {
      entity: { position: pos(0.5, 66.55, 0.5), onGround: false }, // live 0.05 under base
      health: 1,
      blockAt: (p) => {
        if (p.x === 0 && p.y === 66 && p.z === 0) return { name: 'stone', boundingBox: 'block', shapes: [[0.8, 0, 0, 1, 1, 1]] } // contact
        if (p.x === 0 && p.y === 62 && p.z === 0) return { name: 'stone_slab', boundingBox: 'block', shapes: [[0, 0, 0, 1, 0.6, 1]] } // top 62.6
        return { name: 'air', boundingBox: 'empty' }
      },
    }
    const { ctx, sent } = armedCtx()
    feedStorm(ctx, 10000, 10, { x: 0.5, y: 66.65, z: 0.5 }) // base fall 4.05: dmg 1 >= hp 1
    assert.equal(unpin.unpinTick(bot, ctx, 12000), 'watching') // live fall 3.95 would allow
    assert.equal(sent.length, 0)
  })

  it('below (R4 major): water cauldron is not a landing (exact water match)', () => {
    const bot = {
      entity: { position: pos(0.5, 70, 0.5), onGround: false },
      health: 20,
      blockAt: (p) => {
        if (p.x === 0 && p.y === 70 && p.z === 0) return { name: 'stone', boundingBox: 'block', shapes: [[0.8, 0, 0, 1, 1, 1]] } // contact
        if (p.x === 0 && p.y === 69 && p.z === 0) return { name: 'water_cauldron', boundingBox: 'block', shapes: [] } // no fall break
        return { name: 'air', boundingBox: 'empty' } // void below the cauldron
      },
    }
    const { ctx, sent } = armedCtx()
    feedStorm(ctx, 10000, 10, { x: 0.5, y: 70, z: 0.5 })
    assert.equal(unpin.unpinTick(bot, ctx, 12000), 'watching')
    assert.equal(sent.length, 0)
  })

  it('below (R5 minor): lava cauldron vetoes like lava (any lava content)', () => {
    const bot = {
      entity: { position: pos(0.5, 70, 0.5), onGround: false },
      health: 20,
      blockAt: (p) => {
        if (p.x === 0 && p.y === 70 && p.z === 0) return { name: 'stone', boundingBox: 'block', shapes: [[0.8, 0, 0, 1, 1, 1]] } // contact
        if (p.x === 0 && p.y === 69 && p.z === 0) return { name: 'lava_cauldron', boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]] } // rim walls read as a landing
        return { name: 'air', boundingBox: 'empty' }
      },
    }
    const { ctx, sent } = armedCtx()
    feedStorm(ctx, 10000, 10, { x: 0.5, y: 70, z: 0.5 })
    assert.equal(unpin.unpinTick(bot, ctx, 12000), 'watching')
    assert.equal(sent.length, 0)
  })

  it('lava feet (R5 minor): lava cauldron at the feet vetoes', () => {
    const bot = spotABot()
    const base = bot.blockAt
    bot.blockAt = (p) => (p.x === -38 && p.y === 65 && p.z === -213
      ? { name: 'lava_cauldron', boundingBox: 'block', shapes: [] } // empty walls: only the name decides
      : base(p))
    const { ctx, sent } = armedCtx()
    feedStorm(ctx, 10000, 10)
    assert.equal(unpin.unpinTick(bot, ctx, 12000), 'watching')
    assert.equal(sent.length, 0)
  })

  it('below (R6 major): landing needs horizontal overlap (trapdoor over void)', () => {
    const bot = {
      entity: { position: pos(0.4875, 70, 0.5), onGround: false },
      health: 20,
      blockAt: (p) => {
        if (p.x === 0 && p.y === 70 && p.z === 0) return { name: 'oak_door', boundingBox: 'block', shapes: [[0, 0, 0, 0.1875, 1, 1]] } // west contact
        if (p.x === 0 && p.y === 64 && p.z === 0) return { name: 'oak_trapdoor', boundingBox: 'block', shapes: [[0, 0, 0, 0.1875, 1, 1]] } // top 65, x clear of the body
        return { name: 'air', boundingBox: 'empty' } // void below the trapdoor
      },
    }
    const { ctx, sent } = armedCtx()
    feedStorm(ctx, 10000, 10, { x: 0.4875, y: 70, z: 0.5 })
    assert.equal(unpin.unpinTick(bot, ctx, 12000), 'watching')
    assert.equal(sent.length, 0)
  })

  it('below (R6 major): landing checked at the destination (column crossing)', () => {
    const bot = { // base footprint col 0 (safe stone); the +x step crosses into col 1 (lava)
      entity: { position: pos(0.7, 70, 0.5), onGround: false },
      health: 20,
      blockAt: (p) => {
        if (p.x === 0 && p.y === 70 && p.z === 0) return { name: 'stone', boundingBox: 'block', shapes: [[0, 0, 0, 0.4, 1, 1]] } // west contact -> +x
        if (p.x === 0 && p.y === 65 && p.z === 0) return { name: 'stone', boundingBox: 'block' } // base landing: fall 4, ok
        if (p.x === 1 && p.y === 65 && p.z === 0) return { name: 'lava', boundingBox: 'empty' } // dest column: veto
        return { name: 'air', boundingBox: 'empty' }
      },
    }
    const { ctx, sent } = armedCtx()
    feedStorm(ctx, 10000, 10, { x: 0.7, y: 70, z: 0.5 })
    assert.equal(unpin.unpinTick(bot, ctx, 12000), 'stood-down') // geometry passes, no survivable step
    assert.equal(sent.length, 0)
  })

  it('footprint below (F3): slab top sets the fall, not the cell top', () => {
    const bot = {
      entity: { position: pos(0.5, 66.6, 0.5), onGround: false },
      health: 1,
      blockAt: (p) => {
        if (p.x === 0 && p.y === 66 && p.z === 0) return { name: 'stone', boundingBox: 'block', shapes: [[0.8, 0, 0, 1, 1, 1]] } // plane 0.8 = max-x: contact
        if (p.x === 1 && p.y === 66) return { name: 'stone', boundingBox: 'block' } // adjacency only
        if (p.x === 0 && p.y === 62 && p.z === 0) return { name: 'stone_slab', boundingBox: 'block', shapes: [[0, 0, 0, 1, 0.5, 1]] } // top 62.5: fall 4.1, dmg 1
        return { name: 'air', boundingBox: 'empty' }
      },
    }
    const { ctx, sent } = armedCtx()
    feedStorm(ctx, 10000, 10, { x: 0.5, y: 66.6, z: 0.5 })
    assert.equal(unpin.unpinTick(bot, ctx, 12000), 'watching') // dmg 1 >= hp 1: lethal
    assert.equal(sent.length, 0)
  })
})

describe('unpin direction guide', () => {
  it('spot A: grass east -> the single away-step -x', () => {
    assert.deepEqual(unpin.orderNudgeDirs(spotABot()), [[-0.01, 0]])
  })

  it('open air: no faces, no steps (unknown never nudges)', () => {
    const bot = { entity: { position: pos(0, 70, 0), onGround: false }, blockAt: () => ({ name: 'air', boundingBox: 'empty' }) }
    assert.deepEqual(unpin.orderNudgeDirs(bot), [])
  })

  it('pocket corner: one away per touching side, axis order', () => {
    const bot = { // max-x/max-z exactly 1.0: true contact with both walls
      entity: { position: pos(0.7, 70, 0.7), onGround: false },
      blockAt: (p) => ((p.x === 1 && p.z === 0) || (p.x === 0 && p.z === 1)) && (p.y === 70 || p.y === 71)
        ? { name: 'stone', boundingBox: 'block' }
        : { name: 'air', boundingBox: 'empty' },
    }
    assert.deepEqual(unpin.orderNudgeDirs(bot), [[-0.01, 0], [0, -0.01]])
  })

  it('near but not touching: gap walls are not faces', () => {
    const bot = { // max-x 0.5, half a block off the wall: adjacency without contact
      entity: { position: pos(0.2, 70, 0.2), onGround: false },
      blockAt: (p) => (p.x === 1 && p.z === 0 && (p.y === 70 || p.y === 71))
        ? { name: 'stone', boundingBox: 'block' }
        : { name: 'air', boundingBox: 'empty' },
    }
    assert.deepEqual(unpin.orderNudgeDirs(bot), [])
  })

  it('ladder and scaffold neighbours are not faces (passable sides)', () => {
    for (const name of ['ladder', 'scaffolding']) {
      const bot = {
        entity: { position: pos(0.2, 70, 0.2), onGround: false },
        blockAt: (p) => (p.x === 1 && p.z === 0 && p.y === 70 ? { name, boundingBox: 'block' } : { name: 'air', boundingBox: 'empty' }),
      }
      assert.deepEqual(unpin.orderNudgeDirs(bot), [], name)
    }
  })

  it('cactus neighbour is a face (solid inset sides can lock)', () => {
    const bot = { // max-x exactly 1.0: touching the cactus cell
      entity: { position: pos(0.7, 70, 0.2), onGround: false },
      blockAt: (p) => (p.x === 1 && p.z === 0 && p.y === 70 ? { name: 'cactus', boundingBox: 'block' } : { name: 'air', boundingBox: 'empty' }),
    }
    assert.deepEqual(unpin.orderNudgeDirs(bot), [[-0.01, 0]])
  })

  it('no blockAt (blind mock): no steps, no throw', () => {
    assert.deepEqual(unpin.orderNudgeDirs({ entity: { position: pos(0, 70, 0) } }), [])
  })
})

describe('unpin packet clone', () => {
  it('sendNudge clones mineflayer shape, rebases coords to live pos', () => {
    const writes = []
    const bot = {
      _client: { write(name, params) { writes.push({ name, params }) } },
      on() {},
      entity: { position: pos(-37.3, 65.2, -212.6), onGround: false },
    }
    const ctx = {}
    unpin.installUnpinTap(bot, ctx)
    bot._client.write('position', { x: -37.3, y: 65.1216, z: -212.6, yaw: 1, pitch: 2, onGround: false, time: 99, flags: { onGround: false } })
    const st = ctx.unpin
    assert.ok(st && st.lastMove)
    assert.equal(typeof st.sendNudge, 'function')
    writes.length = 0
    assert.equal(st.sendNudge(-0.01, 0, { x: -37.3, y: 65.2, z: -212.6 }), true)
    assert.equal(writes.length, 1)
    const w = writes[0]
    assert.equal(w.name, 'position')
    assert.ok(Math.abs(w.params.x - -37.31) < 1e-9)
    assert.equal(w.params.y, 65.2)
    assert.equal(w.params.z, -212.6)
    assert.equal(w.params.yaw, 1)
    assert.equal(w.params.onGround, false)
    assert.deepEqual(w.params.flags, { onGround: false })
  })

  it('teleport targets resolve absolute (relative packets ignored)', () => {
    const handlers = {}
    const bot = { // physics applied the packet first (post-spawn registration)
      _client: { on(ev, fn) { (handlers[ev] = handlers[ev] || []).push(fn) }, write() {} },
      entity: { position: pos(-37.3, 65.2, -212.6), onGround: false },
    }
    const ctx = {}
    unpin.installUnpinTap(bot, ctx)
    for (const fn of handlers.position) fn({ x: 0.01, y: -0.08, z: 0, flags: { x: true, y: true, z: true } })
    assert.equal(ctx.unpin.teleports.length, 1)
    assert.deepEqual(ctx.unpin.teleports[0].pos, { x: -37.3, y: 65.2, z: -212.6 })
  })

  it('install is idempotent and mock-safe (no _client, no .on)', () => {
    const ctx = {}
    assert.doesNotThrow(() => unpin.installUnpinTap({}, ctx))
    assert.doesNotThrow(() => unpin.installUnpinTap({ on() {} }, ctx))
    const bot = { on() {}, _client: { write() {} } }
    unpin.installUnpinTap(bot, ctx)
    const w = bot._client.write
    unpin.installUnpinTap(bot, ctx)
    assert.equal(bot._client.write, w)
  })
})

describe('unpin ticker hook', () => {
  it('runTick calls unpinTick (wiring proof, not a tautology)', async () => {
    const bot = {
      username: 'IdkBot',
      players: {},
      entities: {},
      health: 20,
      food: 20,
      entity: { position: pos(0, 64, 0), onGround: true, effects: [] },
      spawnPoint: pos(0, 64, 0),
      registry: { blocksByName: {}, itemsByName: {} },
      inventory: { items: () => [] },
      pathfinder: { goal: null, setGoal() {}, stop() {}, isMoving: () => false, setMovements() {} },
      setControlState() {},
      clearControlStates() {},
      quit() {},
      chat() {},
      blockAt: () => null,
      blockAtCursor: () => null,
    }
    const brain = { async decide() { return { action: 'idle', sprint: false, source: 'stub' } } }
    const ticker = createTicker({ bot, brain, tickMs: 10, idleTickMs: 10, leaveAfterMs: 0 })
    const orig = unpin.unpinTick
    let calls = 0
    let sawCtx = false
    unpin.unpinTick = (...a) => { calls++; sawCtx = !!a[1] && a[1] === bot._tickerCtx; return orig(...a) }
    try {
      await ticker.tick()
    } finally {
      unpin.unpinTick = orig
    }
    assert.equal(calls, 1)
    assert.equal(sawCtx, true)
  })

  it('a calm tick runs the hook without firing or breaking the brain', async () => {
    const bot = {
      username: 'IdkBot',
      players: {},
      entities: {},
      health: 20,
      food: 20,
      entity: { position: pos(0, 64, 0), onGround: true, effects: [] },
      spawnPoint: pos(0, 64, 0),
      registry: { blocksByName: {}, itemsByName: {} },
      inventory: { items: () => [] },
      pathfinder: { goal: null, setGoal() {}, stop() {}, isMoving: () => false, setMovements() {} },
      setControlState() {},
      clearControlStates() {},
      quit() {},
      chat() {},
      blockAt: () => null,
      blockAtCursor: () => null,
    }
    const brain = { async decide() { return { action: 'idle', sprint: false, source: 'stub' } } }
    const ticker = createTicker({ bot, brain, tickMs: 10, idleTickMs: 10, leaveAfterMs: 0 })
    const r = await ticker.tick()
    assert.ok(r && r.decision)
    assert.equal(r.decision.action, 'idle')
  })
})
