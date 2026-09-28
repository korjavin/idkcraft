'use strict'

// E2E scenarios, batch 1b (idkcraft-zw8): closed recover-menu bugs replayed
// through the full tick→menu→primitive→facts path (createTicker + ticker.tick
// with harness physics). The menu-level tests drive recover.decide/run
// directly with a hand ctx; these scenarios pin the episode seams — choice
// sources, per-tick status sampling, done/release accounting — where the
// prod symptoms (false done, apex done, unmounted hop) actually showed.

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { Vec3 } = require('vec3')
const { createTicker } = require('../src/index')

function pos(x, y, z) {
  return {
    x, y, z,
    distanceTo: (q) => Math.hypot(x - q.x, y - q.y, z - q.z),
    clone() { return pos(x, y, z) },
    floored() { return pos(Math.floor(x), Math.floor(y), Math.floor(z)) },
    offset(ox, oy, oz) { return pos(x + ox, y + oy, z + oz) },
  }
}

function key(x, y, z) { return `${x},${y},${z}` }

// Fake-world bot (same shape as recover.test.js worldBot): scripted solids,
// chat capture, controls, goal recording. The body moves only via the
// scenario stepBody / scripted positions.
function worldBot(solids, items) {
  const bot = {
    username: 'IdkBot',
    players: {},
    entities: {},
    health: 20,
    food: 20,
    entity: { position: pos(0.5, 61, 0.5), onGround: true },
    inventory: { items: () => items },
    controls: {},
    setControlState(c, v) { this.controls[c] = !!v },
    getControlState(c) { return !!this.controls[c] },
    clearControlStates() { this.controls = {} },
    blockAt(p) {
      const k = key(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z))
      const solidCell = solids.has(k)
      return { name: solidCell ? 'dirt' : 'air', position: new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)), boundingBox: solidCell ? 'block' : 'empty' }
    },
    async placeBlock() {},
    async dig(block) { solids.delete(key(block.position.x, block.position.y, block.position.z)) },
    pathfinder: {
      goal: null,
      setGoal(g) { this.goal = g },
      stop() {},
      isMoving: () => false,
    },
    chats: [],
    chat(m) { this.chats.push(String(m)) },
  }
  return bot
}

function capture() {
  const lines = []
  const origLog = console.log
  const origErr = console.error
  console.log = (m) => { lines.push(String(m)) }
  console.error = (m) => { lines.push(String(m)) }
  return { lines, release() { console.log = origLog; console.error = origErr } }
}

describe('fja: pit-floor shuffle pages the player, never reports done', () => {
  // Session 2026-09-24: a 0.9-block shuffle on the pit floor counted as an
  // escape, fails never grew, call_player never came. Fixed: the strict
  // rule fails floor shuffling. E2E: the whole episode through ticker ticks.
  function pitSolids() {
    const solids = new Set()
    for (let x = -3; x <= 3; x++) {
      for (let z = -1; z <= 1; z++) solids.add(key(x, 60, z))
    }
    for (let y = 61; y <= 64; y++) {
      for (let x = -2; x <= 2; x++) { solids.add(key(x, y, -1)); solids.add(key(x, y, 1)) }
      solids.add(key(-2, y, 0)); solids.add(key(2, y, 0))
    }
    return solids
  }

  it('goal-less backstop episode shuffles, fails, chats /tp exactly once', async () => {
    const bot = worldBot(pitSolids(), [])
    bot.entity.position = pos(0.5, 61, 0.5)
    bot.players = { Steve: { username: 'Steve', entity: { id: 7, username: 'Steve', position: pos(50, 64, 0) } } }
    const brain = {
      decides: 0,
      asks: 0,
      async decide() { this.decides++; return { action: 'follow', sprint: false, source: 'stub' } },
      async ask() { this.asks++; return 'sidestep' },
    }
    const ticker = createTicker({ bot, brain, tickMs: 10, idleTickMs: 10 })
    bot._tickerCtx.stuck = { by: 'no-displacement', goal: null, key: 'pit' }
    const stepBody = () => {
      const g = bot.pathfinder.goal
      if (!g || typeof g.x !== 'number') return
      const bp = bot.entity.position
      const dx = g.x - bp.x
      const dz = g.z - bp.z
      const d = Math.hypot(dx, dz)
      if (d < 0.05) return
      const s = Math.min(0.4, d) / d
      bot.entity.position = pos(bp.x + dx * s, 61, bp.z + dz * s) // pinned to the floor
    }
    const cap = capture()
    const actions = []
    try {
      let t = 0
      for (; t < 150 && (bot._tickerCtx.stuck || bot._tickerCtx.recovery); t++) {
        const r = await ticker.tick()
        actions.push(r.decision && r.decision.action)
        stepBody()
      }
      assert.ok(t < 150, 'episode ends')
      assert.equal(actions[0], 'sidestep', `first choice: ${actions.join(',')}`)
      assert.ok(actions.includes('call_player'), `episode pages the player: ${actions.join(',')}`)
      assert.equal(actions[actions.length - 1], 'idle', 'release parks the tick')
      assert.ok(!actions.includes('wait'), `no stall-out wait: ${actions.join(',')}`)
      const calls = bot.chats.filter((m) => m.startsWith("I'm stuck at"))
      assert.equal(calls.length, 1, `exactly one /tp chat, got: ${bot.chats.join(' | ')}`)
      assert.match(calls[0], /\/tp IdkBot Steve/)
      assert.ok(cap.lines.some((l) => /recover action=call_player .* outcome=gave-up/.test(l)), 'paged episode gave up')
      assert.equal(bot._tickerCtx.stuck, null, 'fact cleared')
      assert.equal(bot._tickerCtx.recovery, null, 'episode cleared')
      assert.equal(brain.decides, 0, 'stuck ticks never call the brain')
      assert.ok(brain.asks >= 1, 'menu asked the model at the decision point')
    } finally {
      cap.release()
      ticker.destroy()
    }
  })
})

