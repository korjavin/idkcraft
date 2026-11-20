'use strict'
// Episode memory (idkcraft-8hpy.5): every stall decide -> stall outcome is
// one episode {sig, choice, outcome, ms, at} in ctx.episodes (persisted by
// memory.js in the bot memory file, capped LRU). A new stall recalls the
// episodes with the most similar situation signature; the result rides the
// JEV/LLM request as `past` and biases the deterministic fallbackRank.

const EPISODES_MAX = 500
const SIG_FIELDS = ['kind', 'phase', 'blocked', 'owed', 'terrain', 'pack', 'chest', 'fail']
const RATE_MS = 600000
const WORK_WINDOW_MS = 300000
const WORK_FAILURE_LIMIT = 3

// Last recall of this process (one bot per process): fallbackRank reads it.
let last = { sig: null, past: [] }

function bucket(n) {
  if (!(n > 0)) return '0'
  if (n < 16) return 'few'
  if (n < 64) return 'some'
  return 'lots'
}

function owedFamily(ctx) {
  try {
    const cw = ctx && ctx.castleWord
    if (cw && cw.kind) return String(cw.kind).replace(/^(oak|spruce|birch|jungle|acacia|dark_oak|mangrove|cherry|stripped)_/, '').split('_').pop()
  } catch (_) { /* owed best-effort */ }
  return '-'
}

function terrain(bot) {
  try {
    const e = bot && bot.entity
    if (!e) return '?'
    if (e.isInWater) return 'water'
    const p = e.position.floored()
    const b = bot.blockAt(p)
    if (b && b.skyLight === 0) return 'cave'
    const biome = b && b.biome && b.biome.name
    return biome ? `open:${biome}` : 'open'
  } catch (_) {
    return '?'
  }
}

function count(items, fam) {
  if (!fam || fam === '-' || !Array.isArray(items)) return 0
  return items.reduce((n, it) => n + (it && typeof it.name === 'string' && it.name.includes(fam) ? (it.count || 0) : 0), 0)
}

