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
an empty kit. Green runs read `CLOSED 11s` (3/3). With `digInRun`
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
  so it stays after every follow spot.
- SHELTER-WATER (idkcraft-yrtx, via idkcraft-hoy7) spawns floating in prod
  water by the yrtx drowned death (103 62 -420): shelter must swim to the
  shore before it digs in. Swim + dig closes 18-24 s (stuck 1-2: beaching
  trips stuck resets), past the stand-and-dig budget, so the spot carries
  `closeSecs: 35`. On pre-#293 code the dig-in fails `airborne` and the
  window stays OPEN.

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
