'use strict'

// Doors (idkcraft-6xno): never break them, open them on the path, close behind.
// Fake-world harness: real Movements over a scripted blockAt, wired exactly
// like production (ticker.setMovements), plus the door reflex against mock
// bots and a fake-player room escape end to end.

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { Vec3 } = require('vec3')
const mcData = require('minecraft-data')('1.21.4')
const Block = require('prismarine-block')(mcData)
const { Movements, goals } = require('mineflayer-pathfinder')
const AStar = require('mineflayer-pathfinder/lib/astar')
const Move = require('mineflayer-pathfinder/lib/move')
const { createTicker } = require('../src/index')
const doors = require('../src/doors')
const { doorOpen, doorLaneDX, DOOR_LANE_DX } = require('../src/behaviours/util')

const stateCache = new Map()
function stateIdFor(name, match) {
  const key = `${name}:${JSON.stringify(match)}`
  if (!stateCache.has(key)) {
    const e = mcData.blocksByName[name]
    let found = -1
    for (let s = e.minStateId; s <= e.maxStateId; s++) {
      const p = Block.fromStateId(s, 0).getProperties()
      if (Object.entries(match).every(([k, v]) => p[k] === v)) { found = s; break }
    }
    if (found < 0) throw new Error(`no state ${key}`)
    stateCache.set(key, found)
  }
  return stateCache.get(key)
}

// Sealed room: 3x3 interior (x/z -1..1), feet y=64, floor y=63, bedrock
// below (no tunneling under), perimeter walls 2 high (y 64..65) with a door
// at (0, *,-2). The ONLY way out is the door: walls/floor-base unbreakable,
// 2-high unjumpable, no scaffold aboard. Variant 'dirt' swaps the walls to
// diggable dirt (the dig-around control for iron).
function roomCells({ door = 'oak_door', facing = 'north', open = false, walls = 'bedrock' } = {}) {
  const cells = new Map() // "x,y,z" -> { name } | { state }
  const ring = (x, z) => Math.abs(x) === 2 || Math.abs(z) === 2
  const inRoom = (x, z) => x >= -2 && x <= 2 && z >= -8 && z <= 2
  for (let x = -2; x <= 2; x++) {
    for (let z = -8; z <= 2; z++) {
      for (let y = 60; y <= 62; y++) cells.set(`${x},${y},${z}`, { name: 'bedrock' })
      cells.set(`${x},63,${z}`, { name: (inRoom(x, z) && ring(x, z) && z >= -2) ? 'bedrock' : 'stone' })
      for (let y = 64; y <= 65; y++) {
        if (z >= -2 && ring(x, z)) {
          if (x === 0 && z === -2 && door) {
            cells.set(`${x},${y},${z}`, {
              state: stateIdFor(door, { facing, half: y === 64 ? 'lower' : 'upper', open }),
            })
          } else {
            cells.set(`${x},${y},${z}`, { name: walls })
          }
        }
      }
    }
  }
  return cells
}

function blockAtFor(cells) {
  return (p) => {
    const x = Math.floor(p.x)
    const y = Math.floor(p.y)
    const z = Math.floor(p.z)
    const c = cells.get(`${x},${y},${z}`)
    const b = c && c.state !== undefined
      ? Block.fromStateId(c.state, 0)
      : Block.fromStateId(mcData.blocksByName[(c && c.name) || 'air'].minStateId, 0)
    b.position = new Vec3(x, y, z)
    return b
  }
}

function worldBot(cells) {
  const blockAt = blockAtFor(cells)
  return {
    registry: mcData,
    game: { minY: -64 },
    entity: { effects: [] },
    pathfinder: { bestHarvestTool: () => null, setMovements() {}, setGoal() {}, stop() {}, isMoving: () => false },
    setControlState() {},
    clearControlStates: () => {},
    blockAt: (p) => blockAt(p),
  }
}

function mockBrain() {
  return { async decide() { return { action: 'follow', sprint: false, source: 'stub' } } }
}

// Production wiring: ticker.setMovements applies the door ban + passages
// plus the neighbour wrappers.
function wiredMovements(cells) {
  const bot = worldBot(cells)
  const ticker = createTicker({ bot, brain: mockBrain(), tickMs: 10, idleTickMs: 10 })
  const movements = new Movements(bot)
  movements.allowSprinting = false
  ticker.setMovements(movements)
  return { bot, movements }
}

function planThrough(movements, from, to) {
  const astar = new AStar(
    new Move(from[0], from[1], from[2], 0, 0),
    movements, new goals.GoalBlock(to[0], to[1], to[2]), 10000, 9000)
  return astar.compute()
}

function pathCells(path) {
  return new Set(path.map((m) => `${m.x},${m.y},${m.z}`))
}

function allBreaks(path) {
  const out = []
  for (const m of path) for (const p of (m.toBreak || [])) out.push(`${p.x},${p.y},${p.z}`)
  return out
}

function capture() {
  const logged = []
  const origLog = console.log
  console.log = (m) => { logged.push(String(m)) }
  return { logged, release() { console.log = origLog } }
}

