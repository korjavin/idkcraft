'use strict'
// vf8e.25.4 intermediate proof: the REAL model drives the v2 bring executive
// (chat.js -> llm-orders.js, BOT_BODY=baritone) over a SIMULATED world. Not
// run by npm test; opt-in, bounded by LLM_TOKENS_PER_HOUR and SIM_ROUNDS.
//
//   node tools/bring-exec-sim.js [--baseline] [scenario...]
//   key: ANTHROPIC_API_KEY, else stash secrets/minecraft/anthropic-api-key
//   (never printed; request headers are never logged). Report: SIM_OUT
//   (default /tmp/bring-exec-sim-<mode>.json): replies + token usage only;
//   SIM_PROMPTS=1 adds the full system/user prompts. Each scenario runs in
//   its own node process (module state never leaks between scenarios).
// Baseline (--baseline) is WEAK: the fake bot has no mineflayer recipesFor,
// so the FSM craft rung refuses at once; it is not a faithful FSM result.
//
// What is simulated (says nothing about v2 physics or pickup): every bring /
// acquire is resolved by the table below — held -> chest -> one recipe batch
// from what the bot already holds — and a refusal names what is missing. A
// root bring's toss runs the real shareToss against a fake inventory, so
// "delivered" here only means the fake inventory decreased. Work steps are
// not modelled (they time out on the virtual clock).

const { execFileSync } = require('node:child_process')
const fs = require('node:fs')

const RECIPES = { // output: { n: yield, in: consumed, tool: held, not consumed }
  oak_planks: { n: 4, in: { oak_log: 1 } },
  stick: { n: 4, in: { oak_planks: 2 } },
  crafting_table: { n: 1, in: { oak_planks: 4 } },
  torch: { n: 4, in: { coal: 1, stick: 1 } },
  furnace: { n: 1, in: { cobblestone: 8 }, tool: ['crafting_table'] },
  iron_ingot: { n: 1, in: { raw_iron: 1, coal: 1 }, tool: ['furnace'] },
  bucket: { n: 1, in: { iron_ingot: 3 }, tool: ['crafting_table'] },
}

const SCENARIOS = {
  // Explicit counts: `bring me a X` parses as the default want (3), not 1 (F4, tracked apart).
  // Chain A: smelt + craft + chest fetch (bucket <- iron_ingot <- raw_iron/coal, furnace, table).
  'BUCKET-CHEST-SMELT': { order: 'bring me bucket 1', item: 'bucket', want: 1, inv: { cobblestone: 8, coal: 3, oak_planks: 4 }, chest: { raw_iron: 3 } },
  // Chain B: wood crafting only (torch <- stick <- planks <- logs), no chest, no smelting.
  'TORCH-FROM-LOGS': { order: 'bring me torch 4', item: 'torch', want: 4, inv: { oak_log: 2, coal: 1 }, chest: {} },
  // Bounded unavailable: nothing in the world yields diamond.
  'DIAMOND-NONE': { order: 'bring me diamond 1', item: 'diamond', want: 1, inv: { cobblestone: 4 }, chest: { dirt: 8 } },
}

function key() {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY
  try { return execFileSync(`${process.env.HOME}/.local/bin/kv`, ['get', 'secrets/minecraft/anthropic-api-key'], { encoding: 'utf8' }).trim() } catch (_) { return '' }
}

function pos(x, y, z) {
  const p = { x, y, z, distanceTo: (q) => Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z), offset: (a, b, c) => pos(x + a, y + b, z + c), clone() { return pos(p.x, p.y, p.z) } }
  return p
}

// Same fake Bot surface as test/llm-orders.test.js mockBot.
function simBot(inv) {
  // Real registry (bridge/index.js: minecraft-data for the hello mc version),
  // so chat routing and item resolution match prod; recipes stay the table above.
  const registry = require('minecraft-data')(process.env.SIM_MC || '26.1.2')
  const itemsByName = registry.itemsByName
  const items = () => Object.entries(inv).filter(([, c]) => c > 0).map(([name, count]) => ({ name, count, type: itemsByName[name] ? itemsByName[name].id : 0 }))
  const bot = {
    lines: [],
    username: 'IdkBot2',
    entities: {},
    health: 20,
    food: 20,
    time: { timeOfDay: 1000, day: 1 },
    entity: { position: pos(0, 64, 0), onGround: true },
    registry,
    players: { P: { username: 'P', entity: { position: pos(1, 64, 0) } } },
    pathfinder: { goal: null, setGoal: (g) => { bot.pathfinder.goal = g }, isMoving: () => false },
    inventory: { items },
    toss: async (tid, _m, n) => { const name = Object.keys(itemsByName).find((k) => itemsByName[k].id === tid); inv[name] = Math.max(0, (inv[name] || 0) - n) },
    chat(line) { bot.lines.push(String(line)) },
  }
  return bot
}

