---
description: goal fit against the bead, and whether npm test would fail without the fix
---
## Lens: tests

First say in one line what the diff does, then compare with the acceptance criteria in `{{GOAL}}`.

- an acceptance criterion not met, or met only for a config prod does not run (e.g. only with
  `BOT_FOLLOW` set; prod default is empty = work mode)
- new branching logic with no test in `bot/test/` that fails when the branch is inverted or deleted —
  name the defect the missing test would catch
- a test that passes by construction: asserts the value it fed in, a stub configured to agree, an
  existing test edited to match the new gate instead of pinning old behaviour (9sh)
- a fake-harness blind spot the fix depends on: the fake has no gravity, no floored block positions,
  no real `Movements`/A*, no entity tracking range — if the fix only works because of the fake, say so
- async left running after a test (meal, timer, promise) that can write into the next test's log
  capture (cn7 flake)
- scope creep: renames or restructuring the bead did not ask for (parallel branches collide)

A `// ponytail:` shortcut with its ceiling named is deliberate, not a finding.
