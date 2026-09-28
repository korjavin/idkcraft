'use strict'
// WATER-UP ASSAY (idkcraft-jsf.1): rig spike — can the bot climb a poured
// water column on Paper 26.1.2? Bare bot + rcon kit on a private copy of the
// prod world; measures pour/swim/rim/deep/scoop, y(t) at 100 ms and server
// position-correction counts (forcedMove events).
// Usage: node water-assay.js <recon|recon2|recon3|pour|place|swim|rim> [arg]
// Env: ASSAY_HOST (127.0.0.1), ASSAY_PORT (25577),
//   ASSAY_CONTAINER (idk-rig-m12, docker exec rcon-cli),
//   ASSAY_TAG (bot name suffix; default random), ASSAY_OUT (JSON results path),
//   ASSAY_PIT (x,y,z floor of the pit; default CLUSTER -59.6,54,-211.3),
//   ASSAY_OP (default 1: rcon-op the name BEFORE login; CLUSTER is inside
//     spawn-protection r=16 and mid-session op does not lift it for the live
//     session — set 0 to measure the un-opped case).
// KEY FINDING (2026-09-28): on Paper 26.1.2 buckets work ONLY via use_item
// (lookAt + activateItem, server raycast); block_place is silently ignored
// for buckets (solid blocks place fine via block_place).
// The rig server must already be up. Never run against prod.
const mineflayer = require('mineflayer')
const fs = require('node:fs')
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')
const Vec3 = require('vec3').Vec3

const execFileAsync = promisify(execFile)

const HOST = process.env.ASSAY_HOST || '127.0.0.1'
const PORT = parseInt(process.env.ASSAY_PORT || '25577', 10)
const CONTAINER = process.env.ASSAY_CONTAINER || 'idk-rig-m12'
const TAG = process.env.ASSAY_TAG || String(Math.floor(Math.random() * 10000))
const BOT = `WaterAssay${TAG}`
const PIT = (process.env.ASSAY_PIT || '-59.6,54,-211.3').split(',').map(Number)
const POUR_DY = parseInt(process.env.ASSAY_POUR_DY || '3', 10)

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)) }

async function rcon(cmd) {
  const { stdout } = await execFileAsync('docker', ['exec', CONTAINER, 'rcon-cli', cmd])
  const out = String(stdout)
  if ((cmd.startsWith('tp ') && !out.includes('Teleported')) ||
      ((cmd.startsWith('clear ') || cmd.startsWith('give ') || cmd.startsWith('effect ') || cmd.startsWith('fill ')) && /No entity was found|Unknown|incorrect/i.test(out))) {
    throw new Error(`rcon failed [${cmd}]: ${out.trim().slice(0, 160)}`)
  }
  return out
}

function waitFor(em, ev, ms, what) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { em.removeListener(ev, on); reject(new Error(`${what} timeout`)) }, ms)
    function on(...a) { clearTimeout(t); resolve(a) }
    em.once(ev, on)
  })
}

async function connect() {
  // Op BEFORE login: offline UUIDs are deterministic from the name, and a
  // mid-session op does not lift spawn protection for the live session.
  if (process.env.ASSAY_OP !== '0') {
    await rcon(`op ${BOT}`)
    console.log(`pre-opped ${BOT}`)
  }
  const bot = mineflayer.createBot({ host: HOST, port: PORT, username: BOT, auth: 'offline' })
  bot.on('error', (e) => console.error(`bot error: ${e && e.message ? e.message : e}`))
  bot.on('kicked', (r) => console.error(`bot kicked: ${r}`))
  bot.on('death', () => console.error('bot DIED'))
  await waitFor(bot, 'spawn', 60000, 'bot spawn')
  await sleep(2500) // chunks in
  // Anti-noise effects; refreshed per trial too (assay is not about damage).
  try {
    await rcon(`effect give ${BOT} minecraft:water_breathing 600`)
    await rcon(`effect give ${BOT} minecraft:resistance 600 4`)
  } catch (e) { console.error(`effects warn: ${e.message}`) }
  return bot
}

// Paper open-air movement freeze (paper-unfreeze-dig-start): after some tps
// displacement is exactly 0.00 until a dig-START packet is sent on the block
// under the feet (aborted, block intact). Returns {frozen, unfroze}.
async function freezeCheck(bot) {
  const p0 = bot.entity.position.clone()
  bot.setControlState('jump', true)
  await sleep(1500)
  bot.setControlState('jump', false)
  const disp = bot.entity.position.distanceTo(p0)
  if (disp > 0.05) { await settle(bot); return { frozen: false, unfroze: false } }
  const under = bot.blockAt(bot.entity.position.offset(0, -1, 0))
  if (under && under.position) {
    bot._client.write('block_dig', { status: 0, location: under.position, face: 1 })
    await sleep(150)
    bot._client.write('block_dig', { status: 1, location: under.position, face: 1 })
    await sleep(500)
  }
  const p1 = bot.entity.position.clone()
  bot.setControlState('jump', true)
  await sleep(1500)
  bot.setControlState('jump', false)
  const disp2 = bot.entity.position.distanceTo(p1)
  const r = { frozen: true, unfroze: disp2 > 0.05 }
  await settle(bot)
  return r
}

