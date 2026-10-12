# One body on Baritone — spike (idkcraft-kqzf)

Can the whole Node logic keep running unchanged on a real client with
Baritone instead of mineflayer, via a Node adapter + a Fabric bridge mod?
This spike answers with a go/no-go and a sized plan — not production code.
Zero `bot/src` files change; all spike code is this new directory.

> idkcraft-neuc.2 moved the Node side into the bot image:
> `adapter.js` → `bot/src/bridge/index.js`, `transport.js` →
> `bot/src/bridge/transport.js`, `adapter.test.js` →
> `bot/test/bridge-adapter.test.js`, and deleted the spike-only
> `console` backend with `rig-goto.js` (neuc.5 brings the real harness;
> `rig.sh`'s last line goes away with it). This directory keeps the wire
> spec (`PROTOCOL.md`) and the mod (`mod/`).

## Verdict: CONDITIONAL GO

Honest scope (revmux 01 core-1): only the `#goto` leg met a real
client (rig proof below). State, chat, dig/place and the unchanged
`follow.js` run are proven against the `FakeTransport` loopback only,
and the mod is a skeleton (not built) — the mod build and a full
behaviour-on-rig run are deferred to the epic (recorded on the bead).
With that scope, the easy leg fits the adapter shape (~2 weeks); the
full swap is 8–12 weeks with hard risks (windows/crafting, control
states, packet taps — see `PROTOCOL.md`). Recommended sequence: land
the hybrid first (epic idkcraft-jlda — its worker slot doubles as the
adapter parity rig), then epic the adapter in three phases (walk →
touch → live), keeping mineflayer as the rollback seam.

## Files

| file | what |
|---|---|
| `PROTOCOL.md` | wire spec (JSON-RPC + event stream) + the easy/medium/hard sizing the bead asks for |
| `bot/src/bridge/index.js` | Node `bot` for the spike subset — was `adapter.js` here (neuc.2 moved it into the bot image) |
| `bot/src/bridge/transport.js` | websocket client + `FakeTransport` loopback — was `transport.js` here |
| `bot/test/bridge-adapter.test.js` | moved spike tests, incl. the REAL `follow.js` + `countItems` running unchanged through the adapter |
| `rig-goto.js` | DELETED by neuc.2 with the `console` backend (neuc.5 brings the real harness) |
| `rig.sh` | slot-z boot + offline client (`IdkBody`); its `rig-goto.js` last line goes away with neuc.5 |
| `mod/` | Fabric mod skeleton (method table + client/Baritone call sites, NOT compiled — sized, not built) |

## Verification (2026-10-12)

- `cd bot && npm test`: 4767/4767 pass (incl. lint) — zero behaviour diff, no `bot/src` change.
- `node --test baritone/bridge/`: 12/12 pass (neuc.2 moved these into `cd bot && npm test`).
- Rig (`sh baritone/bridge/rig.sh EP1`, offline `IdkBody`, slot z):
  `reached=true secs=2 minDist=0.9`, client log shows `> goto` — the
  adapter line walked real Baritone. First run red for a spike bug with
  a useful lesson: `setGoal` is sync fire-and-forget, so a blocked
  `Atomics.wait` loop starves its socket send (timeout, `minDist`
  13.1, no `> goto`); `rig-goto.js` uses async sleeps, noted in code.
- Review: `.revmux/review.sh idkcraft-kqzf 01-review` (one round, `idkcraft` profile — new files only).

## Key findings for the epic

1. `blockAt` is sync (268 sites) but the bridge is async — the adapter
   must serve it from a chunk-snapshot cache; misses read unloaded.
2. `GoalFollow` needs no Baritone `#follow`: `follow.js` already
   re-issues, so a one-shot `#goto` at the live target suffices — but
   only with race-free status (revmux 01 core-3: the adapter latches a
   goal generation and ignores `last:'none'`; prod echoes a goal id
   through `baritone.cmd` → `baritone.status`).
3. `registry` (90 sites) is static data — pass mineflayer's through, zero bridge traffic.
4. Cutover is big-bang (one name = one connection, no shadow mode) —
   the hybrid rig is the parity harness before any cutover.
5. Baritone gaps stand: no water-bucket climb (fails DUGPIT-BARE),
   no inventory actions — the mod carries those, sized in `PROTOCOL.md`.
