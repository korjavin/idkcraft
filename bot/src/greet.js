'use strict'

// Greeting gesture (idkcraft-v92): crouch twice on arrival. One tiny module:
// the arrival rule (far -> near + standing + per-player cooldown) and the
// sneak cycle. The ticker owns one instance and calls greetOnArrival from
// the follow/bring dispatch; destroy/death cancel through cancel().

const GREET_FAR = 6
// +1 past FOLLOW_RANGE: follow stops on block distance (GoalFollow.isEnd),
// so the body stands anywhere up to ~3.5 away; 3 would miss half the arrivals.
const GREET_NEAR = 4
const COOLDOWN_MS = 60000
const SNEAK_MS = 250

function createGreeter({ now = () => Date.now(), sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), cooldownMs = COOLDOWN_MS, sneakMs = SNEAK_MS } = {}) {
  let running = false
  let gen = 0
  const last = new Map() // playerName -> ms of the last greeting
  const armed = new Map() // playerName -> seen far since the last greeting

  function setSneak(bot, v) {
    try {
      if (bot && typeof bot.setControlState === 'function') bot.setControlState('sneak', v)
    } catch (_) { /* body best-effort */ }
  }

  async function crouchTwice(bot) {
    if (running) return false
    running = true
    const g = gen
    let held = false
    const down = () => { held = false; setSneak(bot, false) }
    try {
      for (let i = 0; i < 2; i++) {
        if (g !== gen) return false
        held = true
        setSneak(bot, true)
        await sleep(sneakMs)
        if (g !== gen) return false
        down()
        await sleep(sneakMs)
      }
      return true
    } finally {
      // Sneak is always released, even when cancelled mid-hold.
      if (held) down()
      if (g === gen) running = false
    }
  }

  function cancel(bot) {
    gen++
    running = false
    setSneak(bot, false)
  }

  // Arrival entry: true when a greeting started (fire-and-forget). The
  // far -> near edge is latched per player: only a fresh sighting beyond
  // GREET_FAR arms it, so a gradual approach still greets exactly once on
  // arrival. A cooldown-blocked arrival disarms without greeting — standing
  // nearby is not a new approach.
  function greetOnArrival(bot, playerName, dist, standing) {
    if (!bot || !playerName) return false
    if (typeof dist !== 'number') return false
    if (dist > GREET_FAR) {
      armed.set(playerName, true)
      return false
    }
    if (dist > GREET_NEAR || !standing || !armed.get(playerName)) return false
    armed.set(playerName, false)
    const t = now()
    const prev = last.get(playerName)
    if (typeof prev === 'number' && t - prev < cooldownMs) return false
    last.set(playerName, t)
    void crouchTwice(bot).catch(() => {})
    return true
  }

  return { crouchTwice, cancel, greetOnArrival }
}

module.exports = { createGreeter, GREET_FAR, GREET_NEAR, COOLDOWN_MS, SNEAK_MS }
