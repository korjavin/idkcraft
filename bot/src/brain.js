'use strict'

// The one brain interface, two implementations. No classes needed.
// decide(state) -> { action: 'follow' | 'idle', sprint: bool, source }
// state = { distance_to_player, player_visible, player_moving, bot_health, bot_food, nearby_hostiles }

const JEV_ENDPOINT = 'https://api.typesafe.ai/v1/systemone'
const JEV_MODEL = 'jev-latest'

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

// Noul answers are documented as {"type":"noul","noul":0..1} (probability,
// no confidence field): https://docs.typesafe.ai/primitives/noul.md
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

function jevBrain(apiKey, fetchFn, timeoutMs = 1000) {
  const doFetch = fetchFn || fetch
  return {
    name: 'jev',
    async decide(state) {
      // ponytail: one call per tick, no batching/caching — upgrade path is
      // batching states if JEV cost ever matters ($0.042/M tokens; ~200
      // tokens/tick -> pennies/day).
      try {
        const res = await doFetch(JEV_ENDPOINT, {
          method: 'POST',
          signal: AbortSignal.timeout(timeoutMs),
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`
          },
          body: JSON.stringify({
            model: JEV_MODEL,
            state: stateToText(state),
            questions: {
              action: {
                type: 'choice',
                instructions: 'What should the companion bot do right now?',
                criteria: {
                  follow: 'walk toward and stay near the player',
                  idle: 'stand still and wait'
                }
              },
              sprint: {
                type: 'noul',
                instructions: 'Should the bot sprint to keep up with the player?'
              }
            }
          })
        })
        if (!res.ok) throw new Error(`jev http ${res.status}`)
        const data = await res.json()
        const action = parseAction(data && data.answers && data.answers.action)
        if (!action) throw new Error('jev missing action answer')
        const sprint = parseNoul(data.answers.sprint)
        return { action, sprint, source: 'jev' }
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
  const key = env && env.TYPESAFE_API_KEY
  if (key) {
    console.log('brain=jev')
    const tickMs = parseInt((env && env.BRAIN_TICK_MS) || '1000', 10)
    return jevBrain(key, undefined, Number.isFinite(tickMs) ? tickMs : 1000)
  }
  console.log('brain=stub')
  return stubBrain
}

module.exports = { stubBrain, jevBrain, makeBrain, stateToText, JEV_ENDPOINT, JEV_MODEL }
