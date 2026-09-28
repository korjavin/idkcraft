'use strict'

// Neighbouring-overhang head scan (idkcraft-oz8): the 0.6-wide body drifts
// during the pillar jump-hold, and a lip beside the own column bonks the
// rise (+0.6 stall -> failed:no-apex over 20 ticks) while the own column
// reads free. Rig 2026-09-28, CLUSTER pocket stance (-58.7,54.5,-209.5):
// own y55/y56 free, west x-60 y56 stone with y54/y55 air below, stance
// frac-x 0.30 (west edge exactly on the cell boundary) -> pillar_up chosen
// with head=free, then failed:no-apex with zero rise. The shared scan now
// sees a neighbour lip the drifting body can reach: enterable at feet
// (dy+0 not solid - a full-height wall never lets the body in, chimney
// climbs unaffected) with rock at head height (dy+1/dy+2 solid) inside the
// body's XZ AABB plus a drift margin. dig_up keeps the own-column gate
// (9sq F1: it digs the own head, free own headroom means nothing to dig).

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { Vec3 } = require('vec3')
const recover = require('../src/behaviours/recover')

function pos(x, y, z) {
  return {
    x, y, z,
    distanceTo: (q) => Math.hypot(x - q.x, y - q.y, z - q.z),
    clone() { return pos(x, y, z) },
  }
}

function key(x, y, z) { return `${x},${y},${z}` }

// The bead's pocket, shifted to small coords: stance floor (0,61,0), own
// head free, west lip at dy+2 with air below, south full wall (gravel
// over stone in prod; bedrock here — undiggable even with a pick, so
// jsf.4 dig_step stays out and the test isolates the oz8 menu answer).
function pocketWorld() {
  return new Set([
    key(0, 60, 0), // floor under the stance
    key(-1, 63, 0), // west lip at dy+2, enterable below
    key(0, 61, 1), key(0, 62, 1), // south full wall
  ])
}

// 1-wide chimney: full-height stone walls on all 4 sides, own column free.
function chimneyWorld() {
  const solids = new Set([key(0, 60, 0)])
  for (let y = 61; y <= 63; y++) {
    solids.add(key(1, y, 0)); solids.add(key(-1, y, 0))
    solids.add(key(0, y, 1)); solids.add(key(0, y, -1))
  }
  return solids
}

function worldBot(solids, items, p) {
  return {
    username: 'IdkBot',
    players: {},
    entities: {},
    health: 20,
    food: 20,
    entity: { position: pos(p[0], p[1], p[2]), onGround: true },
    inventory: { items: () => items },
    controls: {},
    setControlState(c, v) { this.controls[c] = !!v },
    getControlState(c) { return !!this.controls[c] },
    clearControlStates() { this.controls = {} },
    blockAt(bp) {
      const k = key(Math.floor(bp.x), Math.floor(bp.y), Math.floor(bp.z))
      const solidCell = solids.has(k)
      const name = !solidCell ? 'air' : (k === key(0, 61, 1) || k === key(0, 62, 1)) ? 'bedrock' : 'stone'
      return { name, position: new Vec3(Math.floor(bp.x), Math.floor(bp.y), Math.floor(bp.z)), boundingBox: solidCell ? 'block' : 'empty' }
    },
    pathfinder: { goal: null, setGoal(g) { this.goal = g }, stop() {}, isMoving: () => false },
    chats: [],
    chat(m) { this.chats.push(String(m)) },
  }
}

const KIT = [{ name: 'dirt', count: 5 }, { name: 'stone_pickaxe', count: 1 }]
// Goal straight above the stance: climb menu without needing the pit fact.
const ABOVE = { x: 0.3, y: 69, z: 0.5 }

function menuNames(facts) {
  return recover.RECOVER_ORDER.filter((n) => {
    try { return recover.RECOVER_MENU[n].feasible(facts, {}) } catch (_) { return false }
  })
}

