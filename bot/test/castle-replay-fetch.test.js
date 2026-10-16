'use strict'
// idkcraft-neuc.62: the castlefetch verdict line (fetchLine) and the leg
// events classify() feeds it.
const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { fetchLine, componentLine, classify, seen, resetSeen } = require('../tools/castle-replay')

const fs = (t, stone, step = 'castlefetch') => ({ t, step, stone })

describe('fetch verdict (neuc.62)', () => {
  it('one finished leg, two cut legs (force=kit, watchdog far), one dead window', () => {
    resetSeen()
    const L = (s, at) => classify(s, at * 1000)
    L('castlefetch stone: need 10 more', 0)
    L('castlefetch stone: leg over (done) ticks dig=1 walk=1 other=0 starts=1 dug=1 blocks=+10 target=10 wall=60s', 60)
    L('goal step=castle prev=castlefetch why=ok', 61)
    L('goal step=castlefetch prev=castle why=need', 62)
    L('castlefetch stone: need 10 more', 62)
    L('goal step=gather prev=castlefetch why=force-switch force=kit', 100)
    L('goal step=castlefetch prev=gather why=need', 101)
    L('castlefetch stone: need 10 more', 101)
    L('goal watchdog round=1 choice=castlefetch-far', 400)
    L('goal step=castle prev=castlefetch why=watchdog', 401)
    assert.deepEqual(seen.fetchEv.map((e) => e.ev + (e.by ? `:${e.by}` : '')),
      ['start', 'finish', 'start', 'cut:force=kit', 'start', 'cut:watchdog:castlefetch-far'])
    const series = [fs(0, 0, 'castle'), fs(15, 0), fs(30, 5), fs(45, 10), // +10 banked
      fs(60, 10), fs(75, 10), fs(90, 10), fs(105, 10), fs(120, 10), fs(135, 10), fs(150, 10), fs(165, 10), fs(180, 10), // dead 45..180 = 135 s
      fs(195, 12), fs(210, 'x')]
    const events = seen.fetchEv.map((e) => ({ ...e, t: e.at / 1000 }))
    const l = fetchLine({ series, events, ticks: 99, ratio: 1, mineBase: { rate: 15.8 } })
    assert.equal(l, 'fetch: ticks=99 stone=+12 (16.3 s/stone, component 3.8) legs=3 finished=1 cut=2 cut-by=force=kit:1,watchdog:castlefetch-far:1 far=1 dead=2min (t=1-3)')
  })

  it('no castlefetch samples -> fetch: -', () => {
    assert.equal(fetchLine({ series: [fs(0, 0, 'castle'), fs(15, 0, 'castle')], events: [], ticks: 0, ratio: 1, mineBase: null }), 'fetch: -')
  })

  it('banked is the one loop componentLine reads', () => {
    const series = [fs(0, 0), fs(15, 0), fs(30, 10), fs(45, 4, 'castle'), fs(60, 14), fs(75, 12)]
    const f = fetchLine({ series, events: [], ticks: 1, ratio: 1, mineBase: null })
    const c = componentLine('mine', { laid: 0, gameMin: 1.25, wallMin: 1.25, series, tick: '1', baseline: null })
    const n = /stone=\+(\d+)/.exec(f)[1]
    assert.match(c, new RegExp(`banked=\\+${n} `))
  })
})
