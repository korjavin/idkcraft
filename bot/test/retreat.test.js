'use strict'

// Retreat chain (idkcraft-1tj): alone at low health with a hostile on the
// bot, the vetoed follow must offer retreat/pillar/gohome, never idle.
const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { Vec3 } = require('vec3')
const { RETREAT_ORDER, feasibleRetreat, chooseRetreat, retreat, pillar } = require('../src/behaviours/retreat')
const { hybridBrain } = require('../src/brain')
const { createTicker, BEHAVIOURS } = require('../src/index')

function pos(x, y, z) {
  return {
    x, y, z,
    distanceTo: (q) => Math.hypot(x - q.x, y - q.y, z - q.z),
    clone() { return pos(x, y, z) },
  }
}

function key(x, y, z) { return `${x},${y},${z}` }

// Open field: solid floor y<=63, air above. Pit adds 4 walls at feet+head.
function fieldBot({ items = [], solids = null, entities = {}, home = null, health = 3 } = {}) {
  const ground = solids || new Set()
  if (!solids) {
    for (let x = -4; x <= 4; x++) {
      for (let z = -4; z <= 4; z++) ground.add(key(x, 63, z))
    }
  }
  const calls = { setGoal: 0, goals: [], chats: [] }
  const bot = {
    calls,
    username: 'IdkBot',
    players: {},
    entities,
    health,
    food: 20,
    entity: { position: pos(0.5, 64, 0.5) },
    inventory: { items: () => items },
    blockAt(p) {
      const k = key(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z))
      const solidCell = ground.has(k)
      return { name: solidCell ? 'dirt' : 'air', position: new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)), boundingBox: solidCell ? 'block' : 'empty' }
    },
    pathfinder: {
      goal: null,
      setGoal: (g) => { calls.setGoal++; calls.goals.push(g); bot.pathfinder.goal = g },
      stop: () => {},
      isMoving: () => false,
      setMovements: () => {},
    },
    setControlState: () => {},
    clearControlStates: () => {},
    getControlState: () => false,
    chat: (l) => { calls.chats.push(String(l)) },
  }
  return bot
}

function zombie(id, x, y, z) {
  return { id, name: 'zombie', type: 'mob', position: pos(x, y, z), isValid: true }
}

function pitSolids() {
  const solids = new Set()
  for (let x = -2; x <= 2; x++) {
    for (let z = -2; z <= 2; z++) solids.add(key(x, 63, z))
  }
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) solids.add(key(dx, 64, dz))
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) solids.add(key(dx, 65, dz))
  return solids
}

function freshCtx(home) {
  return { lastGoalKey: '', stepStatus: null, goalText: null, home: home || null, brain: null }
}

const STATE = { bot_health: 3, hostile_distance: 1.5, nearby_hostiles: 3 }

describe('retreat gates', () => {
  it('open field with dirt: retreat and pillar, in owner order', () => {
    const bot = fieldBot({ items: [{ name: 'dirt', count: 5 }], entities: { 1: zombie(1, 2, 64, 0) } })
    assert.deepEqual(feasibleRetreat(bot, freshCtx(), STATE), ['retreat', 'pillar'])
  })
  it('pit walls shut flee: pillar only', () => {
    const bot = fieldBot({ items: [{ name: 'dirt', count: 5 }], solids: pitSolids(), entities: { 1: zombie(1, 1.5, 64, 0) } })
    bot.entity.position = pos(0.5, 64, 0.5)
    assert.deepEqual(feasibleRetreat(bot, freshCtx(), STATE), ['pillar'])
  })
  it('no scaffold shuts pillar; built close home opens gohome', () => {
    const bot = fieldBot({ entities: { 1: zombie(1, 2, 64, 0) } })
    assert.deepEqual(feasibleRetreat(bot, freshCtx(), STATE), ['retreat'])
    const home = { site: { x: 10, y: 64, z: 0 }, built: true }
    assert.deepEqual(feasibleRetreat(bot, freshCtx(home), STATE), ['retreat', 'gohome'])
  })
  it('far or unbuilt home stays shut; far hostile shuts flee', () => {
    const bot = fieldBot({ entities: { 1: zombie(1, 2, 64, 0) } })
    const far = { site: { x: 200, y: 64, z: 0 }, built: true }
    assert.deepEqual(feasibleRetreat(bot, freshCtx(far), STATE), ['retreat'])
    const raw = { site: { x: 10, y: 64, z: 0 }, built: false }
    assert.deepEqual(feasibleRetreat(bot, freshCtx(raw), STATE), ['retreat'])
    assert.deepEqual(feasibleRetreat(bot, freshCtx(), { ...STATE, hostile_distance: 10 }), [])
  })
  it('players online: chain refuses (normal flow owns)', async () => {
    const bot = fieldBot({ items: [{ name: 'dirt', count: 5 }], entities: { 1: zombie(1, 2, 64, 0) } })
    const r = await chooseRetreat(null, bot, freshCtx(), { ...STATE, distance_to_player: 4 })
    assert.equal(r, null)
  })
})

