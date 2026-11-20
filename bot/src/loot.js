'use strict'
// Post-kill loot: fight.swing() notes its last target; when that entity is
// gone a few seconds later it died, and the tick walks onto each item drop
// near the death spot (bounded radius and time) before any step resumes.
// Every kill path (fight, reflex, forage, bring) swings through fight.swing.

const { goals } = require('mineflayer-pathfinder')
const { issueGoal } = require('./behaviours/util')

const LOOT_R = 5 // drops within this of the death spot
const LOOT_MS = 8000 // whole pickup budget
const SWING_FRESH_MS = 3000 // a target gone this long after the swing died, not walked off

function noteSwing(bot, ent) {
  if (!bot || !ent || !ent.position) return
  bot._lootSwung = { id: ent.id, pos: ent.position.clone ? ent.position.clone() : { ...ent.position }, at: Date.now() }
}

function dropsNear(bot, c) {
  return Object.values(bot.entities || {}).filter((e) => e && e.name === 'item' && e.isValid !== false && e.position &&
    Math.abs(e.position.x - c.x) <= LOOT_R && Math.abs(e.position.z - c.z) <= LOOT_R && Math.abs(e.position.y - c.y) <= 3)
}

const REISSUE_MS = 2000 // a "reached" goal with the drop still out of pickup range walks again

function freeSlots(bot) {
  try { const it = bot.inventory.items(); return Array.isArray(it) ? 36 - it.length : -1 } catch (_) { return -1 }
}

// A full pack picks up nothing that does not stack (prod bot4: n=0 x12, pigs
// hunted again and again): toss one junk stack via craft's junk policy.
// Fire-and-forget; one in flight per bot.
function makeRoom(bot) {
  if (freeSlots(bot) !== 0 || bot._lootRoomInFlight) return false
  bot._lootRoomInFlight = true
  const craft = require('./behaviours/craft') // lazy: craft loads half the tree
  Promise.resolve().then(() => craft.freeSlot(bot, { item: 'loot' }))
    .catch(() => {}).then(() => { bot._lootRoomInFlight = false })
  return true
}

function end(ctx, left, bot) {
  const L = ctx.loot
  ctx.loot = null
  console.log(`loot picked n=${L.picked.size} left=${left} free=${freeSlots(bot)}`)
  return false
}

// true = loot owns this tick's body. danger: hostile close / fleeing.
function tick(bot, ctx, danger) {
  const now = Date.now()
  const s = bot._lootSwung
  if (s && now - s.at > SWING_FRESH_MS) bot._lootSwung = null
  else if (s) {
    const e = bot.entities ? bot.entities[s.id] : null
    if (!e || e.isValid === false) {
      bot._lootSwung = null
      ctx.loot = { c: s.pos, at: now, seen: new Set(), picked: new Set() }
    }
  }
  const L = ctx.loot
  if (!L) return false
  const drops = dropsNear(bot, L.c)
  const ids = new Set(drops.map((d) => d.id))
  for (const id of L.seen) if (!ids.has(id)) L.picked.add(id)
  for (const id of ids) L.seen.add(id)
  if (danger || now - L.at > LOOT_MS) return end(ctx, drops.length, bot)
  // Drops spawn at the death, before the corpse entity is removed: none now means none.
  if (!drops.length) { if (!L.seen.size) { ctx.loot = null; return false } return end(ctx, 0, bot) }
  const bp = bot.entity.position
  drops.sort((a, b) => a.position.distanceTo(bp) - b.position.distanceTo(bp))
  const d = drops[0].position
  const x = Math.floor(d.x), y = Math.floor(d.y), z = Math.floor(d.z)
  const key = `loot:${x},${y},${z}`
  makeRoom(bot)
  // Same key but still out of pickup range after a "reached" (v2 Baritone stops
  // beside a hole/water cell): walk onto the drop's current cell again.
  if (key !== ctx.lastGoalKey || (bp.distanceTo(d) > 1.2 && now - (L.goalAt || 0) > REISSUE_MS)) {
    L.goalAt = now
    try { issueGoal(bot, ctx, new goals.GoalBlock(x, y, z), key, false) } catch (_) { /* walk best-effort */ }
  }
  return true
}

function active(ctx) { return !!(ctx && ctx.loot) }

module.exports = { noteSwing, tick, active, makeRoom, freeSlots, LOOT_R, LOOT_MS }
