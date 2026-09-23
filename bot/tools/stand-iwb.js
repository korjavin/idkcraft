'use strict'
// iwb stand: replay prod hard-states against a System-1 endpoint (laya or JEV)
// with pluggable state/criteria variants; score agreement with stubBrain.
// Offline model-quality stand (bead idkcraft-iwb; reused for rw4.6).
// Replays prod hard-states (brain disagree lines) against a System-1 endpoint
// and scores agreement with stubBrain per state/criteria variant.
// Usage: node stand-iwb.js [URL] [variant] [reps]
// Env: IWB_STATES (disagree-lines file; default /private/tmp/idkcraft-iwb-states.txt),
//   IWB_SYNTH=1 (append synthetic stub-truth states), IWB_KEY (JEV bearer;
//   only needed for api.typesafe.ai — never commit keys or logs).
const fs = require('node:fs')
const { stubBrain, stateToText, isHard } = require(require('node:path').join(__dirname, '..', 'src', 'brain'))

const STATES_FILE = process.env.IWB_STATES || '/private/tmp/idkcraft-iwb-states.txt'
const MODEL = 'jev-latest'

const FIGHT_V0 = 'hard is crowd and health is ok, or hard is hostile-vs-far-player and hostile is adjacent or near, or hostile_near_player is yes and health is ok: pursue and hit the mob.'
const FOLLOW_V0 = 'health is low, or hard is unreachable-hostile, or hard is hostile-vs-far-player and player is away: leave the mob and walk to the player.'
const INSTR_V0 = 'The simple rules could not decide this state; choose fight or follow.'

// Variant table: state text fn + instructions + criteria.
const VARIANTS = {
  // v0: status quo (categorical buckets + long overlapping criteria).
  v0: { state: (s, r) => `hard=${r} ${stateToText(s)}`, instr: INSTR_V0, fight: FIGHT_V0, follow: FOLLOW_V0 },
  // v1: short criteria, one deciding fact per key.
  v1: {
    state: (s, r) => `hard=${r} ${stateToText(s)}`,
    instr: 'Choose fight or follow. Check the criteria in order; the first match wins.',
    fight: 'health is ok and hostile is adjacent or near: attack the mob.',
    follow: 'health is low, or hostile is far or none: walk to the player and stay close.',
  },
  // v2: survival-first wording.
  v2: {
    state: (s, r) => `hard=${r} ${stateToText(s)}`,
    instr: 'Choose fight or follow. Check the criteria in order; the first match wins.',
    fight: 'hostile is adjacent or near and health is ok: attack the mob.',
    follow: 'health is low: walk to the player and stay close. Otherwise, when the player is away and hostile is far or none: walk to the player.',
  },
  // v3: health alone decides (the one fact that separates the prod groups).
  v3: {
    state: (s, r) => `hard=${r} ${stateToText(s)}`,
    instr: 'Choose fight or follow. Health decides: low health always means follow.',
    fight: 'health is ok: attack the mob.',
    follow: 'health is low: walk to the player and stay close.',
  },
  // v6: mirror the stub rule (close+reachable+ok -> fight, else follow).
  v6: {
    state: (s, r) => `hard=${r} ${stateToText(s)}`,
    instr: 'Choose fight or follow. Only one criterion matches; pick it.',
    fight: 'health is ok and the hostile is close and reachable (adjacent or near), or the hostile threatens the player: attack the mob.',
    follow: 'in every other case: health is low, the hostile is far or gone, or the hostile is unreachable: walk to the player and stay close.',
  },
  // v10: v3 fight verbatim; follow names the mob-next-to-you low-health case.
  v10: {
    state: (s, r) => `hard=${r} ${stateToText(s)}`,
    instr: 'Choose fight or follow. Health decides: low health always means follow.',
    fight: 'health is ok: attack the mob.',
    follow: 'health is low, even with the hostile next to you: walk to the player and stay close.',
  },
  // v9 (probe): v3 brevity with an idle key for the wait-when-close stub rule.
  v9: {
    state: (s, r) => `hard=${r} ${stateToText(s)}`,
    instr: 'Choose fight, follow, or idle. Health decides.',
    fight: 'health is ok: attack the mob.',
    follow: 'health is low and player is away or far: walk to the player.',
    idle: 'health is low and player is near: stand still and wait.',
  },
  // v8: v3 fight clause verbatim; follow gains only the unreachable guard.
  v8: {
    state: (s, r) => `hard=${r} ${stateToText(s)}`,
    instr: 'Choose fight or follow. Health decides: low health always means follow.',
    fight: 'health is ok: attack the mob.',
    follow: 'health is low or hostile is unreachable: walk to the player and stay close.',
  },
  // v7: one conjunctive clause per key (stub fight-condition, flattened).
  v7: {
    state: (s, r) => `hard=${r} ${stateToText(s)}`,
    instr: 'Choose fight or follow. Only one criterion matches; pick it.',
    fight: 'health is ok and hostile is adjacent or near and reachable: attack the mob.',
    follow: 'health is low or hostile is far, none, or unreachable: walk to the player and stay close.',
  },
  // v5 (probe only): 3-key question with idle, mirroring the stub rule.
  v5: {
    state: (s, r) => `hard=${r} ${stateToText(s)}`,
    instr: 'Choose fight, follow, or idle. Health decides: low health never means fight.',
    fight: 'health is ok: attack the mob.',
    follow: 'health is low and the player is away or far: walk to the player and stay close.',
    idle: 'health is low and the player is near: stand still and wait.',
  },
  // v4: v3 plus coverage for the other hard reasons (crowd, unreachable).
  v4: {
    state: (s, r) => `hard=${r} ${stateToText(s)}`,
    instr: 'Choose fight or follow. Check the criteria in order; the first match wins.',
    fight: 'health is ok and hostile is adjacent, near, or threatening the player: attack the mob.',
    follow: 'health is low, or hostile is far, none, or unreachable: walk to the player and stay close.',
  },
}