describe('doors: never break (idkcraft-6xno)', () => {
  it('setMovements bans every door, trapdoor and fence gate id', () => {
    const { movements } = wiredMovements(roomCells())
    const banned = movements.blocksCantBreak
    assert.ok(banned instanceof Set)
    for (const n of ['oak_door', 'iron_door', 'copper_door', 'spruce_door',
      'oak_trapdoor', 'iron_trapdoor', 'copper_trapdoor',
      'oak_fence_gate', 'spruce_fence_gate']) {
      assert.ok(banned.has(mcData.blocksByName[n].id), `${n} breakable`)
    }
    // …but not the planks (8si: walls stay diggable).
    assert.ok(!banned.has(mcData.blocksByName.oak_planks.id), 'planks banned')
  })

  it('hand doors join openable, iron does not, canOpenDoors stays false', () => {
    const { movements } = wiredMovements(roomCells())
    assert.ok(movements.openable.has(mcData.blocksByName.oak_door.id), 'oak_door not openable')
    assert.ok(movements.openable.has(mcData.blocksByName.copper_door.id), 'copper_door not openable')
    assert.ok(!movements.openable.has(mcData.blocksByName.iron_door.id), 'iron_door openable')
    assert.equal(movements.canOpenDoors, false, 'canOpenDoors flipped on')
  })

  it('installs once and tolerates movement-like mocks', () => {
    const { movements } = wiredMovements(roomCells())
    const before = movements.getNeighbors
    doors.addDoorPassages(movements)
    assert.equal(movements.getNeighbors, before, 'double wrap')
    assert.doesNotThrow(() => doors.addDoorPassages({ allowSprinting: false }))
    assert.doesNotThrow(() => doors.addDoorPassages(null))
    assert.doesNotThrow(() => doors.banDoorBreaks({}))
    assert.doesNotThrow(() => doors.banDoorBreaks(null))
  })
})

describe('doors: A* through a closed oak door (idkcraft-6xno)', () => {
  it('plans success through the door cell with no dig anywhere', () => {
    const { movements } = wiredMovements(roomCells())
    const r = planThrough(movements, [0, 64, 0], [0, 64, -4])
    assert.equal(r.status, 'success', 'sealed room exits only via the door')
    const cells = pathCells(r.path)
    assert.ok(cells.has('0,64,-2'), `path avoids the door: ${[...cells].join(' ')}`)
    assert.deepEqual(allBreaks(r.path), [], 'path digs')
  })

  it('an open door rides the same edge', () => {
    const { movements } = wiredMovements(roomCells({ open: true }))
    const r = planThrough(movements, [0, 64, 0], [0, 64, -4])
    assert.equal(r.status, 'success')
    assert.ok(pathCells(r.path).has('0,64,-2'), 'path avoids the open door')
    assert.deepEqual(allBreaks(r.path), [], 'path digs')
  })

  it('east/west doors cross along x', () => {
    const { movements } = wiredMovements(roomCells({ facing: 'east' }))
    // Facing east: the z-walk through (0,64,-2) is along the wall, refused…
    const r = planThrough(movements, [0, 64, 0], [0, 64, -4])
    assert.notEqual(r.status, 'success', 'along-wall crossing planned')
    // …while the x-step into the cell is offered.
    const ns = movements.getNeighbors(new Move(-1, 64, -2, 0, 0))
    assert.ok(ns.some((m) => m.x === 0 && m.y === 64 && m.z === -2), 'no across-plane x edge')
  })

  it('no diagonal lands in a door cell', () => {
    const { movements } = wiredMovements(roomCells())
    for (const [sx, sz] of [[-1, -1], [1, -1], [-1, -3], [1, -3]]) {
      const ns = movements.getNeighbors(new Move(sx, 64, sz, 0, 0))
      assert.ok(!ns.some((m) => m.x === 0 && m.y === 64 && m.z === -2),
        `diagonal ${sx},64,${sz} -> 0,64,-2 offered`)
    }
  })

  it('no door position ever lands in toBreak', () => {
    const { movements } = wiredMovements(roomCells())
    for (let x = -2; x <= 2; x++) {
      for (let z = -4; z <= 1; z++) {
        for (const m of movements.getNeighbors(new Move(x, 64, z, 0, 0))) {
          for (const p of (m.toBreak || [])) {
            assert.ok(!(p.x === 0 && p.z === -2 && (p.y === 64 || p.y === 65)),
              `door in toBreak at ${p.x},${p.y},${p.z}`)
          }
        }
      }
    }
  })
})

describe('doors: iron is impassable and unbreakable (idkcraft-6xno)', () => {
  it('a sealed iron-door room has no path', () => {
    const { movements } = wiredMovements(roomCells({ door: 'iron_door' }))
    const r = planThrough(movements, [0, 64, 0], [0, 64, -4])
    assert.equal(r.status, 'noPath', `planned ${r.status} through iron`)
  })

  it('a diggable room routes around the iron door, never through it', () => {
    const { movements } = wiredMovements(roomCells({ door: 'iron_door', walls: 'dirt' }))
    const r = planThrough(movements, [0, 64, 0], [0, 64, -4])
    assert.equal(r.status, 'success')
    const cells = pathCells(r.path)
    assert.ok(!cells.has('0,64,-2'), 'path crosses the iron door')
    for (const b of allBreaks(r.path)) {
      assert.ok(b !== '0,64,-2' && b !== '0,65,-2', `iron door in toBreak: ${b}`)
    }
  })
})

