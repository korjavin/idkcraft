# Generated skills (idkcraft-vf8e.2)

A skill is one JavaScript file that plugs into the bot exactly like a hand
primitive. Runtime: `bot/src/skills.js`.

- **Promoted** skills live here (`bot/skills/<name>.js`) and ship in the image.
- **Unpromoted** (rig) skills live in `SKILLS_DIR/<name>.js`.
- Nothing loads unless `BOT_SKILLS=1` (`1`|`true`|`yes`, parsed like
  `BOT_AUTONOMOUS`). Off, the loader is never called: `RECOVER_MENU`,
  `RECOVER_ORDER`, `BEHAVIOURS`, the goal `MENU` and `STEP_ORDER` are the
  hand tables, byte for byte.
- Load order: this dir first, then `SKILLS_DIR`. A name that is already taken
  (hand primitive, step, or an earlier skill) is skipped with a log line.

## File format

The first block comment is the header, `skill` followed by a JSON object:

```js
/* skill {"name": "ledge_climb", "description": "climb: in a pit with a 1-high ledge — dig a step and hop it", "kind": "recover", "body": "any", "verb": "climbing the ledge", "verifiedBy": {"scenario": "...", "verdict": "...", "sha": "..."}, "bead": "idkcraft-..."} */

function feasible(facts) {
  return facts.pit && facts.goalDy >= 2
}

function run(bot, st) {
  // one tick: return 'running' | 'done' | 'failed:<reason>'
  return 'done'
}
```

| field | required | meaning |
|---|---|---|
| `name` | yes | `^[a-z][a-z0-9_]{1,39}$`, unique across hand primitives, steps and skills |
| `description` | yes | the menu criterion text: the model reads it in the recover/step menu and in `plan()` |
| `kind` | yes | `recover` (stuck-recovery primitive) or `step` (goal step) |
| `body` | no | `any` (default), `mineflayer` or `baritone`; a skill for the other body is skipped at load |
| `verb` | no | chat verb (`stuck, trying <verb>` / `next: <verb>`); default: the name with spaces |
| `verifiedBy`, `bead` | no | provenance; promotion (vf8e.4) fills them |

No `require`, no `module.exports`: the file is a plain script that defines two
top-level functions.

- `feasible(facts)` sees only the facts (recover: `recoverFacts`, step:
  `goalFacts`), as JSON. It has no facade. Keep it narrow: it is the only gate.
- `run(bot, st)` runs once per tick. `bot` is the facade below; `st` is a
  per-episode object (recover: one stuck episode, step: one step instance)
  that persists between ticks.

## Where it plugs in

- **recover**: appended after the hand entries in `RECOVER_ORDER`, with
  `RECOVER_MENU[name]` and `RECOVER_CRITERIA[name] = description`. The model
  menu, `plan()` criteria and the FSM see it. The FSM picks a feasible skill
  after every hand escape and before the generic fallbacks (`dig_through`,
  `call_player`, `wait`). A skill that fails for any reason is banned for
  the rest of the episode.
- **step**: `MENU[name]`, inserted before `rest` in `STEP_ORDER`,
  `STEP_CRITERIA[name] = description`, plus `BEHAVIOURS[name]`, so
  `goal.registered()` admits it. It finishes through `step.js`
  (`stepDone`/`stepFailed`).

## Sandbox and limits

Each skill runs in its own `node:vm` context: no `require`, `process`, timers
or `console`. `eval` and `new Function` are off. Only JSON crosses the
boundary.

- **Per call:** 50 ms (`feasible` or one `run` tick). Past that the outcome
  is `failed:skill-timeout`.
- **Per episode:** a tick budget of 60 for recover and 600 for step. Past it,
  `failed:skill-timeout`.
- **Errors:** any throw, or a return value other than `running`, `done` or
  `failed:[a-z0-9-]{1,40}`, gives `failed:skill-error`.
- **Metric:** `idkcraft_bot_skill_runs_total{skill, outcome}`, with outcome
  `done`|`failed`|`skill-timeout`|`skill-error`.

## Facade (`bot` in `run`)

Read:

- `pos()` returns `{x, y, z, onGround}`.
- `blockAt(x, y, z)` returns `{name, solid, x, y, z}` or `null`.
- `findBlocks(names, maxDistance<=32, count<=64)` returns `[{x, y, z}]`.
- `inventory()` returns `{name: count}`. `count(name)` returns a number.
- `health()`, `food()`, `time()` (timeOfDay).
- `entities(radius<=32)` returns `[{name, type, username, x, y, z}]`.
- `status()` returns `{busy, err, path, moving}`.

Act. Each async act returns `'started'`, `'busy'` or `'denied:<reason>'`, and
only one runs at a time. Poll `status().busy` and `status().err` on later
ticks.

- `dig(x, y, z)` goes through `util.denyReason`: the protected/foreign-block
  and self-trap rules every hand dig uses.
- `place(x, y, z, item)` places INTO that cell against a solid neighbour. It
  refuses the castle yard ring and apron (`denied:place-protected`) and never
  clicks a GUI block.
- `goto(x, y, z, range=1)` sets a pathfinder `GoalNear` on the live Movements
  after `body.movementsFor`. It never builds a new `Movements`.
- `stop()` clears the goal and the controls.
- `control(name, on)` takes `forward|back|left|right|jump|sprint|sneak`. Jump
  is `control('jump', true)`.
- `lookAt(x, y, z)`.
- `equip(item, 'hand'|'off-hand')`.

There is no toss, drop or chat, so a skill can never drop items or talk. On
a terminal outcome the runtime releases every control.

node:vm is a guard rail for generated code that a person reviews before
promotion. It is not a security boundary against hostile code.
