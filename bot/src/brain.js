'use strict'

// The one brain interface, two implementations. No classes needed.
// decide(state) -> { action: 'fight' | 'follow' | 'roam' | 'idle', sprint: bool, source }
// state = { distance_to_player, player_visible, player_moving, bot_health, bot_food, nearby_hostiles, hostile_distance, hostile_near_player, hostile_reachable }
// hostile_reachable=false comes from fight's give-up latch (unreachable mob:
// cave, glass, ravine). Missing means reachable (older callers).

const metrics = require('./metrics')

const JEV_ENDPOINT = 'https://api.typesafe.ai/v1/systemone'
const JEV_MODEL = 'jev-latest'
const LAYA_URL_DEFAULT = 'http://laya:8000/v1/systemone'
// Stall-point planner (idkcraft-vmzq.5): off the tick path, so its own
// deadline, not BRAIN_TIMEOUT_MS. 10 s since vmzq.21: the watchdog's
// commit window is 120 s, an answer later than 10 s is stale.
const PLAN_TIMEOUT_MS = 10000

// Remote-brain source name: the JEV hostname stays 'jev', anything else
// (e.g. the compose service laya) is addressed by its own hostname.
function sourceForUrl(url) {
  try {
    const host = new URL(url).hostname
    return host === 'api.typesafe.ai' ? 'jev' : host
  } catch {
    return 'jev'
  }
}

function brainTimeoutMs(env) {
  const raw = parseInt((env && env.BRAIN_TIMEOUT_MS) || (env && env.BRAIN_TICK_MS) || '1000', 10)
  return Number.isFinite(raw) ? raw : 1000
}

// Laya address for the autonomous downgrade (dxl): BRAIN_URL only when it
// does NOT point at JEV — a JEV-configured BRAIN_URL would keep the paid
// brain running under a 'laya' label. Null means off.
function layaUrl() {
  const env = process.env && process.env.BRAIN_URL
  return env && sourceForUrl(env) !== 'jev' ? env : null
}

const stubBrain = {
  name: 'stub',
  decide(state) {
    const hd = state.hostile_distance
    const near = !!state.hostile_near_player
    const health = typeof state.bot_health === 'number' ? state.bot_health : 20
    // Unreachable mob (fight gave up pursuit): yield to follow unless the mob
    // threatens the player — the arbitration the brain owns.
    const unreachable = state.hostile_reachable === false
    if (((typeof hd === 'number' && hd <= 8 && !unreachable) || near) && health >= 6) {
      return { action: 'fight', sprint: false, source: 'stub' }
    }
    const d = state.distance_to_player
    if (typeof d !== 'number') return { action: 'idle', sprint: false, source: 'stub' }
    if (typeof hd === 'number' || near) {
      // Caution: a hostile fact with too little health to fight — the legacy
      // rule (follow when far, wait when close), never roam into danger.
      if (d > 3) return { action: 'follow', sprint: d > 8, source: 'stub' }
      return { action: 'idle', sprint: false, source: 'stub' }
    }
    if (d > 6) return { action: 'follow', sprint: d > 8, source: 'stub' }
    if (state.player_moving) {
      if (d > 3) return { action: 'follow', sprint: d > 8, source: 'stub' }
      return { action: 'idle', sprint: false, source: 'stub' }
    }
    // Roam ranks last: a still player within the 6-block stroll envelope and
    // no hostile near. The envelope must span the goals roam.js picks (up to
    // 6 from the player) — with follow at d > 3, every stroll past 3 blocks
    // would be preempted and the bot would yo-yo instead of strolling.
    return { action: 'roam', sprint: false, source: 'stub' }
  }
}

function parseAction(answer) {
  const choice = answer && answer.choice
  return choice === 'fight' || choice === 'follow' || choice === 'roam' || choice === 'idle' ? choice : null
}
// roam/idle never reach the model: hybridBrain consults it only on hard
// states, and every hard case is a fight-vs-follow judgement. parseAction
// still accepts all four words (harmless: a 2-key criteria can only yield two).

