'use strict'

// Automatic curriculum (idkcraft-vf8e.9): prod's failure log, ranked by
// owner-visible cost, is "what to learn next". Offline: reads a dump file,
// no host, token or container id in here (README "Curriculum").
//
//   node tools/curriculum.js harvest <dump.txt...> [days=7]
//   node tools/curriculum.js propose <sig>
//
// Dump lines start "YYYY-MM-DD HH:MM:SS <name> <msg>" (UTC), like deaths.sh.
// A raw `docker logs --timestamps` dump works as is (vf8e.16): the daemon's
// leading RFC3339 timestamp and any multiplex framing are stripped, and the
// bot's bare stdout lines (no date or name of their own) are dated from the
// daemon stamp and attributed to the single bot in the filter. Bare lines
// under a multi-bot filter are skipped (unattributable).
// Families (owner 2026-10-19: the simplest first):
//   page  — a recover episode (recover.js logRecover lines) that chose
//           call_player or ended gave-up. Signature = last failed hand
//           primitive + its outcome + the end pos in an 8-block cell.
//   bring — a bring order refused for a recipe gap: the bot's own chat
//           "<Bot> can't get <item>: no recipe, no source" / "<Bot> can't
//           make <item>: need …|no recipe|crafting failed" from the mc log
//           (the bot never logs its chat). Signature = item + reason words.
//   step-fail (vf8e.11) — a goal step that ended failed:<reason> (goal.js
//           `goal ... why=step-failed fail=failed:<reason> ... facts=...`).
//           Signature = step + reason (no pos: goal lines carry none).
//           Proposes only vehicles that leave the goal menu running
//           (gather/build -> `build here`, shelter -> the night dig-in
//           arena); castlefetch failures route to park, the rest read
//           `no-order` (revmux 01: orders that own the body could never
//           run the skill).
//   park (vf8e.11, unreachable verdict path 0l0m, parked sggu) — a
//           castlefetch-* leg failure (`castlefetch <kind>: leg over
//           (failed:...)`, `castlefetch failed:...`) or a park line
//           (`goal park ...`, `task ... parked ...`) whose diagnosis names
//           one. Signature = the castlefetch reason. All castlefetch-*
//           stay parked: other reasons read `no-verdict` (revmux 02: no
//           in-window outcome judges them) and `castlefetch-unreachable`
//           reads `red-parked` (sggu: judging `build castle` by `castle
//           done at ` inside secs:300 is RED on every run — a whole castle
//           takes hours — so the paid skill loop could never go GREEN);
//           other parks read `no-vehicle`.
// Rank = owner tier first (vf8e.22: castlefetch parks, castlefetch/mine/
// castle-feeding step fails and daytime idle above night/arrival families),
// then count x weight (page 3, bring 2, step-fail 2, park 2). Bots: CURRICULUM_BOTS = comma
// list or "all" (default BOT2_USERNAME, else IdkBotV2 — the owner's feed);
// SWARM_PREFIX names fold into one "swarm" bot like deaths.sh. days counts
// back from the newest timestamp in the dump, so a re-run is deterministic.
// Out: <CURRICULUM_DIR, default /tmp/idkcraft-curriculum>/curriculum.json
// plus a table; propose writes <dir>/AUTO-<sig>/{spots.json,scenario.json}.
// ponytail: the signature is an 8-hex sha1 so spot and skill names are
// always valid.

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

const WEIGHT = { page: 3, bring: 2, 'step-fail': 2, park: 2 }
// Owner priority (idkcraft-vf8e.22): the harvest ranks what the owner cares
// about first — castlefetch/mine/castle-feeding step fails and daytime idle
// (S4 idle+stay) — above night/arrival families. Tiers sort before score;
// score (count x weight) still orders inside a tier.
const OWNER_STEPS = new Set(['castlefetch', 'gather', 'craft', 'build', 'deliver', 'castle']) // mine = gather; castle-feeding = craft/build/deliver
const NIGHT_ARRIVAL_STEPS = new Set(['shelter', 'gohome', 'stay']) // the night safety steps (skills README): stay, gohome, shelter
const CELL = 8
const DIR = () => process.env.CURRICULUM_DIR || '/tmp/idkcraft-curriculum'
const BEAD = 'idkcraft-vf8e.9'
const BEAD11 = 'idkcraft-vf8e.11'
// Order arena for bring proposals: the vf8e.6 order spots' shaft-side flat.
const BRING_SPAWN = [59.5, 64, -205.5]
const BRING_GOAL = [62.5, 64, -205.5]
const GOAL_DY = { high: 3, low: -3, level: 0 }
const MAX_DIST = 16 // ponytail: a 123-block page goal is not a 90 s micro-run; raise with the arena

