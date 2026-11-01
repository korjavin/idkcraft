const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

test('AGENTS.md matches CLAUDE.md byte-for-byte without symlinks (Portainer GitOps)', () => {
  const root = path.resolve(__dirname, '../..')
  const claudePath = path.join(root, 'CLAUDE.md')
  const agentsPath = path.join(root, 'AGENTS.md')

  assert.ok(fs.existsSync(claudePath), 'CLAUDE.md must exist')
  assert.ok(fs.existsSync(agentsPath), 'AGENTS.md must exist')

  const agentsStat = fs.lstatSync(agentsPath)
  assert.ok(!agentsStat.isSymbolicLink(), 'AGENTS.md must be a regular file, not a symlink (Portainer rejects symlinks)')

  const claudeContent = fs.readFileSync(claudePath, 'utf8')
  const agentsContent = fs.readFileSync(agentsPath, 'utf8')
  assert.equal(agentsContent, claudeContent, 'AGENTS.md must match CLAUDE.md')
})
