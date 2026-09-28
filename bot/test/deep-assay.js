'use strict'

// Manual deep-leg assay (not run by npm test): safety rules + full leg on
// live Paper. Usage (server first!):
//   docker run ... --name idk-mc-deep ... (natural world, RCON, peaceful)
//   MC_PORT=25568 MC_CONTAINER=idk-mc-deep node test/deep-assay.js [rules|leg|band|all]
// Modes: rules = RCON-built lava/drop/bedrock/tier scenarios (each must
// fail honestly with a danger mark); leg = shortened live leg (RCON-carved
// starter shaft, 15 real steps + scan + tunnel + dig + return, iron pick
// via RCON); band = diamond Y histogram (1 column, like the ipn.2 assay).
// Exit 0/1 with PASS/FAIL lines; prints y + phase so a stall is visible.
const mineflayer = require('mineflayer')
const { pathfinder, Movements } = require('mineflayer-pathfinder')
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')
const { waitFor, sleep } = require('./e2e-util')
const deep = require('../src/behaviours/deep')
const danger = require('../src/danger')

const execFileAsync = promisify(execFile)

const MC_HOST = process.env.MC_HOST || 'localhost'
const MC_PORT = parseInt(process.env.MC_PORT || '25568', 10)
const MC_CONTAINER = process.env.MC_CONTAINER || 'idk-mc-deep'
const NAME = `DeepAssay${Math.floor(Math.random() * 10000)}`
// Prod-rate ticks (muse-7 ipn.2): the brain runs at BRAIN_TICK_MS (1000ms
// in prod), and a 250ms assay is a DIFFERENT control problem — back-off
// glides never decay between ticks, arcs never complete, and every branch
// races its own timers. The assay mirrors prod (override explicitly for
// speed, knowing races return).
const TICK_MS = parseInt(process.env.BRAIN_TICK_MS || '1000', 10)

async function rcon(cmd) {
  await execFileAsync('docker', ['exec', MC_CONTAINER, 'rcon-cli', cmd])
}

async function waitLoaded(bot, timeoutMs = 20000) {
  const end = Date.now() + timeoutMs
  for (;;) {
    try {
      if (bot.blockAt(bot.entity.position.floored().offset(0, -1, 0)) != null) return true
    } catch (_) {}
    if (Date.now() > end) return false
    await sleep(500)
  }
}

// Drive deep() until a terminal stepStatus or timeout. Returns the status.
async function drive(bot, ctx, timeoutMs, label) {
  const end = Date.now() + timeoutMs
  let lastPh = null // fail() nulls ctx.deep; the dump below needs the terminal phase
  for (;;) {
    try { deep(bot, ctx, null, {}) } catch (e) { console.error(`${label} THREW ${e.message}\n${e.stack.split('\n').slice(0, 6).join('\n')}`); return 'threw' }
    const ph = ctx.deep && ctx.deep.phase
    if (ph) lastPh = ph
    const p = bot.entity.position
    if (ph === 'return' || ph === 'return-slow' || Date.now() % 4000 < TICK_MS + 50) {
      const st = ctx.deep && ctx.deep.steps
      const top = st && st.length ? st[st.length - 1] : null
      const vv = (bot.entity && bot.entity.velocity) || {}
      const vy = typeof vv.y === 'number' ? vv.y.toFixed(2) : '?'
      const vh = (typeof vv.x === 'number' && typeof vv.z === 'number') ? Math.hypot(vv.x, vv.z).toFixed(2) : '?'
      const vg = !bot.entity || bot.entity.onGround !== false ? 'g' : 'a'
      const dg = bot.targetDigBlock && bot.targetDigBlock.position ? `${bot.targetDigBlock.position.x},${bot.targetDigBlock.position.y},${bot.targetDigBlock.position.z}` : '-'
      console.log(`${new Date().toISOString().slice(11, 19)} ${label} pos=${p.x.toFixed(1)},${p.y.toFixed(1)},${p.z.toFixed(1)} hp=${Math.round(bot.health || 0)} phase=${ph} status=${ctx.stepStatus} crumbs=${st ? st.length : '-'} crumb=${top ? `${top.x},${top.y},${top.z}` : '-'} key=${ctx.lastGoalKey} moving=${bot.pathfinder.isMoving()} stalls=${ctx.deep ? ctx.deep.stalls : '-'} vel=${vh}/${vy}${vg} dig=${dg}`)
    }
    if (ctx.stepStatus.startsWith('done') || ctx.stepStatus.startsWith('failed:')) {
      if (label === 'leg' && (ph === 'return' || lastPh === 'return')) {
        try {
          const Vec3 = require('vec3').Vec3
          const bx = Math.floor(p.x)
          const by = Math.floor(p.y)
          const bz = Math.floor(p.z)
          const rows = []
          for (const zz of [bz - 1, bz, bz + 1]) {
            for (let y = by + 1; y >= by - 2; y--) {
              const row = []
              for (let x = bx - 4; x <= bx + 4; x++) {
                let b = null
                try { b = bot.blockAt(new Vec3(x, y, zz)) } catch (_) { b = null }
                row.push(!b ? '?' : (b.name === 'air' || b.name === 'cave_air' ? '.' : (b.name.includes('diamond') ? 'D' : (b.name.includes('lava') ? 'L' : (b.name === 'water' ? 'W' : '#')))))
              }
              rows.push(`z${zz} y${y} ${row.join('')}`)
            }
          }
          console.log(`stall window around ${bx},${by},${bz}:\n${rows.join('\n')}`)
        } catch (e) { console.log(`stall window failed: ${e && e.message}`) }
      }
      return ctx.stepStatus
    }
    if (Date.now() > end) return `timeout@${ph}`
    await sleep(TICK_MS)
  }
}