// One simulated attempt at holding `want` of `item`; returns null or the missing line.
function obtain(inv, chest, item, want) {
  if ((inv[item] || 0) >= want) return null
  if ((chest[item] || 0) > 0) {
    const got = Math.min(chest[item], want - (inv[item] || 0))
    chest[item] -= got
    inv[item] = (inv[item] || 0) + got
    if ((inv[item] || 0) >= want) return null
  }
  const r = RECIPES[item]
  if (!r) return `no ${item} anywhere within reach and no recipe (simulated world)`
  const batches = Math.ceil((want - (inv[item] || 0)) / r.n)
  const miss = []
  for (const [k, v] of Object.entries(r.in)) if ((inv[k] || 0) < v * batches) miss.push(`${v * batches - (inv[k] || 0)} ${k}`)
  for (const t of r.tool || []) if (!(inv[t] > 0)) miss.push(`1 ${t} (tool)`)
  if (miss.length) return `cannot make ${item}: missing ${miss.join(', ')} in the bot inventory (simulated recipe)`
  for (const [k, v] of Object.entries(r.in)) inv[k] -= v * batches
  inv[item] = (inv[item] || 0) + r.n * batches
  return null
}

async function runScenario(name, sc, baseline) {
  const envKeep = { ...process.env }
  process.env.BOT_BODY = 'baritone'
  if (baseline) delete process.env.BOT_LLM_ORDERS
  else process.env.BOT_LLM_ORDERS = '1'
  const { handleChat, createTicker } = require('../src/index')
  const llmOrders = require('../src/llm-orders')
  const bringbase = require('../src/behaviours/bringbase')
  const bringitem = require('../src/behaviours/bringitem')
  const { resetLlmBudget } = require('../src/brain')
  // The fake bot has no recipesFor: the FSM's recipe fallback is what keeps an
  // order open for the simulated obtain, but a real recipe call then races it
  // (first TORCH toss refused). Hold it pending forever, no model call.
  bringitem.setRecipeSource({ plan: () => new Promise(() => {}), enabled: () => true, timeoutMs: Infinity })
  resetLlmBudget()
  const inv = { ...sc.inv }
  const chest = { ...sc.chest }
  const bot = simBot(inv)
  const ticker = createTicker({ bot, brain: { decide: async () => ({ action: 'idle', sprint: false, source: 'stub' }) }, tickMs: 10, idleTickMs: 10 })
  const ctx = bot._tickerCtx
  const calls = []
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body)
    const res = await realFetch(url, init)
    const data = await res.clone().json().catch(() => null)
    calls.push({
      system: process.env.SIM_PROMPTS === '1' ? body.system : undefined,
      prompt: process.env.SIM_PROMPTS !== '1' ? undefined : (body.messages || []).map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n'),
      reply: data && data.content ? data.content.map((c) => c.text || '').join('') : `http ${res.status}`,
      usage: data && data.usage ? { in: data.usage.input_tokens, out: data.usage.output_tokens } : null,
    })
    return res
  }
  const log = []
  const origLog = console.log
  console.log = (...a) => { const s = a.join(' '); if (/^llm |bring/.test(s)) log.push(s) }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const settle = async () => { for (let i = 0; i < 600 && (ctx.llmAsk || (ctx.llmOrder && ctx.llmOrder.replanning)); i++) await sleep(100); for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)) }
  const events = []
  // One virtual clock for every stamp (bringEnd.at, step starts, timeouts):
  // a separate tick clock made refusals read as cancelled (lost reasons).
  const realNow = Date.now
  let now = realNow()
  Date.now = () => now
  const before = inv[sc.item] || 0
  let tossed = 0
  try {
    handleChat(bot, ticker, 'P', sc.order)
    await settle()
    const rounds = Number(process.env.SIM_ROUNDS) || 40
    for (let i = 0; i < rounds; i++) {
      if (baseline ? !ctx.bring : !ctx.llmOrder) break
      if (!baseline) { llmOrders.tick(bot, ctx); await settle() }
      const o = ctx.bring
      if (o && !o.tossInFlight) {
        const item = o.kind === 'item' && o.items && o.items[0] ? o.items[0].name : (o.drop || o.name)
        const want = o.want || 1
        const snap = { ...inv }
        const snapChest = { ...chest }
        const miss = obtain(inv, chest, item, want)
        await settle()
        // The real FSM bring may have ended this order meanwhile (e.g. its own
        // recipe rung refused): undo the simulated gain, never resolve twice.
        if (ctx.bring !== o) { for (const k of Object.keys(inv)) delete inv[k]; Object.assign(inv, snap); for (const k of Object.keys(chest)) delete chest[k]; Object.assign(chest, snapChest); events.push(`sim: ${item} order ended by the FSM before the simulated result; result discarded`); continue }
        if (miss) { events.push(`sim: ${o.self ? 'acquire' : 'bring'} ${want} ${item} -> refused: ${miss}`); bringbase.refuse(bot, ctx, miss) } else if (o.self) {
          events.push(`sim: acquire ${want} ${item} -> held ${inv[item]}`)
          bringbase.done(bot, ctx)
        } else {
          const had = inv[item] || 0
          if (o.kind !== 'item') { o.kind = 'item'; o.items = [{ name: item, count: want }] }
          bringitem.shareToss(bot, ctx, o)
          await settle()
          tossed += had - (inv[item] || 0)
          events.push(`sim: bring ${want} ${item} -> fake toss, inventory ${had} -> ${inv[item] || 0}`)
        }
        await settle()
      } else if (ctx.taskPlanStep) {
        events.push(`sim: work step ${ctx.taskPlanStep} not modelled (times out)`)
      }
      now += 60000 // virtual clock: a work step / wait times out within a few rounds
    }
  } finally {
    console.log = origLog
    Date.now = realNow
    globalThis.fetch = realFetch
    for (const k of Object.keys(process.env)) if (!(k in envKeep)) delete process.env[k]
    Object.assign(process.env, envKeep)
    try { ticker.stop && ticker.stop() } catch (_) { /* best-effort */ }
  }
  const tokens = calls.reduce((a, c) => ({ in: a.in + ((c.usage && c.usage.in) || 0), out: a.out + ((c.usage && c.usage.out) || 0) }), { in: 0, out: 0 })
  return {
    scenario: name, mode: baseline ? 'baseline (FSM order, no model)' : 'real model', world: 'SIMULATED (no physics, no pickup)',
    prerequisites: { order: sc.order, inventory: sc.inv, chest: sc.chest },
    modelCalls: calls.length, tokens, calls, events, chat: bot.lines, log: log.slice(-30),
    fakeTossed: tossed, simulatedInventoryAfter: Object.fromEntries(Object.entries(inv).filter(([, c]) => c > 0)),
    verdict: tossed >= sc.want ? `fake-toss ${tossed}/${sc.want} (inventory decrease in simulation, NOT pickup)` : `no toss (${bot.lines.slice(-1)[0] || 'silent'})`,
    _before: before,
  }
}

