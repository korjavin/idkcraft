/* skill {"name":"gen_bare_pit_climb","description":"climb: in a deep pit with no pickaxe and no blocks, water bucket on hand, a wall notch near the top — pour water high against the notch wall, swim up the fall, step onto the notch, scoop the water back","kind":"recover","verb":"swimming up the pit","body":"any","verifiedBy":{"scenario":"water-climb","verdict":"baseline: 1/1 ok, 0 improved, 0 regressed, 0 env (stuck-baseline-v2.json) | micro-run: exit 0 in 77s","sha":"e8688b96","body":"baritone"},"bead":"idkcraft-vf8e.4"} */

function feasible(facts) {
  return facts.bucket >= 1 && facts.goalDy >= 2 && !facts.pickaxe && facts.scaffold === 0 && !facts.lavaNear
}

function air(bot, x, y, z) {
  const b = bot.blockAt(x, y, z)
  return !!b && !b.solid && b.name !== 'lava'
}
function solid(bot, x, y, z) {
  const b = bot.blockAt(x, y, z)
  return !!b && b.solid
}

function scan(bot) {
  const p = bot.pos()
  const bx = Math.floor(p.x), by = Math.floor(p.y), bz = Math.floor(p.z)
  const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]]
  let best = null
  for (let dx = -4; dx <= 4; dx++) for (let dz = -4; dz <= 4; dz++) {
    for (let ny = by + 2; ny <= by + 6; ny++) {
      const nx = bx + dx, nz = bz + dz
      if (!solid(bot, nx, ny - 1, nz) || !air(bot, nx, ny, nz) || !air(bot, nx, ny + 1, nz)) continue
      for (const d of dirs) {
        const ix = nx - d[0], iz = nz - d[1]
        let ok = true
        for (let y = by; y <= ny + 1 && ok; y++) if (!air(bot, ix, y, iz)) ok = false
        if (!ok) continue
        const sx = nx - 2 * d[0], sz = nz - 2 * d[1]
        if (!air(bot, sx, by, sz) || !air(bot, sx, by + 1, sz) || !solid(bot, sx, by - 1, sz)) continue
        const score = ny * 100 + Math.abs(dx) + Math.abs(dz)
        if (!best || score < best.score) best = { score, nx, ny, nz, ix, iz, sx, sz, by, dx: d[0], dz: d[1] }
        break
      }
    }
  }
  return best
}

function release(bot) {
  bot.control('forward', false); bot.control('jump', false)
  bot.control('sprint', false); bot.control('sneak', false)
}

function run(bot, st) {
  st.pt = (st.pt || 0) + 1
  const p = bot.pos()
  const s = bot.status()
  const fx = Math.floor(p.x), fy = Math.floor(p.y), fz = Math.floor(p.z)
  const go = (ph) => { st.ph = ph; st.pt = 0 }
  if (!st.ph) {
    if (bot.count('water_bucket') < 1) return 'failed:no-water-bucket'
    const g = scan(bot)
    if (!g) return 'failed:no-notch'
    st.g = g
    st.wb0 = bot.count('water_bucket')
    go('walk')
    return 'running'
  }
  const g = st.g
  if (st.ph === 'walk') {
    if (fx === g.sx && fz === g.sz && fy === g.by && Math.abs(p.x - g.sx - 0.5) <= 0.4 && Math.abs(p.z - g.sz - 0.5) <= 0.4) {
      bot.stop(); go('nudge'); return 'running'
    }
    if (st.pt > 15) return 'failed:no-stand'
    bot.goto(g.sx + 0.5, g.by, g.sz + 0.5, 0)
    return 'running'
  }
  if (st.ph === 'nudge') {
    const along = (p.x - g.sx - 0.5) * g.dx + (p.z - g.sz - 0.5) * g.dz
    if (along >= 0.12 || st.pt > 6) { release(bot); bot.equip('water_bucket', 'hand'); go('pour'); return 'running' }
    bot.lookAt(g.nx + 0.5, g.by + 1.6, g.nz + 0.5)
    bot.control('sneak', true)
    bot.control('forward', true)
    return 'running'
  }
  if (st.ph === 'pour') {
    release(bot)
    if (s.busy) { if (st.pt > 8) return 'failed:pour-busy'; return 'running' }
    if (st.pt < 2) return 'running'
    if (!st.poured) {
      const r = bot.use(g.nx, g.ny, g.nz)
      if (r === 'started') { st.poured = true; st.pp = st.pt; return 'running' }
      if (r === 'busy') return 'running'
      return 'failed:pour-' + String(r).replace(/[^a-z0-9-]/g, '-').slice(0, 30)
    }
    let src = null
    for (let y = g.ny; y >= g.by; y--) {
      const b = bot.blockAt(g.ix, y, g.iz)
      if (b && b.name === 'water') { src = { x: g.ix, y, z: g.iz }; break }
    }
    if (src && src.y >= g.ny - 1) { st.src = src; go('enter'); return 'running' }
    if (st.pt - st.pp > 4) {
      if (src && src.y >= g.ny - 2) { st.src = src; go('enter'); return 'running' }
      return 'failed:no-water'
    }
    return 'running'
  }
  if (st.ph === 'enter') {
    if (fx === g.ix && fz === g.iz) { go('swim'); return 'running' }
    if (st.pt > 6) { release(bot); return 'failed:no-enter' }
    bot.lookAt(g.nx + 0.5, p.y + 1.6, g.nz + 0.5)
    bot.control('forward', true)
    return 'running'
  }
  if (st.ph === 'swim') {
    if (fy >= g.ny && !(fx === g.ix && fz === g.iz)) { release(bot); go('scoop'); return 'running' }
    if (st.pt > 25) { release(bot); return 'failed:no-climb' }
    bot.lookAt(g.nx + 0.5, g.ny + 1.5, g.nz + 0.5)
    bot.control('jump', true)
    bot.control('forward', true)
    return 'running'
  }
  if (st.ph === 'scoop') {
    release(bot)
    if (bot.count('water_bucket') >= st.wb0) { go('hop'); return 'running' }
    if (s.busy) return 'running'
    if (!st.eq) { bot.equip('bucket', 'hand'); st.eq = true; return 'running' }
    if (st.pt > 12) return 'failed:no-scoop'
    if (st.pt % 2 === 0) bot.use(st.src.x, st.src.y, st.src.z)
    return 'running'
  }
  if (st.ph === 'hop') {
    const rx = g.nx + g.dx, rz = g.nz + g.dz
    if (!(solid(bot, rx, g.ny, rz) && air(bot, rx, g.ny + 1, rz) && air(bot, rx, g.ny + 2, rz))) { release(bot); return 'done' }
    if ((fy >= g.ny + 1 && p.onGround) || st.pt > 6) { release(bot); return 'done' }
    bot.lookAt(rx + 0.5, g.ny + 1.5, rz + 0.5)
    bot.control('forward', true)
    bot.control('jump', true)
    return 'running'
  }
  return 'failed:bad-phase'
}