function freshCtx(site) {
  return { lastGoalKey: '', stepStatus: 'running', home: site ? { site } : undefined }
}

async function rules(bot) {
  let pass = true
  // Prepare a flat stone pad at a fixed site so the mouth is deterministic:
  // anchor (sx,sz) -> mouth r=3/a=0 -> (sx, sz-3), topY = pad top.
  const sx = Math.round(bot.entity.position.x)
  const sz = Math.round(bot.entity.position.z)
  const padY = 70
  await rcon(`fill ${sx - 10} ${padY - 6} ${sz - 10} ${sx + 10} ${padY - 1} ${sz + 10} stone`)
  await rcon(`fill ${sx - 10} ${padY} ${sz - 10} ${sx + 10} ${padY + 4} ${sz + 10} air`)
  await sleep(1500)
  const mouth = { x: sx, z: sz - 3, topY: padY }
  // Step-0 cells for a +X shaft: feet/head/down at (sx+1, padY..padY+1, sz-3).
  const fx = sx + 1
  const fz = sz - 3

  async function scenario(name, setup, want) {
    await rcon(`fill ${fx - 2} ${padY - 8} ${fz - 2} ${fx + 2} ${padY + 2} ${fz + 2} stone`)
    await rcon(`fill ${sx - 2} ${padY} ${sz - 5} ${sx + 2} ${padY + 2} ${sz - 1} air`)
    await setup()
    await sleep(1000)
    const ctx = freshCtx({ x: sx, z: sz })
    await rcon(`tp ${NAME} ${mouth.x} ${mouth.topY} ${mouth.z}`)
    await sleep(1000)
    const st = await drive(bot, ctx, 90000, name)
    const marked = danger.near(ctx, { x: fx, z: fz }, 8)
    const ok = st === want && (want === 'done' ? true : marked)
    console.log(`${ok ? 'PASS' : 'FAIL'}: ${name} status=${st} marked=${marked} (want ${want}+mark)`)
    if (!ok) pass = false
  }

  // Lava/bedrock sit at step-2 feet: pickDir routes step-0 around them by
  // design, and lava adjacency would trip step-1 early — step-2 proves the
  // descend-time guard (lava fails at step 1 via the down-dig neighbour).
  const step1 = { x: sx + 3, y: padY - 2, z: fz }
  await scenario('lava', async () => { await rcon(`fill ${step1.x} ${step1.y} ${step1.z} ${step1.x} ${step1.y} ${step1.z} lava`) }, 'failed:lava')
  await scenario('drop', async () => { await rcon(`fill ${fx} ${padY - 8} ${fz} ${fx} ${padY + 1} ${fz} air`) }, 'failed:drop')
  await scenario('bedrock', async () => { await rcon(`fill ${step1.x} ${step1.y} ${step1.z} ${step1.x} ${step1.y} ${step1.z} bedrock`) }, 'failed:bedrock')

  // Tier gate: live bot at depth, stone pick, diamond remembered.
  {
    await rcon(`tp ${NAME} ${sx} -45 ${sz}`)
    await sleep(1000)
    await rcon(`give ${NAME} stone_pickaxe 1`)
    const ctx = freshCtx({ x: sx, z: sz })
    ctx.resources = { items: new Map([['k', { x: sx + 5, y: -45, z: sz, name: 'diamond_ore', at: Date.now() }]]) }
    ctx.deep = { phase: 'plan', shaft: { x: sx, z: sz, topY: 70, dx: 1, dz: 0 }, n: 115, steps: [], target: null, dug: 0, stalls: 0, lastPos: null, issuedKey: null, startDrops: { diamond: 0 }, tunnelDigs: 0, cameFrom: null }
    const st = await drive(bot, ctx, 30000, 'tier')
    const ok = st === 'failed:need-iron-pick'
    console.log(`${ok ? 'PASS' : 'FAIL'}: tier status=${st}`)
    if (!ok) pass = false
  }
  return pass
}

