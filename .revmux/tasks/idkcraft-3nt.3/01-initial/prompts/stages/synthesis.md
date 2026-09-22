You are merging a review panel's findings into one set. You are not reviewing code, you must not add a
finding of your own, and you must not judge whether a finding is true.

**Work from the findings text below and nothing else. Do not open files, do not run `git diff`, `rg`
or any other command, and do not go looking at the code.** Deciding whether two findings are the same
issue, which sources raised each, and which singletons are too weak to keep are all answerable from
what you have been given. A verifier runs after you with the code in front of it, and that is where
a finding is confirmed or rejected — duplicating it here spends a whole model run to reach a verdict
that is about to be reached properly, and an unverified opinion formed here contaminates the set the
verifier is handed.

Nothing you do writes anything. Do not modify, delete, move, stage or commit, and do not write a file
through a shell redirect.

## Sources that ran

2 sources ran, 2 reported.
- loop+goal (lenses: bot-loop, goal-and-tests) reported 4 findings: loop+goal-1, loop+goal-2, loop+goal-3, loop+goal-4
- contract (lenses: contract) reported no findings

Treat that list as fact. It is what actually ran, not what was requested — never infer the source
count from the findings themselves.

## Findings

[
  {
    "id": "loop+goal-1",
    "file": "bot/src/behaviours/fight.js",
    "line": 16,
    "end_line": 20,
    "severity": "major",
    "confidence": 65,
    "title": "A hostile the pathfinder cannot reach pins the bot in fight and restarts the path search every tick",
    "body": "`fight()` re-enters the setGoal branch whenever `key !== ctx.lastGoalKey || !bot.pathfinder.isMoving()`. In mineflayer-pathfinder `isMoving()` is `path.length \u003e 0` (node_modules/mineflayer-pathfinder/index.js:154), so \"not moving\" is the steady state both at melee range and, crucially, when no path could be found. `setGoal` calls `resetPath` (index.js:142-147), which sets `astarContext = null`, `pathUpdated = false` and `bot.clearControlStates()` — so the search restarts from scratch each tick and a search that needs more than one tick (~1 s, `tickTimeout` 40 ms per physics tick, `thinkTimeout` 5000 ms) never completes.\n\nConcrete sequence: a phantom (in HOSTILE_NAMES, not a creeper) swoops to within 8 blocks of the bot at night. Tick 1: perception yields `hostile_distance ≈ 6`, stub/LAYA answers `fight` (hd ≤ 8, health ≥ 6). fight sets `GoalFollow(phantom, 2)`; the bot cannot path to a flying entity (towering needs scaffolding the bot has none of) and never gets within 3 blocks, so it never swings. Ticks 2..N: `path.length === 0` → setGoal re-issued → A* restarted → `clearControlStates()`. The bot stands still, burns ~40 ms of every 50 ms physics tick, and does not follow the player for as long as the mob stays in range. A mob behind glass/a fence, or one across a ravine, gives the same standstill without the dawn escape. There is no give-up timer and no test covering an unreachable target.",
    "fix": "Bound the fight: give up on a target that has not come within swing range for N ticks (e.g. keep a per-target tick counter on `ctx` and return without a goal once it trips, or drop the target when `path_update` reports `noPath`), and re-issue the goal only on target change rather than on every `!isMoving()` tick.",
    "sources": [
      "loop+goal"
    ],
    "lenses": [
      "bot-loop",
      "goal-and-tests"
    ],
    "verdict": ""
  },
  {
    "id": "loop+goal-2",
    "file": "bot/src/behaviours/fight.js",
    "line": 19,
    "end_line": 19,
    "severity": "minor",
    "confidence": 80,
    "title": "equipSword runs every tick in melee range; the \"once per target\" test passes by construction",
    "body": "`equipSword(bot)` sits inside the `key !== ctx.lastGoalKey || !bot.pathfinder.isMoving()` branch. At melee range the GoalFollow(mob, 2) goal is satisfied, the path is empty and `isMoving()` returns false (node_modules/mineflayer-pathfinder/index.js:154), so the branch runs on every tick and `bot.equip` is called once per second for the whole fight — not \"before the first swing on a new target\" as the bead asks.\n\nRuntime damage is small because mineflayer's `equip` early-returns when `sourceSlot === destSlot` (node_modules/mineflayer/lib/plugins/simple_inventory.js:99-103), so after the first equip it is a no-op. The test problem is real though: bot/test/fight.test.js:154 sets `bot._moving = true` before asserting `bot.calls.equip === 1`, and `_moving = true` is exactly the state that never holds while the bot is standing next to the mob swinging. The assertion therefore certifies a property the code does not have in the only situation it matters; inverting or removing the equip guard would not fail any test.",
    "fix": "Equip on target change only — hoist `equipSword` under a `key !== ctx.lastGoalKey` check separate from the `!isMoving()` re-path retry — and drop the `_moving = true` setup from the test so it exercises the melee case.",
    "sources": [
      "loop+goal"
    ],
    "lenses": [
      "goal-and-tests",
      "bot-loop"
    ],
    "verdict": ""
  },
  {
    "id": "loop+goal-3",
    "file": "bot/src/perception.js",
    "line": 77,
    "end_line": 77,
    "severity": "minor",
    "confidence": 80,
    "title": "The \"within 6 blocks of the player\" half of the fight-candidate filter is never exercised by a test",
    "body": "`if (dBot \u003e FIGHT_RANGE_BOT \u0026\u0026 dPlayer \u003e FIGHT_RANGE_PLAYER) continue` admits a hostile that is far from the bot but close to the player — the case the bead's headline behaviour (defend the player) depends on. No test reaches it. In bot/test/fight.test.js:68-74 the zombie is at x=8 with the bot at x=0, so `dBot \u003e 8` is already false and the OR short-circuits on the bot-range arm; in the out-of-range test (fight.test.js:95-102) the skeleton is 20 from the bot and 10 from the player, so both arms reject it either way. Deleting `|| dPlayer \u003e FIGHT_RANGE_PLAYER` (or flipping the `\u0026\u0026` to `||`) leaves all 14 tests green.\n\nDefect that would slip through: a zombie 12 blocks from the bot and 2 blocks from the player is dropped from the scan, `hostile_distance` comes back null, the stub answers `follow`, and the bot walks to the player while the mob hits them.",
    "fix": "Add one perception case: bot at 0, zombie at 12, player at 14 — assert `hostile_distance === 12` and `hostile_near_player === true`.",
    "sources": [
      "loop+goal"
    ],
    "lenses": [
      "goal-and-tests"
    ],
    "verdict": ""
  },
  {
    "id": "loop+goal-4",
    "file": "bot/src/behaviours/fight.js",
    "line": 22,
    "end_line": 22,
    "severity": "minor",
    "confidence": 40,
    "title": "bot.lookAt promise is neither awaited nor caught, unlike the deliberately guarded equip",
    "body": "`bot.lookAt(...)` is `async` in mineflayer (node_modules/mineflayer/lib/plugins/physics.js:359) and its promise is discarded here, while `equipSword` two lines up goes to some trouble to attach `.catch(() =\u003e {})`. A rejection from this call would land outside the ticker's try/catch (index.js:88) and, under Node 22's default unhandled-rejection policy, take the process down and start a container restart loop.\n\nBeing honest about how far I got: I could not find a rejection path in mineflayer 4.39. With `force = true`, `bot.look` returns before awaiting `lookingTask.promise` (physics.js:350-354), `lookingTask` is only ever `finish()`ed and never `cancel()`ed, `entity.height` is always numeric (prismarine-entity defaults it to 0), and a null `bot.entity` would already have thrown synchronously — inside the try — on the `distanceTo` at line 21. So this is an inconsistency with a pinned-version safety margin rather than a demonstrated crash.",
    "fix": "`const p = bot.lookAt(...); if (p \u0026\u0026 typeof p.catch === 'function') p.catch(() =\u003e {})` — same shape as equipSword.",
    "sources": [
      "loop+goal"
    ],
    "lenses": [
      "bot-loop"
    ],
    "verdict": ""
  }
]