// JEV `state` is documented as a string; send one compact categorical text line.
function stateToText(state) {
  if (typeof state === 'string') return state
  if (!state || typeof state !== 'object') {
    return 'player=none player_moving=no hostile=none hostile_near_player=no hostile_reachable=yes health=ok food=ok'
  }
  const d = state.distance_to_player
  const hd = state.hostile_distance
  const player = typeof d !== 'number' || Number.isNaN(d) ? 'none'
    : d <= 3 ? 'near'
    : d <= 6 ? 'far'
    : 'away'
  const playerMoving = state.player_moving ? 'yes' : 'no'
  const hostile = typeof hd !== 'number' || Number.isNaN(hd) ? 'none'
    : hd <= 3 ? 'adjacent'
    : hd <= 8 ? 'near'
    : hd < 16 ? 'far'
    : 'none'
  const hostileNearPlayer = state.hostile_near_player ? 'yes' : 'no'
  const hostileReachable = state.hostile_reachable === false ? 'no' : 'yes'
  const hp = typeof state.bot_health === 'number' ? state.bot_health : 20
  const health = hp < 6 ? 'low' : 'ok'
  const f = typeof state.bot_food === 'number' ? state.bot_food : 20
  const food = f < 6 ? 'hungry' : 'ok'
  return `player=${player} player_moving=${playerMoving} hostile=${hostile} ` +
    `hostile_near_player=${hostileNearPlayer} hostile_reachable=${hostileReachable} ` +
    `health=${health} food=${food}`
}

// Numeric state line preserved for the disagreement log and logstats.sh.
function numericStateToText(state) {
  if (typeof state === 'string') return state
  const d = state.distance_to_player
  const hd = state.hostile_distance
  return `distance_to_player=${typeof d === 'number' ? d.toFixed(1) : 'none'} ` +
    `player_visible=${!!state.player_visible} ` +
    `player_moving=${!!state.player_moving} ` +
    `bot_health=${state.bot_health} bot_food=${state.bot_food} ` +
    `nearby_hostiles=${state.nearby_hostiles} ` +
    `hostile_distance=${typeof hd === 'number' ? hd.toFixed(1) : 'none'} ` +
    `hostile_near_player=${!!state.hostile_near_player} ` +
    `hostile_reachable=${state.hostile_reachable === false ? 'false' : 'true'}`
}

// Situation error streaks: the repeat signal for the escalation ladder
// (owner direction, ef3 owns the policy). ask() counts consecutive failures
// per situation key and resets on success; bounded so a chatty caller cannot
// grow it. chooseStep passes the goal facts text as the situation.
const askErrors = new Map()
const ASK_ERROR_KEYS_MAX = 200
function streakFail(key) {
  if (!key) return 0
  const n = (askErrors.get(key) || 0) + 1
  askErrors.set(key, n)
  if (askErrors.size > ASK_ERROR_KEYS_MAX) askErrors.delete(askErrors.keys().next().value)
  return n
}
function askErrorStreak(situation) {
  return (situation && askErrors.get(situation)) || 0
}

