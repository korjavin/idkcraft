'use strict'

// idkcraft-oqul.1: five correctness rules only — no-unused-vars stays off
// (catch (_) everywhere would drown it). Globals = whatever this Node has
// (DOMException, fetch, AbortController ...) plus the CommonJS wrapper names.
// ponytail: globals read from the running Node, not the `globals` package.
const globals = Object.fromEntries(Object.getOwnPropertyNames(globalThis).map((n) => [n, 'readonly']))
for (const n of ['require', 'module', 'exports', '__dirname', '__filename']) globals[n] = 'writable'

module.exports = [
  {
    files: ['**/*.js'],
    languageOptions: { ecmaVersion: 'latest', sourceType: 'commonjs', globals },
    linterOptions: { reportUnusedDisableDirectives: 'off' },
    rules: {
      'no-undef': 'error',
      'no-redeclare': 'error',
      'no-unreachable': 'error',
      'no-dupe-keys': 'error',
      'no-self-assign': 'error',
    },
  },
]
