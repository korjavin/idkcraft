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
| `before` | no | step only: the hand step this skill goes ahead of in `STEP_ORDER` (default `rest`). Must sit after `shelter`; a higher or unknown name falls back to `rest` with a log line, so the night safety steps (`stay`, `gohome`, `shelter`) always come first |
| `verb` | no | chat verb (`stuck, trying <verb>` / `next: <verb>`); default: the name with spaces |
| `verifiedBy`, `bead` | promoted: yes | provenance `{scenario, verdict, sha, body}` + the promotion bead; `tools/skill-promote.js` fills them and `npm test` fails on a `bot/skills/` file without them |

## Promotion and prod switches (vf8e.4)

- A skill gets here only through `node tools/skill-promote.js <bead> <work-dir>/skills/<name>.js...`
  (manual: `bot/tools/README.md`): micro-rig verdict, full stuck-run and the v2 component gates
  in a generated PR labelled `generated-skill`, reviewed like a hand movement PR.
- Prod: `BOT_SKILLS=1` on `bot`, `BOT2_SKILLS=1` on `bot2` (compose maps it to its `BOT_SKILLS`).
- Chat `skills` reports `on n=<k>` (`banned=<names>` once any is), `skills off` takes every
  skill off both menus until restart.
- Auto-ban: a skill that ends non-done (`failed:*`, `skill-timeout`, `skill-error`) 3 times in
  one process is off the menus until restart, logged `skill <name> banned fails=3 last=<outcome>`.
- Rollback = flag off.

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
  the rest of the episode. It also joins the cross-episode spot bans like a
  hand shuffle (`RECOVER_BANNABLE` + `RECOVER_SHUFFLE`): 3 same-spot fails,
  or 3 flat dones while boxed in, take it off the menu at that spot.
- **step**: `MENU[name]`, inserted before `rest` (or the header's `before`) in `STEP_ORDER`, which the FSM walks in priority order,
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
- `use(x, y, z)` uses the held bucket on that cell (look at its centre,
  then the server's use-item raycast): a held `water_bucket` pours, a held
  `bucket` scoops a water source. `place()` cannot pour. It refuses any other
  held item (`denied:not-a-bucket`), a cell farther than 4.5 from the eyes
  (`denied:out-of-reach`) and the castle yard ring/apron
  (`denied:use-protected`). `equip` the bucket first.
- `goto(x, y, z, range=1)` sets a pathfinder `GoalNear` on the live Movements
  after `body.movementsFor`. It never builds a new `Movements`. The goal is
  issued under a `skill:` goal key. It is idempotent: the same target with a
  live goal returns `'moving'` without re-issuing, so calling it every tick
  is safe. A new target returns `'started'`.
- `stop()` clears the goal and the controls.
- `control(name, on)` takes `forward|back|left|right|jump|sprint|sneak`. Jump
  is `control('jump', true)`.
- `lookAt(x, y, z)`.
- `equip(item, 'hand'|'off-hand')`.

There is no toss, drop or chat, so a skill can never drop items or talk. On
a terminal outcome the runtime releases every control and clears a goal the
skill left live. A step skill whose `feasible` throws or loops is switched
off for the rest of the process.

node:vm is a guard rail for generated code that a person reviews before
promotion. It is not a security boundary against hostile code.