// Wait for landing so feet-cell math (findWall etc.) samples the floor,
// not a jump apex.
async function settle(bot) {
  for (let i = 0; i < 30 && !bot.entity.onGround; i++) await sleep(100)
  await sleep(300)
}

function isWater(b) { return !!b && b.name === 'water' }
function isAirish(b) { return !b || b.name === 'air' || b.name === 'cave_air' || b.name === 'void_air' }
function isSolid(b) { return !!b && b.boundingBox !== 'empty' && b.name !== 'water' && b.name !== 'lava' }

// Scan the 4 neighbours of the feet cell for a solid wall column; returns the
// best wall dir + the reference block at feet+dy with the face toward the pit.
function findWall(bot, dy = 3) {
  const p = bot.entity.position
  const fx = Math.floor(p.x); const fz = Math.floor(p.z); const fy = Math.floor(p.y)
  const dirs = [
    { d: new Vec3(1, 0, 0), face: new Vec3(-1, 0, 0) },
    { d: new Vec3(-1, 0, 0), face: new Vec3(1, 0, 0) },
    { d: new Vec3(0, 0, 1), face: new Vec3(0, 0, -1) },
    { d: new Vec3(0, 0, -1), face: new Vec3(0, 0, 1) },
  ]
  const cands = []
  for (const { d, face } of dirs) {
    const ref = bot.blockAt(new Vec3(fx + d.x, fy + dy, fz + d.z))
    const dest = bot.blockAt(new Vec3(fx, fy + dy, fz))
    if (isSolid(ref) && (isAirish(dest))) cands.push({ ref, face, destPos: dest ? dest.position : new Vec3(fx, fy + dy, fz) })
  }
  return cands[0] || null
}

async function resetPit(bot, { bucket = true } = {}) {
  await rcon(`tp ${BOT} ${PIT[0]} ${PIT[1]} ${PIT[2]}`)
  await sleep(1200)
  // Wipe assay water in the pit box (box covers CLUSTER + rim).
  const [x, y, z] = PIT.map(Math.floor)
  await rcon(`fill ${x - 6} ${y - 3} ${z - 6} ${x + 6} ${y + 10} ${z + 6} air replace water`)
  await rcon(`clear ${BOT}`)
  if (bucket) await rcon(`give ${BOT} water_bucket 1`)
  await rcon(`effect give ${BOT} minecraft:water_breathing 600`)
  await rcon(`effect give ${BOT} minecraft:resistance 600 4`)
  await sleep(800)
}

async function equipBucket(bot, name) {
  const item = bot.inventory.items().find((i) => i.name === name)
  if (!item) throw new Error(`no ${name} in inventory`)
  await bot.equip(item, 'hand')
}

// --- recon: ASCII slices of the pit + wall report ---
async function cmdRecon(bot) {
  await rcon(`tp ${BOT} ${PIT[0]} ${PIT[1]} ${PIT[2]}`)
  await sleep(2500)
  const p = bot.entity.position
  console.log(`feet=(${p.x.toFixed(1)},${p.y.toFixed(1)},${p.z.toFixed(1)}) on=${bot.blockAt(p.offset(0, -1, 0))?.name}`)
  const fx = Math.floor(p.x); const fz = Math.floor(p.z)
  for (let y = Math.floor(p.y) + 7; y >= Math.floor(p.y) - 3; y--) {
    let row = `y=${String(y).padStart(3)} `
    for (let dz = -4; dz <= 4; dz++) {
      for (let dx = -4; dx <= 4; dx++) {
        const b = bot.blockAt(new Vec3(fx + dx, y, fz + dz))
        const me = (dx === 0 && dz === 0)
        row += me ? (isSolid(b) ? '[#]' : '[.]') : (isAirish(b) ? ' . ' : isWater(b) ? ' ~ ' : ' # ')
      }
      if (dz === 0) row += `  <-- z=${fz + dz}`
      row += '\n     '
    }
    console.log(row)
  }
  // Wall adjacency per height at the feet cell.
  for (let dy = -1; dy <= 6; dy++) {
    const w = findWallAt(bot, dy)
    console.log(`dy=${dy >= 0 ? '+' : ''}${dy}: ${w}`)
  }
  // Rim hunt: nearest solid top surface above feet within 6 blocks.
  console.log('rim hunt (solid tops above feet, |dx|,|dz|<=6):')
  const fy = Math.floor(p.y)
  for (let y = fy + 1; y <= fy + 9; y++) {
    const tops = []
    for (let dx = -6; dx <= 6; dx++) {
      for (let dz = -6; dz <= 6; dz++) {
        const b = bot.blockAt(new Vec3(fx + dx, y, fz + dz))
        const above = bot.blockAt(new Vec3(fx + dx, y + 1, fz + dz))
        if (isSolid(b) && isAirish(above)) tops.push(`${b.name}@(${fx + dx},${y},${fz + dz})`)
      }
    }
    if (tops.length > 0) console.log(`  y=${y}: ${tops.slice(0, 12).join(' ')}${tops.length > 12 ? ` +${tops.length - 12} more` : ''}`)
  }
}

