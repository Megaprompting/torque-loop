---
name: skill-forge
description: Add or evolve a /ratchet:* command across every synced surface at once — canonical prompt in PROMPTS.md, SKILL.md in the house shape, README row, templates, drift guard, tests. Use when a new loop move is being added to the plugin (like map or the probe were), or an existing skill's contract is changing. Prevents the four-surface drift the plugin-shape suite exists to catch.
argument-hint: "<command-name> [new|evolve] — e.g. 'sensor new'"
---

# /skill-forge — one command, every surface

A `/ratchet:*` command is not a file; it is a contract spread across four synced
surfaces — `reference/PROMPTS.md` (intent), `skills/<name>/SKILL.md` (procedure),
`README.md` (catalog), and `test/plugin-shape.test.js` (drift police) — plus
`templates/` when the command produces a file-shaped record. Editing one surface and
not the others is the repo's most common failure mode. This skill walks them in
dependency order: intent first, procedure second, catalog third, guard last.

## Step 0 — Ground truth

```
ls skills/
grep -n "<command-name>" reference/PROMPTS.md README.md test/plugin-shape.test.js
```

Read the two nearest-neighbor skills (for a gate-like command: `skills/map/SKILL.md`,
`skills/build/SKILL.md`) — the new skill must read like it was written the same day.

## Step 1 — Canonical prompt (PROMPTS.md) — the source of truth, written FIRST

- Add the prompt as a fenced `text` block in `reference/PROMPTS.md`, in the imperative
  copy-paste voice of the existing twelve ("Produce the artifact now." / "Map the fog
  before you build.").
- Add a row to the Command ↔ prompt map table.
- If the mechanism is grafted from elsewhere: general mechanism, own words — rewrite
  in ratchet vocabulary and note provenance (aperture-dial precedent).
- Rule to preserve: the prompt must force *pressure* — a choice, an artifact, a test,
  a patch, serialized state, a killed option, or a push. If it only produces insight,
  it is not a ratchet command; stop and say so.

## Step 2 — SKILL.md in the house shape

`skills/<name>/SKILL.md`, exactly this skeleton:

```
---
name: <name>
description: <verb-first pitch. Use when <trigger>. <what it produces / refuses>.>
argument-hint: "[...]"        # only if it takes arguments
---

# /ratchet:<name> — <tagline>

<2–3 sentences: why this command exists, what failure it prevents.>

## Step 0 — Load state
```
ratchet status
```

## Procedure
<numbered, imperative, bolded key rules. Prompt-level tripwires welcome, but never
claim they are enforced — enforcement is the CLI's job.>

## Output contract
```
<FIXED-SHAPE block — same sections every run, emptiness stated>
```

## Serialize
```
ratchet <exact commands — artifact add / state append / state set phase>
```

<closing line naming the NEXT move — no ratchet skill ends in analysis.>
```

Frontmatter `description:` is mandatory (plugin-shape asserts it) and doubles as the
when-to-use pitch the model router reads — write it like the existing ones.

## Step 3 — Templates (only if the command produces a durable file)

Mirror `templates/probe-card.md` / `templates/unknowns-map.md`: terse field list,
every field load-bearing, no prose padding. Reference the template from the SKILL.md.

## Step 4 — README row

Add `/ratchet:<name>` to the correct README section (Core loop / Specialized /
Evolution) in the table style of its neighbors. plugin-shape fails the suite if any
skill folder lacks a README mention — and if you RENAMED a command, grep README for
the old name; the suite also rejects stale names.

## Step 5 — Drift guard

If the new command creates a cross-surface invariant the generic loops don't already
cover (a template that must exist, a threading rule like "build records deviations"),
add one `ok(...)` block to `test/plugin-shape.test.js` in the existing style: a
comment saying WHY the guard exists, then content-level asserts (`/deviation/i.test(...)`),
not snapshot dumps. Precedents: the map-wiring and probe-threading guards.

## Step 6 — Verify + serialize

```
npm test
```

All three suites green. Then:

```
ratchet artifact add '{"title":"/ratchet:<name> command","kind":"code-patch","status":"v0","holes":[...]}'
```

Output contract for this skill's own run:

```
SURFACES TOUCHED: PROMPTS.md § + map row · skills/<name>/SKILL.md · README § · [templates/…] · [plugin-shape guard]
SURFACES UNCHANGED AND WHY: <e.g. no template — command produces no durable file>
VERIFY: npm test <counts>
NEXT MOVE: /ratchet:attack the new SKILL.md before it ships
```

<!-- Traced by: claude-fable-5 · 2026-07-07 -->
