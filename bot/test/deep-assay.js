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
  const { stdout } = await execFileAsync('docker', ['exec', MC_CONTAINER, 'rcon-cli', cmd])
  return (stdout || '').trim()
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

// Tick deep() until the site phase commits to a shaft (phase descend, shaft
// fixed) or the leg ends. True only when a shaft is committed.
async function untilDescend(bot, ctx, timeoutMs) {
  const end = Date.now() + timeoutMs
  for (;;) {
    try { deep(bot, ctx, null, {}) } catch (e) { console.error(`untilDescend THREW ${e.message}`); return false }
    if (ctx.deep && ctx.deep.phase === 'descend' && ctx.deep.shaft) return true
    if (ctx.stepStatus.startsWith('done') || ctx.stepStatus.startsWith('failed:')) return false
    if (Date.now() > end) return false
    await sleep(TICK_MS)
  }
}

async function rules(bot) {
  let pass = true
  // Pad site (fsg): pickDir scans the whole 115-deep tube, and on the
  // prod-world copy raw terrain refuses EVERY direction near spawn (6/6
  // stride-20 columns pickDir=null in all 4 dirs — a clean-column search
  // cannot work). The rules assay proves the step 0-2 GUARDS, not
  // tube-finding in the wild (the leg assay covers that on natural terrain),
  // so RCON-clean the +X corridor to stone: pickDir(+X) then passes by
  // construction, deterministically. Anchor (sx,sz) -> mouth r=3/a=0 ->
  // (sx, sz-3), topY = pad top.
  const sx = Math.round(bot.entity.position.x)
  const sz = Math.round(bot.entity.position.z)
  const padY = 70
  const mz = sz - 3
  // Corridor = tubeClean's exact read set for the +X shaft: steps 0..114,
  // digs+stand+below, lava/water radius 2 -> x sx-1..sx+117, y -48..69
  // (y 70+ is pad air, clean), z mz+-2. 4 fills under the 32768 limit.
  console.log(`pad stone: ${await rcon(`fill ${sx - 10} ${padY - 6} ${sz - 10} ${sx + 10} ${padY - 1} ${sz + 10} stone`)}`)
  console.log(`pad air: ${await rcon(`fill ${sx - 10} ${padY} ${sz - 10} ${sx + 10} ${padY + 4} ${sz + 10} air`)}`)
  // Chunks first: /fill refuses unloaded positions ("That position is not
  // loaded") and the corridor runs past the loaded area — high-hop down +X
  // (columns load full-height; intermediate hops are re-teleported before
  // they can land, and the pad return below catches the last hop).
  for (const dx of [8, 32, 56, 80, 104]) {
    await rcon(`tp ${NAME} ${sx + dx} 220 ${mz}`)
    await sleep(2000)
    await waitLoaded(bot, 15000)
  }
  await rcon(`tp ${NAME} ${sx} ${padY + 1} ${sz}`) // park on the pad (revmux 01 minor: the last hop would otherwise fall 150 and die mid-fills)
  for (const [y1, y2] of [[-48, -20], [-19, 10], [11, 40], [41, 69]]) {
    const res = await rcon(`fill ${sx - 1} ${y1} ${mz - 2} ${sx + 117} ${y2} ${mz + 2} stone`)
    console.log(`corridor fill y ${y1}..${y2}: ${res}`)
    if (res.includes('not loaded')) {
      console.log(`FAIL: rules corridor fill refused (chunks unloaded): y ${y1}..${y2}: ${res}`)
      return false
    }
  }
  await sleep(1500)
  const mouth = { x: sx, z: sz - 3, topY: padY }
  // Settle (fsg): the client must hold post-fill chunks before pickDir runs —
  // stale pre-fill reads refuse with the same no-dir as real dirt. Poll the
  // REAL pickDir until +X commits; on timeout dump sample reads as ground
  // truth (stone = fills applied, null = unloaded/stale, raw = failed).
  await rcon(`tp ${NAME} ${mouth.x} ${mouth.topY} ${mouth.z}`)
  await waitLoaded(bot, 15000)
  let committed = null
  for (let t = 0; t < 15000; t += 1000) {
    await sleep(1000)
    committed = deep.pickDir(bot, mouth)
    if (committed && committed.dx === 1 && committed.dz === 0) break
    committed = null
  }
  if (!committed) {
    try {
      const Vec3 = require('vec3').Vec3
      const samples = [[sx, 69, mz, 'mouth-ground'], [sx, 70, mz, 'mouth-feet'],
        [sx + 1, 69, mz, 'step0-down'], [sx + 1, 70, mz, 'step0-feet'],
        [sx + 50, 0, mz, 'mid-corridor'], [sx + 115, -45, mz, 'deep-corridor'],
        [sx + 3, 68, mz, 'step2-feet']]
      const reads = samples.map(([x, y, z, tag]) => {
        let b = null
        try { b = bot.blockAt(new Vec3(x, y, z)) } catch (_) { b = null }
        return `${tag}=${b ? b.name : 'null'}`
      })
      const site = deep.pickSite(bot, freshCtx({ x: sx, z: sz }), { x: sx, z: sz })
      console.log(`FAIL: rules +X never committed; site=${site ? `${site.x},${site.topY},${site.z}` : 'null'} ${reads.join(' ')}`)
    } catch (e) { console.log(`FAIL: rules +X never committed (diagnose threw: ${e.message})`) }
    return false
  }
  // Step-0 cells for a +X shaft: feet/head/down at (sx+1, padY..padY+1, sz-3).
  const fx = sx + 1
  const fz = sz - 3

  async function scenario(name, setup, want, inject, settle) {
    await rcon(`fill ${fx - 2} ${padY - 8} ${fz - 2} ${fx + 2} ${padY + 2} ${fz + 2} stone`)
    await rcon(`fill ${sx - 2} ${padY} ${sz - 5} ${sx + 2} ${padY + 2} ${sz - 1} air`)
    await setup()
    await sleep(1000)
    const ctx = freshCtx({ x: sx, z: sz })
    await rcon(`tp ${NAME} ${mouth.x} ${mouth.topY} ${mouth.z}`)
    await sleep(1000)
    // Settle on the post-setup reads (fsg): a stale pre-reset cell desyncs
    // the drive (stale air skips the dig, the body walks into server stone,
    // rubber-band shaft-stuck). Fail fast with the actual reads.
    if (settle) {
      const Vec3 = require('vec3').Vec3
      const readAll = () => settle.map(([x, y, z, wantName]) => {
        let b = null
        try { b = bot.blockAt(new Vec3(x, y, z)) } catch (_) { b = null }
        return { ok: !!b && b.name === wantName, line: `${x},${y},${z}=${b ? b.name : 'null'}(want ${wantName})` }
      })
      let missing = null
      for (let t = 0; t < 10000; t += 500) {
        const reads = readAll()
        if (reads.every((r) => r.ok)) { missing = null; break }
        missing = reads.filter((r) => !r.ok).map((r) => r.line)
        await sleep(500)
      }
      if (missing) {
        console.log(`FAIL: ${name} setup never landed: ${missing.join(' ')}`)
        pass = false
        return
      }
    }
    if (inject) {
      // Mid-drive injection (fsg): the shaft commits to +X at the site tick;
      // planting the hazard only AFTER that keeps pickDir honest. Pre-planted
      // step-2 lava trips tubeClean(+X), so pickDir could never pick the
      // scenario direction (self-defeat); bedrock/air are tubeClean-invisible
      // and stay pre-planted.
      if (!(await untilDescend(bot, ctx, 30000))) {
        console.log(`FAIL: ${name} never reached descend (status=${ctx.stepStatus})`)
        pass = false
        return
      }
      await inject()
      await sleep(1000)
    }
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
  await scenario('lava', async () => {}, 'failed:lava', async () => { await rcon(`fill ${step1.x} ${step1.y} ${step1.z} ${step1.x} ${step1.y} ${step1.z} lava`) }, [[fx, padY - 1, fz, 'stone']])
  await scenario('drop', async () => { await rcon(`fill ${fx} ${padY - 8} ${fz} ${fx} ${padY + 1} ${fz} air`) }, 'failed:drop', null, [[fx, padY - 1, fz, 'air'], [fx, padY - 3, fz, 'air']]) // padY-3 (revmux 01 minor): lava digs padY-1, so only padY-3 (stone until this setup) tells stale from fresh
  await scenario('bedrock', async () => { await rcon(`fill ${step1.x} ${step1.y} ${step1.z} ${step1.x} ${step1.y} ${step1.z} bedrock`) }, 'failed:bedrock', null, [[step1.x, step1.y, step1.z, 'bedrock'], [fx, padY - 1, fz, 'stone']])

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
  // OP the assay bot (fsg): the rules pad sits inside spawn-protection=16
  // and a non-op's digs are denied+restored server-side while the client
  // believes them (ghost) — the body walks into server stone, the server
  // pins it back 10x/s, walk stalls, shaft-stuck. Ops dig normally.
  console.log(`op: ${await rcon(`op ${NAME}`)}`)
  let ok = true
  if (mode === 'rules' || mode === 'all') ok = (await rules(bot)) && ok
  if (mode === 'leg' || mode === 'all') ok = (await leg(bot)) && ok
  if (mode === 'band' || mode === 'all') ok = (await band(bot)) && ok
  console.log(ok ? 'ASSAY-PASS' : 'ASSAY-FAIL')
  bot.quit()
  process.exit(ok ? 0 : 1)
}

main().catch((err) => { console.error(`ASSAY-FAIL: ${err && err.message ? err.message : err}`); process.exit(1) })
