# Stuck oracle: the pre-merge gate for movement code

`stuck-run.sh` + `stuck-replay.js` replay the known prod stuck spots on a
pristine prod-world snapshot with the REAL bot stack and judge the run
against a committed baseline. It is the only check that sees Paper physics —
unit tests have no physics by construction.

## One command

```sh
sh bot/tools/stuck-run.sh [variant] [spots.json] [secs]
```

One call = reset the disposable world copy, boot the rig, wait for rcon,
anti-noise, pre-op, replay, tear down, judge. Exit codes:

| code | meaning |
| ---- | ------- |
| 0 | baseline holds (or comparison skipped — see below), including `FLAKY`: the regressed spots held on the automatic rerun (see Sensitivity, flakes) |
| 1 | REGRESSION vs `stuck-baseline.json`, repeated on the rerun: a spot flipped reached→unreached, overran its stuck/episode ceiling, or has no baseline entry (never rerun) |
| 2 | environment failure: no START.sh/snapshot, rig never came up, anti-noise rejected, pristine `world.tar` changed mid-run, guide setup failed (`GUIDE-BURIED`/`GUIDE-DIED`), follower dropped mid-run |
| 130 | interrupted (never a pass) |

**One rig run at a time, no manual wrapper needed.** The script takes an atomic
lock (`/tmp/idkcraft-rig.lock`, override `RIG_LOCK`; holder pid inside, dead
holder = stale, reclaimed; released on every exit). A second caller exits 2
(`rig busy`) before touching the world; `RIG_LOCK_WAIT=<secs>` polls instead.
A caller that already holds the lock itself sets `RIG_LOCK_HELD=1`.

Results land in `bot/tools/last-replay.json` (gitignored); the run table
prints to stdout with a `BASELINE <spot>: was … | now …` diff per changed spot.

## Setup (local only — the world never enters git)

The rig world lives OUTSIDE the repo (private prod data):

- `PRODWORLD` (default `/Users/iv/Projects/.idkcraft-prodworld`): `START.sh`,
  pristine `world.tar`, disposable `replay-data/<variant>/` copies.
- `START.sh` boots Paper 26.1.2 on port 25571 with rcon; the wrapper only
  ever READS `world.tar` (`tar -xf`) and fails with exit 2 if its sha moved.
- `variant`: `paper-base` (default) or `paper-relaxed`. `vanilla` is refused
  (no pristine tar — transplanted hand-built world).

No Minecraft client needed; Docker is required.

## Environment

| var | default | meaning |
| --- | ------- | ------- |
| `PRODWORLD` | `/Users/iv/Projects/.idkcraft-prodworld` | rig dir (outside the repo) |
| `REPLAY_TAG` | `r` + 3 pid digits | bot name suffix (16-char username cap); the wrapper pre-ops these names |
| `REPLAY_OUT` | `bot/tools/last-replay.json` | JSON results path |
| `REPLAY_BASELINE` | `bot/tools/stuck-baseline.json` (`stuck-baseline-v2.json` under `REPLAY_BODY=baritone`) | baseline file |
| `REPLAY_BASELINE_OFF=1` | — | record only, skip the comparison |
| `REPLAY_BRAIN` | `stub` | `stub` (gate) or `laya` (menu measurement, see below) |
| `REPLAY_PLANNER` | `stub` | `jev` / `llm`: the stub brain plus the stall-point `plan()` (prod `makeBrain` shape), so stuck recovery escalates to it after a failed primitive (idkcraft-vhlb.4). Keys from env, else stash (`secrets/jev-api-key`, `secrets/minecraft/anthropic-api-key`). Judged against the stub baseline |
| `REPLAY_BRAIN_URL` | `http://localhost:8000/v1/systemone` | operator's tunnel to the prod sidecar |
| `REPLAY_BRAIN_TIMEOUT_MS` | `10000` | per-call model deadline |
| `REPLAY_SPOTS` / argv[2] | `stuck-spots.json` | corpus file |
| `REPLAY_SECS` / argv[3] | per-spot `secs` (else 75) | window override |
| `REPLAY_OP=1` | — | legacy pre-login op inside the replay (the wrapper pre-ops already) |
| `REPLAY_QUIET=0` | filtered | keep per-tick ticker chatter |

## Baseline workflow

The baseline is data, not aspiration: `spot → { reached, maxStuck, maxEps, maxCalls }`.

- Record: `REPLAY_BASELINE_OFF=1 sh bot/tools/stuck-run.sh`, then copy the
  measured `reached`/`stuck`/`eps`/`call` per spot into `stuck-baseline.json`.
- Slack: ceilings carry observed + 2 stuck / + 1 episode — single runs vary
  (ik7 saw S6 stuck 0..3 across two opped runs on one build). `maxCalls`
  carries no slack (a page is a gave-up — see Sensitivity). Re-measure,
  do not hand-tune; `npm test` fails when a corpus spot lacks an entry.
- Judge: plain `sh bot/tools/stuck-run.sh` → exit 0/1 with the diff.
  Green runs are quiet (under-ceiling counts are `ok`, not news).
- Improvement (`IMPROVED`: reached flipped false→true, exit still 0) means
  the entry is stale: re-record and commit the new entry in the same PR.
- Control spots (idkcraft-jsf.7) are the one exception to `maxCalls: 0`:
  DUGPIT-VALIDATE is a trap that MUST page, so its entry is
  `reached: false, maxCalls: 1, minCalls: 1`. `minCalls` (optional, any
  entry) regresses a run that pages less — a silent trap (the no-path
  detector broke) or a leaking one (the bot walked out, and BARE's
  `reached` stops proving water_up). An entry with `minCalls` is a
  control: reaching regresses (`control trap leaked`), never `IMPROVED`.

A `laya` run never judges against the stub baseline (different menu policy):
it records and exits 0 until a laya baseline ships.

## Sensitivity (what the gate sees, and what it does not)

The gate sees planner/reflex/follow regressions: a reached flip or a stuck
overrun on any spot exits 1 (proven: `canDig=false` sabotage flips the
dig-through spots — see the 6x7.4 PR).

It also sees recover-budget breakage — via premature paging, not via
reached. S6-PIT wedges under a dirt brow every run: healthy code fails
`dig_up`, rescues with a `dig_step` chain, and reaches silently; with
`MAX_FAILS=0` the first failed primitive pages the owner (`call_player`)
and gives up instead of rescuing. The give-up still reaches (a fresh plan
finishes the dug void), so `reached` cannot flip — but `calls` flips 0→1
against the strict `maxCalls: 0`, and the run exits 1 (proven: full-suite
sabotage run, `BASELINE S6-PIT … REGRESSION (calls 1 > 0)` — see the PR).

`maxCalls` carries no slack on any spot because a page is a gave-up: a
decision, not physics. Zero healthy pages in 30+ spot-runs across the
corpus; a page on a healthy run means the bot gave up somewhere, which is
news, not noise — investigate first, re-record only when the new behavior
is the intended one. `npm test` pins S6-PIT's `maxCalls: 0`: any slack
there would un-flip the sabotage.

It sees water_up breakage via DUGPIT-BARE (idkcraft-jsf.7): healthy code
climbs out in 58-59 s with both buckets back (5/5); with
`BUCKETS_NEEDED=3` water_up refuses `failed:no-bucket`, the bot pages from
the pit, and the run exits 1 (`BASELINE DUGPIT-BARE … REGRESSION
(unreached (was reached))`). DUGPIT-VALIDATE, its no-bucket twin on the
same arena, holds 5/5 (one page, never reached) — so BARE's `reached` is
the water climb, not a walk.

Flakes (idkcraft-6x7.9): the corpus is not deterministic by construction,
and that is prod behavior, not a rig bug — so it is neither seeded nor
absorbed by wider ceilings. Two observed false REGRESSIONs (~1 in 15 full
runs, 2026-10-02): CLUSTER `calls 1 > 0` — recover's sidestep picks a free
side at random (`pickSidestepDir`), one side leads the `dig_step` into
prod-era cobblestone the bot did not place this session (`protected`) and
it pages; three single reruns of the same code were 0 eps / 0 calls.
DUGPIT-BARE unreached once — `water_up failed:no-rise` (swim stall/timeout
counted in real Paper ticks plus water physics). So a run that exits 1
reruns ONLY the regressed spots, once, on a freshly reset world (dug
terrain persists across spots); results go to `/tmp/stuck-rerun-<variant>.json`.
Repeats → `verdict: REGRESSION (repeated on the rerun)`, exit 1. Holds →
a `FLAKY <spot>` line per spot plus `verdict: FLAKY`, exit 0 — paste it
with the table; a spot that keeps showing up FLAKY is a bead, not noise.
FLAKY means "held in isolation": the rerun has a fresh follower (no ctx
latches/counters from earlier spots) and pristine terrain, so a spot
FLAKY again and again behind the same predecessor points to cross-spot
state carry-over, not physics. A missing baseline entry is deterministic
(exit 1, no rerun); env exits (2) are never rerun. The sabotages above are
deterministic (they fail 2/2) and still exit 1 after the rerun (proven:
S6-LEAD with `MAX_FAILS=0` regressed `unreached (was reached)` on both
runs, `verdict: REGRESSION (repeated on the rerun)`, exit 1).

What it does NOT see: recover breakage that changes neither the walk nor
the paging (a first-try rescue needs no budget — `MAX_FAILS=0` is silent
on every spot whose green run never fails a primitive).

Order-driven spots (idkcraft-6x7.7) judge the outcome of a guide-chatted
work order instead of a follow walk: the guide parks on the goal (the
delivery point, near the spawn), chats the order at window start, and the
window ends at the first `expect`/`fail` chat marker. A give-up that fails
the order (a bring `refuse` — no delivery, no `here are`) flips `reached`
instead of re-issuing the walk, so bring-behavior breakage exits 1 with a
diff (proven: atl.20-exemption sabotage on ATL-SHAFT refuses `could not
reach iron_ore safely` after 3 escape episodes — `REGRESSION (unreached
(was reached))`, plus an episode overrun 3 > 1).

Honest limit, measured: `MAX_FAILS=0` is silent on ATL-SHAFT too (exit 0,
byte-identical row). The green order runs episode-free — the atl.20
exemption digs below-feet ore onto solid without ever asking the recover
menu, so the budget is never read. An order spot proves recover-sensitivity
only where its green path fails a primitive and rescues.

The shelter spot (SPAWN-BARE, idkcraft-ed88) sees the night shelter with
an empty kit. Green runs read `CLOSED 11s` (3/3, v1; v2 13-14 s fresh,
15-19 s after a long spot — idkcraft-bn4d, budget `closeSecs: 25`). With `digInRun`
sabotaged to fail at once, the bot holds on the bare stone (`OPEN at
-58 61 -214`, maxDisp 0.0) and the run exits 1 (`BASELINE SPAWN-BARE …
REGRESSION (unreached (was reached))`).

The 6x7.8 carrier hunt (idkcraft-6x7.8) found no such order — measured,
not assumed. Q0H-PIT `come home` runs episode-free (18 s, the pit→rim
walk never wedges: the q0h trap was rest-specific and is fixed), so the
budget is never read there either (`MAX_FAILS=0` sabotage: exit 0, row
identical — 17 s, `OK home`; JR-SLOPE likewise exit 0, 31 s, `here
is 1 acacia_log`). Rest itself has
no chat order and never wins the work menu deterministically. Two
constructed carriers failed green and were dropped, not committed: a
come-home through the S6 brow (the brow noPaths canDig-false planning
— no wedge, the walk stalls at 0 displacement and refuses in 31 s) and
a bring across it (bring picks the nearer east source and noPath-refuses
in 11 s). JR-BUILD (`build here`, idkcraft-d7i) completes on green but
never asks the recover menu either (eps 0), so it is a build gate, not
a budget carrier. The common cause: the only deterministic
fail-then-rescue shape (S6: `dig_up` fails, `dig_step` rescues) OPENS
its wedge — the failed dig digs the void a post-gave-up re-plan walks —
so every order that re-plans after a gave-up still delivers.

