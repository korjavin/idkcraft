'use strict'

// Generated-skill runtime (idkcraft-vf8e.2). A skill is one file
// bot/skills/<name>.js (promoted, ships in the image) or SKILLS_DIR/<name>.js
// (rig, unpromoted), plugged into the same tables as a hand primitive:
// kind 'recover' -> RECOVER_MENU/RECOVER_ORDER/RECOVER_CRITERIA, kind
// 'step' -> goal MENU/STEP_ORDER/STEP_CRITERIA + BEHAVIOURS. Off unless
// BOT_SKILLS=1: the ticker never calls load(), the tables stay
// byte-identical. Contract and header: bot/skills/README.md.
//
// Sandbox: one node:vm context per skill, own realm, no require/process/
// timers/console, eval and Function off (codeGeneration), microtasks drained
// inside each call's timeout. The only door out is the frozen `bot` facade,
// built inside the context around ONE host bridge that takes and returns
// JSON strings — no host object, function or error ever crosses, so the
// classic `x.constructor.constructor('return process')` escape has nothing
// to climb. Every act goes through the hand guards: dig = denyReason
// (protectedReason + selftrap rules), place = the castle yard/apron refusal
// and never against a GUI block, goto = body.js movementsFor on the live
// Movements (never a new one). No toss/drop, no chat.
// ponytail: node:vm is a guard rail for our own generated code, not a
// boundary against hostile code; promotion (vf8e.4) keeps revmux review.
// Known ceiling: no heap cap — a skill allocating GBs inside its 50 ms can
// OOM the process (container restart); isolated-vm's memoryLimit is the
// upgrade if skills ever come from outside our own pipeline.

const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { types } = require('node:util')
const { Vec3 } = require('vec3')
const { goals } = require('mineflayer-pathfinder')
const metrics = require('./metrics')
const castle = require('./castle')
const body = require('./body')
const { botPos, denyReason, logDeny, isInteractRef, issueGoal, clearGoal } = require('./behaviours/util')
const { stepDone, stepFailed, failReason, stepGen } = require('./step')

const PROMOTED_DIR = path.join(__dirname, '..', 'skills')
const CALL_MS = 50 // vm timeout per feasible/run call
// Per-episode tick budget (1 Hz ticks): a recover episode is ~a minute of
// hand primitives; a step leg may walk for minutes.
// ponytail: fixed per kind, a header field if a skill ever needs its own.
const TICK_BUDGET = { recover: 60, step: 600 }
const NAME_RE = /^[a-z][a-z0-9_]{1,39}$/
const REASON_RE = /^failed:[a-z0-9-]{1,40}$/
const KINDS = new Set(['recover', 'step'])
const BODIES = new Set(['any', 'mineflayer', 'baritone'])
const CONTROLS = new Set(['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak'])
const FACADE_OPS = ['pos', 'blockAt', 'findBlocks', 'inventory', 'count', 'health', 'food', 'time', 'entities', 'status',
  'dig', 'place', 'goto', 'stop', 'control', 'lookAt', 'equip']

function enabled(env) {
  const raw = String((env && env.BOT_SKILLS) || '').trim().toLowerCase()
  return raw === '1' || raw === 'true' || raw === 'yes'
}

// Header: the first block comment, `/* skill {json} */`.
function parseHeader(text) {
  const m = /^\s*\/\*\s*skill\s*(\{[\s\S]*?\})\s*\*\//.exec(text)
  if (!m) throw new Error('no header')
  const meta = JSON.parse(m[1])
  if (!meta || typeof meta !== 'object') throw new Error('bad header')
  if (typeof meta.name !== 'string' || !NAME_RE.test(meta.name)) throw new Error('bad name')
  if (typeof meta.description !== 'string' || !meta.description.trim()) throw new Error('no description')
  if (!KINDS.has(meta.kind)) throw new Error('bad kind')
  if (meta.body === undefined) meta.body = 'any'
  if (!BODIES.has(meta.body)) throw new Error('bad body')
  return meta
}