describe('retreat chain', () => {
  function askBrain(answers) {
    const calls = []
    return {
      calls,
      source: 'laya',
      async ask({ criteria }) {
        calls.push(Object.keys(criteria))
        return answers[Math.min(calls.length - 1, answers.length - 1)]
      },
    }
  }
  it('single option asks nothing (only-option)', async () => {
    const bot = fieldBot({ items: [{ name: 'dirt', count: 5 }], solids: pitSolids(), entities: { 1: zombie(1, 1.5, 64, 0) } })
    bot.entity.position = pos(0.5, 64, 0.5)
    const brain = askBrain([])
    const ctx = freshCtx()
    const r = await chooseRetreat(brain, bot, ctx, STATE)
    assert.deepEqual(r, { action: 'pillar', source: 'only-option', model: null })
    assert.equal(brain.calls.length, 0)
    assert.equal(ctx.recovery.action, 'pillar_up')
    assert.equal(ctx.recovery.status, 'running')
    assert.ok(bot.calls.chats.some((l) => l.startsWith('retreating: pillaring up')))
  })
  it('yes/no chain in owner order: no then pillar', async () => {
    const bot = fieldBot({ items: [{ name: 'dirt', count: 5 }], entities: { 1: zombie(1, 2, 64, 0) } })
    const brain = askBrain(['no', 'pillar'])
    const r = await chooseRetreat(brain, bot, freshCtx(), STATE)
    assert.equal(r.action, 'pillar')
    assert.equal(r.source, 'laya')
    assert.deepEqual(brain.calls[0], ['retreat', 'no'])
    assert.deepEqual(brain.calls[1], ['pillar', 'no'])
  })
  it('all declined: null once, then silent without re-asking', async () => {
    const bot = fieldBot({ items: [{ name: 'dirt', count: 5 }], entities: { 1: zombie(1, 2, 64, 0) } })
    const brain = askBrain(['no'])
    const ctx = freshCtx()
    assert.equal(await chooseRetreat(brain, bot, ctx, STATE), null)
    assert.equal(brain.calls.length, 2) // retreat? no; pillar? no (gohome infeasible)
    assert.equal(await chooseRetreat(brain, bot, ctx, STATE), null)
    assert.equal(brain.calls.length, 2) // stamped: no re-ask, situation unchanged
    // Same-bucket drift (hp 3->5, hd 1.5->1.9): still no re-ask.
    assert.equal(await chooseRetreat(brain, bot, ctx, { ...STATE, bot_health: 5, hostile_distance: 1.9 }), null)
    assert.equal(brain.calls.length, 2)
  })
  it('invalid label continues the chain with a disagree note', async () => {
    const bot = fieldBot({ items: [{ name: 'dirt', count: 5 }], entities: { 1: zombie(1, 2, 64, 0) } })
    const errs = []
    const orig = console.error
    console.error = (m) => { errs.push(String(m)) }
    try {
      const brain = askBrain(['fight', 'pillar'])
      const r = await chooseRetreat(brain, bot, freshCtx(), STATE)
      assert.equal(r.action, 'pillar')
      assert.ok(errs.some((e) => e.includes('brain disagree') && e.includes('reason=retreat')))
    } finally {
      console.error = orig
    }
  })
  it('dead brain (every ask throws): fsm-fallback pick, unstamped', async () => {
    const bot = fieldBot({ items: [{ name: 'dirt', count: 5 }], entities: { 1: zombie(1, 2, 64, 0) } })
    const dead = { source: 'laya', async ask() { throw new Error('timeout') } }
    const ctx = freshCtx()
    const r1 = await chooseRetreat(dead, bot, ctx, STATE)
    assert.deepEqual(r1, { action: 'retreat', source: 'fsm-fallback', model: null })
    assert.equal(ctx.retreatAskedKey, undefined) // unasked: retry next tick
    const r2 = await chooseRetreat(dead, bot, freshCtx(), STATE)
    assert.equal(r2.action, 'retreat')
  })
  it('stub brain (no ask): first feasible, source fsm', async () => {
    const bot = fieldBot({ items: [{ name: 'dirt', count: 5 }], entities: { 1: zombie(1, 2, 64, 0) } })
    const r = await chooseRetreat({ source: 'stub' }, bot, freshCtx(), STATE)
    assert.deepEqual(r, { action: 'retreat', source: 'fsm', model: null })
  })
  it('ongoing pick holds without re-asking', async () => {
    const bot = fieldBot({ items: [{ name: 'dirt', count: 5 }], entities: { 1: zombie(1, 2, 64, 0) } })
    const brain = askBrain(['retreat'])
    const ctx = freshCtx()
    const r1 = await chooseRetreat(brain, bot, ctx, STATE)
    assert.equal(r1.action, 'retreat')
    assert.equal(brain.calls.length, 1)
    ctx.stepStatus = 'running'
    const r2 = await chooseRetreat(brain, bot, ctx, STATE)
    assert.equal(r2.action, 'retreat')
    assert.equal(r2.source, 'laya') // the stored pick origin, not a fallback
    assert.deepEqual(ctx.retreat, { action: 'retreat', source: 'laya', model: 'laya' })
    assert.equal(brain.calls.length, 1) // held, not re-asked
  })
  it('just-failed gohome excludes itself from the next menu', async () => {
    const bot = fieldBot({ items: [{ name: 'dirt', count: 5 }], entities: { 1: zombie(1, 2, 64, 0) } })
    const home = { site: { x: 10, y: 64, z: 0 }, built: true }
    // Decline everything: with gohome in the menu the chain would ask it
    // third and pick it; excluded, the chain ends after two questions.
    const brain = askBrain(['no', 'no', 'gohome'])
    const ctx = freshCtx(home)
    ctx.retreat = { action: 'gohome', source: 'laya', model: 'laya' }
    ctx.stepStatus = 'failed:cannot-reach-home'
    const r = await chooseRetreat(brain, bot, ctx, STATE)
    assert.equal(r, null)
    assert.equal(brain.calls.length, 2) // retreat? no; pillar? no (gohome never asked)
    assert.equal(ctx.retreatFailed, 'gohome')
  })
  it('just-failed option leaves the model menu while an alternative stands', async () => {
    const bot = fieldBot({ items: [{ name: 'dirt', count: 5 }], entities: { 1: zombie(1, 2, 64, 0) } })
    const brain = askBrain([])
    const ctx = freshCtx()
    ctx.retreatFailed = 'pillar'
    const r = await chooseRetreat(brain, bot, ctx, STATE)
    assert.equal(r.action, 'retreat') // pillar excluded, retreat the only option: no ask
    assert.equal(brain.calls.length, 0)
  })
})