function parseStates() {
  const out = []
  for (const line of fs.readFileSync(STATES_FILE, 'utf8').split('\n')) {
    const m = line.match(/model=(\w+) stub=(\w+) state=(.+)/)
    if (!m) continue
    const kv = Object.fromEntries(m[3].trim().split(' ').map((p) => p.split('=')))
    const num = (v) => (v === 'none' || v === undefined ? undefined : Number(v));
    const state = {
      distance_to_player: kv.distance_to_player === undefined ? undefined : num(kv.distance_to_player),
      player_visible: kv.player_visible === 'true',
      player_moving: kv.player_moving === 'true',
      bot_health: Number(kv.bot_health),
      bot_food: Number(kv.bot_food),
      nearby_hostiles: Number(kv.nearby_hostiles),
      hostile_distance: kv.hostile_distance === undefined ? undefined : num(kv.hostile_distance),
      hostile_near_player: kv.hostile_near_player === 'true',
      hostile_reachable: kv.hostile_reachable !== 'false',
    }
    out.push({ state, prodModel: m[1], stub: m[2] })
  }
  return out
}

async function ask(url, key, body) {
  const headers = { 'Content-Type': 'application/json' }
  if (key) headers.Authorization = `Bearer ${key}`
  const t0 = Date.now()
  const res = await fetch(url, {
    method: 'POST',
    signal: AbortSignal.timeout(60000),
    headers,
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`http ${res.status}`)
  const data = await res.json()
  const choice = data && data.answers && data.answers.action && data.answers.action.choice
  return { choice, ms: Date.now() - t0 }
}

// Synthetic hard states (stub ground truth) covering reasons absent from prod:
// unreachable, crowd, far-hostile. player_visible=true throughout.
const SYNTH = [
  { distance_to_player: 12, player_visible: true, player_moving: true, bot_health: 20, bot_food: 16, nearby_hostiles: 1, hostile_distance: 5, hostile_near_player: false, hostile_reachable: false },
  { distance_to_player: 12, player_visible: true, player_moving: true, bot_health: 20, bot_food: 16, nearby_hostiles: 1, hostile_distance: 5, hostile_near_player: true, hostile_reachable: false },
  { distance_to_player: 10, player_visible: true, player_moving: false, bot_health: 20, bot_food: 16, nearby_hostiles: 3, hostile_distance: 2, hostile_near_player: false, hostile_reachable: true },
  { distance_to_player: 10, player_visible: true, player_moving: false, bot_health: 5, bot_food: 16, nearby_hostiles: 3, hostile_distance: 2, hostile_near_player: false, hostile_reachable: true },
  { distance_to_player: 12, player_visible: true, player_moving: true, bot_health: 5, bot_food: 16, nearby_hostiles: 1, hostile_distance: 5, hostile_near_player: false, hostile_reachable: false },
  { distance_to_player: 12, player_visible: true, player_moving: false, bot_health: 20, bot_food: 16, nearby_hostiles: 1, hostile_distance: 10, hostile_near_player: false, hostile_reachable: true },
  { distance_to_player: 12, player_visible: true, player_moving: false, bot_health: 20, bot_food: 16, nearby_hostiles: 1, hostile_distance: 2, hostile_near_player: false, hostile_reachable: false },
]
async function main() {
  const url = process.argv[2] || 'http://127.0.0.1:8000/v1/systemone'
  const vname = process.argv[3] || 'v0'
  const reps = Number(process.argv[4] || '1')
  const key = process.env.IWB_KEY || ''
  const v = VARIANTS[vname]
  if (!v) throw new Error(`unknown variant ${vname}`)
  const rows = parseStates()
  if (process.env.IWB_SYNTH === '1') {
    for (const state of SYNTH) {
      const r = isHard(state)
      if (!r) { console.log('SYNTH-NOTHARD ' + JSON.stringify(state)); continue }
      rows.push({ state, prodModel: 'synth', stub: stubBrain.decide(state).action })
    }
  }
  console.log(`states=${rows.length} variant=${vname} reps=${reps}`)
  let agree = 0, total = 0
  for (const { state, prodModel, stub } of rows) {
    const want = stubBrain.decide(state).action
    if (want !== stub) console.log(`STUB-MISMATCH recomputed=${want} logged=${stub}`)
    const reason = isHard(state) || 'unknown'
    for (let i = 0; i < reps; i++) {
      const stateText = v.state(state, reason)
      const criteria = {}
      for (const k of ['fight', 'follow', 'idle']) if (v[k]) criteria[k] = v[k]
      const body = {
        model: MODEL,
        state: stateText,
        questions: { action: { type: 'choice', instructions: v.instr, criteria } },
      }
      let got
      try {
        got = await ask(url, key, body)
      } catch (e) {
        console.log(`ERROR ${e.message} state=${stateText}`)
        continue
      }
      total++
      const ok = got.choice === want
      if (ok) agree++
      console.log(`${ok ? 'OK  ' : 'MISS'} want=${want} got=${got.choice} ms=${got.ms} prod=${prodModel} state=${stateText}`)
    }
  }
  console.log(`RESULT variant=${vname} agree=${agree}/${total} (${(100 * agree / Math.max(total, 1)).toFixed(1)}%)`)
}

main().catch((e) => { console.error('FATAL', e.message); process.exit(1) })