describe('ak4: sidestep apex sample is not an escape', () => {
  it('airborne floor rise stays running, grounded rise ends the episode done', async () => {
    // Prod 2026-09-24: 13/13 sidestep dones read at y=62.1-62.2 from a y=61
    // start — the 1 Hz tick sampling the sidestep jump apex. Fixed: a floor
    // rise only counts on the ground. E2E: the samples arrive as ticks.
    const solids = new Set()
    for (let x = -3; x <= 3; x++) {
      for (let z = -3; z <= 3; z++) solids.add(key(x, 60, z))
    }
    const bot = worldBot(solids, [])
    bot.entity.position = pos(0.5, 61, 0.5)
    bot.entity.onGround = true
    bot.players = { Steve: { username: 'Steve', entity: { id: 7, username: 'Steve', position: pos(10, 64, 0) } } }
    const brain = { async decide() { return { action: 'follow', sprint: false, source: 'stub' } } } // FSM-only: no ask
    const ticker = createTicker({ bot, brain, tickMs: 10, idleTickMs: 10 })
    bot._tickerCtx.stuck = { by: 'follow', goal: { x: 10, y: 61, z: 0 }, key: 'follow:Steve' }
    const cap = capture()
    try {
      const r1 = await ticker.tick() // menu picks sidestep, first run issues + jumps
      assert.equal(r1.decision.action, 'sidestep')
      assert.equal(bot._tickerCtx.recovery.status, 'running')
      bot.entity.position = pos(0.5, 62.2, 0.5) // jump apex sample
      bot.entity.onGround = false
      const r2 = await ticker.tick()
      assert.equal(r2.decision.action, 'sidestep')
      assert.equal(bot._tickerCtx.recovery.status, 'running', 'apex sample is not an escape')
      assert.ok(bot._tickerCtx.stuck, 'fact still held at the apex')
      bot.entity.onGround = true // same rise, feet on the ground
      const r3 = await ticker.tick()
      assert.equal(r3.decision.action, 'sidestep')
      assert.equal(bot._tickerCtx.recovery.status, 'done', 'grounded rise is the escape')
      const r4 = await ticker.tick() // done releases the episode
      assert.equal(r4.decision.action, 'idle')
      assert.equal(bot._tickerCtx.stuck, null)
      assert.equal(bot._tickerCtx.recovery, null)
      assert.ok(cap.lines.some((l) => /recover action=sidestep .* outcome=done/.test(l)), cap.lines.join('\n'))
      assert.ok(!cap.lines.some((l) => /outcome=gave-up/.test(l)), 'escape, not a gave-up')
    } finally {
      cap.release()
      ticker.destroy()
    }
  })
})

