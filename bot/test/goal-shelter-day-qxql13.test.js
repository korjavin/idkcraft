'use strict'

// idkcraft-qxql.13: wood-starved castle stall shed path. Prod-log check
// (2026-10-21, bot2 10-19 window): the 49% shelter share is dusk/night
// picks holding ~10 min each (max 10.0 min, all picked at dusk/night),
// never a daytime shed — dawn moves the time word, the time force fires,
// the day menu drops shelter. These tests pin that: shelter is
// day-infeasible with a castle order, dawn exits it, night keeps it, and
// the no-trees -> equip-fail -> gocastle-fail sequence parks the kind and
// sheds to day work, never to an idle step.
const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { MENU, goalFacts, goalText, decide } = require('../src/goal')
const castlefetchMod = require('../src/behaviours/castlefetch')

function pos(x, y, z) {
  const p = {
    x, y, z,
    distanceTo: (q) => Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z),
    clone() { return pos(p.x, p.y, p.z) },
    floored() { return pos(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)) },
  }
  return p
}

function testBot({ timeOfDay = 6000, at = pos(0, 64, 0), items = [] } = {}) {
  return {
    entity: { position: at },
    inventory: { items: () => items },
    time: { timeOfDay },
    spawnPoint: pos(0, 64, 0),
    blockAt: () => ({ name: 'air' }),
    chat: () => {},
  }
}

// Active castle (vetoes.castleFirst reads explore.castleActive).
function castleCtx(home) {
  return {
    work: true,
    brain: null,
    home,
    castle: { site: { x: 0, y: 64, z: 0 }, parked: false, phase: 'build' },
  }
}

describe('qxql.13 day shelter', () => {
  it('shelter infeasible in day with a castle order standing', () => {
    const bot = testBot({ timeOfDay: 6000 })
    const ctx = castleCtx({ site: pos(500, 64, 500), built: true })
    const facts = goalFacts(bot, ctx)
    assert.equal(facts.time, 'day')
    assert.equal(MENU.shelter.feasible(facts, bot, ctx), false)
  })

  it('night shelter still feasible homeless (no regression)', () => {
    const bot = testBot({ timeOfDay: 18000 })
    const ctx = { work: true, brain: null }
    const facts = goalFacts(bot, ctx)
    assert.equal(facts.time, 'night')
    assert.equal(MENU.shelter.feasible(facts, bot, ctx), true)
  })

  it('dawn (night text -> day text) re-decides out of shelter', async () => {
    const bot = testBot({ timeOfDay: 6000 })
    const ctx = castleCtx({ site: pos(500, 64, 500), built: true })
    const facts = goalFacts(bot, ctx)
    const dayText = goalText(facts, ctx.home)
    const nightText = dayText.replace('time=day', 'time=night')
    ctx.step = 'shelter'
    ctx.stepStatus = 'running'
    ctx.goalText = nightText
    ctx.heldText = null
    ctx.stepPick = { step: 'shelter', source: 'night-rule', fsm: 'shelter', why: 'night', at: Date.now() - 60000 }
    ctx.shelter = { pillared: true, perched: true }
    const d = await decide(bot, ctx)
    assert.notEqual(d.action, 'shelter', `dawn must leave shelter, got ${d.action}`)
  })

  it('night shelter holds on steady night facts (no regression)', async () => {
    const bot = testBot({ timeOfDay: 18000 })
    const ctx = { work: true, brain: null }
    const facts = goalFacts(bot, ctx)
    const text = goalText(facts, ctx.home)
    ctx.step = 'shelter'
    ctx.stepStatus = 'running'
    ctx.goalText = text
    ctx.heldText = text
    ctx.stepPick = { step: 'shelter', source: 'night-rule', fsm: 'shelter', why: 'night', at: Date.now() }
    ctx.shelter = { pillared: true, perched: true }
    const d = await decide(bot, ctx)
    assert.equal(d.action, 'shelter')
  })

  // Bead sequence: a wood-starved fetch leg ends no-trees, equip fails
  // table-unreachable, gocastle fails cannot-reach-castle. The kind parks
  // in the per-kind hold and the stall sheds to day work, never shelter.
  it('wood-starved stall parks the kind and sheds to day work', async () => {
    const bot = testBot({ timeOfDay: 6000 })
    const ctx = castleCtx({ site: pos(500, 64, 500), built: true })
    const facts = goalFacts(bot, ctx)
    assert.equal(facts.time, 'day')
    const text = goalText(facts, ctx.home)
    const kind = facts.castle.slice(0, facts.castle.lastIndexOf('-'))
    // Fetch leg ends no-trees (the WOOD branch stamps the leg kind).
    ctx.step = 'castlefetch'
    ctx.stepStatus = 'failed:no-trees'
    ctx.castleFetchFailKind = kind
    ctx.goalText = text
    ctx.heldText = null
    await decide(bot, ctx)
    assert.equal(castlefetchMod.holdFor(bot, ctx, kind), true, `${kind} parks on no-trees`)
    assert.equal(MENU.castlefetch.feasible(goalFacts(bot, ctx), bot, ctx), false, 'parked kind leaves the fetch menu')
    // Equip fails table-unreachable, gocastle fails cannot-reach-castle.
    ctx.step = 'equip'
    ctx.stepStatus = 'failed:equip-table-unreachable'
    await decide(bot, ctx)
    ctx.step = 'gocastle'
    ctx.stepStatus = 'failed:cannot-reach-castle'
    const d = await decide(bot, ctx)
    // An idle shed (shelter/rest/stay/idle) is the bead's complaint; the
    // stall must shed to work. (Here: explore — gather's castle-chop
    // clause yields while the kind is held, the built home is not
    // blocked, so the bounded spiral is the work.)
    assert.ok(
      !['shelter', 'rest', 'stay', 'idle'].includes(d.action),
      `stall must shed to work, got ${d.action}`,
    )
  })
})
