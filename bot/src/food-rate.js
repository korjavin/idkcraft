'use strict'

// 'food rate' every 10 min: meals eaten, mean food, lowest health, food
// recovery starts and deaths in the window (the dies-in-foodRecovery class).
const WINDOW_MS = 10 * 60 * 1000

function win(ctx, now) {
  return ctx.foodRate || (ctx.foodRate = { since: now, eaten: 0, sum: 0, n: 0, minHealth: 20, recoveries: 0, deaths: 0 })
}

function note(ctx, kind, now = Date.now()) {
  if (ctx) win(ctx, now)[kind]++
}

// Per tick: sample food/health, print and reset once the window is over.
function tick(bot, ctx, now = Date.now()) {
  if (!ctx || !bot || typeof bot.food !== 'number') return
  const w = win(ctx, now)
  w.sum += bot.food; w.n++
  if (typeof bot.health === 'number' && bot.health < w.minHealth) w.minHealth = bot.health
  if (now - w.since < WINDOW_MS) return
  console.log(`food rate eaten=${w.eaten} food=${(w.sum / w.n).toFixed(1)} minHealth=${Math.round(w.minHealth)} recoveries=${w.recoveries} deaths=${w.deaths}`)
  ctx.foodRate = null
}

module.exports = { note, tick, WINDOW_MS }
