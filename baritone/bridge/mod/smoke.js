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

  // 2. state.get — the full in-world snapshot.
  const st = await t.call('state.get', {})
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
  const token = `smoke${Date.now().toString(36)}`
  const sent = await t.call('chat.send', { message: `hi-${token}` })
  if (!sent || sent.sent !== true) fail('chat.send', `bad reply: ${JSON.stringify(sent)}`)
  let line = null
  for (let i = 0; i < 15 && !line; i++) {
    await sleep(1000)
    const logs = sh('docker', ['logs', '--since', '2m', RIG])
    if (logs) line = logs.split('\n').find((l) => l.includes(token)) || null
  }
  if (!line) fail('chat.send', `hi-${token} never reached the server log`)
  pass('chat.send', line.trim().slice(-120))

  // 4. inbound system chat — rcon say must arrive as a message event.
  const token2 = `say${Date.now().toString(36)}`
  const said = sh('docker', ['exec', RIG, 'rcon-cli', `say ${token2}`])
  if (said === null) fail('message', 'rcon say failed')
  let got = null
  for (let i = 0; i < 15 && !got; i++) {
    await sleep(1000)
    got = notes.find((n) => n.method === 'message' && JSON.stringify(n.params).includes(token2)) || null
  }
  if (!got) fail('message', `no message event for say ${token2} (saw ${notes.length} notes)`)
  pass('message', `${got.params.position || '?'}: ${(got.params.message || '').slice(0, 80)}`)
  const chats = notes.filter((n) => n.method === 'chat')
  console.log(`  info: ${chats.length} chat event(s) so far` +
    (chats.length ? ` first from=${chats[0].params.username} text=${JSON.stringify((chats[0].params.message || '').slice(0, 60))}` : ''))

  // 5. baritone.cmd — walk EP1, the id must echo through status + event.
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

  const fin = await t.call('state.get', {})
  console.log(`  final pos: ${fin.pos.x.toFixed(1)} ${fin.pos.y.toFixed(1)} ${fin.pos.z.toFixed(1)}`)
  t.close()
  console.log('SMOKE: ALL PASS')
}

main().catch((e) => fail('smoke', (e && e.stack) || e))
