'use strict'

// The one brain interface, two implementations. No classes needed.
// decide(state) -> { action: 'fight' | 'follow' | 'roam' | 'idle', sprint: bool, source }
// state = { distance_to_player, player_visible, player_moving, bot_health, bot_food, nearby_hostiles, hostile_distance, hostile_near_player, hostile_reachable }
// hostile_reachable=false comes from fight's give-up latch (unreachable mob:
// cave, glass, ravine). Missing means reachable (older callers).

const metrics = require('./metrics')

const JEV_ENDPOINT = 'https://api.typesafe.ai/v1/systemone'
const JEV_MODEL = 'jev-latest'

// Remote-brain source name: the JEV hostname stays 'jev', anything else
// (e.g. the compose service laya) is addressed by its own hostname.
function sourceForUrl(url) {
  try {
    const host = new URL(url).hostname
    return host === 'api.typesafe.ai' ? 'jev' : host
  } catch {
    return 'jev'
  }
}

const stubBrain = {
  name: 'stub',
  decide(state) {
    const hd = state.hostile_distance
    const near = !!state.hostile_near_player
    const health = typeof state.bot_health === 'number' ? state.bot_health : 20
    // Unreachable mob (fight gave up pursuit): yield to follow unless the mob
    // threatens the player — the arbitration the brain owns.
    const unreachable = state.hostile_reachable === false
    if (((typeof hd === 'number' && hd <= 8 && !unreachable) || near) && health >= 6) {
      return { action: 'fight', sprint: false, source: 'stub' }
    }
    const d = state.distance_to_player
    if (typeof d !== 'number') return { action: 'idle', sprint: false, source: 'stub' }
    if (typeof hd === 'number' || near) {
      // Caution: a hostile fact with too little health to fight — the legacy
      // rule (follow when far, wait when close), never roam into danger.
      if (d > 3) return { action: 'follow', sprint: d > 8, source: 'stub' }
      return { action: 'idle', sprint: false, source: 'stub' }
    }
    if (d > 6) return { action: 'follow', sprint: d > 8, source: 'stub' }
    if (state.player_moving) {
      if (d > 3) return { action: 'follow', sprint: d > 8, source: 'stub' }
      return { action: 'idle', sprint: false, source: 'stub' }
    }
    // Roam ranks last: a still player within the 6-block stroll envelope and
    // no hostile near. The envelope must span the goals roam.js picks (up to
    // 6 from the player) — with follow at d > 3, every stroll past 3 blocks
    // would be preempted and the bot would yo-yo instead of strolling.
    return { action: 'roam', sprint: false, source: 'stub' }
  }
}

function parseAction(answer) {
  const choice = answer && answer.choice
  return choice === 'fight' || choice === 'follow' || choice === 'roam' || choice === 'idle' ? choice : null
}
// roam/idle never reach the model: hybridBrain consults it only on hard
// states, and every hard case is a fight-vs-follow judgement. parseAction
// still accepts all four words (harmless: a 2-key criteria can only yield two).

// JEV `state` is documented as a string; send one compact categorical text line.
function stateToText(state) {
  if (typeof state === 'string') return state
  if (!state || typeof state !== 'object') {
    return 'player=none player_moving=no hostile=none hostile_near_player=no hostile_reachable=yes health=ok food=ok'
  }
  const d = state.distance_to_player
  const hd = state.hostile_distance
  const player = typeof d !== 'number' || Number.isNaN(d) ? 'none'
    : d <= 3 ? 'near'
    : d <= 6 ? 'far'
    : 'away'
  const playerMoving = state.player_moving ? 'yes' : 'no'
  const hostile = typeof hd !== 'number' || Number.isNaN(hd) ? 'none'
    : hd <= 3 ? 'adjacent'
    : hd <= 8 ? 'near'
    : hd < 16 ? 'far'
    : 'none'
  const hostileNearPlayer = state.hostile_near_player ? 'yes' : 'no'
  const hostileReachable = state.hostile_reachable === false ? 'no' : 'yes'
  const hp = typeof state.bot_health === 'number' ? state.bot_health : 20
  const health = hp < 6 ? 'low' : 'ok'
  const f = typeof state.bot_food === 'number' ? state.bot_food : 20
  const food = f < 6 ? 'hungry' : 'ok'
  return `player=${player} player_moving=${playerMoving} hostile=${hostile} ` +
    `hostile_near_player=${hostileNearPlayer} hostile_reachable=${hostileReachable} ` +
    `health=${health} food=${food}`
}

// Numeric state line preserved for the disagreement log and logstats.sh.
function numericStateToText(state) {
  if (typeof state === 'string') return state
  const d = state.distance_to_player
  const hd = state.hostile_distance
  return `distance_to_player=${typeof d === 'number' ? d.toFixed(1) : 'none'} ` +
    `player_visible=${!!state.player_visible} ` +
    `player_moving=${!!state.player_moving} ` +
    `bot_health=${state.bot_health} bot_food=${state.bot_food} ` +
    `nearby_hostiles=${state.nearby_hostiles} ` +
    `hostile_distance=${typeof hd === 'number' ? hd.toFixed(1) : 'none'} ` +
    `hostile_near_player=${!!state.hostile_near_player} ` +
    `hostile_reachable=${state.hostile_reachable === false ? 'false' : 'true'}`
}

