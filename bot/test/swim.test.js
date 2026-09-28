'use strict'

// Swim primitive (idkcraft-be7, corrected by idkcraft-b50): fake-world test.
// A river 6 wide (x=4..9, surface feet y=62) cuts between flat banks flush
// with the surface (feet y=63); the goal stands on the far bank. Needs the
// real registry/block shapes, so this test builds a real Movements over a
// scripted blockAt (deps are pinned).
//
// b50 correction: a +2 exit from water standing on the bottom (head in air)
// is unexecutable — the body jumps ~1.25. dy=2 fires only with liquid above
// the feet (room to surface); dy=1 exits at flush banks carry crossings.

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { Vec3 } = require('vec3')
const mcData = require('minecraft-data')('1.21.4')
const Block = require('prismarine-block')(mcData)
const { Movements, goals } = require('mineflayer-pathfinder')
const AStar = require('mineflayer-pathfinder/lib/astar')
const Move = require('mineflayer-pathfinder/lib/move')
const { createTicker } = require('../src/index')
const { addSwimExits, addSwimPrune } = require('../src/swim')

// nameAt with tunable banks/water; lava pit + dry wall only in the main world.
function makeNameAt({ bankTop = 62, waterLo = 60, waterHi = 62, extras = true }) {
  return function nameAt(x, y, z) {
    if (extras && x === -2 && y >= 60 && y <= 62) return 'lava' // lava pit in the bank
    if (extras && x === -4 && (y === 63 || y === 64)) return 'stone' // 2-high wall on land
    const river = x >= 4 && x <= 9
    if (river) {
      if (y < waterLo) return 'stone'
      if (y <= waterHi) return 'water'
      return 'air'
    }
    if (y < waterLo) return 'stone'
    if (y <= bankTop - 1) return 'dirt'
    if (y === bankTop) return 'grass_block'
    return 'air'
  }
}

const nameAt = makeNameAt({})

function blockAtFor(nameFn) {
  return (p) => {
    const b = Block.fromStateId(mcData.blocksByName[nameFn(p.x, p.y, p.z)].minStateId, 0)
    b.position = new Vec3(p.x, p.y, p.z)
    return b
  }
}

function worldBot(nameFn = nameAt) {
  return {
    registry: mcData,
    game: { minY: -64 },
    entity: { effects: [] },
    pathfinder: { bestHarvestTool: () => null, setMovements() {}, setGoal() {}, stop() {}, isMoving: () => false },
    setControlState() {},
    clearControlStates: () => {},
    blockAt: (p) => blockAtFor(nameFn)(new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z))),
  }
}

function mockBrain() {
  return { async decide() { return { action: 'follow', sprint: false, source: 'stub' } } }
}

// Movements wired exactly like production: ticker.setMovements applies the
// bot settings (no sprint) plus the swim exits.
function wiredMovements(nameFn = nameAt) {
  const bot = worldBot(nameFn)
  const ticker = createTicker({ bot, brain: mockBrain(), tickMs: 10, idleTickMs: 10 })
  const movements = new Movements(bot)
  movements.allowSprinting = false
  ticker.setMovements(movements)
  return movements
}

