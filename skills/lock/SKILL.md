---
name: lock
description: Convert vague input into a locked, executable target. Use when a task is fuzzy, over-broad, or stated as a wish. Returns the literal object, operation, output shape, real outcome, proof-of-done, smallest progress artifact, the highest-information missing variable, and the assumption to adopt if it stays missing.
---

# /ratchet:lock — scope lock

Ambiguity is where work goes to die. This command converts a wish into a target with
edges. You do not begin work until the target is locked — but you also do not stall for
missing information you can assume. Name the assumption and move.

## Step 0 — Load state

```
ratchet status
```

## Procedure

Interrogate the input until every field below has a concrete answer. Where the input is
silent, infer the most reasonable value and mark it as an assumption.

1. **Literal object** — the exact noun being operated on (this file, this prompt, this
   route, this dataset). Not a category. The specific thing.
2. **Operation** — the single verb (build, fix, rank, migrate, decide, audit).
3. **Desired output shape** — the concrete form of the result (a JSON file, a patch, a
   3-row table, a 200-word spec). If you can't name the shape, the target isn't locked.
4. **Real outcome** — what becomes true in the world when this is done. The reason, not
   the deliverable.
5. **Proof-of-done** — the observable test that flips from fail to pass. One sentence,
   checkable by someone else.
6. **Smallest progress artifact** — the tiniest thing you could produce in the next 20
   minutes that is undeniably forward motion.
7. **Highest-information missing variable** — the one unknown whose answer would change
   the plan most.
8. **Assumption if missing** — the value you will adopt for that variable so work can
   start now, stated explicitly so it can be challenged later.
9. **Downstream consumer** — who consumes the result and what they do with it. The
   proof-of-done must be runnable by that consumer; strip any field that merely restates the
   task and any word like "clean", "properly" or "works well".

## Output contract

```
OBJECT: <literal noun>
OPERATION: <single verb>
OUTPUT SHAPE: <concrete form>
REAL OUTCOME: <what becomes true>
PROOF-OF-DONE: <the checkable test>
SMALLEST ARTIFACT: <20-minute forward motion>
MISSING VARIABLE: <highest-information unknown>
WORKING ASSUMPTION: <adopted value + one-line justification>
CONSUMER: <who runs the proof-of-done and what they do with the result>
```

## Serialize

```
ratchet state set objective "<operation> <object> → <output shape>, proof: <proof-of-done>"
ratchet state set phase lock
```

## Meter what follows

Once the target is locked, score its uncertainty so you spend only the loop it
earns — don't reflexively run the full ratchet on a reversible one-liner:

```
ratchet score aperture '{"ambiguity":_,"terrain":_,"taste":_,"blastRadius":_,"reversibility":_}'
```

- **A0–A1** → go straight to `/ratchet:build`, then `/ratchet:verify`.
- **A2–A3** → run `/ratchet:ignite`'s metered pipeline.
- **A4** → do not build yet; produce options and lock constraints first.

Then point forward: the locked target's smallest artifact is now the target of
`/ratchet:build`, or run `/ratchet:auction` first if the path to it is blocked.
