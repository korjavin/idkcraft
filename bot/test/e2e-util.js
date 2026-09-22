'use strict'

// Shared helpers for the manual e2e scripts (not run by npm test).
function waitFor(emitter, event, timeoutMs, what) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), timeoutMs)
    emitter.once(event, (...args) => { clearTimeout(timer); resolve(args) })
  })
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

module.exports = { waitFor, sleep }