S6-LEAD (idkcraft-au4j) is the order that does not re-plan. `find me
emerald_block` leads to a block the prep plants in the S6 brow
(`setblock -47 63 -231 emerald_block` — one block the order can name,
none other within 48), from S6-PIT's spawn. Green: the lead wedges under
the brow, the menu fails `dig_up`, rescues with a `dig_step` chain, and
the lead arrives (`here: emerald_block …`; eps 1, 0 pages). A lead
episode that gives up (`release`, `by=lead`) drops `ctx.lead` itself —
no re-issue, no `here:` ever — so `MAX_FAILS=0` pages after the failed
`dig_up`, the order dies, and the window times out: `BASELINE S6-LEAD …
REGRESSION (unreached (was reached))`, exit 1 (proven, see the au4j
PR). Dug terrain persists across spots, and both shapes dig the same
brow: a second lead in a row ran eps 0, and a lead before S6-PIT once
walked S6-PIT out of its wedge (eps 0, 5 s). So S6-LEAD runs after
S6-PIT and its prep first restores the pristine brow (26 `fill`s over
x -50..-43 y 61..66 z -232..-224, read from `world.tar`; grass folds
into dirt, short grass into air) before planting the target. The guide
parks on open ground east of the pit (-43 64 -224), not on S6-PIT's
goal: that goal is inside the hill, and a guide parked there suffocated
~85 s into every sabotage window (`GUIDE-DIED` → exit 2, never the
flip — green windows end at ~80 s and hid it). The
recover budget is now guarded twice — S6-PIT by the page (`maxCalls`),
S6-LEAD by the lost order (`reached`).

## Corpus rules

`stuck-spots.json` is the corpus. Spot shape:

```json
{"name": "EP1", "spawn": [-61.3, 66, -210.5], "goal": [-72, 65, -218],
 "secs": 75, "scaffold": 64, "pickaxe": true, "bucket": false, "bead": "idkcraft-4rz"}
```

- `spawn`/`goal` are prod coords on the snapshot; `secs`/`scaffold`/
  `pickaxe`/`bucket` are the per-spot kit (66 dirt default, stone pickaxe,
  water-bucket pair for `water_up` spots). `kit` (idkcraft-6x7.10) is an
  optional list of extra `"<item> <count>"` give-strings (a seeded house
  BOM): item `[a-z_]+`, count 1..2304 (one give carries many stacks) —
  validated like `prep`, issued one `give` per entry after the standard
  kit. Omit it for an unseeded run.
- Every closed movement bead adds its prod coords as a spot (with `bead`)
  PLUS the measured baseline entry — one without the other fails the gate
  (`NO BASELINE ENTRY` → exit 1) or `npm test`.
- Order spots (`mode: "order"`) replay a work order instead of a follow
  walk:

```json
{"name": "ATL-SHAFT", "mode": "order", "spawn": [59.5, 64, -205.5],
 "goal": [62.5, 64, -205.5], "order": "bring me iron_ore 2",
 "expect": ["here is ", "here are "], "fail": ["could not ", "…"]}
```

  `goal` is the guide's park point (the delivery point — keep it near the
  spawn); `order` is the guide's chat at window start; `expect`/`fail`
  are substring markers over follower chat (the first hit ends the
  window). Markers are per-order-kind data: every one must be terminal
  for THAT order — a bring's `here are` delivers, but its `I can't see
  you` only waits and must never be a `fail` marker (the committed
  markers are pinned against the real behaviour chat lines in
  `test/stuck-oracle.test.js`).
- Exact markers (idkcraft-6x7.8): a `=` prefix matches the full line
  only. `come home` arrives with a bare `home` while its refusals read
  `cannot reach home…` — a substring expect would verdict a refusal as
  delivered (fail-open), so Q0H-PIT expects `=home`.
- JR-SLOPE is a slope bring (`bring me acacia_log 1`): it spawns AT the
  jr2.4 site (-145 72 -78) and works the slope acacias (an ore bring
  ranged 20 blocks east off-terrain and was rejected in review). (The
  jr2.4 approach-loop fix itself is pinned by unit tests; the oracle
  guards the terrain, not the bug.)
- JR-BUILD is the build gate (idkcraft-d7i): `build here` on the same
  slope, expect `home done at`. Seeded since idkcraft-6x7.10 (was
  from-scratch: 496-671 s of a 900 s window, ±90 s of gather noise): the
  `kit` carries the v2 house BOM (107 acacia planks = `needPlanks`, a
  crafting table and an acacia door), so gather is skipped but
  craft/equip/build still run — the spot gates build completion
  (partition, door, roof placed, no wedge/page) in ~220 s of a 300 s
  window, not the partition order (a partition-first revert still
  completes: doors open since 6xno). Before d7i the order stalled
  inside the house and paged every run; the fix made it complete
  deterministically, so the completion pin holds (`reached: true`,
  `maxCalls: 0`). The from-scratch gather stays runnable via a kit-less
  temp spots file (it is 6x7.14's territory, not the oracle's).
  JR-BUILD-FRESH, the unseeded twin at the same spawn/goal, carries a prep
  air-fill over the house footprint (idkcraft-vmzq.13): without it the order
  sites on the flat roof of JR-BUILD's standing house (-144 75 -77) instead
  of the measured ground site, and the roof build TIMED OUT once (stuck 31).
  Pristine reads air + grass in the volume, so the fill is a no-op alone.
  Its first-run fails (idkcraft-6x7.20, batch 10abbe1 stuck 8 TIMEOUT; also
  seen in single runs) were not rig noise: a wall-base cell skipped
  `unreachable` while the body sat in its own scaffold-dig pit, the cells
  above it followed `no-ref`, and the 1h skip re-probe outlived the 30-min
  window (with every other cell placed, the build menu gate read the hole
  as given up and never re-picked build). Since 6x7.20 each stamped skip
  gets one last-pass retry once the rest stands, in the build step and in
  the gate (`build holes: retrying N`); the ceiling is unchanged.
- Q0H-PIT is a `come home` to a rig-built house (`house: [x, y, z]`,
  idkcraft-6x7.8): the snapshot holds no adoptable house near the pit
  (measured: doors stand but the table cell + quorum reject every one),
  so the setup raises a plan-driven v2 house (`raise-house.js`, cells
  from the real blueprint) at the q0h rim site. Rest itself has no chat
  order and never wins the work menu deterministically, so the order
  walks the same trap terrain (pit → rim home) as a meet instead.
- S6-LEAD (idkcraft-au4j) is the recover-budget order carrier (see
  Sensitivity): a `find me` lead to a prep-planted block — the order
  names a block nothing else within 48 is made of, so the lead target is
  fixed. Markers: `here: emerald_block` delivers; `cannot reach `,
  `giving up on `, the not-found and too-deep answers fail. A lead keeps
  follow, so it may sit among the follow spots — it stays right after
  S6-PIT, prep restoring the brow both dig (pinned in
  `test/stuck-oracle.test.js`).
- Follow-revoking orders (`build here`, `come home`) stay after all
  follow spots: they clear the live follow target with no per-spot
  re-arm (pinned in `test/stuck-oracle.test.js`).
- ATL-SHAFT orders `bring me iron_ore 2`, not the bare order: the pristine
  shaft vein holds exactly 2 (probed from `world.tar`), and want=3 would
  send the bot hunting a second vein 15+ blocks off-terrain — slower and
  flakier, for no extra shaft-loop coverage (the atl.17/atl.20 below-feet
  stance is exercised by the first ore).
- `prep` (idkcraft-jsf.7): optional list of rcon world edits — `fill`/
  `setblock` only (no `give`/`op`/`tp`: kit and state stay in the spot
  contract) — run every trial after both tps (chunks loaded) and before
  the kit. A failed command exits 2 (`No blocks were filled` is the
  idempotent re-run, not a failure). It builds a fixture the pristine
  map lacks, on the disposable copy only — never on `world.tar`.
- DUGPIT-BARE / DUGPIT-VALIDATE (idkcraft-jsf.2/jsf.7) are the water_up
  carriers. CLUSTER-BARE and SHAFT-BARE are walked out after ik7 (no
  recover runs there), so no prod-map spot exercised water_up. The prep
  rebuilds muse-5's rig arena (read back from its rig world): drain the
  pond around it, clear the ring x -56..-45 z -206..-197 above y59,
  2-thick obsidian walls y57-62 around a 4x4 interior x -52..-49
  z -202..-199, bedrock floor y56, and a 1x2x4 notch in the east wall
  (x -48 y62-63 z -202..-199 — natural pits have ledges; a flat sheer pit
  has no ledge-pour site and water_up rightly declines it). No pickaxe,
  no scaffold: the only way out is the water climb.
  BARE (2 buckets) must escape; VALIDATE (no buckets, same arena) must
  NOT and must page once. A water spot without its control is a vacuum:
  if the trap leaked, BARE would reach by walking and a broken water_up
  would still pass. Both stay before the follow-revoking orders; the
  arena persists in the world for the later spots (they sit outside the
  ring).
- SPAWN-BARE (idkcraft-ed88) is a shelter spot (`mode: "shelter"`):
  the prod respawn body by world spawn (bare stone), empty kit,
  `time set 18000`, a built home injected as `ctx.home` at `home` (far
  past the night walk range, never raised), the guide parked out of entity
  range on `goal`, then `go work` from the guide. Shelter picks the night-far
  step, the pillar fails no-scaffold, and dig-in walks to the nearest
  hand-dig column and closes itself in. `reached` = floor, 4 sides at feet
  and head, and a cap, all solid within the close budget (15 s default,
  `closeSecs` overrides — idkcraft-hoy7), and alive at the window end
  (the window always runs its full `secs`). The row note reads
  `CLOSED <s>s` or `OPEN at <x y z>`. It chats `go work` (follow-revoking),
  so it stays after every follow spot. Budget `closeSecs: 25`
  (idkcraft-bn4d): v2 closes in 13 brain ticks fresh (13-14 s), but after
  a long spot (JR-BUILD-FRESH) the body client hand-digs ~40% slower
  (`shelter-trace dig` 0.9-1.0 s -> 1.26-1.49 s per cell, brain tick period
  unchanged ~1.0 s), each dig spills one more tick, 15-19 s — the 15 s
  default flipped on spot order, not code. Shelter windows print
  `shelter-trace` lines (phase changes, per-dig wall time, ticks and tick
  cost at close) to tell a slow body from a slow brain.
- SHELTER-WATER (idkcraft-yrtx, via idkcraft-hoy7) spawns floating in prod
  water by the yrtx drowned death (103 62 -420): shelter must swim to the
  shore before it digs in. Swim + dig closes 18-24 s (stuck 1-2: beaching
  trips stuck resets), past the stand-and-dig budget, so the spot carries
  `closeSecs: 45` (`secs: 60`): v2 closes 26-32 s, which the old 35 left
  3 s of slack (idkcraft-neuc.47). On pre-#293 code the dig-in fails
  `airborne` and the window stays OPEN.
- Night spots (`mode: "night"`, idkcraft-6x7.17) are the house-at-night
  family: the shelter setup (`time set 18000`, `home` injected as
  `ctx.home`, guide parked out of entity range on `goal`, `go work`) at a
  rig-raised house — `home` must equal `house` (one site) — judged by
  order markers (`expect`/`fail`, no `order`; the window ends on the first
  hit, `time set 1000` after). `after` (optional, `fill`/`setblock` only,
  ≤32, needs a `house`) runs AFTER `raiseHouse`, whose air fill would
  erase a `prep` bed or bump. Markers are chat lines only (`shelter dig-in
  done` and `failed:cannot-reach-home` are a log line and a step status —
  a yard dig-in reads as TIMEOUT). HOUSE-NIGHT: the clean house with bed A
  set by `after`, expects `sleeping in my bed`. HOUSE-BUMP (idkcraft-rw4.19
  prod repro): dirt behind the door (`ox+3 oy oz+1`) and on bed A's foot
  (`ox+1 oy oz+4`, so no bed stands — the kit carries `red_bed 1`, as in
  prod). Both `prep` a flat approach in front of the HOME-* house site
  (filling HOME-PIT-DEEP's pit in-corpus) and stay last (`go work` revokes
  follow).

## Head-to-head tasks (`task-spots.json`, idkcraft-wh80)

Same two tasks as `baritone/tasks.json`, judged the same way, not part of the
gate (no baseline entries):
`REPLAY_BASELINE_OFF=1 sh bot/tools/stuck-run.sh paper-base bot/tools/task-spots.json`.
BED-60 is a follow spot (reached within 2.5 of the goal in 3D, or within 6 of
the guide parked ~6 past it — looser than ab.js's XZ-only 2.5; the runs
walked 61-64 blocks, i.e. to the goal); MINE-10 is an order spot with a
`count`/`item` judge: peak `item` held by follower+guide >= `count` (the bot
hands finds to the guide), instead of a chat marker.

## Planted-thing verdict (`verify`, idkcraft-vf8e.18)

An order spot may carry a data-driven world check for "build/plant
something" orders — the mirror of `verifyBuild` over any block list, not
the house blueprint:

```json
{"name": "PARK-1", "mode": "order", "spawn": [0, 64, 0], "goal": [1, 64, 0],
 "order": "plant the park", "expect": ["park done"], "fail": ["could not "],
 "verify": {"blocks": ["oak_sapling", "birch_sapling"], "around": "goal",
  "radius": 3, "dy": 1, "min": 10, "gap": 2}}