const TS = /^(\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d)\S* (\S+) (.*)$/
const RECOVER = /recover action=(\S+) source=\S+ outcome=(\S+) pos=(\S+)(.*)$/
const REFUSAL = /<([A-Za-z0-9_]+)> can't (get|make) ([a-z0-9_]+)(?::| yet) ?(.*)$/
// A goal step that ended failed:<reason> (goal.js noteChoice): the NEW step
// first, then the failed one. facts= is always last on that line.
const STEPFAIL = /^goal step=(\S+) prev=(\S+) .*why=step-failed fail=(failed:\S+) .*facts=(.*)$/
// Park lines (task.js parkOrder/parkTask): the diagnosis may name a
// castlefetch-* reason — otherwise the park has no replay vehicle.
const PARK_GOAL = /^goal park kind=(\S+) progress=(\S+) why=(.*)$/
const PARK_TASK = /^task (\S+) (\S+) parked #\d+[^\n]*? why=(.*)$/
// castlefetch finish(): the leg-over line carries the fetch kind, the bare
// line only the reason. Both are park-family events (v2 body).
const CASTLE_LEGOVER = /^castlefetch (\S+): leg over \((failed:[^)]+)\)/
const CASTLE_FAILED = /^castlefetch (failed:castlefetch-\S+)/
// Voxel slice at plan fire time (task.js planState): the park's arena.
const PLAN_WORLD = /^plan world dy\+2\.\.-2 (.*)$/
// Raw `docker logs --timestamps` (timestamps=1) prefixes every line with the
// daemon time ("2026-10-19T21:44:50.123456789Z <original line>"). The bot's
// own stdout is bare (`recover action=...`, no date or bot name:
// recover.js logs with plain console.log), so after the strip a raw line is
// dated and attributed from the daemon stamp instead (vf8e.16: the vf8e.15
// night read events=0 off such a dump and each line was rewritten by hand).
const DOCKER_TS = /^(\d{4}-\d\d-\d\d)T(\d\d:\d\d:\d\d)(?:\.\d+)?(?:Z|[+-]\d\d:?\d\d)? (.*)$/
// The Portainer container-logs API passes docker's multiplexed stream
// through as is (bot2 runs without a TTY): each frame starts with an 8-byte
// header (stream id, three zero bytes, big-endian length). Real log text
// never holds NUL bytes, so the header pattern is safe to strip anywhere.
const MUX = /[\x00-\x02]\x00\x00\x00[\s\S]{4}/g
const clean = (line) => String(line).replace(/\r$/, '').replace(MUX, '')

const botSpec = (env = process.env) => env.CURRICULUM_BOTS || env.BOT2_USERNAME || 'IdkBotV2'

function botFilter(env = process.env) {
  const spec = botSpec(env)
  if (spec === 'all') return () => true
  const set = new Set(spec.split(',').map((s) => s.trim()).filter(Boolean))
  return (name) => set.has(name)
}

// The bot name for bare `docker logs --timestamps` lines: the single bot in
// the filter. A multi-name filter (or "all") cannot attribute a bare line to
// a bot, so those lines are skipped (null) — use the VictoriaLogs feed
// (which prints names) for multi-bot harvests.
const bareName = (env = process.env) => {
  const spec = botSpec(env)
  if (spec === 'all') return null
  const names = spec.split(',').map((s) => s.trim()).filter(Boolean)
  return names.length === 1 ? names[0] : null
}

// A dump line -> [day, time, name, msg] or null. Bot lines carry their own
// stamp; bare docker lines are dated and attributed from the daemon stamp.
function classify(line, bare) {
  const m = TS.exec(line)
  if (m) return [m[1], m[2], m[3], m[4]]
  const d = DOCKER_TS.exec(line)
  if (!d) return null
  const m2 = TS.exec(d[3])
  if (m2) return [m2[1], m2[2], m2[3], m2[4]]
  if (!bare) return null
  return [d[1], d[2], bare, d[3]]
}

const xyz = (s) => {
  const p = String(s).split(',').map(Number)
  return p.length === 3 && p.every(Number.isFinite) ? p : null
}
const cellOf = (p) => (p ? p.map((v) => Math.floor(v / CELL)).join(',') : '-')
const sigOf = (key) => crypto.createHash('sha1').update(key).digest('hex').slice(0, 8)
const words = (s) => String(s).replace(/\(.*?\)/g, ' ').replace(/\d{4}-\d\d-\d\dT\S*/g, ' ').replace(/[^a-z_ ]+/gi, ' ')
  .trim().split(/\s+/).filter(Boolean).join('-').slice(0, 40) || 'refused'

// The fetch kind behind a castlefetch-* reason (vf8e.11): `no-`, `craft-`
// and `smelt-` reasons name it (`castlefetch-no-stone` -> stone); the rest
// (unreachable, dig-stall, pack-full) do not — the proposal defaults those
// to stone, the mine ladder's bottleneck.
function fetchKind(reason) {
  const m = /^castlefetch-(?:no|craft|smelt)-([a-z_]+)$/.exec(String(reason || ''))
  return m ? m[1] : null
}

