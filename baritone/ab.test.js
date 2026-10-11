// node --test baritone/ — pure parts of the A/B driver.
const test = require('node:test')
const assert = require('node:assert')
const path = require('node:path')
const { parsePos, parseCount, dist, reachRadius, command, loadSpots } = require('./ab.js')

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
  assert.strictEqual(reachRadius(follow.find((s) => s.name === 'S7')), 1) // spawn 1.9 from goal
  assert.strictEqual(reachRadius(follow[0]), 2.5)
})