```

After the chat verdict (at the terminal verdict, where `applyBuildVerify`
runs) the replay counts wanted `blocks` in the box `|dx|,|dz| <= radius`,
`|dy| <= dy` around `around` (`"goal"` = the spot goal, else `[x, y, z]`)
from the follower's world and demotes a chat-done to `reached: false` with
note `PARTIAL found=<n>/<min> close=<pairs>` when fewer than `min` stand or
any pair sits at Chebyshev distance `< gap` (gap 2 = no two in touching
cells, the "trees can grow" rule; gap 1 = any). The reached-by-chat verdict
stays required: `verify` only demotes, never promotes. Order mode only;
`blocks` must name real blocks, `min >= 1`, `radius <= 16` — anything else
throws naming the spot. `radius`/`dy`/`gap` default to 3/1/2. The row keeps
`verifyFound`/`verifyMin`/`verifyClose` next to the note, so the replay
table and the skill-loop feedback show the demotion (`rowGreen` reads it RED
with no change).

## LLM orders A/B (`llm-order-spots.json`, idkcraft-vf8e.6)

Three free-form orders the FSM refuses or ignores (TORCH-8, WATER-1,
LIGHT-HOUSE) plus MINE-10/MINE-7 forced through the planner (`plan bring me
…`), judged like task-spots (markers / `count`). `BOT_LLM_ORDERS=1` loads the
key from stash like `REPLAY_PLANNER=llm`; without it the same file is the
FSM side (the new orders fail/time out, the MINE pair refuses `plan`):

```sh
BOT_LLM_ORDERS=1 REPLAY_BASELINE_OFF=1 sh bot/tools/stuck-run.sh paper-base bot/tools/llm-order-spots.json
REPLAY_BASELINE_OFF=1 sh bot/tools/stuck-run.sh paper-base bot/tools/task-spots.json   # FSM MINE-10/MINE-7
```

An order spot may carry `home` (injected built home, as night spots do);
the window cut drops `llmOrder`/`llmAsk`/`taskPlanStep`.

## Worker runs (`REPLAY_WORKER=1`, idkcraft-jlda.3)

Runs the head with the Baritone worker beside it — the measurable harness
for the delegation beads (guided dig-in, guided far walk):

```sh
REPLAY_WORKER=1 REPLAY_BASELINE_OFF=1 BOT=<worker name> sh bot/tools/stuck-run.sh paper-base bot/tools/task-spots.json
sh bot/tools/stuck-run.sh   # head-only: unchanged, byte-identical flow
```

Before the replay, the wrapper launches the worker client
(`baritone/client.sh`, offline under its own name — `BOT` overrides the
default, never the owner's account) on the run's own slot, pre-opped
(spawn protection is decided at login); the client log lands next to the
run log. Per spot the replay stops the worker over its bridge, parks it
next to the follower's spawn with a pickaxe and the same anti-noise
effects; rows carry `worker: true` (in the tab list at the window end).
The baseline is forced off (worker rows are never compared), and the run
exits 2 when the worker never joins. One worker client per box (a second
`REPLAY_WORKER` run fails loud at the already-running guard).

## v2 body runs (`REPLAY_BODY=baritone`, idkcraft-neuc.5/.15/.23)

Runs the FOLLOWER on the Baritone body — the regression gate for the v2
epic (idkcraft-neuc). The wrapper pre-ops the follower name, boots the
offline client under it (`baritone/client.sh`, API jar), publishes the
console bridge and the Fabric mod ws, and exports `BOT_BODY=baritone` plus
the `BRIDGE_*` addresses for the replay; the replay builds the follower via
`bot/src/bridge` (the MC address the container connects to is
`REPLAY_BODY_MC_HOST`, default `host.docker.internal`) while the guide stays
mineflayer. The body log lands at `/tmp/stuck-body-<variant>[-<RIG_ID>].log`
(Baritone's `[CHAT] [Baritone] ...` lines prove the goal reached the client).

```sh
# client.sh builds-or-reuses its default image idkcraft-baritone:<baritone/ tree hash>
REPLAY_BODY=baritone sh bot/tools/stuck-run.sh                      # judged against stuck-baseline-v2.json
REPLAY_BODY=baritone RIG_ID=auto RIG_LOCK_WAIT=3600 sh bot/tools/stuck-run.sh   # beside other rig users
REPLAY_BODY=baritone REPLAY_BASELINE_OFF=1 sh bot/tools/stuck-run.sh paper-base bot/tools/task-spots.json
sh bot/tools/stuck-run.sh   # v1 (`BOT_BODY` unset): unchanged, byte-identical flow, stuck-baseline.json
```

**Merge gate** (CLAUDE.md "v2 merge gate"): v2 PRs run no rig legs; the batch on
master judges the lay/mine pair, the 90-min castle throughput (cells/90 min,
house done-seconds, deaths/night) and the v2 stuck-run vs the recorded
baselines, not on stuck spots. The v2 stuck-run above is a regression check only (not worse).

- **Image** (idkcraft-neuc.23, 6x7.28): `client.sh` defaults to
  `idkcraft-baritone:<git rev-parse --short=8 HEAD:baritone>` of the checkout
  it runs from (the tag CI uses on ghcr) and builds it when missing — so a
  before (master) and an after (PR) worktree each run their own body, and
  trees sharing `baritone/` share one image. Uncommitted `baritone/` edits
  refuse (exit 2): commit them or pass `BARITONE_IMAGE=<tag>` (an explicit
  tag is never built). The Dockerfile's warm layer bakes the first launch's
  libraries + assets in (~+600 MB), so the client is up in ~25 s with no
  downloads. The old `:spike` default had no mod: the body joined, the ws
  never opened.
- **Per slot** (idkcraft-neuc.23): on `RIG_ID=<a-z>` the body container is
  `idk-baritone-body-<id>` and the ports shift by 2 x letter index
  (default rig 7778/7779, a=7780/7781, z=7830/7831 — `baritone/bridge/rig.sh`
  uses z), so parallel v2 runs never collide. `BODY_CLIENT`, `MOD_PORT`,
  `BODY_CONSOLE_PORT` still override. The worker (`REPLAY_WORKER=1`) keeps
  one fixed name/port: one worker per box.
- **Baseline** (idkcraft-neuc.15): `BOT_BODY=baritone` makes the replay
  judge against `stuck-baseline-v2.json` (`REPLAY_BASELINE` still wins); the
  v1 file is never read by a v2 run and never edited for one. The flake
  rerun relaunches the body client after the fresh boot. The v2 file is
  recorded like v1 (worse of two full runs: reached = both, stuck + 2,
  episodes + 1, calls strict) and may cover a SUBSET of the corpus while v2
  is incomplete (`npm test`: no dangling entry, well-formed, and every spot
  v1 reaches but v2 does not names its `blockedBy` bead plus a `why`). A
  `blockedBy` spot reached on a later run prints `IMPROVED`: re-record both
  runs and drop the annotation in the PR that fixed it.
- **Known flakes** (idkcraft-neuc.47): a reached entry may carry `flaky`
  (the bead owning the failure mode) plus `flakyWhy` (the measurement).
  Annotation only — the judge ignores it and the rerun protocol is
  unchanged; it says which `FLAKY` lines are known (DOOR-ROOM: door-cell
  wedge, neuc.48; SHELTER-WATER: no-cap-ref after the swim, neuc.49). A
  `FLAKY` on any other spot is news: measure it N=5 before calling it
  noise (neuc.47's JR-BUILD "flake" was a plank shortfall, fixed).
- `BOT_AUTONOMOUS` takes `1`/`true`/`yes` — `on` reads as off (bot/src
  `parseAutonomous`; chat `autonomous on` is the in-game toggle).

### v1 vs v2 (2026-10-13, rig, offline names)

v2 on master f0f6dd63 (incl. neuc.30) with the body image built from it; v1
on be078570 (neuc.30 touched only `bot/src/bridge` and the mod — no v1
path). Per-spot table: the neuc.15 PR body.

| | v1 (mineflayer) | v2 (Baritone body) |
|---|---|---|
| corpus reached (32) | 30 | 24 and 23 (baseline: 22, worse of two) |
| BED-60 (3 runs) | 3/3, 24-25 s | 3/3, 21-22 s |
| MINE-10 (3 runs) | 3/3, 161-163 s | 3/3, 107-109 s |
| ATL-SHAFT order | 34 s, delivery 6 s after the last ore | 24-25 s, delivery 6 s after |
| lost-shaft / deep unfreeze lines | 0 | 0 |
| client CPU (mean) | node 15-17 % | node 8-10 % + body JVM 28-100 % |
| client memory (mean / max) | node ~205 / 334 MiB | node ~150 / 282 MiB + body 2.1-2.2 / 2.6 GiB (corpus), 1.55 / 2.0 GiB (tasks) |

v2 gaps (beads): DUGPIT-BARE closed (neuc.34: a wedge off the combo column walks to the
stand first, v2 only; re-recorded reached),
JR-BUILD / JR-BUILD-FRESH / SHELTER-WATER closed (re-recorded reached by neuc.46),
MOAT-EXIT / HOME-PIT / HOME-ROOF / HOME-PIT-DEEP (neuc.33, order answered
before the post-tp chunk cache fills). DROWNED-SHORE went through the
drowned disc (closest 3.5-9.9) until neuc.25 sent the water-death discs to
Baritone (PROTOCOL.md "Danger discs on goals"): closest 31.1 on 3/3 runs,
v2 `minDanger` 30 = the v1 floor. The 2.6 GiB corpus peak above was an UNCAPPED rig
client (heap sizes to host RAM). Under the compose cap (`BARITONE_MEM=2500m`
on `client.sh`, = `BODY2_MEM_LIMIT`) the JVM's max heap is 25 % of it
(~626 MiB) and the full 32-spot corpus measured 1.58 GiB mean / 1.60 GiB
peak (`docker stats`, 2.44 GiB limit; uncapped on the same box: 1.82 / 2.13)
— no OOM, no JVM flags (idkcraft-neuc.38). `stuck-run.sh` now defaults the body to
`BARITONE_MEM=2500m` (`BARITONE_MEM=` empty = uncapped). Deep return: the diamond leg (`deep.js`, where `lost-shaft`
lives) runs on none of these orders; ATL-SHAFT's iron shaft is shallow, and
MINE-10's count judge ends the window before the walk back.

## `REPLAY_BRAIN=laya`

Runs the follower on the shipped hybrid brain (FSM primary, model on hard
states only) against the PROD sidecar — reached read-only through the
operator's tunnel at `REPLAY_BRAIN_URL`, sequential single-bot calls, the
same inference-only shape the stands use. Never point it at a local stand
for evals (owner direction). It measures menu choice, not just the FSM.

## Why the wrapper does what it does

- Pre-op (`op` both bot names, asserted): the spawn-cluster spots sit inside
  spawn-protection r=16, and Paper enforces protection once `ops.json` is
  non-empty — one stray op armed it mid-day and the baseline collapsed to
  3/10 with no code change (3ro). The replay re-ops post-spawn as the
  asserted guarantee.
- Anti-noise (`difficulty peaceful`, `fall_damage`/`advance_weather`
  snake_case, `weather clear` — every call asserted): Paper 26.1 renamed
  gamerules to snake_case and the old camelCase fails; a silent redirect
  once hid the dead rules and every run measured a noisier game (3ro).
- Same-IP login gap: Paper's connection throttle kicks a second login
  inside its window, so the follower waits past it before joining.
- Dirty-baseline guards: `GUIDE-BURIED` / `GUIDE-DIED` rows (guide tp'd
  into rock or dead) skip the comparison and force exit 2 — the bot was
  never measured, so judging them as regressions would block PRs on rig
  luck; a bucket spot's flood is wiped before the next trial.

## Parallel rigs (`RIG_ID`)

One run per rig; the default rig is unchanged. `RIG_ID=a` (any letter
a-z) is a second rig: container `idk-replay-<id>`, host port 25571 + letter
index (a=25572, b=25573), lock `$RIG_LOCK-<id>`, data under
`$PRODWORLD/rigs/<id>/` (seeded once from the default rig minus `world/`
and `logs/`; `rm -rf` it to reseed). Its `START.sh` is derived from the
real one each run (container and port renamed only), so image and flags
never drift. `RIG_ID=auto` takes the first free of `RIG_SLOTS` (default
`0 a b`, `0` = default rig) — use it when several agents share the box.
Each Paper takes ~1.5 GB; three fit Docker's 8 GB next to the stand. Runs
from one worktree in parallel need distinct `REPLAY_OUT`.

## Micro-rig (`REPLAY_KEEP=1`, idkcraft-vf8e.1)

One scenario, one verdict, the server stays up — the inner loop for a
skill attempt (human or LLM), not a gate:

```sh
# keeper: lock, reset, boot, run the spots once, then hold the rig up
REPLAY_KEEP=1 RIG_ID=auto sh bot/tools/stuck-run.sh paper-base spots.json &
# inner runs (any worktree), AFTER the keeper printed `kept: rig <id> up`:
REPLAY_KEEP=1 RIG_ID=<id> sh bot/tools/stuck-run.sh paper-base spots.json
```

An inner call made before `kept:` finds no published rig and falls through
to the normal path — with `RIG_ID=auto` that boots and keeps a SECOND rig.

The keeper holds the rig lock and publishes the rig in `$RIG_LOCK/keep.env`
(tag, container, port, v2/worker bridge env). A `REPLAY_KEEP=1` call that
finds a live keeper on its slot (`RIG_ID=auto` = the first kept one) is an
inner run: no lock (the RIG_LOCK_HELD contract), no world reset, no boot,
no flake rerun — one fresh `stuck-replay.js` process (the bot code of the
calling tree, reloaded), the same table/`BASELINE` lines and exit code as
a gate run, then `micro-run: exit <rc> in <s>s`. Inner runs serialise on
`$RIG_LOCK/run`. The arena reset is each spot's own prep/tp/kit — so only
spots whose `prep` rebuilds the terrain they dig are repeatable (DUGPIT-*,
S6-LEAD, the rig-built houses); a dug follow spot stays dug. The keeper
tears down on INT/TERM or after `REPLAY_KEEP_IDLE` seconds (default 1800)
with no inner run. `REPLAY_SKILLS_DIR=<dir>` exports `SKILLS_DIR` +
`BOT_SKILLS=1` to the bot (keep mode only; read by the skill runtime,
idkcraft-vf8e.2).

Sabotage knob: `"sabotage": "<primitive>"` on a spot removes that
`RECOVER_MENU` entry for its window only (validated against the menu), so
a scenario can demand a new skill instead of the hand primitive — the
hand sabotages above, as data. A goal `MENU` step name (`"shelter"`,
idkcraft-vf8e.3) is made infeasible for the window instead (kept in the
menu: index.js reads `MENU.shelter.feasible` directly). Any mode, gate runs included; the corpus
carries none.

Measured (2026-10-18, v1, DUGPIT-BARE on a kept rig): runs 2 and 3
`micro-run: exit 0 in 72s` / `73s` (59 s window, `water_bucket 2/2`,
`baseline: 1/1 ok`) vs ~2.5 min for the keeper's boot + first run;
`sabotage: "water_up"` → sidestep fails, one page, `BASELINE DUGPIT-BARE …
REGRESSION (unreached (was reached))`, exit 1 in 105 s — the
`BUCKETS_NEEDED=3` outcome. Inner runs inherit the rig's world, so the
follower's inventory from the last run is still there until the kit's
`clear`.

## Skill loop (`skill-loop.js`, idkcraft-vf8e.3)

A Voyager-style loop on our stack. A scenario (`skill-scenarios.json`) is a corpus spot plus
a sabotaged hand primitive or goal step. The model writes the missing skill. The micro-rig
is the critic: one Messages API call per attempt (our own loop through `brain.llmCall`, so
the vf8e.5 budget applies; no `claude -p`), then one inner micro-run, green = exit 0.

```sh
node bot/tools/skill-loop.js water-climb 6   # key: ANTHROPIC_API_KEY or stash; never printed
```

- Work dir `SKILL_LOOP_DIR` (default `/tmp/idkcraft-skill-loop/<scenario>`) holds:
  `attempt-N.js` / `.log`, `result.json`.
- Knobs: `SKILL_LOOP_MODEL` (default `claude-opus-5-5`), `SKILL_LOOP_EFFORT` (default
  `medium`), max_tokens 32000.
- A green skill stays in `<work dir>/skills/` and is not promoted (vf8e.4).

### Spike numbers (2026-10-19, v1, laptop rig, claude-opus-5-5 effort medium)

| scenario (spot, sabotage) | attempts | wall | tokens in/out | cost | verdict |
|---|---|---|---|---|---|
| water-climb (DUGPIT-BARE, `water_up`) | 3 (1 = network `fetch failed`, 300 s) | 825 s | 16,325 / 18,709 | $0.44 | GREEN |
| brow-step (S6-LEAD, `dig_step`) | 1 | 388 s | 7,449 / 7,358 | $0.18 | GREEN |
| night-dig-in (SPAWN-BARE, `shelter`) | 6 | 1203 s | 50,223 / 44,518 | $1.09 | RED |

Result: 2/3 green within 6 attempts, $1.71 for the run above. The whole spike, including
the pre-fix run and the discarded attempts, cost about $3.86.

The first run, on the runtime as merged, went 0 for 2:

- water-climb was RED after 6 attempts (54,758 / 65,807 tokens, $1.53).
- brow-step's skill was never offered.

Each gap below is a runtime fix in this PR. All of them are no-ops with `BOT_SKILLS` off.

- **Buckets.** Pouring needs look-at plus use-item (`waterup.js`); `place()` cannot pour.
  The new facade act `use(x,y,z)` covers a held bucket only.
- **9sh page rule.** The rule (`recoverFsm`: `dig_up` failed, no hand climber) paged
  `call_player` before the skills loop could run. A feasible skill now blocks the early page.
- **Step order.** A step skill was inserted before `rest`, so the FSM always picked
  `gather` first at night. The header `before` now places it ahead of a named hand step,
  never at or above `shelter`.
- **Effort.** `effort: high` used the whole 16k max_tokens on thinking (164 s, no answer).
  The defaults are now medium and 32k.

night-dig-in stays RED for a structural reason:

- The hand dig-in uses its own veto (`digInVeto`).
- The facade `dig` goes through `util.denyReason`. Its `below-feet` self-trap rule refuses
  digging under a walled bot, which is the core move of a dig-in.
- Attempts 3-6 hit `dig-denied` and then `no-spot`.
- This spike does not loosen a safety rule for generated code. A step-skill dig-in needs a
  facade dig-in act first.

Human pipeline cost of the same fixes (git and revmux archives; developer tokens were not
recorded per bead):

| fix | PRs | diff | calendar | revmux |
|---|---|---|---|---|
| water_up (jsf.2/.3/.6/.7) | 4 (+ neuc.34) | +3,224/-61 | ~4 days | ~9 rounds, ~4.9M cache-read |
| dig_step S6 rescue (au4j, 6x7.11) | 2 | +215/-28 | ~15 h | 3 rounds, ~1.6M cache-read |
| shelter dig-in (ed88, hoy7, bn4d) | 3 | +824/-30 | ed88 7.8 h; thread 15 days | ed88: 3 rounds, ~4.4M cache-read |

Gates with the two green skills loaded (`BOT_SKILLS=1`, no sabotage; `skills loaded n=2` in
each bot log):

| gate | result | verdict |
|---|---|---|
| full `stuck-run.sh` | `baseline: 32/32 ok, 0 improved, 0 regressed`, exit 0 | no regression |
| lay (v2, 10 game-min) | 75.4/game-min, baseline 76.5 (-1%) | within |
| mine (v2, 10 game-min, 3 runs) | 20.0, 35.3, 30.0 = mean 28.4, baseline 29.4 (-3%) | within |
| `work-rig.sh 20` | nights=5 slept=5 inside=4 deaths=1 banked=18/h | report only (no recorded baseline) |

Notes on the gates:

- **mine.** A single mine run is too noisy to judge alone. The 20.0 run had no recover episode
  at all, and the cached master run at the base sha read 37.2 (+27%).
- **Skills in the corpus.** In all 32 spots, the only skill run was `gen_brow_step` once in
  the DUGPIT area: `failed:no-dir` in 5 ticks, then the hand chain went on.
- **Decision rule.** Met: 2/3 green within 6 attempts, and no regression on the three gates.
  vf8e.4 and vf8e.6 proceed.

## Skill promotion (`skill-promote.js`, idkcraft-vf8e.4)

A green skill reaches prod only as a generated PR with the same gates as a hand movement PR.

```sh
# 1. fresh verdict on this tree and body, no model call (the file is attempt 1)
REPLAY_BODY=baritone SKILL_LOOP_VERIFY=<work>/skills/<name>.js SKILL_LOOP_DIR=<new dir> \
  node bot/tools/skill-loop.js <scenario> 1
