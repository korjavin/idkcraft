// idkcraft-neuc.1 acceptance smoke: the wave-1 wire contract against a real
// rig client (Paper slot z + the offline body). Boot the rig with the mod ws
// published, then run this:
//
//   MOD_PORT=7778 BARITONE_IMAGE=idkcraft-baritone:neuc1 sh baritone/bridge/rig.sh &
//   node baritone/bridge/mod/smoke.js            # after "rig z up"
//
// (rig.sh holds the rig up once neuc.2 lands; MOD_PORT is neuc.5's client.sh.
// Until both merge, borrow their files — see the bead transcript.)
// Uses the REAL BridgeTransport (bot/src/bridge/transport.js), so a green run
// proves the mod speaks what the adapter parses. Exits 0 on PASS, 1 on the
// first FAIL.
'use strict'

const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const { BridgeTransport } = require('../../../bot/src/bridge/transport.js')

const MOD_HOST = process.env.MOD_HOST || 'localhost'
const MOD_PORT = parseInt(process.env.MOD_PORT || '7778', 10)
const RIG = process.env.RIG_CONTAINER || 'idk-replay-z'
const SPOT = process.env.GOTO_SPOT || 'EP1'
const BOT = process.env.BOT || 'IdkBody'

function fail(step, what) {
  console.log(`FAIL ${step}: ${what}`)
  process.exit(1)
}

function pass(step, what) {
  console.log(`PASS ${step}: ${what}`)
}