describe('doors: shared open/lane (idkcraft-6xno)', () => {
  const mockDoor = (props) => ({ name: 'oak_door', getProperties: () => ({ ...props }) })

  it('doorOpen reads the open flag, fail-closed', () => {
    assert.equal(doorOpen(mockDoor({ open: true })), true)
    assert.equal(doorOpen(mockDoor({ open: false })), false)
    assert.equal(doorOpen(mockDoor({})), false)
    assert.equal(doorOpen(null), false)
    assert.equal(doorOpen({}), false)
  })

  it('doorLaneDX keeps the bv6 table (moved, not changed)', () => {
    assert.equal(DOOR_LANE_DX, 0.09375)
    assert.equal(doorLaneDX(mockDoor({ open: true, facing: 'north', hinge: 'left' })), DOOR_LANE_DX)
    assert.equal(doorLaneDX(mockDoor({ open: true, facing: 'north', hinge: 'right' })), -DOOR_LANE_DX)
    assert.equal(doorLaneDX(mockDoor({ open: true, facing: 'south', hinge: 'left' })), -DOOR_LANE_DX)
    assert.equal(doorLaneDX(mockDoor({ open: true, facing: 'south', hinge: 'right' })), DOOR_LANE_DX)
    assert.equal(doorLaneDX(mockDoor({ open: true, facing: 'east', hinge: 'left' })), 0)
    assert.equal(doorLaneDX(mockDoor({ open: true, facing: 'west', hinge: 'right' })), 0)
    assert.equal(doorLaneDX(mockDoor({ open: false, facing: 'north', hinge: 'left' })), 0)
    assert.equal(doorLaneDX(mockDoor({ open: true })), 0)
    assert.equal(doorLaneDX(null), 0)
  })
})

describe('doors: opener reflex (idkcraft-6xno)', () => {
  // Mock bot over a live door cell: blockAt reads the mutable state,
  // activateBlock flips it.
  function mockBot({ door = { open: false, name: 'oak_door', facing: 'north' }, at = { x: 0.5, y: 64, z: -0.5 }, moving = true } = {}) {
    const st = { ...door }
    const bot = {
      entity: { position: { ...at } },
      toggles: 0,
      state: st,
      pathfinder: { isMoving: () => moving },
      blockAt: (p) => {
        const x = Math.floor(p.x)
        const y = Math.floor(p.y)
        const z = Math.floor(p.z)
        if (x === 0 && (y === 64 || y === 65) && z === -2) {
          return {
            name: st.name,
            position: new Vec3(x, y, z),
            getProperties: () => ({ open: st.open, facing: st.facing, hinge: 'left', half: y === 64 ? 'lower' : 'upper' }),
          }
        }
        return { name: 'air', position: new Vec3(x, y, z), getProperties: () => ({}) }
      },
      activateBlock: async () => { bot.toggles++; st.open = !st.open },
    }
    return bot
  }

  const planViaDoor = [
    { x: 0.5, y: 64, z: -0.5 },
    { x: 0.5, y: 64, z: -1.5 },
    { x: 0.5, y: 64, z: -2.5 }, // feet cell 0,64,-2: the door
    { x: 0.5, y: 64, z: -3.5 },
  ]

  it('opens a closed plan door within reach and tracks it', () => {
    const bot = mockBot()
    const ctx = { lastPathNodes: planViaDoor }
    const cap = capture()
    try {
      doors.doorReflex(bot, ctx)
    } finally {
      cap.release()
    }
    assert.equal(bot.toggles, 1, 'no toggle')
    assert.equal(bot.state.open, true, 'door still shut')
    assert.ok(ctx.doorOpened instanceof Map && ctx.doorOpened.has('0,64,-2'), 'untracked')
    assert.ok(cap.logged.some((l) => l === 'door open at 0 64 -2'), cap.logged.join('\n'))
  })

  it('never touches open, iron, off-plan or idle doors', () => {
    const cap = capture()
    try {
      // Open on the plan: the player's, or already handled — no click.
      const open = mockBot({ door: { open: true, name: 'oak_door', facing: 'north' } })
      doors.doorReflex(open, { lastPathNodes: planViaDoor })
      assert.equal(open.toggles, 0, 'clicked an open door')
      // Iron on the plan: unclickable, never tracked.
      const iron = mockBot({ door: { open: false, name: 'iron_door', facing: 'north' } })
      const ironCtx = { lastPathNodes: planViaDoor }
      doors.doorReflex(iron, ironCtx)
      assert.equal(iron.toggles, 0, 'clicked iron')
      assert.ok(!ironCtx.doorOpened || ironCtx.doorOpened.size === 0, 'iron tracked')
      // Closed but off the plan: none of the executor's business.
      const off = mockBot()
      doors.doorReflex(off, { lastPathNodes: [{ x: 5.5, y: 64, z: 5.5 }] })
      assert.equal(off.toggles, 0, 'clicked off-plan')
      // Idle executor (home legs, parked stop): no plan is being walked.
      const idle = mockBot({ moving: false })
      doors.doorReflex(idle, { lastPathNodes: planViaDoor })
      assert.equal(idle.toggles, 0, 'clicked while idle')
    } finally {
      cap.release()
    }
  })

  it('one toggle per window: a lagged update never flips the door back', () => {
    const bot = mockBot()
    const ctx = { lastPathNodes: planViaDoor }
    const cap = capture()
    try {
      doors.doorReflex(bot, ctx)
      bot.state.open = false // the server echo hasn't landed yet
      doors.doorReflex(bot, ctx)
      doors.doorReflex(bot, ctx)
    } finally {
      cap.release()
    }
    assert.equal(bot.toggles, 1, `toggled ${bot.toggles}x in one window`)
  })

  it('in-doorway: a shut door under the feet opens past the window head (6x7.13)', () => {
    // Trap geometry (rig DOOR-ROOM): the body entered before the first click
    // and the lib trimmed the reached door node, so the window starts past
    // the door — the scan sees nothing and the bot pushes into its own shut
    // panel forever. Feet cell 0,64,-2 is the door here.
    const bot = mockBot({ at: { x: 0.5, y: 64, z: -1.6 } })
    const ctx = { lastPathNodes: [{ x: 0.5, y: 64, z: -2.5 }, { x: 0.5, y: 64, z: -3.5 }] }
    const cap = capture()
    try {
      doors.doorReflex(bot, ctx)
    } finally {
      cap.release()
    }
    assert.equal(bot.toggles, 1, 'shut door under the feet never opened')
    assert.equal(bot.state.open, true, 'door still shut')
  })

  it('in-doorway: an open door under the feet shadows no door ahead (6x7.13)', () => {
    // The feet seed only fires on shut: walking out through an open doorway
    // must not eat the click for the next shut door on the plan.
    const bot = mockBot({ door: { open: true, name: 'oak_door', facing: 'north' }, at: { x: 0.5, y: 64, z: -1.6 } })
    const rawBlockAt = bot.blockAt
    bot.blockAt = (p) => {
      if (Math.floor(p.x) === 0 && Math.floor(p.y) === 64 && Math.floor(p.z) === -4) {
        return { name: 'oak_door', position: new Vec3(0, 64, -4), getProperties: () => ({ open: false, facing: 'north', hinge: 'left', half: 'lower' }) }
      }
      return rawBlockAt(p)
    }
    let aheadToggles = 0
    const rawToggle = bot.activateBlock
    bot.activateBlock = async (b) => {
      if (b && b.position && b.position.z === -4) aheadToggles++
      return rawToggle(b)
    }
    const ctx = { lastPathNodes: [{ x: 0.5, y: 64, z: -2.5 }, { x: 0.5, y: 64, z: -3.5 }] }
    const cap = capture()
    try {
      doors.doorReflex(bot, ctx)
    } finally {
      cap.release()
    }
    assert.equal(aheadToggles, 1, 'shut door ahead starved by the open one underfoot')
  })
})

