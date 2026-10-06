'use strict'
// Goal-steps stand: replay goal arbiter states against a System-1 endpoint
// (laya or JEV) through the REAL prod path (shipped menu, criteria,
// instructions and FSM), scoring label validity + FSM agreement. Model for
// atl.2 criteria (one deciding fact per key).
// vmzq.7: fixture mode replays the 10-05 jev-disagreement shapes + 4 stall
// situations (bot/test/fixtures/goal-context-eval.json) under the shipped /
// +goal / +context / +menu+park variants, posting raw (like stand-iwb) so
// probabilities + confidence are recorded per answer; ask() cannot return
// them. Fixture mode asks every multi-option row (planner eval): the
// night-rule and shapeGoalMenu shaping of chooseStep are NOT applied.
// Usage: node stand-steps.js [laya|jev] [variant] [reps]
// Env: STEPS_KEY (JEV bearer; only needed for jev — never commit keys/logs),
//   STEPS_URL (override endpoint; default the local laya sidecar URL below),
//   STEPS_ROWS (house|fixture|all; default all),
//   STEPS_FIXTURE (fixture path; default ../test/fixtures/goal-context-eval.json).
// JEV budget: ~1 call per row per rep (fixture: 32 rows); sequential posts,
// the endpoint 429s under bursts.
const fs = require('node:fs')
const path = require('node:path')
const { JEV_ENDPOINT, JEV_MODEL, sourceForUrl } = require('../src/brain')
const { STEP_ORDER, STEP_CRITERIA, ASK_INSTRUCTIONS, goalText, goalFsm } = require('../src/goal')

const LAYA_URL = process.env.STEPS_URL || 'http://127.0.0.1:8000/v1/systemone'

// Extra planner options for the +menu+park variant (vmzq.5): the menu grows
// by these two; the reviewer labels on the stall rows are drawn from them.
const PARK = 'park'
const ASK_OWNER = 'ask-owner'
const EXTRA_CRITERIA = {
  [PARK]: 'stop the task, rest at home and report why',
  [ASK_OWNER]: 'tell the owner what blocks the task and wait',
}

function taskWord(row) {
  const goal = (row.context && row.context.goal) || ''
  const words = goal.trim().split(/\s+/)
  return words.length ? words[words.length - 1] : 'none'
}

// Variant table: state/instructions/criteria/menu builders per row. shipped
// is the exact prod ask (text state, ASK_INSTRUCTIONS, menu criteria).
const VARIANTS = {
  shipped: {
    instr: () => ASK_INSTRUCTIONS,
    criteria: () => STEP_CRITERIA,
    state: (row) => row.facts,
    menu: (row) => row.menu,
  },
  // Ablation: pre-atl.2 instruction — did the rewrite cost rw4 agreement?
  oldinstr: {
    instr: () => 'Pick the next step toward building and keeping a home',
    criteria: () => STEP_CRITERIA,
    state: (row) => row.facts,
    menu: (row) => row.menu,
  },
  // +goal: one goal sentence on the instructions, a task= word on the text.
  '+goal': {
    instr: (row) => `${ASK_INSTRUCTIONS}. Goal: ${row.context.goal} (${row.context.progress}).`,
    criteria: () => STEP_CRITERIA,
    state: (row) => `${row.facts} task=${taskWord(row)}`,
    menu: (row) => row.menu,
  },
  // +context: the state as a JSON object (the JEV docs recommend object
  // states: the material you would present to a panel of experts).
  '+context': {
    instr: () => ASK_INSTRUCTIONS,
    criteria: () => STEP_CRITERIA,
    state: (row) => ({
      goal: row.context.goal,
      progress: row.context.progress,
      blocked_on: row.context.blocked_on,
      recent: row.context.recent,
      facts: row.facts,
    }),
    menu: (row) => row.menu,
  },
  // +menu+park: the context object plus the two planner options.
  '+menu+park': {
    instr: () => ASK_INSTRUCTIONS,
    criteria: () => ({ ...STEP_CRITERIA, ...EXTRA_CRITERIA }),
    state: (row) => ({
      goal: row.context.goal,
      progress: row.context.progress,
      blocked_on: row.context.blocked_on,
      recent: row.context.recent,
      facts: row.facts,
    }),
    menu: (row) => [...row.menu, PARK, ASK_OWNER],
  },
}