function num(v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error('bad number')
  return v
}

function short(e) {
  return String((e && e.message) || e).slice(0, 80)
}

function cellAt(bot, x, y, z) {
  return bot.blockAt(new Vec3(Math.floor(num(x)), Math.floor(num(y)), Math.floor(num(z))))
}

function solid(b) {
  return !!b && b.boundingBox === 'block'
}

// One in-flight async act per skill, across episodes (the yvi rule: never
// two placements). `live()` throws once the episode lost the body (step
// replaced, recovery over, terminal tick): an act never lands after that.
function fire(c, kind, fn) {
  const act = c.act
  if (act.busy) return 'busy'
  act.busy = kind
  c.hs.err = null
  const live = () => { if (!c.alive()) throw new Error('episode over') }
  Promise.resolve().then(() => fn(live)).catch((e) => { c.hs.err = `${kind}: ${short(e)}` }).finally(() => { act.busy = null })
  return 'started'
}

const PLACE_REFS = [[0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0]]

// Host side of the bridge: op name + plain args -> plain JSON value.
const OPS = {
  pos(c) {
    const p = botPos(c.bot)
    return p ? { x: p.x, y: p.y, z: p.z, onGround: !!(c.bot.entity && c.bot.entity.onGround) } : null
  },
  blockAt(c, x, y, z) {
    const b = cellAt(c.bot, x, y, z)
    return b ? { name: b.name, solid: solid(b), x: b.position.x, y: b.position.y, z: b.position.z } : null
  },
  findBlocks(c, names, maxDistance = 16, count = 16) {
    if (!Array.isArray(names) || names.length > 64) throw new Error('names must be an array of <=64')
    const want = new Set(names.map(String))
    const found = c.bot.findBlocks({ matching: (b) => !!b && want.has(b.name), maxDistance: Math.min(num(maxDistance), 32), count: Math.min(num(count), 64) }) || []
    return found.map((p) => ({ x: p.x, y: p.y, z: p.z }))
  },
  inventory(c) {
    const out = {}
    for (const it of c.bot.inventory.items()) out[it.name] = (out[it.name] || 0) + it.count
    return out
  },
  count(c, name) {
    let n = 0
    for (const it of c.bot.inventory.items()) if (it.name === name) n += it.count
    return n
  },
  health: (c) => c.bot.health,
  food: (c) => c.bot.food,
  time: (c) => (c.bot.time ? c.bot.time.timeOfDay : null),
  entities(c, radius = 16) {
    const p = botPos(c.bot)
    if (!p) return []
    const r = Math.min(num(radius), 32)
    const out = []
    for (const e of Object.values(c.bot.entities || {})) {
      if (!e || e === c.bot.entity || !e.position) continue
      if (Math.hypot(e.position.x - p.x, e.position.y - p.y, e.position.z - p.z) > r) continue
      out.push({ name: e.name || null, type: e.type || null, username: e.username || null, x: e.position.x, y: e.position.y, z: e.position.z })
      if (out.length >= 32) break
    }
    return out
  },
  status(c) {
    let moving = false
    try { moving = !!(c.bot.pathfinder && c.bot.pathfinder.isMoving()) } catch (_) { moving = false }
    return { busy: c.act.busy, err: c.hs.err, path: c.ctx.lastPathStatus || null, moving }
  },
  dig(c, x, y, z) {
    const b = cellAt(c.bot, x, y, z)
    if (!b) return 'denied:unloaded'
    if (!solid(b)) return 'denied:air'
    const why = denyReason(c.bot, b, c.ctx)
    if (why) { logDeny(b, why); return `denied:${why}` }
    return fire(c, 'dig', (live) => { live(); return c.bot.dig(b) })
  },
  // Place `item` INTO cell x,y,z against any solid neighbour.
  place(c, x, y, z, item) {
    const cell = { x: Math.floor(num(x)), y: Math.floor(num(y)), z: Math.floor(num(z)) }
    if (solid(cellAt(c.bot, cell.x, cell.y, cell.z))) return 'denied:occupied'
    if ((c.ctx.castle && castle.yardRing(c.ctx.castle, cell)) || castle.inCastleApron(c.ctx, cell)) return 'denied:place-protected'
    const stack = c.bot.inventory.items().find((it) => it.name === item)
    if (!stack) return 'denied:no-item'
    for (const [dx, dy, dz] of PLACE_REFS) {
      const ref = cellAt(c.bot, cell.x + dx, cell.y + dy, cell.z + dz)
      if (!solid(ref) || isInteractRef(ref.name)) continue
      const face = new Vec3(-dx, -dy, -dz)
      return fire(c, 'place', async (live) => {
        live()
        await c.bot.equip(stack, 'hand')
        live()
        await c.bot.placeBlock(ref, face)
      })
    }
    return 'denied:no-reference'
  },
  // Idempotent (3nt.19): setGoal resets the path, so the same target with a
  // live goal is not re-issued; the skill: key lets stopOnce and the hand
  // steps' key dedupe see the skill's goal (issueGoal, like every walker).
  goto(c, x, y, z, range = 1) {
    const r = Math.max(0, num(range))
    // The cell, like GoalNear (floors): a float target (pos()/entities()) keeps one key (revmux 03).
    x = Math.floor(num(x)); y = Math.floor(num(y)); z = Math.floor(num(z))
    const key = `skill:${c.name}:${x},${y},${z},${r}`
    // Own goal object, per episode: a raw-setGoal walker (castle, build)
    // may have replaced it under a stale key (revmux 02).
    if (c.hs.goalKey === key && c.bot.pathfinder.goal === c.hs.goal) return 'moving'
    body.movementsFor((c.ctx.body && c.ctx.body.owner) || 'idle', c.bot, c.ctx)
    const g = new goals.GoalNear(x, y, z, r)
    issueGoal(c.bot, c.ctx, g, key, false)
    c.hs.goal = g
    c.hs.goalKey = key
    return 'started'
  },
  stop(c) {
    try { clearGoal(c.bot, c.ctx) } catch (_) { /* best-effort */ }
    releaseControls(c.bot)
    return 'ok'
  },
  control(c, name, on) {
    if (!CONTROLS.has(name)) throw new Error('bad control')
    c.bot.setControlState(name, !!on)
    return 'ok'
  },
  lookAt(c, x, y, z) {
    Promise.resolve(c.bot.lookAt(new Vec3(num(x), num(y), num(z)), true)).catch(() => { /* look best-effort */ })
    return 'ok'
  },
  equip(c, item, dest = 'hand') {
    if (dest !== 'hand' && dest !== 'off-hand') throw new Error('bad dest')
    const stack = c.bot.inventory.items().find((it) => it.name === item)
    if (!stack) return 'denied:no-item'
    return fire(c, 'equip', (live) => { live(); return c.bot.equip(stack, dest) })
  },
}