// Preflight: simulate deep's own descend rules down the candidate tube
// (stairCells + lava/dig/drop verdicts) and take the first column deep
// would walk. Caves fail the leg honestly by design (a breached cave
// breaks the return guarantee), so the assay picks a column deep accepts
// instead of hoping.
async function preflight(bot, sx, sz) {
  for (const y of [50, 20, -10, -30, -44]) {
    if ((bot.health || 20) < 12) {
      await rcon(`tp ${NAME} ${sx} 70 ${sz}`)
      await sleep(4000)
    }
    await rcon(`tp ${NAME} ${sx} ${y} ${sz - 3}`)
    await sleep(1200)
    await waitLoaded(bot, 15000)
  }
  const mz = sz - 3
  const shaft = { x: sx, z: mz, topY: -28, dx: 1, dz: 0 }
  const dirty = []
  for (let n = 0; n < 18; n++) {
    const st = deep.stairCells(shaft, n)
    for (const c of st.digs) {
      let b = null
      try { b = bot.blockAt(new (require('vec3').Vec3)(c.x, c.y, c.z)) } catch (_) { dirty.push([c.x, c.y, c.z, 'ERR']); continue }
      if (!b) { dirty.push([c.x, c.y, c.z, 'NULL']); continue }
      const nm = b.name || ''
      if (nm === 'water' || nm.includes('lava')) { dirty.push([c.x, c.y, c.z, nm]); continue }
      if (nm !== 'air' && nm !== 'cave_air' && b.diggable === false) { dirty.push([c.x, c.y, c.z, nm + '!']); continue }
      if (deep.lavaNear(bot, c.x, c.y, c.z)) { dirty.push([c.x, c.y, c.z, 'lava~']); continue }
      if (deep.waterNear(bot, c.x, c.y, c.z)) { dirty.push([c.x, c.y, c.z, 'water~']); continue }
      if (deep.fallingAbove(bot, c.x, c.y, c.z)) { dirty.push([c.x, c.y, c.z, 'loose~']); continue }
    }
    if (deep.dropBelow(bot, st.stand.x, st.stand.y, st.stand.z) > 1) dirty.push([st.stand.x, st.stand.y, st.stand.z, 'void'])
  }
  if (dirty.length > 0) console.log(`  dirty@${sx}:`, JSON.stringify(dirty.slice(0, 8)), dirty.length > 8 ? `+${dirty.length - 8}` : '')
  return dirty.length === 0
}

async function leg(bot) {
  // Shortened live leg: RCON-carved starter air down to y=-28, then 17
  // REAL staircase steps to the band + scan + tunnel + dig + return.
  // Fixed scan (muse-7 ipn.2): world spawn wanders by radius, so a
  // spawn-seeded scan samples a different shaft/ore/pockets every run and
  // the leg is not reproducible. The world snapshot is fixed, so fixed
  // candidates are deterministic: 33 first (the proven pass terrain), then
  // spares. sz likewise fixed (mouth/preflight z derive from it).
  const bx = 33
  const sz = -199
  let sx = -1
  for (let a = 0; a < 6 && sx < 0; a++) {
    const cand = bx + a * 20
    console.log(`leg preflight column x=${cand}`)
    if (await preflight(bot, cand, sz)) sx = cand
  }
  if (sx < 0) {
    console.log('FAIL: leg no clean column in 4 tries')
    return false
  }
  // Anchor (sx, sz): mouth lands r=3/a=0 = (sx, sz-3), carved air shaft.
  await rcon(`fill ${sx} -28 ${sz - 3} ${sx} -27 ${sz - 3} air`)
  await rcon(`fill ${sx} -29 ${sz - 3} ${sx} -29 ${sz - 3} stone`)
  await rcon(`give ${NAME} iron_pickaxe 1`)
  // Deterministic diamonds: three planted cells past the band arrival
  // (the shaft lands near (sx+17, -45, sz-3)).
  for (const px of [sx + 20, sx + 22, sx + 24]) {
    await rcon(`fill ${px} -45 ${sz - 3} ${px} -45 ${sz - 3} diamond_ore`)
  }
  await rcon(`tp ${NAME} ${sx} -28 ${sz - 3}`)
  await sleep(1500)
  const ctx = freshCtx({ x: sx, z: sz })
  const st = await drive(bot, ctx, 15 * 60 * 1000, 'leg')
  const p = bot.entity.position
  const ok = st === 'done' && (ctx.haul && ctx.haul.diamond >= 1) && Math.abs(p.y - -28) < 4
  console.log(`${ok ? 'PASS' : 'FAIL'}: leg status=${st} haul=${JSON.stringify(ctx.haul)} y=${p.y.toFixed(1)}`)
  return ok
}

