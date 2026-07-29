---
name: loop
description: Run recursive improvement — build → attack → patch → compile — until the artifact is genuinely done. Use to drive an artifact to a stable, tested, serialized state without stopping at the first draft. Repeats the cycle and reports an iteration log and confidence score, stopping only when no critical/high defect, no untested core assumption, and no missing next action remain.
---

# /ratchet:loop — recursive advancement

One pass rarely finishes anything. This command repeats the core cycle until the artifact
actually holds under attack. It is the closest thing Ratchet has to a software-quality
agent: discover the missing thing, build it, try to break it, fix what broke, serialize.

## Step 0 — Load state

```
ratchet status
ratchet score confidence
```

## The cycle (repeat until the stop condition holds)

Each iteration:

1. **Discover the missing thing.** The highest-leverage gap right now — an untested
   assumption, an open defect, a missing piece of the artifact. (Borrow `/ratchet:cut`
   and `/ratchet:auction` logic to pick it.)
2. **Build** the artifact or the fix (`/ratchet:build`).
3. **Attack** it with the five-voice board (`/ratchet:attack`); record defects.
4. **Patch** only what failed (`/ratchet:patch`); resolve the original defect with evidence.
5. **Verify** bound to the artifact (`/ratchet:verify`); on green, `ratchet artifact close <id>`.
6. **Compile** the advance (`/ratchet:compile`); recompute confidence.

The cycle is build → attack → patch → verify → compile. Compiling before verifying
records an unproven state as if it were an advance.

Report each iteration compactly:

```
ITERATION n: discovered <gap> → built <thing> → attack <c crit / h high> → patched <delta> → confidence <score>
```

## Stop condition (all must hold)

Run `ratchet score confidence` and read BOTH `loopClear` and the workflow-closure layer
(`closure.closed`). Stop only when:

- **`loopClear` holds** — no unresolved critical/high defect, no untested core assumption,
  no missing next action.
- **`workflowClosed.closed` is true** — the active artifact carries a closure certificate
  and no open defect is unattached.
- **The artifact is genuinely usable** (passes its 5-point test).

If either read is false, run another iteration. Do not stop because the output "looks
good" — the CLI reads are the arbiter, not your impression.

There is no convergence escape. If two iterations find nothing new while
`workflowClosed.closed` is false, you are not converged — you are blocked. Stop with
`STOP REASON: blocked-needs-human`, name the blocker the closure read printed, and hand it
over. "Nothing left to try" and "finished" are different states, and only one of them is
an ending.

## Output contract

```
ITERATION LOG:
- ITERATION 1: ...
- ITERATION 2: ...
STOP REASON: closed | blocked-needs-human
WORKFLOW: CLOSED | NOT CLOSED — <blockers, if any>
FINAL CONFIDENCE: <score>/100 (<band>)
REMAINING RISK: <what a human should still watch>
NEXT: <action> → /ratchet:<command>
```

Then confirm serialization with `ratchet export markdown`.