# 2. promote one or more verified skills (from a committed tree)
REPLAY_BODY=baritone node bot/tools/skill-promote.js <bead> <new dir>/skills/<name>.js...
```

`skill-promote.js`:

1. Refuses unless `<dir>/result.json` is green for that skill, with a clean `sha` and the
   `body` the gates run on (`REPLAY_BODY`), and the green attempt's log shows
   `skill run skill=<name> ... outcome=done`. A green run that never needed the skill proves
   nothing (v2 on S6-LEAD never wedges, so `gen_brow_step` stays unpromoted).
2. Copies the skill to `bot/skills/<name>.js` with `verifiedBy {scenario, verdict, sha, body}`
   and `bead` in the header.
3. Runs the gates with the copies loaded from `bot/skills` (`BOT_SKILLS=1`, no `SKILLS_DIR`):
   the full `stuck-run.sh` on the caller's `REPLAY_BODY` (exit != 0 = refused, no PR), then
   `CASTLE_BODY=baritone CASTLE_PADSPOT=250,350` (the baseline's setup) with one `lay` leg and
   three `mine` legs, quoted with the mean vs `component-baseline.json` (more than 15% down =
   `REGRESSION`; review judges). A skills-loaded leg is never cached as master's before
   (`castle-before.js` gate knobs). `RIG_LOCK_WAIT`/`CASTLE_LOCK_WAIT` default to 7200.
4. Branch `<bead>-skill-<names>`, commit, push, draft PR labelled `generated-skill`. The body
   carries the micro-rig verdicts, the stuck-run table and exit, the two component lines and the
   branch's commit subjects, local paths scrubbed.

The tool takes about the stuck-run plus four 10-minute component rigs. A refusal leaves the
copies in `bot/skills/` to inspect. Prod switches (`BOT_SKILLS`/`BOT2_SKILLS`, chat
`skills off`, the 3-fail auto-ban): `bot/skills/README.md`.

## Curriculum (`curriculum.js`, idkcraft-vf8e.9)

What the skill loop learns next is prod's failure log ranked by what the owner sees, not
Voyager's novelty list. Offline: the tool reads dump files only (no host, token or container
id in it).

```sh
node bot/tools/curriculum.js harvest bot.txt mc.txt [days=7]   # table + curriculum.json
node bot/tools/curriculum.js propose <sig>                     # AUTO-<sig>/spots.json + scenario.json
```

- Input lines are `YYYY-MM-DD HH:MM:SS <name> <msg>` (UTC), as for `deaths.sh`. The bot dump
  is the VictoriaLogs query `container_name:idkcraft-bot2 "recover action="`, printed as
  `_time <bot name> _msg` (wider: `idkcraft-bot*`/`idkcraft-swarm*` plus `CURRICULUM_BOTS`).
  The mc dump is `container_name:idkcraft-mc ("can't make" or "can't get")`. A raw shipped mc
  line works as is, because the bot name is read from `<Name>`. Strip IPs as session-review
  does. Credentials: see "Deaths per day".
- Families (owner 2026-10-19: the simplest first):
  - `page`: a recover episode that chose `call_player` or ended `gave-up`. The reason is the
    last failed hand primitive plus its outcome. The position is the end pos in an 8-block cell.
  - `bring`: a bring order refused for a recipe gap: the bot's own chat line
    `can't get <item>: no recipe, no source` or `can't make <item>: need …|no recipe|crafting failed`.
    The bot never logs its own chat, so these come from the mc log.
  - step-fail, park and `castlefetch-*` are vf8e.11.
- Rank = count x weight (page 3, bring 2). `days` counts back from the newest line in the dump.
- Bots: `CURRICULUM_BOTS` is a comma list or `all`. The default is `BOT2_USERNAME`, else
  `IdkBotV2` (the owner's feed). `SWARM_PREFIX` names fold into one `swarm` bot.
- Output goes to `CURRICULUM_DIR` (default `/tmp/idkcraft-curriculum`). `TOP` sets the number of
  table rows (default 20).
- `propose` for a page writes a follow spot:
  - spawn = the prod end pos; goal = pos + unit(next - pos) x dist (capped at 16), with y +3, -3
    or 0 from `goal=high|low|level`.
  - `secs` 90; scaffold, pickaxe and bucket come from the facts.
  - A level page whose `next` is unknown (`?:?`, every v2 line) or under half a block away has
    no heading, so it reads `no-dir` and is not proposable.
- `propose` for a bring writes an order spot on the vf8e.6 order flat: `bring me <item>`,
  expect `here is`, fail on the refusal lines, standard kit. Its scenario kind is `step`: there
  is no order-skill kind yet, so vf8e.10 decides how it runs.
- Scenarios carry `sabotage: null`: prod failed with the full menu. They live in the work dir,
  never in `skill-scenarios.json`, because `skill-loop.test.js` pins that file to corpus spots.
- Reproduction gate (printed by `propose`; the runner, vf8e.10, gives the verdict): micro-run
  the spot once WITHOUT a skill. It must be RED (unreached, a page or a refusal). If it is not,
  the candidate is not-reproduced and no model tokens are spent. A `GUIDE-BURIED`/`GUIDE-DIED`
  setup failure is env (not judged), never RED — the runner retries it without spending.

Real harvest (2026-10-12..19 prod dump, default feed IdkBotV2): 206 events, 151 signatures
(147 page, 4 bring), 115 proposable. Top 10 are all pages: counts 20, 8, 7, 6, 6, 3, 2, 2, 2, 2.
Seven are `sidestep:failed:no-progress` and three are `call_player:gave-up`. 3 of the 10 are
proposable; the other 7 are `no-dir` (v2 logs no `next`). The 4 bring signatures, all
proposable: `bone` and `sapling` with no recipe, `andesite` needing diorite, `diorite` needing
quartz. With `CURRICULUM_BOTS=all`: 918 events, 695 signatures (690 page, 5 bring), 637
proposable.

### Nightly runner (`curriculum.sh`, idkcraft-vf8e.10)

The curriculum names what to learn; the runner closes the loop overnight on the laptop rig
(learning never runs on prod): harvest -> pick the top `CURRICULUM_K` (default 2) signatures
that are not in the ledger, or RED in the ledger older than 7 days with a grown count ->
`propose` each into `AUTO-<sig>/` -> one keeper per candidate (`REPLAY_KEEP=1`,
fresh world) -> pre-run WITHOUT skills on it (not RED = `not-reproduced` in the ledger,
no model tokens spent) -> RED = `skill-loop.js <name> 6` with `SKILL_LOOP_SCENARIOS` /
`SKILL_LOOP_SPOTS` pointing at the proposed files and `SKILL_LOOP_RIG` at the keeper
(proposed spots have no baseline entry, so the replay row decides: reached with no page
is green) -> ledger `curriculum-ledger.json` in the work root (never in git). The keeper
is torn down after each candidate; the night ends with one line per candidate plus
`CURRICULUM night=<date> tried=<n> green=<n> red=<n> skipped=<n> cost=$<usd>`.

```sh
sh bot/tools/curriculum.sh bot.txt [days=7]   # laptop, by hand or by the orchestrator
```

- Caps: `CURRICULUM_USD_PER_DAY` (default 30) refuses to START a scenario once today's
  ledger sum reaches it (exit 3 = budget); 6 attempts per scenario
  (`CURRICULUM_MAX_ATTEMPTS`); `LLM_TOKENS_PER_HOUR` still applies inside the loop; 3
  lifetime RED runs parks the signature for a human look. Costs come from the loop's
  `result.json` (the PRICE table there), never re-estimated; a loop exit 2 (keeper never
  kept, network) is not RED and spends no cap.
- Schedule stays manual (owner 2026-10-19): started by hand or by the orchestrator before
  an owner play session / overnight. There is no scheduler and the night job never opens
  PRs: a GREEN candidate ends with a `PROMOTE:` line (the vf8e.4 `skill-promote.js`
  command with scenario, spot and result paths), and the morning promotion runs it by
  hand — its PR carries the verdict lines. The promoter also copies the `AUTO-<sig>`
  spot from the printed spot path into `stuck-spots.json` and records its baseline
  entry (corpus rule: one without the other fails the gate or `npm test`); the
  promote script does not do that step itself.
- Body: the harvest feeds bot2 stalls by default, so set `CURRICULUM_BODY=baritone`
  for a bot2 night — the keeper, the pre-run and the loop then verify on the v2
  body. Empty (default) is the mineflayer replay. The ledger records the body and
  the promotion refuses a body mismatch.
- Rig slot: one (`CURRICULUM_RIG_ID`, default the default rig); `RIG_LOCK_WAIT`
  (default 7200) bounds the keeper boot's wait for a busy rig, then the night is
  skipped (exit 2). Key: `ANTHROPIC_API_KEY` or the stash, never printed.
- Exits: 0 = night done (loop REDs are ledger data, not failures), 2 = environment
  failure with no loop verdict, 3 = budget.

## Castle throughput rig (`castle-rig.sh`, idkcraft-vmzq.20)

```sh
sh bot/tools/castle-rig.sh [mins]   # default 6; gates pass 30+ explicitly
CASTLE_KIT=seeded sh bot/tools/castle-rig.sh 6   # laying, not fetching
CASTLE_KIT=seeded CASTLE_TICK_RATE=60 sh bot/tools/castle-rig.sh 5   # /tick rate 60, 5 GAME min; no speedup for either body (neuc.60, below)
CASTLE_KIT=junk sh bot/tools/castle-rig.sh 5     # vmzq.38: the 36/36 prod junk pack, no pickaxe — must recover and lay
sh bot/tools/castle-rig.sh --night 30            # ek69: natural cycle, hostile nights, one verdict per night
```

`--night` (first arg, or `CASTLE_NIGHT=1`; idkcraft-ek69 — replaces the
hand-rolled night drivers) skips the day lock, sets `time 0` when the
window opens, and per night: `difficulty easy` + 2 phantoms summoned over
the bot at nightfall, `difficulty peaceful` at dawn, then one line
`CASTLE-RIG night <n>: deaths=<d>, sheltered=<yes|no>, steps=<goal steps
held>` (sheltered = a `shelter`/`rest` step at any point of the night; a
night cut by the window end is `(partial)`). The verdict line gains
`, nights=<n>, sheltered=<k>/<n>, night-deaths=<d>` and the record a
`nights` array. Crossings are the replay's resynced clock, so it works at
any `CASTLE_TICKRATE`.

`--night prod` (or `CASTLE_NIGHT=prod`; idkcraft-neuc.65.2) keeps those
per-night lines and changes only the conditions, all from window open:
`difficulty easy` for the whole window (natural spawns, no phantoms, no
peaceful dawn, so day deaths count), `gamerule fall_damage true`, and the
world spawn moved 150 blocks from the pad toward the snapshot's spawn
(`setworldspawn` on the world surface; the snapshot spawn is ~600 off the
pad, prod deaths respawn 100-250 out). keep_inventory stays true, because
prod reads true (2026-10-17; `CASTLE_KEEP_INVENTORY=0` drops the kit on
death instead, which is the bead's family-B assumption), and so does the
rest of the rig (weather locked clear). The verdict line adds `, day-deaths=<window deaths outside
the nights>, kitless=<death lines with sword=0>` after `night-deaths=`.
House variants: `CASTLE_SEED=complete` (castle residence present),
`CASTLE_BARE=1` (no house: home none, then an unbuilt site), and
`CASTLE_BARE=1 CASTLE_HOUSE=clean|bump`, a built v2 house with a bed on
the pad (raise-house.js) as the home. In `bump`, bedrock fills the two
cells behind the door so gohome fails `cannot-reach-home`. Each night then
adds `CASTLE-RIG house-bump night <n>: gohome-fails=<k>, shelter-at=<x y
z|none>, door-dist=<d|none>, deaths=<d>, PASS|FAIL`, where shelter-at is
the last settled `shelter phase` pos and PASS means 8+ blocks from the
door with 0 deaths (neuc.65.3's walk-off). The verdict line gets
`, bump=<pass>/<n>`. In `pit` (neuc.65.6), the 3x2 doorstep is a 6-deep
crater in a stone shell (prod v2 10-16 fell ten times at one cell in front
of its creeper-holed door), and every `--night prod` verdict adds
`, falls=<server fall-death messages for the bot>` (the guide reads them).
Measured (v2, master c541d62e, two 30-min runs): falls=0 both times — the
gohome walk aims at the doorstep cell over the pit, and Baritone bridges it
with scaffold (stands at floor+1 over the crater), so this pit alone does not
reproduce prod's falls. `gallery` (neuc.65.6.1) is prod's real terrain: the
house on a 1-block crust over a void 6 deep (x -8..+12, z -10..+7 off the
site), the doorstep crust cell and the floor beside the table aired, and a
3-wide west ramp of 1-high steps back to the surface. Every `CASTLE_HOUSE`
`--night prod` verdict also adds `, drops=<n>`: landings 4+ below the last
grounded sample within 16 of the house (non-lethal falls; prod died after
~7), each one logged as `CASTLE-RIG drop <n> at <s>s pos <x y z> step=<s>`.
Measured (v2, 30 min): master drops=2 and drops=1 — the gohome enter leg
leaves the body on the doorstep edge and it drops when Baritone resumes
(cannot-reach-home, twice a night); with the doorstep fill cells the
house re-opens, build refills the doorstep in ~2 min, gohome gets in and
drops=0 (one later run drops=1, away from the doorstep: a forage chase off the
crust's north edge into the void, not the house).
The same verdicts add `, door-lost=<n>` (idkcraft-z591): the house door
cell turning into a non-door, each logged as `CASTLE-RIG door-lost <n>
<old>-><new> at <s>s pos <x y z> step=<s>`; every change of the door's sill
(the block under it) logs `CASTLE-RIG sill <old>-><new> at ...`, the
support-break trace. raise-house lays the sill as planks, as v2 builds it.
Baselines are in `night-baseline.json` (master
ed8f1107, one 68-min run each). v1 bare: 3 nights, sheltered 3/3,
night-deaths 0, day-deaths 0, kitless 0. v1 castle (`CASTLE_SEED=complete`;
sleeping skips the night, so it gets 5 nights): night-deaths 1,
day-deaths 2, kitless 3, residence 4/6. v1 house-bump: bump 3/3 with the
door 8/9/9 blocks away, 0 deaths. v2 bare: 3 nights, 0 deaths. On the v2
body (no packet client), the crossings come from the bridge's `bot.time`.
Before neuc.65.2, a `CASTLE_BODY=baritone --night` run never closed a
night.

`CASTLE_SEED=complete` (idkcraft-g0z.33, the g0z.30 "lives in the castle"
acceptance): instead of ordering a castle, setblocks the whole v2 castle
centred on the pad (site = pad centre - 15,-13, rot 0; all 1722 plan
blocks in the bot's paint, keep-clear and moat cells cleared, the gate's
upper half, both bedroom beds and the table on the residence cells), reads
every cell back (one ordered retry, then `SETUP-FAIL seed-castle`), sets
the castle state `complete` and waits for the live adopt
(`residence ... -> castle@...`) plus a memory home `kind=castle` on disk.
No `build castle` order is sent. Every night (dusk to dawn) then logs

```
CASTLE-RIG residence night <n>: entered=yes@<s>s|no, slept=yes|no, shelter=<episodes>, deaths=<d>, dawn-exit=<s>s|pending|n/a
```

at dawn, `dawn-exit=<s>s` when the bot first stands off the residence
floors after it, and the same lines with `, PASS|FAIL` at the window end
(pass = entered + slept + 0 shelter + 0 deaths + a dawn exit; a night cut
by the window is `(partial)` and fails). The bot sleeps alone, so the
server skips the night: that forward clock jump out of the night is a
dawn (`CASTLE-RIG time: dawn ... (sleep skip)`, for `--night` too), and
the 3 nights finish well before 68 min. The verdict line gains
`, seeded=1722/1722, residence=<pass>/<nights>`, the record `seed` and
`residence`. The 3-night acceptance (night 3's dawn lands at 60 min, the
8 extra minutes leave room for the dawn exit):

```sh
CASTLE_SEED=complete CASTLE_RIG_ID=auto sh bot/tools/castle-rig.sh --night 68
```

Pane ladder (g0z.38): `CASTLE_SAND=1` lays a 6x3x6 sand patch just east
of the pad; with the seeded castle the verdict adds `, panes=<laid>/44`
(the bot digs sand, smelts it in the kitchen furnace, crafts and lays):

```sh
CASTLE_SEED=complete CASTLE_KIT=empty CASTLE_SAND=1 CASTLE_RIG_ID=auto sh bot/tools/castle-rig.sh 60
```

Blast self-source (g0z.51): `CASTLE_KIT=blast` carries 5 raw iron + coal
+ cobble (no finished block) and `CASTLE_SEED_DECOR_EXCEPT=blast_furnace`
seeds every other decor cell placed, so the window measures the blast
ladder alone — the full gauntlet's wool hunt walked 85+ blocks out and
pillared the kit cobble away before the blast leg ran (the IDLE_DEATH
drowning, same fix). The verdict's `blast=<laid>/1` reads the kitchen
cell the ladder smelted and crafted itself:

```sh
CASTLE_SEED=complete CASTLE_KIT=blast CASTLE_SEED_DECOR_EXCEPT=blast_furnace CASTLE_RIG_ID=auto sh bot/tools/castle-rig.sh 25
```

Stairs upgrade (g0z.48): `CASTLE_SEED_VERSION=2` seeds the complete
castle as v2 and the guide chats `castle upgrade` after adoption, so the
window measures the stairs relay; `CASTLE_KIT=stairs` carries one cobble
stair per converted cell plus a stone kit and bread. The verdict adds
`, upgrade=<facing-ok>/<total>@<phase>` (rcon readback of every v3
stairs cell) next to the residence nights:

```sh
CASTLE_SEED=complete CASTLE_SEED_VERSION=2 CASTLE_KIT=stairs CASTLE_RIG_ID=auto sh bot/tools/castle-rig.sh --night 68
```

Repair relay (g0z.56): `CASTLE_REPAIR=wood|nowood` knocks out 20 plan
cells of the seeded castle after adoption (12 fence, the door, 4 wall, 3
torches); `wood` puts 16 oak_log in the castle chest, `nowood` leaves it
empty and clears every log within 72. The guide chats `castle repair`
(the reply is logged). The verdict adds `, repair=<relaid>/20@<s>,
regress=<n after the full relay>, nowood@<s>` (first 'no wood' status).
`CASTLE_BODY=baritone` runs the builder on the v2 body (client image
`BARITONE_IMAGE`, ports 7850/7851 + 2 x slot index):

```sh
CASTLE_SEED=complete CASTLE_REPAIR=wood CASTLE_BODY=baritone CASTLE_KIT=blast sh bot/tools/castle-rig.sh 30
```

Start spot (g0z.58): `CASTLE_START="dx,dy,dz"` (off the seeded site's SW
corner) lands the builder in a 1x2 air pocket there after adoption; prod's
g0z.55 tunnel start is `50,-5,31`. `CASTLE_START_CELL=cobble|planks` walls
the pocket in a 3x4x3 shell of that block, marked the bot's own (self-enclosed;
a foreign box is a player build, never dug) plus a stone pickaxe — v2
pathing hard-bans both kinds, so
only an explicit dig gets out. The verdict adds `, start=<d>[/<cell>],
escaped@<s>, home@<s>` (first second in the castle interior) and
`regress=<n>` (castle regress lines over the whole window; 0 = it never
tunnelled through the walls). Pin the pad: the start lands off it, and
an unpinned pick can put the cell under a lake (padspot 250,350 is dry):

```sh
CASTLE_PADSPOT=250,350 CASTLE_SEED=complete CASTLE_BODY=baritone CASTLE_START=50,-5,31 CASTLE_START_CELL=cobble sh bot/tools/castle-rig.sh --night 18
```

Apron diff (g0z.64): `CASTLE_APRON_DIFF=1` (with `CASTLE_SEED=complete`)
clones the apron box (16 around the site, y -4..+16) into the deepslate
under the site after the start spot and, at the window end, bisects
`execute if blocks` to the changed cells. The verdict adds
`, apron-throwaway=<t>, apron-new=<n>(<names>), apron-changed=<m>`: new = cells air at the snapshot,
solid now and on no plan/decor cell (tree growth and work blocks too);
throwaway = those of Baritone's throwaway kinds (dirt + castle stone) — v2's
towers and bridges, the gate count (they never reach `placedByBot`, so
`apron-litter` misses them).
The g0z.64 acceptance starts the bot south of the fence, the far side from
the gate:

```sh
CASTLE_PADSPOT=250,350 CASTLE_SEED=complete CASTLE_BODY=baritone CASTLE_START=15,0,32 CASTLE_APRON_DIFF=1 sh bot/tools/castle-rig.sh --night 75
```

Interrupts clean up after themselves: `kill -INT`/`-TERM` (or Ctrl-C)
kills every descendant (server client, node, tee), `docker rm -f`s this
slot's container and drops the lock, exit 130 — the next run on the slot
needs no manual `pkill`/`docker rm`.

One call = reset the disposable world copy, boot Paper, scan nine
candidate 48x48 pads around `CASTLE_PAD` (default `300,300`, the preferred
centre) from loaded chunks and flatten a dirt pad on the flattest
(liquid-penalised; deterministic per world), join guide + follower, empty
the follower's kit (or seed it, see below), order `build castle` through
the real chat path, quit the
guide (prod-alone parity: nobody online, autonomous on), work `mins`
minutes, print ONE verdict line:

```
castle <laid>/<total> in <min> min, flips=<n>, deaths=<n>, top-steps=<...>, top-fail=<...>, watchdog=<calls>, first=<s>, choices=<...>, outcomes=progress:<n>,flat:<n>,preempted:<n>
```

`flips` counts goal-step transitions castle<->castlefetch; the JSON record
lands in `CASTLE_OUT` (default `bot/tools/last-castle.json`, gitignored —
check; if not ignored, don't commit it), the full log in `CASTLE_LOG`. The
bot runs the real stack with the REAL JEV planner by default
(`RIG_PLANNER=jev`, idkcraft-vmzq.23): the key arrives as
`TYPESAFE_API_KEY`, or — when unset — from the stash
`secrets/jev-api-key` at run time, and travels as env only (never
printed, never logged; a jev run without a key fails loud instead of
silently measuring the stub). Once the guide quits, the tick brain steps
down to stub (prod-alone parity, no paid tick asks) while the
stall-point `plan()` keeps reaching JEV. `RIG_PLANNER=stub` keeps the
deterministic stub brain for tests that need no network.
`GOAL_WATCHDOG_MS` / `GOAL_COMMIT_MS` pass through when set (defaults 60 s
/ 120 s). The watchdog tail parses the bot's own `.21` lines:
`watchdog` = consumed `goal watchdog` rounds, `first` = seconds from
window start to the first real intervention (`-` when none;
`choice=none` failure paths count as calls, not interventions),
`choices` = top-3 intervention choices, `outcomes` buckets the
`goal outcome` results (`failed:*` reads as flat — no goal effect either
way). Day is locked (`CASTLE_DAYLOCK=0` runs the natural cycle),
difficulty peaceful, fall damage off, keepInventory on — the window
measures build throughput, not survival. `CASTLE_KIT=seeded` pre-fills
128 cobble, 64 planks, 64 dirt, a stone pick+sword, the attic nook
(5 bookshelves + 1 enchanting table) and the kitchen blast furnace
after the clear, so
a 6-min window measures laying (equip is kit-complete, the first word is
a batch) independent of the fetch chain; `empty` (default) runs the full
chain from nothing. `CASTLE_TICKRATE=N` (now `CASTLE_TICK_RATE`; the
window is GAME minutes since neuc.60, see "Rig speed") runs `/tick rate N`
— literal ticks/sec (20 = normal, 60 = 3x, 100 = 5x; 2..19
warns, it runs slower than wall clock). A Paper that rejects it warns
loudly and runs at wall clock; the record carries the effective rate.
Gates always run at 1, since the bot ticks on wall-clock seconds and a
faster game clock changes what a minute of play means (tested 20/60/100
tps: identical laying, no speedup; the cycle win is 3-4 parallel rigs, 3
proven overlapping with no degradation).
Night runs stay correct above rate 1 (idkcraft-vmzq.45): on MC 26.1 the
server sends full clock state only on join/time-set/gamerule flips and one
empty `update_time` per 20 game ticks after that, which mineflayer
interpolates at a stale 20/s wall — at rate 100 the bot's clock ran ~5x
slow and it sheltered through server days. The replay re-anchors on every
full packet, counts +20 ticks per empty (frozen clocks stay frozen), and
rewrites `bot.time` on the `time` event, so dusk/dawn land within seconds
of the server's at any rate. Every run logs `CASTLE-RIG time: <dusk|
nightfall|dawn> server=<daytime> bot=<daytime> +<s>s` crossings plus a
`time-resync: tickrate=<N> mode=<correct|track>` line (rate 1 tracks only
and never writes the clock); the JSON record carries `timeEvents` and each
15 s sample carries server (`srv`) vs bot (`bt`) daytime. The crossing's
bot value is sampled on the next physicsTick after the write — the live
clock as the brain reads it, never the counted value — and a sample past
100 ticks of drift prints `CASTLE-RIG time-drift` loud; the record keeps
the run max, so a correction that stops landing fails loud instead of
printing agreement by construction.

Own containers/ports/locks, so a castle run and a stuck run share the box:
container `idk-castle[-<id>]`, port 25581 + letter index, lock
`/tmp/idkcraft-castle-rig.lock[-<id>]`, data under
`$PRODWORLD/castle-rigs/<id>/` (seeded once from `replay-data/paper-base`
minus `world/` and `logs/`). `CASTLE_RIG_ID=a|b|c` (or `auto` over
`CASTLE_SLOTS`, default `0 a b c`) runs up to 4 rigs in parallel; runs
from one worktree need distinct `CASTLE_OUT`. Each rig is trimmed
(`CASTLE_INIT_MEMORY`/`CASTLE_MAX_MEMORY`, default 512M/768M;
`CASTLE_VIEW_DISTANCE`/`CASTLE_SIM_DISTANCE`, default 6/4; no extra
plugins) so 3+ fit the host. Exit 0 = measured (even 0 laid),
2 = environment/setup failure, 130 = interrupted (never a pass).

This is a measurement loop instrument, not a gate: no baseline judging.
`test/castle-rig.test.js` pins the wrapper (lock, rig derivation,
anti-noise asserts) and the verdict-line contract without docker.

`cycles.sh N [mins]` runs N cycles unattended into one table (sequential
— no JEV bursts; `CASTLE_RIG_ID=auto` + `CASTLE_LOCK_WAIT` to share the
box). Exit 0 when every cycle measured, 1 otherwise; per-cycle output in
`/tmp/castle-cycle-<i>-<pid>.log`.

The watchdog asks themselves are measured offline by
`stand-steps.js jev +history+options` over
`test/fixtures/goal-context-eval.json` (the `wd-*` rows are the run-2/3/4
stall shapes with reviewer labels and decision-history rings): JEV
budget ~1 call/row, sequential. The confidence split it prints re-sets
`TASK_PLAN_MIN_CONF` (`test/stand-steps.test.js` pins the variant shape
and the fixture cache without network).

### Rig speed: component rigs + `CASTLE_TICK_RATE` (idkcraft-neuc.60)

Two 10-minute component rigs replace "wait 90 min for one noisy castle
number" for the batch's per-component signal (v2 PRs quote no lines; CLAUDE.md "v2 merge gate"):

```sh
B="CASTLE_BODY=baritone CASTLE_PADSPOT=250,350 CASTLE_RIG_ID=auto"   # image: client.sh default (tree-hash tag)
env $B CASTLE_COMPONENT=lay  sh bot/tools/castle-rig.sh   # 10 min, cells laid / game-min
env $B CASTLE_COMPONENT=mine sh bot/tools/castle-rig.sh   # 10 min, stone banked / game-min
```

- `lay` = `CASTLE_KIT=lay`: the seeded kit with stock for the whole window
  (640 cobble, 192 planks, 64 dirt, 32 torches, stone pick + sword, the
  attic and blast items), so no fetch leg opens. Rate = castle cells laid
  per game minute of the window.
- `mine` = `CASTLE_KIT=pick`: 3 stone picks + a sword and nothing to lay,
  so the first castle word opens one stone leg that mines the whole
  window. Rate = stone (every castle `STONE_ITEMS` kind) banked in the
  pack per game minute of castlefetch time, counted from the 15 s sample
  before the first gain; `first=` is the walk to the first stone (not in
  the rate).

Each run prints the usual castle line plus ONE component line, judged
against `component-baseline.json` (`v1`/`v2` by `BOT_BODY`):

```
lay-rate 24.2/game-min: laid=242 in 10.0 game-min, tick=1, baseline 24.2 -> 24.2 (+0%, within ±20%)
mine-rate 15.5/game-min: banked=+120 in 7.7 game-min of castlefetch, first=135s, window=10.0 game-min, tick=1, baseline 15.8 -> 15.5 (-2%, within ±20%)
```

**Diagnosis leg (idkcraft-6x7.26).** A component with `[mins]` under 10
is a DIAG leg: `CASTLE_COMPONENT=lay ... sh bot/tools/castle-rig.sh 3`
prints `DIAG leg: 3 game-min lay component — diagnosis only, NOT a gate
verdict` at start and a component line `lay-rate 23.9/game-min (DIAG, no
baseline verdict): ...` with no baseline or ±20% judge (the record carries
`diag: true`; laid, series and `first=` are unchanged). Recommended: lay 3,
mine 5 (`first=` is a ~135 s walk that is not in the rate, so a 3-min mine
window leaves under a minute of mining). Wall cost ~7 min vs ~14 for the
gate leg. A DIAG line is never quoted in a PR body as before/after; only
the 10-game-min lines are gate legs.

**Shared before (idkcraft-6x7.27).** The two before legs measure
origin/master, the same commit for every batch run between merges, so they run
once per master sha. A 10-min component leg that exits 0 from a clean tree
(tracked files) whose HEAD equals `origin/master` (after a `git fetch`)
writes its record + component line through to
`$PRODWORLD/castle-rigs/before/<sha>-<component>-<image tag>-<settings hash>.json`
(local, never in git). Settings = the gate's "equal settings":
`CASTLE_BODY`, `CASTLE_PADSPOT`, mins, tick rate, `BARITONE_IMAGE` (unset =
client.sh's tree-hash tag resolved at the measured sha, so a PR touching
`baritone/` still reads master's body). A DIAG leg, or a leg with any
off-gate knob set (`--night`, a non-default `CASTLE_KIT`, `CASTLE_BLOCKED`,
`CASTLE_PAD`, `RIG_PLANNER` other than jev, `GOAL_*`, memory/distance
trims, `CASTLE_BASELINE_RATE`, ...), never caches. A PR then reads its
base's before with the same env:

```sh
env $B sh bot/tools/castle-before.sh lay    # before (cached <date>, master <sha>): lay-rate ...
env $B sh bot/tools/castle-before.sh mine
```

Valid: an exact-sha hit, or a cached ancestor of the base
(`git merge-base origin/master HEAD`) when `git diff <cached>..<base> --
bot/src baritone bot/tools/castle-replay.js bot/tools/castle-rig.sh
bot/tools/component-baseline.json` is empty (docs/CI-only merges do not
change the rig). Hard cap 7 days on any entry (host/image drift). A miss,
a stale entry or "ancestor but rig files moved" prints one reason line
plus the exact rig command to run from a clean origin/master worktree, and
exits 1 — whoever misses pays the two before legs (as before), which also
fills the cache; no cron. `CASTLE_BASELINE_RATE=<rate from the before line>`
on the after legs judges `baseline <before> -> <after>` against the cached
before instead of `component-baseline.json`.

### Fetch line (idkcraft-neuc.62)

Every castle-rig run (the 90-min castle and the component rigs) also prints
ONE diagnosis line, not judged, no exit-code effect:

```
fetch: ticks=3436 stone=+290 (11.9 s/stone, component 3.8) legs=12 finished=1 cut=11 cut-by=force=kit:4,watchdog:castlefetch-far:6,castle-word:1 far=6 dead=22min (t=15-24,47-55,65-70)
```

- `stone=` the banked rule of the mine component (one shared loop);
  `s/stone` = castlefetch sample seconds (game time) / banked; `component`
  = 60 / the mine baseline rate, `-` without a baseline.
- `legs`/`finished`/`cut` (stone legs only) from the bot's own
  `castlefetch stone: need`, `leg over` and `goal step=<x> prev=castlefetch`
  lines (`why=step-done` counts as finished); `cut-by` is `force=<f>`, else
  `watchdog:<choice>` when the previous watchdog line chose, else the goal
  line's `why=`. A far choice inside a live leg (no goal line) counts as
  a cut plus a new leg. `far` = cuts whose reason names far.
- `dead` = castlefetch samples with no stone gain for >= 120 s, in game
  minutes from the window open (list capped at 5). `fetch: -` = no
  castlefetch at all. Promote to a gate only when two runs show it stable.

so the batch run quotes `before -> after` per component straight from its two
lines. Re-record a baseline (lay: two master runs, each within ±20% of the
`rate`; mine: `rate` = mean of 3 pairs, spread noted; `npm test` enforces it) in the PR that moves it on purpose.
Pre-existing `CASTLE_*` knobs stay usable but change what the line means;
`CASTLE_SEED`/`CASTLE_IDLE` are refused (a component orders a castle).

`CASTLE_TICK_RATE=N` (old name `CASTLE_TICKRATE`; unset = server
untouched) runs `/tick rate N` and makes `[mins]` GAME minutes (wall =
mins x 20 / N); every rate-set line adds `tick=, game=` (rcon `time query
gametime` delta — a server that cannot hold the rate shows here) and
`cells/game-min`. **Measured: no rate above 20 is usable, v2 included**
(2026-10-16, v2 body, pad 250,350, 10 game-min each):

| rate | lay cells/game-min | mine stone/game-min | mine first= (game s) |
|---|---|---|---|
| 20 (set) | 24.2 | 16.5 (from the cobble samples; the field predates `stone`) | 135 |
| untouched (the baselines) | 24.2, 24.2 | 16.0, 15.5 | 135, 135 |
| 40 | 9.4 | — | — |
| 60 | 4.6 | 4.3 | 405 |

The server holds the rate (game=10.0-10.5 min in 1/3 the wall time at
60), but the body does not follow it: the walk to the first stone takes
the same 135 WALL seconds at 20 and 60, and per wall minute laying and
mining are flat or slower (lay 24 vs 14/wall-min at 60). This matches the
vanilla client clamping its tick length to >= 50 ms (it slows down with
the server, never speeds up), and v1's mineflayer physics is wall-clock
paced too (vmzq.24: 20/60/100 tps, identical laying per wall minute). So
the safe rate is 20; acceleration needs a client-side change (a mod
mixin lifting that clamp), out of this tooling scope. The wrapper warns on
any rate > 20; above 20 the line is a game-clock
measurement, not a speedup.

## Work-cycle rig (`work-rig.sh`, idkcraft-6x7.16)

```sh
sh bot/tools/work-rig.sh [mins]                  # default 20, WORK_TICKRATE=60 (one mc day ~6.7 min)
WORK_KIT=chest sh bot/tools/work-rig.sh 20       # + a home chest at the first v2 chest spot
WORK_TICKRATE=1 sh bot/tools/work-rig.sh 60      # gate regime: wall-clock game
```

The offline twin of the work-cycle prod acceptances: a day of the bot's
work with nobody online, measured in minutes instead of a multi-hour prod
session. One call = reset the disposable world copy, boot Paper on
NORMAL difficulty with the clock running (no daylock, no peaceful; fall
damage and keepInventory untouched — deaths and drops are the
measurement; weather stays clear so runs compare), level a 21x21 dirt pad
at world spawn, raise a plan-driven v2 house on it (`raise-house.js`)
with both bedroom beds set at the canonical cells (`beds.cellsOf`), join
the follower (it must adopt the rig house from the world, else exit 2),
chat `autonomous on` + `go work`, quit the guide (prod-alone parity),
work `mins` minutes, print ONE verdict line:

```
work nights=<n> slept=<n> inside=<n> dugin=<n> deaths=<n> banked=<items>/h brought=<n> steps=<top-4> fail=<top-3>
```

Counters parse the bot's own lines only (`verdict(lines, mins)` in
`work-replay.js`, pure): `nights` = server dusks (the castle-replay
time resync, server truth; a bed at dusk skips the night before
nightfall ever crosses), `slept` = `sleeping in my bed` chats,
`inside` = `home for the night` chats, `dugin` = `shelter dig-in done`,
`deaths` = `death health=` lines, `banked` = items in `forage done:
banked …` (and the pack-full yield's `forage failed:pack-full (banked
…)`) per hour of window, `brought` = `brought …`/`stockpiled …`
chats, `steps` = top `goal step=` counts, `fail` = top failed steps (the
prev step of `why=step-failed`, `:<reason>` once the line carries
`fail=`, ipn.15). `WORK_KIT=empty` (default) clears the pack, `chest`
adds a home chest, `seeded` adds stone tools + 16 bread on top. Planner,
key handling, `GOAL_WATCHDOG_MS`/`GOAL_COMMIT_MS`, heap and distance
trims mirror the castle rig (`WORK_` prefix). JSON record in `WORK_OUT`
(default `/tmp/work-rig-<id>.json`), full log in `WORK_LOG`.

Own containers/ports/locks beside the castle and stuck rigs: container
`idk-work[-<id>]`, port 25611 + letter index, lock
`/tmp/idkcraft-work-rig.lock[-<id>]` (`WORK_LOCK_WAIT`, falling back to
`RIG_LOCK_WAIT`), data under `$PRODWORLD/work-rigs/<id>/`;
`WORK_RIG_ID=auto` picks a free slot of `WORK_SLOTS` (`0 a b c`). Exit
0 = measured (even all zeros), 2 = environment/setup failure, 130 =
interrupted. `test/work-rig.test.js` pins the wrapper and the verdict
without docker.

| prod acceptance | verdict counter |
|---|---|
| rw4.7 (home → night → morning) | `slept>=1` per night and `dugin=0` with a house (`slept`≈`nights` on the clean rig house) |
| atl.3 (items/hour, deaths, stalls) | `banked=<n>/h`, `deaths`, `fail` |
| ipn.5 / jsf.8 | counters exposed only (`brought`, `fail`); their epic owners write the criteria |

Known limit: the world snapshot is old (spawn near −48 65 −208); prod
relief (a hump inside the house, a cave at spawn) is synthetic here — the
pad levels it — not the world itself.

## Puppet player (`puppet.js`, idkcraft-jlw7)

Agents run real prod play sessions without the owner: the puppet joins as
`PUPPET_NAME` (default `IdkTester`) and takes the owner's place at the
keyboard. Commands go through the real chat path (entity-needing orders work)
and the puppet counts as roster for work mode. It runs from the agent's
machine — never add it to `docker-compose.yml` (shared contract).

```sh
node bot/tools/puppet.js --host=<mc-host> --port=<mc-port> --http-port=18080
```

Control is HTTP on `localhost` only: `POST /say {text}`, `POST /goto
{x,y,z}` or `{player}`, `POST /look {yaw,pitch}`, `POST /stop`, `GET
/state[?n=N]`, `POST /quit`. Every control call and every chat line heard
appends to the JSONL transcript. `/goto` never digs or towers (a walk through
a wall fails instead of griefing prod).

| var | default | meaning |
| --- | ------- | ------- |
| `PUPPET_HOST` / `--host` | `localhost` | MC Java host (env/argv only — never commit prod's) |
| `PUPPET_PORT` / `--port` | `25565` | MC Java port |
| `PUPPET_NAME` / `--name` | `IdkTester` | puppet username (1..16 chars, whitelisted on prod) |
| `BOT_USERNAME` / `--bot-name` | `IdkBot` | the prod bot (ignored in the roster, like `index.js:505`) |
| `PUPPET_HTTP_PORT` / `--http-port` | `18080` | localhost control port |
| `PUPPET_LOG` / `--log` | `/tmp/idkcraft-puppet-<pid>.jsonl` | JSONL transcript path |
| `PUPPET_IDLE_MS` / `--idle-ms` | `900000` | quit when no control call arrives for this long (min 1000) |

Yield to humans (owner requirement): any roster entry other than the puppet
and `BOT_USERNAME` (exact match — a Bedrock `.Name` is just a roster key)
makes the puppet say goodbye and leave within 2 s; HTTP stays up and control
calls return `409 human online`. A human already on at connect refuses with
exit 2 and no join. Exit codes: 0 = `/quit` or idle timeout, 1 = error,
2 = human online. Agent manual: `.claude/skills/idkcraft-prod-play/SKILL.md`.
The bot tags incoming chat (`chat from=<name> msg=<msg>` in `src/chat.js`),
so session review tells `from=IdkTester` from live players.

## Unattended build oracle (`task-run.sh`, idkcraft-vmzq.1)

One command per stage orders a build on prod, leaves, and judges it from the
logs — the epic-vmzq acceptance that "finish a build unattended" is a test.

```sh
sh bot/tools/task-run.sh house 180    # `build here` on a new site, 3 h budget
sh bot/tools/task-run.sh castle 480   # `build castle`, 8 h budget
```

Regime (the owner's case: "give the order and leave"): the puppet joins, says
`autonomous on` + `follow me`, walks into mutual range (the unseen reply leaks
the bot's coords, chat.js), says the order, confirms the reply, and QUITS —
the 3 h run meets even a 580-block-away bot via reunion + re-asked coords.
Progress is read from VictoriaLogs, never from the puppet. Nobody online,
BOT_AUTONOMOUS on. Exit 0 = done within budget, 1 = budget exceeded (prints
the last 20 bot lines + the last progress line), a castle with no site, or a
house done over unhealed `build skip` lines (PARTIAL — pre-vmzq.10 the marker
fired when every remaining cell was skipped; since vmzq.10 the bot fails the
step honestly instead, so a hole-y run ends on budget with the skips visible,
and skips younger than the prune horizon veto the done either way), 2 =
environment (puppet refused, bot never seen, no reply, human void, logs lost
mid-run, bot autonomy unverified).

Rules:
- No merge/deploy freeze (owner Q3): a deploy restart mid-run is RECORDED in
  the series and the run resumes (autonomy is env, so the bot rejoins working);
  it never voids. A human joining voids (exit 2, never rejoin).
- A gone bot triggers a resume (a fresh puppet waits for the roster, says
  `autonomous on`, needs the bot's reply): on `leaving: nobody online`, on
  `waiting for players` (an offline bot ticks that, not silence), or after
  two silent polls in a row. Resumes exhausted with the bot still gone exits
  2 immediately — the run is dead, not slow.
- Castle order follow-ups (vmzq.11): a `looking for a castle spot` ack waits
  for the search (`found a castle spot` / `I found no castle spot`) before
  quitting — the asker leaving cancels the search; `I already have a castle`
  is followed by `castle go` (the bot is still following, `castle go` puts it
  to work).
- Search area (vmzq.15): both orders centre on the speaker, so
  `TASK_RUN_AT=x,y,z` walks the puppet there after the meet and waits for
  the bot to follow into range before the order (a walk that never arrives,
  or a bot that never follows, exits 2). `TASK_RUN_PROBE=1` (castle only)
  is the dry mode: meet, walk, ask, report, quit — a site the probe
  started is `castle forget` again (exit 0), no site exits 1, and an
  already-have reports without touching it (exit 0, no `castle go`).
  Known-good ground: the 10-05 castle area near 276,64,177 (found 1 block
  away 2026-10-05T21:41Z, ran 8/1722):
  `TASK_RUN_AT=276,64,177 sh bot/tools/task-run.sh castle 480`.
- Fail-closed polling (vmzq.11): a poll judges only when both log streams
  answer (a one-stream failure is transient, 3 in a row is logs-lost, never
  a pass); the lookback covers the last good poll, so failed polls and slow
  resumes leave no gap; log lines past the deadline never judge (a late
  marker is budget-exceeded, not DONE), and no resume starts past it.
- One scenario per run; concurrent prod runs collide on the puppet name.
- Secrets resolve at runtime from the stash (`secrets/idkcraft-mc-host`,
  `secrets/idkcraft-mc-port`, the session-review Grafana/Portainer keys found
  fuzzy by generic words) and never print. Every run prints the UTC window
  start and the VictoriaLogs queries to re-judge it by hand.

The series JSON (`/tmp/task-run-<task>-<utc>.series.json`) is the record:
window, order + reply, progress points (`building N/M`, `castle N/total`),
restarts, resumes, and the verdict.

### Baseline (current master)

| date | sha | stage | result | minutes | interventions | diagnosis quoted |
|---|---|---|---|---|---|---|
| 2026-10-06 | 3d4f340 | rig JR-BUILD-FRESH | PASS | 15 | 0 | from scratch, verifyBuild 99/99 skip 0; gather variance 709/909 s over 2 runs |
| 2026-10-06 | 3d4f340 | prod house | FAIL (partial) | 30 | 0 | marker `home done at -40 63 -215` in 30 min, but 30 `build skip … after 3 refusals (no-ref)` lines 17:00:46–17:08:37Z and a post-run world-read shows 70/99 placed (whole dz=5 row + roof patches missing); first pause 17:08:43Z at 94/99 (`next: rearming (laya)` — planks out, then night → `menu=rest`); zero joins in the window |

Budget rule after run 1: 2× the median of 3 green runs (owner Q4).

Grafana: the `idkcraft_bot_task_progress{task}` / `_stall_seconds{task}`
panel queries live in `bot/README.md` (Task panel queries, vmzq.9) — the
metric landed in #316, the dashboard JSON lives in the house Grafana, not
in this repo.

## castle-give.sh

`sh bot/tools/castle-give.sh <file|->`: one rcon command per line (e.g. `give IdkBotV2 minecraft:cobblestone 896`) run on prod `mc` via Portainer exec; keys from stash. The owner's standing ask (curator 2026-10-17): top up the bots' castle materials with it instead of waiting.

## Deaths per day (`deaths.sh`, idkcraft-neuc.65.1)

`sh bot/tools/deaths.sh mc.txt bot.txt` (or stdin): per bot per UTC day,
deaths by killer (mc log), then from the bot's `death health=` lines the time
word, step, kitless share (`sword=0`), share within `NEAR` (60) blocks of
spawn and the death loop (death within `LOOP_S` (300) s of a respawn at
world spawn, `SPAWN_R` (12) blocks per axis; the measured `respawned at` line wins over the `respawn at`
claim). Swarm names (`SWARM_PREFIX`, default `IdkSwarm`) fold into one
`swarm` row, phantoms included. `FROM`/`TO` bound the days; the closing
`summary` lines are what `deaths-baseline.json` records. Offline: the
script reads files only — no hosts, tokens or container ids in it.

Every input line is `YYYY-MM-DD HH:MM:SS <name> <msg>` (UTC):

- mc: the `mc` service's `/data/logs/*.log.gz` + `latest.log` (Portainer
  exec, read-only), each `[HH:MM:SS] [Server thread/INFO]: ` prefix rewritten
  to `<file date> HH:MM:SS `. Demultiplex the exec stream (8-byte frame
  headers) before parsing, or names come out split.
- bots: the idkcraft-session-review VictoriaLogs query
  `(container_name:idkcraft-bot* or container_name:idkcraft-swarm*) ("death health=" or "respawn at" or "respawned at")`,
  printed as `_time <bot name> _msg` (`bot` -> `BOT_USERNAME`, `bot2` ->
  `BOT2_USERNAME`, `swarmK` -> `<BOT_SWARM_PREFIX>K`).

Credentials: the Portainer url/api-key and the Grafana sa-token live in stash
(`kv ls secrets`: the `portainer-url`, `portainer-api-key` and
`grafana … sa-token` keys, as in the session-review skill); the Grafana host
is the `monitoring` stack's `GRAFANA_HOST` env. Never paste them into the
repo, a bead or a PR.

`deaths-baseline.json` holds the BEFORE row (10-15..17, old death lines: no
step/kit facts). Re-measure 3 prod days after the enriched line deploys and
replace it.