describe('overhang head scan (oz8)', () => {
  it('boundary stance + enterable neighbour lip: head blocked, pillar and dig both out, FSM sidesteps', () => {
    // Bead stance: frac-x 0.30, west body edge exactly on the lip-column
    // boundary (the rig no-apex stance).
    const bot = worldBot(pocketWorld(), KIT.slice(), [0.3, 61, 0.5])
    const ctx = { stuck: { by: 'no-displacement', goal: ABOVE, key: 'pit' }, brain: null }
    const f = recover.recoverFacts(bot, ctx, null, null)
    assert.equal(f.headBlocked, true, 'the drift-reach lip blocks the head')
    assert.equal(f.ownHeadBlocked, false, 'the own column itself is free')
    assert.equal(f.walls, 1, 'sanity: only the south wall counts')
    assert.equal(recover.RECOVER_MENU.pillar_up.feasible(f), false, 'pillar_up is not offered under the lip')
    assert.equal(recover.RECOVER_MENU.dig_up.feasible(f), false, 'dig_up is not offered: own headroom is free (9sq F1)')
    const names = menuNames(f)
    assert.ok(!names.includes('pillar_up'), `menu: ${names}`)
    assert.ok(names.includes('sidestep'), `menu: ${names}`)
    assert.equal(recover.recoverFsm(f, names), 'sidestep')
  })

  it('decide() under the lip chooses sidestep, never pillar_up', async () => {
    const bot = worldBot(pocketWorld(), KIT.slice(), [0.3, 61, 0.5])
    const ctx = { stuck: { by: 'no-displacement', goal: ABOVE, key: 'pit' }, brain: null }
    const r = await recover.decide(bot, ctx, null, null)
    assert.equal(r.action, 'sidestep', `got ${r.action}`)
  })

  it('pillarUpRun vetoes the lip on the first tick (no 20-tick no-apex)', () => {
    const bot = worldBot(pocketWorld(), KIT.slice(), [0.3, 61, 0.5])
    const ctx = { stuck: { by: 'no-displacement', goal: ABOVE, key: 'pit' }, recovery: { action: 'pillar_up', source: 'fsm', status: 'running', st: null } }
    const out = recover.pillarUpRun(bot, ctx)
    assert.equal(out, 'failed:head-blocked')
  })

  it('chimney climbs unaffected: full-height walls never threaten, centered or leaning', () => {
    // Centered: the lip column is outside the drift reach entirely.
    const centered = worldBot(chimneyWorld(), KIT.slice(), [0.5, 61, 0.5])
    const cctx = { stuck: { by: 'no-displacement', goal: ABOVE, key: 'pit' }, brain: null }
    const fc = recover.recoverFacts(centered, cctx, null, null)
    assert.equal(fc.headBlocked, false, 'centered chimney stance reads free')
    assert.equal(recover.RECOVER_MENU.pillar_up.feasible(fc), true, 'pillar_up still offered in the chimney')
    // Leaning on the west wall: the wall column is in drift reach, but its
    // feet cell is solid, so the body can never drift in - sliding, not a
    // bonk. Same for a centered stance next to an enterable lip: out of
    // reach means out of the veto.
    const leaning = worldBot(chimneyWorld(), KIT.slice(), [0.15, 61, 0.5])
    const fl = recover.recoverFacts(leaning, cctx, null, null)
    assert.equal(fl.headBlocked, false, 'a full-height wall is not a lip')
    const clearOfLip = worldBot(pocketWorld(), KIT.slice(), [0.5, 61, 0.5])
    const fo = recover.recoverFacts(clearOfLip, cctx, null, null)
    assert.equal(fo.headBlocked, false, 'a lip outside drift reach does not veto')
    assert.equal(recover.RECOVER_MENU.pillar_up.feasible(fo), true)
  })

  it('own-column rock still blocks and still offers dig_up (9sq F1)', async () => {
    const solids = pocketWorld()
    solids.add(key(0, 63, 0)) // own dy+2 solid, like the pristine pocket
    const bot = worldBot(solids, KIT.slice(), [0.3, 61, 0.5])
    const ctx = { stuck: { by: 'no-displacement', goal: ABOVE, key: 'pit' }, brain: null }
    const f = recover.recoverFacts(bot, ctx, null, null)
    assert.equal(f.headBlocked, true)
    assert.equal(f.ownHeadBlocked, true)
    assert.equal(recover.RECOVER_MENU.pillar_up.feasible(f), false)
    assert.equal(recover.RECOVER_MENU.dig_up.feasible(f), true, 'blocked own head is diggable')
    assert.equal(recover.RECOVER_MENU.dig_up.repeatable(f), true)
    const r = await recover.decide(worldBot(solids, KIT.slice(), [0.3, 61, 0.5]),
      { stuck: { by: 'no-displacement', goal: ABOVE, key: 'pit' }, brain: null }, null, null)
    assert.equal(r.action, 'dig_up', `got ${r.action}`)
  })

  it('dig_up feasibility tolerates facts without the new field (stand/tests literals)', () => {
    const f = { goalDy: 2, goalDist: 9, pickaxe: true, lavaNear: false, headBlocked: true }
    assert.equal(recover.RECOVER_MENU.dig_up.feasible(f), true)
    assert.equal(recover.RECOVER_MENU.dig_up.feasible({ ...f, headBlocked: false }), false)
  })
})

