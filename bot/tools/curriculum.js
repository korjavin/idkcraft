'use strict'

// Automatic curriculum (idkcraft-vf8e.9): prod's failure log, ranked by
// owner-visible cost, is "what to learn next". Offline: reads a dump file,
// no host, token or container id in here (README "Curriculum").
//
//   node tools/curriculum.js harvest <dump.txt...> [days=7]
//   node tools/curriculum.js propose <sig>
//
// Dump lines start "YYYY-MM-DD HH:MM:SS <name> <msg>" (UTC), like deaths.sh.
// Families (owner 2026-10-19: the simplest first):
//   page  — a recover episode (recover.js logRecover lines) that chose
//           call_player or ended gave-up. Signature = last failed hand
//           primitive + its outcome + the end pos in an 8-block cell.
//   bring — a bring order refused for a recipe gap: the bot's own chat
//           "<Bot> can't get <item>: no recipe, no source" / "<Bot> can't
//           make <item>: need …|no recipe|crafting failed" from the mc log
//           (the bot never logs its chat). Signature = item + reason words.
// Rank = count x weight (page 3, bring 2). Bots: CURRICULUM_BOTS = comma
// list or "all" (default BOT2_USERNAME, else IdkBotV2 — the owner's feed);
// SWARM_PREFIX names fold into one "swarm" bot like deaths.sh. days counts
// back from the newest timestamp in the dump, so a re-run is deterministic.
// Out: <CURRICULUM_DIR, default /tmp/idkcraft-curriculum>/curriculum.json
// plus a table; propose writes <dir>/AUTO-<sig>/{spots.json,scenario.json}.
// ponytail: step-fail / park / castlefetch-* families are vf8e.11; the
// signature is an 8-hex sha1 so spot and skill names are always valid.

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

const WEIGHT = { page: 3, bring: 2 }
const CELL = 8
const DIR = () => process.env.CURRICULUM_DIR || '/tmp/idkcraft-curriculum'
const BEAD = 'idkcraft-vf8e.9'
// Order arena for bring proposals: the vf8e.6 order spots' shaft-side flat.
const BRING_SPAWN = [59.5, 64, -205.5]
const BRING_GOAL = [62.5, 64, -205.5]
const GOAL_DY = { high: 3, low: -3, level: 0 }
const MAX_DIST = 16 // ponytail: a 123-block page goal is not a 90 s micro-run; raise with the arena

const TS = /^(\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d)\S* (\S+) (.*)$/
const RECOVER = /recover action=(\S+) source=\S+ outcome=(\S+) pos=(\S+)(.*)$/
const REFUSAL = /<([A-Za-z0-9_]+)> can't (get|make) ([a-z0-9_]+)(?::| yet) ?(.*)$/

function botFilter(env = process.env) {
  const spec = env.CURRICULUM_BOTS || env.BOT2_USERNAME || 'IdkBotV2'
  if (spec === 'all') return () => true
  const set = new Set(spec.split(',').map((s) => s.trim()).filter(Boolean))
  return (name) => set.has(name)
}

const xyz = (s) => {
  const p = String(s).split(',').map(Number)
  return p.length === 3 && p.every(Number.isFinite) ? p : null
}
const cellOf = (p) => (p ? p.map((v) => Math.floor(v / CELL)).join(',') : '-')
const sigOf = (key) => crypto.createHash('sha1').update(key).digest('hex').slice(0, 8)
const words = (s) => String(s).replace(/\(.*?\)/g, ' ').replace(/\d{4}-\d\d-\d\dT\S*/g, ' ').replace(/[^a-z_ ]+/gi, ' ')
  .trim().split(/\s+/).filter(Boolean).join('-').slice(0, 40) || 'refused'