function releaseControls(bot) {
  for (const n of CONTROLS) {
    try { bot.setControlState(n, false) } catch (_) { /* best-effort */ }
  }
}

// Built INSIDE the context: `host` lives only in this closure.
const PRELUDE = `(function (host, ops) {
  'use strict'
  const P = JSON.parse, S = JSON.stringify
  const f = {}
  for (const op of ops) {
    f[op] = (...a) => {
      const r = P(host(op, S(a)))
      if (r.err) throw new Error(op + ': ' + r.err)
      return r.v
    }
  }
  globalThis.bot = Object.freeze(f)
})`

// Body -> script source whose completion value is always a primitive.
function guarded(body) {
  return `(() => { try { ${body} } catch (e) { let m = '?'; try { m = String(e && e.message).slice(0, 80) } catch (_) {} return '\\0' + m } })()`
}

// A rejected skill-realm promise (async run/feasible, a stray
// Promise.reject) is the skill's problem, not a process crash: swallowed
// here, every other rejection rethrown as Node's default would. Installed
// only when skills load, so the flag-off process is untouched.
const SKILL_PROMISES = new Set()
function skillPromise(p) {
  for (let o = p, i = 0; o && i < 16; i++) {
    if (types.isProxy(o)) return true // host promises are never proxied
    o = Object.getPrototypeOf(o)
    if (SKILL_PROMISES.has(o)) return true
    if (o === Promise.prototype) return false
  }
  return true // no host Promise.prototype on the chain: not ours
}
function onRejection(reason, p) {
  if (skillPromise(p)) { console.log('skill unhandled-rejection swallowed'); return }
  throw reason
}

