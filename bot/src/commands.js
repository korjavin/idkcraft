'use strict'

// Single source of truth for chat commands (idkcraft-kae): name/aliases,
// usage, one-line description, example. handleChat (index.js) keeps its
// logic and only wires 'help' plus the 'find me' usage hint to this table,
// so the game reply — not README — is the list to maintain.

// Minecraft chat caps a message at 256 chars: the 'help' overview must fit
// one line, spilling onto 'help 2' etc. only when commands outgrow it.
const CHAT_LIMIT = 256

const COMMANDS = [
  { names: ['follow me'], usage: 'follow me', what: 'locks onto you and follows', example: 'follow me' },
  { names: ['stop'], usage: 'stop', what: 'parks the bot in place until called', example: 'stop' },
  { names: ['lead anyway'], usage: 'lead anyway', what: 'walks to a deep find that was only announced', example: 'lead anyway' },
  { names: ['go work', 'free'], usage: 'go work', what: 'releases the bot to work on its own goal', example: 'go work' },
  { names: ['status'], usage: 'status', what: 'reports mode, goal step and home progress', example: 'status' },
  { names: ['find me'], usage: 'find me <block>', what: 'finds the nearest block within 48 blocks and leads you there', example: 'find me iron' },
  { names: ['help'], usage: 'help [command]', what: 'lists commands, or explains one in detail', example: 'help find me' },
]

// Exact alias match first, then a single prefix match ('help find' -> the
// find me entry). Ambiguous or unknown topics return null.
function lookupCommand(topic) {
  const t = String(topic || '').toLowerCase().trim()
  if (!t) return null
  const exact = COMMANDS.find((c) => c.names.some((n) => n === t))
  if (exact) return exact
  const prefixed = COMMANDS.filter((c) => c.names.some((n) => n.startsWith(t)))
  return prefixed.length === 1 ? prefixed[0] : null
}

function detailLine(cmd) {
  return `${cmd.names[0]}: ${cmd.usage} — ${cmd.what}. Try: ${cmd.example}`
}

// Overview pages: flat alias names packed greedily into CHAT_LIMIT lines.
// Page 1 carries the details pointer (or the 'help 2' pointer when there
// are more pages); later pages are headed 'help N'.
function helpPages() {
  const names = COMMANDS.flatMap((c) => c.names)
  const pages = []
  let cur = []
  let len = 0
  for (const n of names) {
    const add = (cur.length ? 2 : 0) + n.length
    if (cur.length && len + add > CHAT_LIMIT) {
      pages.push(cur)
      cur = []
      len = 0
    }
    cur.push(n)
    len += cur.length === 1 ? n.length : add
  }
  if (cur.length) pages.push(cur)
  return pages.map((p, i) => {
    const head = i === 0 ? '' : `help ${i + 1}: `
    const tail = i < pages.length - 1
      ? ` — say help ${i + 2} for more`
      : ' — say help <command> for details'
    return head + p.join(', ') + tail
  })
}

// 1-based overview page text, or null when the page does not exist.
function helpReply(page) {
  const pages = helpPages()
  if (!Number.isInteger(page) || page < 1 || page > pages.length) return null
  return pages[page - 1]
}

module.exports = { COMMANDS, CHAT_LIMIT, lookupCommand, detailLine, helpPages, helpReply }
