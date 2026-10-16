'use strict'
// vewo.9: the swarm compose command sleeps (no node) when BOT_SWARM_I >= BOT_SWARM_N.
const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const yml = fs.readFileSync(path.join(__dirname, '../../docker-compose.yml'), 'utf8')
const m = yml.match(/^ {6}- '(if \[ "\$\$\{BOT_SWARM_N[^\n]*)'$/m)
// stub node/sleep so the script just reports its choice
const script = m && m[1].replace(/\$\$/g, '$').replace('exec sleep infinity', 'echo SLEEP; exit 0').replace('exec node src/index.js', 'echo NODE')
const run = (n, i) => spawnSync('sh', ['-c', script], { env: { BOT_SWARM_N: n, BOT_SWARM_I: i }, encoding: 'utf8' }).stdout

describe('swarm compose idle command', () => {
  it('is present on the swarm anchor', () => assert.ok(script))
  it('sleeps for I >= N or N empty, runs node otherwise', () => {
    assert.match(run('', '1'), /swarm idle[\s\S]*SLEEP/)
    assert.match(run('2', '2'), /SLEEP/)
    assert.match(run('13', '14'), /SLEEP/)
    assert.equal(run('2', '1'), 'NODE\n')
    assert.equal(run('33', '32'), 'NODE\n')
  })
})
