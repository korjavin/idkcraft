// Reach a block nobody can stand next to (floating scaffold, tree tops):
// a live reach window lets the body build its own access — pillar or bridge
// with whatever throwaway block the pack holds (the scaffold set). v2:
// Baritone's own allowPlace (body.js nearAnyCastle); v1: the place vetoes
// lift around the target column (castle placeFn). Any step may arm it.
const REACH_BUILD_MS = 3 * 60 * 1000
const REACH_XZ = 5 // stand column within dig reach of the target

const key = (t) => `${t.x},${t.y},${t.z}`
function live(ctx, now = Date.now()) {
  const r = ctx && ctx.reachBuild
  return !!(r && r.until > now)
}
function arm(ctx, t, now = Date.now()) {
  ctx.reachBuild = { x: t.x, y: t.y, z: t.z, until: now + REACH_BUILD_MS, how: process.env.BOT_BODY === 'baritone' ? 'baritone' : 'pillar' }
  try { console.log(`reach target=${key(t)} how=${ctx.reachBuild.how} result=start`) } catch (_) { /* log best-effort */ }
}
// A placement at q may serve the live reach window's access build.
function nearTarget(ctx, q, now = Date.now()) {
  if (!q || !live(ctx, now)) return false
  const r = ctx.reachBuild
  return Math.abs(q.x - r.x) <= REACH_XZ && Math.abs(q.z - r.z) <= REACH_XZ && q.y <= r.y + 1
}
// Outcome for target t: logs how it was reached and closes its window.
function done(ctx, t, result) {
  const r = ctx && ctx.reachBuild
  const mine = !!(r && key(r) === key(t))
  try { console.log(`reach target=${key(t)} how=${mine ? r.how : 'walk'} result=${result}`) } catch (_) { /* log best-effort */ }
  if (mine) ctx.reachBuild = null
}

module.exports = { arm, live, nearTarget, done, REACH_BUILD_MS }
