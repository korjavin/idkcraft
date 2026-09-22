# Round 01 findings (both addressed)

## loop+goal-1 [minor] Paused branch ticks the scout with nobody online, unlike the idle branch
The paused block runs the scout seam unconditionally (lines 64-65), outside the `if (target) / else` above it, whereas the normal path only reaches the scout seam after `if (!target) return ...` (lines 79-95) — scout never scans when nobody is online. `bot/test/tick.test.js:220` pins that invariant for the unpaused path ("never scans or chats when no player is online").

Trigger: a player says `stop` (paused = true), then everyone logs off. `findTarget` returns null (confirmed in `bot/src/perception.js:22` — empty `bot.players` yields `null`), so `lastVisible` is false and the loop settles into the 10 s poll, but every one of those ticks still creates the scout (registry is present after spawn) and calls `scout.tick()`.

Consequences, in order of weight: (a) `bot.findBlocks` runs every 10 s indefinitely with no audience; (b) the veins it finds are added to the scout's `seen` set and chatted into an empty server, so a player who logs back in while the bot is still parked never hears about the ore around it — scout's `seen` set is per-instance and persists on `ctx.scout`. Note the chat/console burst is one-time, not indefinite: a parked bot is stationary, so after the first scan nothing is `fresh` and the loop goes quiet. The comment at lines 51-53 claiming the paused path is the "same cost guard as 'no player online'" is therefore slightly inaccurate as written.

The root cause is that the paused block is a hand-copy of the idle cost-guard block (lines 79-95) with the scout seam spliced in at a different nesting level.
FIX: Move lines 64-65 inside the `if (target)` arm of the paused block so the scout only ticks when a player is visible, matching the unpaused path. The move stays inside the paused branch — no signature or caller change.

## loop+goal-2 [minor] New paused test never exercises the scout seam, the one thing the bead says pausing must preserve
The bead's design is explicit that "the tick still runs perception (scout keeps reporting)" while parked — that separation is the stated learning point. The new test builds a bare `mockBot()` (line 241) with no `registry`, no `findBlocks` and no `blockAt`, so `ctx.scout` is never created and `ctx.scout.tick()` is never called on any paused tick. Deleting lines 64-65 of `bot/src/index.js` — the scout seam inside the paused branch — leaves the whole suite green, so the bot silently stops reporting ore the moment anyone says `stop` and nothing catches it.

The rest of the test is sound: removing the `if (ctx.paused)` block does fail it (the brain would be called and a goal set on the paused ticks).
FIX: Use the existing `scoutBot()` helper from the `scout seam` describe (or an inline equivalent) in the paused test and assert `bot.findCalls > 0` / a chat line after a paused tick with a player nearby.