describe('ak4/cjq: hop_step back-off and mount through ticks', () => {
  // Floor + one STONE step east with air above (cjq world): no dig_step (the
  // stone never digs by hand), so the FSM must prefer the no-dig hop on a
  // level goal. ak4: pressed to the face with vel.y=0 and no ground, the
  // held jump never fires — the hop backs off until a sample reads ground.
  function stepBot() {
    // Full floor under the run-up plus the stone step: gravity and
    // groundedness resolve everywhere the body walks, like prod ground.
    const solids = new Set()
    for (let x = -3; x <= 3; x++) {
      for (let z = -1; z <= 1; z++) solids.add(key(x, 60, z))
    }
    solids.add(key(1, 61, 0))
    const bot = worldBot(solids, [])
    const raw = bot.blockAt.bind(bot)
    bot.blockAt = (p) => {
      const b = raw(p)
      if (b && key(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)) === key(1, 61, 0)) {
        return { ...b, name: 'stone' }
      }
      return b
    }
    bot.entity.position = pos(0.5, 61, 0.5)
    bot.players = { Steve: { username: 'Steve', entity: { id: 7, username: 'Steve', position: pos(5, 61, 0) } } }
    bot._yaw = 0
    bot.look = (yaw) => { bot._yaw = yaw }
    return bot
  }

  function fsmBrain() {
    return { async decide() { return { action: 'follow', sprint: false, source: 'stub' } } }
  }

  it('hanging at the face holds back, stays running (ak4 unwedge)', async () => {
    const bot = stepBot()
    bot.entity.onGround = false // hanging at the face from the first sample
    bot.entity.velocity = { x: 0, y: 0, z: 0 }
    const ticker = createTicker({ bot, brain: fsmBrain(), tickMs: 10, idleTickMs: 10 })
    bot._tickerCtx.stuck = { by: 'follow', goal: { x: 5, y: 61, z: 0 }, key: 'follow:Steve' }
    const cap = capture()
    try {
      let sawBack = false
      let first = null
      for (let t = 0; t < 14 && !sawBack; t++) {
        const r = await ticker.tick()
        if (first === null) first = r.decision.action
        assert.equal(r.decision.action, 'hop_step')
        assert.equal(bot._tickerCtx.recovery.status, 'running')
        if (bot.controls.back) sawBack = true
      }
      assert.equal(first, 'hop_step', 'FSM picks the hop on a level goal')
      assert.ok(sawBack, 'stall backs off the face')
    } finally {
      cap.release()
      ticker.destroy()
    }
  })

  it('grounded run-up mounts the step and ends the episode done (cjq)', async () => {
    const bot = stepBot()
    bot.entity.onGround = true
    const ticker = createTicker({ bot, brain: fsmBrain(), tickMs: 10, idleTickMs: 10 })
    bot._tickerCtx.stuck = { by: 'follow', goal: { x: 5, y: 61, z: 0 }, key: 'follow:Steve' }
    // Harness physics: face collision at low feet, capped jump rise,
    // gravity, groundedness from the cell below. Without these the mount
    // reads done on an airborne sample (revmux core-1): prod samples the
    // leap mid-air, so done must wait for grounded feet over the step.
    const stepBody = () => {
      const bp = bot.entity.position
      const blocked = (nx, nz) => {
        const cell = bot.blockAt({ x: nx, y: bp.y, z: nz })
        return !!cell && cell.boundingBox !== 'empty'
      }
      if (bot.getControlState('forward')) {
        const yaw = bot._yaw || 0
        const nx = bp.x - Math.sin(yaw) * 0.4
        const nz = bp.z - Math.cos(yaw) * 0.4
        if (!blocked(nx, nz)) bot.entity.position = pos(nx, bp.y, nz)
      } else if (bot.getControlState('back')) {
        const yaw = bot._yaw || 0
        const nx = bp.x + Math.sin(yaw) * 0.4
        const nz = bp.z + Math.cos(yaw) * 0.4
        if (!blocked(nx, nz)) bot.entity.position = pos(nx, bp.y, nz)
      } else {
        const g = bot.pathfinder.goal
        if (g && typeof g.x === 'number') {
          const dx = g.x - bp.x
          const dz = g.z - bp.z
          const d = Math.hypot(dx, dz)
          if (d >= 0.05) {
            const s = Math.min(0.4, d) / d
            bot.entity.position = pos(bp.x + dx * s, bp.y, bp.z + dz * s)
          }
        }
      }
      const st = bot._tickerCtx.recovery && bot._tickerCtx.recovery.st
      const capY = st && typeof st.startFloor === 'number' ? st.startFloor + 1.05 : 61.05
      const jumping = bot.getControlState('jump')
      if (jumping && bot.entity.position.y < capY) bot.entity.position.y += 0.5
      const below = bot.blockAt({ x: bot.entity.position.x, y: bot.entity.position.y - 0.1, z: bot.entity.position.z })
      if (below && below.boundingBox !== 'empty') {
        bot.entity.position.y = Math.floor(bot.entity.position.y - 0.1) + 1
        bot.entity.onGround = true
      } else if (!jumping) {
        bot.entity.position.y -= 0.5
        bot.entity.onGround = false
        const land = bot.blockAt({ x: bot.entity.position.x, y: bot.entity.position.y - 0.1, z: bot.entity.position.z })
        if (land && land.boundingBox !== 'empty') {
          bot.entity.position.y = Math.floor(bot.entity.position.y - 0.1) + 1
          bot.entity.onGround = true
        }
      } else {
        bot.entity.onGround = false
      }
    }
    const cap = capture()
    const actions = []
    try {
      let t = 0
      let sawSettled = false
      for (; t < 60 && (bot._tickerCtx.stuck || bot._tickerCtx.recovery); t++) {
        const r = await ticker.tick()
        actions.push(r.decision && r.decision.action)
        const st = bot._tickerCtx.recovery && bot._tickerCtx.recovery.st
        if (st && st.settled) sawSettled = true
        stepBody()
      }
      assert.ok(t < 60, 'episode ends')
      assert.equal(actions[0], 'hop_step', `first choice, got ${actions.join(',')}`)
      assert.ok(sawSettled, 'leap settles over the top before done')
      assert.ok(Math.floor(bot.entity.position.y) >= 62, `mounted, y=${bot.entity.position.y}`)
      assert.equal(bot.entity.onGround, true, 'done on grounded feet, not an apex sample')
      assert.equal(bot._tickerCtx.stuck, null, 'episode over')
      assert.equal(bot._tickerCtx.recovery, null, 'episode over')
      assert.ok(cap.lines.some((l) => /recover action=hop_step .* outcome=done/.test(l)), cap.lines.join('\n'))
      assert.ok(!actions.includes('call_player'), `mounted, never paged: ${actions.join(',')}`)
    } finally {
      cap.release()
      ticker.destroy()
    }
  })
})