function compile(file, text, env) {
  const meta = parseHeader(text)
  const want = env && env.BOT_BODY === 'baritone' ? 'baritone' : 'mineflayer'
  if (meta.body !== 'any' && meta.body !== want) return { meta, skip: `body=${meta.body}` }
  const g = vm.createContext(vm.constants.DONT_CONTEXTIFY, {
    name: `skill:${meta.name}`,
    codeGeneration: { strings: false, wasm: false },
    microtaskMode: 'afterEvaluate',
  })
  let cur = null // { bot, ctx, hs, act, alive } while run() runs; feasible() reads facts only
  const act = { busy: null } // per skill, outlives an episode while an act is in flight
  const host = (op, argsJson) => {
    try {
      if (!cur) return '{"err":"inactive"}'
      if (!Object.hasOwn(OPS, op)) return '{"err":"unknown op"}'
      const v = OPS[op](cur, ...JSON.parse(argsJson))
      return JSON.stringify({ v: v === undefined ? null : v })
    } catch (e) {
      return JSON.stringify({ err: short(e) })
    }
  }
  vm.runInContext(PRELUDE, g, { timeout: CALL_MS })(host, FACADE_OPS)
  SKILL_PROMISES.add(vm.runInContext('Promise.prototype', g)) // intrinsic, before skill code
  if (!process.listeners('unhandledRejection').includes(onRejection)) process.on('unhandledRejection', onRejection)
  const script = new vm.Script(text, { filename: file }) // a SyntaxError here is host-realm
  const t0 = Date.now()
  let ok
  try {
    script.runInContext(g, { timeout: CALL_MS })
    ok = vm.runInContext('typeof feasible === "function" && typeof run === "function"', g, { timeout: CALL_MS })
  } catch (_) { // never read a context-thrown value on the host (getters)
    throw new Error(Date.now() - t0 >= CALL_MS ? 'top-level timed out' : 'top-level threw')
  }
  if (ok !== true) throw new Error('feasible/run missing')
  // The host never touches a context object (a skill getter/setter/Proxy
  // would run outside the timeout and wedge the tick, security review 03):
  // input is a literal in the script source, output is the script's
  // completion value, and throws are flattened to a '\0msg' string inside
  // the timed script.
  const runScript = new vm.Script(guarded('const o = run(bot, __st); return typeof o === "string" ? o : null'))
  const resetScript = new vm.Script(guarded('globalThis.__st = {}; return null'))

  // -> { out } | { error: 'skill-timeout' | 'skill-error', msg }
  function call(scr, c) {
    cur = c
    const t = Date.now()
    try {
      const out = scr.runInContext(g, { timeout: CALL_MS })
      if (typeof out === 'string' && out[0] === '\0') return { error: 'skill-error', msg: out.slice(1) }
      return { out }
    } catch (_) {
      // Only the timeout (host error) or a context overflow lands here; no property reads.
      return Date.now() - t >= CALL_MS ? { error: 'skill-timeout', msg: `timed out after ${CALL_MS}ms` } : { error: 'skill-error', msg: 'threw' }
    } finally {
      cur = null
    }
  }

  const sk = {
    meta,
    name: meta.name,
    feasible(facts) {
      let json = '{}'
      try { json = JSON.stringify(facts) || '{}' } catch (_) { json = '{}' }
      // ponytail: one compile per feasible call (facts are a few KB).
      // Strictly `true`: an async feasible (a Promise) is not feasible.
      const r = call(new vm.Script(guarded(`return feasible(JSON.parse(${JSON.stringify(json)})) === true`)), null)
      if (r.error) {
        console.log(`skill feasible-error skill=${meta.name} outcome=${r.error} msg=${JSON.stringify(r.msg)}`)
        return { error: r.error }
      }
      return r.out === true
    },
    // A failing reset (skill setter on __st) only leaves run() its old state.
    reset() { call(resetScript, null) },
    // One tick: 'running' | 'done' | 'failed:<reason>'. Terminal outcomes
    // count, log and release the controls the skill may hold.
    tick(bot, ctx, st) {
      let out
      if (++st.ticks > TICK_BUDGET[meta.kind]) {
        out = 'failed:skill-timeout'
      } else {
        const alive = () => !st.dead && (!st.alive || st.alive())
        const r = call(runScript, { bot, ctx, hs: st.hs, act, alive, name: meta.name })
        if (r.error) {
          out = `failed:${r.error}`
          console.log(`skill error skill=${meta.name} outcome=${r.error} msg=${JSON.stringify(r.msg)}`)
        } else {
          out = r.out
          if (out !== 'running' && out !== 'done' && !(typeof out === 'string' && REASON_RE.test(out))) out = 'failed:skill-error'
        }
      }
      if (out !== 'running') {
        st.dead = true // an act still in flight never lands (fire live())
        // A started dig finishes on mineflayer's timer: cancel ours (codex 03 P2).
        // ponytail: a replaced episode (no terminal tick) keeps its dig, like a hand primitive's.
        if (act.busy === 'dig') { try { bot.stopDigging() } catch (_) { /* best-effort */ } }
        releaseControls(bot)
        // A goal the skill left live dies with it (a stale goal re-wedges: yvi).
        if (typeof ctx.lastGoalKey === 'string' && ctx.lastGoalKey.startsWith('skill:')) {
          try { clearGoal(bot, ctx) } catch (_) { /* best-effort */ }
        }
        const reason = failReason(out)
        const label = out === 'done' ? 'done' : (reason === 'skill-timeout' || reason === 'skill-error') ? reason : 'failed'
        metrics.skillRuns.inc({ skill: meta.name, outcome: label })
        console.log(`skill run skill=${meta.name} kind=${meta.kind} outcome=${out} ticks=${st.ticks}`)
      }
      return out
    },
  }
  return { meta, sk }
}

