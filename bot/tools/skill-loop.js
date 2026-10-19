'use strict'

// Voyager-style skill loop on our stack (idkcraft-vf8e.3). One scenario:
// a stuck-spots.json spot with a hand primitive/step sabotaged, so the
// model must write the missing skill. The loop is Voyager's action agent
// with the rig as the critic: prompt (skill contract + scenario + last
// attempt's code, verdict and log) -> one Messages API call -> the host
// writes ONLY <SKILLS_DIR>/<skill>.js -> one micro-run on a kept rig
// (stuck-run.sh REPLAY_KEEP=1, vf8e.1) -> green (exit 0) or the next attempt.
//
//   node tools/skill-loop.js <scenario> [max-attempts=6]
//
// Scenarios: tools/skill-scenarios.json. Key: ANTHROPIC_API_KEY, else stash
// secrets/minecraft/anthropic-api-key (never printed). Every call goes
// through brain.llmCall (vf8e.5: usage metrics + LLM_TOKENS_PER_HOUR cap,
// default 200k/h; the spike's heaviest scenario used ~95k. A longer run
// that hits it ends as exit 2 — raise it, or LLM_TOKENS_PER_HOUR=0 = off).
// Model SKILL_LOOP_MODEL (default claude-opus-5-5), effort SKILL_LOOP_EFFORT
// (default medium), max_tokens 32000 (thinking included). Work dir SKILL_LOOP_DIR (default /tmp/idkcraft-skill-loop/
// <scenario>): skills/, spots.json, keeper.log, attempt-N.log, result.json.
// The keeper boots under RIG_LOCK_WAIT (default 7200 s: the laptop slot is
// shared) and is torn down when the loop ends, green or not.
// Curriculum mode (idkcraft-vf8e.10, tools/curriculum.sh): SKILL_LOOP_SCENARIOS
// + SKILL_LOOP_SPOTS point at a proposed scenario.json + spots.json (default
// the committed tables), and SKILL_LOOP_RIG=<slot> reuses the runner's kept
// rig instead of booting. Proposed spots have no baseline entry, so inner
// runs record without judging (REPLAY_BASELINE_OFF=1) and the replay row
// decides: reached with no page is green.
// Output: one row per attempt plus
//   SKILL-LOOP <scenario> GREEN|RED attempts=<n> wall=<s>s in=<t> out=<t> cost=$<usd>
// Exit 0 green, 1 red after max attempts, 2 environment failure.
// ponytail: one user message per call (last code + feedback, Voyager's
// shape), no tool use — the host owns file writes and the rig.

const fs = require('node:fs')
const path = require('node:path')
const { spawn, spawnSync, execFileSync } = require('node:child_process')

const BOT = path.join(__dirname, '..')
const MODEL = process.env.SKILL_LOOP_MODEL || 'claude-opus-5-5'
// medium = Opus 5.5's own default; high spent the whole 16k on thinking
// (first live attempt: answer cut at max_tokens after 164 s).
const EFFORT = process.env.SKILL_LOOP_EFFORT || 'medium'
const MAX_TOKENS = 32000
// vf8e.4: SKILL_LOOP_VERIFY=<skill.js> re-verifies a written skill — no
// model call, the file is attempt 1 — on this tree and REPLAY_BODY, for a
// fresh result.json (sha, body) that skill-promote.js reads.
const VERIFY = process.env.SKILL_LOOP_VERIFY || ''
// $ per 1M tokens in/out (claude-api skill table, 2026-10-06).
const PRICE = { 'claude-opus-5-5': [4, 20], 'claude-sonnet-5-5': [2, 10], 'claude-haiku-5-5': [0.1, 0.5] }

// idkcraft-vf8e.10: the nightly curriculum runner (tools/curriculum.sh)
// points the loop at a proposed scenario + spots file. Defaults keep
// `node tools/skill-loop.js water-climb 6` on the committed table.
// SKILL_LOOP_RIG=<slot> reuses the runner's kept rig: no boot, attempt 0 is
// an inner run without a skill on it, no teardown.
function loopFiles(env = process.env) {
  return {
    scenarios: env.SKILL_LOOP_SCENARIOS || path.join(__dirname, 'skill-scenarios.json'),
    spots: env.SKILL_LOOP_SPOTS || path.join(__dirname, 'stuck-spots.json'),
    rig: env.SKILL_LOOP_RIG || '',
    curriculum: Boolean(env.SKILL_LOOP_SPOTS),
  }
}