describe('4jr: level goal never offers climb, failed prims are not repeated', () => {
  // Prod 2026-09-24: laya always took the first menu item (pillar_up) on
  // level goals and repeated it after place-error fails — 29 pillar_ups in
  // 16 min, ~20 s standing per attempt. Fixed twice: climb prims leave the
  // feasible menu on level goals, and the just-failed prim leaves the ask
  // menu (a stubborn repeat reads invalid and falls back to the FSM).
  const kit = [{ name: 'dirt', count: 5 }] // no pickaxe: the 4jr pin is the exclusion, not the dig menu

  // Floor + one dirt wall with a stone cap, no pickaxe on hand: walls=1,
  // but no dig_step (the stone cap needs a pick since jsf.4) — the 4jr
  // menu case exactly.
  function levelBot() {
    // Headroom stays FREE (revmux-01 body-1): a head block would exclude
    // pillar_up by itself and mask the failed-action rules under test.
    const bot = worldBot(new Set([key(0, 60, 0), key(1, 61, 0), key(1, 62, 0)]), kit)
    const raw = bot.blockAt.bind(bot)
    bot.blockAt = (p) => {
      const b = raw(p)
      if (b && key(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)) === key(1, 62, 0)) {
        return { ...b, name: 'stone' }
      }
      return b
    }
    bot.entity.position = pos(0.5, 61, 0.5)
    bot.players = { Steve: { username: 'Steve', entity: { id: 7, username: 'Steve', position: pos(5, 61, 0) } } }
    return bot
  }

  it('level goal: first-label model gets sidestep, menu lacks climb', async () => {
    const bot = levelBot()
    const seen = []
    const brain = {
      async decide() { return { action: 'follow', sprint: false, source: 'stub' } },
      async ask(q) { seen.push(Object.keys(q.criteria)); return seen[0][0] },
    }
    const ticker = createTicker({ bot, brain, tickMs: 10, idleTickMs: 10 })
    bot._tickerCtx.stuck = { by: 'follow', goal: { x: 5, y: 61, z: 0 }, key: 'follow:Steve' }
    const cap = capture()
    try {
      const r = await ticker.tick()
      assert.equal(seen.length, 1, 'asked once')
      assert.ok(!seen[0].includes('pillar_up'), `menu: ${seen[0]}`)
      assert.ok(!seen[0].includes('dig_up'), `menu: ${seen[0]}`)
      assert.equal(r.decision.action, 'sidestep')
      assert.equal(bot._tickerCtx.recovery.status, 'running')
      assert.ok(bot.pathfinder.goal, 'sidestep issued its goal')
      const r2 = await ticker.tick()
      assert.equal(r2.decision.action, 'sidestep', 'episode runs on')
    } finally {
      cap.release()
      ticker.destroy()
    }
  })

  it('stubborn pillar_up repeat after place-error is overruled to sidestep', async () => {
    const bot = levelBot()
    const seen = []
    const brain = {
      async decide() { return { action: 'follow', sprint: false, source: 'stub' } },
      async ask(q) { seen.push(Object.keys(q.criteria)); return 'pillar_up' },
    }
    const ticker = createTicker({ bot, brain, tickMs: 10, idleTickMs: 10 })
    bot._tickerCtx.stuck = { by: 'gather', goal: { x: 0, y: 70, z: 0 }, key: 'gather' }
    // A pillar_up just failed place-error: the next tick re-asks past it.
    bot._tickerCtx.recovery = {
      action: 'pillar_up', source: 'stub', model: null, status: 'failed:place-error',
      st: null, attempts: 1, fails: 0, repeats: 0, last: null,
      calledPlayer: false, endEpisode: false, lastDy: null,
    }
    const cap = capture()
    try {
      const r = await ticker.tick()
      assert.equal(seen.length, 1, 're-asked once')
      assert.ok(!seen[0].includes('pillar_up'), `menu: ${seen[0]}`)
      assert.equal(r.decision.action, 'sidestep', `no climb prim offered with free headroom (9sq F1), got ${r.decision.action}`)
      assert.equal(r.decision.source, 'stub-fallback')
      assert.ok(cap.lines.some((l) => l.includes('brain disagree')), 'overrule logged')
    } finally {
      cap.release()
      ticker.destroy()
    }
  })
})

