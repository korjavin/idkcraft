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
  that persists between ticks. An ordered step run also sees `st.count`
  (the order's count, 1..64, or `null`) and `st.by` (the ordering player,
  or `null`); a run the FSM picks on its own always sees `null`s.

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

## Order-only skills (vf8e.17)

A step skill reaches a chat order through the plan executive — no hand FSM
order, no new skill kind. Say `do <name> [count]` (deterministic, no LLM
call) or let an LLM plan pin it: the executive pins the step one at a time
through `ctx.taskPlanStep` (args in `ctx.taskPlanArgs`), the arbiter consumes
the pin, and the wrapper copies the args into the fresh `st`.

Recipe (e.g. a skill that plants parks only when taught and ordered):

```js
function feasible(facts) {
  return facts.pinned === 'gen_park' // only when ordered — never on its own
}
```

| fact / field | value |
|---|---|
| `facts.pinned` | the executive's one-shot step (`ctx.taskPlanStep`), kept while the executive owns the running work step, else `'none'`. |
| `facts.pinCount` | the pin's count (`ctx.taskPlanArgs.count`), or `0`. |
| `st.count` / `st.by` | the order's count (1..64) and player, or `null`s without an order. |
| `entities()` item | each entry carries `item`: the dropped-item registry name, or `null`. |

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
- `entities(radius<=32)` returns `[{name, type, username, item, x, y, z}]` (`item` is the dropped-item registry name, else `null` — on the baritone body it rides the mod's `entities.list` item field, idkcraft-poyd).
- `drops([name|names], [radius<=32])` returns `[{item, x, y, z}]`: the cheap per-tick drop watch (idkcraft-poyd). The first call each tick scans the folded entities once and caches the rows on the episode; later calls that tick only filter — a gather skill that also scans players pays one scan, never one per call, and never an RPC. Omit the name to watch every drop, or pass one name (or an array of up to 64) to watch only those stacks.
- `status()` returns `{busy, err, path, moving}`.

Act. Each async act returns `'started'`, `'busy'` or `'denied:<reason>'`, and
only one runs at a time. Poll `status().busy` and `status().err` on later
ticks.

- `dig(x, y, z)` goes through `util.denyReason`: the protected/foreign-block
  and self-trap rules every hand dig uses. It cannot dig down once the bot
  is walled in (the `below-feet` trap rule) — that move is `digIn`.
- `digIn()` runs the hand dig-in maneuver (`recover.digInRun`), one tick per
  call: it walks to the nearest hand-diggable column itself when the ground
  under the body is stone (the stone stance — do not relocate first, just
  call it where you stand), digs the veto-steered descent, falls in and caps
  overhead from the dug dirt. `denyReason` stays unchanged; every dig and
  the cap runs the hand vetoes inside. No arguments. Call it every tick and
  nothing else until it answers `'done'`: while it runs `dig`/`place`/`use`/
  `equip` answer `'busy'`, and `goto()`/`control()` would fight the
  maneuver's own walk to the column and forward steps into the pit. It
  answers `'started'` while running, `'done'` once the pit is capped, or
  `'denied:dig-in-<reason>'` when the ground refuses (stone with no dirt
  column in reach, protected ground, no cap material). Recipe for a night
  dig-in: call `digIn()` until it answers `'done'`, then `stop()`, release
  the controls and hold still till dawn (`'done'` when `time()` leaves the
  night range).
- `place(x, y, z, item)` places INTO that cell against a solid neighbour. It
  refuses the castle yard ring and apron (`denied:place-protected`) and never
  clicks a GUI block.
- `use(x, y, z)` uses the held bucket on that cell: a held `water_bucket`
  pours, a held `bucket` scoops a water source. `place()` cannot pour. It
  refuses any other held item (`denied:not-a-bucket`), a cell farther than
  4.5 from the eyes (`denied:out-of-reach`) and the castle yard ring/apron
  (`denied:use-protected`). `equip` the bucket first. A pour aims at a
  ray-visible solid face INTO the cell (re-verified after the look, since
  the body moves between the check and the pour) and refuses with
  `denied:no-face` when no face is visible — the water always lands in the
  checked cell, never where a stale or occluded server ray lands. A scoop
  refuses with `denied:ray-miss` when a solid stands between the eyes and
  the target.
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
- `craft(item, n=1)` runs one craftany tick per call: the hand plan, table
  walk/place and gear ops (per-episode run state, shared body goals).
  `'started'` while it advances, `'done'` once the product lands,
  `'denied:no-table'` / `'denied:no-mats'` / `'denied:craft-failed'` when
  the pack cannot fund it, `'denied:wood-capped'` for a `_planks` target
  past the wood ceiling (packroom `PLANK_KEEP`). While it runs every other
  firing act answers `'busy'` — call it every tick and nothing else, the
  `digIn` shape.
- `withdraw(chest, item, n=1)` opens one chest window through stockpile's
  `withdrawAnyFromChest` (the castlefetch draw call). `chest` is an
  `{x,y,z}` cell (or `x, y, z, item, n`): it must be a chest block in open
  reach (`INTERACT_REACH`) — walk there with `goto()` first. On a built home,
  planks past `PLANK_KEEP` and logs past `LOG_KEEP` are refused
  (`denied:bank-keep`).
  No dig runs, so the protection rules are untouched by construction.
  `'started'`, then `'busy'` while open (poll `status()`); an empty or gone
  chest lands in `status().err`. Count the pack before/after for the got.

Resource-chain recipe (a castle stairs leg whose table sits in the chest):
`goto()` the chest, `withdraw()` the table (or the wood), `craft()` the
stairs, `place()` them — `count()`/`inventory()` before and after each act
tell what landed.

There is no toss, drop or chat, so a skill can never drop items or talk. On
a terminal outcome the runtime releases every control and clears a goal the
skill left live. A step skill whose `feasible` throws or loops is switched
off for the rest of the process.

node:vm is a guard rail for generated code that a person reviews before
promotion. It is not a security boundary against hostile code.