describe('lip shape guards (oz8 revmux 01)', () => {
  it('pressed stance at a feet-level notch (dy+1 solid): wall, not lip — pillar offered', () => {
    // Revmux 01 core-1/body-1: a dy+1-solid neighbour can never hold the
    // 1.8 body at any jump phase, so the pressed stance (frac 0.30, edge on
    // the notch boundary) slides and climbs; vetoing it wedges a 1x1 shaft
    // with no replacement (dig_up needs own blockage, walls=4 drops
    // sidestep). Guard: must read free.
    const solids = new Set([key(0, 60, 0), key(-1, 62, 0), key(-1, 63, 0)])
    const bot = worldBot(solids, KIT.slice(), [0.3, 61, 0.5])
    const ctx = { stuck: { by: 'no-displacement', goal: ABOVE, key: 'pit' }, brain: null }
    const f = recover.recoverFacts(bot, ctx, null, null)
    assert.equal(f.headBlocked, false, 'the notch is a wall to slide along')
    assert.equal(f.ownHeadBlocked, false)
    assert.equal(recover.RECOVER_MENU.pillar_up.feasible(f), true, 'the climb stays offered')
  })

  it('diagonal lip behind a sealed corner reads free; open corner still vetoes', () => {
    // The body reaches a diagonal column only past both orthogonal
    // neighbours: a wall in either seals the corner.
    const sealed = new Set([key(0, 60, 0), key(-1, 63, -1), key(-1, 61, 0)])
    const botSealed = worldBot(sealed, KIT.slice(), [0.3, 61, 0.3])
    const ctx = { stuck: { by: 'no-displacement', goal: ABOVE, key: 'pit' }, brain: null }
    const fs = recover.recoverFacts(botSealed, ctx, null, null)
    assert.equal(fs.headBlocked, false, 'west wall seals the diagonal corner')
    assert.equal(recover.RECOVER_MENU.pillar_up.feasible(fs), true)
    // Same diagonal lip with both orthogonals enterable: reachable, vetoed.
    const open = new Set([key(0, 60, 0), key(-1, 63, -1)])
    const botOpen = worldBot(open, KIT.slice(), [0.3, 61, 0.3])
    const fo = recover.recoverFacts(botOpen, ctx, null, null)
    assert.equal(fo.headBlocked, true, 'open corner leaves the diagonal lip reachable')
    assert.equal(fo.ownHeadBlocked, false)
    assert.equal(recover.RECOVER_MENU.pillar_up.feasible(fo), false)
  })
})
