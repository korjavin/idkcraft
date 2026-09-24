'use strict'
// Goal-steps stand: replay goal arbiter states against a System-1 endpoint
// (laya or JEV) through the REAL prod path (jevBrain.ask + chooseStep with
// the shipped menu, criteria, instructions and FSM), scoring label validity
// + FSM agreement. Model for atl.2 criteria (one deciding fact per key).
// Usage: node stand-steps.js [laya|jev] [variant] [reps]
// Env: STEPS_KEY (JEV bearer; only needed for jev — never commit keys/logs),
//   STEPS_URL (override endpoint; default laya http://127.0.0.1:8000/v1/systemone).
// JEV budget: shortlisted variant only, ~12 calls.
const { jevBrain, JEV_ENDPOINT } = require('../src/brain')
const { STEP_ORDER, STEP_CRITERIA, ASK_INSTRUCTIONS, goalText, goalFsm } = require('../src/goal')

const LAYA_URL = process.env.STEPS_URL || 'http://127.0.0.1:8000/v1/systemone'

// Variant table: the shipped wording plus shortlisted rewrites. Only the
// criteria/instructions change — menu, FSM and facts stay prod.
const VARIANTS = {
  shipped: { instr: ASK_INSTRUCTIONS, criteria: STEP_CRITERIA },
  // Ablation: pre-atl.2 instruction — did the rewrite cost rw4 agreement?
  oldinstr: {
    instr: 'Pick the next step toward building and keeping a home',
    criteria: STEP_CRITERIA,
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

async function main() {
  const backend = process.argv[2] || 'laya'
  const variant = process.argv[3] || 'shipped'
  const reps = parseInt(process.argv[4] || (backend === 'jev' ? '1' : '2'), 10)
  const V = VARIANTS[variant]
  if (!V) { console.error(`unknown variant ${variant}: ${Object.keys(VARIANTS).join(',')}`); process.exit(2) }
  let brain
  if (backend === 'laya') {
    brain = jevBrain('stand', undefined, 180000, LAYA_URL)
  } else if (backend === 'jev') {
    const key = process.env.STEPS_KEY
    if (!key) { console.error('STEPS_KEY required for jev'); process.exit(2) }
    brain = jevBrain(key, undefined, 60000, JEV_ENDPOINT)
  } else { console.error('backend: laya|jev'); process.exit(2) }
  console.log(`backend=${backend} variant=${variant} reps=${reps} model=${brain.source || brain.name}`)
  console.log('state            fsm          model-answers (valid? agree?)')
  let valid = 0
  let agree = 0
  let total = 0
  for (const [label, facts, names] of STATES) {
    const ok = new Set(names)
    const text = goalText(facts)
    const fsm = goalFsm(facts, names)
    if (!ok.has(fsm)) {
      console.log(`${label.padEnd(16)} fsm=${fsm} NOT-FEASIBLE (bad state)`)
      continue
    }
    if (names.length <= 1) {
      console.log(`${label.padEnd(16)} ${fsm.padEnd(12)} only-option:${fsm} (no ask)`)
      continue
    }
    const answers = []
    for (let r = 0; r < reps; r++) {
      const criteria = {}
      for (const n of names) criteria[n] = V.criteria[n]
      const t0 = Date.now()
      let ans
      try {
        ans = await brain.ask({ state: text, instructions: V.instr, criteria, situation: `${label}#${r}` })
      } catch (err) {
        ans = `ERROR:${err && err.message ? err.message : err}`
      }
      const ms = Date.now() - t0
      const isOk = names.includes(ans)
      const ag = ans === fsm
      if (isOk) valid++
      if (ag) agree++
      total++
      answers.push(`${ans}${isOk ? '' : '!'}/${ag ? 'y' : 'n'}/${(ms / 1000).toFixed(1)}s`)
    }
    console.log(`${label.padEnd(16)} ${fsm.padEnd(12)} ${answers.join(' ')}`)
  }
  console.log(`valid=${valid}/${total} agree=${agree}/${total}`)
}

main().catch((err) => { console.error('stand failed:', err && err.message ? err.message : err); process.exit(1) })
