'use strict'
// Damage attribution: every health drop gets a cause (mob:<name>,
// explosion, fall, lava, fire, drowning, suffocation, starvation, unknown);
// the death line prints the last one as cause= and metrics count it.
const { HOSTILE_NAMES } = require('./perception')
const metrics = require('./metrics')

const HURT_KEEP = 5
const DEATH_CAUSE_MS = 5000
const FALL_MIN = 3.5
const FALL_VY = -0.9 // blocks/tick: ~5+ blocks of free fall
// Server death messages (vanilla wording) -> cause; first match wins.
const DEATH_MSG = [
  [/lava/, 'lava'], [/burn|flames|fire/, 'fire'], [/drown/, 'drowning'], [/suffocat|squash|in a wall/, 'suffocation'],
  [/out of the world|fell out/, 'void'], [/fell|hit the ground|doomed to fall|too far/, 'fall'], [/starv/, 'starvation'],
  [/blew up|blown up|explo/, 'explosion'], [/slain by|shot by|killed by/, 'mob'],
]

function blockAt(bot, pos, dy) {
  try { return bot.blockAt(pos.offset(0, dy, 0)) || null } catch (_) { return null }
}

// Nearest entity of the given kind within r (null when none).
function nearest(bot, r, pred) {
  const bp = bot.entity && bot.entity.position
  let best = null
  let bd = r
  for (const id in (bot.entities || {})) {
    const e = bot.entities[id]
    if (!e || e === bot.entity || !e.position || !pred(e)) continue
    let d
    try { d = e.position.distanceTo(bp) } catch (_) { continue }
    if (d <= bd) { bd = d; best = e }
  }
  return best
}

function classify(bot, ctx, drop, now = Date.now()) {
  const src = ctx.hurtSource && now - ctx.hurtSource.at <= 1000 ? ctx.hurtSource.name : null
  if (src) return src === 'creeper' ? 'explosion' : `mob:${src}`
  const pos = bot.entity && bot.entity.position
  if (!pos) return 'unknown'
  const feet = (blockAt(bot, pos, 0) || {}).name || ''
  const body = (blockAt(bot, pos, 1) || {}).name || ''
  const e = bot.entity
  const minY = bot.game && typeof bot.game.minY === 'number' ? bot.game.minY : -64
  if (pos.y < minY) return 'void'
  if (feet.includes('lava') || body.includes('lava') || e.isInLava === true) return 'lava'
  if (feet.includes('fire') || body.includes('fire')) return 'fire'
  const fall = ctx.lastFall
  if (fall && now - fall.at <= 1000 && fall.dist >= FALL_MIN) return 'fall'
  // Poll-cadence bodies (bridge) miss the landing tick: a fast drop still reads.
  if (e.velocity && typeof e.velocity.y === 'number' && e.velocity.y <= FALL_VY) return 'fall'
  if (bot.oxygenLevel === 0) return 'drowning'
  const head = blockAt(bot, pos, 1.6)
  if (head && head.boundingBox === 'block') return 'suffocation'
  if (drop >= 3 && nearest(bot, 7, (e) => e.name === 'creeper')) return 'explosion'
  const mob = nearest(bot, 4, (e) => HOSTILE_NAMES.has(e.name || ''))
  if (mob) return `mob:${mob.name}`
  if (bot.food === 0) return 'starvation'
  // Head under water with nothing else to blame: the bridge's oxygen poll lags.
  if (((blockAt(bot, pos, 1.6) || {}).name || '') === 'water') return 'drowning'
  return 'unknown'
}