// Lines -> events [{family, reason, bot, at, day, pos, facts, next, chain, item}].
function parse(text, env = process.env) {
  const keep = botFilter(env)
  const bare = bareName(env)
  const swarm = env.SWARM_PREFIX || 'IdkSwarm'
  const who = (n) => (n.startsWith(swarm) ? 'swarm' : n)
  const eps = new Map()
  const out = []
  // Latest voxel slice in stream order (planState logs it at fire time, the
  // park lands later): the next park events' arena. Bot-agnostic — feeds are
  // single-bot, and a missing slice parks the candidate, never misplaces it.
  let lastSlice = null
  // Castlefetch legs log three lines for ONE failure: the leg-over (names
  // the kind), the bare `castlefetch failed:` line, and on the next tick the
  // goal step-fail. Count it once: the leg-over only stages the kind, the
  // bare line pushes the event, the step-fail is skipped. Per bot — swarm
  // folds share the feed but never the same leg.
  const legKinds = new Map()
  const page = (name, ep, reason, at, day, pos) => {
    // The facts of the last choice near the end pos (call_player's own
    // line carries none); none within a cell = no kit, not proposable.
    const f = ep.facts && ep.facts.pos && pos && Math.hypot(ep.facts.pos[0] - pos[0], ep.facts.pos[2] - pos[2]) <= CELL ? ep.facts : null
    out.push({
      family: 'page', reason: ep.fail || reason, bot: who(name), at, day, pos,
      facts: f ? f.text : null, from: f ? f.pos : null, next: f ? f.next : null, chain: ep.chain.join('>') || reason.split(':')[0],
    })
  }
  for (const raw of String(text).split('\n')) {
    const c = classify(clean(raw), bare)
    if (!c) continue
    const [day, time, name, msg] = c
    const at = Date.parse(`${day}T${time}Z`)
    const r = REFUSAL.exec(msg)
    if (r) {
      if (!keep(r[1])) continue
      out.push({ family: 'bring', reason: `${r[3]}:${words(r[4] || (r[2] === 'make' ? 'not yet' : 'refused'))}`, item: r[3], bot: who(r[1]), at, day })
      continue
    }
    // A failed goal step (vf8e.11): step-fail. A castlefetch step-fail
    // repeats the leg failure the bare line already counted (revmux 01),
    // so it is skipped, never a second event.
    const sf = STEPFAIL.exec(msg)
    if (sf) {
      if (!keep(name)) continue
      const detail = sf[3].slice('failed:'.length)
      if (sf[2] === 'castlefetch' || detail.startsWith('castlefetch-')) continue
      const tm = fact(sf[4], 'time')
      out.push({ family: 'step-fail', reason: `${sf[2]}:${detail}`, step: sf[2], detail, facts: sf[4], time: tm === 'day' || tm === 'night' ? tm : null, bot: who(name), at, day })
      continue
    }
    // A castlefetch leg that ended failed (vf8e.11): v2 park material. The
    // leg-over line only stages the fetch kind; the bare line pushes the
    // one event per failure (revmux 01).
    const lo = CASTLE_LEGOVER.exec(msg)
    if (lo) {
      if (!keep(name)) continue
      if (lo[2].startsWith('failed:')) legKinds.set(who(name), { reason: lo[2].slice('failed:'.length), kind: lo[1] })
      continue
    }
    const cf = CASTLE_FAILED.exec(msg)
    if (cf) {
      if (!keep(name)) continue
      const reason = cf[1].slice('failed:'.length)
      const staged = legKinds.get(who(name))
      legKinds.delete(who(name))
      const kind = staged && staged.reason === reason ? staged.kind : fetchKind(reason)
      out.push({ family: 'park', reason, step: 'castlefetch', fetch: kind, task: null, facts: null, slice: lastSlice, bot: who(name), at, day })
      continue
    }
    // A parked task/goal (vf8e.11): only castlefetch parks get a vehicle
    // (v2); any other diagnosis stays parked (no-vehicle).
    const pg = PARK_GOAL.exec(msg) || PARK_TASK.exec(msg)
    if (pg) {
      if (!keep(name)) continue
      const diag = pg[3]
      const m = /castlefetch-[a-z0-9-]+/.exec(diag || '')
      out.push({
        family: 'park', reason: m ? m[0] : `${pg[1]}:${words(diag || 'unknown')}`,
        step: null, fetch: m ? fetchKind(m[0]) : null, task: pg[1], facts: null, slice: lastSlice, bot: who(name), at, day,
      })
      continue
    }
    // A voxel slice for later parks (vf8e.11): kept, never an event.
    const w = PLAN_WORLD.exec(msg)
    if (w) {
      if (!keep(name)) continue
      lastSlice = w[1]
      continue
    }
    const a = RECOVER.exec(msg)
    if (!a || !keep(name)) continue
    const [, action, outcome, posText, rest] = a
    let ep = eps.get(name)
    // A first choice (facts last=none: recover.js starts every episode with
    // rec.last null) opens a new episode. The old one ended without a
    // terminal line (clearStuck on an order, a restart): a paged one still
    // counts, where it was last seen.
    if (ep && / last=none /.test(rest)) { // chosen, or an entry drop-goal (its only line)
      if (ep.paged) page(name, ep, 'call_player:cleared', ep.at, ep.day, ep.pos)
      ep = null
    }
    if (!ep) eps.set(name, (ep = { chain: [], paged: false, fail: null }))
    Object.assign(ep, { at, day, pos: xyz(posText) })
    if (outcome === 'chosen') {
      ep.chain.push(action)
      if (action === 'call_player') ep.paged = true
      const f = / facts=(.*?) feet=/.exec(rest)
      const n = / next=(-?[\d.]+,-?[\d.]+,-?[\d.]+):/.exec(rest)
      if (f) ep.facts = { text: f[1], pos: xyz(posText), next: n ? xyz(n[1]) : null }
    } else if (outcome.startsWith('failed') && action !== 'call_player' && action !== 'wait') {
      ep.fail = `${action}:${outcome}`
    } else if (outcome === 'done' || outcome === 'gave-up' || outcome === 'drop-goal') {
      eps.delete(name)
      if (ep.paged || outcome === 'gave-up') page(name, ep, `${action}:${outcome}`, at, day, ep.pos)
    }
  }
  for (const [name, ep] of eps) if (ep.paged) page(name, ep, 'call_player:cleared', ep.at, ep.day, ep.pos)
  return out
}

// survey: what the dump held for this feed, for the empty-night why-line
// (vf8e.16). Mirrors parse()'s line classification and bot filter, without
// episode logic: lines = non-blank, parsed = kept for event detection,
// recover = kept raw `recover action=` lines, refusals = kept refusal-shaped
// lines (attributed by chat name, like parse).
function survey(text, env = process.env) {
  const keep = botFilter(env)
  const bare = bareName(env)
  let lines = 0
  let parsed = 0
  let recover = 0
  let refusals = 0
  for (const raw of String(text).split('\n')) {
    const line = clean(raw)
    if (!line.trim()) continue
    lines++
    const c = classify(line, bare)
    if (!c) continue
    const [, , name, msg] = c
    const r = REFUSAL.exec(msg)
    if (r) {
      if (keep(r[1])) { parsed++; refusals++ }
      continue
    }
    if (!keep(name)) continue
    parsed++
    if (msg.includes('recover action=')) recover++
  }
  return { lines, parsed, recover, refusals }
}

