'use strict'

// idkcraft-oqul.2: characterization harness for the brain-structure moves
// (epic oqul, stages 1–3). Records the ordered external effects of a tick
// run — pathfinder setGoal/stop/setMovements (with the movement flags the
// goal was issued under), chat, body owner, step/stepStatus/lastGoalKey —
// so a pure move that changes any of them shows up as a golden diff, not
// as a still-green `decision.action` assert.
//
// Golden files live in test/golden/<file>.json keyed by scenario name.
// `npm run golden:update` rewrites them (GOLDEN_UPDATE=1); a reviewer reads
// the journal diff as a behaviour change.

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const GOLDEN_DIR = path.join(__dirname, 'golden')

// mulberry32: a seeded Math.random, so roam/recover jitter is replayable.
function seeded(seed) {
  let a = seed >>> 0
  return function random() {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// One controlled clock for the ticker, task.js and the scenario: Date.now
// is global (task.js:1502/1675 and most behaviours read it directly), so
// the fake replaces it process-wide until restore(). Math.random is seeded
// alongside. Always restore in a finally.
function fakeClock(start = 1_700_000_000_000, seed = 1) {
  const realNow = Date.now
  const realRandom = Math.random
  const c = {
    t: start,
    now: () => c.t,
    advance(ms) { c.t += ms },
    restore() { Date.now = realNow; Math.random = realRandom },
  }
  Date.now = c.now
  Math.random = seeded(seed)
  return c
}

const round = (v) => Math.round(v * 1000) / 1000

function plain(v) {
  if (v == null || typeof v === 'string' || typeof v === 'boolean') return v
  if (typeof v === 'number') return round(v)
  return undefined
}

// Goals, flattened to what identifies them: type, coords/range, nested
// goals, the followed entity by name. Anything else is named, not dumped.
function goalDesc(g, depth = 0) {
  const p = plain(g)
  if (p !== undefined || g == null) return g == null ? null : p
  if (typeof g !== 'object' || depth > 3) return `[${typeof g}]`
  if (Array.isArray(g)) return g.map((x) => goalDesc(x, depth + 1))
  const type = g.constructor && g.constructor.name
  const out = type && type !== 'Object' ? { type } : {}
  for (const k of Object.keys(g).sort()) {
    const v = g[k]
    if (typeof v === 'function') continue
    const pv = plain(v)
    if (pv !== undefined) { out[k] = pv; continue }
    if (k === 'entity' || k === 'bot') { out[k] = v ? (v.username || v.name || v.id || '[entity]') : v; continue }
    out[k] = goalDesc(v, depth + 1)
  }
  return out
}

const FLAGS = ['canDig', 'allowSprinting', 'allowParkour', 'allow1by1towers', 'canOpenDoors']
function flags(m) {
  if (!m || typeof m !== 'object') return null
  const out = {}
  for (const f of FLAGS) if (typeof m[f] === 'boolean') out[f] = m[f]
  return out
}

function wrap(obj, name, before) {
  if (!obj || typeof obj[name] !== 'function') return
  const orig = obj[name]
  obj[name] = function wrapped(...args) {
    before(...args)
    return orig.apply(this, args)
  }
}

// Intercept every write of ctx[key]; record only real changes (same-value
// refreshes are not effects). `desc` maps the stored value to the logged one.
function watch(ctx, key, desc, onChange) {
  let value = ctx[key]
  Object.defineProperty(ctx, key, {
    configurable: true,
    enumerable: true,
    get: () => value,
    set(v) {
      const before = desc(value)
      value = v
      const after = desc(v)
      if (before !== after) onChange(after)
    },
  })
}

const scalar = (v) => {
  const p = plain(v)
  return p !== undefined ? p : JSON.stringify(goalDesc(v))
}

// record(bot, ctx, { ticker, clock, tickMs, keys }) → journal. `keys` adds
// ctx fields to watch beyond step/stepStatus/lastGoalKey. Pass the ticker to
// count ticks (each ticker.tick() call bumps journal.tick and, with a
// clock, advances it by tickMs first). Events fired between ticks (an async
// step finishing late) carry the tick they landed in.
function record(bot, ctx, { ticker = null, clock = null, tickMs = 1000, keys = [] } = {}) {
  const j = { tick: 0, events: [] }
  const push = (kind, data) => j.events.push({ tick: j.tick, kind, ...data })
  const pf = bot.pathfinder
  const movesNow = () => flags((pf && pf.movements) || ctx.movements)
  wrap(pf, 'setGoal', (g, dynamic) => push('setGoal', { goal: goalDesc(g), dynamic: !!dynamic, moves: movesNow() }))
  wrap(pf, 'stop', () => push('stop', {}))
  wrap(pf, 'setMovements', (m) => push('setMovements', { moves: flags(m) }))
  wrap(bot, 'chat', (m) => push('chat', { text: String(m) }))
  watch(ctx, 'body', (b) => (b ? b.owner : b), (owner) => push('owner', { owner }))
  for (const key of ['step', 'stepStatus', 'lastGoalKey', ...keys]) watch(ctx, key, scalar, (v) => push(key, { value: v }))
  if (ticker) {
    const tick = ticker.tick
    ticker.tick = async (...args) => {
      j.tick++
      if (clock) clock.advance(tickMs)
      return tick.apply(ticker, args)
    }
  }
  return j
}

// Compare (or with GOLDEN_UPDATE=1 rewrite) one scenario's journal in
// test/golden/<file>.json. Tests within a file run sequentially, files in
// separate processes: the read-modify-write per file is race-free.
function golden(file, scenario, events) {
  const p = path.join(GOLDEN_DIR, `${file}.json`)
  let all = {}
  try { all = JSON.parse(fs.readFileSync(p, 'utf8')) } catch (_) { all = {} }
  const got = JSON.parse(JSON.stringify(events))
  if (process.env.GOLDEN_UPDATE) {
    all[scenario] = got
    fs.mkdirSync(GOLDEN_DIR, { recursive: true })
    // One event per line: a behaviour change reads as a line diff.
    const body = Object.keys(all).map((k) =>
      ` ${JSON.stringify(k)}: [\n${all[k].map((e) => `  ${JSON.stringify(e)}`).join(',\n')}\n ]`)
    fs.writeFileSync(p, `{\n${body.join(',\n')}\n}\n`)
    return
  }
  assert.ok(scenario in all, `no golden for ${file}/${scenario}: run npm run golden:update`)
  assert.deepEqual(got, all[scenario], `${file}/${scenario}: effect journal changed (npm run golden:update if intended)`)
}

module.exports = { seeded, fakeClock, goalDesc, flags, record, golden }
