'use strict'

// Prod scoreboard (idkcraft-qxql.6): S1-S9 of the idkcraft-qxql epic from a
// pulled bot2 log. Usage: node bot/tools/prod-score.js <log.txt> [--day]
// Input: one line per log message, 'YYYY-MM-DD HH:MM:SS <msg>' (the
// idkcraft-session-review recipe output). Reuses castle-replay classify().
// Prints one block per UTC day (--day) or one for the whole file. No baseline,
// no verdict: the reviewer compares before vs after.

process.env.CASTLE_LOG = process.env.CASTLE_LOG || '/dev/null' // castle-replay opens its log stream on require
const fs = require('node:fs')
const { classify, seen, resetSeen } = require('./castle-replay')

const HOUSE = new Set(['gather', 'craft', 'build', 'beds', 'light', 'stockpile'])
const FLAT_MS = 10 * 60 * 1000
const LINE = /^(\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d)\s+(.*)$/

const top = (o, n) => Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => `${k}:${v}`).join(',') || 'none'
const pct = (n, t) => (t ? Math.round((n / t) * 100) : 0)

function scoreBlock(label, rows, carryN, lastN) {
  resetSeen()
  const a = { placed: [], ticks: [], share: {}, active: false, legs: 0, stone: 0, blocks: 0, wall: 0, dead: 0, fin: 0, skillRun: 0, skillBan: 0, dig: 0, walk: 0, stall: 0, miss: 0, slow: 0, deaths: 0 }
  if (carryN != null) a.placed.push({ at: rows[0].at, n: carryN }) // a day without a change prints no castle line
  for (const { at, msg } of rows) {
    if (msg.startsWith('spawned as ')) seen.leg = null // v2 restart: an open leg died with the process
    if (msg.startsWith('goal step=')) a.active = / castle=(?!parked\b|done\b)\S+/.test(msg)
    // classify() only tracks stone legs; every kind is a leg for the scoreboard
    const k = /^castlefetch (\S+): (need \d+ more|leg over \()/.exec(msg)
    const cm = /^castle (\d+)\/(\d+)$/.exec(msg)
    if (cm) {
      a.placed.push({ at, n: +cm[1] })
      a.active = +cm[1] < +cm[2]
    }
    const d = /^decision source=\S+ action=(\S+)/.exec(msg)
    if (d) {
      a.ticks.push({ at, step: d[1] })
      if (a.active) {
        const s = d[1] === 'castle' || d[1] === 'castlefetch' ? d[1] : HOUSE.has(d[1]) ? 'house' : d[1] === 'idle' || d[1] === 'stay' ? 'idle+stay' : 'other'
        a.share[s] = (a.share[s] || 0) + 1
      }
    }
    if (k) {
      if (k[2].startsWith('need')) a.legs++
      const lo = /^castlefetch \S+: leg over \(.*\) ticks dig=(\d+) walk=(\d+).* blocks=(\S+) .*wall=(\d+)s/.exec(msg)
      if (lo) {
        if (k[2] === 'leg over (' && /\(done\)/.test(msg)) a.fin++
        a.dig += +lo[1]
        a.walk += +lo[2]
        const gain = /^\+[1-9]\d*$/.test(lo[3])
        if (!gain) a.dead++ // dead leg: no stock gained
        if (k[1] === 'stone') { a.wall += +lo[4]; if (gain) a.blocks += +lo[3] } // dead legs cost wall time too
      }
      classify(msg.replace(/^castlefetch \S+:/, 'castlefetch stone:'), at)
    } else classify(msg, at)
    if (msg.startsWith('build-stall ')) a.stall++
    else if (msg.startsWith('castle blocked ')) a.miss++
    else if (msg.startsWith('dig slow ')) a.slow++
    else if (msg.startsWith('skill run ')) a.skillRun++
    else if (/^skill \S+ banned /.test(msg)) a.skillBan++
    else if (msg.startsWith('death health=')) a.deaths++
  }
  const t = rows.length ? rows[rows.length - 1].at - rows[0].at : 0
  const ns = a.placed.map((p) => p.n)
  if (ns.length) lastN.n = ns[ns.length - 1]
  const min = ns.length ? Math.min(...ns) : '-'
  const max = ns.length ? Math.max(...ns) : '-'
  // flat: equal-n castle lines spanning >= 10 min; dominant decision step inside the longest
  let flat = 0
  let longest = null
  for (let i = 0; i < a.placed.length;) {
    let j = i
    while (j + 1 < a.placed.length && a.placed[j + 1].n === a.placed[i].n) j++
    // castle n/total prints only on change: the last run lasts to the window end
    const end = j + 1 < a.placed.length ? a.placed[j + 1].at : rows[rows.length - 1].at
    const span = end - a.placed[i].at
    if (span >= FLAT_MS) {
      flat++
      if (!longest || span > longest.span) longest = { span, from: a.placed[i].at, end }
    }
    i = j + 1
  }
  let lstr = '-'
  if (longest) {
    const c = {}
    for (const x of a.ticks) if (x.at >= longest.from && x.at <= longest.end) c[x.step] = (c[x.step] || 0) + 1
    lstr = `${Math.round(longest.span / 60000)}@${top(c, 1).split(':')[0]}`
  }
  const tot = Object.values(a.share).reduce((x, y) => x + y, 0)
  const sh = (s) => `${s}:${pct(a.share[s] || 0, tot)}`
  const fin = a.fin
  const cuts = {}
  for (const e of seen.fetchEv) if (e.ev === 'cut') cuts[e.by] = (cuts[e.by] || 0) + 1
  const per = a.blocks > 0 ? (a.wall / a.blocks).toFixed(1) : '-'
  return [
    `== ${label}`,
    `placed=${min}->${max} (+${ns.length ? max - min : 0})`,
    `share=${sh('castle')},${sh('castlefetch')},${sh('house')},${sh('idle+stay')},${sh('other')}`,
    `fetch: legs=${a.legs} finished=${fin} cut-by=${top(cuts, 4)} stone=+${a.blocks} ${per} s/stone`,
    `walk/dig=${a.dig ? (a.walk / a.dig).toFixed(2) : '-'} dead=${a.dead} top-fail=${top(seen.fails, 3)} flat=${flat} longest=${lstr}`,
    `holes: build-stall=${a.stall} build-miss=${a.miss} dig-slow/h=${t ? (a.slow / (t / 3600000)).toFixed(1) : '-'} skills=${a.skillRun}/${a.skillBan}`,
    `deaths=${a.deaths}`,
  ].join('\n')
}

function score(text, { day = false } = {}) {
  const groups = new Map()
  for (const raw of text.split('\n')) {
    const m = LINE.exec(raw)
    if (!m) continue
    const key = day ? m[1] : 'all'
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push({ at: Date.parse(`${m[1]}T${m[2]}Z`), msg: m[3] })
  }
  let carry = null
  return [...groups].map(([k, rows]) => {
    const lastN = {}
    const out = scoreBlock(k, rows, carry, lastN)
    carry = lastN.n != null ? lastN.n : carry // the last printed n (a regress lowers it)
    return out
  }).join('\n')
}

if (require.main === module) {
  const file = process.argv.slice(2).find((x) => !x.startsWith('--'))
  if (!file) { console.error('usage: node bot/tools/prod-score.js <log.txt> [--day]'); process.exit(2) }
  console.log(score(fs.readFileSync(file, 'utf8'), { day: process.argv.includes('--day') }))
}

module.exports = { score }
