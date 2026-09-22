---
description: goal fit against the bead, proportion (ponytail), and whether npm test proves the new logic
---
## Lens: goal-and-tests

Judge the change against the bead in `{{GOAL}}` and `{{CONTEXT}}`, not against a better change you
would have made. Say in one line what the diff actually does, then compare with what the bead asked.

Look for:

- an acceptance criterion the change covers only partly, or a behaviour the bead describes that no
  code path reaches
- work the bead never asked for: renames, restructuring, drive-by cleanups, a second behaviour bundled
  into this PR — the developers run in parallel on disjoint files, so scope creep here collides with
  another branch
- disproportion: a class, abstraction, config knob or dependency where a few lines would do. The
  project's rule is the smallest diff; a `// ponytail:` comment marks an intentional shortcut and is
  not a finding
- new branching logic (a behaviour priority, a threshold, a chat trigger) with no test in `bot/test/`
  that fails if it is inverted or deleted. `npm test` runs without a Minecraft client through the
  fake-player harness; name the defect the missing test would catch, never "no test" alone
- a test that passes by construction: asserting the value it supplied, a stub configured to agree, a
  condition that skips the assertion

When the goal is vague, say so and lower confidence rather than inventing one. A removal that is only
the branch lagging its base is not a change.