// whyLine: a night with 0 signatures must say why (vf8e.16) — the per-family
// counts it saw, e.g. recover=9 page=0 bring=excluded.
function whyLine(s, events, spec) {
  const parts = []
  if (s.parsed === 0) {
    parts.push(`nothing parsed (0 of ${s.lines} lines; wrong dump or bot filter '${spec}'?)`)
  } else {
    const pages = events.filter((e) => e.family === 'page').length
    if (s.recover > 0 && pages === 0) parts.push(`recover=${s.recover} but 0 page events (no call_player/gave-up episode)`)
    else if (s.recover === 0) parts.push('no recover lines at all')
    else parts.push(`recover=${s.recover} page=${pages}`)
  }
  if (s.refusals === 0) parts.push('bring=excluded (no refusal lines kept for this feed: the mc log is out of the feed by owner rule)')
  else parts.push(`bring-refusals=${s.refusals}`)
  return parts.join('; ')
}

function rank(events, days = 7) {
  const newest = events.reduce((t, e) => Math.max(t, e.at), 0)
  const from = newest - days * 86400e3
  const by = new Map()
  for (const e of events) {
    if (!(e.at >= from)) continue
    // A stay fail's tier is its time (day = daytime idle, tier 0): day and
    // night occurrences aggregate separately, so one late fail cannot demote
    // (or promote) the other bucket with the newest event's time.
    const key = e.family === 'page' ? `page|${e.reason}|${cellOf(e.pos)}` : e.family === 'bring' ? `bring|${e.reason}` :
      e.family === 'step-fail' && e.step === 'stay' ? `step-fail|${e.reason}|${e.time || 'unknown'}` : `${e.family}|${e.reason}`
    let c = by.get(key)
    if (!c) by.set(key, (c = { sig: sigOf(key), family: e.family, reason: e.reason, cell: e.family === 'page' ? cellOf(e.pos) : '-', count: 0, bots: [] }))
    c.count++
    if (!c.bots.includes(e.bot)) c.bots.push(e.bot)
    if (!c.at || e.at >= c.at) {
      c.at = e.at
      c.lastSeen = new Date(e.at).toISOString().slice(0, 19).replace('T', ' ')
      for (const k of ['pos', 'facts', 'from', 'next', 'chain', 'item', 'step', 'detail', 'fetch', 'task', 'slice', 'time']) if (e[k] !== undefined) c[k] = e[k]
    }
  }
  const list = [...by.values()].map((c) => {
    c.score = c.count * WEIGHT[c.family]
    c.tier = tier(c)
    const p = proposal(c)
    c.proposable = !p.why
    if (p.why) c.why = p.why
    delete c.at
    return c
  })
  return list.sort((a, b) => a.tier - b.tier || b.score - a.score || (b.lastSeen > a.lastSeen ? 1 : b.lastSeen < a.lastSeen ? -1 : 0))
}

// Owner-priority tier (idkcraft-vf8e.22): 0 = what the owner cares about
// (castlefetch parks, castlefetch/mine/castle-feeding step fails, daytime
// idle = a day-time stay fail, the S4 idle+stay bucket), 2 = night/arrival
// families (shelter/gohome/stay fails), 1 = everything else.
function tier(c) {
  if (c.family === 'park' && String(c.reason || '').startsWith('castlefetch-')) return 0
  if (c.family === 'step-fail') {
    if (c.step === 'stay' && c.time === 'day') return 0
    if (OWNER_STEPS.has(c.step)) return 0
    if (NIGHT_ARRIVAL_STEPS.has(c.step)) return 2
  }
  return 1
}

const fact = (text, k) => {
  const m = new RegExp(`(?:^| )${k}=(\\S+)`).exec(text || '')
  return m ? m[1] : null
}

// --- vf8e.11: step-fail and park vehicles ---
//
// Marker tables verbatim from the corpus (bot/tools/stuck-spots.json,
// pinned by bot/test/stuck-oracle.test.js): the same lines judge AUTO
// spots, so a table edit here must move the corpus test too.
const needLogs = () => {
  try { return require('../src/budget').NEED_LOGS || 14 } catch (_) { return 14 }
}

// before hint for the skill header (skills.js: must sit after shelter — a
// higher or unknown name falls back to rest, so the night safety steps
// stay first). Only steps after shelter in STEP_ORDER keep their name.
const beforeHint = (step) => {
  try {
    const { STEP_ORDER } = require('../src/plan-consts')
    if (typeof step === 'string' && STEP_ORDER.indexOf(step) > STEP_ORDER.indexOf('shelter')) return step
  } catch (_) { /* fall through to rest */ }
  return 'rest'
}

// Order vehicles per failed goal step (vf8e.11): the step's own order text,
// but ONLY orders that leave the goal menu running (revmux 01): `build
// here` founds a site and works, so a step skill runs before the verdict;
// come-home/bring/find orders own the body past the verdict, so a skill
// could never fire — those steps read `no-order`.
const STEP_VEHICLES = {
  // the gather step of a build-here (GATHER-CLIFF, idkcraft-m7ke)
  gather: () => ({
    order: 'build here', expect: [`got ${needLogs()} logs`], fail: ['cannot reach the trees', 'no trees within 48'],
    arena: { spawn: [-20.5, 64, -247.5], goal: [-18.5, 64, -247.5], secs: 300, scaffold: 0, pickaxe: true },
  }),
  // a failed build, rebuilt (JR-BUILD, idkcraft-d7i)
  build: () => ({
    order: 'build here', expect: ['home done at '], fail: ["I can't see you"],
    arena: { spawn: [-145.5, 73, -78.5], goal: [-139.5, 73, -72.5], secs: 420, scaffold: 64, pickaxe: true, kit: ['acacia_planks 107', 'crafting_table 1', 'acacia_door 1'] },
  }),
}

