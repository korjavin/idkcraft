#!/usr/bin/env node
// idkcraft-6x7.27: shared BEFORE cache for the v2 gate's component legs.
// The two before legs measure origin/master, the same commit for every PR
// between merges: castle-rig.sh writes a clean 10-min component leg on
// origin/master through to $PRODWORLD/castle-rigs/before/ (local, never in
// git), and `castle-before.sh <lay|mine>` prints the cached line for the
// PR's base. Keep it dumb: no worktree, no npm ci, no rig on a miss.
//   node castle-before.js <lay|mine>   lookup; exit 0 hit, 1 miss/stale/changed
//   node castle-before.js store        write-through (castle-rig.sh calls it)
// Settings = the gate's "equal settings": CASTLE_BODY, CASTLE_PADSPOT,
// CASTLE_MINS (10), tick rate, BARITONE_IMAGE (the body image tag; unset =
// client.sh's default idkcraft-baritone:<short baritone/ tree hash>, 6x7.28,
// resolved at the MEASURED sha — master's body for a before, not the PR's).
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { execFileSync } = require('node:child_process')

const MAX_AGE_MS = 7 * 24 * 3600 * 1000 // host/image drift cap, applies to exact hits too
// A docs/CI-only merge does not change the rig: an ancestor stays valid
// while none of these moved between it and the base.
const RIG_PATHS = ['bot/src', 'baritone', 'bot/tools/castle-replay.js', 'bot/tools/castle-rig.sh', 'bot/tools/component-baseline.json']

function settingsOf(env, treeTag = 'local') {
  const body = env.CASTLE_BODY || ''
  return {
    body,
    padspot: env.CASTLE_PADSPOT || '',
    mins: String(env.CASTLE_MINS || 10),
    tick: String(env.CASTLE_TICKRATE || env.CASTLE_TICK_RATE || 1), // the rig exports the effective rate as CASTLE_TICKRATE
    image: body === 'baritone' ? (env.BARITONE_IMAGE || `idkcraft-baritone:${treeTag}`) : '-',
  }
}

// Pure: <sha>-<component>-<image tag>-<settings hash>. The sha is a full
// 40-hex commit, so the first '-' split is unambiguous.
function cacheKey(sha, component, settings) {
  const h = crypto.createHash('sha256').update(JSON.stringify(settings)).digest('hex').slice(0, 10)
  return `${sha}-${component}-${settings.image.replace(/[^A-Za-z0-9._-]/g, '_')}-${h}`
}

// Pure: pick the before for `base` among cache entries ({ sha, date, line })
// of the same component+settings. isAncestor(sha) / rigChanged(sha) are
// injected (git in the CLI, fakes in tests). Exact sha first, then the
// newest valid ancestor; else the most telling one-line reason.
function pickBefore(entries, { base, now, isAncestor, rigChanged }) {
  const fresh = (e) => now - Date.parse(e.date) <= MAX_AGE_MS
  const exact = entries.filter((e) => e.sha === base).sort((a, b) => Date.parse(b.date) - Date.parse(a.date))
  if (exact.length) {
    if (fresh(exact[0])) return { hit: exact[0] }
    return { reason: `stale: cached ${exact[0].date.slice(0, 10)} on master ${base.slice(0, 8)} is older than 7 days` }
  }
  const anc = entries.filter((e) => e.sha !== base && isAncestor(e.sha)).sort((a, b) => Date.parse(b.date) - Date.parse(a.date))
  const ok = anc.find((e) => fresh(e) && !rigChanged(e.sha))
  if (ok) return { hit: ok }
  if (anc.some((e) => fresh(e))) {
    const e = anc.find((x) => fresh(x))
    return { reason: `changed: cached master ${e.sha.slice(0, 8)} is an ancestor of ${base.slice(0, 8)} but rig files moved (${RIG_PATHS.join(' ')})` }
  }
  if (anc.length) return { reason: `stale: newest cached ancestor ${anc[0].sha.slice(0, 8)} (${anc[0].date.slice(0, 10)}) is older than 7 days` }
  return { reason: `miss: no cached before for master ${base.slice(0, 8)}` }
}

// Knobs outside the cache key that change the rate: a leg that set any of
// them is not a gate before and never caches (revmux 01 core-1).
const GATE_DEFAULTS = {
  CASTLE_NIGHT: ['', '0'], CASTLE_BLOCKED: ['', '0'], RIG_PLANNER: ['', 'jev'], CASTLE_DAYLOCK: ['', '1'],
  CASTLE_BURY: ['', '0'], CASTLE_PIT: ['', '0'], CASTLE_SAND: ['', '0'], CASTLE_FAR: ['', '0'],
  CASTLE_PAD: [''], GOAL_WATCHDOG_MS: [''], GOAL_COMMIT_MS: [''], CASTLE_BASELINE_RATE: [''],
  CASTLE_INIT_MEMORY: [''], CASTLE_MAX_MEMORY: [''], BARITONE_MEM: [''], CASTLE_VIEW_DISTANCE: [''], CASTLE_SIM_DISTANCE: [''],
}
const COMPONENT_KIT = { lay: 'lay', mine: 'pick' }

// Pure: the names of the off-gate knobs set in env ([] = a gate leg).
function offGate(env) {
  const off = Object.keys(GATE_DEFAULTS).filter((k) => !GATE_DEFAULTS[k].includes(env[k] || ''))
  if ((env.CASTLE_KIT || COMPONENT_KIT[env.CASTLE_COMPONENT]) !== COMPONENT_KIT[env.CASTLE_COMPONENT]) off.push('CASTLE_KIT')
  return off
}