describe("swim primitive (idkcraft-be7, idkcraft-b50)", () => {
  it('the exit edge exists: water-surface node reaches the flush bank', () => {
    const movements = wiredMovements()
    const ns = movements.getNeighbors(new Move(9, 62, 0, 0, 0))
    assert.ok(ns.some((m) => m.x === 10 && m.y === 63 && m.z === 0), 'swim exit 9,62 -> 10,63')
  })

  it('a goal across 6 water blocks plans success through the water', () => {
    const movements = wiredMovements()
    const astar = new AStar(new Move(0, 63, 0, 0, 0), movements, new goals.GoalBlock(14, 63, 0), 10000, 9000)
    const r = astar.compute()
    assert.equal(r.status, 'success')
    assert.ok(r.path.length > 0)
    const last = r.path[r.path.length - 1]
    assert.deepEqual([last.x, last.y, last.z], [14, 63, 0])
    assert.ok(r.path.some((m) => m.y < 63), 'path crosses at water level, not over the top')
  })

  it('1-deep water with a +2 bank offers no exit (the spawn trap)', () => {
    const shallow = makeNameAt({ bankTop: 63, waterLo: 62, waterHi: 62, extras: false })
    const movements = wiredMovements(shallow)
    const ns = movements.getNeighbors(new Move(9, 62, 0, 0, 0))
    assert.ok(!ns.some((m) => m.x === 10 && m.y === 64 && m.z === 0), 'no unexecutable 9,62 -> 10,64')
  })

  it('a deep surface node with air head and a +2 bank offers no exit (intended)', () => {
    const deep = makeNameAt({ bankTop: 63, waterLo: 60, waterHi: 62, extras: false })
    const movements = wiredMovements(deep)
    const ns = movements.getNeighbors(new Move(9, 62, 0, 0, 0))
    assert.ok(!ns.some((m) => m.x === 10 && m.y === 64 && m.z === 0), 'no unexecutable 9,62 -> 10,64')
  })

  it('h04: no +2 exit from any water node — the mount is unexecutable', () => {
    // Live (idk-eqd, idk-202): Paper 26.1.2 rejects every
    // rise-while-touching-the-wall with a same-pos teleport, 20/s, so a +2
    // mount from water never executes — the edge would only plan a dive to
    // the bottom and pin there (plus reintroduce the b50 spawn trap).
    // Grounded + submerged bottom nodes get no +2 either; floating nodes
    // still rise diagonally toward the surface instead.
    const deep = makeNameAt({ bankTop: 62, waterLo: 61, waterHi: 62, extras: false })
    const movements = wiredMovements(deep)
    const bottom = movements.getNeighbors(new Move(9, 61, 0, 0, 0))
    assert.ok(!bottom.some((m) => m.x === 10 && m.y === 63 && m.z === 0), 'grounded+submerged 9,61 takes no +2')
    const floaty = makeNameAt({ bankTop: 62, waterLo: 60, waterHi: 62, extras: false })
    const movements2 = wiredMovements(floaty)
    const mid = movements2.getNeighbors(new Move(5, 61, 0, 0, 0))
    assert.ok(!mid.some((m) => m.y === 63), 'floating 5,61 takes no +2')
    assert.ok(mid.some((m) => m.y === 62 && Math.abs(m.x - 5) + Math.abs(m.z) === 1), 'floating 5,61 rises diagonally')
  })

  it('h04: no rise from the surface or under a ceiling', () => {
    // Rise edges are lateral (x±1/z±1, y+1): from a surface node every
    // climb must land on the bank, never on open water.
    const movements = wiredMovements()
    const surface = movements.getNeighbors(new Move(9, 62, 0, 0, 0))
    const climbs = surface.filter((m) => m.y === 63 && (Math.abs(m.x - 9) + Math.abs(m.z) === 1))
    assert.ok(climbs.length > 0 && climbs.every((m) => m.x === 10), 'surface climbs only onto the bank, never a water rise')
    // Head-liquid gate: a surface node (head in air) beside a taller
    // water column offers no rise — without the gate the wet neighbour
    // would read as a launchpad.
    const base = makeNameAt({ bankTop: 62, waterLo: 60, waterHi: 62, extras: false })
    const withColumn = (x, y, z) => (x === 6 && y === 63 && z === 0) ? 'water' : base(x, y, z)
    const movementsG = wiredMovements(withColumn)
    const surfG = movementsG.getNeighbors(new Move(5, 62, 0, 0, 0))
    assert.ok(!surfG.some((m) => m.x === 6 && m.y === 63 && m.z === 0), 'air head blocks the rise into a wet neighbour')
    // Ceiling over the start column kills every rise (the room guard).
    const withLid = (x, y, z) => (x === 5 && y === 63 && z === 0) ? 'stone' : base(x, y, z)
    const movements2 = wiredMovements(withLid)
    const mid = movements2.getNeighbors(new Move(5, 61, 0, 0, 0))
    assert.ok(!mid.some((m) => m.y === 62 && (Math.abs(m.x - 5) + Math.abs(m.z) === 1)), 'no rise under a ceiling')
    // Ceiling over one target head blocks only that rise (the rh guard).
    const withTargetLid = (x, y, z) => (x === 6 && y === 63 && z === 0) ? 'stone' : base(x, y, z)
    const movements3 = wiredMovements(withTargetLid)
    const mid3 = movements3.getNeighbors(new Move(5, 61, 0, 0, 0))
    assert.ok(!mid3.some((m) => m.x === 6 && m.y === 62 && m.z === 0), 'no rise into a lidded head cell')
    assert.ok(mid3.some((m) => m.x === 4 && m.y === 62 && m.z === 0), 'open head cells still rise')
  })

  it('wrapping twice adds no duplicate exits; land nodes are untouched', () => {
    const bot = worldBot()
    const plain = new Movements(bot)
    const movements = new Movements(bot)
    addSwimExits(movements)
    addSwimExits(movements)
    const exits = movements.getNeighbors(new Move(9, 62, 0, 0, 0))
      .filter((m) => m.x === 10 && m.y === 63 && m.z === 0)
    assert.equal(exits.length, 1)
    // The water guard: a dry-land node gets exactly the original neighbors.
    const hash = (ns) => ns.map((m) => m.hash).sort().join(' ')
    assert.equal(hash(movements.getNeighbors(new Move(0, 63, 0, 0, 0))), hash(plain.getNeighbors(new Move(0, 63, 0, 0, 0))))
  })

  it('no phantom exits beside a dry-land wall', () => {
    const movements = wiredMovements()
    const ns = movements.getNeighbors(new Move(-3, 63, 0, 0, 0))
    assert.ok(!ns.some((m) => m.y >= 65), 'no 2-up jump the body cannot make')
  })

  it('no exits from lava feet', () => {
    const movements = wiredMovements()
    const ns = movements.getNeighbors(new Move(-2, 62, 0, 0, 0))
    assert.ok(!ns.some((m) => m.y >= 64), 'lava never climbs to bank level')
  })

  it('h04: the level lip diagonal into water survives nocorner', () => {
    // wiredMovements applies addNoCornerCut after the swim exits: the
    // (3,63)->(4,62) lip diagonal grazes the bank-top block and used to be
    // filtered, leaving only the dive. A safe-water landing forgives it.
    const movements = wiredMovements()
    const ns = movements.getNeighbors(new Move(3, 63, 0, 0, 0))
    assert.ok(ns.some((m) => m.x === 4 && m.y === 62), 'level water entry kept')
  })

  it('h04: a level water diagonal past a post stays dropped (4ac)', () => {
    // The nocorner water exemption forgives below-feet grazes only: a
    // stone post at feet level on a side cell must still drop the level
    // diagonal, wet landing or not, or the 4ac wedge returns on water.
    const base = makeNameAt({ bankTop: 62, waterLo: 60, waterHi: 62, extras: false })
    const withPost = (x, y, z) => (x === 6 && y === 62 && z === 0) ? 'stone' : base(x, y, z)
    const movements = wiredMovements(withPost)
    const ns = movements.getNeighbors(new Move(5, 62, 0, 0, 0))
    assert.ok(!ns.some((m) => m.x === 6 && m.y === 62 && m.z === 1), 'post-side diagonal dropped')
  })

  it('h04: shallow crossings skim the surface, no dive', () => {
    // With level lip entries available the planner never leaves the top:
    // no dive (deep arrival pins at the face live) and no rise needed.
    const shallow = makeNameAt({ bankTop: 62, waterLo: 61, waterHi: 62, extras: false })
    const movements = wiredMovements(shallow)
    const astar = new AStar(new Move(0, 63, 0, 0, 0), movements, new goals.GoalBlock(14, 63, 0), 10000, 9000)
    const r = astar.compute()
    assert.equal(r.status, 'success')
    const wet = r.path.filter((m) => m.x >= 4 && m.x <= 9)
    assert.ok(wet.length > 0)
    assert.ok(wet.every((m) => m.y === 62), `surface skim: ${wet.map((m) => m.y).join(',')}`)
  })

  it('h04: the bank exit starts at the surface', () => {
    // Live (idk-eqd): a mount started below the surface never executes —
    // rising while pressing the face gets every packet rejected. Whatever
    // the cruise depth, the exit step itself must launch from the top.
    const movements = wiredMovements()
    const astar = new AStar(new Move(0, 63, 0, 0, 0), movements, new goals.GoalBlock(14, 63, 0), 10000, 9000)
    const r = astar.compute()
    assert.equal(r.status, 'success')
    const bi = r.path.findIndex((m) => m.x >= 10 && m.y === 63)
    assert.ok(bi > 0, 'path reaches the far bank')
    assert.equal(r.path[bi - 1].y, 62, `exit launches from the surface, not ${r.path[bi - 1].y}`)
  })
})