describe('retreat behaviours', () => {
  it('flee: far hostile is done; no position fails loudly', () => {
    const bot = fieldBot({ entities: { 1: zombie(1, 20, 64, 0) } })
    const ctx = freshCtx()
    retreat(bot, ctx)
    assert.equal(ctx.stepStatus, 'done')
    const blind = fieldBot({})
    blind.entity = null
    const ctx2 = freshCtx()
    retreat(blind, ctx2)
    assert.equal(ctx2.stepStatus, 'failed:retreat-no-pos')
    assert.equal(ctx2.retreatFailed, 'retreat')
  })
  it('flee: own no-path fails loudly; foreign no-path is ignored', () => {
    const bot = fieldBot({ entities: { 1: zombie(1, 2, 64, 0) } })
    const ctx = freshCtx()
    ctx.lastGoalKey = 'retreat:1'
    ctx.lastPathStatus = 'noPath'
    retreat(bot, ctx)
    assert.equal(ctx.stepStatus, 'failed:retreat-no-path')
    assert.equal(ctx.retreatFailed, 'retreat')
    const foreign = fieldBot({ entities: { 1: zombie(1, 2, 64, 0) } })
    const ctx2 = freshCtx()
    ctx2.lastGoalKey = 'fight:1'
    ctx2.lastPathStatus = 'noPath'
    retreat(foreign, ctx2)
    assert.equal(ctx2.stepStatus, 'running') // not our goal: keep trying
  })
  it('flee: near hostile sets the away goal and runs', () => {
    const bot = fieldBot({ entities: { 1: zombie(1, 2, 64, 0) } })
    const ctx = freshCtx()
    retreat(bot, ctx)
    assert.equal(ctx.stepStatus, 'running')
    assert.equal(bot.calls.setGoal, 1)
    const g = bot.calls.goals[0]
    assert.ok(g.x < 0.5, `away from the hostile at +x, got x=${g.x}`) // bot x=0.5, hostile x=2
  })
  it('pillar wrapper mirrors rec.status to the step', () => {
    const bot = fieldBot({ items: [{ name: 'dirt', count: 5 }] })
    const own = () => ({ action: 'pillar', source: 'laya', model: 'laya' })
    // A placed prim already verified: the wrapper maps, not recomputes.
    const done = {
      recovery: { action: 'pillar_up', status: 'running', st: { phase: 'place', placed: true, startFloor: 63 } },
      stepStatus: 'running', retreat: own(),
    }
    pillar(bot, done)
    assert.equal(done.stepStatus, 'done')
    assert.equal(done.recovery, null) // terminal: stuck detectors back on
    const failed = { recovery: { action: 'pillar_up', status: 'failed:no-scaffold' }, stepStatus: 'running', retreat: own() }
    pillar(bot, failed)
    assert.equal(failed.stepStatus, 'failed:pillar-no-scaffold')
    assert.equal(failed.retreatFailed, 'pillar')
    assert.equal(failed.recovery, null) // terminal: later stuck episodes start clean
    const running = { recovery: { action: 'pillar_up', status: 'running' }, stepStatus: 'running', retreat: own() }
    pillar(bot, running)
    assert.equal(running.stepStatus, 'running')
    assert.ok(running.recovery) // live episode keeps owning it
  })
  it('pillar wrapper keeps an adopted episode (no retreat ownership)', () => {
    const bot = fieldBot({ items: [{ name: 'dirt', count: 5 }] })
    // A stuck flow adopted the prim and cleared ctx.retreat first: terminal
    // verdict maps, but the episode belongs to recover now.
    const adopted = { recovery: { action: 'pillar_up', status: 'failed:no-scaffold' }, stepStatus: 'running', retreat: null }
    pillar(bot, adopted)
    assert.equal(adopted.stepStatus, 'failed:pillar-no-scaffold')
    assert.ok(adopted.recovery)
  })
  it('registers in BEHAVIOURS under retreat and pillar', () => {
    assert.equal(BEHAVIOURS.retreat, retreat)
    assert.equal(BEHAVIOURS.pillar, pillar)
  })
})

