'use strict'
// idkcraft-neuc.13: control states for the Baritone body.
//
// mineflayer parity: setControlState/getControlState/clearControlStates +
// bot.controlState mirror. Calls coalesce: synchronous bursts (home.js
// back+sneak, deep.js five keys) become ONE input.set carrying only the
// diff against what the mod was last sent. The mod (Input.java) holds the
// states until changed/cleared, applies them per client tick, pauses
// Baritone while any key is held and resumes the latched goal on clear —
// the goal id is never cleared by pause/resume, so no re-issue is needed
// (see PROTOCOL.md, control-states section).
//
// Self-contained: requires nothing outside bot/src/bridge/.

const CONTROLS = ['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak']

function allFalse() {
  const s = {}
  for (const c of CONTROLS) s[c] = false
  return s
}

// Small exported pause/resume helper for other bridge surfaces (neuc.9
// look/attack/activate reuse): sends the Baritone control command and
// resolves true when the mod accepted it. Never throws.
async function setBaritonePaused(bot, paused) {
  try {
    if (!bot || !bot.transport || typeof bot.transport.call !== 'function') return false
    await bot.transport.call('baritone.cmd', { command: paused ? '#pause' : '#resume' })
    return true
  } catch (_) {
    return false
  }
}

function installInput(bot, transport) {
  const desired = allFalse() // local mirror (bot.controlState)
  const sent = allFalse() // what the mod was last told via input.set
  let pendingClear = false
  let flushQueued = false
  let flushing = false
  let dirty = false

  bot.controlState = desired

  function flush() {
    if (flushing) { dirty = true; return }
    flushing = true
    ;(async () => {
      try {
        for (;;) {
          dirty = false
          if (pendingClear) {
            pendingClear = false
            // A clear supersedes any unsent diff.
            for (const c of CONTROLS) sent[c] = false
            await transport.call('input.clear', {})
          }
          const diff = {}
          for (const c of CONTROLS) if (desired[c] !== sent[c]) diff[c] = desired[c]
          if (Object.keys(diff).length > 0) {
            await transport.call('input.set', diff)
            for (const c of Object.keys(diff)) sent[c] = diff[c]
          }
          if (!dirty && !pendingClear) break
        }
      } catch (e) {
        // Never emit 'error' (runOnce fatal()s it); the next call re-diffs
        // against `sent`, so a lost set is retried by any later change.
        try { console.log(`bridge input failed: ${(e && e.message) || e}`) } catch (_) {}
        // Re-mark unsent keys so a later flush retries them.
        dirty = false
      } finally {
        flushing = false
      }
    })()
  }

  function schedule() {
    if (flushQueued) return
    flushQueued = true
    queueMicrotask(() => { flushQueued = false; flush() })
  }

  bot.setControlState = (control, state) => {
    if (!CONTROLS.includes(control)) throw new Error(`invalid control: ${control}`)
    if (typeof state !== 'boolean') throw new Error(`invalid state: ${state}`)
    if (desired[control] === state) return
    desired[control] = state
    // A fresh press after a queued clear cancels that clear only when the
    // clear has not been sent yet; flush() ordering keeps this safe: the
    // clear is dropped and the diff (computed vs sent) still sends.
    if (pendingClear && !flushing) pendingClear = false
    schedule()
  }

  bot.getControlState = (control) => {
    if (!CONTROLS.includes(control)) throw new Error(`invalid control: ${control}`)
    return desired[control]
  }

  bot.clearControlStates = () => {
    let any = false
    for (const c of CONTROLS) if (desired[c]) { desired[c] = false; any = true }
    // Even with an all-false mirror, a set may be in flight unsent-acked;
    // input.clear is idempotent on the mod, so send it when anything was
    // held or anything was ever sent.
    if (any || CONTROLS.some((c) => sent[c]) || flushing) {
      pendingClear = true
      schedule()
    }
  }

  // state.get reconciliation: adopt the mod-reported states only when no
  // local change is queued/in flight (poll lag must not fight a press).
  bot._syncInputFromState = (states) => {
    if (!states || typeof states !== 'object') return
    if (pendingClear || flushQueued || flushing || dirty) return
    for (const c of CONTROLS) {
      if (typeof states[c] === 'boolean') { desired[c] = states[c]; sent[c] = states[c] }
    }
  }

  // Connect-time reset (revmux 01 core-3): a previous Node process may
  // have died holding keys — the mod keeps them (and its Baritone pause)
  // across a ws reconnect, where v1 would drop all controls on disconnect.
  // Force one input.clear before the first refresh adopts mod state.
  bot._resetInput = async () => {
    for (const c of CONTROLS) desired[c] = false
    pendingClear = true
    schedule()
    await bot._flushInput()
  }

  // Test/diagnostic seam: resolves when the current coalesced flush settles.
  bot._flushInput = async () => {
    for (let i = 0; i < 5000 && (flushQueued || flushing || dirty || pendingClear); i++) {
      await new Promise((r) => setTimeout(r, 1))
    }
  }

  return bot
}

module.exports = { CONTROLS, installInput, setBaritonePaused }
