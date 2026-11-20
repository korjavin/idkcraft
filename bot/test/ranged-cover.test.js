'use strict'

// prod 2026-11-20 bot4: under skeleton fire the bot chased 22 s (20 -> 3 hp),
// fled toward solid stone (noPath x2), and every retreat tick struck its bread
// run (strikes=11). Class fixes: engagement cap, cover first, standable flee
// cells, no strike on a safety preempt, food at 8 hp.
const { it } = require('node:test')
const assert = require('node:assert/strict')
const { Vec3 } = require('vec3')
const { feasibleRetreat, chooseRetreat, retreat } = require('../src/behaviours/retreat')
const fight = require('../src/behaviours/fight')
const fr = require('../src/behaviours/food-recovery')
const { needsFood } = require('../src/health-gate')

const key = (x, y, z) => `${x},${y},${z}`
function pos(x, y, z) {
  return { x, y, z, distanceTo: (q) => Math.hypot(x - q.x, y - q.y, z - q.z), clone() { return pos(x, y, z) } }
}
function mkBot(solids, entities, health = 14) {
  const goals = []
  const bot = {
    username: 'IdkBot', players: {}, entities, health, food: 20,
    entity: { position: pos(0.5, 64, 0.5), onGround: true },
    inventory: { items: () => [{ name: 'dirt', count: 16 }, { name: 'stone_sword', count: 1 }] },
    blockAt(p) {
      const s = solids.has(key(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)))
      return { name: s ? 'stone' : 'air', position: new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)), boundingBox: s ? 'block' : 'empty' }
    },
    pathfinder: { goal: null, setGoal: (g) => { goals.push(g); bot.pathfinder.goal = g }, stop: () => {}, isMoving: () => false, setMovements: () => {} },
    setControlState: () => {}, clearControlStates: () => {}, getControlState: () => false, chat: () => {}, lookAt: () => {}, attack: () => {},
  }
  bot.goals = goals
  return bot
}
function floor(r = 8) {
  const s = new Set()
  for (let x = -r; x <= r; x++) for (let z = -r; z <= r; z++) s.add(key(x, 63, z))
  return s
}
const skeleton = (x, z) => ({ id: 7, name: 'skeleton', type: 'mob', position: pos(x, 64, z), isValid: true })
const zombie = () => ({ id: 1, name: 'zombie', type: 'mob', position: pos(2.5, 64, 0.5), isValid: true })

it('unreachable shooter: cover (digin) is offered first, the chain takes it', async () => {
  const bot = mkBot(floor(), { 7: skeleton(8.5, 0.5) })
  const ctx = { lastGoalKey: '', stepStatus: null, brain: null }
  const state = { bot_health: 14, hostile_distance: 8, nearby_hostiles: 1, hostile_reachable: false }
  assert.equal(feasibleRetreat(bot, ctx, state)[0], 'digin')
  const pick = await chooseRetreat(null, bot, ctx, state)
  assert.equal(pick.action, 'digin')
  assert.deepEqual(ctx.retreatDig, {})
})

it('flee goal is always a standable cell; a walled side is skipped without a noPath wait', () => {
  const solids = floor()
  // Solid stone on the whole away side (-x), as in the prod GoalNear-on-stone.
  for (let x = -8; x <= -1; x++) for (let z = -8; z <= 8; z++) for (const y of [61, 62, 64, 65, 66]) solids.add(key(x, y, z))
  const bot = mkBot(solids, { 1: zombie() }, 3)
  const ctx = { lastGoalKey: '', stepStatus: null }
  retreat(bot, ctx)
  assert.equal(ctx.stepStatus, 'running')
  const g = bot.goals[bot.goals.length - 1]
  assert.ok(solids.has(key(g.x, g.y - 1, g.z)) && !solids.has(key(g.x, g.y, g.z)) && !solids.has(key(g.x, g.y + 1, g.z)), `standable ${g.x},${g.y},${g.z}`)
  assert.equal(ctx.lastGoalKey, 'retreat:1:1', 'away side skipped at once')
  // Boxed in: no standable cell anywhere -> fails now so the chain moves on.
  const all = new Set()
  for (let x = -8; x <= 8; x++) for (let z = -8; z <= 8; z++) for (let y = 61; y <= 67; y++) if (x || z) all.add(key(x, y, z))
  const boxed = mkBot(all, { 1: zombie() }, 3)
  const c2 = { lastGoalKey: '', stepStatus: null }
  retreat(boxed, c2)
  assert.equal(c2.stepStatus, 'failed:retreat-no-cell')
  assert.equal(c2.retreatFailed, 'retreat')
})

it('fight: hurt by a mob kept out of swing reach past the cap writes it off', () => {
  const bot = mkBot(floor(), { 7: skeleton(8.5, 0.5) })
  const ctx = { lastGoalKey: '' }
  const state = { hostile: bot.entities[7], hostile_distance: 8 }
  const log = console.log
  console.log = () => {}
  try {
    fight(bot, ctx, null, state)
    assert.notEqual(ctx.fightGivenUpId, 7)
    ctx.fightRec.at = Date.now() - 6000 // 6 s in, never in reach
    ctx.lastHurtAt = Date.now() - 500
    fight(bot, ctx, null, state)
  } finally { console.log = log }
  assert.equal(ctx.fightGivenUpId, 7)
})

it('safety preempt does not strike the food run; food acts at 8 hp', () => {
  const bot = { health: 7, food: 15, inventory: { items: () => [] } }
  const ctx = {}
  ctx.foodRecovery = { valid: true, phase: 'bread', startFood: 15 }
  Object.defineProperty(ctx.foodRecovery, 'bot', { value: bot })
  fr.invalidate(ctx, true)
  assert.ok(!ctx.foodRecoveryRetryAt && !ctx.foodRecoveryFails)
  assert.equal(needsFood({ health: 7, food: 20 }), true)
  assert.equal(needsFood({ health: 8, food: 20 }), false)
})