// Stall-point planner (idkcraft-vmzq.5): one JEV choice over the feasible
// goal menu with the goal/situation/history OBJECT state (the JEV docs
// recommend object states: the material you would present to a panel of
// experts). Unlike ask(), this reads the answer's probabilities +
// confidence — the caller gates low-confidence answers back to the
// rule-based park. Laya never gets this call (fact-insensitive on menus),
// so plan() always posts to JEV, whatever URL the tick ask uses — the
// alone-exemption for plan() falls out of that: a laya-stepped-down brain
// still plans via JEV. It exists only when the JEV key is present, so
// key-absent/stub brains keep the .3 deterministic park with no new env.
// plan({ state, instructions, criteria }) -> { step, confidence,
// probabilities, source } or throws (timeout/http/invalid/error, the same
// outcome vocabulary as ask()). A single option answers directly.
function planner(apiKey, fetchFn, timeoutMs = PLAN_TIMEOUT_MS) {
  const doFetch = fetchFn || fetch
  async function plan({ state, instructions, criteria }) {
    const keys = Object.keys(criteria || {})
    if (keys.length === 0) throw new Error('jev missing plan answer')
    if (keys.length === 1) return { step: keys[0], confidence: 1, probabilities: { [keys[0]]: 1 }, source: 'single' }
    const endTimer = metrics.brainDuration.startTimer({ source: 'jev' })
    try {
      const headers = { 'Content-Type': 'application/json' }
      if (apiKey) headers.Authorization = `Bearer ${apiKey}`
      const ac = new AbortController()
      const timer = setTimeout(() => ac.abort(new DOMException('brain timeout', 'TimeoutError')), timeoutMs)
      let data
      try {
        const res = await doFetch(JEV_ENDPOINT, {
          method: 'POST',
          signal: ac.signal,
          headers,
          body: JSON.stringify({
            model: JEV_MODEL,
            state,
            questions: { action: { type: 'choice', instructions, criteria } }
          })
        })
        if (!res.ok) throw new Error(`jev http ${res.status}`)
        data = await res.json()
      } finally {
        clearTimeout(timer)
      }
      const ans = data && data.answers && data.answers.action
      const choice = ans && ans.choice
      if (typeof choice !== 'string' || !keys.includes(choice)) throw new Error('jev missing plan answer')
      const confidence = ans && typeof ans.confidence === 'number' ? ans.confidence : null
      const probabilities = ans && ans.probabilities && typeof ans.probabilities === 'object' ? ans.probabilities : null
      endTimer()
      metrics.brainRequests.inc({ source: 'jev', outcome: 'ok' })
      return { step: choice, confidence, probabilities, source: 'jev' }
    } catch (err) {
      endTimer()
      const msg = String(err && err.message ? err.message : err)
      const outcome = err && err.name === 'TimeoutError' ? 'timeout'
        : msg.startsWith('jev http') ? 'http'
        : msg.startsWith('jev missing') ? 'invalid'
        : 'error'
      metrics.brainRequests.inc({ source: 'jev', outcome })
      throw err
    }
  }
  return { plan }
}

// LLM stall-point planner (idkcraft-vhlb.2): the same plan() contract as
// planner() above, answered by a text LLM (Anthropic Messages API, plain
// fetch — no SDK) that reasons over the state instead of classifying it.
// Never on the tick path: only plan() callers (the goal watchdog / task
// plan) reach it. The answer carries no probabilities; confidence is null,
// which the TASK_PLAN_MIN_CONF gates pass (they only check numbers).
// Errors keep the planner outcome vocabulary (timeout/http/invalid/error)
// with an `llm` prefix that task.js planErrReason reads like `jev`.
const LLM_ENDPOINT = 'https://api.anthropic.com/v1/messages'
const LLM_MODEL = 'claude-haiku-5-5'
const LLM_SYSTEM = 'You are the stall-point planner of a Minecraft companion bot. ' +
  'The bot is working on a goal and its progress has stalled. Read the state and pick the ONE option ' +
  'most likely to get progress moving again. Answer with JSON only, no prose: ' +
  '{"choice": "<one of the option ids>", "reason": "<one short sentence>"}'

// LLM guardrails (idkcraft-vf8e.5): the ONE Anthropic call site — every use
// (planner today; orders/skill later) posts through llmCall(). It counts
// data.usage.input_tokens/output_tokens (the Messages API response `usage`
// object, https://docs.claude.com/en/api/messages) into a sliding-hour
// in-process budget, LLM_TOKENS_PER_HOUR (default 200000, 0 = unlimited;
// per bot process). Spent -> the call is skipped before any fetch with an
// 'llm budget exhausted' error, which task.js planErrReason reads as error ->
// the deterministic park/FSM fallback, same as any failed call today.
// ponytail: {t, n} array pruned per call (a few calls/hour); the check is
// before the fetch, so one in-flight call can overshoot the cap by its size.
const LLM_TOKENS_PER_HOUR_DEFAULT = 200000
const LLM_WINDOW_MS = 3600000
const llmSpend = []
let llmBudgetLogged = false

function llmTokensPerHour(env = process.env) {
  const raw = env.LLM_TOKENS_PER_HOUR
  if (raw === undefined || raw === '') return LLM_TOKENS_PER_HOUR_DEFAULT
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? n : LLM_TOKENS_PER_HOUR_DEFAULT
}

// Tests only: the window is module state.
function resetLlmBudget() {
  llmSpend.length = 0
  llmBudgetLogged = false
}

