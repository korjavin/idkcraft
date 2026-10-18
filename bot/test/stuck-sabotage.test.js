const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { sabotageMenu, loadSpots } = require('../tools/stuck-replay')
const { RECOVER_MENU } = require('../src/behaviours/recover')

// idkcraft-vf8e.1: the per-spot sabotage knob drops one RECOVER_MENU
// primitive for the window and puts it back after.
describe('stuck-replay sabotage knob (idkcraft-vf8e.1)', () => {
  it('removes the named primitive and the undo restores the same object', () => {
    const orig = RECOVER_MENU.water_up
    const undo = sabotageMenu(RECOVER_MENU, 'water_up')
    assert.equal(Object.hasOwn(RECOVER_MENU, 'water_up'), false)
    undo()
    assert.equal(RECOVER_MENU.water_up, orig)
    sabotageMenu(RECOVER_MENU, null)() // no sabotage: a no-op undo
    assert.equal(RECOVER_MENU.water_up, orig)
  })

  it('loadSpots accepts a menu name and rejects anything else', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sabotage-spots-'))
    const saved = process.argv[2]
    const load = (sabotage) => {
      const f = path.join(dir, 's.json')
      fs.writeFileSync(f, JSON.stringify([{ name: 'X', spawn: [0, 64, 0], goal: [1, 64, 0], sabotage }]))
      process.argv[2] = f
      return loadSpots()
    }
    try {
      assert.equal(load('water_up')[0].sabotage, 'water_up')
      assert.equal(load(undefined)[0].sabotage, null)
      for (const bad of ['water-up', 'constructor', 7]) assert.throws(() => load(bad), /bad sabotage/)
    } finally {
      if (saved === undefined) delete process.argv[2]
      else process.argv[2] = saved
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