// --- recon2: compact vertical profiles (y=70..45) for cells around the pit,
// to find an open-top shaft cell for swim/rim. Usage: recon2 x0,z0,x1 (cells
// x0..x1 at fixed z0), defaults -62,-212,-54.
async function cmdRecon2(bot, arg) {
  await rcon(`tp ${BOT} ${PIT[0]} ${PIT[1]} ${PIT[2]}`)
  await sleep(2500)
  const [x0, z0, x1] = (arg || '-62,-212,-54').split(',').map(Number)
  const p = bot.entity.position
  console.log(`standing feet=(${p.x.toFixed(1)},${p.y.toFixed(1)},${p.z.toFixed(1)})`)
  let hdr = 'y   '
  for (let x = x0; x <= x1; x++) hdr += `${String(x).padStart(4)}`
  console.log(hdr)
  for (let y = 70; y >= 45; y--) {
    let row = `${String(y).padStart(3)} `
    for (let x = x0; x <= x1; x++) {
      const b = bot.blockAt(new Vec3(x, y, z0))
      let c = ' ## '
      if (isAirish(b)) c = ' .. '
      else if (isWater(b)) c = ' ~~ '
      else if (b && b.name !== 'stone') c = ` ${b.name.slice(0, 2)} `
      row += c
    }
    console.log(row)
  }
}

// --- recon3: like recon2 but along z at fixed x. Usage: recon3 z0,x0,z1
// (cells z0..z1 at fixed x0), defaults -216,-56,-208.
async function cmdRecon3(bot, arg) {
  await rcon(`tp ${BOT} ${PIT[0]} ${PIT[1]} ${PIT[2]}`)
  await sleep(2500)
  const [z0, x0, z1] = (arg || '-216,-56,-208').split(',').map(Number)
  const p = bot.entity.position
  console.log(`standing feet=(${p.x.toFixed(1)},${p.y.toFixed(1)},${p.z.toFixed(1)})`)
  let hdr = 'y   '
  for (let z = z0; z <= z1; z++) hdr += `${String(z).padStart(4)}`
  console.log(hdr)
  for (let y = 70; y >= 45; y--) {
    let row = `${String(y).padStart(3)} `
    for (let z = z0; z <= z1; z++) {
      const b = bot.blockAt(new Vec3(x0, y, z))
      let c = ' ## '
      if (isAirish(b)) c = ' .. '
      else if (isWater(b)) c = ' ~~ '
      else if (b && b.name !== 'stone') c = ` ${b.name.slice(0, 2)} `
      row += c
    }
    console.log(row)
  }
}

function findWallAt(bot, dy) {
  const p = bot.entity.position
  const fx = Math.floor(p.x); const fz = Math.floor(p.z); const fy = Math.floor(p.y)
  const out = []
  for (const [dx, dz, nm] of [[1, 0, '+x'], [-1, 0, '-x'], [0, 1, '+z'], [0, -1, '-z']]) {
    const b = bot.blockAt(new Vec3(fx + dx, fy + dy, fz + dz))
    if (isSolid(b)) out.push(`${nm}:${b.name}`)
  }
  const here = bot.blockAt(new Vec3(fx, fy + dy, fz))
  return `here=${here?.name} walls=[${out.join(' ') || 'none'}]`
}