describe('veto path ownership (live 1tj)', () => {
  it('interleaved work step ends the episode: next veto re-chains', async () => {
    const bot = fieldBot({ items: [{ name: 'dirt', count: 5 }], entities: { 1: zombie(1, 2, 64, 0) }, health: 3 })
    bot.players = {}
    const answers = ['no', 'pillar', 'no', 'pillar']
    let asks = 0
    let chainAsks = 0
    const remote = {
      name: 'laya',
      source: 'laya',
      async decide() { return { action: 'follow', sprint: false, source: 'laya' } },
      // The goal menu asks through the same remote on tick 2: count only
      // the retreat chain's questions (retreat/pillar/gohome vs no).
      async ask({ criteria }) {
        asks++
        if (criteria && (criteria.retreat || criteria.pillar || criteria.gohome)) chainAsks++
        return answers[Math.min(asks - 1, answers.length - 1)]
      },
    }
    const brain = hybridBrain(remote)
    const ticker = createTicker({ bot, brain, tickMs: 10, idleTickMs: 10, autonomous: true })
    ticker.work()
    // Tick 1: veto -> chain asks retreat (no) then pillar (yes).
    const r1 = await ticker.tick()
    assert.equal(r1.decision.action, 'pillar')
    assert.equal(chainAsks, 2)
    // Tick 2: healthy, no hostile: the goal arbiter takes the tick (rest),
    // which must release the pillar episode.
    bot.health = 20
    bot.entities = {}
    const r2 = await ticker.tick()
    assert.ok(r2.decision.action !== 'pillar' && r2.decision.action !== 'retreat')
    // Tick 3: low health + hostile again: a FRESH chain (2 more asks),
    // never a hold of the tick-1 pick.
    bot.health = 3
    bot.entities = { 1: zombie(1, 2, 64, 0) }
    const r3 = await ticker.tick()
    assert.equal(r3.decision.action, 'pillar')
    assert.equal(chainAsks, 4)
  })
})

