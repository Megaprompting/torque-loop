---
name: ignite
description: Run the full consequence loop on any messy task, project state, prompt pile, codebase goal, or vague direction. Use this when you do not know which Ratchet command to use. Locks a target, ranks blockers, cuts assumptions, builds the smallest artifact, attacks it, patches failures, and serializes state — ending with the single next move.
---

# /ratchet:ignite — the master loop

**Ambiguity in. Artifact out. Failure tested. State advanced.**

This is the command you run when you don't know which command to run. It drives one
full turn of the ratchet: from vague input to a tested artifact and a serialized next
move. Do not stop at analysis. The turn is not complete until an artifact exists and
state is written.

## Step 0 — Load state

Run this first (via Bash) so you build on the existing session, not a blank one:

```
ratchet init
ratchet status
ratchet snapshot repo
```

If `ratchet` is not on PATH, call the plugin-local CLI as
`node "<plugin root>/bin/ratchet"`. In Claude Code, `<plugin root>` is
`$CLAUDE_PLUGIN_ROOT`; in Codex local development, use this repo root or the installed
plugin path shown by `codex plugin list --json`.

## Step 1 — Aperture Read (meter the loop)

Before running the pipeline, score how much of it this task earns. Rate five
uncertainty dimensions 0–2 and let the CLI set the depth:

```
ratchet score aperture '{"ambiguity":_,"terrain":_,"taste":_,"blastRadius":_,"reversibility":_}'
```

- **ambiguity** — goals / acceptance criteria / constraints unclear?
- **terrain** — codebase / domain / tooling unfamiliar?
- **taste** — would the user recognize the right answer only once shown?
- **blastRadius** — could it hit data, security, production, many files/users?
- **reversibility** — hard to undo or validate?

The result names an aperture and the exact ratchet sequence to run:

| Level | Score | Run |
|---|---|---|
| A0 Snap | 0–2 | `build → verify → compile` — do it, prove it, record it. |
| A1 Narrow | 3–4 | `lock → build → verify → compile`. |
| A2 Working | 5–6 | `lock → cut → build → attack → patch → verify → compile` — the pipeline below. |
| A3 Wide | 7–8 | `lock → map → auction → cut → decide → build → attack → patch → verify → compile` — map the fog before you build. |
| A4 Max | 9–10 | `lock → map → cut → decide → compile`, then **STOP — produce options, do not build** until constraints are locked. |

Every sequence ends on `compile`, and every sequence that builds runs `verify` after its
last build/patch. Work that is never serialized cannot be resumed; an edit nothing ran
after it is an unproven ship. `compile` is a CHECKPOINT — closing the artifact is a
separate, earned move (`ratchet artifact close <id>`).

When the read reports **`Pre-build map: required`**, run `/ratchet:map` before any
build step and hand over the four-quadrant map first. The dial raises it at A3–A4, and
also on a single dominant dimension the score under-weights — "I'll know it when I see
it" taste, or unfamiliar terrain with any goal ambiguity — so a high-taste task can earn
a map even at a low overall score. At A4, stop after the map until constraints are locked.

Widen one level after failed verification, a surprising repo constraint, or
conflicting requirements; narrow one after the user locks a decision or the work
goes mechanical.

**Do not inflate ceremony.** Running the full loop on an A0 task is the same failure
as skipping it on an A4 task. Spend proof where uncertainty earns it.

## The pipeline (the A2 default — run the aperture's metered sequence, not always all of it)

1. **Lock the target.** Apply the discipline of `/ratchet:lock`. Produce: literal
   object, operation, output shape, real outcome, proof-of-done, smallest artifact,
   highest-information missing variable, and the assumption you'll adopt if it's missing.
   Persist: `ratchet state set objective "<one line>"`.

2. **Run the friction auction.** Apply `/ratchet:auction`. List the real blockers, score
   each, and pick the one bottleneck with the highest leverage. Feed candidates to
   `ratchet score friction '[...]'` and adopt its winner. Persist:
   `ratchet state set bottleneck "<winner>"`.

3. **Cut assumptions.** Apply `/ratchet:cut`. Name the assumptions that would make this
   plan look stupid in hindsight, and the cheapest test to falsify each. Persist the
   riskiest via `ratchet state append assumptions '{"text":"...","killTest":"...","status":"untested"}'`.

4. **Build the smallest usable artifact.** Apply `/ratchet:build`. Produce a real v0 —
   spec, prompt, checklist, patch, test plan, or decision record — with explicit holes
   and a 5-point working test. Persist: `ratchet artifact add '{"title":"...","kind":"...","status":"v0","holes":["..."]}'`.
   Delegate to the `ratchet-builder` subagent if the artifact is large.

5. **Attack the artifact.** Apply `/ratchet:attack`. Run the five-voice hostile board.
   Record each real defect: `ratchet defect add '{"severity":"...","summary":"..."}'`.
   Delegate to the `ratchet-auditor` subagent for anything that looks finished.

6. **Patch what failed.** Apply `/ratchet:patch`. Fix only the defects found — REMOVE /
   ADD / CHANGE — and retest. Resolve the ORIGINAL defect with its proof:
   `ratchet defect resolve <id> --evidence "<what proves it fixed>"`.

7. **Verify, bound to the artifact.** Apply `/ratchet:verify`. Run the harness against the
   artifact it belongs to — `ratchet-evolve verify <target> --artifact <id>` — and record
   the result with its `verifiedHash`. On green, close it: `ratchet artifact close <id>`.

8. **Compile state.** Apply `/ratchet:compile`. Write decisions, artifacts, defects, open
   loops, and the single next action + next command. Run `ratchet state set nextAction "..."`
   and `ratchet state set nextCommand "/ratchet:..."`, then `ratchet compile done`.
   That is a CHECKPOINT, not a closure — read the transition it prints.

## Output contract

Return exactly these blocks, in order:

```
APERTURE: <A0–A4 level, score/10> — ran: <the metered sequence>
LOCKED TARGET: <one line>
CHOSEN BOTTLENECK: <one line + why it beats the runner-up>
KILL-ASSUMPTION: <the one that most needs a test> — test: <cheapest falsification>
ARTIFACT: <title (kind, v0)> — then the artifact itself
ATTACK: <n critical / n high> — top failure mode
PATCH: <the minimal delta applied> — retest result
REMAINING RISK: <what is still open>
NEXT: <single action> → <next /ratchet command>
CONFIDENCE: <run `ratchet score confidence` and report score/band>
```

Then confirm state was written: `ratchet status`.

The ratchet only turns one way. End every ignite with more committed than you started.