// --- pour: placeBlock vs activateItem, 3 trials each ---
async function pourTrial(bot, method, n) {
  await resetPit(bot)
  const fr = await freezeCheck(bot)
  await equipBucket(bot, 'water_bucket')
  const wall = findWall(bot, POUR_DY)
  const feetY = +bot.entity.position.y.toFixed(2)
  if (!wall) return { method, n, ok: false, note: `no-wall-at-feet+${POUR_DY}`, feetY, frozen: fr.frozen, unfroze: fr.unfroze }
  const eye = bot.entity.position.offset(0, 1.62, 0)
  const reach = +eye.distanceTo(wall.destPos.offset(0.5, 0.5, 0.5)).toFixed(2)
  const t0 = Date.now()
  let err = ''
  try {
    if (method === 'placeBlock') {
      await bot.placeBlock(wall.ref, wall.face)
    } else {
      // use_item path (the one that works for buckets): aim either at the
      // ref FACE center (vanilla crosshair) or at the DEST air cell.
      const aim = method === 'useitem-face'
        ? wall.ref.position.offset(0.5 + wall.face.x * 0.5, 0.5 + wall.face.y * 0.5, 0.5 + wall.face.z * 0.5)
        : wall.destPos.offset(0.5, 0.5, 0.5)
      await bot.lookAt(aim)
      await sleep(350)
      bot.activateItem()
      await sleep(1500)
    }
  } catch (e) { err = String(e.message || e).slice(0, 120) }
  await sleep(800)
  const dest = bot.blockAt(wall.destPos)
  const below1 = bot.blockAt(wall.destPos.offset(0, -1, 0))
  const below2 = bot.blockAt(wall.destPos.offset(0, -2, 0))
  const below3 = bot.blockAt(wall.destPos.offset(0, -3, 0))
  const held = bot.heldItem?.name || 'none'
  const poured = isWater(dest)
  const colN = [dest, below1, below2, below3].filter(isWater).length
  const r = {
    method, n, ok: poured, ms: Date.now() - t0,
    ref: `${wall.ref.name}@${wall.ref.position}`, dest: `${dest?.name}@${wall.destPos}`,
    column: colN, held, err, feetY, reach,
    below: [below1?.name, below2?.name, below3?.name].join(','),
    frozen: fr.frozen, unfroze: fr.unfroze,
  }
  console.log(`pour/${method}#${n}: ok=${poured} col=${colN}/4 held=${held} feet=${feetY} reach=${reach} ms=${r.ms} err=${err || '-'} frozen=${fr.frozen}/${fr.unfroze}`)
  return r
}

async function cmdPour(bot) {
  const rows = []
  for (const m of ['placeBlock', 'useitem-face', 'useitem-dest']) {
    for (let n = 1; n <= 3; n++) rows.push(await pourTrial(bot, m, n))
  }
  saveOut(rows)
  return rows
}

// --- place probe: placeBlock with any item/face (control for bucket refusal).
// Env: ASSAY_ITEM (default dirt), ASSAY_FACE (wall|floor, default wall).
async function cmdPlace(bot) {
  const item = process.env.ASSAY_ITEM || 'dirt'
  const faceMode = process.env.ASSAY_FACE || 'wall'
  const rows = []
  for (let n = 1; n <= 3; n++) {
    await resetPit(bot, { bucket: false })
    await rcon(`give ${BOT} ${item} 1`)
    const fr = await freezeCheck(bot)
    await equipBucket(bot, item)
    let ref, face, label
    if (faceMode === 'floor') {
      // Floor of the ADJACENT cell (own feet cell would collide with the body).
      ref = bot.blockAt(bot.entity.position.offset(1, -1, 0))
      face = new Vec3(0, 1, 0)
      label = 'floor/top'
    } else {
      const wall = findWall(bot, POUR_DY)
      if (!wall) { rows.push({ item, faceMode, n, ok: false, note: 'no-wall' }); continue }
      ref = wall.ref; face = wall.face; label = `wall@${ref.position}`
    }
    const dest = ref.position.plus(face)
    const eye = bot.entity.position.offset(0, 1.62, 0)
    const reach = +eye.distanceTo(dest.offset(0.5, 0.5, 0.5)).toFixed(2)
    const t0 = Date.now()
    let err = ''
    try {
      await bot.placeBlock(ref, face)
    } catch (e) { err = String(e.message || e).slice(0, 140) }
    await sleep(600)
    const after = bot.blockAt(dest)?.name
    const ok = item === 'water_bucket' ? after === 'water' : (after !== 'air' && after != null)
    const r = { item, faceMode, n, ok, after, dest: String(dest), ref: `${ref.name}@${ref.position}`, reach, ms: Date.now() - t0, err }
    console.log(`place/${item}/${faceMode}#${n}: ok=${ok} after=${after} dest=${dest} reach=${reach} err=${err || '-'}`)
    rows.push(r)
  }
  saveOut(rows)
  return rows
}

// --- swim: jump-only vs jump+forward control, 3 trials each ---
// The working pour: equip water bucket, aim at the ref face, use_item.
// Falls back to lower faces when the shaft widens (no wall at +3).
async function pourColumn(bot) {
  await equipBucket(bot, 'water_bucket')
  let wall = null
  for (let dy = POUR_DY; dy >= 1 && !wall; dy--) wall = findWall(bot, dy)
  if (!wall) throw new Error('no-wall')
  await bot.lookAt(wall.ref.position.offset(
    0.5 + wall.face.x * 0.5, 0.5 + wall.face.y * 0.5, 0.5 + wall.face.z * 0.5))
  await sleep(350)
  bot.activateItem()
  await sleep(1500)
  if (!isWater(bot.blockAt(wall.destPos))) throw new Error('pour-no-water')
  return wall
}