// Curriculum rows (proposed AUTO spots) have no baseline entry, so the exit
// code never goes green: the replay JSON is the verdict — reached with no
// page. Null when the file is missing or unparsable.
function readRow(file) {
  try {
    const rows = JSON.parse(fs.readFileSync(file, 'utf8'))
    return Array.isArray(rows) ? rows[0] || null : null
  } catch (_) { return null }
}

function rowText(row) {
  return `${row.spot}: reached=${row.reached} stuck=${row.stuck} eps=${row.eps} calls=${row.call}` +
    (row.orderLine ? ` order=${JSON.stringify(String(row.orderLine).slice(0, 120))}` : '')
}

function cost(tin, tout, model = MODEL) {
  const p = PRICE[model]
  return p ? (tin * p[0] + tout * p[1]) / 1e6 : NaN
}

// The last fenced block in the answer, else the whole text.
function extractCode(text) {
  const all = [...String(text).matchAll(/```(?:js|javascript)?[ \t]*\n([\s\S]*?)```/g)]
  return (all.length ? all[all.length - 1][1] : String(text)).trim() + '\n'
}

// Env feedback for the model: the verdict, the spot's own lines and the
// recover/skill/step trail, last LOG_LINES lines.
const LOG_LINES = 120
const KEEP = /BASELINE|baseline|micro-run|verdict|sabotage|recover |skill|shelter|stuck|on my own|reached|TIMEOUT|OPEN|CLOSED|error|Error|chat|step|page|gave-up|KIT|here/
function feedback(out, spot) {
  const lines = String(out).split('\n').filter((l) => KEEP.test(l) || l.includes(spot))
  return lines.slice(-LOG_LINES).map((l) => l.slice(0, 300)).join('\n')
}

function verdictLine(out) {
  const lines = String(out).split('\n')
  const pick = lines.filter((l) => /^BASELINE |^micro-run: exit|^keep: first run exit|^baseline: /.test(l))
  return pick.join(' | ').slice(0, 400) || '(no verdict line)'
}