function hhmm(ms) {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

// llmCall({ use, apiKey, body, signal, fetchFn }) -> the parsed response JSON;
// throws 'llm budget exhausted' | 'llm http <status>' | the fetch/abort error.
async function llmCall({ use, apiKey, body, signal, fetchFn }) {
  const now = Date.now()
  while (llmSpend.length && now - llmSpend[0].t >= LLM_WINDOW_MS) llmSpend.shift()
  const cap = llmTokensPerHour()
  const used = llmSpend.reduce((a, e) => a + e.n, 0)
  if (cap > 0 && used >= cap) {
    if (!llmBudgetLogged) {
      llmBudgetLogged = true
      console.log(`llm budget exhausted until ${hhmm(llmSpend[0].t + LLM_WINDOW_MS)} (${used}/${cap} tokens/h)`)
    }
    throw new Error('llm budget exhausted')
  }
  llmBudgetLogged = false
  const payload = JSON.stringify(body)
  // A sent call that dies without usage (deadline abort mid-generation, a
  // body that never parses) may still be billed: charge the window a
  // conservative estimate (~4 chars/token in + the max_tokens ceiling out)
  // so a run of timeouts still trips the cap. The counters stay real usage.
  const charge = () => llmSpend.push({ t: Date.now(), n: Math.ceil(payload.length / 4) + (Number(body.max_tokens) || 0) })
  let res
  try {
    res = await (fetchFn || fetch)(LLM_ENDPOINT, {
      method: 'POST',
      signal,
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: payload,
    })
  } catch (err) {
    if (signal && signal.aborted) charge()
    throw err
  }
  if (!res.ok) throw new Error(`llm http ${res.status}`)
  let data
  try {
    data = await res.json()
  } catch (err) {
    charge()
    throw err
  }
  const u = (data && data.usage) || {}
  const tin = Number.isFinite(u.input_tokens) ? u.input_tokens : 0
  const tout = Number.isFinite(u.output_tokens) ? u.output_tokens : 0
  metrics.llmTokens.inc({ dir: 'in', use }, tin)
  metrics.llmTokens.inc({ dir: 'out', use }, tout)
  llmSpend.push({ t: Date.now(), n: tin + tout })
  return data
}

function llmPlanner(apiKey, fetchFn, timeoutMs = PLAN_TIMEOUT_MS, model = LLM_MODEL) {
  async function plan({ state, instructions, criteria }) {
    const keys = Object.keys(criteria || {})
    if (keys.length === 0) throw new Error('llm missing plan answer')
    if (keys.length === 1) return { step: keys[0], confidence: 1, probabilities: { [keys[0]]: 1 }, source: 'single' }
    const endTimer = metrics.brainDuration.startTimer({ source: 'llm' })
    try {
      const ac = new AbortController()
      const timer = setTimeout(() => ac.abort(new DOMException('brain timeout', 'TimeoutError')), timeoutMs)
      const user = `${instructions || 'Pick the next option.'}\n\nState:\n${JSON.stringify(state)}\n\nOptions (id: criterion):\n` +
        keys.map((k) => `${k}: ${criteria[k]}`).join('\n')
      let data
      try {
        data = await llmCall({
          use: 'planner',
          apiKey,
          signal: ac.signal,
          fetchFn,
          body: {
            model,
            max_tokens: 300,
            // A one-line menu pick: no thinking keeps it inside the 10 s deadline.
            thinking: { type: 'disabled' },
            system: LLM_SYSTEM,
            messages: [{ role: 'user', content: user }],
          },
        })
      } finally {
        clearTimeout(timer)
      }
      const text = ((data && Array.isArray(data.content) ? data.content : []).find((b) => b && b.type === 'text') || {}).text || ''
      let ans = null
      try {
        ans = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1))
      } catch (_) {
        ans = null
      }
      const choice = ans && ans.choice
      if (typeof choice !== 'string' || !keys.includes(choice)) throw new Error('llm missing plan answer')
      const reason = typeof ans.reason === 'string' ? ans.reason.replace(/\s+/g, ' ').trim().slice(0, 160) : ''
      endTimer()
      metrics.brainRequests.inc({ source: 'llm', outcome: 'ok' })
      metrics.llmCalls.inc({ use: 'planner', outcome: 'ok' })
      return { step: choice, confidence: null, probabilities: null, source: 'llm', reason }
    } catch (err) {
      endTimer()
      const msg = String(err && err.message ? err.message : err)
      const outcome = err && err.name === 'TimeoutError' ? 'timeout'
        : msg.startsWith('llm http') ? 'http'
        : msg.startsWith('llm missing') ? 'invalid'
        : msg.startsWith('llm budget') ? 'budget'
        : 'error'
      // brain_requests keeps its vocabulary: a budget skip counts as error there.
      metrics.brainRequests.inc({ source: 'llm', outcome: outcome === 'budget' ? 'error' : outcome })
      metrics.llmCalls.inc({ use: 'planner', outcome })
      throw err
    }
  }
  return { plan }
}