function F(over) {
  return {
    time: 'day', logs: 0, planks: 0, maxPlanks: 0, table: 0, door: 0,
    home: 'built', tablePlaced: false, inside: 'no', health: 20, food: 20,
    known: 'none', haul: 'none', player: 'none', ...over,
  }
}

// Goal states: facts + the feasible subset decide() would compute. The FSM
// verdict is computed, not asserted — the table prints it next to the model
// answer for the human quality check.
const STATES = [
  // rw4 regression: the house loop still decides like before.
  ['gather-day', F({ home: 'site' }), ['gather', 'rest']],
  ['craft-load', F({ home: 'site', logs: 14 }), ['craft', 'build', 'gather', 'rest']],
  ['night-home', F({ time: 'night', home: 'built', table: 1, door: 1, planks: 48 }), ['gohome', 'rest']],
  ['night-inside', F({ time: 'night', home: 'built', inside: 'yes', table: 1, door: 1, planks: 48 }), ['stay', 'gohome', 'rest']],
  // atl.2: the harvest loop.
  ['forage-known', F({ table: 1, door: 1, planks: 48, known: 'near' }), ['forage', 'explore', 'rest']],
  ['deliver-haul', F({ table: 1, door: 1, planks: 48, known: 'near', haul: 'waiting', player: 'near' }), ['deliver', 'forage', 'explore', 'rest']],
  ['deliver-far', F({ table: 1, door: 1, planks: 48, haul: 'waiting', player: 'far' }), ['deliver', 'explore', 'rest']],
  ['explore-empty', F({ table: 1, door: 1, planks: 48 }), ['explore', 'rest']],
  ['dxl-alone', F({ table: 1, door: 1, planks: 48, known: 'near', haul: 'waiting' }), ['forage', 'explore', 'rest']],
  ['night-haul', F({ time: 'night', home: 'built', inside: 'no', table: 1, door: 1, planks: 48, haul: 'waiting', player: 'near' }), ['gohome', 'deliver', 'rest']],
  ['prehouse-rw4', F({ home: 'none', planks: 5, table: 1, door: 1 }), ['gather', 'rest']],
]

// The house rows predate goal contexts; reviewer == fsm there (no human
// label), and the context is the generic home goal.
const HOUSE_CONTEXT = { goal: 'build home', progress: 'n/a', blocked_on: 'none', recent: [], since_min: 0 }

function houseRows() {
  return STATES.map(([label, facts, names]) => {
    const text = goalText(facts)
    const fsm = goalFsm(facts, names)
    return { id: label, source: 'house', facts: text, time: facts.time, menu: names, fsm, reviewer: fsm, context: HOUSE_CONTEXT }
  })
}

function fixtureRows() {
  const file = process.env.STEPS_FIXTURE || path.join(__dirname, '..', 'test', 'fixtures', 'goal-context-eval.json')
  const rows = JSON.parse(fs.readFileSync(file, 'utf8'))
  return rows.map((r) => {
    const m = /time=(day|dusk|night)/.exec(r.facts)
    const time = m ? m[1] : 'day'
    const fsm = goalFsm({ time }, r.menu)
    if (fsm !== r.fsm) throw new Error(`fixture ${r.id}: fsm=${r.fsm} but goalFsm says ${fsm}`)
    if (!r.context || !r.context.goal) throw new Error(`fixture ${r.id}: missing context`)
    return { id: r.id, source: r.source, facts: r.facts, time, menu: r.menu, fsm: r.fsm, reviewer: r.reviewer, context: r.context }
  })
}

