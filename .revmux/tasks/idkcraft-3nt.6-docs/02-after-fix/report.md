# Review: idkcraft-3nt.6-docs / 02-after-fix

scope: `/Users/iv/Projects/idkcraft/.revmux/tasks/idkcraft-3nt.6-docs/02-after-fix/input/scope.md`

## Minor

### README still documents `roam`, which exists nowhere in the tree

`bot/README.md:54`

Line 54 reads "*(roam is being added as a fourth choice in a follow-up).*" inside the list of actions the brain chooses. `rg -ni roam` over the whole worktree matches this line and nothing else — no code, no test, and `git grep -ni roam origin/master -- bot/` is empty too. `bot/src/brain.js:39` accepts only fight/follow/idle and `stubBrain.decide` has no roam branch, so nothing a reader can run produces it. `bd show idkcraft-3nt.5` confirms roam is still IN_PROGRESS and unmerged, and 3nt.6's own Notes say not to wait for it.

This is a carry-over: round 1 raised the same line, and this round's scope.md claims "Removed speculative roam details from documentation" — the surrounding detail was removed but the forward-looking bullet survived in reworded form, so the claimed fix is incomplete. Impact is contained (the line is labelled as future work, so no reader is misled about today's behaviour), but the README of a learning project now lists a fourth choice that 3nt.5 may land differently.

Fix: Delete line 54; document roam in the PR that adds it.

_confidence: 90 | sources: loop+goal | lenses: goal-and-tests | verdict: confirmed_

### Scout cap described as "3 new veins per scan" when it is 3 lines, one per ore type

`bot/README.md:78`

Line 78 says "Reports up to 3 new veins per scan in chat as `<ore> x<count> at <x> <y> <z>`". In `bot/src/behaviours/scout.js:137-169` the new positions are grouped into `fresh` keyed by **base ore name**, `names` is that key set sorted by rank and `.slice(0, 3)`, and one chat line is emitted per name with `x${spots.length}` (total new blocks of that ore) at the nearest of them. So the cap is three ore *types*, and a single line can merge several distinct veins: two separate diamond veins found in one scan produce one line `diamond_ore x<total> at <nearest>`, with the second vein's coordinates never reported. Conversely a scan turning up four ore types drops the lowest-ranked one entirely, which "3 new veins" does not convey either.

This is a regression in accuracy introduced by the rewrite — `origin/master:bot/README.md:54` said "at most 3 lines per scan", which was correct, and goal.md's own criterion asks for "max 3 lines". A reader who runs `/setblock` on two separate veins and sees one line would read it as the scout missing a vein.

Fix: Restore the earlier wording: "at most 3 lines per scan, one per ore type, highest value first".

_confidence: 85 | sources: loop+goal | lenses: goal-and-tests | verdict: confirmed_

## Sources

| agent | executor | model | effort | tokens | raised | status |
| --- | --- | --- | --- | --- | --- | --- |
| loop+goal | claude | claude-opus-5 (requested opus) | high | 356875 | 3 | ok |
| contract | claude | claude-opus-5 (requested opus) | high | 416575 | 0 | ok, nothing raised |
