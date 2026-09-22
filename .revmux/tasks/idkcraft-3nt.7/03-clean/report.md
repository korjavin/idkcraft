# Review: idkcraft-3nt.7 / 03-clean

scope: `/Users/iv/Projects/idkcraft/.revmux/tasks/idkcraft-3nt.7/03-clean/input/scope.md`

## Minor

### The 'follow me' / 'stop' branches of the extracted handleChat are executed by zero tests

`bot/src/index.js:144-151`

This diff lifts the inline chat listener out of `main()` into an exported `handleChat(bot, ticker, username, message)` (bot/src/index.js:141-166) and, in the move, adds two new guards that did not exist before: `if (ticker)` around `setFollow(username)` (line 145) and around `setFollow('') + stop()` (lines 148-151).

None of that is executed by any test. Every one of the eleven `handleChat` calls in the suite passes `ticker` as `null` (bot/test/scout.test.js:323-374), and every message they send is a `find me …` string or a deliberate non-match — no test sends `follow me` or `stop` at all. Nothing else covers it: `tick.test.js` only requires `createTicker`/`BEHAVIOURS` and drives the ticker directly, and `e2e-follow.js` is not even part of `npm test` (`bot/package.json:11` runs brain, tick and scout only).

So the `follow me` and `stop` bodies run in no test, in either branch of the new guard. Concretely: had the move written `ticker.setFollow(msg)` instead of `ticker.setFollow(username)`, the bot would lock onto a player literally named "follow me" — follow nobody, forever, silently — and all 62 tests would still be green, because no test observes those paths. The same holds for dropping `ticker.stop()` from the `stop` branch, which would leave the pathfinder walking after the player asked it to stop.

The code is correct as written; this is a coverage gap for branching logic the refactor introduced, which the project profile calls out explicitly ("a missing assertion for new branching logic is a finding"). The old inline handler was untested too, but before this change it was not callable from a test, and now it is.

Fix: Add two cases in the same describe block using a recording stub, e.g. `const t = { calls: [], setFollow(n){ this.calls.push(['setFollow', n]) }, stop(){ this.calls.push(['stop']) } }`, then assert `handleChat(bot, t, 'Steve', 'follow me')` records `['setFollow','Steve']` (and chats `Following Steve`), and that `'stop'` records both `setFollow('')` and `stop()`.

_confidence: 95 | sources: loop+goal | lenses: goal-and-tests | verdict: refined_

## Immaterial

### Two of the three explicit candidates in resolveBlockIds are now subsumed by the substring scan below them

`bot/src/behaviours/scout.js:70-80`

The round-2 fix appended a registry scan (scout.js:74-80) that adds every block name containing `${base}_ore`. It did not touch the three-candidate loop above it (scout.js:70), so two of those three entries are now unreachable in effect:

- `${base}_ore` — the scan's pattern *is* `${base}_ore`, and `'coal_ore'.includes('coal_ore')` is true.
- `deepslate_${base}_ore` — `'deepslate_coal_ore'.includes('coal_ore')` is true.

Only the bare `blockName` candidate still contributes anything the scan cannot (the exact non-ore match, e.g. `find me chest`). The effective set was checked against the bundled registry: for every ore base the two paths produce the same ids, and the `!ids.includes(entry.id)` guard means the duplicates are dropped rather than doubled — so this is not a behaviour bug, the resolved ids are correct.

It is worth a line on a project whose stated convention is smallest diff and code that explains itself: a reader now meets two different rules for the same job in nine lines, and the explanatory comment at scout.js:62-65 still describes only the first one, so it under-describes what the function actually matches (it no longer mentions the nether variants the scan exists to catch).

Fix: Collapse the first loop to the single exact-match candidate (`const entry = byName[blockName]; if (...) ids.push(entry.id)`) and let the scan handle the `_ore` variants, then extend the comment at scout.js:62-65 to say 'exact name, plus every registry block containing <base>_ore (covers deepslate_* and nether_*)'.

_confidence: 90 | sources: loop+goal | lenses: goal-and-tests | verdict: immaterial_

## Sources

| agent | executor | model | effort | tokens | raised | status |
| --- | --- | --- | --- | --- | --- | --- |
| loop+goal | claude | claude-opus-5 (requested opus) | high | 518485 | 3 | ok |
| contract | claude | claude-opus-5 (requested opus) | high | 304711 | 0 | ok, nothing raised |