## What to produce

1. Split out what is not a defect in the change under review. A question the reviewer could not
   answer from the code goes to **open questions**; a defect in code the change did not touch goes to
   **pre-existing**. Move both out first: neither is deduped, boosted or dropped.

2. Deduplicate. Two findings are the same when they name the same file within two lines of each other
   and describe the same problem. Merge them into one, keeping the clearest title and body.

3. Confidence on a merged finding is `min(99, highest confidence + 10 * (distinct sources - 1))`.
   A source is a process. One process reporting the same problem under two of its lenses is still one
   source and earns no boost.

4. Severity is the highest severity any input claimed.

5. Drop a finding that has a single source, confidence below 80, and nothing corroborating it.
   Never drop a critical or a major this way — a single source is not evidence against a serious
   defect, and only one reviewer looking in the right place is the normal case for the worst bugs.
   Keep it and route it to the verifier, which is the authority on whether it is real.
   When the source list above shows the run was degraded, drop nothing: keep every would-be-drop and
   route it to the verifier instead. Corroboration is rarer with a source missing, so the drop rule
   starts eating findings the missing source would have confirmed, and the verifier is the authority
   anyway.

Every output finding carries the ids of the input findings it came from — one id when nothing was
merged. Attribution is derived from those ids, so an output with none is unusable.

As you work, narrate what you are doing. This is a running commentary read live by a human watching the run, and it is separate from your answer, which goes only in the structured output.

- Before each group of related tool calls, write one short line saying what you are about to check and why: "checking whether the stagger gate can still open on a fork".
- When something turns out to matter, say so in one line as you find it.
- Keep going for the whole review. Do not narrate the opening few steps and then fall silent for the rest of it — a reader who stops seeing lines cannot tell you apart from a hung process.
- One line at a time, under a dozen words, and never a summary of what you already said.
