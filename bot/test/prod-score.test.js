'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { score } = require('../tools/prod-score')

const L = (t, msg, d = '2026-10-19') => `${d} ${t} ${msg}`
const fixture = [
  L('23:00:00', 'spawned as IdkBot2'),
  L('23:00:01', 'goal step=castle prev=gather source=fsm fsm=castle why=x menu=a facts=day castle=stone-batch'),
  L('23:00:02', 'castle 100/2048'),
  L('23:00:03', 'decision source=fsm action=castle sprint=false dist=none'),
  L('23:00:04', 'decision source=fsm action=gather sprint=false dist=none'),
  L('23:00:05', 'decision source=fsm action=stay sprint=false dist=none'),
  L('23:00:06', 'decision source=fsm action=castlefetch sprint=false dist=none'),
  L('23:00:07', 'castlefetch stone: need 40 more'),
  L('23:00:30', 'goal step=castle prev=castlefetch source=fsm fsm=castle why=x force=castle-word menu=a facts=day castle=stone-batch'),
  L('23:00:31', 'castlefetch stone: need 24 more'),
  L('23:01:31', 'castlefetch stone: leg over (done) ticks dig=30 walk=60 other=1 starts=1 dug=20 blocks=+20 target=24 wall=60s'),
  L('23:02:00', 'castlefetch planks: need 4 more'),
  L('23:02:10', 'castlefetch planks: leg over (failed) ticks dig=0 walk=5 other=0 starts=1 dug=0 blocks=+0 target=4 wall=10s'),
  L('23:02:11', 'goal step=gather prev=castlefetch source=fsm fsm=gather why=step-failed fail=failed:no-planks menu=a facts=day castle=planks-batch'),
  L('23:02:11', 'castlefetch planks: failed:no-planks'),
  L('23:02:11', 'step failed:no-planks'),
  L('23:02:12', 'build-stall castle: 3 cells unplaced e.g. 1,2,3'),
  L('23:02:13', 'castle blocked 1 2 3 stone (x) try 1, retry in 5s'),
  L('23:02:14', 'skill run skill=mine-x kind=a outcome=done ticks=3'),
  L('23:02:14', 'skill mine-x banned fails=3 last=failed'),
  L('23:02:14', 'dig slow stone expect=10 ticks=30 client=1 wall=1 rpc=1'),
  L('23:20:00', 'castle 100/2048'),
  L('23:30:00', 'castle 130/2048'),
  L('00:10:00', 'castle 150/2048', '2026-10-20'),
  L('00:10:01', 'death health=0 hostiles=1 at 1 2 3', '2026-10-20'),
].join('\n')

test('prod-score: whole-file block', () => {
  const out = score(fixture)
  assert.match(out, /placed=100->150 \(\+50\)/)
  assert.match(out, /share=castle:25,castlefetch:25,house:25,idle\+stay:25,other:0/)
  assert.match(out, /fetch: legs=3 finished=1 cut-by=force=castle-word:1 stone=\+20 3\.0 s\/stone/)
  assert.match(out, /walk\/dig=2\.17 dead=1 top-fail=no-planks:2 flat=2 longest=40@/)
  assert.match(out, /build-stall=1 build-miss=1 dig-slow\/h=\S+ skills=1\/1/)
  assert.match(out, /deaths=1/)
})

test('prod-score: a stall running to the window end and across a quiet day counts', () => {
  const log = [
    L('08:00:00', 'castle 1500/2048'),
    L('20:00:00', 'decision source=fsm action=gather sprint=false dist=none'),
    L('01:00:00', 'decision source=fsm action=gather sprint=false dist=none', '2026-10-20'),
  ].join('\n')
  assert.match(score(log), /placed=1500->1500 \(\+0\)[\s\S]*flat=1 longest=1020@gather/)
  assert.match(score(log, { day: true }), /== 2026-10-19[\s\S]*flat=1 longest=720@gather[\s\S]*== 2026-10-20\nplaced=1500->1500/)
})

test('prod-score: parked castle is not an active order', () => {
  const log = [
    L('08:00:00', 'goal step=idle prev=gather source=fsm fsm=idle why=x menu=a facts=day castle=parked'),
    L('08:00:01', 'decision source=fsm action=gather sprint=false dist=none'),
  ].join('\n')
  assert.match(score(log), /share=castle:0,castlefetch:0,house:0,idle\+stay:0,other:0/)
})

test('prod-score: --day splits at UTC midnight', () => {
  const out = score(fixture, { day: true })
  assert.match(out, /== 2026-10-19\nplaced=100->130 \(\+30\)/)
  assert.match(out, /== 2026-10-20\nplaced=130->150 \(\+20\)/)
})
