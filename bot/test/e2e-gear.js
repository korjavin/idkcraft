'use strict'

// Manual e2e: gear forges from stock and hands over (not run by npm test).
// Against a running flat server (sh test/mc-up.sh): connect the assay bot,
// RCON-seed stock, tick the REAL gear behaviour in-process, and hand each
// owner piece over via the REAL stockpile step (chest placed by RCON).
// Leg 1 (self pick): stone kit + 3 ingots + 2 sticks -> iron_pickaxe in pack.
// Leg 2 (self pair, jsf.5): + 6 ingots -> 2x (bucket crafted, filled at RCON
// water) -> the reserve pair in pack, no haul (self forge stays silent).
// Leg 3 (owner sword): + 2 ingots + stick -> forged, banked, given, NBT.
// Leg 4 (owner pick): + 3 ingots + 2 sticks -> forged, banked with the self
// twin surviving, haul cleared, chest NBT holds both.
// Leg 5 (owner buckets, jsf.5): 2x (3 ingots -> craft, fill, bank) -> given
// water_bucket 2, the reserve pair surviving, ladder on self armour.
// Leg 6 (pantry, ipn.6): 20 ingots banked via the real stockpile step,
// then the self helmet rung draws 5 back from the chest, crafts, and WEARS
// it (armour slot 5) — mats in chest -> withdrawn -> crafted -> worn.
// Leg 7 (self set, ipn.6): 19 more ingots -> chestplate+leggings+boots
// forged and worn (slots 6-8), no sticks, no haul.
// Leg 8 (owner armour, ipn.6): 4x (5/8/7/4 ingots -> forge, bank) -> given
// all four, spares in the chest NBT, worn set untouched, ladder on diamond.
// Leg 9 (diamond crossing, ipn.6): self diamond pick from seed diamonds,
// owner sword+pick forged+banked, self diamond helmet worn.
// Exit 0/1; prints GEAR E2E PASS/FAIL.
const mineflayer = require('mineflayer')
const { pathfinder } = require('mineflayer-pathfinder')
const { Vec3 } = require('vec3')
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')
const { waitFor, sleep } = require('./e2e-util')
const gear = require('../src/behaviours/gear')
const stockpile = require('../src/behaviours/stockpile')

const execFileAsync = promisify(execFile)

const MC_HOST = process.env.MC_HOST || 'localhost'
const MC_PORT = parseInt(process.env.MC_PORT || '25565', 10)
const MC_CONTAINER = process.env.MC_CONTAINER || 'idk-mc'
const NAME = `GearAssay${Math.floor(Math.random() * 10000)}`
const TICK_MS = parseInt(process.env.E2E_TICK_MS || '100', 10)
const CAP_TICKS = 150

async function rcon(cmd) {
  await execFileAsync('docker', ['exec', MC_CONTAINER, 'rcon-cli', cmd])
}

function count(bot, name) {
  let n = 0
  try {
    for (const i of bot.inventory.items()) {
      if (i && i.name === name) n += typeof i.count === 'number' ? i.count : 1
    }
  } catch (_) { /* unreadable: 0 */ }
  return n
}

// Worn check (ipn.6): armour slots 5-8 hold the live set; items() skips them.
function worn(bot, name) {
  try {
    const slots = bot && bot.inventory && bot.inventory.slots
    if (!Array.isArray(slots)) return 0
    let n = 0
    for (const s of [5, 6, 7, 8]) {
      if (slots[s] && slots[s].name === name) n += 1
    }
    return n
  } catch (_) {
    return 0
  }
}