// Planner selection (vhlb.2): PLANNER=llm|jev; default llm when
// ANTHROPIC_API_KEY exists, else jev (which already rides every
// TYPESAFE-keyed brain). Only the llm choice changes a brain: no
// ANTHROPIC_API_KEY (prod today) returns the brain untouched, and so does a
// brain marked planner 'none' (the manual 'brain off': no paid calls).
function plannerChoice(env) {
  const e = env || {}
  if (!e.ANTHROPIC_API_KEY) return 'jev'
  return e.PLANNER === 'jev' ? 'jev' : 'llm'
}

function withPlanner(brain, env = process.env, fetchFn) {
  if (!brain || brain.planner === 'none' || plannerChoice(env) !== 'llm') return brain
  return { ...brain, planner: 'llm', ...llmPlanner(env.ANTHROPIC_API_KEY, fetchFn, PLAN_TIMEOUT_MS, env.LLM_MODEL || LLM_MODEL) }
}

// Which planner answers plan() on this brain: llm | jev | none (logs + 'brain' chat).
function plannerName(brain) {
  if (brain && brain.planner) return brain.planner
  return brain && typeof brain.plan === 'function' ? 'jev' : 'none'
}

function jevBrain(apiKey, fetchFn, timeoutMs = 1000, url = JEV_ENDPOINT) {
  const doFetch = fetchFn || fetch
  const source = sourceForUrl(url)
  // Shared ask(): one question to the smart model, label out or throw.
  // decide() below is one ask() with the combat question; goal.js step
  // choice calls ask() directly with a per-menu question. ask() never picks
  // the model (laya vs jev is the URL); it only adapts the menu shape:
  // laya answers reliably only with <=2 options (iwb stand), so a wider
  // menu becomes a yes/no chain over the options in order, first yes wins.
  async function ask({ state, instructions, criteria, labels = null, situation = '' }) {
    const keys = Object.keys(criteria || {})
    const valid = Array.isArray(labels) && labels.length ? labels : keys
    const post = async (bodyState, bodyCriteria, bodyLabels) => {
      const endTimer = metrics.brainDuration.startTimer({ source })
      try {
        const headers = { 'Content-Type': 'application/json' }
        if (apiKey) headers.Authorization = `Bearer ${apiKey}`
        // Node 22 (prod + CI): AbortSignal.timeout() runs on an unref'd timer, so a
        // process with nothing else alive exits before the abort fires (first CI
        // test run, brain.test.js 'stalled fetch'). A plain setTimeout is ref'd;
        // the reason keeps err.name === 'TimeoutError' for the outcome metric.
        const ac = new AbortController()
        const timer = setTimeout(() => ac.abort(new DOMException('brain timeout', 'TimeoutError')), timeoutMs)
        let data
        try {
          const res = await doFetch(url, {
            method: 'POST',
            signal: ac.signal,
            headers,
            body: JSON.stringify({
              model: JEV_MODEL,
              state: bodyState,
              questions: { action: { type: 'choice', instructions, criteria: bodyCriteria } }
            })
          })
          if (!res.ok) throw new Error(`jev http ${res.status}`)
          data = await res.json() // deadline covers the body read too, not just the headers
        } finally {
          clearTimeout(timer)
        }
        const choice = data && data.answers && data.answers.action && data.answers.action.choice
        if (typeof choice !== 'string' || !bodyLabels.includes(choice)) throw new Error('jev missing action answer')
        endTimer()
        metrics.brainRequests.inc({ source, outcome: 'ok' })
        return choice
      } catch (err) {
        // Same outcome vocabulary decide() always used: timeout | http |
        // invalid | error. A refused chain (all-no) is unusable, hence invalid.
        endTimer()
        const msg = String(err && err.message ? err.message : err)
        const outcome = err && err.name === 'TimeoutError' ? 'timeout'
          : msg.startsWith('jev http') ? 'http'
          : (msg.startsWith('jev missing') || msg.includes('chain exhausted')) ? 'invalid'
          : 'error'
        metrics.brainRequests.inc({ source, outcome })
        throw err
      }
    }
    try {
      if (keys.length === 0) throw new Error('jev missing action answer')
      // A single option needs no model (and laya 500s on 1-key questions):
      // answer it directly, like chooseStep's only-option.
      if (keys.length === 1) {
        if (situation) askErrors.delete(situation)
        return keys[0]
      }
      if (source !== 'jev' && keys.length > 2) {
        for (const key of keys) {
          const answer = await post(`${state} candidate=${key}`, { yes: criteria[key], no: 'another step fits better' }, ['yes', 'no'])
          if (answer === 'yes') {
            if (situation) askErrors.delete(situation)
            return key
          }
        }
        throw new Error('ask chain exhausted (all-no)')
      }
      const choice = await post(state, criteria, valid)
      if (situation) askErrors.delete(situation)
      return choice
    } catch (err) {
      streakFail(situation)
      throw err
    }
  }
  const self = {
    name: source,
    source,
    ask,
    // The stall-point planner rides every keyed brain (even a laya one):
    // plan() posts to JEV, never to the tick URL.
    ...((apiKey) ? planner(apiKey, doFetch) : {}),
    // reason is the hard-case name hybridBrain passes (isHard's answer, the
    // one fact that distinguishes the hard states); it rides the wire as a
    // leading hard=<reason> word. Sprint is NOT asked: the model answered
    // sprint 0.91 for everything, and the FSM rule (d > 8) already gets this
    // body detail right — the decision below returns the FSM's sprint.
    async decide(state, reason = '') {
      // ponytail: one call per tick, no batching/caching — upgrade path is
      // batching states if JEV cost ever matters ($0.042/M tokens; ~200
      // tokens/tick -> pennies/day).
      // Futile-ask skip (idkcraft-uig): on low-health-hostile with nobody
      // online laya answers follow ~98.5%+ (prod VL 7d: 2991 follow vs
      // <=45 fight on hostile-fact + hp<6 states) and hybrid's noplayer
      // veto converts every follow to the FSM's answer — the ask is
      // decided before it is sent. Like the only-option skip in ask(),
      // answer without the round-trip on non-jev remotes (JEV keeps its
      // judgement). The <=1.5% jitter-fight tail at hp<6 with zero
      // backup is safer as the FSM's follow/idle. No disagree line is
      // emitted (nothing was asked); hybrid logs the FSM answer with
      // source=fsm-noplayer and no veto= word.
      if (reason === 'low-health-hostile' && noPlayerOnline(state) && source !== 'jev') {
        const skip = stubBrain.decide(state)
        return { action: skip.action, sprint: skip.sprint, source: 'fsm-noplayer' }
      }
      try {
        const choice = await self.ask({
          state: `hard=${reason} ${stateToText(state)}`,
          instructions: 'Choose fight or follow. Health decides: low health always means follow.',
          criteria: {
            fight: 'health is ok: attack the mob.',
            follow: 'health is low: walk to the player and stay close.'
          },
          labels: ['fight', 'follow', 'roam', 'idle']
        })
        const action = parseAction({ choice })
        if (!action) throw new Error('jev missing action answer')
        const fsm = stubBrain.decide(state)
        if (fsm.action !== action) {
          metrics.disagreements.inc({ model: action, stub: fsm.action })
          console.error(`brain disagree source=${source} reason=${reason || 'unknown'} model=${action} stub=${fsm.action} state=${numericStateToText(state)}`)
        }
        return { action, sprint: fsm.sprint, source }
      } catch (err) {
        // 429/529 back off by falling through to the stub; the next tick
        // retries naturally. Never crash the bot because of the brain.
        // (ask() already counted the outcome; counting here too would double it.)
        console.error(`brain jev error, stub fallback: ${err && err.message ? err.message : err}`)
        const fallback = stubBrain.decide(state)
        fallback.source = 'stub-fallback'
        return fallback
      }
    }
  }
  return self
}

