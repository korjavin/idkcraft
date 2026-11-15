'use strict'

// Swordless fund (prod 2026-11-15 bot3): a chest visit draws a ready sword,
// else the sword craft's materials; an armed pack draws nothing.

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { swordFund } = require('../src/behaviours/castlefetch')

function botWith(items) { return { inventory: { items: () => items } } }

describe('castlefetch sword fund', () => {
  it('draws a ready sword first', async () => {
    const calls = []
    await swordFund(botWith([]), async (names, n) => { calls.push([names[0], n]); return { got: 1 } }, { stone_sword: 1 })
    assert.deepEqual(calls, [['netherite_sword', 1]])
  })
  it('no sword in the chest: draws cobble, a stick and a table', async () => {
    const calls = []
    await swordFund(botWith([]), async (names, n) => { calls.push([names[0], n]); return { got: 0 } }, { cobblestone: 9, stick: 4, crafting_table: 1 })
    assert.deepEqual(calls.map((c) => c[0]), ['cobblestone', 'stick', 'crafting_table'])
  })
  it('chest holds none of it: no draw (no extra opens)', async () => {
    const calls = []
    await swordFund(botWith([]), async (names) => { calls.push(names) }, { oak_planks: 4 })
    assert.equal(calls.length, 0)
  })
  it('armed: draws nothing', async () => {
    const calls = []
    await swordFund(botWith([{ name: 'stone_sword', count: 1 }]), async (names) => { calls.push(names) }, { stone_sword: 1 })
    assert.equal(calls.length, 0)
  })
})
