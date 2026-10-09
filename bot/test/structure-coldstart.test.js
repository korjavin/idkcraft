'use strict'

// idkcraft-oqul.1: cold start from every entry point. Test files usually
// load index.js first (vmzq19.test.js) and warm the require cache, which
// hides load-order defects. Here each entry loads first in a clean node
// process: loading must not throw, and every top-level
// `const { a, b } = require('./x')` in src must see a and b already on x's
// exports at that moment — a cycle that hands back a partial export would
// freeze undefined into the destructured binding (craft.js NEED_LOGS,
// gather.js NEED_LOGS/gatherFailedHolds, home.js goalFacts/timeWord).

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')

const SRC = path.join(__dirname, '..', 'src')
const BEH = path.join(SRC, 'behaviours')
const FILES = [
  ...fs.readdirSync(SRC).filter((f) => f.endsWith('.js')).map((f) => path.join(SRC, f)),
  ...fs.readdirSync(BEH).filter((f) => f.endsWith('.js')).map((f) => path.join(BEH, f)),
]

// Top-level destructured local requires: [{ from, to, names }].
function destructureSites() {
  const sites = []
  for (const from of FILES) {
    const text = fs.readFileSync(from, 'utf8')
    for (const m of text.matchAll(/^const\s*\{([^}]*)\}\s*=\s*require\(\s*['"](\.\.?\/[^'"]+)['"]\s*\)/gm)) {
      const names = m[1].split(',').map((s) => s.split(':')[0].trim()).filter(Boolean)
      sites.push({ from, to: require.resolve(path.resolve(path.dirname(from), m[2])), names })
    }
  }
  return sites
}

// Runs in the child: wraps require to check each site's names at the
// moment the consumer receives the exports, then loads the entry.
const CHILD = `
const Module = require('node:module')
const sites = JSON.parse(process.env.COLDSTART_SITES)
const misses = []
const orig = Module.prototype.require
Module.prototype.require = function (req) {
  const out = orig.apply(this, arguments)
  if (typeof req === 'string' && req.startsWith('.')) {
    const to = Module._resolveFilename(req, this)
    for (const s of sites) {
      if (s.from !== this.filename || s.to !== to) continue
      for (const n of s.names) if (out == null || out[n] === undefined) misses.push(s.from + ' got ' + n + ' undefined from ' + s.to)
    }
  }
  return out
}
require(process.env.COLDSTART_ENTRY)
console.log(JSON.stringify(misses))
process.exit(0)
`

const ENTRIES = [
  path.join(SRC, 'index.js'),
  path.join(SRC, 'goal.js'),
  path.join(SRC, 'goal-options.js'),
  path.join(SRC, 'task.js'),
  ...FILES.filter((f) => f.startsWith(BEH + path.sep)),
]

describe('structure: cold start per entry point (oqul.1)', () => {
  const sites = destructureSites()

  it('finds the known load-time destructures (the scan is live)', () => {
    const keys = sites.map((s) => `${path.basename(s.from)}<-${path.basename(s.to)}:${s.names.join(',')}`)
    for (const k of ['craft.js<-goal.js:NEED_LOGS', 'gather.js<-goal.js:NEED_LOGS,gatherFailedHolds', 'home.js<-goal.js:goalFacts,timeWord']) {
      assert.ok(keys.includes(k), `${k} not found in ${keys.length} sites`)
    }
  })

  it('every entry loads first in a clean process with complete destructured exports', async () => {
    const run = promisify(execFile)
    const env = { ...process.env, COLDSTART_SITES: JSON.stringify(sites) }
    // ponytail: all children at once (~40 node processes); cap with a pool if CI chokes.
    const results = await Promise.all(ENTRIES.map(async (entry) => {
      const name = path.relative(SRC, entry)
      try {
        const { stdout } = await run(process.execPath, ['-e', CHILD], { env: { ...env, COLDSTART_ENTRY: entry }, timeout: 60000 })
        const misses = JSON.parse(stdout.trim().split('\n').pop())
        return misses.map((m) => `${name} first: ${m.split(SRC + path.sep).join('')}`)
      } catch (err) {
        return [`${name} first: load failed: ${(err.stderr || err.message || '').toString().split('\n').slice(0, 6).join(' | ')}`]
      }
    }))
    const bad = results.flat()
    assert.deepEqual(bad, [], `cold-start defects:\n  ${bad.join('\n  ')}`)
  })
})