// Wire the taps once per bot (real bot and bridge body alike).
function install(bot, ctx) {
  if (!bot || !ctx || bot._hurtInstalled || typeof bot.on !== 'function') return
  bot._hurtInstalled = true
  let lastHp = typeof bot.health === 'number' ? bot.health : 20
  let airPeak = null
  bot.on('physicsTick', () => {
    const e = bot.entity
    if (!e || !e.position) return
    if (e.onGround === false) { airPeak = airPeak == null ? e.position.y : Math.max(airPeak, e.position.y); return }
    if (airPeak != null) ctx.lastFall = { dist: airPeak - e.position.y, at: Date.now() }
    airPeak = null
  })
  bot.on('entityHurt', (e, source) => {
    if (e !== bot.entity || !source) return
    ctx.hurtSource = { name: source.name || source.username || 'mob', at: Date.now() }
  })
  // The server's death line ('<name> fell from a high place') is the only
  // first-hand cause; a body that forwards it (v1, bridge chat) wins.
  bot.on('message', (msg) => {
    const text = String((msg && (msg.text != null ? msg.text : msg)) || '')
    const name = bot.username
    if (!name || !text.startsWith(name + ' ')) return
    const cause = causeOfMessage(text.slice(name.length + 1))
    if (cause) { ctx.deathMsg = { cause, text, at: Date.now() }; console.log(`death message: ${text} cause=${cause}`) }
  })
  bot.on('health', () => {
    const hp = bot.health
    if (typeof hp !== 'number') return
    const drop = lastHp - hp
    lastHp = hp
    if (drop > 0) noteHurt(bot, ctx, drop)
  })
}

function noteHurt(bot, ctx, drop, now = Date.now()) {
  let cause = 'unknown'
  try { cause = classify(bot, ctx, drop, now) } catch (_) { /* unknown */ }
  const log = ctx.hurtLog = ctx.hurtLog || []
  log.push({ at: now, cause, drop })
  if (log.length > HURT_KEEP) log.shift()
  return cause
}

// Cause for the death line: the last hurt within DEATH_CAUSE_MS, else a
// fresh read of the surroundings. Counts it once per death.
function causeOfMessage(text) {
  const t = String(text || '').toLowerCase()
  for (const [re, cause] of DEATH_MSG) if (re.test(t)) return cause
  return null
}

// What the death read saw, for an unknown cause (prod bot3: six cause=unknown
// deaths at one spot with no hurt lines): feet/head blocks, vy, o2, last fall.
function evidence(bot, ctx, now = Date.now()) {
  try {
    const e = bot.entity
    const pos = e && e.position
    if (!pos) return 'nopos'
    const n = (dy) => ((blockAt(bot, pos, dy) || {}).name || '?')
    const vy = e.velocity && typeof e.velocity.y === 'number' ? e.velocity.y.toFixed(2) : '?'
    const f = ctx && ctx.lastFall
    const fall = f ? `${f.dist.toFixed(1)}@${Math.round((now - f.at) / 1000)}s` : 'none'
    return `feet=${n(0)} head=${n(1.6)} below=${n(-1)} vy=${vy} o2=${bot.oxygenLevel} food=${bot.food} fall=${fall}`
  } catch (_) { return 'err' }
}

function deathCause(bot, ctx, now = Date.now()) {
  const log = (ctx && ctx.hurtLog) || []
  const last = log[log.length - 1]
  const dm = ctx && ctx.deathMsg
  let cause = dm && now - dm.at <= DEATH_CAUSE_MS ? dm.cause : null
  if (!cause && last && now - last.at <= DEATH_CAUSE_MS && last.cause !== 'unknown') cause = last.cause
  if (!cause) { try { cause = classify(bot, ctx || {}, 20, now) } catch (_) { cause = 'unknown' } }
  if (cause === 'unknown') cause += `/${evidence(bot, ctx || {}, now).replace(/ /g, ',')}`
  if (ctx) { ctx.hurtLog = []; ctx.deathMsg = null }
  try { metrics.events.inc({ event: `death_cause:${cause.split('/')[0]}` }) } catch (_) { /* metrics best-effort */ }
  return cause
}

module.exports = { install, noteHurt, deathCause, classify, causeOfMessage }
