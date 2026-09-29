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
| 2 | environment failure: no START.sh/snapshot, rig never came up, anti-noise rejected, pristine `world.tar` changed mid-run |
| 130 | interrupted (never a pass) |

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
| `REPLAY_TAG` | `run$$` | bot name suffix; the wrapper pre-ops these names |
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

The baseline is data, not aspiration: `spot → { reached, maxStuck, maxEps }`.

- Record: `REPLAY_BASELINE_OFF=1 sh bot/tools/stuck-run.sh`, then copy the
  measured `reached`/`stuck`/`eps` per spot into `stuck-baseline.json`.
- Slack: ceilings carry observed + 2 stuck / + 1 episode — single runs vary
  (ik7 saw S6 stuck 0..3 across two opped runs on one build). Re-measure,
  do not hand-tune; `npm test` fails when a corpus spot lacks an entry.
- Judge: plain `sh bot/tools/stuck-run.sh` → exit 0/1 with the diff.
- Improvement (`IMPROVED`, exit still 0) means the baseline is stale:
  re-record and commit the new entry in the same PR.

A `laya` run never judges against the stub baseline (different menu policy):
it records and exits 0 until a laya baseline ships.

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
- Work-bug terrains (bring shaft, build slope, rest pit) replay through the
  follow driver: the walk covers the prod ground where the work bug lived.
  Order-driven work spots (chat an order, judge the outcome) are follow-up
  work, not this rig.

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
  into rock or dead) fail `reached` instead of faking a pass; a bucket
  spot's flood is wiped before the next trial.
