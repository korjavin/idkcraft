# Review: idkcraft-3nt.4 / 01-initial

scope: `/Users/iv/Projects/idkcraft/.revmux/tasks/idkcraft-3nt.4/01-initial/input/scope.md`

## Major

### The index.js seam wiring has no test — deleting it or moving it above the idle return keeps all 35 tests green

`bot/src/index.js:72-73`

The two new lines in `tick()` are the only place the scout is ever created or ticked, and nothing in `bot/test/` exercises them. `tick.test.js:18` builds its mock bot with no `registry` property (`grep -rn registry bot/test bot/src` matches only `scout.test.js` and `scout.js:52`), so `if (!ctx.scout && bot.registry)` is false in every existing test and `ctx.scout` is never assigned. `scout.test.js` constructs `makeScout` directly and never goes through `createTicker`.

Two concrete regressions that ship green today:

1. Delete both lines 72–73 — the bot stops scouting entirely, `npm test` still passes 35/35. The bead's headline behaviour has no regression guard.
2. Move the seam above the no-target branch (lines 52–68). goal.md's first correctness criterion is "no chat and no findBlocks when the idle branch runs"; the epic calls it out as a deliberate no-spam/cost guard. The placement is correct right now, but no assertion holds it there. On an empty server the bot would then chat `iron_ore x3 at ...` into the void every 5 s for as long as it is up, and every test would still pass.

The project profile states directly that "a missing assertion for new branching logic is a finding", and goal.md line 9 asks for tests that fail if the cadence/dedup/cap are removed — those exist for the module, but nothing covers the integration that makes any of it run.

Fix: Give `tick.test.js`'s `mockBot()` a `registry: { blocksByName: { iron_ore: { id: 15 } } }`, a counting `findBlocks: () => []` and a line-collecting `chat`. Then two assertions: after a no-target tick, `findCalls === 0` and `lines.length === 0`; after a tick with a player present, `findCalls === 1`.

_confidence: 85 | sources: loop+goal | lenses: goal-and-tests, bot-loop | verdict: confirmed_

### findNearestBlock matches only the exact block name, so it misses every deepslate ore and every plain name

`bot/src/behaviours/scout.js:65-84`

goal.md line 8 makes this a gate criterion: the exported helper must "resolve plain names to ore ids sanely (e.g. 'coal' -> coal_ore and deepslate_coal_ore)". It does not — line 67 is a single exact lookup `byName[blockName]`, and line 71 passes that one id to `findBlocks`.

Verified against the pinned registry (`prismarine-registry('1.21')`): `blocksByName['coal']` is `undefined`, so `findNearestBlock(bot, 'coal')` returns null at line 68 for what a player would obviously type. Worse, `blocksByName['diamond_ore'].id` is 179 and `deepslate_diamond_ore` is a separate id 180. Since 1.18 every diamond below Y=0 is the deepslate form, so `findNearestBlock(bot, 'diamond_ore')` returns null while the bot is standing next to a diamond vein — the single most likely use of the upcoming `find me <block>` bead. `matching` accepts an array (`getMatchingFunction` in mineflayer/lib/plugins/blocks.js), so merging the variants is one line; the current return of a single position means the caller in 3nt.7 cannot fix this without re-implementing the function.

Two secondary points on the same code. It is dead in this PR: nothing calls it, and the bead's "What" list and Files list cover `makeScout` only — `find me <block>` is the separate blocked bead 3nt.7, which the parallel-developer rule says not to pre-empt. And its tests pass by construction: both cases at scout.test.js:202-215 use `iron_ore` with `bot.findBlocks` replaced by a stub returning canned positions, so neither the id resolution nor the variant gap is ever asserted — inverting the resolution would not fail them.

Runtime impact today is nil because there is no caller; the cost is that the next bead inherits a helper that is wrong for its stated purpose and has tests that look like they cover it.

Fix: Resolve to the set of ids whose base name matches — reuse `baseName`/`resolveIds` to collect `[name, 'deepslate_' + name, name + '_ore', 'deepslate_' + name + '_ore']` that exist in the registry, and pass the array as `matching`. Or drop the export from this PR and build it in 3nt.7 where it has a caller and a real test.

_confidence: 85 | sources: loop+goal | lenses: goal-and-tests | verdict: confirmed_

## Sources

| agent | executor | model | effort | tokens | raised | status |
| --- | --- | --- | --- | --- | --- | --- |
| loop+goal | claude | claude-opus-5 (requested opus) | high | 265563 | 3 | ok |
| contract | claude | claude-opus-5 (requested opus) | high | 517628 | 0 | ok, nothing raised |
