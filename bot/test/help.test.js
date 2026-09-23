'use strict'

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { handleChat } = require('../src/index')
const { COMMANDS, CHAT_LIMIT, lookupCommand, detailLine, helpReply } = require('../src/commands')

function chatBot() {
  return {
    username: 'IdkBot',
    players: { Steve: { username: 'Steve', entity: { position: { x: 0, y: 64, z: 0 } } } },
    chats: [],
    chat(m) { this.chats.push(String(m)) },
  }
}

describe("help command (idkcraft-kae)", () => {
  it("'help' fits one line of <= 256 chars and names every command", () => {
    const bot = chatBot()
    handleChat(bot, null, 'Steve', 'help')
    assert.equal(bot.chats.length, 1)
    assert.ok(bot.chats[0].length <= CHAT_LIMIT, `help is ${bot.chats[0].length} chars`)
    for (const cmd of COMMANDS) {
      for (const n of cmd.names) assert.ok(bot.chats[0].includes(n), `help lists ${n}`)
    }
    assert.ok(bot.chats[0].includes('help <command>'))
  })

  it("'help find me' explains find me; aliases resolve", () => {
    const bot = chatBot()
    handleChat(bot, null, 'Steve', 'help find me')
    assert.equal(bot.chats.length, 1)
    assert.ok(bot.chats[0].includes('find me <block>'))
    assert.ok(bot.chats[0].includes('find me iron'))
    const alias = chatBot()
    handleChat(alias, null, 'Steve', 'help free')
    assert.ok(alias.chats[0].startsWith('go work:'), `alias resolves: ${alias.chats[0]}`)
  })

  it("'help <unknown>' points at help instead of staying silent", () => {
    const bot = chatBot()
    handleChat(bot, null, 'Steve', 'help bring')
    assert.equal(bot.chats.length, 1)
    assert.ok(bot.chats[0].includes('unknown command'))
    assert.ok(bot.chats[0].includes('say help'))
  })

  it("bare 'find me' hints usage instead of staying silent", () => {
    const bot = chatBot()
    handleChat(bot, null, 'Steve', 'find me')
    assert.deepEqual(bot.chats, ['try: find me iron'])
  })

  it('unrelated chatter stays silent', () => {
    const bot = chatBot()
    handleChat(bot, null, 'Steve', 'hello bot')
    assert.deepEqual(bot.chats, [])
  })

  it('every help reply fits the 256-char chat limit', () => {
    assert.ok(helpReply(1).length <= CHAT_LIMIT)
    for (const cmd of COMMANDS) {
      const line = detailLine(cmd)
      assert.ok(line.length <= CHAT_LIMIT, `${cmd.names[0]} detail is ${line.length} chars`)
    }
  })

  it('every command handleChat understands is in COMMANDS', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.js'), 'utf8')
    const literals = [...src.matchAll(/msg === '([^']+)'/g)].map((m) => m[1])
    const heads = [...src.matchAll(/msg\.match\(\/\^([a-z ]+?)\\/g)]
      .map((m) => (m[1] || '').trim())
      .filter(Boolean)
    assert.ok(literals.length > 0, 'scanner found exact-match commands')
    const names = COMMANDS.flatMap((c) => c.names)
    for (const lit of literals) {
      assert.ok(names.includes(lit), `COMMANDS covers handleChat literal '${lit}'`)
    }
    for (const head of heads) {
      assert.ok(names.includes(head), `COMMANDS covers handleChat pattern head '${head}'`)
    }
    assert.ok(lookupCommand('bring') === null, 'no phantom bring entry')
  })
})
