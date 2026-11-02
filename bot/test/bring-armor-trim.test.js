'use strict'

// idkcraft-3dkc: Find and bring armor trim on request.
// Tests name resolution, chest lookup/scanning, structure hints, inventory handover, and find me leading.

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const mcData = require('minecraft-data')('1.21.4')
const bring = require('../src/behaviours/bring')
const bringItem = require('../src/behaviours/bringitem')
const { resolveFindIds, resolveIds } = require('../src/blockids')
const { createTicker, handleChat } = require('../src/index')

function mockBot(extra = {}) {
  const b = {
    registry: mcData,
    inventory: {
      items: () => extra.items || [],
    },
    entity: {
      position: { x: 0, y: 64, z: 0, distanceTo: (p) => Math.hypot(p.x, p.y - 64, p.z) },
    },
    pathfinder: {
      setGoal: () => {},
      isMoving: () => false,
      stop: () => {},
    },
    chat: (msg) => { (b.chats = b.chats || []).push(msg) },
    openChest: async (block) => {
      const key = `${block.position.x},${block.position.y},${block.position.z}`
      const contents = (extra.chests && extra.chests[key]) || []
      return {
        containerItems: () => contents.map((c) => ({
          name: c.name,
          type: mcData.itemsByName[c.name]?.id || 1,
          count: c.count,
          metadata: 0,
        })),
        withdraw: async (type, meta, count) => {
          const item = contents.find((c) => mcData.itemsByName[c.name]?.id === type)
          if (item) {
            const got = Math.min(item.count, count)
            item.count -= got
            const held = (extra.items = extra.items || [])
            const existing = held.find((i) => i.name === item.name)
            if (existing) existing.count += got
            else held.push({ name: item.name, count: got })
          }
        },
        close: () => {},
      }
    },
    findBlocks: (query) => {
      if (extra.blocks) {
        return extra.blocks.filter((b) => query.matching.includes(b.id)).map((b) => b.pos)
      }
      return []
    },
    blockAt: (pos) => {
      const key = `${pos.x},${pos.y},${pos.z}`
      if (extra.chests && extra.chests[key]) {
        return { name: 'chest', position: pos }
      }
      return { name: 'air', position: pos }
    },
    ...extra,
  }
  return b
}

describe('armor trim resolution and structure hints (idkcraft-3dkc)', () => {
  it('resolves generic armor trim aliases to all 18 smithing templates', () => {
    const bot = mockBot()
    for (const term of ['armor_trim', 'armor_trims', 'trim', 'trims', 'armor_trim_smithing_template']) {
      const res = bringItem.resolveItem(bot, term)
      assert.ok(res, `resolved ${term}`)
      assert.equal(res.family, 'armor_trim')
      assert.equal(res.isTrim, true)
      assert.equal(res.names.length, 18)
      assert.ok(res.names.includes('sentry_armor_trim_smithing_template'))
      assert.ok(res.names.includes('coast_armor_trim_smithing_template'))
      assert.ok(res.names.includes('wild_armor_trim_smithing_template'))
      assert.ok(res.names.includes('dune_armor_trim_smithing_template'))
      assert.ok(res.names.includes('spire_armor_trim_smithing_template'))
    }
  })

  it('resolves specific armor trim names and aliases', () => {
    const bot = mockBot()
    const cases = [
      ['sentry_armor_trim', 'sentry_armor_trim_smithing_template', 'sentry'],
      ['sentry_trim', 'sentry_armor_trim_smithing_template', 'sentry'],
      ['coast_armor_trim', 'coast_armor_trim_smithing_template', 'coast'],
      ['coast_trim', 'coast_armor_trim_smithing_template', 'coast'],
      ['wild_armor_trim', 'wild_armor_trim_smithing_template', 'wild'],
      ['wild_trim', 'wild_armor_trim_smithing_template', 'wild'],
      ['eye_trim', 'eye_armor_trim_smithing_template', 'eye'],
      ['snout_trim', 'snout_armor_trim_smithing_template', 'snout'],
      ['spire_trim', 'spire_armor_trim_smithing_template', 'spire'],
      ['rib_trim', 'rib_armor_trim_smithing_template', 'rib'],
      ['ward_trim', 'ward_armor_trim_smithing_template', 'ward'],
      ['silence_trim', 'silence_armor_trim_smithing_template', 'silence'],
      ['bolt_trim', 'bolt_armor_trim_smithing_template', 'bolt'],
      ['flow_trim', 'flow_armor_trim_smithing_template', 'flow'],
    ]
    for (const [query, expectedItem, expectedType] of cases) {
      const res = bringItem.resolveItem(bot, query)
      assert.ok(res, `resolved ${query}`)
      assert.equal(res.isTrim, true)
      assert.equal(res.trimType, expectedType)
      assert.deepEqual(res.names, [expectedItem])
    }
  })

  it('provides vanilla structure hints on refusal when trims are not in chests', () => {
    const bot = mockBot()
    assert.equal(
      bringItem.itemRefusal(bot, 'sentry_armor_trim', { isTrim: true, trimType: 'sentry' }),
      'no sentry_armor_trim in chests (found in pillager outposts)'
    )
    assert.equal(
      bringItem.itemRefusal(bot, 'coast_armor_trim', { isTrim: true, trimType: 'coast' }),
      'no coast_armor_trim in chests (found in shipwrecks)'
    )
    assert.equal(
      bringItem.itemRefusal(bot, 'dune_armor_trim', { isTrim: true, trimType: 'dune' }),
      'no dune_armor_trim in chests (found in desert pyramids)'
    )
    assert.equal(
      bringItem.itemRefusal(bot, 'armor_trim', { isTrim: true }),
      'no armor trim in chests (found in structure chests like outposts, pyramids, ruins)'
    )
  })

  it('resolveFindIds maps armor trim queries to container blocks', () => {
    const bot = mockBot()
    const containerIds = resolveIds(bot, ['chest', 'trapped_chest', 'barrel'])
    for (const term of ['armor_trim', 'trim', 'sentry_armor_trim', 'coast_trim']) {
      const ids = resolveFindIds(bot, term)
      assert.deepEqual(ids, containerIds, `resolveFindIds for ${term}`)
    }
  })

  it('netherite_upgrade_smithing_template is not treated as an armor trim', () => {
    const bot = mockBot()
    const trimRes = bringItem.resolveArmorTrim(bot.registry.itemsByName, 'netherite_upgrade_smithing_template')
    assert.equal(trimRes, null)
    const itemRes = bringItem.resolveItem(bot, 'netherite_upgrade_smithing_template')
    assert.ok(itemRes)
    assert.equal(itemRes.isTrim, undefined)
  })
})