async function band(bot) {
  const sx = Math.round(bot.entity.position.x) + 80
  const sz = Math.round(bot.entity.position.z)
  const byName = bot.registry.blocksByName || {}
  const ids = Object.keys(byName)
    .filter((n) => n === 'diamond_ore' || n === 'deepslate_diamond_ore')
    .map((n) => byName[n].id)
  const hist = {}
  for (const y of [40, 20, 0, -20, -30, -40, -48, -54, -59]) {
    if ((bot.health || 20) < 12) {
      await rcon(`tp ${NAME} ${sx} 70 ${sz}`)
      await sleep(4000)
    }
    await rcon(`tp ${NAME} ${sx} ${y} ${sz}`)
    await sleep(1200)
    await waitLoaded(bot, 15000)
    let found = []
    try { found = bot.findBlocks({ matching: ids, maxDistance: 84, count: 400 }) || [] } catch (_) {}
    const from = bot.entity.position
    for (const q of found) {
      if (Math.hypot(q.x - from.x, q.y - from.y, q.z - from.z) > 48) continue
      const yy = Math.floor(q.y / 5) * 5
      hist[yy] = (hist[yy] || 0) + 1
    }
    console.log(`band y=${y} hp=${Math.round(bot.health || 0)}`)
  }
  console.log('BAND-HIST:', JSON.stringify(hist))
  const deepN = Object.keys(hist).filter((k) => +k <= -25).reduce((s, k) => s + hist[k], 0)
  const ok = deepN > 50
  console.log(`${ok ? 'PASS' : 'FAIL'}: band deep-count=${deepN} (want >50)`)
  return ok
}

async function main() {
  const mode = process.argv[2] || 'all'
  const bot = mineflayer.createBot({ host: MC_HOST, port: MC_PORT, username: NAME, auth: 'offline' })
  bot.loadPlugin(pathfinder)
  await waitFor(bot, 'spawn', 60000, 'assay spawn')
  await waitLoaded(bot)
  // Prod-mirror movements (index.js setMovements): the assay must verify
  // what deploys — bare sprinting Movements dig+move race into
  // client/server desync (ghost blocks) that prod never sees.
  const movements = new Movements(bot)
  movements.allowSprinting = false
  require('../src/swim').addSwimExits(movements)
  require('../src/nocorner').addNoCornerCut(movements)
  require('../src/snow').addSnowGround(movements)
  require('../src/jumpcost').addJumpUpCost(movements)
  bot.pathfinder.setMovements(movements)
  bot.on('path_update', (r) => {
    let nodes = '-'
    try { nodes = (r && r.path ? r.path : []).slice(0, 6).map((n) => `${n.x},${n.y},${n.z}`).join(' ') } catch (_) { nodes = '?' }
    console.log(`${new Date().toISOString().slice(11, 19)} path status=${r && r.status} time=${r && r.time} nodes=${r && r.visitedNodes} len=${r && r.path && r.path.length} via=${nodes}`)
  })
  bot.on('goal_reached', () => console.log(`${new Date().toISOString().slice(11, 19)} path goal_reached`))
  bot.on('forcedMove', () => { if (bot.entity) { const q = bot.entity.position; console.log(`${new Date().toISOString().slice(11, 19)} net forcedMove to=${q.x.toFixed(2)},${q.y.toFixed(2)},${q.z.toFixed(2)}`) } })
  bot.on('path_stop', () => console.log(`${new Date().toISOString().slice(11, 19)} path path_stop`))
  console.log(`assay ${mode} as ${NAME} on ${MC_HOST}:${MC_PORT}`)
  let ok = true
  if (mode === 'rules' || mode === 'all') ok = (await rules(bot)) && ok
  if (mode === 'leg' || mode === 'all') ok = (await leg(bot)) && ok
  if (mode === 'band' || mode === 'all') ok = (await band(bot)) && ok
  console.log(ok ? 'ASSAY-PASS' : 'ASSAY-FAIL')
  bot.quit()
  process.exit(ok ? 0 : 1)
}

main().catch((err) => { console.error(`ASSAY-FAIL: ${err && err.message ? err.message : err}`); process.exit(1) })
