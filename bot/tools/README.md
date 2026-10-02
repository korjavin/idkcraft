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
| 0 | baseline holds (or comparison skipped — see below) |
| 1 | REGRESSION vs `stuck-baseline.json`: a spot flipped reached→unreached, overran its stuck/episode ceiling, or has no baseline entry |
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
| `REPLAY_BASELINE` | `bot/tools/stuck-baseline.json` | baseline file |
| `REPLAY_BASELINE_OFF=1` | — | record only, skip the comparison |
| `REPLAY_BRAIN` | `stub` | `stub` (gate) or `laya` (menu measurement, see below) |
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
in 11 s). `build here` orders are un-gateable: two identical runs
stalled at different points (92/99 inside the house, then below 80/99
east of it) and paged every run (1 then 2) — flaky progress plus a
gave-up on green breaks both the reached pin and strict `maxCalls`
(idkcraft-d7i; JR-SLOPE brings slope ore instead).
The mechanism analysis says why: the only deterministic fail-then-rescue
shape (S6: `dig_up` fails, `dig_step` rescues) OPENS its wedge — the
failed dig digs the void the post-gave-up plan walks — so sabotage
reaches for every order kind; wedges that fail closed (sidestep against
a wide wall) are either routed around by A* or noPath green-red. The
budget guard stays S6-PIT `maxCalls` until a bot or terrain change
reopens this.

## Corpus rules

`stuck-spots.json` is the corpus. Spot shape:

```json
{"name": "EP1", "spawn": [-61.3, 66, -210.5], "goal": [-72, 65, -218],
 "secs": 75, "scaffold": 64, "pickaxe": true, "bucket": false, "bead": "idkcraft-4rz"}
```

- `spawn`/`goal` are prod coords on the snapshot; `secs`/`scaffold`/
  `pickaxe`/`bucket` are the per-spot kit (66 dirt default, stone pickaxe,
  water-bucket pair for `water_up` spots).
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
- JR-SLOPE is a slope bring (`bring me acacia_log 1`), not a build: a
  `build here` order proved un-gateable — two identical runs stalled at
  different points (92/99 inside the house, then below 80/99 east of
  it) and paged every run (idkcraft-d7i), so neither a completion pin
  nor a progress pin is deterministic. The bring spawns AT the jr2.4
  site (-145 72 -78) and works the slope acacias (an ore bring ranged
  20 blocks east off-terrain and was rejected in review). (The jr2.4
  approach-loop fix itself is pinned by unit tests; the oracle guards
  the terrain, not the bug.)
- Q0H-PIT is a `come home` to a rig-built house (`house: [x, y, z]`,
  idkcraft-6x7.8): the snapshot holds no adoptable house near the pit
  (measured: doors stand but the table cell + quorum reject every one),
  so the setup raises a plan-driven v2 house (`raise-house.js`, cells
  from the real blueprint) at the q0h rim site. Rest itself has no chat
  order and never wins the work menu deterministically, so the order
  walks the same trap terrain (pit → rim home) as a meet instead.
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
