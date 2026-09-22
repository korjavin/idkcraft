# Review: idkcraft-3nt.7 / 02-after-fix

scope: `/Users/iv/Projects/idkcraft/.revmux/tasks/idkcraft-3nt.7/02-after-fix/input/scope.md`

## Minor

### 'find me quartz' and nether gold are unreachable: variant list misses nether_*_ore

`bot/src/behaviours/scout.js:70`

`resolveBlockIds` resolves a player's word to ids by trying exactly three candidates: `[blockName, <base>_ore, deepslate_<base>_ore]` (scout.js:70). Enumerating the block registry via the bundled `minecraft-data`: every ore follows that pattern except `nether_gold_ore` and `nether_quartz_ore`.

Concrete failures, both reachable from the new chat command at index.js:156:
- A player types `find me quartz`. Candidates are `quartz` (an item, not a block), `quartz_ore` and `deepslate_quartz_ore` — none exist in `blocksByName`, so `ids` is empty and `findNearestBlock` returns `'unknown'`. The bot replies `unknown block: quartz` while standing in a Nether tunnel lined with `nether_quartz_ore`.
- A player in the Nether types `find me gold`. Only `gold_ore` and `deepslate_gold_ore` resolve, neither generates in the Nether, so the bot replies `no gold within 48 blocks` next to visible `nether_gold_ore`.

The bead's matching rule is "exact match first, else any block name containing '<name>_ore'", which matches both of these; the fixed three-candidate list is narrower than what the bead asked for. `resolveBlockIds` itself came in with idkcraft-3nt.4 and this diff only re-worded its comment — but until this bead it had no caller, so this change is what makes the gap player-visible. Impact is contained: typing the full registry name (`find me nether_quartz_ore`) still works.

Fix: In `resolveBlockIds`, after the three exact candidates, fall back to scanning `Object.keys(byName)` for names ending in `_ore` that contain `${base}_ore`, which picks up `nether_gold_ore` and `nether_quartz_ore` without new abstraction. Add one test asserting `findNearest(bot, 'quartz')` resolves `nether_quartz_ore`.

_confidence: 85 | sources: loop+goal | lenses: goal-and-tests | verdict: confirmed_

### Rounding test only pins one direction — Math.ceil still passes every test

`bot/test/scout.test.js:251-261`

The round-1 fix added `rounds non-integral Euclidean distance to nearest integer` (scout.test.js:251) with a block at (3,64,5) and mock origin (0,64,0): sqrt(34) ≈ 5.83, asserted as 6. That fractional part is above .5, so the assertion only distinguishes round-down implementations. Across every `distance` assertion in the file there are exactly two: 10 (from (6,64,8), an exact integer) and this 6. Replacing `Math.round` at scout.js:106 with `Math.ceil` leaves all 60 tests green.

Defect this misses: the bot's real position is fractional in-game, so a vein at a true distance of 5.1 blocks would be reported as `coal_ore at ... (6 blocks)` under `Math.ceil` — the same class of off-by-one the round-1 finding was raised to prevent, just in the other direction. The distance number is one of the three fields in the only line this bead produces.

This is a gap in the round-1 fix, not a regression: the shipped code uses `Math.round` and is correct today.

Fix: Add a second fixture whose fractional part is below .5 — e.g. a block at (5,64,1) from origin (0,64,0) is sqrt(26) ≈ 5.10 — and assert `res.distance === 5`.

_confidence: 85 | sources: loop+goal | lenses: goal-and-tests | verdict: confirmed_

## Sources

| agent | executor | model | effort | tokens | raised | status |
| --- | --- | --- | --- | --- | --- | --- |
| loop+goal | claude | claude-opus-5 (requested opus) | high | 543940 | 2 | ok |
| contract | claude | claude-opus-5 (requested opus) | high | 219659 | 0 | ok, nothing raised |