async function swimTrial(bot, mode, n) {
  await resetPit(bot)
  await settle(bot)
  let wall
  try {
    wall = await pourColumn(bot)
  } catch (e) { return { mode, n, ok: false, note: `pour-failed: ${String(e.message || e).slice(0, 80)}` } }
  const srcY = wall.destPos.y
  // Step into the column: tp to the column cell at floor (feet+0 of PIT).
  const [px, , pz] = PIT
  await rcon(`tp ${BOT} ${(Math.floor(px) + 0.5).toFixed(1)} ${PIT[1]} ${(Math.floor(pz) + 0.5).toFixed(1)}`)
  await sleep(1200)
  const fr = await freezeCheck(bot)
  const p0 = bot.entity.position.clone()
  const inWater0 = isWater(bot.blockAt(p0)) || isWater(bot.blockAt(p0.offset(0, 1, 0)))
  // Look crossover (pitch-quirk test): mode encodes fwd+look.
  // jump-up   = jump only, look straight up (original jump)
  // jump-wall = jump only, look at wall face (crossover A)
  // fwd-up    = jump+forward, look straight up (crossover B)
  // forward   = jump+forward, look at wall (original forward)
  const fwd = mode.startsWith('fwd') || mode === 'forward'
  const up = mode.endsWith('up') || mode === 'jump'
  if (up) {
    await bot.look(bot.entity.yaw, -Math.PI / 2 + 0.05)
  } else {
    await bot.lookAt(wall.ref.position.offset(0.5, 0.5, 0.5))
  }
  let corr = 0
  const onFM = () => { corr++ }
  bot.on('forcedMove', onFM)
  const yt = []
  const t0 = Date.now()
  const yTarget = srcY + 0.6
  bot.setControlState('jump', true)
  if (fwd) bot.setControlState('forward', true)
  const T = setInterval(() => {
    try { yt.push({ t: Date.now() - t0, y: +bot.entity.position.y.toFixed(3) }) } catch (_) {}
  }, 100)
  let reached = false
  const BUDGET = 40000
  while (Date.now() - t0 < BUDGET) {
    await sleep(250)
    if (bot.entity.position.y >= yTarget) { reached = true; break }
  }
  clearInterval(T)
  bot.setControlState('jump', false)
  bot.setControlState('forward', false)
  bot.removeListener('forcedMove', onFM)
  const p1 = bot.entity.position.clone()
  const dt = (Date.now() - t0) / 1000
  const dy = p1.y - p0.y
  // Rise speed over the middle (skip first/last 15%): Paper pins show as ~0.
  const q = (f) => yt[Math.floor(yt.length * f)] || { t: 0, y: p0.y }
  const qa = q(0.15); const qb = q(0.85)
  const speed = qb.t > qa.t ? +(((qb.y - qa.y) / (qb.t - qa.t)) * 1000).toFixed(3) : 0
  const r = {
    mode, n, ok: reached, secs: +dt.toFixed(1),
    y0: +p0.y.toFixed(2), y1: +p1.y.toFixed(2), dy: +dy.toFixed(2),
    speed, corrections: corr, samples: yt.length,
    inWater0, frozen: fr.frozen, unfroze: fr.unfroze,
  }
  console.log(`swim/${mode}#${n}: reached=${reached} dy=${r.dy} speed=${speed}b/s corr=${corr} secs=${r.secs} frozen=${fr.frozen}/${fr.unfroze}`)
  return { ...r, yt }
}

async function cmdSwim(bot) {
  const rows = []
  const modes = (process.env.ASSAY_SWIM_MODES || 'jump-up,jump-wall,fwd-up,forward').split(',')
  for (const m of modes) {
    for (let n = 1; n <= 3; n++) rows.push(await swimTrial(bot, m, n))
  }
  saveOut(rows)
  return rows
}

// Scoop a water cell with the empty bucket (use_item, server raycast).
// Tries the given cell first, then water cells below it (reach permitting).
async function scoopWater(bot, cell) {
  await equipBucket(bot, 'bucket')
  const eye = () => bot.entity.position.offset(0, 1.62, 0)
  for (let dy = 0; dy >= -3; dy--) {
    const c = cell.offset(0, dy, 0)
    if (!isWater(bot.blockAt(c))) continue
    if (eye().distanceTo(c.offset(0.5, 0.5, 0.5)) > 4.4) continue
    await bot.lookAt(c.offset(0.5, 0.5, 0.5))
    await sleep(350)
    bot.activateItem()
    await sleep(1200)
    if ((bot.heldItem?.name) === 'water_bucket') return { cell: c, ok: true }
  }
  return { cell: null, ok: false }
}