// Hard states are judgement calls where the fixed rule is known to conflict or
// to have failed. The FSM is a precedence chain (if fight ... else if ... else
// roam): exactly one rule fires by construction, so counting "rules that fire"
// would always say 1. Hardness is therefore named per case, each with the prod
// line that motivated it (epic catalogue H1-H4). Ordered: first match wins so
// the route log stays comparable over time. No margin bands: the model answers
// a constant today, bands would only inject noise at every boundary crossing.
// H1 low-health-hostile: hostile fact and health < 6 (fight vs follow/survive).
// H2 crowd: nearby_hostiles >= 3 with a fight target the pursuit has not
// written off (without a target the model can only phantom-fight, 82i).
// H3 hostile-vs-far-player: reachable hostile fact and distance_to_player > 8.
// No unreachable case (was H4): fight already gave up pursuit
// (fightGivenUpId), so fight is infeasible and the choice is single —
// the stub follows and the model is never asked. The H2/H3 reachable gates
// below are the same rule: an unreachable mob routes easy even in a crowd
// or far from the player (a player threat still fights via the FSM).
function isHard(state) {
  if (!state || typeof state !== 'object') return null
  const hostileFact = typeof state.hostile_distance === 'number' || !!state.hostile_near_player
  const reachable = state.hostile_reachable !== false
  if (hostileFact && state.bot_health < 6) return 'low-health-hostile'
  if (state.nearby_hostiles >= 3 && hostileFact && reachable) return 'crowd'
  if (hostileFact && reachable && state.distance_to_player > 8) return 'hostile-vs-far-player'
  return null
}

