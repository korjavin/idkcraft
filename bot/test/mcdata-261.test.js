const { describe, it } = require('node:test')
const assert = require('node:assert')

// idkcraft-der: the bot must run on minecraft-data that knows the real 26.1
// wire format (protocol 775, Paper 26.1.2). 3.116.0 shipped a stale
// packet_entity_teleport shape (no dx/dy/dz, i8 yaw/pitch, no relatives
// flags), so every server entity teleport was misparsed — the suspected
// common root of the wall-freeze / hover-arrest stuck family.
describe('minecraft-data 26.1 (idkcraft-der)', () => {
  it('is at least 3.117.0', () => {
    const { version } = require('minecraft-data/package.json')
    const [maj, min, patch] = String(version).split('.').map(Number)
    const ok = maj > 3 || (maj === 3 && (min > 117 || (min === 117 && patch >= 0)))
    assert.ok(ok, `minecraft-data ${version} < 3.117.0`)
  })

  it('resolves 26.1 at protocol 775', () => {
    const mcData = require('minecraft-data')('26.1')
    assert.ok(mcData, 'no data for 26.1')
    assert.equal(mcData.version.version, 775)
    assert.equal(mcData.version.minecraftVersion, '26.1')
  })

  it('has the 26.1 entity_teleport wire shape (dx/dy/dz + flags)', () => {
    const mcData = require('minecraft-data')('26.1')
    const pkt = mcData.protocol.play.toClient.types.packet_entity_teleport
    const fields = pkt[1].map((f) => f.name)
    for (const f of ['dx', 'dy', 'dz', 'flags', 'onGround']) {
      assert.ok(fields.includes(f), `26.1 teleport missing ${f} (got ${fields.join(',')})`)
    }
    assert.equal(pkt[1].find((f) => f.name === 'yaw').type, 'f32')
  })

  it('prismarine-registry builds for the 775 server version', () => {
    const registry = require('prismarine-registry')('26.1')
    assert.ok(registry.version, 'no registry version for 26.1')
    assert.equal(registry.version.version, 775)
  })
})