// --- registration ---

function skillBanned(ctx, name) {
  const b = ctx && ctx.recovery && ctx.recovery.skillBans
  return !!(b && b[name])
}

function banSkill(ctx, name) {
  const rec = ctx && ctx.recovery
  if (rec) (rec.skillBans || (rec.skillBans = {}))[name] = true
}

function registerRecover(sk, tables) {
  const { recover, BEHAVIOURS } = tables
  const name = sk.name
  // Cross-episode spot memory (vmzq.47/i4wm): RECOVER_BAN_FAILS same-spot
  // fails, or that many flat boxed dones (a false 'done' in a pit), ban it
  // there like a hand shuffle — release() never latches while boxed and
  // relies on these bans to bound the re-fire.
  recover.RECOVER_BANNABLE.add(name)
  recover.RECOVER_SHUFFLE.add(name)
  recover.RECOVER_MENU[name] = {
    // A skill that failed (any reason) is out for the rest of the episode;
    // a throwing/looping feasible bans it too.
    feasible: (facts, ctx) => {
      if (skillBanned(ctx, name) || recover.recoverBanned(ctx, name)) return false
      const ok = sk.feasible(facts)
      if (ok && ok.error) { banSkill(ctx, name); return false }
      return ok === true
    },
    run: (bot, ctx) => {
      const rec = ctx.recovery
      if (!rec.st) {
        const st = { skill: name, ticks: 0, hs: { busy: null, err: null } }
        st.alive = () => ctx.recovery === rec && rec.st === st && rec.action === name
        rec.st = st
        sk.reset()
      }
      const out = sk.tick(bot, ctx, rec.st)
      if (out !== 'running' && out !== 'done') banSkill(ctx, name)
      return out
    },
    verb: sk.meta.verb || name.replace(/_/g, ' '),
  }
  recover.RECOVER_ORDER.push(name)
  recover.RECOVER_CRITERIA[name] = sk.meta.description
  recover.RECOVER_SKILLS.add(name)
  BEHAVIOURS[name] = (bot, ctx) => recover.run(bot, ctx)
}

