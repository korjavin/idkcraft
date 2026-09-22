'use strict'

// The one brain interface, two implementations. No classes needed.
// decide(state) -> { action: 'fight' | 'follow' | 'roam' | 'idle', sprint: bool, source }
// state = { distance_to_player, player_visible, player_moving, bot_health, bot_food, nearby_hostiles, hostile_distance, hostile_near_player, hostile_reachable }
// hostile_reachable=false comes from fight's give-up latch (unreachable mob:
// cave, glass, ravine). Missing means reachable (older callers).

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

// Noul answers are documented as {"type":"noul","noul":0..1} (0..1
// probability, no confidence field).
function parseNoul(answer) {
  return typeof answer?.noul === 'number' ? answer.noul >= 0.5 : false
}

// JEV `state` is documented as a string; send one compact text line.
function stateToText(state) {
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
    async decide(state) {
      // ponytail: one call per tick, no batching/caching — upgrade path is
      // batching states if JEV cost ever matters ($0.042/M tokens; ~200
      // tokens/tick -> pennies/day).
      try {
        const headers = { 'Content-Type': 'application/json' }
        if (apiKey) headers.Authorization = `Bearer ${apiKey}`
        const res = await doFetch(url, {
          method: 'POST',
          signal: AbortSignal.timeout(timeoutMs),
          headers,
          body: JSON.stringify({
            model: JEV_MODEL,
            state: stateToText(state),
            questions: {
              action: {
                type: 'choice',
                instructions: 'Decide what the companion bot does this second. Fight when a reachable hostile mob is within 8 blocks of the bot, or a hostile mob is near the player, and the bot has at least 6 health. A mob flagged hostile_reachable=false is unreachable: do not fight it unless it is near the player. Otherwise follow when the player is far: more than 3 blocks while moving or while a hostile mob is near, more than 6 blocks while standing still with no hostile near. Otherwise roam when the player is within 6 blocks and is not moving and no hostile mob is near. Otherwise wait.',
                criteria: {
                  fight: 'A hostile mob is within 8 blocks and hostile_reachable=true, or near the player, and bot_health is 6 or more: attack the mob. hostile_reachable=false means unreachable: do not fight unless near the player.',
                  follow: 'Walk toward the player and stay close when the player is far: more than 3 blocks while moving or while a hostile mob is near, more than 6 blocks while standing still with no hostile near.',
                  idle: 'Stand still and wait: no target, the player is within 3 blocks and moving, or a hostile mob is near while bot_health is below 6 and the player is within 3 blocks.',
                  roam: 'The player is within 6 blocks and is not moving, and no hostile mob is near: walk a few blocks around the player to look at the surroundings.'
                }
              },
              sprint: {
                type: 'noul',
                instructions: 'The player is more than 8 blocks away and moving, so the bot should sprint to catch up.',
                criteria: {
                  true: 'sprint to catch up',
                  false: 'walking is enough'
                }
              }
            }
          })
        })
        if (!res.ok) throw new Error(`jev http ${res.status}`)
        const data = await res.json()
        let action = parseAction(data && data.answers && data.answers.action)
        if (!action) throw new Error('jev missing action answer')
        const sprint = parseNoul(data.answers.sprint)
        const ref = stubBrain.decide(state).action
        if (ref !== action) {
          console.error(`brain disagree source=${source} model=${action} stub=${ref} state=${stateToText(state)}`)
        }
        return { action, sprint, source }
      } catch (err) {
        // 429/529 back off by falling through to the stub; the next tick
        // retries naturally. Never crash the bot because of the brain.
        console.error(`brain jev error, stub fallback: ${err && err.message ? err.message : err}`)
        const fallback = stubBrain.decide(state)
        fallback.source = 'stub-fallback'
        return fallback
      }
    }
  }
}

function makeBrain(env) {
  const customUrl = env && env.BRAIN_URL
  const key = env && env.TYPESAFE_API_KEY
  if (customUrl || key) {
    const url = customUrl || JEV_ENDPOINT
    const source = sourceForUrl(url)
    console.log(`brain=${source}`)
    const rawTimeout = (env && env.BRAIN_TIMEOUT_MS) || (env && env.BRAIN_TICK_MS) || '1000'
    const timeoutMs = parseInt(rawTimeout, 10)
    return jevBrain(key, undefined, Number.isFinite(timeoutMs) ? timeoutMs : 1000, url)
  }
  console.log('brain=stub')
  return stubBrain
}

module.exports = { stubBrain, jevBrain, makeBrain, stateToText, sourceForUrl, JEV_ENDPOINT, JEV_MODEL }
