# Review: idkcraft-3nt.7 / 01-initial

scope: `/Users/iv/Projects/idkcraft/.revmux/tasks/idkcraft-3nt.7/01-initial/input/scope.md`

## Minor

### Comment on resolveBlockIds still calls the chat command 'future' after this commit ships it

`bot/src/behaviours/scout.js:62`

Line 62 reads "// Name -> ore ids for the future 'find me <block>' chat command". This commit is the one that adds that caller (bot/src/index.js:153-164), and the diff correctly de-futured the sibling comment on `findNearestBlock` at line 77 ("Scan helper, exported for the 'find me <block>' chat command") and dropped its "That bead adds a caller, not a copy" note. Line 62 was left behind, so the file now describes the same command as both shipped and not-yet-written. On a project whose stated convention is that changes should be readable and explain themselves, that is the comment a reader hits first.

Fix: Drop "the future" from line 62 so it matches the wording already used at line 77.

_confidence: 95 | sources: loop+goal | lenses: goal-and-tests | verdict: confirmed_

### No test pins the distance rounding — every fixture is an exact integer distance

`bot/test/scout.test.js:248`

goal.md names "Euclidean distance rounded" as a correctness criterion, and `findNearest` implements it with `Math.round(dist(p, origin))` (bot/src/behaviours/scout.js:106). But every fixture in the new tests sits at an exactly integral distance: `pos(6, 64, 8)` from the mock origin `pos(0, 64, 0)` is hypot(6,0,8) = 10.0, used identically at scout.test.js:248, 288 and 311. Swapping `Math.round` for `Math.floor`, `Math.ceil` or `Math.trunc` leaves all 59 tests green.

Concrete defect this would miss: a vein at 5.9 blocks (bot standing at a fractional position, which is the normal case in-game — `bot.entity.position` is not integral) is reported as "coal_ore at ... (5 blocks)" under `Math.floor` instead of the 6 the bead asks for. The reply shape is the whole deliverable of this bead, so the one number in it that can be silently wrong is unguarded.

Fix: Add one case with a non-integral distance, e.g. set the mock origin or block so the true distance is ~5.6, and assert `res.distance === 6`.

_confidence: 85 | sources: loop+goal | lenses: goal-and-tests | verdict: confirmed_

## Sources

| agent | executor | model | effort | tokens | raised | status |
| --- | --- | --- | --- | --- | --- | --- |
| loop+goal | claude | claude-opus-5 (requested opus) | high | 379237 | 3 | ok |
| contract | claude | claude-opus-5 (requested opus) | high | 200800 | 0 | ok, nothing raised |