// Lines -> events [{family, reason, bot, at, day, pos, facts, next, chain, item}].
function parse(text, env = process.env) {
  const keep = botFilter(env)
  const swarm = env.SWARM_PREFIX || 'IdkSwarm'
  const who = (n) => (n.startsWith(swarm) ? 'swarm' : n)
  const eps = new Map()
  const out = []
  const page = (name, ep, reason, at, day, pos) => {
    // The facts of the last choice near the end pos (call_player's own
    // line carries none); none within a cell = no kit, not proposable.
    const f = ep.facts && ep.facts.pos && pos && Math.hypot(ep.facts.pos[0] - pos[0], ep.facts.pos[2] - pos[2]) <= CELL ? ep.facts : null
    out.push({
      family: 'page', reason: ep.fail || reason, bot: who(name), at, day, pos,
      facts: f ? f.text : null, from: f ? f.pos : null, next: f ? f.next : null, chain: ep.chain.join('>') || reason.split(':')[0],
    })
  }
  for (const line of String(text).split('\n')) {
    const m = TS.exec(line)
    if (!m) continue
    const [, day, time, name, msg] = m
    const at = Date.parse(`${day}T${time}Z`)
    const r = REFUSAL.exec(msg)
    if (r) {
      if (!keep(r[1])) continue
      out.push({ family: 'bring', reason: `${r[3]}:${words(r[4] || (r[2] === 'make' ? 'not yet' : 'refused'))}`, item: r[3], bot: who(r[1]), at, day })
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

function rank(events, days = 7) {
  const newest = events.reduce((t, e) => Math.max(t, e.at), 0)
  const from = newest - days * 86400e3
  const by = new Map()
  for (const e of events) {
    if (!(e.at >= from)) continue
    const key = e.family === 'page' ? `page|${e.reason}|${cellOf(e.pos)}` : `bring|${e.reason}`
    let c = by.get(key)
    if (!c) by.set(key, (c = { sig: sigOf(key), family: e.family, reason: e.reason, cell: e.family === 'page' ? cellOf(e.pos) : '-', count: 0, bots: [] }))
    c.count++
    if (!c.bots.includes(e.bot)) c.bots.push(e.bot)
    if (!c.at || e.at >= c.at) {
      c.at = e.at
      c.lastSeen = new Date(e.at).toISOString().slice(0, 19).replace('T', ' ')
      for (const k of ['pos', 'facts', 'from', 'next', 'chain', 'item']) if (e[k] !== undefined) c[k] = e[k]
    }
  }
  const list = [...by.values()].map((c) => {
    c.score = c.count * WEIGHT[c.family]
    const p = proposal(c)
    c.proposable = !p.why
    if (p.why) c.why = p.why
    delete c.at
    return c
  })
  return list.sort((a, b) => b.score - a.score || (b.lastSeen > a.lastSeen ? 1 : b.lastSeen < a.lastSeen ? -1 : 0))
}

const fact = (text, k) => {
  const m = new RegExp(`(?:^| )${k}=(\\S+)`).exec(text || '')
  return m ? m[1] : null
}

// candidate -> {spot, scenario} or {why}.
function proposal(c) {
  const name = `AUTO-${c.sig}`
  const base = { name: `auto-${c.sig}`, spot: name, sabotage: null, skill: `gen_${c.sig}`, bead: BEAD }
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
    const events = parse(files.map((f) => fs.readFileSync(f, 'utf8')).join('\n'))
    const list = rank(events, days)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'curriculum.json'), JSON.stringify(list, null, 1) + '\n')
    console.log(table(list, Number(process.env.TOP || 20)))
    const fam = (f) => list.filter((c) => c.family === f)
    console.log(`harvest events=${events.length} signatures=${list.length} page=${fam('page').length} bring=${fam('bring').length} ` +
      `proposable=${list.filter((c) => c.proposable).length} days=${days} -> ${path.join(dir, 'curriculum.json')}`)
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
  console.log('usage: node tools/curriculum.js harvest <dump.txt...> [days=7] | propose <sig>')
  return 2
}

if (require.main === module) process.exitCode = main(process.argv.slice(2))

module.exports = { parse, rank, proposal, table, main, WEIGHT }