// Swim up with the working input pattern until feet >= yTarget or timeout.
// Returns {reached, y0, y1, dy, secs, corrections, speed}.
async function swimUp(bot, yTarget, budgetMs = 25000) {
  const mode = process.env.ASSAY_SWIM_MODE || 'jump-wall'
  const fwd = mode === 'forward'
  if (mode === 'jump-up') {
    await bot.look(bot.entity.yaw, -Math.PI / 2 + 0.05)
  } else {
    // Look slightly up toward the column (NOT straight up: near-vertical
    // pitch gets movement rejected ~20/s on Paper 26.1.2).
    const p = bot.entity.position
    await bot.lookAt(new Vec3(Math.floor(p.x) + 0.5, p.y + 2.5, Math.floor(p.z) + 0.5))
    await sleep(200)
  }
  let corr = 0
  const onFM = () => { corr++ }
  bot.on('forcedMove', onFM)
  const yt = []
  const t0 = Date.now()
  const y0 = bot.entity.position.y
  bot.setControlState('jump', true)
  if (fwd) bot.setControlState('forward', true)
  const T = setInterval(() => {
    try { yt.push({ t: Date.now() - t0, y: +bot.entity.position.y.toFixed(3) }) } catch (_) {}
  }, 100)
  let reached = false
  while (Date.now() - t0 < budgetMs) {
    await sleep(250)
    if (bot.entity.position.y >= yTarget) { reached = true; break }
  }
  clearInterval(T)
  bot.setControlState('jump', false)
  bot.setControlState('forward', false)
  bot.removeListener('forcedMove', onFM)
  const y1 = bot.entity.position.y
  const q = (f) => yt[Math.floor(yt.length * f)] || { t: 0, y: y0 }
  const qa = q(0.15); const qb = q(0.85)
  const speed = qb.t > qa.t ? +(((qb.y - qa.y) / (qb.t - qa.t)) * 1000).toFixed(3) : 0
  return { reached, y0: +y0.toFixed(2), y1: +y1.toFixed(2), dy: +(y1 - y0).toFixed(2), secs: +((Date.now() - t0) / 1000).toFixed(1), corrections: corr, speed, mode, yt }
}

// One climb cycle from the current feet: pour at feet+POUR_DY, swim to the
// source, scoop it back. Returns cycle record.
async function climbCycle(bot, n) {
  const t0 = Date.now()
  const rec = { cycle: n, yStart: +bot.entity.position.y.toFixed(2) }
  let wall
  try {
    wall = await pourColumn(bot)
  } catch (e) {
    return { ...rec, poured: false, note: String(e.message || e).slice(0, 80) }
  }
  rec.poured = true
  rec.sourceY = wall.destPos.y
  // Step into the column (tp to column center at current floor is a no-op
  // if already there; keeps trials deterministic).
  const p = bot.entity.position
  await rcon(`tp ${BOT} ${(Math.floor(p.x) + 0.5).toFixed(1)} ${p.y.toFixed(1)} ${(Math.floor(p.z) + 0.5).toFixed(1)}`)
  await sleep(1000)
  // Target the eye-out plateau (source-0.5), not the source itself: the
  // standing eye exits the surface ~1.5 below it and lift stops there.
  const sw = await swimUp(bot, wall.destPos.y - 0.5, 20000)
  Object.assign(rec, { swim: sw })
  if (!sw.reached) return { ...rec, note: 'swim-timeout' }
  const sc = await scoopWater(bot, wall.destPos)
  rec.scooped = sc.ok
  rec.secs = +((Date.now() - t0) / 1000).toFixed(1)
  return rec
}

// --- rim/deep: full climb from the pit floor to the surface + top-out +
// scoop-back. ASSAY_RIM_Y (default 59.5): feet at/above this = at the rim.
async function cmdRim(bot) {
  const rows = []
  const N = parseInt(process.argv[3] || '3', 10)
  const RIM_Y = parseFloat(process.env.ASSAY_RIM_Y || '59.5')
  for (let n = 1; n <= N; n++) {
    await resetPit(bot)
    await settle(bot)
    const fr = await freezeCheck(bot)
    const t0 = Date.now()
    const rec = { n, frozen: fr.frozen, unfroze: fr.unfroze, cycles: [] }
    let ok = true
    for (let c = 1; c <= 5; c++) {
      if (bot.entity.position.y >= RIM_Y) break
      const cyc = await climbCycle(bot, c)
      rec.cycles.push({ ...cyc, swim: cyc.swim ? { ...cyc.swim, yt: `[${cyc.swim.yt.length}]` } : undefined })
      if (!cyc.poured || !cyc.swim?.reached || !cyc.scooped) { ok = false; rec.failedAt = `cycle${c}`; break }
    }
    rec.atRim = bot.entity.position.y >= RIM_Y
    rec.climbSecs = +((Date.now() - t0) / 1000).toFixed(1)
    // Top-out attempt whenever the rim is in pour reach (even after a stall
    // below the rim: the rim-pour overflow re-creates the last column).
    if (bot.entity.position.y >= RIM_Y - 3.5) {
      const to = await topOut(bot, RIM_Y)
      Object.assign(rec, to)
    } else {
      rec.topOutSkipped = true
    }
    console.log(`rim#${n}: cycles=${rec.cycles.length} atRim=${rec.atRim} exited=${rec.exited} fell=${rec.fell} back=${rec.scoopedBack} secs=${rec.climbSecs}+${rec.topSecs || 0}`)
    rows.push(rec)
  }
  saveOut(rows)
  return rows
}

