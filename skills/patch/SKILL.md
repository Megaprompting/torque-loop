---
name: patch
description: Fix only what failed — nothing else. Use after an attack surfaced defects, to prevent the model from rewriting everything for elegance. Returns the minimal delta under REMOVE / ADD / CHANGE, the patched artifact, the relevant retest result, and any defects still open.
---

# /ratchet:patch — minimal delta

The temptation after criticism is to rewrite. Rewriting throws away working parts and
introduces new defects. This command patches the specific failures and nothing else.

## Step 0 — Load state and open defects

```
ratchet status
ratchet state get defects
```

## Procedure

1. **Take the defect list as the work order.** Only defects found by `/ratchet:attack`
   (or recorded in state) are in scope. If you feel the urge to change something not on
   the list, stop — that is scope creep, not a patch.

2. **Express each fix as a minimal delta:**
   - **REMOVE:** what to delete.
   - **ADD:** what to introduce.
   - **CHANGE:** what to alter, from → to.

3. **Preserve everything that passed.** Working parts are untouched. Prefer the smallest
   diff that clears the defect over the "cleaner" larger one.

4. **Retest the patched path.** Run the specific 5-point test items the defect touched.
   Report the actual result — if a fix didn't hold, say so; do not claim green on faith.

5. **Update defect status.** Resolved defects get marked; anything still failing stays
   open and honest.

## Output contract

```
PATCH (per defect):
- <defect> → REMOVE: ... | ADD: ... | CHANGE: ...
PATCHED ARTIFACT: <the changed artifact or diff>
RETEST: <which checks were re-run + pass/fail>
REMAINING DEFECTS: <still-open items, or "none">
```

## Serialize

Clear the ORIGINAL defect with the proof that it is fixed. Do not record a second,
already-resolved defect: a defect cannot be born terminal (the CLI refuses it), and a
freshly-minted "resolved" record leaves the real one draining forever.

```
ratchet defect resolve <original-defect-id> --evidence "<the retest result that proves it>"
ratchet state set phase patch
ratchet score confidence
```

Anything still failing stays open and honest — `ratchet defect list` shows what drains.

Next: if defects remain critical/high, loop back to `/ratchet:attack`. If clear,
`/ratchet:compile` to serialize the advance.
