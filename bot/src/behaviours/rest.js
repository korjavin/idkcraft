'use strict'

const Vec3 = require('vec3')
const { goals } = require('mineflayer-pathfinder')
const roam = require('./roam')

// Castle anchor (g0z.23): with nobody visible and an open castle, wait at
// its entrance (the gocastle stance) instead of the home site, so a
// blocked build finds the bot nearby when the backoff expires. Deferred
// require (the goal <-> castle cycle precedent).
function castleAnchor(ctx) {
  try {
    const st = ctx && ctx.castle
    if (!st || st.parked || st.phase === 'complete') return null
    if (!st.site || typeof st.site.x !== 'number') return null
    return require('./castle').entrance(st)
  } catch (_) {
    return null
  }
}

// Castle inventory pass: a castle home reads every chest in its box once
// (then again once a read is INVENTORY_STALE_MS old) while resting, so
// stored wool, iron and food are known stock (chest-first lookups,
// storagePick, gear). withChest snapshots the read into ctx.chests.
const INVENTORY_STALE_MS = 30 * 60 * 1000
function castleInventory(bot, ctx) {
  try {
    const home = ctx && ctx.home
    if (!home || home.kind !== 'castle' || !home.site || ctx.restPeekInFlight) return !!(ctx && ctx.restPeekInFlight)
    const bp = bot.entity && bot.entity.position
    const box = require('../residence').of(home).box(home)
    const ids = require('../blockids').resolveIds(bot, ['chest', 'trapped_chest', 'barrel'])
    if (!bp || !ids || ids.length === 0) return false
    const inBox = (p) => p.x >= box.min.x && p.x <= box.max.x && p.y >= box.min.y && p.y <= box.max.y && p.z >= box.min.z && p.z <= box.max.z
    const sp = require('./stockpile')
    const found = (bot.findBlocks({ matching: ids, maxDistance: 96, count: 64 }) || []).filter(inBox)
    if (found.length > 0) sp.rememberChests(ctx, found)
    const now = Date.now()
    let pick = null
    for (const p of found) {
      const e = ctx.chests.find((c) => c.x === p.x && c.y === p.y && c.z === p.z)
      if (e && Number.isFinite(e.at) && now - e.at < INVENTORY_STALE_MS) continue
      if (e && Number.isFinite(e.failAt) && now - e.failAt < INVENTORY_STALE_MS) continue
      const d = Math.hypot(bp.x - p.x, bp.y - p.y, bp.z - p.z)
      if (!pick || d < pick.d) pick = { p, d }
    }
    if (!pick) return false
    const p = pick.p
    const key = `rest-inventory:${p.x},${p.y},${p.z}`
    if (pick.d > require('./packroom').INTERACT_REACH) {
      if (ctx.lastGoalKey === key && !bot.pathfinder.isMoving()) {
        ctx.restPeekStalls = (ctx.restPeekStalls || 0) + 1
        if (ctx.restPeekStalls > 10) { sp.markChestFailed(ctx, p); ctx.restPeekStalls = 0; ctx.lastGoalKey = null }
        return true
      }
      if (ctx.lastGoalKey !== key) { ctx.restPeekStalls = 0; require('./util').issueGoal(bot, ctx, new goals.GoalNear(p.x, p.y, p.z, 2), key, false) }
      return true
    }
    ctx.restPeekInFlight = true
    void require('./packroom').withChest(bot, ctx, async () => true, new Vec3(p.x, p.y, p.z)).then((r) => {
      ctx.restPeekInFlight = false
      ctx.lastGoalKey = null
      if (!r || r.status !== 'ok') { sp.markChestFailed(ctx, p); return }
      const e = ctx.chests.find((c) => c.x === p.x && c.y === p.y && c.z === p.z)
      try { console.log(`castle inventory chest=${p.x},${p.y},${p.z} items=${Object.keys((e && e.contents) || {}).length}`) } catch (_) { /* log best-effort */ }
    }, () => { ctx.restPeekInFlight = false })
    return true
  } catch (_) {
    return false
  }
}

// rest: stroll around the home site (world spawn until bead .4 sets one).
// Pseudo-target: roam only reads target.position (username/id just tag goal
// keys), and a static point never trips GoalFollow.hasChanged, so the bot
// strolls out and walks back without replanning churn. The position must be
// a real Vec3 — GoalFollow.hasChanged calls position.floored(), which plain
// home-site coords lack (live crash); a Vec3 re-wraps losslessly.
function rest(bot, ctx, target, state) {
  // An order's step-aside walk (llm-orders retry) owns rest while it runs.
  const aside = ctx && ctx.orderAside
  if (aside && Date.now() < aside.until) {
    const key = `aside:${Math.round(aside.x)},${Math.round(aside.z)}`
    try {
      if (ctx.lastGoalKey !== key || !bot.pathfinder.isMoving()) {
        require('./util').issueGoal(bot, ctx, new goals.GoalNear(aside.x, aside.y, aside.z, 2), key, false)
      }
    } catch (_) { /* walk best-effort */ }
    return
  }
  // Player near (the ticker hands the nearest visible player as target):
  // stroll near them, never wander back to the site trap while the owner
  // stands next to the bot (p4s). Roam reuses follow at >6 blocks and picks
  // new points past the executor wedge — no new logic here.
  if (target && target.position) {
    roam(bot, ctx, target, state)
    return
  }
  if (castleInventory(bot, ctx)) return
  const site = castleAnchor(ctx) || (ctx.home && ctx.home.site) || (bot && bot.spawnPoint)
  if (!site) return
  const p = site && typeof site.floored === 'function' ? site : new Vec3(site.x, site.y, site.z)
  roam(bot, ctx, { position: p }, state)
}

module.exports = rest
module.exports.castleInventory = castleInventory
