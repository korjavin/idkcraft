'use strict'
// idkcraft-neuc.19: prod body2 ran with the bridge mod disabled because
// compose never passed BARITONE_API=1 (the rig boot in stuck-run.sh /
// client.sh does). Without it start.sh keeps the API-less standalone jar,
// BridgeMod logs "standalone Baritone has no Java API", the mod ws never
// opens, and bot2 loops on "bridge waiting for the body". The worker
// service must stay on the standalone jar (no BARITONE_API).
const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const compose = fs.readFileSync(path.join(__dirname, '..', '..', 'docker-compose.yml'), 'utf8')

function serviceBlock (name) {
  const start = compose.indexOf(`\n  ${name}:`)
  assert.notEqual(start, -1, `service ${name} missing`)
  const rest = compose.slice(start + 1)
  const end = rest.search(/\n  \S/)
  return end === -1 ? rest : rest.slice(0, end)
}

describe('docker-compose body2 wiring (idkcraft-neuc.19)', () => {
  it('body2 passes BARITONE_API=1 so start.sh swaps in the API jar and the bridge mod enables', () => {
    assert.match(serviceBlock('body2'), /BARITONE_API:\s*"1"/)
  })

  it('the worker service stays on the standalone jar (no BARITONE_API)', () => {
    assert.doesNotMatch(serviceBlock('baritone'), /BARITONE_API/)
  })
})

describe('docker-compose body2 heap default (idkcraft-e4p4)', () => {
  const startSh = fs.readFileSync(path.join(__dirname, '..', '..', 'baritone', 'start.sh'), 'utf8')

  it('body2 defaults BODY_JVM_ARGS to -Xmx1500m (the bead evidence is the body JVM, not Node)', () => {
    assert.match(serviceBlock('body2'), /BODY_JVM_ARGS:.*-Xmx1500m/)
  })

  it('the -Xmx fits inside the body2 cap with headroom for non-heap JVM + socat', () => {
    const xmx = Number(serviceBlock('body2').match(/-Xmx(\d+)m/)[1])
    const cap = Number(serviceBlock('body2').match(/mem_limit:.*:-(\d+)m/)[1])
    assert.ok(cap - xmx >= 800, `headroom ${cap - xmx}m under the ${cap}m cap`)
  })

  it('the worker keeps todays JVM (no BODY_JVM_ARGS on the baritone service)', () => {
    assert.doesNotMatch(serviceBlock('baritone'), /BODY_JVM_ARGS/)
  })

  it('the 400m swarm slots are node-only (no BODY_JVM_ARGS)', () => {
    assert.doesNotMatch(serviceBlock('swarm1'), /BODY_JVM_ARGS/)
  })

  it('start.sh defaults the body2 heap to -Xmx1500m, body2-only, explicit value wins', () => {
    assert.match(startSh, /-Xmx1500m/)
    assert.match(startSh, /\[\s*"\$\{BARITONE_API:-\}"\s*=\s*1\s*\] && \[ -z "\$\{BODY_JVM_ARGS:-\}" \]/)
  })
})