// Find a rim block (solid top, air above) reachable from the shaft top,
// pour onto it, ride the overflow up if below the rim, swim out level,
// walk clear, scoop the source back.
async function topOut(bot, RIM_Y) {
  const t0 = Date.now()
  const rec = {}
  const p = bot.entity.position
  const fx = Math.floor(p.x); const fz = Math.floor(p.z)
  let rim = null
  // Search a 5x5x6 box for a surface top at/above the rim level. Reject
  // adjacent wall-tops (grazing rays miss) and below-rim ledges.
  const cands = []
  for (let dy = 0; dy <= 5; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      for (let dz = -2; dz <= 2; dz++) {
        const horiz = Math.hypot(dx, dz)
        if (horiz < 1.5) continue
        const b = bot.blockAt(new Vec3(fx + dx, Math.floor(p.y) + dy, fz + dz))
        const above = bot.blockAt(new Vec3(fx + dx, Math.floor(p.y) + dy + 1, fz + dz))
        if (isSolid(b) && isAirish(above)) {
          const topY = Math.floor(p.y) + dy + 1
          if (topY < RIM_Y - 1) continue
          const d = Math.abs(topY - (RIM_Y + 1)) + horiz * 0.3
          cands.push({ b, d })
        }
      }
    }
  }
  cands.sort((a, b) => a.d - b.d)
  rim = cands[0]?.b || null
  if (!rim) return { exited: false, note: 'no-rim-block' }
  rec.rimBlock = `${rim.name}@${rim.position}`
  // Pour onto the rim top (need a water bucket: last cycle's scoop left one).
  try {
    await equipBucket(bot, 'water_bucket')
  } catch (e) { return { exited: false, note: 'no-water-bucket' } }
  await bot.lookAt(rim.position.offset(0.5, 1.0, 0.5))
  await sleep(350)
  bot.activateItem()
  await sleep(2500) // let the rim source spread + overflow into the shaft
  const rimTop = rim.position.plus(new Vec3(0, 1, 0))
  rec.rimWet = isWater(bot.blockAt(rimTop))
  if (!rec.rimWet) return { ...rec, exited: false, note: 'rim-pour-failed' }
  // If below the rim water, swim up the overflow column first (best
  // effort: the eye-out plateau may sit below the rim — the hop after
  // covers the last gap in the wide, contact-free shaft top).
  rec.yAtTopOut = +bot.entity.position.y.toFixed(2)
  if (bot.entity.position.y < rimTop.y - 0.2) {
    const sw = await swimUp(bot, rimTop.y + 0.3, 12000)
    rec.overflowSwim = { ...sw, yt: `[${sw.yt.length}]` }
  }
  // Hop out: forward toward the rim-top water + jump, up to 12 s. Open
  // water here — forward does not pin (only sustained wall contact does).
  const yBefore = bot.entity.position.y
  await bot.lookAt(rimTop.offset(0.5, 0.5, 0.5))
  let corr = 0
  const onFM = () => { corr++ }
  bot.on('forcedMove', onFM)
  bot.setControlState('forward', true)
  bot.setControlState('jump', true)
  const tE = Date.now()
  let minY = yBefore
  while (Date.now() - tE < 12000) {
    await sleep(250)
    const q = bot.entity.position
    if (q.y < minY) minY = q.y
    const dx = q.x - (rimTop.x + 0.5); const dz = q.z - (rimTop.z + 0.5)
    if (Math.hypot(dx, dz) < 1.2 && q.y >= rimTop.y - 1.5) break
  }
  bot.setControlState('forward', false)
  bot.setControlState('jump', false)
  bot.removeListener('forcedMove', onFM)
  // Walk 3 more blocks away from the shaft on the surface.
  bot.setControlState('forward', true)
  await sleep(2500)
  bot.setControlState('forward', false)
  await settle(bot)
  const q = bot.entity.position
  rec.exitCorr = corr
  rec.fell = +(yBefore - minY).toFixed(2)
  rec.exited = Math.hypot(q.x - (fx + 0.5), q.z - (fz + 0.5)) > 2.2 && q.y >= rimTop.y - 0.5
  rec.exitPos = `${q.x.toFixed(1)},${q.y.toFixed(1)},${q.z.toFixed(1)}`
  rec.topSecs = +((Date.now() - t0) / 1000).toFixed(1)
  // Scoop the rim source back (phase e).
  try {
    const sc = await scoopWater(bot, rimTop)
    rec.scoopedBack = sc.ok
    rec.rimDry = !isWater(bot.blockAt(rimTop))
  } catch (e) { rec.scoopedBack = false; rec.scoopErr = String(e.message || e).slice(0, 60) }
  return rec
}