function jevBrain(apiKey, fetchFn, timeoutMs = 1000, url = JEV_ENDPOINT) {
  const doFetch = fetchFn || fetch
  const source = sourceForUrl(url)
  return {
    name: source,
    // reason is the hard-case name hybridBrain passes (isHard's answer, the
    // one fact that distinguishes the hard states); it rides the wire as a
    // leading hard=<reason> word. Sprint is NOT asked: the model answered
    // sprint 0.91 for everything, and the FSM rule (d > 8) already gets this
    // body detail right — the decision below returns the FSM's sprint.
    async decide(state, reason = '') {
      // ponytail: one call per tick, no batching/caching — upgrade path is
      // batching states if JEV cost ever matters ($0.042/M tokens; ~200
      // tokens/tick -> pennies/day).
      const endTimer = metrics.brainDuration.startTimer({ source })
      try {
        const headers = { 'Content-Type': 'application/json' }
        if (apiKey) headers.Authorization = `Bearer ${apiKey}`
        const res = await doFetch(url, {
          method: 'POST',
          signal: AbortSignal.timeout(timeoutMs),
          headers,
          body: JSON.stringify({
            model: JEV_MODEL,
            state: `hard=${reason} ${stateToText(state)}`,
            questions: {
              action: {
                type: 'choice',
                // iwb: LAYA matches whole-criterion similarity, so each key gets
                // one short clause on the decisive fact (health). Measured on
                // the 13 prod hard-states: 13/13 criteria-match, 10/13 strict
                // FSM (the 3 idle-want states need an idle key; a 3-key probe
                // scored worse at 8/20). Every longer variant regressed, so
                // keep these strings minimal. Known fringe gaps (unreachable
                // or far hostile at ok health): stub says follow, this says
                // fight — see the iwb report.
                instructions: 'Choose fight or follow. Health decides: low health always means follow.',
                criteria: {
                  fight: 'health is ok: attack the mob.',
                  follow: 'health is low: walk to the player and stay close.'
                }
              }
            }
          })
        })
        if (!res.ok) throw new Error(`jev http ${res.status}`)
        const data = await res.json()
        let action = parseAction(data && data.answers && data.answers.action)
        if (!action) throw new Error('jev missing action answer')
        endTimer()
        metrics.brainRequests.inc({ source, outcome: 'ok' })
        const fsm = stubBrain.decide(state)
        if (fsm.action !== action) {
          metrics.disagreements.inc({ model: action, stub: fsm.action })
          console.error(`brain disagree source=${source} model=${action} stub=${fsm.action} state=${numericStateToText(state)}`)
        }
        return { action, sprint: fsm.sprint, source }
      } catch (err) {
        // 429/529 back off by falling through to the stub; the next tick
        // retries naturally. Never crash the bot because of the brain.
        endTimer()
        const msg = String(err && err.message ? err.message : err)
        const outcome = err && err.name === 'TimeoutError' ? 'timeout'
          : msg.startsWith('jev http') ? 'http'
          : msg.startsWith('jev missing') ? 'invalid'
          : 'error'
        metrics.brainRequests.inc({ source, outcome })
        console.error(`brain jev error, stub fallback: ${err && err.message ? err.message : err}`)
        const fallback = stubBrain.decide(state)
        fallback.source = 'stub-fallback'
        return fallback
      }
    }
  }
}

// Hard states are judgement calls where the fixed rule is known to conflict or
// to have failed. The FSM is a precedence chain (if fight ... else if ... else
// roam): exactly one rule fires by construction, so counting "rules that fire"
// would always say 1. Hardness is therefore named per case, each with the prod
// line that motivated it (epic catalogue H1-H4). Ordered: first match wins so
// the route log stays comparable over time. No margin bands: the model answers
// a constant today, bands would only inject noise at every boundary crossing.
// H1 low-health-hostile: hostile fact and health < 6 (fight vs follow/survive).
// H2 crowd: nearby_hostiles >= 3 (FSM roams/fights into a crowd).
// H3 hostile-vs-far-player: hostile fact and distance_to_player > 8 (chase vs run).
// No unreachable case (was H4): fight already gave up pursuit
// (fightGivenUpId), so fight is infeasible and the choice is single —
// the stub follows and the model is never asked.
function isHard(state) {
  if (!state || typeof state !== 'object') return null
  const hostileFact = typeof state.hostile_distance === 'number' || !!state.hostile_near_player
  if (hostileFact && state.bot_health < 6) return 'low-health-hostile'
  if (state.nearby_hostiles >= 3) return 'crowd'
  if (hostileFact && state.distance_to_player > 8) return 'hostile-vs-far-player'
  return null
}

function hybridBrain(remote) {
  return {
    name: 'hybrid',
    async decide(state) {
      const fsm = stubBrain.decide(state)
      const reason = isHard(state)
      if (!reason) {
        console.log(`brain route=easy fsm=${fsm.action}`)
        metrics.routes.inc({ route: 'easy', reason: 'none' })
        return fsm
      }
      const model = await remote.decide(state, reason)
      metrics.routes.inc({ route: 'hard', reason })
      console.log(`brain route=hard reason=${reason} model=${model.action} fsm=${fsm.action} source=${model.source}`)
      return model
    }
  }
}

function makeBrain(env) {
  const customUrl = env && env.BRAIN_URL
  const key = env && env.TYPESAFE_API_KEY
  if (customUrl || key) {
    const url = customUrl || JEV_ENDPOINT
    const rawTimeout = (env && env.BRAIN_TIMEOUT_MS) || (env && env.BRAIN_TICK_MS) || '1000'
    const timeoutMs = parseInt(rawTimeout, 10)
    const remote = jevBrain(key, undefined, Number.isFinite(timeoutMs) ? timeoutMs : 1000, url)
    console.log(`brain=hybrid(${remote.name})`)
    return hybridBrain(remote)
  }
  console.log('brain=stub')
  return stubBrain
}

module.exports = { stubBrain, jevBrain, makeBrain, hybridBrain, isHard, stateToText, numericStateToText, sourceForUrl, JEV_ENDPOINT, JEV_MODEL }
