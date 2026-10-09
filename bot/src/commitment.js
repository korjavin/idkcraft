'use strict'

// decide() (goal.js) ends a commit window through task.commitFinished
// without requiring task.js (idkcraft-oqul.5). task.js registers it at
// load; a module-level slot, not a ctx.task callback (resetTask/taskTick
// rebuild ctx.task). ponytail: unregistered = no-op — only task.js ever
// creates ctx.goal.commit, so a loaded commit implies a registered finish.
let finish = null

function onCommitFinished(fn) { finish = fn }

function commitFinished(bot, ctx, status) {
  if (finish) finish(bot, ctx, status)
}

module.exports = { onCommitFinished, commitFinished }