describe('doors: closer reflex (idkcraft-6xno)', () => {
  function mockBot({ open = true, at = { x: 0.5, y: 64, z: -5.5 }, moving = true } = {}) {
    const st = { open }
    const bot = {
      entity: { position: { ...at } },
      toggles: 0,
      state: st,
      pathfinder: { isMoving: () => moving },
      blockAt: (p) => {
        const x = Math.floor(p.x)
        const y = Math.floor(p.y)
        const z = Math.floor(p.z)
        if (x === 0 && y === 64 && z === -2) {
          return {
            name: 'oak_door',
            position: new Vec3(x, y, z),
            getProperties: () => ({ open: st.open, facing: 'north', hinge: 'left', half: 'lower' }),
          }
        }
        return { name: 'air', position: new Vec3(x, y, z), getProperties: () => ({}) }
      },
      activateBlock: async () => { bot.toggles++; st.open = !st.open },
    }
    return bot
  }

  const trackedCtx = (nodes) => ({
    lastPathNodes: nodes,
    doorOpened: new Map([['0,64,-2', { x: 0, y: 64, z: -2 }]]),
  })

  it('shuts its own opening once out of the doorway', () => {
    const bot = mockBot({ at: { x: 0.5, y: 64, z: -4.5 } }) // past the door, in reach
    const ctx = trackedCtx([{ x: 0.5, y: 64, z: -4.5 }, { x: 0.5, y: 64, z: -5.5 }])
    const cap = capture()
    try {
      doors.doorReflex(bot, ctx)
    } finally {
      cap.release()
    }
    assert.equal(bot.toggles, 1, 'never shut')
    assert.equal(bot.state.open, false, 'still open')
    assert.ok(cap.logged.some((l) => l === 'door shut at 0 64 -2'), cap.logged.join('\n'))
    // Observed shut next tick: untracked, no second click.
    doors.doorReflex(bot, ctx)
    assert.equal(bot.toggles, 1, 'clicked a shut door')
    assert.equal(ctx.doorOpened.size, 0, 'still tracked')
  })

  it('never shuts into the bot, ahead on the plan, or a player door', () => {
    const cap = capture()
    try {
      // Adjacent, mid-crossing: the body is still in the doorway span.
      const near = mockBot({ at: { x: 0.5, y: 64, z: -2.5 } })
      doors.doorReflex(near, trackedCtx([{ x: 0.5, y: 64, z: -3.5 }]))
      assert.equal(near.toggles, 0, 'shut into the crossing body')
      // Far but the door is still ahead on the plan: walking toward it.
      const ahead = mockBot({ at: { x: 0.5, y: 64, z: 1.5 } })
      doors.doorReflex(ahead, trackedCtx([
        { x: 0.5, y: 64, z: 0.5 },
        { x: 0.5, y: 64, z: -1.5 }, // floors to the door cell 0,64,-2
        { x: 0.5, y: 64, z: -3.5 },
      ]))
      assert.equal(ahead.toggles, 0, 'shut a door still ahead')
      // Untracked open door (the player opened it): never touched.
      const player = mockBot({ at: { x: 0.5, y: 64, z: -5.5 } })
      doors.doorReflex(player, { lastPathNodes: [{ x: 0.5, y: 64, z: -5.5 }] })
      assert.equal(player.toggles, 0, 'shut the player door')
    } finally {
      cap.release()
    }
  })

  it('a gone door untracks silently', () => {
    const bot = mockBot()
    bot.blockAt = () => null
    const ctx = trackedCtx([{ x: 0.5, y: 64, z: -5.5 }])
    const cap = capture()
    try {
      doors.doorReflex(bot, ctx)
    } finally {
      cap.release()
    }
    assert.equal(bot.toggles, 0)
    assert.equal(ctx.doorOpened.size, 0)
  })
})

