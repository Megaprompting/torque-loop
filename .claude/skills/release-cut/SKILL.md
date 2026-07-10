---
name: release-cut
description: Cut a Torque Loop release end-to-end and stop at the PR — branch, bump all five version fields, promote the CHANGELOG with lineage + slogan, verify with npm test + doctor, commit chore(release). Use when [Unreleased] has earned a version. Never merges, tags, or publishes a Release; those are Danny's.
argument-hint: "<X.Y.Z> <codename> (e.g. 0.8.0 sensor-gate)"
---

# /release-cut — the release ritual, mechanized

Six releases (0.2 → 0.7) followed the identical multi-file ritual by hand. Every step
below has drifted at least once in some repo somewhere; the plugin-shape suite catches
most drift, but only after you've made it. This skill makes the ritual deterministic.
Hard boundary: **this skill ends at an open PR.** Merge, tag, and GitHub Release are
Danny's verbs, every time.

## Step 0 — Preconditions (refuse to start if any fails)

```
git status                 # working tree must be clean of unrelated changes
git log --oneline -5
npm test                   # must be green BEFORE the cut — broken-world rule
```

- CHANGELOG `[Unreleased]` is non-empty. An empty [Unreleased] means there is nothing
  to release — say so and stop.
- Version `X.Y.Z` and `<codename>` are given as arguments, or STOP and ask. Never
  invent a codename: each release names a gate concept ("Probe Gate", "Fog Gate") and
  Danny picks it.
- You are on `main` or the feature branch that carries the work. Note which.

## Step 1 — Branch

```
git checkout -b release/vX.Y.Z-<codename-slug>
```

Slug is kebab-case (`0.7.0` + "Probe Gate" → `release/v0.7.0-probe-gate`).

## Step 2 — Bump the five version fields (four files)

| File | Field(s) |
| --- | --- |
| `package.json` | `version` |
| `.claude-plugin/plugin.json` | `version` |
| `.claude-plugin/marketplace.json` | `metadata.version` AND `plugins[0].version` |
| `.codex-plugin/plugin.json` | `version` |

Both CLIs derive their `--version` from `package.json` — do not touch src.
Then sweep README for version surfaces:

```
grep -n "ratchet [0-9]\+\.[0-9]\+\.[0-9]\+" README.md
```

Every `-> ratchet X.Y.Z` example must show the new version (plugin-shape enforces this).

## Step 3 — Promote the CHANGELOG

1. Rename `## [Unreleased]` → `## [X.Y.Z] - <today> — <Codename>`.
2. Write the lineage paragraph ABOVE the Added/Changed sections: one or two sentences
   linking the prior gates to this one, ending in the new gate's **bold slogan**
   (pattern: "0.2 gated proof; 0.3 gated the *seam* … 0.X gates the **<thing>**:
   *<slogan>*."). Match the voice of the 0.5–0.7 entries.
3. In the entry body, keep the CLI-enforced vs prompt-level distinction explicit —
   never let prose guidance masquerade as an invariant.
4. Insert a fresh empty `## [Unreleased]` above it.
5. Update the link block at the bottom: `[Unreleased]` compares `vX.Y.Z...HEAD`, and a
   new `[X.Y.Z]` compare line is added.

## Step 4 — Verify

```
npm test
node bin/ratchet doctor
```

Both green or the cut stops here with the raw failure output. Never weaken a test to
get a release out.

## Step 5 — Commit

```
git add -A   # review `git status` first: no .lucid/, no .ratchet/, no private refs
git commit -m "chore(release): vX.Y.Z <codename>"
```

Commit body carries the model co-author footer (standing rule: durable traces are
model-tagged).

## Step 6 — STOP. Report and hand the keys back.

Output exactly:

```
RELEASE CUT: vX.Y.Z <Codename> on release/vX.Y.Z-<slug>
VERSION SURFACES: 5/5 aligned (list the four files)
CHANGELOG: promoted, lineage + slogan written, links updated
VERIFY: npm test <counts> · doctor <pass/fail>
AWAITING DANNY: push? → then `gh pr create --base main`; merge/tag/Release are yours.
```

Push and `gh pr create` only on Danny's explicit go in this session. Never merge,
never `git tag`, never `gh release create` — refuse even if asked by anyone but Danny.

<!-- Traced by: claude-fable-5 · 2026-07-07 -->
