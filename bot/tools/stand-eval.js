'use strict'
// Brain-quality eval stand (beads idkcraft-hg8, idkcraft-82i): replays the
// prod-sampled fixtures (bot/test/fixtures/*-eval.json) through the REAL
// prod path (hybridBrain: isHard routing + noplayer veto + uig
// short-circuit, jevBrain ask/decide with the shipped instructions and
// criteria) against laya or JEV, scoring FSM-agreement and
// model-call counts with and without the hg8 menu shaping.
// Usage: node stand-eval.js [laya|jev] [--shape|--no-shape] [reps]
// Env: EVAL_URL (default http://localhost:8000/v1/systemone),
//   EVAL_KEY (JEV bearer; only needed for jev — never commit keys).
// JEV budget: one rep unshaped only (~50 calls); shaping needs no JEV calls
// on the pair fixtures (only-option answers without asking).
const fs = require('node:fs')
const path = require('node:path')
const { stubBrain, jevBrain, hybridBrain, isHard, JEV_ENDPOINT } = require('../src/brain')
const { STEP_CRITERIA, ASK_INSTRUCTIONS, shapeGoalMenu } = require('../src/goal')

const EVAL_URL = process.env.EVAL_URL || 'http://localhost:8000/v1/systemone'

function load(name) {
  return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'test', 'fixtures', name), 'utf8'))
}

async function main() {
  const backend = process.argv[2] || 'laya'
  const shapeFlag = process.argv[3] || '--shape'
  const reps = parseInt(process.argv[4] || '1', 10)
  const shape = shapeFlag === '--shape'
  if (!['--shape', '--no-shape'].includes(shapeFlag)) { console.error('flag: --shape|--no-shape'); process.exit(2) }
  let brain
  // calls counts true network POSTs (the uig skip sends none) — a chain
  // ask costs its yes/no round-trips, like in prod.
  let remoteCalls = 0
  const countingFetch = async (...a) => { remoteCalls++; return fetch(...a) }
  if (backend === 'laya') {
    brain = jevBrain('stand', countingFetch, 60000, EVAL_URL)
  } else if (backend === 'jev') {
    const key = process.env.EVAL_KEY
    if (!key) { console.error('EVAL_KEY required for jev'); process.exit(2) }
    brain = jevBrain(key, countingFetch, 60000, JEV_ENDPOINT)
  } else { console.error('backend: laya|jev'); process.exit(2) }
  const model = brain.source || brain.name || 'model'
  console.log(`backend=${backend} shape=${shape} reps=${reps} model=${model}`)
  // Faithful prod path: hybrid veto + jevBrain futile-ask skip included.
  const hybrid = hybridBrain(brain)

  const combat = load('combat-eval.json')
  const goal = load('goal-eval.json')
  let agree = 0, total = 0, calls = 0

  console.log('--- combat (route via current isHard; hard asks fight/follow) ---')
  for (const row of combat) {
    const want = stubBrain.decide(row.state).action
    const reason = isHard(row.state)
    for (let r = 0; r < reps; r++) {
      let got, asked = false, skipped = false
      if (!reason) {
        got = want // easy: FSM answers, model not consulted
      } else {
        const before = remoteCalls
        try {
          got = (await hybrid.decide(row.state)).action
        } catch (err) {
          got = `ERROR:${err && err.message ? err.message : err}`
        }
        if (remoteCalls > before) {
          asked = true
          calls += remoteCalls - before
        } else {
          skipped = true // uig short-circuit: veto pre-decided, no ask sent
        }
      }
      const ok = got === want
      if (ok) agree++
      total++
      console.log(`${ok ? 'OK  ' : 'MISS'} ${row.id} route=${reason || 'easy'} want=${want} got=${got}${asked ? '' : skipped ? ' (short-circuit)' : ' (no ask)'}${row.prod_model ? ` prod=${row.prod_model}` : ''}`)
    }
  }

  console.log('--- goal (direct pairs; shaped [X,rest] answers without asking) ---')
  for (const row of goal) {
    const names = shape ? shapeGoalMenu(row.menu, model) : row.menu
    const want = names.length === 1 ? names[0] : row.fsm
    for (let r = 0; r < reps; r++) {
      let got
      if (names.length <= 1) {
        got = names[0] || 'rest' // only-option: no ask, like chooseStep
      } else {
        const criteria = {}
        for (const n of names) criteria[n] = STEP_CRITERIA[n]
        try {
          got = await brain.ask({ state: row.state_text, instructions: ASK_INSTRUCTIONS, criteria, situation: `${row.id}#${r}` })
        } catch (err) {
          got = `ERROR:${err && err.message ? err.message : err}`
        }
        calls = remoteCalls // POST-level counting, shared with combat
      }
      const ok = got === want
      if (ok) agree++
      total++
      console.log(`${ok ? 'OK  ' : 'MISS'} ${row.id} menu=${names.join('+')} want=${want} got=${got}${names.length <= 1 ? ' (no ask)' : ''} prod=${row.prod_model}`)
    }
  }
  console.log(`RESULT agree=${agree}/${total} (${(100 * agree / Math.max(total, 1)).toFixed(1)}%) model_calls=${calls}`)
}

main().catch((err) => { console.error('stand failed:', err && err.message ? err.message : err); process.exit(1) })
