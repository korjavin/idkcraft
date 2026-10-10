'use strict'

// idkcraft-oqul.1: forbidden require directions, held by an allowlist that
// may only shrink. Rules: a behaviour never requires the arbiter/task/
// ticker/orders/chat modules; nothing requires index.js; task.js ->
// goal-options.js -> goal.js is layered, never upward (oqul.11). Every current violation
// is listed in deps-allowlist.json with a reason — a new edge fails, and so
// does a listed edge that is gone (delete its line: the list only shrinks).
// Lazy in-function requires count the same as top-level ones.

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const BOT = path.join(__dirname, '..')
const ALLOW = require('./deps-allowlist.json')

function srcFiles() {
  const out = []
  for (const dir of ['src', 'src/behaviours']) {
    for (const f of fs.readdirSync(path.join(BOT, dir))) if (f.endsWith('.js')) out.push(`${dir}/${f}`)
  }
  return out
}

// file -> Set of required src-relative files (local requires only).
function graph() {
  const g = {}
  for (const f of srcFiles()) {
    g[f] = new Set()
    const text = fs.readFileSync(path.join(BOT, f), 'utf8')
    for (const m of text.matchAll(/require\(\s*['"](\.\.?\/[^'"]+)['"]\s*\)/g)) {
      let t = path.posix.normalize(path.posix.join(path.posix.dirname(f), m[1]))
      if (!t.endsWith('.js')) t += '.js'
      g[f].add(t)
    }
  }
  return g
}

const BEHAVIOUR_BANNED = new Set(['src/goal.js', 'src/task.js', 'src/index.js', 'src/orders.js', 'src/chat.js'])
// The goal/task/goal-options triangle is layered (oqul.11, the oqul.5
// residual): task.js sits on goal-options.js, which sits on goal.js. The
// downward edges are the design; only an upward one would close a cycle.
const UPWARD = new Set(['src/goal.js -> src/task.js', 'src/goal.js -> src/goal-options.js', 'src/goal-options.js -> src/task.js'])

function forbidden(from, to) {
  if (from === to) return false
  if (to === 'src/index.js') return true
  if (from.startsWith('src/behaviours/') && BEHAVIOUR_BANNED.has(to)) return true
  return UPWARD.has(`${from} -> ${to}`)
}

function violations(g) {
  const out = []
  for (const [from, tos] of Object.entries(g)) for (const to of tos) if (forbidden(from, to)) out.push(`${from} -> ${to}`)
  return out.sort()
}

describe('structure: forbidden require directions (oqul.1)', () => {
  it('every require target exists (the scan reads real edges)', () => {
    const g = graph()
    const missing = []
    for (const [from, tos] of Object.entries(g)) for (const to of tos) if (!fs.existsSync(path.join(BOT, to))) missing.push(`${from} -> ${to}`)
    assert.deepEqual(missing, [])
  })

  it('every allowlist entry carries a reason', () => {
    for (const [edge, why] of Object.entries(ALLOW)) assert.ok(typeof why === 'string' && why.trim().length > 10, `${edge}: reason missing`)
  })

  it('forbidden edges match the allowlist exactly', () => {
    const now = violations(graph())
    const allowed = Object.keys(ALLOW)
    const added = now.filter((e) => !allowed.includes(e))
    const gone = allowed.filter((e) => !now.includes(e))
    const msg = [
      added.length ? `NEW forbidden edges (break the dependency, or list with a reason in test/deps-allowlist.json):\n  + ${added.join('\n  + ')}` : '',
      gone.length ? `Allowlisted edges no longer present (delete them from test/deps-allowlist.json):\n  - ${gone.join('\n  - ')}` : '',
    ].filter(Boolean).join('\n')
    assert.ok(!added.length && !gone.length, msg)
  })

  // oqul.13: the layer order goal < goal-options < task holds through third
  // modules too (goal.js -> X -> task.js would close the cycle the direct
  // UPWARD rule cannot see). Lazy requires count, as above.
  it('the goal/goal-options/task layering holds transitively', () => {
    const g = graph()
    const reach = (from) => {
      const seen = new Set([from])
      const todo = [from]
      while (todo.length) for (const t of g[todo.pop()] || []) if (!seen.has(t)) { seen.add(t); todo.push(t) }
      return seen
    }
    const up = []
    for (const e of UPWARD) {
      const [from, to] = e.split(' -> ')
      if (reach(from).has(to)) up.push(e)
    }
    assert.deepEqual(up, [])
  })

  // oqul.14: the require graph is acyclic — the last cycles (craft/
  // craftany/gear via stockpile, bring and equip) were cut by moving the
  // shared helpers into packroom.js/bringbase.js/tablespot.js leaves (and
  // TABLE_REACH into budget.js). Zero back-edges in any DFS order means no
  // directed cycle exists, so a new require that closes a loop fails here.
  it('the require graph has no cycles', () => {
    const g = graph()
    const color = {}
    for (const f of Object.keys(g)) color[f] = 0
    const stack = []
    const back = []
    const dfs = (u) => {
      color[u] = 1
      stack.push(u)
      for (const v of g[u] || []) {
        if (!(v in color)) continue
        if (color[v] === 1) back.push([...stack.slice(stack.indexOf(v)), v].join(' -> '))
        else if (color[v] === 0) dfs(v)
      }
      stack.pop()
      color[u] = 2
    }
    for (const f of Object.keys(g)) if (color[f] === 0) dfs(f)
    assert.deepEqual(back, [])
  })

  it('forbidden() rules: sanity', () => {
    assert.equal(forbidden('src/behaviours/x.js', 'src/goal.js'), true)
    assert.equal(forbidden('src/behaviours/x.js', 'src/perception.js'), false)
    assert.equal(forbidden('src/metrics.js', 'src/index.js'), true)
    assert.equal(forbidden('src/goal.js', 'src/task.js'), true)
    assert.equal(forbidden('src/goal-options.js', 'src/task.js'), true)
    assert.equal(forbidden('src/goal.js', 'src/goal-options.js'), true)
    assert.equal(forbidden('src/task.js', 'src/goal.js'), false)
    assert.equal(forbidden('src/goal-options.js', 'src/goal.js'), false)
    assert.equal(forbidden('src/goal.js', 'src/behaviours/x.js'), false)
    assert.equal(forbidden('src/index.js', 'src/goal.js'), false)
  })
})