describe('swim prune (idkcraft-e8t)', () => {
  // East bank is a +4 cliff (stone to y=65) instead of a flush bank; the
  // river and west bank match the main world. Water->water descents and
  // rises ending above a floor are unexecutable and must not be offered;
  // level cruises — even head-on into the cliff — arrive fine (rig:
  // goal_reached, fm=0) and must stay.
  function cliffNameAt(x, y, z) {
    const river = x >= 4 && x <= 9
    if (x >= 10) {
      if (y <= 65) return 'stone'
      return 'air'
    }
    if (river) {
      if (y < 60) return 'stone'
      if (y <= 62) return 'water'
      return 'air'
    }
    if (y < 60) return 'stone'
    if (y <= 61) return 'dirt'
    if (y === 62) return 'grass_block'
    return 'air'
  }

  function swimOnly(nameFn) {
    const movements = new Movements(worldBot(nameFn))
    addSwimExits(movements)
    return movements
  }

  function swimPress(nameFn) {
    const movements = new Movements(worldBot(nameFn))
    addSwimExits(movements)
    addSwimPrune(movements)
    return movements
  }

  it('keeps level cruises, even head-on into the 2+ cliff face', () => {
    // The prune targets descents and floor-rises only: a level approach
    // ending adjacent to the cliff must survive — it arrives fine live
    // (rig: goal_reached, fm=0), so pruning it would only cost detours.
    const before = swimOnly(cliffNameAt).getNeighbors(new Move(8, 62, 0, 0, 0))
    const after = swimPress(cliffNameAt).getNeighbors(new Move(8, 62, 0, 0, 0))
    assert.ok(before.some((m) => m.x === 9 && m.y === 62), 'the lib offers the head-on approach')
    assert.ok(after.some((m) => m.x === 9 && m.y === 62), 'the head-on level approach survives')
    assert.ok(after.some((m) => m.x === 7), 'the cruise back west survives')
    assert.ok(after.some((m) => m.x === 8 && m.z === 1), 'the along-wall cruise survives')
    const hash = (ns) => ns.map((m) => m.hash).sort().join(' ')
    assert.equal(hash(after), hash(before), 'no level move is pruned here')
  })

  it('prunes diagonal dives (the executor holds jump and never sinks)', () => {
    // Air pocket beside a water node (cave mouth behind water): the lib
    // offers the diagonal dive into it; the executor cannot descend to
    // it (jump held every tick while isInWater), so it must go.
    const pocket = (x, y, z) => (x === 6 && y === 62 && z === 1) ? 'air' : cliffNameAt(x, y, z)
    const before = swimOnly(pocket).getNeighbors(new Move(5, 62, 0, 0, 0))
    assert.ok(before.some((m) => m.x === 6 && m.y === 61 && m.z === 1), 'the lib offers the dive without the prune')
    const after = swimPress(pocket).getNeighbors(new Move(5, 62, 0, 0, 0))
    assert.ok(!after.some((m) => m.x === 6 && m.y === 61 && m.z === 1), 'the dive is pruned')
    assert.ok(after.some((m) => m.x === 6 && m.y === 62 && m.z === 0), 'the level cruise survives')
  })

  it('prunes rises up onto a shelf, keeps flat wading cruises', () => {
    // Shelf ridge at x=7 (floor dirt 61, water 62 1-deep) mid-river:
    // rising onto it from the bottom storms (E7 — the rise runs in
    // contact with the shelf face); level wading along it walks (E8).
    const shelf = (x, y, z) => (x === 7 && y <= 61) ? 'dirt' : cliffNameAt(x, y, z)
    const before = swimOnly(shelf).getNeighbors(new Move(6, 61, 0, 0, 0))
    assert.ok(before.some((m) => m.x === 7 && m.y === 62), 'the rise onto the shelf exists without the prune')
    const up = swimPress(shelf).getNeighbors(new Move(6, 61, 0, 0, 0))
    assert.ok(!up.some((m) => m.x === 7 && m.y === 62), 'no rise up onto the shelf from the bottom')
    const along = swimPress(shelf).getNeighbors(new Move(7, 62, 0, 0, 0))
    assert.ok(along.some((m) => m.x === 7 && m.z === 1), 'wading along the shelf survives')
    const off = swimPress(shelf).getNeighbors(new Move(7, 62, 0, 0, 0))
    assert.ok(off.some((m) => m.x === 6 && m.y === 62), 'level cruise off the shelf into depth survives')
  })

  it('a +1 bank approach and mount survive', () => {
    // Flush-bank world: the level approach and the dry mount target are
    // outside both prune rules, so the h04 exit shape stays plannable.
    const after = swimPress(nameAt).getNeighbors(new Move(8, 62, 0, 0, 0))
    assert.ok(after.some((m) => m.x === 9 && m.y === 62), 'approach to the +1 bank kept')
    const exit = swimPress(nameAt).getNeighbors(new Move(9, 62, 0, 0, 0))
    assert.ok(exit.some((m) => m.x === 10 && m.y === 63), 'the +1 mount kept')
  })

  it('dry sources and double-installs are untouched', () => {
    const hash = (ns) => ns.map((m) => m.hash).sort().join(' ')
    const dryA = hash(swimOnly(cliffNameAt).getNeighbors(new Move(0, 63, 0, 0, 0)))
    const dryB = hash(swimPress(cliffNameAt).getNeighbors(new Move(0, 63, 0, 0, 0)))
    assert.equal(dryB, dryA)
    const movements = new Movements(worldBot(cliffNameAt))
    addSwimExits(movements)
    addSwimPrune(movements)
    addSwimPrune(movements)
    const twice = hash(movements.getNeighbors(new Move(8, 62, 0, 0, 0)))
    const once = hash(swimPress(cliffNameAt).getNeighbors(new Move(8, 62, 0, 0, 0)))
    assert.equal(twice, once)
  })

  it('a plan at an unexitable cliff holds no dive or floor-rise', () => {
    // The east top (feet 66) is unreachable from water: no +1 exit
    // anywhere. The search must still never emit an unexecutable water
    // move — no descents the executor cannot sink to, no rises ending
    // above a floor. Head-on level approaches may appear: they arrive.
    const movements = wiredMovements(cliffNameAt)
    const astar = new AStar(new Move(0, 63, 0, 0, 0), movements, new goals.GoalBlock(14, 66, 0), 10000, 9000)
    const r = astar.compute()
    assert.notEqual(r.status, 'success')
    const wet = (x, y, z) => cliffNameAt(x, y, z) === 'water'
    const solid = (x, y, z) => {
      const n = cliffNameAt(x, y, z)
      return n !== 'air' && n !== 'water'
    }
    let prev = { x: 0, y: 63, z: 0 }
    for (const m of r.path) {
      if (wet(prev.x, prev.y, prev.z) && wet(m.x, m.y, m.z)) {
        const dy = m.y - prev.y
        assert.ok(dy >= 0, `plan dives at ${m.x},${m.y},${m.z}`)
        if (dy > 0) assert.ok(!solid(m.x, m.y - 1, m.z), `plan rises onto a floor at ${m.x},${m.y},${m.z}`)
      }
      prev = m
    }
  })

  it('prunes dives from seagrass feet (the executor holds jump there too)', () => {
    // revmux core-1/body-2: seagrass reads safe-but-not-liquid while
    // physics waterLike (isInWater) counts it as water, so the
    // executor holds jump and cannot sink — a dive from a seagrass
    // cell treadmills exactly like one from water.
    const grassy = (x, y, z) => (x === 5 && y === 62 && z === 0) ? 'seagrass'
      : (x === 6 && y === 62 && z === 1) ? 'air' : cliffNameAt(x, y, z)
    const before = swimOnly(grassy).getNeighbors(new Move(5, 62, 0, 0, 0))
    assert.ok(before.some((m) => m.x === 6 && m.y === 61 && m.z === 1), 'the lib offers the dive from seagrass')
    const after = swimPress(grassy).getNeighbors(new Move(5, 62, 0, 0, 0))
    assert.ok(!after.some((m) => m.x === 6 && m.y === 61 && m.z === 1), 'the dive from seagrass is pruned')
    assert.ok(after.some((m) => m.x === 6 && m.y === 62 && m.z === 0), 'the level cruise survives')
  })

  it('prunes floor-rises into kelp, keeps level kelp bridges', () => {
    // revmux core-1: a kelp cell above a shelf is the E7 contact
    // shape with a non-liquid target — the rise storms the same way.
    // Level entry into kelp only exists as a place-bridge (the lib
    // reads kelp as air-over-a-gap, not swimmable water) and stays:
    // the toPlace rule fires on rises only, never on level builds.
    const shelf = (x, y, z) => (x === 7 && y <= 61) ? 'dirt' : cliffNameAt(x, y, z)
    const kelpy = (x, y, z) => (x === 7 && y === 62 && z === 0) ? 'kelp' : shelf(x, y, z)
    const before = swimOnly(kelpy).getNeighbors(new Move(6, 61, 0, 0, 0))
    assert.ok(before.some((m) => m.x === 7 && m.y === 62), 'the rise into kelp exists without the prune')
    const up = swimPress(kelpy).getNeighbors(new Move(6, 61, 0, 0, 0))
    assert.ok(!up.some((m) => m.x === 7 && m.y === 62), 'no rise into kelp above the shelf floor')
    const cruise = (x, y, z) => (x === 6 && y === 62 && z === 0) ? 'kelp' : cliffNameAt(x, y, z)
    const bridged = swimPress(cruise).getNeighbors(new Move(5, 62, 0, 5, 0))
    assert.ok(bridged.some((m) => m.x === 6 && m.y === 62 && m.z === 0 && m.toPlace && m.toPlace.length > 0),
      'level place-bridge into kelp survives')
  })

  it('prunes underwater place-then-jumpUp rises, keeps dry-land building', () => {
    // revmux body-1: with scaffolding aboard the lib offers jumpUp
    // moves that place their own floor (C water at plan time, dirt
    // at runtime) — the same contact shape once the block lands.
    // Dry-land construction (dry source or dry target) is untouched.
    const node = new Move(8, 60, 0, 5, 0)
    const before = swimOnly(cliffNameAt).getNeighbors(node)
    const placed = before.filter((m) => m.toPlace && m.toPlace.length > 0)
    assert.ok(placed.some((m) => m.x === 9 && m.y === 61), 'the lib offers the placing rise without the prune')
    const after = swimPress(cliffNameAt).getNeighbors(new Move(8, 60, 0, 5, 0))
    assert.ok(!after.some((m) => m.x === 9 && m.y === 61 && m.toPlace && m.toPlace.length > 0), 'the placing rise is pruned')
    assert.ok(after.some((m) => m.x === 7 && m.y === 60), 'the level bottom cruise survives')
    const hash = (ns) => ns.map((m) => m.hash).sort().join(' ')
    const dryA = hash(swimOnly(cliffNameAt).getNeighbors(new Move(0, 63, 0, 5, 0)))
    const dryB = hash(swimPress(cliffNameAt).getNeighbors(new Move(0, 63, 0, 5, 0)))
    assert.equal(dryB, dryA, 'dry-land building untouched with blocks aboard')
  })

  it('the planner rounds the cliff to a +1 notch instead of pinning', () => {
    // One flush notch in the cliff at z=6: the only way up. The plan
    // must cruise the river, round along the face, and mount there.
    const notch = (x, y, z) => {
      if (x === 10 && z === 6) {
        if (y <= 61) return 'stone'
        if (y === 62) return 'grass_block'
        return 'air'
      }
      return cliffNameAt(x, y, z)
    }
    const movements = wiredMovements(notch)
    const astar = new AStar(new Move(0, 63, 0, 0, 0), movements, new goals.GoalBlock(10, 63, 6), 20000, 19000)
    const r = astar.compute()
    assert.equal(r.status, 'success')
    const last = r.path[r.path.length - 1]
    assert.deepEqual([last.x, last.y, last.z], [10, 63, 6])
    assert.ok(r.path.some((m) => m.x === 9 && m.y === 62 && m.z === 6), 'mount launches beside the notch')
  })
})