// Voxel codes (stall-state.js LEGEND) -> prep block. '?' (prod-unloaded) is
// skipped: the rig leaves prod-unknown cells alone. Bed/door ride as solid
// stand-ins (a fill cannot place their two-cell shapes).
const SLICE_CODES = {
  a: 'air', s: 'stone', g: 'sand', w: 'water', l: 'lava', b: 'oak_planks',
  d: 'oak_planks', c: 'chest', o: 'coal_ore', x: 'dirt', '@': 'air',
}
const PREP_MAX = 32 // loadSpots prep cap

// The logged slice -> fill runs around base. Throws Error('bad slice: ...')
// on a malformed slice, Error('prep too big: ...') past the prep cap.
function sliceToPrep(world, base) {
  const layers = String(world || '').split(' | ')
  if (layers.length !== 5) throw new Error(`bad slice: want 5 layers, got ${layers.length}`)
  const runs = [] // [x1,x2,y,z1?,...] built per row, merged below
  layers.forEach((layer, li) => {
    const m = /^dy([+-]?\d+): ([a-z@?/]+)$/.exec(layer.trim())
    if (!m || Number(m[1]) !== 2 - li) throw new Error(`bad slice: layer ${li} wants dy${2 - li >= 0 ? '+' : ''}${2 - li}`)
    const rows = m[2].split('/')
    if (rows.length !== 7) throw new Error(`bad slice: layer ${li} wants 7 rows, got ${rows.length}`)
    const y = base[1] + (2 - li)
    rows.forEach((row, zi) => {
      if (row.length !== 7 || /[^aswlgbdcox@?]/.test(row)) throw new Error(`bad slice: bad row ${JSON.stringify(row)}`)
      let start = -1
      for (let xi = 0; xi <= 7; xi++) {
        const code = xi < 7 ? row[xi] : null
        const block = code === '?' ? null : SLICE_CODES[code]
        if (code !== null && code !== '?' && !block) throw new Error(`bad slice: unknown code ${JSON.stringify(code)}`)
        const cur = xi < 7 && block ? block : null
        const prev = start >= 0 ? SLICE_CODES[row[start]] : null
        if (cur !== prev) {
          if (start >= 0 && prev) runs.push({ x1: base[0] + start - 3, x2: base[0] + xi - 1 - 3, y, z: base[2] + zi - 3, block: prev })
          start = cur ? xi : -1
        }
      }
    })
  })
  // Merge across z (rows), then y (layers): same x-span + block. Runs
  // arrive in y,z order, so consecutive same-span rows merge; the second
  // pass merges the boxes across y the same way (the z-span rides the key,
  // so only identical boxes merge).
  const zMerged = []
  {
    const open = new Map() // key(x1,x2,y,block) -> box
    for (const r of runs) {
      const prev = open.get(`${r.x1},${r.x2},${r.y},${r.block}`)
      if (prev && r.z === prev.z2 + 1) prev.z2 = r.z
      else {
        const box = { ...r, z1: r.z, z2: r.z }
        open.set(`${r.x1},${r.x2},${r.y},${r.block}`, box)
        zMerged.push(box)
      }
    }
  }
  const merged = []
  {
    // Layers arrive top-down (dy+2 first), so a lower layer extends y1.
    const open = new Map() // key(x1,x2,z1,z2,block) -> box
    for (const b of zMerged) {
      const prev = open.get(`${b.x1},${b.x2},${b.z1},${b.z2},${b.block}`)
      if (prev && b.y === prev.y1 - 1) prev.y1 = b.y
      else {
        const box = { ...b, y1: b.y, y2: b.y }
        open.set(`${b.x1},${b.x2},${b.z1},${b.z2},${b.block}`, box)
        merged.push(box)
      }
    }
  }
  if (merged.length > PREP_MAX) throw new Error(`prep too big: ${merged.length} fills past the ${PREP_MAX} cap`)
  return merged.map((r) => `fill ${r.x1} ${r.y1} ${r.z1} ${r.x2} ${r.y2} ${r.z2} ${r.block}`)
}

// A step-fail candidate -> order-mode spot (vf8e.11) or {why}. Terminal
// markers only: the corpus tables judge delivery lines, never chatter.
function proposeStepFail(c, name, base) {
  const bead = { ...base, bead: BEAD11 }
  const hint = beforeHint(c.step)
  const head = `In prod the ${c.step} step failed ${c.count}x (last ${c.lastSeen} UTC, bots ${c.bots.join(',')}): failed:${c.detail}. Facts at the failure: ${c.facts}.`
  if (c.step === 'shelter') {
    // Night dig-in (krup facade digIn, the hand maneuver): the shelter arena
    // (SPAWN-BARE, idkcraft-ed88) — the only corpus spot with a dig-in
    // verdict. No markers: shelter judges enclosed, not chat.
    return {
      spot: {
        name, mode: 'shelter', spawn: [-57.5, 61, -213.5], goal: [-57.5, 90, -63.5], home: [243, 64, -214],
        secs: 90, closeSecs: 25, scaffold: 0, pickaxe: false, bead: BEAD11,
      },
      scenario: {
        ...bead, kind: 'step',
        task: `${head} The bot stands on open ground at night, its home built but far away, carrying nothing to dig in with. ` +
          `Write a goal step skill that calls digIn() every tick until it answers 'done', then holds still inside until dawn. ` +
          `Set the skill header 'before' to '${hint}' (it must sit after shelter).`,
      },
    }
  }
  const v = STEP_VEHICLES[c.step] && STEP_VEHICLES[c.step]()
  if (!v) return { why: 'no-order' }
  return {
    spot: {
      name, mode: 'order', spawn: v.arena.spawn, goal: v.arena.goal, order: v.order,
      expect: v.expect, fail: v.fail, secs: v.arena.secs, scaffold: v.arena.scaffold,
      pickaxe: v.arena.pickaxe, ...(v.arena.kit ? { kit: v.arena.kit } : {}),
      ...(v.arena.house ? { house: v.arena.house } : {}), bead: BEAD11,
    },
    scenario: {
      ...bead, kind: 'step',
      task: `${head} The bot gets the order '${v.order}' here on the corpus arena with the standard kit. ` +
        `Write a goal step skill that finishes the order so it ends '${v.expect[0]}', not a fail marker. ` +
        `Set the skill header 'before' to '${hint}' (it must sit after shelter).`,
    },
  }
}