describe('doors: revmux 01 fixes (idkcraft-6xno)', () => {
  function mockBot({ open = false, at = { x: 0.5, y: 64, z: -0.5 } } = {}) {
    const st = { open }
    const bot = {
      entity: { position: { ...at } },
      toggles: 0,
      state: st,
      pathfinder: { isMoving: () => true },
      blockAt: (p) => {
        const x = Math.floor(p.x)
        const y = Math.floor(p.y)
        const z = Math.floor(p.z)
        if (x === 0 && y === 64 && z === -2) {
          return {
            name: 'oak_door',
            position: new Vec3(x, y, z),
            getProperties: () => ({ open: st.open, facing: 'north', hinge: 'left', half: 'lower' }),
          }
        }
        return { name: 'air', position: new Vec3(x, y, z), getProperties: () => ({}) }
      },
      activateBlock: async () => { bot.toggles++; st.open = !st.open },
    }
    return bot
  }

  it('major-1: the open click never holds the shut (separate stamps)', () => {
    // Open at T, walk past at speed, shut at T+500: one shared stamp would
    // hold the shut until the bot is out of reach (the walk-past miss).
    const realNow = Date.now
    let now = 2000000
    Date.now = () => now
    const cap = capture()
    try {
      const bot = mockBot()
      const ctx = { lastPathNodes: [{ x: 0.5, y: 64, z: -1.5 }] }
      doors.doorReflex(bot, ctx) // opens (T)
      assert.equal(bot.toggles, 1)
      assert.equal(bot.state.open, true)
      now += 500
      bot.entity.position = { x: 0.5, y: 64, z: -4.0 } // past, in reach
      ctx.lastPathNodes = [{ x: 0.5, y: 64, z: -4.0 }, { x: 0.5, y: 64, z: -5.0 }]
      doors.doorReflex(bot, ctx) // shuts (T+500, inside the open window)
      assert.equal(bot.toggles, 2, 'shut held by the open click')
      assert.equal(bot.state.open, false)
    } finally {
      Date.now = realNow
      cap.release()
    }
  })

  it('major-1: the fast shut runs at most every 250 ms', () => {
    const realNow = Date.now
    let now = 3000000
    Date.now = () => now
    const cap = capture()
    try {
      // A door that never reports shut (lost echo): attempts stay throttled.
      const bot = mockBot({ open: true, at: { x: 0.5, y: 64, z: -4.0 } })
      bot.activateBlock = async () => { bot.toggles++ } // no state change
      const ctx = {
        lastPathNodes: [{ x: 0.5, y: 64, z: -4.0 }],
        doorOpened: new Map([['0,64,-2', { x: 0, y: 64, z: -2 }]]),
      }
      doors.doorShutFast(bot, ctx)
      doors.doorShutFast(bot, ctx)
      assert.equal(bot.toggles, 1, 'unthrottled second attempt')
      delete ctx.doorShutAt // isolate the throttle from the shut stamp
      doors.doorShutFast(bot, ctx)
      assert.equal(bot.toggles, 1, 'throttle ignored')
      now += 300
      doors.doorShutFast(bot, ctx)
      assert.equal(bot.toggles, 2, 'throttled past the window')
    } finally {
      Date.now = realNow
      cap.release()
    }
  })

  it('major-1: the ticker exposes the fast shut (physicsTick tap target)', () => {
    const bot = mockBot({ open: true, at: { x: 0.5, y: 64, z: -4.0 } })
    bot.registry = mcData
    bot.players = {}
    const ticker = createTicker({ bot, brain: mockBrain(), tickMs: 10, idleTickMs: 10 })
    assert.equal(typeof ticker.doorShutFast, 'function', 'no ticker.doorShutFast')
    const ctx = bot._tickerCtx
    ctx.lastPathNodes = [{ x: 0.5, y: 64, z: -4.0 }]
    ctx.doorOpened = new Map([['0,64,-2', { x: 0, y: 64, z: -2 }]])
    const cap = capture()
    try {
      ticker.doorShutFast()
    } finally {
      cap.release()
    }
    assert.equal(bot.toggles, 1, 'ticker fast shut did not fire')
    assert.equal(bot.state.open, false)
  })

  it('minor: only the fast shut catches a between-ticks walk-past', () => {
    // Sprint walk-past: the body is inside the (1.2, 3.5] shut window from
    // T+100 to T+600 only — both adjacent 1 s ticks find it gone. Fails if
    // doorShutFast is removed (the round-2 gap: the e2e below pins the
    // stamps + the integrated shut, not the fast path itself).
    const realNow = Date.now
    let now = 4000000
    Date.now = () => now
    const cap = capture()
    try {
      const bot = mockBot({ open: true, at: { x: 0.5, y: 64, z: -4.0 } })
      const ctx = {
        lastPathNodes: [{ x: 0.5, y: 64, z: -4.0 }, { x: 0.5, y: 64, z: -5.0 }],
        doorOpened: new Map([['0,64,-2', { x: 0, y: 64, z: -2 }]]),
      }
      now += 100 // T+100: 2.5 past the door, mid-window
      doors.doorShutFast(bot, ctx)
      assert.equal(bot.toggles, 1, 'fast shut missed the walk-past')
      assert.equal(bot.state.open, false)
      // Contrast: the 1 s tick closer at T+1000 sees an empty window.
      bot.state.open = true
      bot.toggles = 0
      ctx.doorOpened.set('0,64,-2', { x: 0, y: 64, z: -2 })
      delete ctx.doorShutAt
      bot.entity.position = { x: 0.5, y: 64, z: -7.5 } // 6 past, gone
      ctx.lastPathNodes = [{ x: 0.5, y: 64, z: -7.5 }]
      now += 900
      doors.doorReflex(bot, ctx)
      assert.equal(bot.toggles, 0, 'tick closer caught a gone bot')
      assert.equal(bot.state.open, true)
    } finally {
      Date.now = realNow
      cap.release()
    }
  })

  it('sendback (a): a closed read before the open lands never untracks', () => {
    // Real ping: the opener tracks at click time, the server update lands
    // later. A fast-shut pass in between must not untrack (old code did —
    // then the open door was nobody's and stayed open).
    const realNow = Date.now
    let now = 5000000
    Date.now = () => now
    const cap = capture()
    try {
      const st = { open: false }
      const bot = mockBot({ open: false, at: { x: 0.5, y: 64, z: -0.5 } })
      bot.activateBlock = async () => { bot.toggles++ } // echo withheld
      const liveState = (v) => { st.open = v }
      bot.blockAt = (p) => {
        const x = Math.floor(p.x)
        const y = Math.floor(p.y)
        const z = Math.floor(p.z)
        if (x === 0 && y === 64 && z === -2) {
          return {
            name: 'oak_door',
            position: new Vec3(x, y, z),
            getProperties: () => ({ open: st.open, facing: 'north', hinge: 'left', half: 'lower' }),
          }
        }
        return { name: 'air', position: new Vec3(x, y, z), getProperties: () => ({}) }
      }
      const ctx = { lastPathNodes: [{ x: 0.5, y: 64, z: -1.5 }] }
      doors.doorReflex(bot, ctx) // click (T), echo still in flight
      assert.equal(bot.toggles, 1)
      assert.equal(ctx.doorOpened.size, 1)
      now += 250 // fast-shut pass sees the pre-update closed read
      doors.doorShutFast(bot, ctx)
      assert.equal(bot.toggles, 1, 'shut fired on the unlanded open')
      assert.equal(ctx.doorOpened.size, 1, 'pending open untracked')
      liveState(true) // the update lands
      bot.entity.position = { x: 0.5, y: 64, z: -4.0 }
      ctx.lastPathNodes = [{ x: 0.5, y: 64, z: -4.0 }, { x: 0.5, y: 64, z: -5.0 }]
      now += 250
      doors.doorReflex(bot, ctx)
      assert.equal(bot.toggles, 2, 'never shut after the echo landed')
    } finally {
      Date.now = realNow
      cap.release()
    }
  })

  it('sendback (b): a door consumed at the window tail counts as passed', () => {
    // Door at the last window index, body just past it along the leg: old
    // code skips (at >= ahead is always true at the tail) until a replan.
    const bot = mockBot({ open: true, at: { x: 0.5, y: 64, z: -3.0 } })
    const ctx = {
      lastPathNodes: [{ x: 0.5, y: 64, z: 0.5 }, { x: 0.5, y: 64, z: -0.5 }, { x: 0.5, y: 64, z: -1.5 }],
      doorOpened: new Map([['0,64,-2', { x: 0, y: 64, z: -2, seen: true }]]),
    }
    const cap = capture()
    try {
      doors.doorReflex(bot, ctx)
    } finally {
      cap.release()
    }
    assert.equal(bot.toggles, 1, 'tail-consumed door never shut')
    assert.equal(bot.state.open, false)
  })

  it('sendback (b): approaching a tail door still holds the shut', () => {
    // Same tail geometry, body still short of the door: no shut (guards
    // the projection fix against flipping the approach case).
    const bot = mockBot({ open: true, at: { x: 0.5, y: 64, z: 1.5 } })
    const ctx = {
      lastPathNodes: [{ x: 0.5, y: 64, z: 0.5 }, { x: 0.5, y: 64, z: -0.5 }, { x: 0.5, y: 64, z: -1.5 }],
      doorOpened: new Map([['0,64,-2', { x: 0, y: 64, z: -2, seen: true }]]),
    }
    const cap = capture()
    try {
      doors.doorReflex(bot, ctx)
    } finally {
      cap.release()
    }
    assert.equal(bot.toggles, 0, 'shut a door still being approached')
  })

  it('sendback (b): the opener never reopens a door behind the body', () => {
    // Tracked door shut (by a player) while the body stands past it at the
    // window tail: reopening would flap against the closer every window.
    const bot = mockBot({ open: false, at: { x: 0.5, y: 64, z: -3.0 } })
    const ctx = {
      lastPathNodes: [{ x: 0.5, y: 64, z: 0.5 }, { x: 0.5, y: 64, z: -0.5 }, { x: 0.5, y: 64, z: -1.5 }],
      doorOpened: new Map([['0,64,-2', { x: 0, y: 64, z: -2, seen: true }]]),
    }
    const cap = capture()
    try {
      doors.doorReflex(bot, ctx)
    } finally {
      cap.release()
    }
    assert.equal(bot.toggles, 0, 'reopened a door behind the body')
  })

  it('sendback (c): no sideways exit out of a doorway', () => {
    // Standing IN a north-door cell, the lib offers 90° turns out that the
    // panel/frame cannot execute. Only facing-axis exits stay; iron keeps
    // every exit (the escape hatch: you can only stand in one by
    // spawn/teleport and must be able to leave).
    const doorwayCells = (door) => {
      const cells = new Map()
      for (let x = -2; x <= 2; x++) {
        for (let z = -2; z <= 2; z++) {
          cells.set(`${x},63,${z}`, { name: 'stone' })
        }
      }
      for (const y of [64, 65]) {
        cells.set(`0,${y},0`, { state: stateIdFor(door, { facing: 'north', half: y === 64 ? 'lower' : 'upper', open: true }) })
      }
      return cells
    }
    const { movements } = wiredMovements(doorwayCells('oak_door'))
    const ns = movements.getNeighbors(new Move(0, 64, 0, 0, 0))
    assert.ok(!ns.some((m) => m.x !== 0),
      `sideways exit offered: ${ns.filter((m) => m.x !== 0).map((m) => `${m.x},${m.y},${m.z}`).join(' ')}`)
    assert.ok(ns.some((m) => m.x === 0 && m.y === 64 && m.z === 1), 'straight exit north dropped')
    assert.ok(ns.some((m) => m.x === 0 && m.y === 64 && m.z === -1), 'straight exit south dropped')
    const iron = wiredMovements(doorwayCells('iron_door')).movements
    const ins = iron.getNeighbors(new Move(0, 64, 0, 0, 0))
    assert.ok(ins.some((m) => m.x === 1 && m.y === 64 && m.z === 0), 'iron doorway escape hatch shut')
  })

  it('minor: a diagonal grazing a door panel is still dropped', () => {
    // Freestanding oak door at (1,64,0); the (0,64,0)->(1,64,1) diagonal
    // brushes it as a side cell. The lib offers it (free far side); the
    // 4ac guard must drop it like any solid corner.
    const cells = new Map()
    for (let x = -2; x <= 2; x++) {
      for (let z = -2; z <= 2; z++) {
        cells.set(`${x},63,${z}`, { name: 'stone' })
      }
    }
    for (const y of [64, 65]) {
      cells.set(`1,${y},0`, { state: stateIdFor('oak_door', { facing: 'north', half: y === 64 ? 'lower' : 'upper', open: false }) })
    }
    const { movements } = wiredMovements(cells)
    const ns = movements.getNeighbors(new Move(0, 64, 0, 0, 0))
    assert.ok(!ns.some((m) => m.x === 1 && m.y === 64 && m.z === 1),
      'diagonal 0,64,0 -> 1,64,1 grazes the door side cell 1,64,0')
    // Control: no door, same geometry — the diagonal exists.
    const open = new Map()
    for (let x = -2; x <= 2; x++) {
      for (let z = -2; z <= 2; z++) {
        open.set(`${x},63,${z}`, { name: 'stone' })
      }
    }
    const free = wiredMovements(open).movements
    assert.ok(free.getNeighbors(new Move(0, 64, 0, 0, 0)).some((m) => m.x === 1 && m.y === 64 && m.z === 1),
      'control diagonal missing')
  })
})