describe('goal shortcut (live 1tj follow-up)', () => {
  it('lapsed veto re-decides, never re-issues the chain step', async () => {
    // No dirt: the chain can only pick retreat (no asks anywhere).
    const bot = fieldBot({ entities: { 1: zombie(1, 2, 64, 0) }, health: 3 })
    bot.players = {}
    const decides = ['idle', 'follow', 'idle']
    let n = 0
    const remote = {
      name: 'laya',
      source: 'laya',
      async decide() { n++; return { action: decides[Math.min(n - 1, decides.length - 1)], sprint: false, source: 'laya' } },
      async ask({ criteria }) {
        const keys = Object.keys(criteria || {})
        if (keys.includes('retreat') || keys.includes('pillar') || keys.includes('gohome')) {
          throw new Error('chain must not ask: retreat is the only option')
        }
        return keys[0] // any valid menu label; the point is a real re-decide
      },
    }
    const brain = hybridBrain(remote)
    const ticker = createTicker({ bot, brain, tickMs: 10, idleTickMs: 10, autonomous: true })
    ticker.work()
    // Tick 0: model idle (no veto) -> goal arbiter sets its text and step.
    // HP drifts 3->4->5 across ticks (same veto window, same key bucket):
    // the ticker caches identical states, so each tick needs fresh facts.
    const r0 = await ticker.tick()
    assert.ok(r0.decision.action !== 'retreat')
    // Tick 1: model follow -> veto -> only-option retreat pick, owns the step.
    bot.health = 4
    const r1 = await ticker.tick()
    assert.equal(r1.decision.action, 'retreat')
    // Tick 2: model idle again (veto lapsed), world unchanged: the arbiter
    // must re-decide, not shortcut the chain-owned retreat back out.
    bot.health = 5
    const r2 = await ticker.tick()
    assert.ok(r2.decision.action !== 'retreat', `lapsed veto re-issued retreat: ${r2.decision.action}`)
  })
})

describe('veto path acceptance (1tj)', () => {
  it('low health + hostile adjacent + noplayer: retreat, never idle', async () => {
    const bot = fieldBot({ items: [{ name: 'dirt', count: 5 }], entities: { 1: zombie(1, 2, 64, 0) }, health: 3 })
    bot.players = {}
    bot.inventory = { items: () => bot._items || [{ name: 'dirt', count: 5 }] }
    bot._items = [{ name: 'dirt', count: 5 }]
    const remote = {
      name: 'laya',
      source: 'laya',
      async decide() { return { action: 'follow', sprint: false, source: 'laya' } },
      async ask() { return 'pillar' },
    }
    const brain = hybridBrain(remote)
    // Alone means autonomous work mode: with nobody on the roster the
    // cost-guard idle branch (no brain call at all) would park the tick
    // before the veto path. autonomous opts the tick into working alone.
    const ticker = createTicker({ bot, brain, tickMs: 10, idleTickMs: 10, autonomous: true })
    ticker.work()
    const r = await ticker.tick()
    assert.equal(r.decision.action, 'pillar')
    assert.equal(r.decision.source, 'laya')
  })
})
