'use strict'

// idkcraft-oqul.1: inventory of the shared ctx object. ctx-fields.json maps
// every ctx field written in src to its writer modules (ctx.X =, op=, ++,
// --, delete ctx.X), an owner and, for the tri-state fields, a note
// (null = revoked, undefined = not restored yet — memory.js). The test
// fails when a field written by >= 2 modules is missing from the json or
// has a writer the json does not list (a writer that left is not checked):
// a review hook, not a ban — protocol fields (lastGoalKey, stepStatus,
// in-flight flags) are multi-writer on purpose. Listing it is legal:
//   node test/structure-ctx.test.js --write
// regenerates the writers, keeping owner/tristate of listed fields.
// ponytail: regex scan, not an AST — a write through an alias (const c = ctx) is invisible.

const fs = require('node:fs')
const path = require('node:path')

const BOT = path.join(__dirname, '..')
const JSON_PATH = path.join(__dirname, 'ctx-fields.json')
const TRISTATE = {
  followName: 'null = follow revoked, undefined = not restored from memory yet',
  castle: 'null = castle revoked, undefined = not restored from memory yet',
}

function srcFiles() {
  const out = []
  for (const dir of ['src', 'src/behaviours']) {
    for (const f of fs.readdirSync(path.join(BOT, dir))) if (f.endsWith('.js')) out.push(`${dir}/${f}`)
  }
  return out
}

const WRITES = [
  /\bctx\.([A-Za-z_$][\w$]*)\s*(?:=(?!=)|[-+*/%|&]=|\?\?=|\|\|=|&&=|\+\+|--)/g,
  /(?:\+\+|--)\s*ctx\.([A-Za-z_$][\w$]*)/g,
  /\bdelete\s+ctx\.([A-Za-z_$][\w$]*)/g,
]

// field -> { file: write count }
function scan() {
  const w = {}
  for (const f of srcFiles()) {
    const text = fs.readFileSync(path.join(BOT, f), 'utf8')
    for (const re of WRITES) {
      for (const m of text.matchAll(re)) {
        w[m[1]] = w[m[1]] || {}
        w[m[1]][f] = (w[m[1]][f] || 0) + 1
      }
    }
  }
  return w
}

function generate(old) {
  const out = {}
  for (const [field, by] of Object.entries(scan()).sort(([a], [b]) => a.localeCompare(b))) {
    const writers = Object.keys(by).sort()
    const prev = old[field] || {}
    // Owner default: the module with the most write sites (review and edit freely).
    const owner = prev.owner || writers.slice().sort((a, b) => by[b] - by[a] || a.localeCompare(b))[0]
    out[field] = { writers, owner }
    if (prev.tristate || TRISTATE[field]) out[field].tristate = prev.tristate || TRISTATE[field]
    if (prev.note) out[field].note = prev.note // hand-written protocol notes survive --write (oqul.8)
  }
  return out
}

if (require.main === module && process.argv.includes('--write')) {
  const old = fs.existsSync(JSON_PATH) ? JSON.parse(fs.readFileSync(JSON_PATH, 'utf8')) : {}
  fs.writeFileSync(JSON_PATH, JSON.stringify(generate(old), null, 2) + '\n')
  console.log(`wrote ${JSON_PATH}`)
} else {
  const { describe, it } = require('node:test')
  const assert = require('node:assert/strict')
  const listed = require('./ctx-fields.json')

  describe('structure: ctx field inventory (oqul.1)', () => {
    it('every multi-writer ctx field is listed in ctx-fields.json', () => {
      const missing = []
      for (const [field, by] of Object.entries(scan())) {
        const writers = Object.keys(by)
        if (writers.length < 2) continue
        if (!listed[field]) missing.push(`${field}: ${writers.sort().join(', ')}`)
        else {
          // revmux 01 minor: a listed field gaining a writer is the same hook.
          const added = writers.filter((w) => !(listed[field].writers || []).includes(w))
          if (added.length) missing.push(`${field}: new writer ${added.sort().join(', ')}`)
        }
      }
      assert.deepEqual(missing, [], `ctx fields with new writers (>= 2 modules) — decide the owner, then list them (node test/structure-ctx.test.js --write):\n  ${missing.join('\n  ')}`)
    })

    it('tri-state fields keep their note', () => {
      for (const f of Object.keys(TRISTATE)) assert.ok(listed[f] && listed[f].tristate, `${f}: tristate note missing`)
      assert.ok(listed.lastGoalKey && listed.lastGoalKey.note, 'lastGoalKey: writer-pattern note missing (oqul.8)')
    })

    it('scan sees the protocol fields (the regex is live)', () => {
      const w = scan()
      for (const f of ['lastGoalKey', 'stepStatus', 'step']) assert.ok(Object.keys(w[f] || {}).length >= 2, f)
    })
  })
}