async function main() {
  // Op BEFORE login (water-assay pattern): the fill scoop is a block change
  // and spawn protection refuses un-opped scoops; a mid-session op does not
  // lift it for the live session. Best-effort: flat rigs don't care.
  try {
    await rcon(`op ${NAME}`)
    console.log(`pre-opped ${NAME}`)
  } catch (err) {
    console.log(`pre-op skipped: ${err && err.message ? err.message : err}`)
  }
  const bot = mineflayer.createBot({ host: MC_HOST, port: MC_PORT, username: NAME, auth: 'offline' })
  bot.loadPlugin(pathfinder)
  await waitFor(bot, 'spawn', 60000, 'assay spawn')
  await rcon('difficulty peaceful') // flat spawns slimes that knock bots mid-run
  const chunkDeadline = Date.now() + 30000
  while (bot.blockAt(bot.entity.position.floored().offset(0, -1, 0)) == null) {
    if (Date.now() > chunkDeadline) throw new Error('setup invalid: spawn chunk never loaded')
    await sleep(1000)
  }
  const feet = bot.entity.position
  let surf = null
  for (let i = 1; i <= 8; i++) {
    const b = bot.blockAt(feet.floored().offset(0, -i, 0))
    if (b && b.name !== 'air') { surf = b.position.y + 1; break }
  }
  if (surf === null) throw new Error('setup invalid: no ground under assay bot')
  const cx = Math.round(feet.x)
  const cz = Math.round(feet.z)
  const tx = cx + 1
  const hx = cx - 1
  await rcon(`setblock ${tx} ${surf} ${cz} crafting_table`)
  await rcon(`setblock ${hx} ${surf} ${cz} chest`)
  await rcon(`tp ${NAME} ${cx} ${surf} ${cz}`)
  await sleep(1500)
  // Start clear (ipn.6): earlier runs cluster near spawn, and their spread
  // sits inside the 32-block fill scan — stale flowing cells cost 20 ticks
  // each and time the fill legs out. One fill wipes water around the pad
  // (23k blocks, under the 32768 /fill limit); per-leg removeWater keeps
  // the run itself clean. Disposable rig copy only.
  try {
    await rcon(`fill ${cx - 24} ${surf - 6} ${cz - 24} ${cx + 24} ${surf + 3} ${cz + 24} air replace water`)
  } catch (_) { /* best-effort: the legs clear after themselves */ }
  // jsf.5: the fill source is an infinite 2x2 in bot-verified open air a
  // few blocks out — a blind offset lands inside terrain on hilly ground
  // (unreachable), a single source is drunk dry by the first scoop, and
  // open water next to the pad floods the table legs (the head-space
  // fallback is always air). Each fill leg places it and removes it after,
  // so crafts and banks run dry; the bot walks to the water for the scoop.
  async function placeWater() {
    const cands = [[4, 0], [-4, 0], [0, 4], [0, -4], [5, 0], [0, 5], [5, 5], [-5, -5]]
      .map(([dx, dz]) => [cx + dx, surf, cz + dz])
    cands.push([cx, surf + 1, cz])
    for (const [x, y, z] of cands) {
      let b = null
      try {
        b = bot.blockAt(new Vec3(x, y, z))
      } catch (_) { /* unloadable */ }
      if (!b || (b.name !== 'air' && b.name !== 'water' && b.name !== 'cave_air')) continue
      for (const [ox, oz] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
        await rcon(`setblock ${x + ox} ${y} ${z + oz} water`)
      }
      await sleep(800) // the 2x2 settles into sources
      let v = null
      try {
        v = bot.blockAt(new Vec3(x, y, z))
      } catch (_) { /* unloadable */ }
      if (v && v.name === 'water') {
        console.log(`fill source 2x2 at ${x},${y},${z}`)
        return [x, y, z]
      }
    }
    throw new Error('setup invalid: no open cell for the fill source')
  }
  async function removeWater(cell) {
    if (!cell) return
    // Box clear (ipn.6): on prod-world slopes the 2x2 spreads past its
    // cells, and leftover water poisons later legs (flowing cells never
    // fill) and later runs (no air cell for the source). One fill clears
    // source and spread; the chunks are loaded (the bot stands in them).
    try {
      const [x, y, z] = cell
      await rcon(`fill ${x - 6} ${y - 3} ${z - 6} ${x + 7} ${y + 2} ${z + 7} air replace water`)
    } catch (_) { /* best-effort: spread drains, next leg re-places */ }
  }
  const ctx = {
    home: { site: { x: cx, y: surf, z: cz }, built: true, table: { x: tx, y: surf, z: cz }, chest: { x: hx, y: surf, z: cz } },
    stepStatus: 'running',
    lastGoalKey: '',
  }

  async function seedStock(spec) {
    for (const [name, n] of spec) await rcon(`give ${NAME} ${name} ${n}`)
    for (let i = 0; i < 100; i++) {
      await sleep(100)
      if (spec.every(([name, n]) => count(bot, name) >= n)) return
    }
    throw new Error(`setup invalid: stock never synced (${JSON.stringify(spec)})`)
  }

  async function tickUntil(words, cap, check) {
    for (let t = 0; t < (cap || CAP_TICKS); t++) {
      ctx.stepStatus = 'running'
      try {
        gear(bot, ctx)
      } catch (err) {
        throw new Error(`${words} tick threw: ${err && err.message}`)
      }
      if (check()) return t + 1
      await sleep(TICK_MS)
    }
    throw new Error(`${words} never satisfied in cap`)
  }

  async function bankUntilDone(words) {
    for (let t = 0; t < CAP_TICKS; t++) {
      ctx.stepStatus = 'running'
      try {
        stockpile(bot, ctx, null, {})
      } catch (err) {
        throw new Error(`${words} tick threw: ${err && err.message}`)
      }
      if (ctx.stepStatus === 'done' && !ctx.stockpileInFlight) {
        await sleep(500) // the async window op may still land
        if (ctx.stepStatus === 'done' && !ctx.stockpileInFlight) return t + 1
      }
      await sleep(TICK_MS)
    }
    throw new Error(`${words} never banked in cap`)
  }

  async function chestIds() {
    // Per-slot queries: a whole-Items dump truncates over RCON. Slots 0-9
    // hold the tools, buckets, and owner armour by the final leg.
    const ids = []
    for (let slot = 0; slot < 10; slot++) {
      const out = await execFileAsync('docker', ['exec', MC_CONTAINER, 'rcon-cli', `data get block ${hx} ${surf} ${cz} Items[${slot}].id`])
      ids.push(String((out && out.stdout) || ''))
    }
    return ids.join('\n')
  }

  // Leg 1: stone kit + pick stock -> self iron pickaxe in the pack.
  await rcon(`clear ${NAME}`)
  await seedStock([['stone_pickaxe', 1], ['stone_sword', 1], ['iron_ingot', 3], ['stick', 2]])
  const leg1 = await tickUntil('leg 1', 0, () => count(bot, 'iron_pickaxe') >= 1)
  console.log(`leg 1 PASS: iron_pickaxe in ${leg1} ticks (stone kit kept: pick=${count(bot, 'stone_pickaxe')} sword=${count(bot, 'stone_sword')})`)

  // Leg 2 (jsf.5): bucket stock x2 -> empties crafted silently, then filled
  // at the RCON water -> the reserve pair in pack, no haul (self forge).
  // Generous cap (ipn.6): on prod-world terrain the bot walks real hills to
  // the water, not a flat pad — the flat-tuned 150 risks a timeout fail.
  const w2 = await placeWater()
  await seedStock([['iron_ingot', 6]])
  const leg2 = await tickUntil('leg 2', 500, () => count(bot, 'water_bucket') >= 2)
  await removeWater(w2)
  if (count(bot, 'bucket') !== 0) throw new Error('leg 2: empties must be filled, not left behind')
  if (ctx.haul && ctx.haul.water_bucket) throw new Error('leg 2: self forge must not haul')
  console.log(`leg 2 PASS: reserve pair in ${leg2} ticks (silent self forge)`)

  // Leg 3: sword stock -> forged, then banked via the real stockpile step.
  await seedStock([['iron_ingot', 2], ['stick', 1]])
  const leg3 = await tickUntil('leg 3', 0, () => (ctx.haul && ctx.haul.iron_sword) === 1 && (ctx.gearFinished && ctx.gearFinished.iron_sword) === 1)
  console.log(`leg 3 PASS: iron_sword hauled+recorded in ${leg3} ticks`)
  const bank3 = await bankUntilDone('leg 3 bank')
  await sleep(1000) // ledger settles after the window closes
  if (count(bot, 'iron_sword') !== 0) throw new Error('leg 3 bank: sword must leave the pack')
  if ((ctx.gearGiven && ctx.gearGiven.iron_sword) !== 1) throw new Error('leg 3 bank: sword never marked given')
  if ((ctx.haul && ctx.haul.iron_sword) !== 0) throw new Error('leg 3 bank: sword haul claim not cleared')
  if (!(await chestIds()).includes('iron_sword')) throw new Error('leg 3 bank: chest NBT missing the sword')
  console.log(`leg 3 bank PASS in ${bank3} ticks: sword in chest, given, haul cleared`)

  // Leg 4: pick stock -> forged (self twin already held), then banked with
  // the twin surviving. Proves the round-2 double-spend fix live.
  await seedStock([['iron_ingot', 3], ['stick', 2]])
  const leg4 = await tickUntil('leg 4', 0, () => (ctx.haul && ctx.haul.iron_pickaxe) === 1 && (ctx.gearFinished && ctx.gearFinished.iron_pickaxe) === 1)
  if (count(bot, 'iron_pickaxe') !== 2) throw new Error(`leg 4: self+owner picks expected, have ${count(bot, 'iron_pickaxe')}`)
  console.log(`leg 4 PASS: owner iron_pickaxe hauled+recorded in ${leg4} ticks (pack holds 2)`)
  const bank4 = await bankUntilDone('leg 4 bank')
  await sleep(1000)
  if (count(bot, 'iron_pickaxe') !== 1) throw new Error(`leg 4 bank: self pick must survive, pack holds ${count(bot, 'iron_pickaxe')}`)
  if ((ctx.gearGiven && ctx.gearGiven.iron_pickaxe) !== 1) throw new Error('leg 4 bank: pick never marked given')
  if ((ctx.haul && ctx.haul.iron_pickaxe) !== 0) throw new Error('leg 4 bank: pick haul claim not cleared')

  // Leg 5 (jsf.5): two owner buckets, one at a time: craft, fill at the
  // RCON water, bank. The reserve pair survives, given reaches 2, and
  // the ladder advances to diamond.
  for (let unit = 1; unit <= 2; unit++) {
    const w5 = await placeWater()
    await seedStock([['iron_ingot', 3]])
    const leg = await tickUntil(`leg 5.${unit}`, 400, () => (ctx.haul && ctx.haul.water_bucket) === 1 && (ctx.gearFinished && ctx.gearFinished.water_bucket) === 1)
    await removeWater(w5)
    if (count(bot, 'water_bucket') !== 3) throw new Error(`leg 5.${unit}: pair+spare expected, have ${count(bot, 'water_bucket')}`)
    console.log(`leg 5.${unit} PASS: owner water_bucket hauled+recorded in ${leg} ticks (pack holds 3)`)
    const bank = await bankUntilDone(`leg 5.${unit} bank`)
    await sleep(1000)
    if (count(bot, 'water_bucket') !== 2) throw new Error(`leg 5.${unit} bank: reserve pair must survive, pack holds ${count(bot, 'water_bucket')}`)
    if ((ctx.gearGiven && ctx.gearGiven.water_bucket) !== unit) throw new Error(`leg 5.${unit} bank: given water_bucket reads ${ctx.gearGiven && ctx.gearGiven.water_bucket}, want ${unit}`)
    if ((ctx.haul && ctx.haul.water_bucket) !== 0) throw new Error(`leg 5.${unit} bank: haul claim not cleared`)
    console.log(`leg 5.${unit} bank PASS in ${bank} ticks: spare in chest, given ${unit}, haul cleared`)
  }
  if (gear.deriveNext(bot, ctx).name !== 'iron_helmet') throw new Error('leg 5 bank: ladder did not advance to self armour')
  const nbt = await chestIds()
  if (!nbt.includes('iron_pickaxe') || !nbt.includes('iron_sword') || !nbt.includes('water_bucket')) throw new Error(`leg 5 bank: chest NBT missing pieces: ${nbt.slice(0, 200)}`)
  console.log(`leg 5 bank PASS: pair survives, ledger settled, haul cleared, chest holds sword+pick+buckets, ladder on self armour`)

  // Leg 6 (ipn.6 pantry): bank 20 ingots through the real stockpile step
  // (the run's first iron bank — the pantry signal fires), then the self
  // helmet rung withdraws 5, crafts, and wears the helmet.
  await seedStock([['iron_ingot', 20]])
  const bank6 = await bankUntilDone('leg 6 bank')
  await sleep(1000)
  if (count(bot, 'iron_ingot') !== 0) throw new Error('leg 6 bank: ingots must leave the pack')
  if ((ctx.gearPantryBanked || 0) < 1) throw new Error('leg 6 bank: pantry signal never fired')
  const leg6 = await tickUntil('leg 6', 0, () => worn(bot, 'iron_helmet') >= 1)
  if (ctx.haul && ctx.haul.iron_helmet) throw new Error('leg 6: self forge must not haul')
  if (worn(bot, 'iron_helmet') !== 1 || count(bot, 'iron_helmet') !== 0) throw new Error('leg 6: helmet must be worn, not packed')
  console.log(`leg 6 PASS: 20 banked in ${bank6}t, 5 withdrawn, helmet worn in ${leg6}t (silent self forge)`)

  // Leg 7 (ipn.6 self set): the rest of the set forges and goes on the body.
  await seedStock([['iron_ingot', 19]])
  const leg7 = await tickUntil('leg 7', 0, () => worn(bot, 'iron_chestplate') >= 1 && worn(bot, 'iron_leggings') >= 1 && worn(bot, 'iron_boots') >= 1)
  if (count(bot, 'iron_chestplate') + count(bot, 'iron_leggings') + count(bot, 'iron_boots') !== 0) throw new Error('leg 7: set must be worn, not packed')
  console.log(`leg 7 PASS: chestplate+leggings+boots worn in ${leg7}t`)

  // Leg 8 (ipn.6 owner armour): each spare forges, banks, and reads given;
  // the worn set is untouched throughout.
  for (const [piece, mats] of [['iron_helmet', 5], ['iron_chestplate', 8], ['iron_leggings', 7], ['iron_boots', 4]]) {
    await seedStock([['iron_ingot', mats]])
    const leg = await tickUntil(`leg 8 ${piece}`, 0, () => (ctx.haul && ctx.haul[piece]) === 1 && (ctx.gearFinished && ctx.gearFinished[piece]) === 1)
    if (count(bot, piece) !== 1) throw new Error(`leg 8 ${piece}: spare must sit in the pack, have ${count(bot, piece)}`)
    console.log(`leg 8 ${piece} PASS: hauled+recorded in ${leg}t`)
    const bank = await bankUntilDone(`leg 8 ${piece} bank`)
    await sleep(1000)
    if (count(bot, piece) !== 0) throw new Error(`leg 8 ${piece} bank: spare must leave the pack`)
    if ((ctx.gearGiven && ctx.gearGiven[piece]) !== 1) throw new Error(`leg 8 ${piece} bank: never marked given`)
    if ((ctx.haul && ctx.haul[piece]) !== 0) throw new Error(`leg 8 ${piece} bank: haul claim not cleared`)
    console.log(`leg 8 ${piece} bank PASS in ${bank}t: spare in chest, given, haul cleared`)
  }
  for (const piece of ['iron_helmet', 'iron_chestplate', 'iron_leggings', 'iron_boots']) {
    if (worn(bot, piece) !== 1) throw new Error(`leg 8 bank: worn ${piece} disturbed by the handover`)
  }
  if (gear.deriveNext(bot, ctx).name !== 'diamond_pickaxe') throw new Error('leg 8 bank: ladder did not advance to diamond')
  const nbt8 = await chestIds()
  for (const piece of ['iron_helmet', 'iron_chestplate', 'iron_leggings', 'iron_boots']) {
    if (!nbt8.includes(piece)) throw new Error(`leg 8 bank: chest NBT missing ${piece}: ${nbt8.slice(0, 300)}`)
  }
  console.log('leg 8 bank PASS: worn set untouched, spares in chest, ladder on diamond')

  // Leg 9 (ipn.6 diamond crossing): self pick, owner sword+pick, self helmet.
  await seedStock([['diamond', 3], ['stick', 2]])
  const leg9a = await tickUntil('leg 9 self pick', 0, () => count(bot, 'diamond_pickaxe') >= 1)
  console.log(`leg 9a PASS: diamond_pickaxe in ${leg9a}t`)
  await seedStock([['diamond', 2], ['stick', 1]])
  const leg9b = await tickUntil('leg 9 sword', 0, () => (ctx.haul && ctx.haul.diamond_sword) === 1)
  const bank9b = await bankUntilDone('leg 9 sword bank')
  await sleep(1000)
  if ((ctx.gearGiven && ctx.gearGiven.diamond_sword) !== 1) throw new Error('leg 9 sword bank: never marked given')
  console.log(`leg 9b PASS: diamond_sword forged in ${leg9b}t, banked in ${bank9b}t`)
  await seedStock([['diamond', 3], ['stick', 2]])
  const leg9c = await tickUntil('leg 9 owner pick', 0, () => (ctx.haul && ctx.haul.diamond_pickaxe) === 1)
  const bank9c = await bankUntilDone('leg 9 owner pick bank')
  await sleep(1000)
  if ((ctx.gearGiven && ctx.gearGiven.diamond_pickaxe) !== 1) throw new Error('leg 9 owner pick bank: never marked given')
  if (count(bot, 'diamond_pickaxe') !== 1) throw new Error('leg 9 owner pick bank: self pick must survive')
  console.log(`leg 9c PASS: owner diamond_pickaxe forged in ${leg9c}t, banked in ${bank9c}t, twin survives`)
  await seedStock([['diamond', 5]])
  const leg9d = await tickUntil('leg 9 diamond helm', 0, () => worn(bot, 'diamond_helmet') >= 1)
  if (worn(bot, 'iron_helmet') !== 0 || count(bot, 'iron_helmet') < 1) throw new Error('leg 9 helm: old iron must swap to the pack')
  console.log(`leg 9d PASS: diamond_helmet worn in ${leg9d}t, iron swapped down`)
  console.log(`GEAR E2E PASS: self pick ${leg1}t, self pair ${leg2}t, sword ${leg3}t+bank, owner pick ${leg4}t+bank, owner buckets 2x+bank, pantry+helm ${leg6}t, set ${leg7}t, owner armour 4x+bank, diamond crossing`)
  bot.quit()
  process.exit(0)
}

main().catch((err) => {
  console.error(`GEAR E2E FAIL: ${err && err.message ? err.message : err}`)
  process.exit(1)
})