function sh(cmd, args, timeoutMs = 20000) {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', timeout: timeoutMs })
  } catch (e) {
    return null
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

async function waitTerminal(notes, id, secs) {
  for (let i = 0; i < secs; i++) {
    await sleep(1000)
    const ev = notes.find((n) => n.method === 'baritone.event' && n.params && n.params.id === id) || null
    if (ev) return ev
  }
  return null
}

function resolved(notes, id) {
  return notes.some((n) => n.method === 'baritone.event' && n.params && n.params.id === id)
}

async function main() {
  const spotsPath = path.join(__dirname, '..', '..', '..', 'bot', 'tools', 'stuck-spots.json')
  let spot
  try {
    const spots = JSON.parse(fs.readFileSync(spotsPath, 'utf8'))
    spot = spots.find((s) => s.name === SPOT)
  } catch (e) {
    fail('spots', `cannot read ${spotsPath}: ${e.message}`)
  }
  if (!spot || !Array.isArray(spot.goal)) fail('spots', `no goal for spot ${SPOT}`)
  const [gx, gy, gz] = spot.goal
  console.log(`smoke: spot=${SPOT} goal=${gx} ${gy} ${gz} rig=${RIG} ws=${MOD_HOST}:${MOD_PORT}`)

  const t = new BridgeTransport(`ws://${MOD_HOST}:${MOD_PORT}/rpc`, { timeoutMs: 8000 })
  const notes = []
  t.on('event', (method, params) => {
    notes.push({ method, params, at: Date.now() })
    if (notes.length < 12) console.log(`  note: ${method} ${JSON.stringify(params)}`)
  })
  let connected = false
  for (let i = 0; i < 15 && !connected; i++) {
    try {
      await t.connect()
      connected = true
    } catch (e) {
      if (i === 0) console.log(`  waiting for the mod ws (${e.message})`)
      await sleep(2000)
    }
  }
  if (!connected) fail('connect', 'mod ws never answered')

  // 1. hello — mc must be the exact minecraft-data key (the adapter gates
  // the static registry on it), baritone the real mod version.
  const hello = await t.call('hello', {})
  console.log(`  hello: ${JSON.stringify(hello)}`)
  if (!hello || hello.mod !== 'idkcraft-bridge') fail('hello', `bad mod: ${JSON.stringify(hello)}`)
  if (hello.mc !== '26.1.2') fail('hello', `bad mc (want 26.1.2): ${JSON.stringify(hello)}`)
  if (typeof hello.baritone !== 'string' || !hello.baritone) fail('hello', 'missing baritone version')
  pass('hello', `mod=${hello.mod} v=${hello.v} mc=${hello.mc} baritone=${hello.baritone}`)

  // 2. state.get — the full in-world snapshot (poll: the first call kicks
  // the lazy client init and the snapshot lands on the next client tick).
  let st = null
  for (let i = 0; i < 20; i++) {
    st = await t.call('state.get', {})
    if (st && st.pos) break
    await sleep(500)
  }
  const pos = st && st.pos
  const finite = (n) => typeof n === 'number' && Number.isFinite(n)
  if (!pos || !finite(pos.x) || !finite(pos.y) || !finite(pos.z)) fail('state.get', `bad pos: ${JSON.stringify(st)}`)
  for (const [k, ok] of [
    ['yaw', finite(pos.yaw)], ['pitch', finite(pos.pitch)],
    ['onGround', typeof pos.onGround === 'boolean'],
    ['health', finite(st.health)], ['food', finite(st.food)], ['oxygen', finite(st.oxygen)],
    ['time', st.time && finite(st.time.age) && finite(st.time.timeOfDay) && finite(st.time.day) && typeof st.time.isDay === 'boolean'],
    ['spawn', st.spawn && finite(st.spawn.x) && finite(st.spawn.y) && finite(st.spawn.z)],
    ['isRaining', typeof st.isRaining === 'boolean'], ['isSleeping', typeof st.isSleeping === 'boolean'],
    ['dimension', typeof st.dimension === 'string' && !!st.dimension],
    ['gameMode', typeof st.gameMode === 'string' && !!st.gameMode],
  ]) {
    if (!ok) fail('state.get', `bad ${k}: ${JSON.stringify(st)}`)
  }
  pass('state.get', `pos=${pos.x.toFixed(1)} ${pos.y.toFixed(1)} ${pos.z.toFixed(1)} hp=${st.health} dim=${st.dimension} mode=${st.gameMode}`)

  // 3. chat.send — the line must reach the server log.
  const tag = `smoke${Date.now().toString(36)}`
  const sent = await t.call('chat.send', { message: `hi-${tag}` })
  if (!sent || sent.sent !== true) fail('chat.send', `bad reply: ${JSON.stringify(sent)}`)
  let line = null
  for (let i = 0; i < 15 && !line; i++) {
    await sleep(1000)
    const logs = sh('docker', ['logs', '--since', '2m', RIG])
    if (logs) line = logs.split('\n').find((l) => l.includes(tag)) || null
  }
  if (!line) fail('chat.send', `hi-${tag} never reached the server log`)
  pass('chat.send', line.trim().slice(-120))

  // 4. inbound system chat — rcon say must arrive as a message event.
  const tag2 = `say${Date.now().toString(36)}`
  const said = sh('docker', ['exec', RIG, 'rcon-cli', `say ${tag2}`])
  if (said === null) fail('message', 'rcon say failed')
  let got = null
  for (let i = 0; i < 15 && !got; i++) {
    await sleep(1000)
    got = notes.find((n) => n.method === 'message' && JSON.stringify(n.params).includes(tag2)) || null
  }
  if (!got) fail('message', `no message event for say ${tag2} (saw ${notes.length} notes)`)
  pass('message', `${got.params.position || '?'}: ${(got.params.message || '').slice(0, 80)}`)
  const chats = notes.filter((n) => n.method === 'chat')
  console.log(`  info: ${chats.length} chat event(s) so far` +
    (chats.length ? ` first from=${chats[0].params.username} text=${JSON.stringify((chats[0].params.message || '').slice(0, 60))}` : ''))

  // 5. entities.list / roster.get (neuc.3, enabled by this bead) — shape
  // plus our own tab entry; mob content depends on the world, so the list
  // asserts shape only.
  const el = await t.call('entities.list', {})
  if (!el || !Array.isArray(el.entities)) fail('entities.list', `bad reply: ${JSON.stringify(el)}`)
  const self = el.entities.find((e) => e.self)
  pass('entities.list', `${el.entities.length} entities` +
    (self ? ` self id=${self.id} pos=${self.pos.x.toFixed(1)} ${self.pos.y.toFixed(1)} ${self.pos.z.toFixed(1)}` : ' (self not listed)'))
  const ro = await t.call('roster.get', {})
  if (!ro || !Array.isArray(ro.players)) fail('roster.get', `bad reply: ${JSON.stringify(ro)}`)
  const me = ro.players.find((p) => p.name === BOT)
  if (!me) fail('roster.get', `${BOT} not in roster: ${JSON.stringify(ro.players.map((p) => p.name))}`)
  if (typeof me.uuid !== 'string' || typeof me.ping !== 'number') fail('roster.get', `bad entry: ${JSON.stringify(me)}`)
  pass('roster.get', `${ro.players.length} player(s), ${BOT} ping=${me.ping} mode=${me.gameMode}`)

  // 6. baritone.cmd — walk EP1, the id must echo through status + event.
  // Prep mirrors the kqzf spike (rig-goto.js): teleport to the spot spawn,
  // clear, kit up — Baritone needs the pickaxe where the spot says so.
  const [sx, sy, sz] = spot.spawn
  for (const cmd of spot.prep || []) sh('docker', ['exec', RIG, 'rcon-cli', cmd])
  sh('docker', ['exec', RIG, 'rcon-cli', `tp ${BOT} ${sx} ${sy} ${sz}`])
  sh('docker', ['exec', RIG, 'rcon-cli', `clear ${BOT}`])
  if ((spot.scaffold || 0) > 0) sh('docker', ['exec', RIG, 'rcon-cli', `give ${BOT} dirt ${spot.scaffold}`])
  if (spot.pickaxe) sh('docker', ['exec', RIG, 'rcon-cli', `give ${BOT} stone_pickaxe 1`])
  if (spot.bucket) {
    sh('docker', ['exec', RIG, 'rcon-cli', `give ${BOT} water_bucket 1`])
    sh('docker', ['exec', RIG, 'rcon-cli', `give ${BOT} water_bucket 1`])
  }
  for (const e of ['water_breathing', 'fire_resistance']) {
    sh('docker', ['exec', RIG, 'rcon-cli', `effect give ${BOT} minecraft:${e} 300`])
  }
  let atSpawn = false
  for (let i = 0; i < 20 && !atSpawn; i++) {
    await sleep(500)
    const cur = await t.call('state.get', {})
    atSpawn = cur && cur.pos && Math.abs(cur.pos.x - sx) < 2 && Math.abs(cur.pos.z - sz) < 2
  }
  if (!atSpawn) fail('baritone.cmd', `tp to spawn ${sx} ${sy} ${sz} never showed in state.get`)
  console.log(`  at spawn: ${sx} ${sy} ${sz}`)
  const cmd = await t.call('baritone.cmd', { command: `#goto ${gx} ${gy} ${gz}` })
  if (!cmd || typeof cmd.id !== 'number' || cmd.id < 1) fail('baritone.cmd', `bad reply: ${JSON.stringify(cmd)}`)
  pass('baritone.cmd', `id=${cmd.id} for #goto ${gx} ${gy} ${gz}`)
  for (let i = 0; i < 3; i++) {
    await sleep(1000)
    const bs = await t.call('baritone.status', {})
    console.log(`  status poll ${i + 1}: ${JSON.stringify(bs)}`)
    if (!bs || bs.id !== cmd.id) fail('baritone.status', `id not echoed: ${JSON.stringify(bs)}`)
  }
  let ev = null
  for (let i = 0; i < 100 && !ev; i++) {
    await sleep(1000)
    ev = notes.find((n) => n.method === 'baritone.event' && n.params && n.params.id === cmd.id) || null
  }
  if (!ev) fail('baritone.event', `no terminal event for id=${cmd.id} within 100 s`)
  console.log(`  baritone.event: ${JSON.stringify(ev.params)}`)
  if (ev.params.status !== 'success') fail('baritone.event', `want success, got ${ev.params.status}`)
  pass('baritone.event', `id=${ev.params.id} status=success`)

  // 6b. Mid-walk #set (the neuc.4 lease case): a control mints a fresh id
  // but leaves the goal armed — success still arrives under the GOAL id.
  const back = await t.call('baritone.cmd', { command: `#goto ${sx} ${sy} ${sz}` })
  if (!back || typeof back.id !== 'number' || back.id <= cmd.id) fail('midwalk.set', `bad reply: ${JSON.stringify(back)}`)
  await sleep(3000)
  const set = await t.call('baritone.cmd', { command: '#set echoCommands false' })
  if (!set || typeof set.id !== 'number' || set.id <= back.id) fail('midwalk.set', `bad set reply: ${JSON.stringify(set)}`)
  const bsSet = await t.call('baritone.status', {})
  if (!bsSet || bsSet.id !== back.id) fail('midwalk.set', `#set re-armed the tracker: ${JSON.stringify(bsSet)}`)
  const evSet = await waitTerminal(notes, back.id, 120)
  if (!evSet) fail('midwalk.set', `no terminal event for id=${back.id} within 120 s`)
  if (evSet.params.status !== 'success') fail('midwalk.set', `want success, got ${evSet.params.status}`)
  if (resolved(notes, set.id)) fail('midwalk.set', `#set id=${set.id} resolved (controls never resolve)`)
  await t.call('baritone.cmd', { command: '#set echoCommands true' }).catch(() => {})
  pass('midwalk.set', `goal id=${back.id} success; set id=${set.id} silent`)

  // 6c. Pause/resume (the revmux 01 scenario): the walk continues after the
  // resume and success arrives under the GOAL id, not the resume's.
  const pr = await t.call('baritone.cmd', { command: `#goto ${gx} ${gy} ${gz}` })
  if (!pr || typeof pr.id !== 'number' || pr.id <= set.id) fail('midwalk.pause', `bad reply: ${JSON.stringify(pr)}`)
  await sleep(2000)
  const pau = await t.call('baritone.cmd', { command: '#pause' })
  if (!pau || typeof pau.id !== 'number' || pau.id <= pr.id) fail('midwalk.pause', `bad pause reply: ${JSON.stringify(pau)}`)
  await sleep(3000)
  const rsm = await t.call('baritone.cmd', { command: '#resume' })
  if (!rsm || typeof rsm.id !== 'number' || rsm.id <= pau.id) fail('midwalk.pause', `bad resume reply: ${JSON.stringify(rsm)}`)
  const bsPr = await t.call('baritone.status', {})
  if (!bsPr || bsPr.id !== pr.id) fail('midwalk.pause', `pause/resume re-armed the tracker: ${JSON.stringify(bsPr)}`)
  const evPr = await waitTerminal(notes, pr.id, 120)
  if (!evPr) fail('midwalk.pause', `no terminal event for id=${pr.id} within 120 s`)
  if (evPr.params.status !== 'success') fail('midwalk.pause', `want success, got ${evPr.params.status}`)
  if (resolved(notes, pau.id)) fail('midwalk.pause', `#pause id=${pau.id} resolved (controls never resolve)`)
  if (resolved(notes, rsm.id)) fail('midwalk.pause', `#resume id=${rsm.id} resolved (controls never resolve)`)
  pass('midwalk.pause', `goal id=${pr.id} success; pause id=${pau.id} resume id=${rsm.id} silent`)

  // 6d. Mid-walk #stop: the TRACKED goal id resolves as stopped.
  const stp = await t.call('baritone.cmd', { command: `#goto ${sx} ${sy} ${sz}` })
  if (!stp || typeof stp.id !== 'number' || stp.id <= rsm.id) fail('midwalk.stop', `bad reply: ${JSON.stringify(stp)}`)
  await sleep(3000)
  const halt = await t.call('baritone.cmd', { command: '#stop' })
  if (!halt || typeof halt.id !== 'number' || halt.id <= stp.id) fail('midwalk.stop', `bad stop reply: ${JSON.stringify(halt)}`)
  const evStop = await waitTerminal(notes, stp.id, 15)
  if (!evStop) fail('midwalk.stop', `no terminal event for id=${stp.id} within 15 s`)
  if (evStop.params.status !== 'stopped') fail('midwalk.stop', `want stopped, got ${evStop.params.status}`)
  const bsStop = await t.call('baritone.status', {})
  if (!bsStop || bsStop.id !== stp.id) fail('midwalk.stop', `status id moved: ${JSON.stringify(bsStop)}`)
  if (bsStop.pathing) fail('midwalk.stop', 'still pathing after stop')
  if (resolved(notes, halt.id)) fail('midwalk.stop', `#stop id=${halt.id} resolved (controls never resolve)`)
  pass('midwalk.stop', `goal id=${stp.id} stopped; stop id=${halt.id} silent`)

  const fin = await t.call('state.get', {})
  console.log(`  final pos: ${fin.pos.x.toFixed(1)} ${fin.pos.y.toFixed(1)} ${fin.pos.z.toFixed(1)}`)
  t.close()
  console.log('SMOKE: ALL PASS')
}

main().catch((e) => fail('smoke', (e && e.stack) || e))