describe('doors: room escape (fake-player e2e, idkcraft-6xno)', () => {
  // The bot stands in the sealed 3x3 room, goal 5 blocks past the door. Each
  // 1 s tick replans over the live world (the opener's window) and runs the
  // reflex; between ticks 4 sub-ticks step the body at walk speed (4.4 b/s)
  // and run the fast shut. Pins the integrated prompt shut (round-2 note:
  // the between-ticks walk-past itself is pinned by the unit above). The
  // body never steps THROUGH a shut door (the executor pushes, it doesn't
  // clip).
  const SUBSTEP = 1.1
  async function escape({ withReflex }) {
    const cells = roomCells()
    const doorAt = { x: 0, y: 64, z: -2 }
    const toggledAt = []
    let now = 1000000
    const bot = worldBot(cells)
    Object.assign(bot, {
      toggles: [],
      entity: { position: new Vec3(0.5, 64, 0.5), effects: [] },
      pathfinder: {
        ...bot.pathfinder,
        isMoving: () => true,
        bestHarvestTool: () => null,
      },
      activateBlock: async (b) => {
        const p = b && b.position
        bot.toggles.push(p ? `${p.x},${p.y},${p.z}` : '?')
        toggledAt.push(now)
        // A hand click flips both halves (facing/hinge kept).
        for (const y of [64, 65]) {
          const cur = Block.fromStateId(cells.get(`0,${y},-2`).state, 0).getProperties()
          cells.set(`0,${y},-2`, {
            state: stateIdFor('oak_door', {
              facing: cur.facing, half: y === 64 ? 'lower' : 'upper', open: !cur.open,
            }),
          })
        }
      },
    })
    const ticker = createTicker({ bot, brain: mockBrain(), tickMs: 10, idleTickMs: 10 })
    const movements = new Movements(bot)
    movements.allowSprinting = false
    ticker.setMovements(movements)
    const ctx = { lastPathNodes: null, doorOpened: new Map() }
    const goal = new goals.GoalBlock(0, 64, -7)
    const arrived = () => Math.hypot(bot.entity.position.x - 0.5, bot.entity.position.z + 6.5) < 0.4
    const cap = capture()
    const realNow = Date.now
    Date.now = () => now
    let reached = false
    try {
      for (let t = 0; t < 30 && !reached; t++) {
        const bp = bot.entity.position
        if (arrived()) { reached = true; break }
        const r = new AStar(
          new Move(Math.floor(bp.x), Math.floor(bp.y), Math.floor(bp.z), 0, 0),
          movements, goal, 10000, 9000).compute()
        assert.equal(r.status, 'success', `tick ${t}: plan ${r.status}`)
        if (r.path.length === 0) { reached = true; break }
        ctx.lastPathNodes = r.path.slice(0, 8).map((m) => ({ x: m.x + 0.5, y: m.y, z: m.z + 0.5 }))
        if (withReflex) doors.doorReflex(bot, ctx)
        for (let s = 0; s < 4 && !reached; s++) {
          now += 250
          if (withReflex) doors.doorShutFast(bot, ctx)
          // Nearest-ahead node of the tick's plan, like the executor's next.
          const here = bot.entity.position
          let next = null
          let nextD = Infinity
          for (const m of r.path) {
            const d = Math.hypot(m.x + 0.5 - here.x, m.z + 0.5 - here.z)
            if (d < nextD) { nextD = d; next = m }
          }
          if (nextD < 0.25) {
            const i = r.path.indexOf(next)
            next = r.path[Math.min(i + 1, r.path.length - 1)]
            nextD = Math.hypot(next.x + 0.5 - here.x, next.z + 0.5 - here.z)
          }
          // A shut door holds the body (no clipping through the panel).
          const doorNow = Block.fromStateId(cells.get('0,64,-2').state, 0).getProperties()
          if (next.x === doorAt.x && next.y === doorAt.y && next.z === doorAt.z && !doorNow.open) continue
          const k = Math.min(SUBSTEP, nextD) / (nextD || 1)
          bot.entity.position = new Vec3(
            here.x + (next.x + 0.5 - here.x) * k, 64, here.z + (next.z + 0.5 - here.z) * k)
          if (arrived()) reached = true
        }
      }
    } finally {
      Date.now = realNow
      cap.release()
    }
    const lower = Block.fromStateId(cells.get('0,64,-2').state, 0)
    const upper = Block.fromStateId(cells.get('0,65,-2').state, 0)
    return { reached, lower, upper, toggles: bot.toggles, toggledAt, pos: bot.entity.position, logged: cap.logged }
  }

  it('exits at walk speed; the door stands whole and shut promptly after', async () => {
    const r = await escape({ withReflex: true })
    assert.ok(r.reached, `never left the room (at ${r.pos.x.toFixed(1)},${r.pos.z.toFixed(1)})`)
    assert.equal(r.lower.name, 'oak_door', 'lower half gone')
    assert.equal(r.upper.name, 'oak_door', 'upper half gone')
    assert.equal(r.lower.getProperties().open, false, 'door left open')
    assert.equal(r.upper.getProperties().open, false, 'halves disagree')
    assert.deepEqual(r.toggles, ['0,64,-2', '0,64,-2'], `toggles: ${r.toggles.join(' ')}`)
    // Prompt, not on the return visit: shut within ~1 s of the open click
    // (revmux 01 major-1: the shared-stamp build never shut at all here).
    assert.ok(r.toggledAt[1] - r.toggledAt[0] <= 1500,
      `shut ${r.toggledAt[1] - r.toggledAt[0]} ms after the open`)
  })

  it('control: without the reflex the bot pushes at the shut door forever', async () => {
    const r = await escape({ withReflex: false })
    assert.ok(!r.reached, 'left without opening anything')
    assert.equal(r.lower.name, 'oak_door', 'control dug the door')
  })
})