// Step state per ctx, keyed to the step instance (step.js stepGen).
const stepState = new WeakMap()

function registerStep(sk, tables) {
  const { goal, STEP_ORDER, BEHAVIOURS } = tables
  const name = sk.name
  const verb = sk.meta.verb || name.replace(/_/g, ' ')
  let broken = false // a throwing/looping step feasible is off for the process (logged once)
  goal.MENU[name] = {
    feasible: (facts) => {
      if (broken) return false
      const ok = sk.feasible(facts)
      if (ok && ok.error) broken = true
      return ok === true
    },
    chat: () => `on my own: ${verb}`,
    verb,
  }
  // Before rest ("nothing else fits"): the FSM reaches a skill only when no
  // hand step is feasible; the model sees it on every menu it is on.
  const at = STEP_ORDER.indexOf('rest')
  STEP_ORDER.splice(at < 0 ? STEP_ORDER.length : at, 0, name)
  goal.STEP_CRITERIA[name] = sk.meta.description
  BEHAVIOURS[name] = (bot, ctx) => {
    const gen = stepGen(ctx)
    let st = stepState.get(ctx)
    if (!st || st.gen !== gen || st.skill !== name) {
      st = { gen, skill: name, ticks: 0, hs: { busy: null, err: null }, over: false }
      const me = st
      me.alive = () => stepState.get(ctx) === me && stepGen(ctx) === gen && ctx.step === name
      stepState.set(ctx, st)
      sk.reset()
    }
    if (st.over) return // finished; decide() re-picks next tick
    const out = sk.tick(bot, ctx, st)
    if (out === 'running') return
    st.over = true
    if (out === 'done') stepDone(ctx, gen)
    else stepFailed(ctx, failReason(out), gen)
  }
}

let loaded = null

// Load every skill once per process (createTicker runs per join). Promoted
// dir first, so a SKILLS_DIR copy of a promoted name is skipped.
// Deferred requires: the tables' modules load inside the behaviours chain.
function load(env = process.env, opts = {}) {
  if (loaded && !opts.force) return loaded
  const recover = require('./behaviours/recover')
  const goal = require('./goal')
  const { STEP_ORDER } = require('./plan-consts')
  const { BEHAVIOURS } = require('./behaviours/index')
  const tables = { recover, goal, STEP_ORDER, BEHAVIOURS }
  const dirs = [opts.promotedDir || PROMOTED_DIR, env && env.SKILLS_DIR].filter(Boolean)
  const names = []
  for (const dir of dirs) {
    let files = []
    try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.js')).sort() } catch (_) { continue }
    for (const f of files) {
      const file = path.join(dir, f)
      try {
        const { meta, sk, skip } = compile(file, fs.readFileSync(file, 'utf8'), env)
        if (skip) { console.log(`skill skip file=${f} reason=${skip}`); continue }
        if (BEHAVIOURS[meta.name] || recover.RECOVER_MENU[meta.name] || goal.MENU[meta.name]) {
          console.log(`skill skip file=${f} reason=name-taken name=${meta.name}`)
          continue
        }
        if (meta.kind === 'recover') registerRecover(sk, tables)
        else registerStep(sk, tables)
        names.push(meta.name)
      } catch (e) {
        console.log(`skill skip file=${f} reason=${JSON.stringify(short(e))}`)
      }
    }
  }
  console.log(`skills loaded n=${names.length} names=${names.join(',') || 'none'}`)
  loaded = names
  return names
}

module.exports = { enabled, load, parseHeader, compile, CALL_MS, TICK_BUDGET, PROMOTED_DIR }