describe('9sh: dig_step climbs a dirt pit by hand through ticks', () => {
  // Bead 9sh: scaffold=0, pickaxe=no after death — no climb primitive, yet
  // dirt walls dig by hand. Fixed: dig_step is in the menu and climbs out.
  // E2E: the whole climb through ticker ticks, with a player online (paging
  // stays feasible the whole time — self-exit must still win).
  function dirtPit() {
    const solids = new Set()
    for (let x = -3; x <= 3; x++) {
      for (let z = -1; z <= 1; z++) solids.add(key(x, 60, z))
    }
    for (let y = 61; y <= 64; y++) {
      for (let x = -2; x <= 2; x++) { solids.add(key(x, y, -1)); solids.add(key(x, y, 1)) }
      solids.add(key(-2, y, 0)); solids.add(key(2, y, 0))
    }
    // Notch at the wall top: the second cycle picks its step standing on
    // the first mount, and findDigStepDir vetoes without two air above the
    // feet — (0,64,1) is that headroom cell. Load-bearing (verified:
    // filling the notch fails the climb, the episode degrades to /tp).
    solids.delete(key(0, 64, 1))
    return solids
  }

  it('high goal dirt pit: dig_step first, climbs out, never pages', async () => {
    const solids = dirtPit()
    const bot = worldBot(solids, [])
    bot.entity.position = pos(0.5, 61, 0.5)
    bot.players = { Steve: { username: 'Steve', entity: { id: 7, username: 'Steve', position: pos(50, 64, 0) } } }
    bot._yaw = 0
    bot.look = (yaw) => { bot._yaw = yaw }
    const brain = { async decide() { return { action: 'follow', sprint: false, source: 'stub' } } } // FSM-only
    const ticker = createTicker({ bot, brain, tickMs: 10, idleTickMs: 10 })
    bot._tickerCtx.stuck = { by: 'gather', goal: { x: 0, y: 70, z: 0 }, key: 'gather' }
    // Harness collision (adv): honest feet+head — any solid refuses the
    // move. No executor-dig emulation: dig_step owns the mount head itself
    // (digs (dx,2,dz) by hand before the mount), so the climb must pass on
    // primitive digging alone.
    const stepBody = () => {
      const bp = bot.entity.position
      const tryMove = (nx, nz) => {
        const feet = bot.blockAt({ x: nx, y: bp.y, z: nz })
        const head = bot.blockAt({ x: nx, y: bp.y + 1, z: nz })
        let ok = true
        if (feet && feet.boundingBox !== 'empty') ok = false
        else if (head && head.boundingBox !== 'empty') ok = false
        // A refused step never cancels the jump below: prod jumps in
        // place against the step, then moves over once risen.
        if (ok) bot.entity.position = pos(nx, bp.y, nz)
      }
      // Direct drive first (jsf.4: the mount sets no goal), goal walk after.
      const yaw = bot._yaw || 0
      if (bot.getControlState('forward')) {
        tryMove(bp.x - Math.sin(yaw) * 0.4, bp.z - Math.cos(yaw) * 0.4)
      } else if (bot.getControlState('back')) {
        tryMove(bp.x + Math.sin(yaw) * 0.4, bp.z + Math.cos(yaw) * 0.4)
      } else {
        const g = bot.pathfinder.goal
        if (g && typeof g.x === 'number') {
          const dx = g.x - bp.x
          const dz = g.z - bp.z
          const d = Math.hypot(dx, dz)
          if (d >= 0.05) {
            const s = Math.min(0.4, d) / d
            tryMove(bp.x + dx * s, bp.z + dz * s)
          }
        }
      }
      // Honest jump + gravity (adv): a held jump impulses +1.0 from the
      // ground only (a real leap, enough to clear the step's feet cell);
      // airborne ticks fall, and solid ground below snaps the feet and
      // grounds. Without the mount head dug, the XZ drift refuses at the
      // face and the body bunny-hops in place until the mount budget dies.
      const st = bot._tickerCtx.recovery && bot._tickerCtx.recovery.st
      const capY = st && typeof st.startFloor === 'number' ? st.startFloor + 1.05 : 61.05
      const jumping = bot.getControlState('jump')
      if (jumping && bot.entity.onGround && bot.entity.position.y < capY) bot.entity.position.y += 1.0
      const below = bot.blockAt({ x: bot.entity.position.x, y: bot.entity.position.y - 0.1, z: bot.entity.position.z })
      if (below && below.boundingBox !== 'empty') {
        bot.entity.position.y = Math.floor(bot.entity.position.y - 0.1) + 1
        bot.entity.onGround = true
      } else if (!jumping || !bot.entity.onGround) {
        bot.entity.position.y -= 0.5
        bot.entity.onGround = false
        const land = bot.blockAt({ x: bot.entity.position.x, y: bot.entity.position.y - 0.1, z: bot.entity.position.z })
        if (land && land.boundingBox !== 'empty') {
          bot.entity.position.y = Math.floor(bot.entity.position.y - 0.1) + 1
          bot.entity.onGround = true
        }
      } else {
        bot.entity.onGround = false
      }
    }
    const flush = async () => { for (let i = 0; i < 3; i++) await new Promise((r) => setImmediate(r)) }
    const cap = capture()
    const actions = []
    try {
      let t = 0
      let firstMountHead = 'unseen'
      let prevPhase = null
      for (; t < 200 && (bot._tickerCtx.stuck || bot._tickerCtx.recovery); t++) {
        const r = await ticker.tick()
        actions.push(r.decision && r.decision.action)
        const st = bot._tickerCtx.recovery && bot._tickerCtx.recovery.st
        const phase = st && st.phase
        if (prevPhase === 'dig' && phase === 'step' && firstMountHead === 'unseen' && st && st.dir) {
          // The mount head must already be air when the first mount starts:
          // dig_step owns it upfront (adv), never discovers it mid-arc via
          // an apex sample or the executor's canDig.
          const bp = bot.entity.position
          const head = bot.blockAt({ x: Math.floor(bp.x) + st.dir[0], y: Math.floor(bp.y) + 2, z: Math.floor(bp.z) + st.dir[1] })
          firstMountHead = head && head.boundingBox !== 'empty' ? head.name : 'air'
        }
        if (phase) prevPhase = phase
        stepBody()
        await flush()
      }
      assert.ok(t < 200, 'episode ends')
      assert.equal(actions[0], 'dig_step', `first choice, got ${actions.join(',')}`)
      assert.equal(firstMountHead, 'air', `mount head dug before the first mount, got ${firstMountHead}`)
      assert.ok(Math.floor(bot.entity.position.y) >= 65, `climbed out, y=${bot.entity.position.y}`)
      assert.equal(bot._tickerCtx.stuck, null, 'episode over')
      assert.equal(bot._tickerCtx.recovery, null, 'episode over')
      assert.deepEqual(bot.chats.filter((m) => m.startsWith("I'm stuck at")), [], 'self-exit, never paged')
    } finally {
      cap.release()
      ticker.destroy()
    }
  })
})

