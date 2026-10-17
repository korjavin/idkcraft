'use strict'
// neuc.65.1: bot/tools/deaths.sh on a tiny synthetic mc + bot dump.
const { describe, it } = require('node:test')
const assert = require('node:assert')
const path = require('path')
const { execFileSync } = require('child_process')

const DUMP = [
  '2026-10-17 10:00:00 IdkBot was slain by Zombie',
  '2026-10-17 10:00:00 IdkBot death health=0 hostiles=1 at 100 64 0 nearest=zombie 1.0 time=night inside=no step=gather via=retreat owner=fight sword=0 pickaxe=wood dist_home=5 dist_spawn=100',
  '2026-10-17 10:00:00 IdkBot respawn at 0 70 16',
  '2026-10-17 10:00:02 IdkBot respawned at 0 70 16',
  '2026-10-17 10:03:00 IdkBot was shot by Skeleton',
  '2026-10-17 10:03:00 IdkBot death health=0 hostiles=1 at 10 70 20 nearest=skeleton 6.0',
  '2026-10-17 10:03:00 IdkBot respawn at 50 64 50 (bed)',
  '2026-10-17 10:05:00 IdkBot fell from a high place',
  '2026-10-17 10:05:00 IdkBot death health=0 hostiles=0 at 10 70 20 time=day inside=no step=forage owner=work sword=1 pickaxe=none dist_home=none dist_spawn=11',
  '2026-10-17 10:06:00 IdkSwarm3 was slain by Phantom',
  '2026-10-17 10:07:00 IdkSwarm12 was slain by Phantom whilst trying to escape Zombie',
  '2026-10-17 10:08:00 [Not Secure] <IdkBot> next: gathering (goal-fsm)',
  '2026-10-17 10:09:00 IdkBot left the game',
  '2026-10-19 01:00:00 IdkBot drowned',
  // v2: the claim line sorts after its same-second death; the measured
  // 'respawned at' (scattered 9 blocks per axis) overrides the bed claim.
  '2026-10-17 10:10:00 IdkBotV2 respawn at 50 64 50 (bed)',
  '2026-10-17 10:10:00 IdkBotV2 death health=0 hostiles=0 at 300 64 300',
  '2026-10-17 10:10:00 IdkBotV2 was doomed to fall',
  '2026-10-17 10:10:02 IdkBotV2 respawned at 9 70 25',
  '2026-10-17 10:12:00 IdkBotV2 fell off a ladder',
  '2026-10-17 10:12:00 IdkBotV2 death health=0 hostiles=0 at 5 70 20',
  '2026-10-17 10:13:00 UUID of player IdkBotV2 is 0000',
].join('\n') + '\n'

describe('deaths.sh', () => {
  it('prints per-day blocks and per-bot summaries', () => {
    const out = execFileSync('sh', [path.join(__dirname, '..', 'tools', 'deaths.sh')], { input: DUMP, encoding: 'utf8' })
    assert.match(out, /^IdkBot 2026-10-17 deaths=3 lines=3$/m)
    assert.match(out, /^ {2}killer zombie:1,skeleton:1,fell:1$/m)
    assert.match(out, /^ {2}time .*night:1/m)
    // kit facts only from enriched lines; old line reads '?' and dist from 'at';
    // loop = the 10:03 death 3 min after a world-spawn respawn (the bed one is not).
    assert.match(out, /^ {2}kitless=1\/2 near_spawn=2\/3 loop=1\/3$/m)
    assert.match(out, /^swarm 2026-10-17 deaths=2 lines=0$/m)
    assert.match(out, /^ {2}killer phantom:2$/m)
    assert.match(out, /^IdkBotV2 2026-10-17 deaths=2 lines=2\n {2}killer fell:2\n.*\n.*\n {2}kitless=0\/0 near_spawn=1\/2 loop=1\/2$/m)
    // perDay over the calendar span 10-17..10-19 (the empty 10-18 counts).
    assert.match(out, /^summary IdkBot days=3 deaths=4 perDay=1\.3 /m)
    assert.match(out, /^summary swarm days=1 deaths=2 perDay=2\.0 topKillers=phantom:2 /m)
    assert.ok(!/next:|left/.test(out), out)
  })
})