describe('bring me armor trim behavior', () => {
  it('brings immediately from pack if the bot already holds the requested trim', () => {
    const bot = mockBot({
      items: [{ name: 'sentry_armor_trim_smithing_template', count: 1 }],
    })
    const ticker = createTicker({ bot })
    const reply = ticker.setBring({ name: 'sentry_armor_trim', want: 1, by: 'Player' })
    assert.equal(reply, 'coming with 1 sentry_armor_trim_smithing_template')
    assert.equal(bot._tickerCtx.bring.phase, 'return')
    assert.equal(bot._tickerCtx.bring.have, 1)
  })

  it('brings generic armor trim from pack if holding any trim template', () => {
    const bot = mockBot({
      items: [{ name: 'wild_armor_trim_smithing_template', count: 1 }],
    })
    const ticker = createTicker({ bot })
    const reply = ticker.setBring({ name: 'armor_trim', want: 1, by: 'Player' })
    assert.equal(reply, 'coming with 1 wild_armor_trim_smithing_template')
    assert.equal(bot._tickerCtx.bring.phase, 'return')
  })

  it('checks home chest and withdraws armor trim when present', async () => {
    const homeChestPos = { x: 5, y: 64, z: 5 }
    const bot = mockBot({
      items: [],
      chests: {
        '5,64,5': [{ name: 'coast_armor_trim_smithing_template', count: 1 }],
      },
    })
    const ticker = createTicker({ bot })
    const ctx = bot._tickerCtx
    ctx.home = { chest: homeChestPos }
    ctx.stockpile = {}
    const reply = ticker.setBring({ name: 'coast_armor_trim', want: 1, by: 'Player' })
    assert.equal(reply, 'checking the home chest for coast_armor_trim')
    assert.equal(ctx.bring.phase, 'chestfetch')

    // Simulate arriving at the chest and running fetchItem
    await bringItem.fetchItem(bot, ctx, ctx.bring, homeChestPos)

    assert.equal(ctx.bring.phase, 'return')
    assert.equal(ctx.bring.have, 1)
    assert.equal(ctx.bring.items[0].name, 'coast_armor_trim_smithing_template')
  })

  it('scans loaded area for chests and visits sighted chest for trim', async () => {
    const sightedChestPos = { x: 10, y: 64, z: 10 }
    const chestId = mcData.blocksByName.chest.id
    const bot = mockBot({
      items: [],
      chests: {
        '10,64,10': [{ name: 'sentry_armor_trim_smithing_template', count: 1 }],
      },
      blocks: [
        { id: chestId, pos: sightedChestPos },
      ],
    })
    const ticker = createTicker({ bot })
    const ctx = bot._tickerCtx
    ctx.home = null
    ctx.stockpile = {}
    const reply = ticker.setBring({ name: 'armor_trim', want: 1, by: 'Player' })
    assert.equal(reply, 'checking chests for armor_trim')
    assert.equal(ctx.bring.phase, 'chestfetch')

    // pickChest scans and picks the sighted chest
    const target = bring.pickChest(bot, ctx, ctx.bring)
    assert.ok(target, 'chest target found')
    assert.equal(target.pos.x, 10)

    // Fetch from sighted chest
    await bringItem.fetchItem(bot, ctx, ctx.bring, target.pos)
    assert.equal(ctx.bring.phase, 'return')
    assert.equal(ctx.bring.have, 1)
    assert.equal(ctx.bring.items[0].name, 'sentry_armor_trim_smithing_template')
  })

  it('scans loaded area when home chest does not have the trim', async () => {
    const homeChestPos = { x: 5, y: 64, z: 5 }
    const sightedChestPos = { x: 15, y: 64, z: 15 }
    const chestId = mcData.blocksByName.chest.id
    const bot = mockBot({
      items: [],
      chests: {
        '5,64,5': [{ name: 'cobblestone', count: 64 }],
        '15,64,15': [{ name: 'bolt_armor_trim_smithing_template', count: 1 }],
      },
      blocks: [
        { id: chestId, pos: sightedChestPos },
      ],
    })
    const ticker = createTicker({ bot })
    const ctx = bot._tickerCtx
    ctx.home = { chest: homeChestPos }
    ctx.stockpile = {}
    const reply = ticker.setBring({ name: 'bolt_trim', want: 1, by: 'Player' })
    assert.equal(reply, 'checking the home chest for bolt_armor_trim')
    assert.equal(ctx.bring.phase, 'chestfetch')

    // Arrive at home chest (which has no trim)
    await bringItem.fetchItem(bot, ctx, ctx.bring, homeChestPos)

    // fetchItem should scan loaded area, find the sighted chest, and queue next chestfetch
    assert.equal(ctx.bring.phase, 'chestfetch')
    assert.equal(ctx.bring.chestScanned, true)

    // Next chest target should be the sighted chest
    const nextTarget = bring.pickChest(bot, ctx, ctx.bring)
    assert.ok(nextTarget)
    assert.equal(nextTarget.pos.x, 15)

    // Fetch from sighted chest
    await bringItem.fetchItem(bot, ctx, ctx.bring, nextTarget.pos)
    assert.equal(ctx.bring.phase, 'return')
    assert.equal(ctx.bring.have, 1)
    assert.equal(ctx.bring.items[0].name, 'bolt_armor_trim_smithing_template')
  })

  it('refuses with structure hint when chests have been checked and none hold trim', async () => {
    const homeChestPos = { x: 5, y: 64, z: 5 }
    const bot = mockBot({
      items: [],
      chests: {
        '5,64,5': [{ name: 'cobblestone', count: 64 }],
      },
    })
    const ticker = createTicker({ bot })
    const ctx = bot._tickerCtx
    ctx.home = { chest: homeChestPos }
    ctx.stockpile = {}
    ticker.setBring({ name: 'sentry_armor_trim', want: 1, by: 'Player' })

    // Fetch from empty chest
    await bringItem.fetchItem(bot, ctx, ctx.bring, homeChestPos)

    // With all chests exhausted, enterCraftOrRefuse refuses with hint
    assert.ok(bot.chats.some((c) => c.includes('no sentry_armor_trim in chests (found in pillager outposts)')))
    assert.equal(ctx.bring, null, 'order ended after refusal')
  })

  it('find me armor trim brings from pack if bot already has one', () => {
    const bot = mockBot({
      items: [{ name: 'sentry_armor_trim_smithing_template', count: 1 }],
      players: {
        Player: { entity: { position: { x: 0, y: 64, z: 0 } } },
      },
    })
    const ticker = createTicker({ bot })
    handleChat(bot, ticker, 'Player', 'find me armor trim')
    assert.ok(bot.chats.some((c) => c.includes('i have sentry_armor_trim_smithing_template in my pack, bringing it to you!')))
    assert.equal(bot._tickerCtx.bring.phase, 'return')
  })

  it('find me armor trim leads to nearest chest when not in pack', () => {
    const chestId = mcData.blocksByName.chest.id
    const bot = mockBot({
      items: [],
      players: {
        Player: { entity: { position: { x: 0, y: 64, z: 0 } } },
      },
      findBlocks: (query) => {
        if (query.matching.includes(chestId)) return [{ x: 12, y: 64, z: 0 }]
        return []
      },
      blockAt: (p) => {
        if (p.x === 12 && p.y === 64 && p.z === 0) return { name: 'chest', position: p }
        return { name: 'air', position: p }
      },
    })
    const ticker = createTicker({ bot })
    handleChat(bot, ticker, 'Player', 'find me armor trim')
    assert.ok(bot.chats.some((c) => c.includes('leading you to chest, 12 blocks, follow me')))
    assert.ok(bot._tickerCtx.lead)
    assert.equal(bot._tickerCtx.lead.name, 'chest')
  })
})