// --- climb2: the viable 2-pour climb: pour high (feet+5) from the floor,
// swim to the tall plateau, rim-pour + overflow + hop + exit + strip.
// Usage: rim2 [N]. ASSAY_HIGH_DY (default 5): first-pour height.
async function cmdClimb2(bot) {
  const rows = []
  const N = parseInt(process.argv[3] || '3', 10)
  const RIM_Y = parseFloat(process.env.ASSAY_RIM_Y || '59.5')
  const HIGH_DY = parseInt(process.env.ASSAY_HIGH_DY || '5', 10)
  for (let n = 1; n <= N; n++) {
    await resetPit(bot)
    await rcon(`give ${BOT} water_bucket 1`) // 2 total: high pour + rim pour
    await settle(bot)
    const fr = await freezeCheck(bot)
    const t0 = Date.now()
    const rec = { n, frozen: fr.frozen, unfroze: fr.unfroze }
    // High pour from the floor (single source; stacked sources pin).
    let wall = null
    try {
      await equipBucket(bot, 'water_bucket')
      for (let dy = HIGH_DY; dy >= 3 && !wall; dy--) wall = findWall(bot, dy)
      if (!wall) throw new Error('no-high-wall')
      await bot.lookAt(wall.ref.position.offset(
        0.5 + wall.face.x * 0.5, 0.5 + wall.face.y * 0.5, 0.5 + wall.face.z * 0.5))
      await sleep(350)
      bot.activateItem()
      await sleep(1500)
      if (!isWater(bot.blockAt(wall.destPos))) throw new Error('pour-no-water')
    } catch (e) {
      rec.poured = false
      rec.note = String(e.message || e).slice(0, 80)
      console.log(`climb2#${n}: pour failed (${rec.note})`)
      rows.push(rec)
      continue
    }
    rec.poured = true
    rec.sourceY = wall.destPos.y
    const p = bot.entity.position
    await rcon(`tp ${BOT} ${(Math.floor(p.x) + 0.5).toFixed(1)} ${p.y.toFixed(1)} ${(Math.floor(p.z) + 0.5).toFixed(1)}`)
    await sleep(1000)
    const sw = await swimUp(bot, wall.destPos.y - 0.5, 20000)
    rec.swim = { ...sw, yt: `[${sw.yt.length}]` }
    rec.climbSecs = +((Date.now() - t0) / 1000).toFixed(1)
    if (!sw.reached) {
      rec.note = 'swim-timeout'
      console.log(`climb2#${n}: src=${rec.sourceY} swim FAIL y1=${sw.y1}`)
      rows.push(rec)
      continue
    }
    const to = await topOut(bot, RIM_Y)
    Object.assign(rec, to)
    // Strip: scoop the high source back from the rim (reach permitting).
    try {
      const sc = await scoopWater(bot, wall.destPos)
      rec.strippedHigh = sc.ok
    } catch (e) { rec.strippedHigh = false }
    rec.highDry = !isWater(bot.blockAt(wall.destPos))
    console.log(`climb2#${n}: src=${rec.sourceY} swim=${sw.y1}/${sw.secs}s exited=${rec.exited} fell=${rec.fell} back=${rec.scoopedBack} strip=${rec.strippedHigh} secs=${rec.climbSecs}+${rec.topSecs || 0}`)
    rows.push(rec)
  }
  saveOut(rows)
  return rows
}

function saveOut(rows) {
  if (!process.env.ASSAY_OUT) return
  fs.writeFileSync(process.env.ASSAY_OUT, JSON.stringify(rows, null, 1) + '\n')
  console.log(`wrote ${process.env.ASSAY_OUT}`)
}

async function main() {
  const cmd = process.argv[2] || 'recon'
  const bot = await connect()
  console.log(`assay tag=${TAG} bot=${BOT} port=${PORT} pit=${PIT.join(',')} cmd=${cmd}`)
  try {
    if (cmd === 'recon') await cmdRecon(bot)
    else if (cmd === 'recon2') await cmdRecon2(bot, process.argv[3])
    else if (cmd === 'recon3') await cmdRecon3(bot, process.argv[3])
    else if (cmd === 'pour') await cmdPour(bot)
    else if (cmd === 'place') await cmdPlace(bot)
    else if (cmd === 'swim') await cmdSwim(bot)
    else if (cmd === 'rim') await cmdRim(bot)
    else if (cmd === 'climb2') await cmdClimb2(bot)
    else throw new Error(`unknown cmd: ${cmd} (recon|pour|swim|rim|deep|scoop|full)`)
  } finally {
    try { bot.quit() } catch (_) {}
    await sleep(800)
    process.exit(0)
  }
}

if (require.main === module) {
  main().catch((e) => { console.error('ASSAY-ERROR', e && e.message ? e.message : e); process.exit(2) })
}