async function main() {
  const args = process.argv.slice(2)
  const baseline = args.includes('--baseline')
  const pick = args.filter((a) => !a.startsWith('--'))
  if (!baseline) {
    const k = key()
    if (!k) { console.log('no ANTHROPIC_API_KEY (stash secrets/minecraft/anthropic-api-key)'); return 2 }
    process.env.ANTHROPIC_API_KEY = k
  }
  const child = args.includes('--child')
  const out = []
  for (const [name, sc] of Object.entries(SCENARIOS)) {
    if (pick.length && !pick.includes(name)) continue
    let r
    if (child) r = await runScenario(name, sc, baseline)
    else {
      const res = require('node:child_process').spawnSync(process.execPath, [__filename, '--child', ...(baseline ? ['--baseline'] : []), name], { env: process.env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
      const line = (res.stdout || '').split('\n').find((l) => l.startsWith('{"scenario"'))
      if (!line) { console.log(`${name}: child failed rc=${res.status} ${(res.stderr || '').slice(-300)}`); continue }
      r = JSON.parse(line)
    }
    delete r._before
    if (child) { process.stdout.write(JSON.stringify(r) + '\n'); continue }
    out.push(r)
    console.log(`${name} [${r.mode}; ${r.world}] calls=${r.modelCalls} tokens=${r.tokens.in}/${r.tokens.out} -> ${r.verdict}`)
  }
  if (child) return 0
  const file = process.env.SIM_OUT || `/tmp/bring-exec-sim-${baseline ? 'baseline' : 'model'}.json`
  fs.writeFileSync(file, JSON.stringify(out, null, 2))
  console.log(`report: ${file}`)
  return 0
}

if (require.main === module) main().then((c) => process.exit(c), (e) => { console.error(e); process.exit(1) })
module.exports = { obtain, RECIPES, SCENARIOS }