describe('rw4.9.1: repeat episodes in one pit stay silent, the ask stands out', () => {
  function pitSolids() {
    const solids = new Set()
    for (let x = -3; x <= 3; x++) {
      for (let z = -1; z <= 1; z++) solids.add(key(x, 60, z))
    }
    for (let y = 61; y <= 64; y++) {
      for (let x = -2; x <= 2; x++) { solids.add(key(x, y, -1)); solids.add(key(x, y, 1)) }
      solids.add(key(-2, y, 0)); solids.add(key(2, y, 0))
    }
    return solids
  }

  it('episode 1 narrates, gave-up marks, episode 2 keeps only the /tp ask', async () => {
    // Prod 2026-09-27 12:55-13:05: 25 stuck-chats drowned the rescue page.
    // The first episode tells the story; repeats keep quiet so the
    // call_player ask stays visible in the scrollback. Steve is online
    // (fja shape): without a player the menu ends wait-done and lays no
    // mark, and the idle branch would not route the fact at all.
    const bot = worldBot(pitSolids(), [])
    bot.entity.position = pos(0.5, 61, 0.5)
    bot.players = { Steve: { username: 'Steve', entity: { id: 7, username: 'Steve', position: pos(50, 64, 0) } } }
    const brain = { async decide() { return { action: 'idle', sprint: false, source: 'stub' } } }
    const ticker = createTicker({ bot, brain, tickMs: 10, idleTickMs: 10, autonomous: true })
    async function runEpisode(n) {
      bot._tickerCtx.stuck = { by: 'no-displacement', goal: null, key: `pit:${n}` }
      let t = 0
      const cap = 400
      for (; t < cap && (bot._tickerCtx.stuck || bot._tickerCtx.recovery); t++) {
        await ticker.tick() // the trap holds: no displacement, budget burns, gave up
      }
      assert.ok(t < cap, 'episode ends')
    }
    const stuckCount = () => bot.chats.filter((m) => m.startsWith('stuck, trying')).length
    const askCount = () => bot.chats.filter((m) => m.startsWith("I'm stuck at")).length
    try {
      await runEpisode(1) // episode 1: fresh pit
      const firstStuck = stuckCount()
      assert.ok(firstStuck >= 1, `episode 1 narrates: ${bot.chats.join(' | ')}`)
      assert.equal(askCount(), 1, `episode 1 asks once: ${bot.chats.join(' | ')}`)
      await runEpisode(2) // episode 2: same pit, live mark
      assert.equal(stuckCount(), firstStuck, `episode 2 adds no stuck-chat: ${bot.chats.join(' | ')}`)
      assert.equal(askCount(), 2, `the ask persists every episode: ${bot.chats.join(' | ')}`)
    } finally {
      ticker.destroy()
    }
  })
})