// A park candidate (vf8e.11, unreachable verdict path 0l0m, parked sggu): parks whose
// diagnosis names no castlefetch-* read `no-vehicle` (no replay vehicle).
// Castlefetch legs other than unreachable read `no-verdict` (revmux 02: no
// in-window outcome judges them — `castle done at ` takes hours, the leg
// lines are console while the order gate reads chat, L1/L2 need 15/45
// min). The unreachable leg reads `red-parked`: judging `build castle`
// by `castle done at ` inside secs:300 is RED on every run (a whole castle
// takes hours), so no skill could ever read GREEN and the paid loop would
// burn to its 3-RED park. It stays parked for a human look instead —
// honestly, without spending a rig run. (No sliceToPrep call here, so a
// bad slice or a PREP_MAX-cap overflow can no longer propose a silent bare
// flat: sliceToPrep still throws, and stays exported + tested for a future
// short-castle vehicle.)
function proposePark(c) {
  if (!String(c.reason || '').startsWith('castlefetch-')) return { why: 'no-vehicle' }
  if (c.reason !== 'castlefetch-unreachable') return { why: 'no-verdict' }
  return { why: 'red-parked' }
}

// candidate -> {spot, scenario} or {why}.
function proposal(c) {
  const name = `AUTO-${c.sig}`
  const base = { name: `auto-${c.sig}`, spot: name, sabotage: null, skill: `gen_${c.sig}`, bead: BEAD }
  if (c.family === 'step-fail') return proposeStepFail(c, name, base)
  if (c.family === 'park') return proposePark(c)
  if (c.family === 'bring') {
    const order = `bring me ${c.item}`
    return {
      spot: {
        name, mode: 'order', spawn: BRING_SPAWN, goal: BRING_GOAL, order,
        expect: ['here is ', 'here are '], fail: ["can't get ", "can't make ", 'could not ', 'unknown item', "can't bring "],
        secs: 300, scaffold: 64, pickaxe: true, bead: BEAD,
      },
      scenario: {
        ...base, kind: 'step',
        task: `In prod the owner ordered '${order}' and the bot refused ${c.count}x (last ${c.lastSeen} UTC, bots ${c.bots.join(',')}): ` +
          `${c.reason.slice(c.item.length + 1)}. The bot gets the same order here with the standard kit (stone pickaxe, 64 dirt) and no ` +
          `recipe path to ${c.item}. Write a goal step skill that obtains ${c.item} and hands it to the player, so the order ends 'here is', not a refusal.`,
      },
    }
  }
  if (!c.facts || !c.pos) return { why: 'no-facts' }
  const dy = GOAL_DY[fact(c.facts, 'goal')]
  if (dy === undefined) return { why: 'no-goal' }
  const d = Number(fact(c.facts, 'dist'))
  const dist = Math.min(MAX_DIST, Number.isFinite(d) && d > 0 ? d : CELL)
  const from = c.from || c.pos
  const vx = c.next ? c.next[0] - from[0] : 0
  const vz = c.next ? c.next[2] - from[2] : 0
  const len = Math.hypot(vx, vz)
  // next within half a block = no heading: only a climb/drop goal is honest.
  const [ux, uz] = len >= 0.5 ? [vx / len, vz / len] : [0, 0]
  if (ux === 0 && uz === 0 && dy === 0) return { why: 'no-dir' }
  const goal = [Math.round(c.pos[0] + ux * dist), Math.floor(c.pos[1]) + dy, Math.round(c.pos[2] + uz * dist)]
  const scaffold = Number(fact(c.facts, 'scaffold'))
  return {
    spot: {
      name, spawn: c.pos, goal, secs: 90,
      scaffold: Number.isFinite(scaffold) ? Math.min(2304, Math.max(0, scaffold)) : 0,
      pickaxe: fact(c.facts, 'pickaxe') === 'yes', bucket: fact(c.facts, 'bucket') === 'yes', bead: BEAD,
    },
    scenario: {
      ...base, kind: 'recover',
      task: `In prod the bot paged the owner ${c.count}x here (last ${c.lastSeen} UTC, bots ${c.bots.join(',')}): recover chain ` +
        `${c.chain} ended ${c.reason}. Facts at the last choice: ${c.facts}. Write a recover skill that gets the bot to the goal without paging.`,
    },
  }
}

const GATE = 'gate: micro-run the spot once WITHOUT a skill (vf8e.10 runner); it must be RED (unreached / page / refusal) ' +
  'or the candidate is not-reproduced and no model tokens are spent (stale terrain, mobs, protected blocks, a player)'

