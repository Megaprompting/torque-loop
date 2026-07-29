# reference/graph — the skill graph, derived not remembered

`torque-loop.cypher` is a knowledge graph of this plugin's skills. It is **generated**, never
hand-edited. The generator (`scripts/graph-gen.js`) reads the real source and emits Cypher;
`test/plugin-shape.test.js` byte-matches the committed file against a fresh generation, so a
drifted graph fails CI exactly like a stale version number does.

This exists because the first pass at this graph was hand-authored — a snapshot of the skills
as of one night, with nothing tying it back to source. By the plugin's own thesis (`README.md`),
an unverified guardrail is a liability wearing the costume of relief: the moment a skill changes,
a remembered graph silently lies and you trust it without re-checking. A *derived* graph cannot.

## Regenerate

```
node scripts/graph-gen.js            # rewrite reference/graph/torque-loop.cypher
node scripts/graph-gen.js --check    # exit 1 if the committed file is stale
```

Change a skill's frontmatter or the PROMPTS.md map, rerun the generator, commit the new `.cypher`
in the same change. If you forget, `npm test` (plugin-shape) turns red.

## What is in the graph (scope: DERIVED from torque-loop source only)

Namespace `ns: 'torque-loop'` on every node. The load script's first statement is
`MATCH (n {ns: 'torque-loop'}) DETACH DELETE n;` — a **delete-and-rebuild**, so a shrunk or
reordered graph can never leave a stale node or `STEP`/`NEXT_PHASE` edge behind as if it were
truth. (The earlier MERGE-only reload was additive-idempotent only; this closes that hole.)

| Node | Source | Key |
| --- | --- | --- |
| `RatchetSkill` | `skills/*/SKILL.md` frontmatter (dir name = command) | `name` |
| `RatchetPhase` | the canonical path line in `reference/PROMPTS.md` | `name`, `step` |
| `RatchetPrompt` | the command ↔ prompt map table in `reference/PROMPTS.md` | `slug` |

| Edge | Meaning |
| --- | --- |
| `(RatchetPhase)-[:NEXT_PHASE]->(RatchetPhase)` | frame → choose → build → attack → patch → serialize → advance |
| `(RatchetSkill)-[:IMPLEMENTS]->(RatchetPrompt)` | which canonical prompt a skill implements (a skill may implement two) |

Loading: any Cypher runner that accepts `;`-terminated statements (cypher-shell, Memgraph). The
file is a portable source artifact; nothing in this repo executes it.

## PARKED — the aperture cross-links (declared, not derived)

The first graph pass also carried ~11 cross-links from aperture *mechanism* skills to ratchet
*execution* skills (e.g. `entity-bridge → lock`, `yield-loop → loop`) plus a
`MECHANISM_LAYER_OVER` doctrine edge, grounded in the 2026-07-07 harness lock: *one execution
grammar (ratchet), many mechanism tags (aperture)*. Those are **deliberately absent here** for two
honest reasons, and are parked rather than dropped:

- **Not in this repo's source.** Their far endpoint is the aperture repo. This generator can only
  derive what torque-loop source contains; a bridge it cannot verify does not belong in the derived
  file (convention 15 — a scoped decision is parked with an owner, never silently shipped).
- **Never adversarially attacked.** The specific pairings were one model's judgment. `entity-bridge`
  could as defensibly bind to `map` as to `lock`. Until a hostile pass reviews the mapping, encoding
  it as canon is self-grading.

**Route out (owner: Danny).** Author the aperture-side generator *in the aperture repo*, deriving
each mechanism skill's `use` text from its own `SKILL.md` (fixes the second-hand-text hole at its
source), then emit the bridge edges as an explicitly `declared: true, verified: false` overlay whose
torque-loop endpoints this repo's guard can still check. Cross-repo bridges are a graph-merge
concern, not a torque-loop build.

Traced by: claude-opus-4-8[1m]