// Pure: what the write-through stores, or null when the leg is not a
// clean gate before (no component, DIAG, a stale record, dirty tree, not
// origin/master).
function storeEntry({ env, record, head, master, clean, treeTag }) {
  const component = env.CASTLE_COMPONENT
  if (!component || env.CASTLE_DIAG === '1' || offGate(env).length) return null
  if (!record || !record.component || record.diag || record.tag !== env.CASTLE_TAG) return null
  if (!clean || !head || head !== master) return null
  const settings = settingsOf(env, treeTag)
  const m = /^\S+-rate ([\d.]+)\//.exec(record.component)
  return { key: cacheKey(head, component, settings), sha: head, component, settings, date: record.date, line: record.component, rate: m ? Number(m[1]) : null, record }
}

// An explicit tag only when the caller pinned one: client.sh exits 2 on a
// missing explicit tag but builds its default one.
function rigCommand(component, s, pinned) {
  const env = [s.body && `CASTLE_BODY=${s.body}`, pinned && s.body === 'baritone' && `BARITONE_IMAGE=${s.image}`, s.padspot && `CASTLE_PADSPOT=${s.padspot}`, s.tick !== '1' && `CASTLE_TICK_RATE=${s.tick}`]
    .filter(Boolean).join(' ')
  return `from a clean origin/master worktree: ${env} CASTLE_COMPONENT=${component} CASTLE_RIG_ID=auto sh bot/tools/castle-rig.sh${s.mins !== '10' ? ` ${s.mins}` : ''}`
}

function main(argv, env) {
  process.chdir(path.join(__dirname, '..', '..')) // repo root: git + RIG_PATHS resolve in this checkout whatever the caller's cwd
  const git = (...a) => execFileSync('git', a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  const gitOk = (...a) => { try { execFileSync('git', a, { stdio: 'ignore' }); return true } catch (_) { return false } }
  const treeTagAt = (rev) => (gitOk('rev-parse', `${rev}:baritone`) && git('rev-parse', '--short=8', `${rev}:baritone`)) || 'local' // client.sh's tag rule
  const dir = path.join(env.PRODWORLD || '/Users/iv/Projects/.idkcraft-prodworld', 'castle-rigs', 'before')
  const mode = argv[0]
  if (!['store', 'lay', 'mine'].includes(mode)) { console.log('usage: castle-before.sh <lay|mine>   (or store, from castle-rig.sh)'); return 2 }
  try { execFileSync('git', ['fetch', '-q', 'origin', 'master'], { stdio: 'ignore', timeout: 30000 }) } catch (_) { /* offline: use the local ref */ }
  if (mode === 'store') {
    let record = null
    try { record = JSON.parse(fs.readFileSync(env.CASTLE_OUT, 'utf8')) } catch (_) { record = null }
    const e = storeEntry({ env, record, treeTag: treeTagAt('HEAD'), head: gitOk('rev-parse', 'HEAD') && git('rev-parse', 'HEAD'), master: gitOk('rev-parse', 'origin/master') && git('rev-parse', 'origin/master'), clean: git('status', '--porcelain', '--untracked-files=no') === '' })
    const off = offGate(env)
    if (!e) { console.log(`castle-before: not cached (needs a clean 10-min gate-settings component leg on origin/master${off.length ? `; off-gate knobs set: ${off.join(' ')}` : ''})`); return 0 }
    fs.mkdirSync(dir, { recursive: true })
    const f = path.join(dir, `${e.key}.json`)
    fs.writeFileSync(`${f}.tmp`, JSON.stringify(e, null, 1))
    fs.renameSync(`${f}.tmp`, f)
    console.log(`castle-before: cached ${e.component} before for master ${e.sha.slice(0, 8)} -> ${f}`)
    return 0
  }
  const base = git('merge-base', 'origin/master', 'HEAD')
  const settings = settingsOf(env, treeTagAt(base))
  const suffix = cacheKey('x', mode, settings).slice(1) // -<component>-<image>-<hash>.json
  const entries = []
  let names = []
  try { names = fs.readdirSync(dir) } catch (_) { names = [] }
  for (const n of names) {
    if (!n.endsWith(`${suffix}.json`)) continue
    try { const e = JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')); if (e.sha && e.date && e.line) entries.push(e) } catch (_) { /* skip a torn file */ }
  }
  const r = pickBefore(entries, {
    base, now: Date.now(),
    isAncestor: (sha) => gitOk('merge-base', '--is-ancestor', sha, base),
    rigChanged: (sha) => !gitOk('diff', '--quiet', sha, base, '--', ...RIG_PATHS),
  })
  if (r.hit) {
    console.log(`before (cached ${r.hit.date.slice(0, 10)}, master ${r.hit.sha.slice(0, 8)}): ${r.hit.line}`)
    return 0
  }
  // A branch behind master: legs on origin/master cache master, never this base (revmux 01 core-2).
  const master = git('rev-parse', 'origin/master')
  const behind = master !== base ? ` (base ${base.slice(0, 8)} is behind master ${master.slice(0, 8)}: merge origin/master into the branch first, then re-check)` : ''
  console.log(`castle-before ${mode}: ${r.reason}${behind} — run ${rigCommand(mode, settings, !!env.BARITONE_IMAGE)}`)
  return 1
}

if (require.main === module) process.exit(main(process.argv.slice(2), process.env))
module.exports = { cacheKey, settingsOf, pickBefore, storeEntry, offGate, rigCommand, MAX_AGE_MS, RIG_PATHS }
