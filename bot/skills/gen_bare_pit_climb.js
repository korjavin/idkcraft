/* skill {"name":"gen_bare_pit_climb","description":"climb: in a pit with a water bucket, no pickaxe or blocks, a ledge in the wall within reach — pour one bucket on the wall below the ledge, swim up the fall, scoop it back","kind":"recover","body":"any","verb":"swimming out of the pit","verifiedBy":{"scenario":"water-climb","verdict":"baseline: 1/1 ok, 0 improved, 0 regressed, 0 env (stuck-baseline-v2.json) | micro-run: exit 0 in 71s","sha":"cff5482b","body":"baritone"},"bead":"idkcraft-vf8e.13"} */

function feasible(f) {
  var b = typeof f.bucket === 'number' ? f.bucket : (f.bucket ? 1 : 0)
  return b >= 1 && f.goalDy >= 2 && !f.lavaNear && !f.water
}

var REACH = 4.4
var PLAN_REACH = 4.2

function isAir(b) { return !!b && (b.name === 'air' || b.name === 'cave_air' || b.name === 'void_air') }
function isOpen(b) { return !!b && !b.solid && b.name !== 'water' && b.name !== 'lava' }

function eyeDist(p, c) {
  return Math.hypot(c.px + 0.5 - p.x, c.ly + 0.5 - (p.y + 1.62), c.pz + 0.5 - p.z)
}

function scan(bot, st) {
  var p = bot.pos()
  var fx = Math.floor(p.x), fy = Math.floor(p.y + 0.2), fz = Math.floor(p.z)
  var dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]]
  var best = null
  for (var dx = -3; dx <= 3; dx++) for (var dz = -3; dz <= 3; dz++) for (var ly = fy + 2; ly <= fy + 5; ly++) {
    var lx = fx + dx, lz = fz + dz
    var L = bot.blockAt(lx, ly, lz)
    if (!L || !L.solid) continue
    if (!isOpen(bot.blockAt(lx, ly + 1, lz)) || !isOpen(bot.blockAt(lx, ly + 2, lz))) continue
    for (var i = 0; i < 4; i++) {
      var px = lx + dirs[i][0], pz = lz + dirs[i][1]
      var key = px + ',' + ly + ',' + pz
      if (st.bad[key]) continue
      // reach from the planned stand (directly below the pour cell), checked first
      var reach = Math.hypot(0, ly + 0.5 - (fy + 1.62), 0)
      if (reach > PLAN_REACH) continue
      var floor = bot.blockAt(px, fy - 1, pz)
      if (!floor || !floor.solid) continue
      var ok = true
      for (var y = fy; y <= ly; y++) { if (!isAir(bot.blockAt(px, y, pz))) { ok = false; break } }
      if (!ok) continue
      var bd = Math.hypot(px + 0.5 - p.x, pz + 0.5 - p.z)
      if (bd > 4.5) continue
      var score = reach + 0.3 * bd - 0.05 * (ly - fy)
      if (!best || score < best.score) {
        best = { px: px, pz: pz, ly: ly, lx: lx, lz: lz, fy: fy, key: key, score: score }
      }
    }
  }
  return best
}

function ban(st) { if (st.c) st.bad[st.c.key] = true; st.nbad = (st.nbad || 0) + 1; st.ph = 'scan' }

function release(bot) {
  bot.control('forward', false); bot.control('jump', false); bot.control('sprint', false)
  bot.stop()
}

function run(bot, st) {
  if (!st.ph) { st.ph = 'scan'; st.bad = {}; st.wb0 = bot.count('water_bucket'); st.nbad = 0 }
  var p = bot.pos()
  var s = bot.status()
  var c = st.c
  if (st.ph === 'scan') {
    if (st.nbad > 8) return 'failed:no-reachable-notch'
    if (st.wb0 < 1) return 'failed:no-water-bucket'
    st.c = scan(bot, st)
    if (!st.c) return 'failed:no-notch'
    st.ph = 'move'; st.t = 0
    return 'running'
  }
  if (st.ph === 'move') {
    st.t++
    var inCol = Math.floor(p.x) === c.px && Math.floor(p.z) === c.pz
    if (inCol && p.onGround && eyeDist(p, c) <= REACH) { bot.stop(); st.ph = 'equip'; return 'running' }
    if (st.t > 10) { bot.stop(); ban(st); return 'running' }
    bot.goto(c.px + 0.5, c.fy, c.pz + 0.5, 0)
    return 'running'
  }
  if (st.ph === 'equip') {
    if (s.busy) return 'running'
    var r = bot.equip('water_bucket', 'hand')
    if (r.indexOf('denied') === 0) return 'failed:equip-denied'
    st.ph = 'pour'; st.t = 0
    return 'running'
  }
  if (st.ph === 'pour') {
    if (s.busy) return 'running'
    st.t++
    if (eyeDist(p, c) > REACH) { ban(st); return 'running' }
    var u = bot.use(c.px, c.ly, c.pz)
    if (u === 'started') { st.ph = 'pourwait'; st.t = 0; return 'running' }
    if (u === 'busy' && st.t < 5) return 'running'
    ban(st)
    return 'running'
  }
  if (st.ph === 'pourwait') {
    if (s.busy) return 'running'
    st.t++
    var w = bot.blockAt(c.px, c.ly, c.pz)
    if (w && w.name === 'water' && bot.count('water_bucket') < st.wb0) { st.ph = 'swim'; st.t = 0; return 'running' }
    if (st.t > 3) {
      if (bot.count('water_bucket') < st.wb0) return 'failed:pour-misplaced'
      ban(st)
    }
    return 'running'
  }
  if (st.ph === 'swim') {
    st.t++
    if (p.onGround && p.y >= c.ly + 0.9) { release(bot); st.up = true; st.ph = 'equip2'; return 'running' }
    if (st.t > 25) { release(bot); st.ph = 'equip2'; return 'running' }
    bot.lookAt(c.lx + 0.5, c.ly + 1.5, c.lz + 0.5)
    bot.control('forward', true)
    bot.control('jump', true)
    return 'running'
  }
  if (st.ph === 'equip2') {
    if (s.busy) return 'running'
    var e = bot.equip('bucket', 'hand')
    if (e.indexOf('denied') === 0) return 'failed:equip-bucket-denied'
    st.ph = 'scoop'; st.t = 0
    return 'running'
  }
  if (st.ph === 'scoop') {
    if (s.busy) return 'running'
    st.t++
    if (bot.count('water_bucket') >= st.wb0) return st.up ? 'done' : 'failed:swim-short'
    if (st.t > 10) return 'failed:scoop-failed'
    if (eyeDist(p, c) > REACH) {
      if (st.up) bot.goto(c.lx + 0.5, c.ly + 1, c.lz + 0.5, 0)
      else bot.goto(c.px + 0.5, c.fy, c.pz + 0.5, 0)
      return 'running'
    }
    bot.stop()
    var k = bot.use(c.px, c.ly, c.pz)
    if (k === 'started') { st.ph = 'scoopwait'; st.t2 = 0 }
    return 'running'
  }
  if (st.ph === 'scoopwait') {
    if (s.busy) return 'running'
    st.t2++
    if (bot.count('water_bucket') >= st.wb0) return st.up ? 'done' : 'failed:swim-short'
    if (st.t2 > 2) st.ph = 'scoop'
    return 'running'
  }
  return 'failed:bad-phase'
}
