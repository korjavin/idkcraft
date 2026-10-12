// node --test baritone/ — pure parts of the A/B driver.
const test = require('node:test')
const assert = require('node:assert')
const net = require('node:net')
const path = require('node:path')
const { parsePos, parseCount, dist, reachedAt, command, loadSpots, sendBridgeLine } = require('./ab.js')

test('parses rcon replies', () => {
  assert.deepStrictEqual(parsePos('BaritoneBot has the following entity data: [-61.3d, 66.0d, -210.5d]'), [-61.3, 66, -210.5])
  assert.strictEqual(parsePos('No entity was found'), null)
  assert.strictEqual(parseCount('Found 7 matching item(s) on player BaritoneBot'), 7)
  assert.strictEqual(parseCount('No items were found on player BaritoneBot'), 0)
})

test('xz goals ignore y', () => {
  assert.strictEqual(dist([3, 90, 4], [3, 4]), 0)
  assert.strictEqual(dist([0, 90, 0], [0, 0, 0]), 90)
})

test('corpus filter = the 16 vhlb.1 follow spots + tasks', () => {
  const spots = loadSpots(path.join(__dirname, '../bot/tools/stuck-spots.json'), path.join(__dirname, 'tasks.json'))
  const follow = spots.filter((s) => !s.why)
  assert.strictEqual(follow.length, 16)
  assert.ok(follow.every((s) => s.goal.length === 3 && s.secs <= 90))
  assert.strictEqual(command(spots.find((s) => s.name === 'BED-60')), '#goto 0 -210')
  assert.strictEqual(command(spots.find((s) => s.name === 'MINE-10')), '#mine 10 iron_ore deepslate_iron_ore')
  assert.strictEqual(command(follow[0]), '#goto -72 65 -218')
  const s7 = follow.find((s) => s.name === 'S7') // spawn 1.9 from goal
  assert.strictEqual(reachedAt(s7, s7.spawn), false)
  assert.strictEqual(reachedAt(s7, [-39.3, 62, -199.3]), true) // inside the goal block, off its corner
  assert.strictEqual(reachedAt(follow[0], [-70, 65, -218]), true) // EP1: 2.5 radius
})

test('bridge writer delivers one line + newline per connection', async () => {
  const lines = []
  const server = net.createServer((sock) => {
    let buf = ''
    sock.on('data', (c) => { buf += c })
    sock.on('end', () => { lines.push(buf); sock.end() })
  })
  await new Promise((res) => server.listen(0, 'localhost', res))
  const port = server.address().port
  await sendBridgeLine({ host: 'localhost', port, line: 'msg #goto 1 2 3' })
  await sendBridgeLine({ host: 'localhost', port, line: 'connect mc 25565' })
  for (let i = 0; i < 100 && lines.length < 2; i++) await new Promise((r) => setTimeout(r, 10))
  assert.deepStrictEqual(lines, ['msg #goto 1 2 3\n', 'connect mc 25565\n'])
  await new Promise((res) => server.close(res))
  await assert.rejects( // localhost resolves twice: node rejects with an AggregateError
    sendBridgeLine({ host: 'localhost', port, line: 'x', timeoutMs: 1000 }),
    (e) => e.code === 'ECONNREFUSED' || (Array.isArray(e.errors) && e.errors.every((x) => x.code === 'ECONNREFUSED')))
})
