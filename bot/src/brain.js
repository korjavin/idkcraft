'use strict'

// The one brain interface, two implementations. No classes needed.
// decide(state) -> { action: 'follow' | 'idle', sprint: bool, source }
// state = { distance_to_player, player_visible, player_moving, bot_health, bot_food, nearby_hostiles }

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
    const d = state.distance_to_player
    if (typeof d !== 'number') return { action: 'idle', sprint: false, source: 'stub' }
    if (d > 3) return { action: 'follow', sprint: d > 8, source: 'stub' }
    return { action: 'idle', sprint: false, source: 'stub' }
  }
}

function parseAction(answer) {
  const choice = answer && answer.choice
  return choice === 'follow' || choice === 'idle' ? choice : null
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
  return `distance_to_player=${typeof d === 'number' ? d.toFixed(1) : 'none'} ` +
    `player_visible=${!!state.player_visible} ` +
    `player_moving=${!!state.player_moving} ` +
    `bot_health=${state.bot_health} bot_food=${state.bot_food} ` +
    `nearby_hostiles=${state.nearby_hostiles}`
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
                instructions: 'The companion bot must decide whether to follow the player or wait. Follow whenever the player is more than 3 blocks away.',
                criteria: {
                  follow: 'The player is far away (more than 3 blocks): the bot should walk toward the player and stay close.',
                  idle: 'The player is already within 3 blocks: the bot should stand still and wait.'
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
        const action = parseAction(data && data.answers && data.answers.action)
        if (!action) throw new Error('jev missing action answer')
        const sprint = parseNoul(data.answers.sprint)
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