// Compact situation signature; every field is a short class string.
function sig(bot, ctx, kind) {
  const owed = owedFamily(ctx)
  let blocked = '-'
  let fail = '-'
  let pack = 0
  let chest = 0
  try {
    const sf = ctx && ctx.stepStatus
    if (typeof sf === 'string' && sf.startsWith('failed:')) fail = sf.slice(7).split(/[:\s]/)[0] || '-'
    const t = ctx && ctx.task
    const fails = t && t[t.active] && Array.isArray(t[t.active].fails) ? t[t.active].fails : []
    if (fail === '-' && fails.length) fail = String(fails[fails.length - 1]).split(/[:\s]/)[0]
    const pick = ctx && ctx.stepPick
    if (pick && pick.why) blocked = String(pick.why).split(/[\s=:(]/)[0] || '-'
  } catch (_) { /* fields best-effort */ }
  try { pack = count(bot && bot.inventory && bot.inventory.items(), owed) } catch (_) { pack = 0 }
  try {
    for (const c of (ctx && Array.isArray(ctx.chests) ? ctx.chests : [])) chest += count(c && c.items, owed)
  } catch (_) { chest = 0 }
  return {
    kind: kind || '?',
    phase: (ctx && ctx.step) || 'none',
    blocked,
    owed,
    terrain: terrain(bot),
    pack: bucket(pack),
    chest: bucket(chest),
    fail,
  }
}

function sigText(s) {
  return s ? SIG_FIELDS.map((k) => s[k]).join('/') : '?'
}

function similarity(a, b) {
  if (!a || !b || a.kind !== b.kind) return 0
  return SIG_FIELDS.reduce((n, k) => n + (a[k] === b[k] ? 1 : 0), 0)
}

function success(outcome) {
  return outcome === 'progress'
}

function listOf(ctx) {
  if (!Array.isArray(ctx.episodes)) ctx.episodes = []
  return ctx.episodes
}

// Find similar past episodes (same kind, >= 4/8 fields equal), grouped by
// choice; top 5 by successes then rate. Stores the signature as the pending
// one for the next record and the result for fallbackRank.
function recall(bot, ctx, kind) {
  const s = sig(bot, ctx, kind)
  const by = {}
  let hits = 0
  for (const e of listOf(ctx)) {
    if (similarity(s, e.sig) < 4) continue
    hits++
    const g = by[e.choice] || (by[e.choice] = { choice: e.choice, n: 0, ok: 0, outcome: e.outcome })
    g.n++
    if (success(e.outcome)) g.ok++
    g.outcome = e.outcome
  }
  const past = Object.values(by)
    .map((g) => ({ choice: g.choice, outcome: g.outcome, n: g.n, successRate: Math.round((g.ok / g.n) * 100) / 100 }))
    .sort((a, b) => b.successRate * b.n - a.successRate * a.n || b.successRate - a.successRate)
    .slice(0, 5)
  ctx.episodeSig = s
  last = { sig: s, past }
  try {
    const best = past[0] ? `${past[0].choice}(${past[0].successRate})` : '-'
    console.log(`episode recall sig=${sigText(s)} hits=${hits} best=${best}`)
  } catch (_) { /* log best-effort */ }
  return past
}

// Fallback score delta for a choice: a past success goes first, a choice
// that failed twice or more with no success sinks.
function bias(id) {
  const p = last.past.find((x) => x.choice === id)
  if (!p) return 0
  if (p.successRate > 0) return -1000 * p.successRate
  return p.n >= 2 ? 5000 : 0
}

function record(bot, ctx, kind, choice, outcome, ms, now) {
  if (!ctx || !choice || choice === '?') return
  const list = listOf(ctx)
  const s = ctx.episodeSig && ctx.episodeSig.kind === kind ? ctx.episodeSig : sig(bot, ctx, kind)
  ctx.episodeSig = null
  list.push({ sig: s, choice, outcome: String(outcome), ms: Math.max(0, ms | 0), at: typeof now === 'number' ? now : Date.now() })
  if (list.length > EPISODES_MAX) list.splice(0, list.length - EPISODES_MAX)
  const r = rateOf(ctx)
  r.decides++
  if (success(outcome)) r.progress++
  else if (outcome === 'flat' || String(outcome).startsWith('failed:')) r.flat++
}

function beginWork(bot, ctx, choice, generation, progress, facts, decision, now = Date.now()) {
  ctx.workEpisode = {
    choice, generation, before: Number.isFinite(progress?.done) ? progress.done : null,
    total: Number.isFinite(progress?.total) ? progress.total : null,
    id: `${now}-${generation}`, by: decision.by, conf: decision.conf,
    facts, at: now, sig: sig(bot, ctx, 'work'),
  }
  console.log(`brain work choice=${choice} by=${decision.by} conf=${decision.conf ?? '?'} id=${ctx.workEpisode.id}`)
}

function workResult(run, generation, progress, status, facts, now) {
  const after = Number.isFinite(progress?.done) ? progress.done : null
  const delta = run.generation === generation && run.before != null && after != null && run.total === progress?.total
    ? after - run.before : null
  // A generation change without an observed result is a cancellation.
  // Count positive movement on an interrupted run only when it was measured.
  const fail = run.generation === generation && status?.startsWith('failed:') ? status.slice(7) : null
  const done = run.generation === generation && status === 'done'
  const outcome = fail != null ? `failed:${fail}`
    : delta > 0 || (delta == null && done && facts !== run.facts) ? 'progress'
      : done || status === 'window' ? 'flat' : 'interrupted'
  return {
    sig: run.sig, choice: run.choice, outcome, before: run.before, after, delta, fail,
    by: run.by, ms: Math.max(0, now - run.at), at: now,
  }
}

function logWorkOutcome(run, result) {
  if (run.reported) return
  run.reported = true
  console.log(`brain work outcome choice=${run.choice} by=${run.by} id=${run.id} result=${result.outcome} delta=${result.delta ?? '?'} fail=${result.fail ?? '-'} ms=${result.ms}`)
}

function sampleWork(ctx, generation, progress, facts, now = Date.now()) {
  const run = ctx.workEpisode
  if (run && !run.reported && now - run.at >= WORK_WINDOW_MS) {
    logWorkOutcome(run, workResult(run, generation, progress, 'window', facts, now))
  }
}

function finishWork(ctx, generation, progress, status, facts, now = Date.now()) {
  const run = ctx.workEpisode
  if (!run) return null
  ctx.workEpisode = null
  const episode = workResult(run, generation, progress, status, facts, now)
  const list = listOf(ctx)
  list.push(episode)
  if (list.length > EPISODES_MAX) list.splice(0, list.length - EPISODES_MAX)
  logWorkOutcome(run, episode)
  return episode
}

// One neutral prior on each side keeps an untried block available and
// prevents one lucky result from dominating a block with a longer history.
function workRates(ctx, ids, now = Date.now()) {
  const stats = new Map(ids.map((id) => [id, { n: 0, ok: 0, last: null, consecutive: 0, lastAt: 0 }]))
  for (const e of ctx.episodes || []) {
    const stat = stats.get(e.choice)
    if (!stat || e.sig?.kind !== 'work' || e.outcome === 'interrupted') continue
    stat.n++
    if (e.at - stat.lastAt >= WORK_WINDOW_MS) stat.consecutive = 0
    if (success(e.outcome)) { stat.ok++; stat.consecutive = 0 }
    else stat.consecutive++
    stat.lastAt = e.at
    stat.last = e.outcome
  }
  return Object.fromEntries([...stats].map(([id, { n, ok, last: outcome, consecutive, lastAt }]) => [id, {
    attempts: n, successRate: Math.round(100 * (ok + 1) / (n + 2)) / 100, outcome,
    coolingDown: consecutive >= WORK_FAILURE_LIMIT && now - lastAt < WORK_WINDOW_MS,
  }]))
}

// Sanitize a stored list (hand-edited files must not inject shapes).
function of(v) {
  if (!Array.isArray(v)) return []
  return v.filter((e) => e && typeof e.choice === 'string' && e.sig && typeof e.sig === 'object' && typeof e.outcome === 'string').slice(-EPISODES_MAX)
}

function rateOf(ctx) {
  if (!ctx.goalRate) ctx.goalRate = { at: 0, done: null, ticks: 0, still: 0, pos: null, decides: 0, progress: 0, flat: 0 }
  return ctx.goalRate
}

// Called every task tick; logs one `goal rate` line per 10 min.
function rateTick(bot, ctx, kind, done, now) {
  try {
    if (!ctx || !kind) return
    const r = rateOf(ctx)
    const t = typeof now === 'number' ? now : Date.now()
    if (!r.at) {
      r.at = t
      r.done = typeof done === 'number' ? done : null
    }
    const p = bot && bot.entity && bot.entity.position
    if (p) {
      r.ticks++
      if (r.pos && p.distanceTo(r.pos) < 0.1) r.still++
      r.pos = p.clone()
    }
    if (t - r.at < RATE_MS) return
    const placed = typeof done === 'number' && typeof r.done === 'number' ? done - r.done : '?'
    const stand = r.ticks ? Math.round((r.still / r.ticks) * 100) : 0
    console.log(`goal rate kind=${kind} placed=${placed}/10min stand=${stand}% decides=${r.decides} progress=${r.progress} flat=${r.flat}`)
    ctx.goalRate = null
    rateOf(ctx).at = t
    ctx.goalRate.done = typeof done === 'number' ? done : null
  } catch (_) { /* monitor best-effort */ }
}

module.exports = { sig, sigText, recall, record, bias, beginWork, finishWork, sampleWork, workRates, WORK_WINDOW_MS, of, rateTick, EPISODES_MAX }