// Nobody to walk to: distance_to_player is not a number (nobody
// online, or the fact is unknown). Shared by the veto and the uig
// short-circuit so the two can never disagree on who is missing.
function noPlayerOnline(state) {
  return !state || typeof state !== 'object' || typeof state.distance_to_player !== 'number'
}

function hybridBrain(remote) {
  return {
    name: 'hybrid',
    source: remote && remote.name,
    ...((remote && typeof remote.ask === 'function') ? { ask: (q) => remote.ask(q) } : {}),
    ...((remote && typeof remote.plan === 'function') ? { plan: (q) => remote.plan(q) } : {}),
    async decide(state) {
      const fsm = stubBrain.decide(state)
      const reason = isHard(state)
      if (!reason) {
        console.log(`brain route=easy fsm=${fsm.action}`)
        metrics.routes.inc({ route: 'easy', reason: 'none' })
        return fsm
      }
      const model = await remote.decide(state, reason)
      metrics.routes.inc({ route: 'hard', reason })
      // Feasibility (idkcraft-dxl): follow walks to the player, so with
      // nobody online the model's follow is vetoed to the FSM's answer
      // (which idles without distance_to_player). Source names the veto.
      if (model.action === 'follow' && noPlayerOnline(state)) {
        console.log(`brain route=hard reason=${reason} model=follow veto=noplayer fsm=${fsm.action} source=${model.source}`)
        return { action: fsm.action, sprint: fsm.sprint, source: 'fsm-noplayer' }
      }
      console.log(`brain route=hard reason=${reason} model=${model.action} fsm=${fsm.action} source=${model.source}`)
      return model
    }
  }
}

// vhlb.5: the tick ask (laya/JEV) is out of the decision path — the A/B
// (vhlb.1) showed neither beats the stub FSM. The base brain is always the
// stub; a TYPESAFE key only adds the stall-point plan() (JEV), and
// withPlanner may swap in the LLM one. BRAIN_URL is ignored (prod still has
// it set to JEV); jevBrain/hybridBrain stay for the manual 'brain jev|laya'.
function makeBrain(env) {
  const key = env && env.TYPESAFE_API_KEY
  if (env && env.BRAIN_URL) console.log('BRAIN_URL ignored: the tick ask is retired (idkcraft-vhlb.5)')
  const b = withPlanner(key ? { ...stubBrain, ...planner(key) } : stubBrain, env)
  console.log(`brain=stub planner=${plannerName(b)}`)
  return b
}

module.exports = { stubBrain, jevBrain, makeBrain, hybridBrain, isHard, stateToText, numericStateToText, sourceForUrl, JEV_ENDPOINT, JEV_MODEL, askErrorStreak, LAYA_URL_DEFAULT, brainTimeoutMs, layaUrl, planner, PLAN_TIMEOUT_MS, llmPlanner, withPlanner, plannerChoice, plannerName, LLM_ENDPOINT, LLM_MODEL, llmCall, llmTokensPerHour, resetLlmBudget }