// --- Nightly runner support (idkcraft-vf8e.10, tools/curriculum.sh) ---
// Ledger: <CURRICULUM_DIR>/curriculum-ledger.json (work root, never in git):
// sig -> {date, verdict, attempts, cost, skillPath, resultJson, count, reds}.
// count = harvest count at record time (the 7-day retry compares growth);
// reds = lifetime RED runs (3 parks the signature for a human look).
const LEDGER = () => path.join(DIR(), 'curriculum-ledger.json')
const today = () => new Date().toISOString().slice(0, 10)
const ageDays = (date) => (Date.parse(`${today()}T00:00:00Z`) - Date.parse(`${date}T00:00:00Z`)) / 86400e3
const RETRY_DAYS = 7
const MAX_REDS = 3

function readLedger() {
  try {
    const l = JSON.parse(fs.readFileSync(LEDGER(), 'utf8'))
    return l && typeof l === 'object' && !Array.isArray(l) ? l : {}
  } catch (_) { return {} }
}

// Top-k pick: proposable signatures not in the ledger, or RED older than 7
// days with a grown count (Voyager's failed-list retry). Prints
// `pick <sig>` lines plus `skip <sig> <reason>` for the runner's log.
function pick(top = 2) {
  let file = path.join(DIR(), 'curriculum.json')
  let list
  try { list = JSON.parse(fs.readFileSync(file, 'utf8')) } catch (_) { console.log(`no ${file}: run harvest first`); return 2 }
  if (!Array.isArray(list)) { console.log(`${file}: not a list`); return 2 }
  const ledger = readLedger()
  const out = []
  for (const c of list) {
    if (out.filter((l) => l.startsWith('pick ')).length >= top) break
    if (!c || !c.proposable || !c.sig) continue
    const e = ledger[c.sig]
    if (!e) { out.push(`pick ${c.sig}`); continue }
    if (String(e.verdict || '').toUpperCase().startsWith('GREEN')) { out.push(`skip ${c.sig} done`); continue }
    if ((e.reds || 0) >= MAX_REDS || (e.envs || 0) >= MAX_REDS) { out.push(`skip ${c.sig} parked`); continue }
    // env never reached a verdict: the candidate was never really tried,
    // so it is picked again right away (its strike count parks it above).
    if (String(e.verdict || '').toUpperCase() === 'ENV') { out.push(`pick ${c.sig}`); continue }
    if (String(e.verdict || '').toUpperCase().startsWith('RED')) {
      if (ageDays(e.date) > RETRY_DAYS && c.count > (e.count || 0)) { out.push(`pick ${c.sig}`); continue }
      out.push(`skip ${c.sig} ${ageDays(e.date) > RETRY_DAYS ? 'red-stale' : 'red-recent'}`)
      continue
    }
    out.push(`skip ${c.sig} ${String(e.verdict || 'unknown').toLowerCase()}`)
  }
  console.log(out.join('\n'))
  return 0
}

// record <sig> <verdict> [result.json] [skillPath]: verdict is RED,
// GREEN:unpromoted, not-reproduced or env; attempts/cost come from the
// loop's result.json (the PRICE table there — never re-estimated), 0
// without one. env (revmux 01 core-1) is a loop exit 2 AFTER paid attempts:
// never RED and reds is not bumped, but the real dollars reach the ledger
// or the $ cap goes blind. body defaults to the run's REPLAY_BODY.
function record(sig, verdict, resultFile, skillPath) {
  if (!sig || !['RED', 'GREEN:unpromoted', 'not-reproduced', 'env'].includes(verdict)) {
    console.log('usage: node tools/curriculum.js record <sig> <RED|GREEN:unpromoted|not-reproduced|env> [result.json] [skill.js]')
    return 2
  }
  let list = []
  try { list = JSON.parse(fs.readFileSync(path.join(DIR(), 'curriculum.json'), 'utf8')) } catch (_) { /* count unknown */ }
  const c = Array.isArray(list) ? list.find((x) => x && x.sig === sig) : null
  let attempts = 0
  let cost = 0
  if (resultFile) {
    try {
      const r = JSON.parse(fs.readFileSync(resultFile, 'utf8'))
      attempts = r.attempts || 0
      cost = Number(r.cost) || 0
    } catch (e) { console.log(`no result at ${resultFile}: ${String((e && e.message) || e).slice(0, 120)}`); return 2 }
  }
  const ledger = readLedger()
  const prev = ledger[sig] || {}
  // Same-day re-record (an env entry retried tonight, or two runs in one
  // UTC day): add, don't overwrite, or the earlier spend hides from the $
  // cap (revmux 02 core-1). The entry then totals today for the signature;
  // each run's own cost stays on its CURRICULUM line.
  const sameDay = prev.date === today()
  ledger[sig] = {
    date: today(), verdict,
    attempts: attempts + (sameDay ? prev.attempts || 0 : 0),
    cost: cost + (sameDay ? prev.cost || 0 : 0),
    skillPath: skillPath || prev.skillPath || null,
    resultJson: resultFile || prev.resultJson || null,
    count: c ? c.count : (prev.count || 0),
    reds: (prev.reds || 0) + (verdict === 'RED' ? 1 : 0),
    envs: (prev.envs || 0) + (verdict === 'env' ? 1 : 0),
    body: process.env.REPLAY_BODY || prev.body || 'mineflayer',
  }
  fs.mkdirSync(DIR(), { recursive: true })
  fs.writeFileSync(LEDGER(), JSON.stringify(ledger, null, 1) + '\n')
  console.log(`ledger ${sig}: ${verdict} attempts=${attempts} cost=$${cost.toFixed(2)} reds=${ledger[sig].reds}`)
  return 0
}