function apiKey() {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY
  const kv = path.join(process.env.HOME || '', '.local/bin/kv')
  try { return execFileSync(fs.existsSync(kv) ? kv : 'kv', ['get', 'secrets/minecraft/anthropic-api-key'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() } catch (_) { return '' }
}

// What the facts passed to feasible() mean, from the source itself.
function factsDoc(kind) {
  if (kind === 'recover') {
    const r = require('../src/behaviours/recover')
    return 'feasible(facts) receives this object (recover.js recoverFacts):\n' + r.recoverFacts.toString() +
      '\n\nHand primitives still on the menu (name: criterion):\n' + Object.keys(r.RECOVER_MENU).map((n) => `${n}: ${r.RECOVER_CRITERIA[n] || ''}`).join('\n')
  }
  const g = require('../src/goal')
  const src = g.goalFacts.toString()
  const ret = src.slice(src.lastIndexOf('return {'))
  return 'feasible(facts) receives goal.js goalFacts(bot, ctx). Its keys:\n' + ret +
    "\ntime is 'day'|'dusk'|'night' (goal.js timeWord below); inside is 'yes'|'no'; home is 'none'|'site'|'built'; pickaxe/sword/scaffold/logs/planks are counts.\n" +
    g.timeWord.toString() + '\n\nHand steps (name: criterion) — the FSM tries them in this order and a step skill comes just before rest, unless its header `before` names a later hand step (never at or above shelter):\n' +
    g.STEP_ORDER.map((n) => `${n}: ${g.STEP_CRITERIA[n] || ''}`).join('\n')
}

function system(sc) {
  return 'You write ONE skill file for a Minecraft bot (mineflayer on a Paper 26.1.2 server). The file contract, the sandbox and the ' +
    'whole `bot` facade are below; nothing else exists inside the skill. run(bot, st) is called once per bot tick (about 1 s) and must ' +
    "return at once: start an act, return 'running', and poll bot.status() on later ticks. A verifier runs your file on a real server " +
    'and reports the verdict and the bot log; you get that report and your previous file on the next attempt.\n' +
    `Required header: name "${sc.skill}", kind "${sc.kind}". Reply with ONE \`\`\`js block holding the complete file, header first, and no prose. Keep it small (well under 200 lines).\n\n` +
    fs.readFileSync(path.join(BOT, 'skills', 'README.md'), 'utf8')
}

function prompt(sc, spot, prev) {
  const parts = [
    `TASK: ${sc.task}`,
    'SCENARIO (rig spot: spawn = where the bot starts, goal = where it must get to, prep = the server commands that build the arena, kit = what it carries):\n' +
      JSON.stringify(spot),
    factsDoc(sc.kind),
  ]
  if (prev.code) parts.push(`YOUR PREVIOUS FILE (attempt ${prev.n}):\n\`\`\`js\n${prev.code}\`\`\``)
  parts.push(`VERIFIER REPORT (${prev.code ? `attempt ${prev.n}` : 'the run without your skill'}): ${prev.verdict}\nBot log (filtered):\n${prev.log}`)
  return parts.join('\n\n')
}

// Compile with the real loader before spending a rig run.
function check(sc, file, code) {
  const { compile } = require('../src/skills')
  try {
    const { meta, skip } = compile(file, code, { BOT_BODY: process.env.REPLAY_BODY })
    if (skip) return `compile: skipped (${skip})`
    if (meta.name !== sc.skill || meta.kind !== sc.kind) return `compile: header must say name "${sc.skill}" kind "${sc.kind}" (got ${meta.name}/${meta.kind})`
    return null
  } catch (e) {
    return `compile: ${String((e && e.message) || e).slice(0, 200)}`
  }
}

function startKeeper(env, spotsFile, log) {
  return new Promise((resolve, reject) => {
    const k = spawn('sh', ['tools/stuck-run.sh', 'paper-base', spotsFile], { cwd: BOT, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let done = false
    const on = (d) => {
      out += d
      fs.appendFileSync(log, d)
      const m = /kept: rig (\S+) up/.exec(out)
      if (m && !done) { done = true; resolve({ k, rig: m[1], out }) }
    }
    k.stdout.on('data', on)
    k.stderr.on('data', on)
    k.on('exit', (rc) => { if (!done) { done = true; reject(new Error(`keeper exited ${rc} before kept: (see ${log})`)) } })
  })
}

function stopKeeper(k) {
  if (!k || k.exitCode !== null) return Promise.resolve()
  return new Promise((resolve) => {
    const t = setTimeout(resolve, 180000)
    k.on('exit', () => { clearTimeout(t); resolve() })
    try { k.kill('SIGTERM') } catch (_) { resolve() }
  })
}

async function main() {
  const [name, maxArg] = process.argv.slice(2)
  const max = Number(maxArg || 6)
  const files = loopFiles()
  const scList = JSON.parse(fs.readFileSync(files.scenarios, 'utf8'))
  const sc = (Array.isArray(scList) ? scList : []).find((s) => s && s.name === name)
  if (!sc || !(max >= 1)) { console.log('usage: node tools/skill-loop.js <scenario> [max-attempts=6]'); return 2 }
  const spotList = JSON.parse(fs.readFileSync(files.spots, 'utf8'))
  const base = (Array.isArray(spotList) ? spotList : []).find((s) => s && s.name === sc.spot)
  if (!base) { console.log(`spot ${sc.spot} not in ${files.spots}`); return 2 }
  const spot = { ...base, sabotage: sc.sabotage }
  const key = VERIFY ? '' : apiKey()
  if (!key && !VERIFY) { console.log('no ANTHROPIC_API_KEY (stash secrets/minecraft/anthropic-api-key)'); return 2 }
  const work = process.env.SKILL_LOOP_DIR || path.join('/tmp/idkcraft-skill-loop', sc.name)
  const skillsDir = path.join(work, 'skills')
  // Read before the wipe: the file may live in this very skills dir.
  const verifyText = VERIFY ? fs.readFileSync(VERIFY, 'utf8') : ''
  fs.rmSync(skillsDir, { recursive: true, force: true })
  fs.mkdirSync(skillsDir, { recursive: true })
  const spotsFile = path.join(work, 'spots.json')
  fs.writeFileSync(spotsFile, JSON.stringify([spot]))
  const env = { ...process.env, REPLAY_SKILLS_DIR: skillsDir }
  delete env.ANTHROPIC_API_KEY // the rig bot never needs it (stub brain)
  const brain = require('../src/brain')
  const t0 = Date.now()
  const rows = []
  let keeper = null
  let green = false
  let envFail = null
  const bail = () => { stopKeeper(keeper).then(() => process.exit(130)) }
  process.on('SIGINT', bail)
  process.on('SIGTERM', bail)
  try {
    const keeperLog = path.join(work, 'keeper.log')
    fs.writeFileSync(keeperLog, '')
    let kp
    let prev
    if (files.rig) {
      // The curriculum runner's keeper is already up on this slot: attempt
      // 0 is an inner run without a skill (no skills dir), judged from the
      // replay row for proposed spots (they have no baseline entry, so the
      // exit code never goes green). Nothing is booted or torn down here.
      console.log(`skill-loop ${sc.name}: kept rig ${files.rig} (curriculum) — attempt 0 is the run without a skill`)
      const inner0 = { ...env, REPLAY_KEEP: '1', RIG_ID: files.rig, REPLAY_OUT: path.join(work, 'replay-0.json') }
      delete inner0.REPLAY_SKILLS_DIR
      if (files.curriculum) inner0.REPLAY_BASELINE_OFF = '1'
      const r0 = spawnSync('sh', ['tools/stuck-run.sh', 'paper-base', spotsFile], { cwd: BOT, env: inner0, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
      const out0 = `${r0.stdout || ''}${r0.stderr || ''}`
      fs.writeFileSync(path.join(work, 'attempt-0.log'), out0)
      kp = { k: null, rig: files.rig, out: out0 }
      if (!/^micro-run: /m.test(out0)) {
        envFail = `no kept rig ${files.rig} (rc ${r0.status})`
        prev = { n: 0, code: null, verdict: verdictLine(out0), log: feedback(out0, sc.spot) }
      } else if (files.curriculum) {
        const row0 = readRow(path.join(work, 'replay-0.json'))
        prev = { n: 0, code: null, verdict: row0 ? rowText(row0) : '(no replay row)', log: feedback(out0, sc.spot) }
        if (!row0) envFail = `no replay row in replay-0.json (rc ${r0.status})`
      } else {
        prev = { n: 0, code: null, verdict: verdictLine(out0), log: feedback(out0, sc.spot) }
      }
      console.log(`attempt 0 (no skill): ${prev.verdict}`)
    } else {
      console.log(`skill-loop ${sc.name}: booting the keeper (RIG_LOCK_WAIT=${env.RIG_LOCK_WAIT || 7200}) — attempt 0 is the run without a skill`)
      kp = await startKeeper({ ...env, REPLAY_KEEP: '1', RIG_ID: env.RIG_ID || 'auto', RIG_LOCK_WAIT: env.RIG_LOCK_WAIT || '7200', REPLAY_KEEP_IDLE: env.REPLAY_KEEP_IDLE || '900' }, spotsFile, keeperLog)
      keeper = kp.k
      const bootSecs = Math.round((Date.now() - t0) / 1000)
      prev = { n: 0, code: null, verdict: verdictLine(kp.out), log: feedback(kp.out, sc.spot) }
      console.log(`attempt 0 (no skill, keeper boot+run ${bootSecs}s): ${prev.verdict}`)
    }
    for (let n = 1; n <= max && !green && !envFail; n++) {
      const ta = Date.now()
      const body = {
        model: MODEL,
        max_tokens: MAX_TOKENS,
        thinking: { type: 'adaptive' },
        output_config: { effort: EFFORT },
        system: system(sc),
        messages: [{ role: 'user', content: prompt(sc, spot, prev) }],
      }
      let data
      try {
        data = VERIFY
          ? { usage: {}, content: [{ type: 'text', text: verifyText }] }
          : await brain.llmCall({ use: 'skill', apiKey: key, body })
      } catch (e) {
        const msg = String((e && e.message) || e)
        if (msg.startsWith('llm budget')) { envFail = `llm: ${msg}`; break }
        // A failed call is a spent attempt (its tokens are unknown), not an abort.
        rows.push({ attempt: n, in: 0, out: 0, llmSecs: Math.round((Date.now() - ta) / 1000), rigSecs: 0, rc: null, verdict: `llm error: ${msg.slice(0, 120)}` })
        console.log(`attempt ${n}: ${rows[rows.length - 1].verdict}`)
        continue
      }
      const llmSecs = Math.round((Date.now() - ta) / 1000)
      const u = data.usage || {}
      const row = { attempt: n, in: u.input_tokens || 0, out: u.output_tokens || 0, llmSecs, rigSecs: 0, rc: null, verdict: '' }
      rows.push(row)
      const text = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n')
      const code = extractCode(text)
      const file = path.join(skillsDir, `${sc.skill}.js`)
      for (const f of fs.readdirSync(skillsDir)) fs.rmSync(path.join(skillsDir, f))
      fs.writeFileSync(path.join(work, `attempt-${n}.js`), code)
      const bad = data.stop_reason === 'refusal' ? 'refusal' : data.stop_reason === 'max_tokens' ? 'answer cut at max_tokens' : check(sc, file, code)
      let log = ''
      if (bad) {
        row.verdict = bad
      } else {
        fs.writeFileSync(file, code)
        const tr = Date.now()
        const inner = { ...env, REPLAY_KEEP: '1', RIG_ID: kp.rig, REPLAY_OUT: path.join(work, `replay-${n}.json`) }
        if (files.curriculum) inner.REPLAY_BASELINE_OFF = '1'
        const r = spawnSync('sh', ['tools/stuck-run.sh', 'paper-base', spotsFile], {
          cwd: BOT,
          env: inner,
          encoding: 'utf8',
          maxBuffer: 256 * 1024 * 1024,
        })
        row.rigSecs = Math.round((Date.now() - tr) / 1000)
        const out = `${r.stdout || ''}${r.stderr || ''}`
        fs.writeFileSync(path.join(work, `attempt-${n}.log`), out)
        row.rc = r.status
        log = feedback(out, sc.spot)
        if (!/^micro-run: /m.test(out)) {
          row.verdict = verdictLine(out)
          envFail = `inner run did not reach the kept rig (rc ${r.status})`
        } else if (files.curriculum) {
          // Proposed spots have no baseline entry: the replay row decides.
          const crow = readRow(path.join(work, `replay-${n}.json`))
          row.verdict = crow ? rowText(crow) : '(no replay row)'
          if (!crow) envFail = `no replay row in replay-${n}.json (rc ${r.status})`
          else if (crow.reached === true && crow.call === 0) green = true
        } else {
          row.verdict = verdictLine(out)
          if (r.status === 0) green = true
          else if (r.status === 2) envFail = `inner run env failure: ${row.verdict}`
        }
      }
      console.log(`attempt ${n}: in=${row.in} out=${row.out} llm=${llmSecs}s rig=${row.rigSecs}s rc=${row.rc} ${row.verdict}`)
      if (envFail) break
      prev = { n, code, verdict: row.verdict, log }
    }
  } catch (e) {
    envFail = String((e && e.message) || e)
  } finally {
    await stopKeeper(keeper)
  }
  const tin = rows.reduce((a, r) => a + r.in, 0)
  const tout = rows.reduce((a, r) => a + r.out, 0)
  const wall = Math.round((Date.now() - t0) / 1000)
  let sha = '?'
  try { sha = execFileSync('git', ['-C', BOT, 'describe', '--always', '--dirty', '--abbrev=8'], { encoding: 'utf8' }).trim() } catch (_) { sha = '?' }
  const result = { scenario: sc.name, spot: sc.spot, sabotage: sc.sabotage, skill: sc.skill, model: VERIFY ? 'verify' : MODEL, effort: EFFORT, body: process.env.REPLAY_BODY || 'mineflayer', sha, green, envFail, attempts: rows.length, wall, in: tin, out: tout, cost: +cost(tin, tout).toFixed(3), rows }
  fs.writeFileSync(path.join(work, 'result.json'), JSON.stringify(result, null, 2))
  if (envFail) console.log(`skill-loop ${sc.name}: environment failure: ${envFail}`)
  console.log(`SKILL-LOOP ${sc.name} ${green ? 'GREEN' : 'RED'} attempts=${rows.length} wall=${wall}s in=${tin} out=${tout} cost=$${result.cost.toFixed(2)} (${work}/result.json)`)
  return envFail ? 2 : green ? 0 : 1
}

if (require.main === module) main().then((rc) => process.exit(rc), (e) => { console.log(e && e.stack ? e.stack : e); process.exit(2) })

module.exports = { extractCode, feedback, verdictLine, cost, check, loopFiles, readRow, rowText }
