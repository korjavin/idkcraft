'use strict'
// ef3 stand: replay stuck states against a System-1 endpoint (laya or JEV)
// through the REAL prod path (jevBrain.ask + chooseRecovery with the shipped
// menu, criteria and FSM), scoring label validity + FSM agreement.
// Usage: node stand-ef3.js [laya|jev] [variant] [reps]
// Env: EF3_KEY (JEV bearer; only needed for jev — never commit keys/logs),
//   EF3_URL (override endpoint; default laya http://127.0.0.1:8000/v1/systemone).
// JEV budget: keep jev runs to one rep of the shortlisted variant (~10 calls).
const { jevBrain, JEV_ENDPOINT } = require('../src/brain')
const { RECOVER_ORDER, RECOVER_CRITERIA, RECOVER_INSTRUCTIONS, RECOVER_MENU, recoverText, recoverFsm } = require('../src/behaviours/recover')

const LAYA_URL = process.env.EF3_URL || 'http://127.0.0.1:8000/v1/systemone'

// Variant table: the shipped wording (v0) plus shortlisted rewrites.
// Only the criteria/instructions change — menu, FSM and facts stay prod.
const VARIANTS = {
  shipped: { instr: RECOVER_INSTRUCTIONS, criteria: RECOVER_CRITERIA },
  // v0: the original long clauses (frozen) — lost to shipped on laya 4/7.
  v0: {
    instr: 'The bot is stuck and cannot reach its goal. Pick one recovery action',
    criteria: {
      pillar_up: 'goal is high, scaffold blocks are on hand and headroom is free: jump and place one block under your feet',
      dig_up: 'goal is high and you carry a pickaxe: dig the blocks above your head and climb',
      sidestep: 'a side is open: step sideways around the obstacle',
      dig_through: 'you carry a pickaxe and no lava is near: dig a 1-wide 2-tall tunnel toward the goal',
      wait: 'the blockage looks temporary (a mob, a player, a loading chunk): stand still and wait',
      call_player: 'a player is online and no escape works: ask the player for a teleport',
    },
  },
}

function F(over) {
  return {
    by: 'stand', goalDy: 0, goalDist: 5, scaffold: 0, pickaxe: false, water: false,
    headBlocked: false, digStep: null, walls: 0, freeSides: [[1, 0]], lavaNear: false,
    playerOnline: false, playerDist: null, playerName: null, stuckTicks: 12,
    resetsStuck: 2, resetsPlaceError: 0, last: 'none', ...over,
  }
}

// Stuck states: facts + note. The FSM verdict is computed, not asserted —
// the table prints it next to the model answer for the human quality check.
const STATES = [
  ['pit-scaffold', F({ goalDy: 3, goalDist: 3, scaffold: 10, walls: 4, playerOnline: true, playerDist: 20, playerName: 'Steve' })],
  ['pit-pickaxe', F({ goalDy: 3, goalDist: 3, pickaxe: true, walls: 4, playerOnline: true, playerDist: 20, playerName: 'Steve' })],
  ['corridor', F({ walls: 2, playerOnline: true, playerDist: 6, playerName: 'Steve' })],
  ['dead-end', F({ walls: 4, pickaxe: true })],
  ['lava-dead-end', F({ walls: 4, pickaxe: true, lavaNear: true, playerOnline: true, playerDist: 6, playerName: 'Steve' })],
  ['boxed-alone', F({ walls: 4 })],
  ['open-field', F({ walls: 0 })],
  ['repeat-fail', F({ walls: 2, playerOnline: true, playerDist: 6, playerName: 'Steve', last: 'sidestep:failed' })],
  ['pit-dirt-hand', F({ goalDy: 3, goalDist: 6, walls: 2, digStep: [0, 1] })],
  ['pit-stone-online', F({ goalDy: 3, goalDist: 6, walls: 3, playerOnline: true, playerDist: 6, playerName: 'Steve' })],
]

function feasibleNames(facts) {
  return RECOVER_ORDER.filter((n) => {
    try { return RECOVER_MENU[n].feasible(facts, { recovery: null }) } catch (_) { return false }
  })
}

async function main() {
  const backend = process.argv[2] || 'laya'
  const variant = process.argv[3] || 'v0'
  const reps = parseInt(process.argv[4] || (backend === 'jev' ? '1' : '2'), 10)
  const V = VARIANTS[variant]
  if (!V) { console.error(`unknown variant ${variant}: ${Object.keys(VARIANTS).join(',')}`); process.exit(2) }
  let brain
  if (backend === 'laya') {
    brain = jevBrain('stand', undefined, 180000, LAYA_URL)
  } else if (backend === 'jev') {
    const key = process.env.EF3_KEY
    if (!key) { console.error('EF3_KEY required for jev'); process.exit(2) }
    brain = jevBrain(key, undefined, 60000, JEV_ENDPOINT)
  } else { console.error('backend: laya|jev'); process.exit(2) }
  console.log(`backend=${backend} variant=${variant} reps=${reps} model=${brain.source || brain.name}`)
  console.log('state            fsm          model-answers (valid? agree?)')
  let valid = 0
  let agree = 0
  let total = 0
  for (const [label, facts] of STATES) {
    const names = feasibleNames(facts)
    const text = recoverText(facts)
    const fsm = recoverFsm(facts, names)
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
      const ok = names.includes(ans)
      const ag = ans === fsm
      if (ok) valid++
      if (ag) agree++
      total++
      answers.push(`${ans}${ok ? '' : '!'}/${ag ? 'y' : 'n'}/${(ms / 1000).toFixed(1)}s`)
    }
    console.log(`${label.padEnd(16)} ${fsm.padEnd(12)} ${answers.join(' ')}`)
  }
  console.log(`valid=${valid}/${total} agree=${agree}/${total}`)
}

main().catch((err) => { console.error('stand failed:', err && err.message ? err.message : err); process.exit(1) })