// Raw ask mirroring jevBrain.ask (brain.js): one direct post for jev and
// for <=2-key menus, else the per-candidate yes/no chain in menu order,
// first yes wins. Chain states are strings (stringified when the variant
// builds an object). Returns choice + confidence + probabilities.
async function rawAsk(url, key, timeoutMs, { state, instructions, criteria }) {
  const keys = Object.keys(criteria)
  const isJev = sourceForUrl(url) === 'jev'
  const post = async (bodyState, bodyCriteria) => {
    const headers = { 'Content-Type': 'application/json' }
    if (key) headers.Authorization = `Bearer ${key}`
    const t0 = Date.now()
    const res = await fetch(url, {
      method: 'POST',
      signal: AbortSignal.timeout(timeoutMs),
      headers,
      body: JSON.stringify({ model: JEV_MODEL, state: bodyState, questions: { action: { type: 'choice', instructions, criteria: bodyCriteria } } }),
    })
    if (!res.ok) throw new Error(`stand http ${res.status}`)
    const data = await res.json()
    const ans = data && data.answers && data.answers.action
    return {
      choice: ans && ans.choice,
      confidence: ans && typeof ans.confidence === 'number' ? ans.confidence : null,
      probabilities: ans && ans.probabilities && typeof ans.probabilities === 'object' ? ans.probabilities : null,
      ms: Date.now() - t0,
    }
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const guarded = async (bodyState, bodyCriteria) => {
    try {
      return await post(bodyState, bodyCriteria)
    } catch (err) {
      // One retry on rate-limit: the JEV endpoint 429s under bursts.
      if (String((err && err.message) || err).includes('429')) {
        await sleep(5000)
        return post(bodyState, bodyCriteria)
      }
      throw err
    }
  }
  if (isJev || keys.length <= 2) {
    const r = await guarded(state, criteria)
    return { ...r, chain: 1 }
  }
  const text = typeof state === 'string' ? state : JSON.stringify(state)
  let n = 0
  for (const k of keys) {
    n++
    const r = await guarded(`${text} candidate=${k}`, { yes: criteria[k], no: 'another step fits better' })
    if (r.choice === 'yes') return { choice: k, confidence: r.confidence, probabilities: r.probabilities, ms: r.ms, chain: n }
  }
  throw new Error('ask chain exhausted (all-no)')
}

function fmtProbs(probs) {
  if (!probs) return 'probs=?'
  const ks = Object.keys(probs).sort((a, b) => probs[b] - probs[a])
  return 'probs=' + ks.map((k) => `${k}:${Number(probs[k]).toFixed(2)}`).join(',')
}

async function main() {
  const backend = process.argv[2] || 'laya'
  const variant = process.argv[3] || 'shipped'
  const reps = parseInt(process.argv[4] || (backend === 'jev' ? '1' : '2'), 10)
  const which = process.env.STEPS_ROWS || 'all'
  const V = VARIANTS[variant]
  if (!V) { console.error(`unknown variant ${variant}: ${Object.keys(VARIANTS).join(',')}`); process.exit(2) }
  let url
  let key = ''
  let timeoutMs = 180000
  if (backend === 'laya') {
    url = LAYA_URL
  } else if (backend === 'jev') {
    key = process.env.STEPS_KEY
    if (!key) { console.error('STEPS_KEY required for jev'); process.exit(2) }
    url = JEV_ENDPOINT
    timeoutMs = 60000
  } else { console.error('backend: laya|jev'); process.exit(2) }
  let rows = []
  if (which === 'house' || which === 'all') rows = rows.concat(houseRows())
  if (which === 'fixture' || which === 'all') rows = rows.concat(fixtureRows())
  if (!rows.length) { console.error(`STEPS_ROWS=${which}: no rows (house|fixture|all)`); process.exit(2) }
  console.log(`backend=${backend} variant=${variant} reps=${reps} rows=${which} n=${rows.length}`)
  console.log('row              fsm          rev          answers (choice/Rvreviewer/Ffsm/conf/secs probs)')
  const score = {
    revProd: [0, 0], revStall: [0, 0], revHouse: [0, 0],
    fsmHouse: [0, 0], fsmFixture: [0, 0],
    confRight: [], confWrong: [], planner: [0, 0], errors: 0,
  }
  const bucketsFor = (row) => [
    row.source === 'prod-10-05' ? score.revProd : row.source === 'synthetic' ? score.revStall : score.revHouse,
    row.source === 'house' ? score.fsmHouse : score.fsmFixture,
  ]
  for (const row of rows) {
    const menu = V.menu(row)
    const ok = new Set(menu)
    if (!ok.has(row.fsm) && row.source !== 'synthetic') {
      console.log(`${row.id.padEnd(16)} fsm=${row.fsm} NOT-FEASIBLE (bad row)`)
      continue
    }
    if (menu.length <= 1) {
      console.log(`${row.id.padEnd(16)} ${row.fsm.padEnd(12)} ${(row.reviewer || '-').padEnd(12)} only-option:${menu[0]} (no ask)`)
      continue
    }
    const answers = []
    for (let r = 0; r < reps; r++) {
      const criteria = {}
      for (const n of menu) criteria[n] = V.criteria()[n]
      let ans = null
      try {
        ans = await rawAsk(url, key, timeoutMs, { state: V.state(row), instructions: V.instr(row), criteria })
      } catch (err) {
        // Errors score as wrong (the old total++ did): a variant that
        // errors on its hard rows must not win on a smaller denominator.
        answers.push(`ERROR:${err && err.message ? err.message : err}`)
        const [bucket, fbucket] = bucketsFor(row)
        bucket[1]++
        fbucket[1]++
        if (row.source === 'synthetic') score.planner[1]++
        score.errors++
        continue
      }
      const isOk = ok.has(ans.choice)
      const revYes = ans.choice === row.reviewer
      const fsmYes = ans.choice === row.fsm
      const [bucket, fbucket] = bucketsFor(row)
      bucket[revYes ? 0 : 1]++
      fbucket[fsmYes ? 0 : 1]++
      if (row.source === 'synthetic' && (ans.choice === PARK || ans.choice === ASK_OWNER)) score.planner[0]++
      else if (row.source === 'synthetic') score.planner[1]++
      if (typeof ans.confidence === 'number') (revYes ? score.confRight : score.confWrong).push(ans.confidence)
      const conf = typeof ans.confidence === 'number' ? ans.confidence.toFixed(2) : '?'
      answers.push(`${ans.choice}${isOk ? '' : '!'}${revYes ? '/R' : '/w'}${fsmYes ? 'F' : 'f'}/${conf}/${(ans.ms / 1000).toFixed(1)}s${ans.chain > 1 ? `/ch${ans.chain}` : ''} ${fmtProbs(ans.probabilities)}`)
      if (backend === 'jev') await new Promise((res) => setTimeout(res, 150))
    }
    console.log(`${row.id.padEnd(16)} ${row.fsm.padEnd(12)} ${(row.reviewer || '-').padEnd(12)} ${answers.join(' ')}`)
  }
  const pct = ([a, b]) => (a + b ? `${a}/${a + b} (${(100 * a / (a + b)).toFixed(1)}%)` : 'n/a')
  const mean = (xs) => (xs.length ? (xs.reduce((s, x) => s + x, 0) / xs.length).toFixed(3) : 'n/a')
  console.log(`reviewer-agree prod=${pct(score.revProd)} stall=${pct(score.revStall)} house=${pct(score.revHouse)}`)
  console.log(`fsm-agree house=${pct(score.fsmHouse)} fixture=${pct(score.fsmFixture)}`)
  console.log(`planner-option-on-stall=${pct(score.planner)} errors=${score.errors}`)
  console.log(`confidence right=${mean(score.confRight)} (n=${score.confRight.length}) wrong=${mean(score.confWrong)} (n=${score.confWrong.length})`)
}

main().catch((err) => { console.error('stand failed:', err && err.message ? err.message : err); process.exit(1) })