// spent: today's ledger USD sum (the CURRICULUM_USD_PER_DAY cap compares it
// before STARTING each scenario). Prints a number with 2 decimals.
function spent() {
  const ledger = readLedger()
  const t = today()
  const sum = Object.values(ledger).reduce((a, e) => a + (e && e.date === t ? Number(e.cost) || 0 : 0), 0)
  console.log(sum.toFixed(2))
  return 0
}

// Setup-failure notes (findings-1 b): the arena was never tested (the guide
// was buried or died), so the row is not a verdict on the spot. Kept equal
// to stuck-replay.js ENV_NOTES by the runner tests — never RED, never a
// paid loop.
const ENV_FAIL_NOTES = new Set(['GUIDE-BURIED', 'GUIDE-DIED'])

// gate <replay.json>: the reproduction gate — the no-skill micro-run must be
// RED (unreached, or a page/refusal: calls > 0) or the candidate is
// not-reproduced. Exit 0 = RED, 1 = not RED, 2 = unreadable or setup failure.
function gate(file) {
  let rows
  try { rows = JSON.parse(fs.readFileSync(file, 'utf8')) } catch (e) {
    console.log(`gate: no replay rows at ${file}: ${String((e && e.message) || e).slice(0, 120)}`)
    return 2
  }
  const row = Array.isArray(rows) ? rows[0] : null
  if (!row) { console.log(`gate: no replay rows at ${file}`); return 2 }
  if (ENV_FAIL_NOTES.has(row.note)) { console.log(`gate: ${row.spot} ${row.note} (setup failed, not judged) -> ENV`); return 2 }
  const red = row.reached !== true || row.call !== 0
  console.log(`gate: ${row.spot} reached=${row.reached} calls=${row.call} -> ${red ? 'RED' : 'NOT-RED'}`)
  return red ? 0 : 1
}

function table(list, top = 20) {
  const rows = [['#', 'sig', 'family', 'count', 'score', 'bots', 'lastSeen', 'cell', 'propose', 'reason']]
  list.slice(0, top).forEach((c, i) => rows.push([i + 1, c.sig, c.family, c.count, c.score, c.bots.join(','), c.lastSeen, c.cell, c.proposable ? 'yes' : c.why, c.reason]))
  const w = rows[0].map((_, j) => Math.max(...rows.map((r) => String(r[j]).length)))
  return rows.map((r) => r.map((v, j) => String(v).padEnd(w[j])).join('  ').trimEnd()).join('\n')
}

function main(argv) {
  const [cmd, arg] = argv
  const dir = DIR()
  if (cmd === 'harvest' && arg) {
    // harvest <dump...> [days]: bot + mc dumps may come as separate files.
    const files = argv.slice(1)
    const days = /^\d+(\.\d+)?$/.test(files[files.length - 1]) && files.length > 1 ? Number(files.pop()) : 7
    if (!(days > 0)) { console.log('days must be > 0'); return 2 }
    const text = files.map((f) => fs.readFileSync(f, 'utf8')).join('\n')
    const events = parse(text)
    const list = rank(events, days)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'curriculum.json'), JSON.stringify(list, null, 1) + '\n')
    console.log(table(list, Number(process.env.TOP || 20)))
    const fam = (f) => list.filter((c) => c.family === f)
    const s = survey(text)
    console.log(`harvest events=${events.length} signatures=${list.length} page=${fam('page').length} bring=${fam('bring').length} stepfail=${fam('step-fail').length} park=${fam('park').length} ` +
      `proposable=${list.filter((c) => c.proposable).length} days=${days} parsed=${s.parsed}/${s.lines} recover=${s.recover} refusals=${s.refusals} -> ${path.join(dir, 'curriculum.json')}`)
    if (list.length === 0) console.log(`harvest why: ${whyLine(s, events, botSpec())}`)
    return 0
  }
  if (cmd === 'propose' && arg) {
    const file = path.join(dir, 'curriculum.json')
    if (!fs.existsSync(file)) { console.log(`no ${file}: run harvest first`); return 2 }
    const c = JSON.parse(fs.readFileSync(file, 'utf8')).find((x) => x.sig === arg)
    if (!c) { console.log(`sig ${arg} not in ${file}`); return 2 }
    const p = proposal(c)
    if (p.why) { console.log(`not proposable: ${p.why}`); return 1 }
    const work = path.join(dir, p.spot.name)
    fs.mkdirSync(work, { recursive: true })
    fs.writeFileSync(path.join(work, 'spots.json'), JSON.stringify([p.spot], null, 1) + '\n')
    fs.writeFileSync(path.join(work, 'scenario.json'), JSON.stringify([p.scenario], null, 1) + '\n')
    console.log(`proposed ${p.spot.name} (${c.family} ${c.reason}) -> ${work}/spots.json + scenario.json`)
    console.log(GATE)
    return 0
  }
  if (cmd === 'pick') return pick(Number(arg || 2) >= 1 ? Number(arg || 2) : 2)
  if (cmd === 'record') return record(argv[1], argv[2], argv[3], argv[4])
  if (cmd === 'spent') return spent()
  if (cmd === 'gate') return gate(arg)
  console.log('usage: node tools/curriculum.js harvest <dump.txt...> [days=7] | propose <sig> | pick [k=2] | record <sig> <verdict> [result.json] [skill.js] | spent | gate <replay.json>')
  return 2
}

if (require.main === module) process.exitCode = main(process.argv.slice(2))

module.exports = { parse, rank, tier, proposal, table, main, WEIGHT, OWNER_STEPS, NIGHT_ARRIVAL_STEPS, pick, record, spent, gate, readLedger, ENV_FAIL_NOTES, survey, whyLine, sliceToPrep, fetchKind, beforeHint, STEP_VEHICLES }
