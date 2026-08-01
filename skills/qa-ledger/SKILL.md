---
name: qa-ledger
description: Create or update the canonical feature / test / defect ledger for a codebase. Use to turn a repo into a durable quality record that survives sessions. Maintains features (with evidence), tests (with status), and defects (with severity) via the ratchet CLI so quality state is queryable, not remembered.
---

# /ratchet:qa-ledger — the canonical quality ledger

Session state is "this session." The ledger is "everything we know about this codebase's
quality surface." This command builds and maintains it. It is the memory that lets QA
compound instead of restarting every session.

## Step 0 — Ensure the ledger exists

```
ratchet ledger create
ratchet ledger get
```

## Procedure

1. **Features** — from `/ratchet:repo-audit` evidence (or discover now). Each feature is a
   row with a stable ID, area, the routes/workflows it covers, and a status
   (`discovered` → `specced` → `covered` → `verified`).

   ```
   ratchet ledger update features '{"name":"checkout","area":"commerce","routes":"/cart,/pay","status":"discovered"}'
   ```

2. **Tests** — every test that exists or must exist, tied to a feature, with a kind
   (unit / integration / e2e / manual) and status (`pass` / `fail` / `missing`).

   ```
   ratchet ledger update tests '{"feature":"<feature id>","name":"pay-with-expired-card","kind":"e2e","status":"missing"}'
   ```

3. **Defects** — every known failure enters through the defect verbs, never through a
   generic ledger edit: the state defect family owns the mirror's status, severity, and
   summary end-to-end, so `ratchet defect add` is the only birth door (it lands in the
   ledger automatically).

   ```
   ratchet defect add '{"feature":"<feature id>","severity":"high","summary":"..."}'
   ```

4. **Reconcile.** Update statuses for anything that changed since last session — through
   the verbs that own each record. A test that now passes or a feature now covered
   reconciles with `ratchet ledger update tests|features ...`; a defect reconciles only
   through its lifecycle:

   ```
   ratchet defect resolve <id> --evidence "<proof it is actually fixed>"
   ratchet defect reopen <id> --reason "<why it is not actually fixed>"
   ratchet defect supersede <id> --by <newId>
   ```

## Rules

- **Every feature must have evidence and at least one intended test.** A feature with no
  test row is itself a defect — record the gap.
- **Never mark a feature `verified` without a passing test to point to.**
- Use stable IDs so updates upsert instead of duplicating.

## Output contract

```
LEDGER SUMMARY: <features / tests (failing) / defects (open) — from `ratchet ledger get`>
NEW THIS PASS: <features/tests/defects added or changed>
HIGHEST-RISK GAP: <the feature most exposed>
FIRST TEST TO WRITE: <name>
```

Next: `/ratchet:verify` to run a change through the ledger and record results.
