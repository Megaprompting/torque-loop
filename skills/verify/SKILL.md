---
name: verify
description: Run a change (or an artifact) through a test harness built to embarrass it, then record the results as defects. Use instead of asking whether the work is good — never self-grade. Builds acceptance / happy-path / edge / abuse / ambiguity / regression tests plus fake-progress red flags, runs the artifact through them, and returns passes, failures, severity, required patches, and whether it is usable despite failures.
---

# /ratchet:verify — the embarrassment harness

Do not grade the artifact. Asking a model "how good is this?" gets you self-praise. This
command instead builds a harness designed to *embarrass* the artifact, then runs it
through. Validation, not vibes.

## Step 0 — Load state and target

```
ratchet status
ratchet snapshot repo
```

Identify the change or artifact under test (usually the last artifact, or the current diff).

## Build the harness

Construct all seven, then run the artifact against them:

1. **Acceptance criteria** — the conditions that define "correct".
2. **Happy-path test** — the intended use, working.
3. **Edge-case tests** — boundaries: empty, huge, zero, negative, unicode, concurrent.
4. **Abuse / misuse tests** — hostile or wrong input a real user will eventually send.
5. **Ambiguity tests** — under-specified inputs where behavior is undefined.
6. **Regression tests** — what previously worked and must still work.
7. **Fake-progress red flags** — the tells that this is theater: passes only on the
   author's example, swallows errors, asserts nothing, tests the mock not the code.

**Run the artifact through the harness for real.** Where a runtime exists, execute it via
Bash — do not simulate a pass in your head. Report the actual result.

## Output contract

```
HARNESS: <the tests, briefly>
RESULTS:
- PASS: <checks that held>
- FAIL: <check> — <what happened> — severity: critical/high/medium/low
RED FLAGS: <any fake-progress tells found, or "none">
USABLE DESPITE FAILURES? <yes/no + one-line reason>
REQUIRED PATCHES: <smallest delta per failure>
```

## Serialize

Run the harness BOUND to the artifact it is about, so the evidence names the exact bytes
it was gathered against:

```
ratchet-evolve verify <target> --artifact <id> --test "<the command>" --json
```

That prints `verifiedHash` and `verifiedRev`. Carry **both** into the log append — it
recomputes them and refuses if the file moved (`file changed after verification`) or if
the artifact was revised after the harness ran (`artifact revised after verification`).
The hash alone cannot catch a metadata-only revision: retitle an artifact and the file
is untouched while the revision moves, so rev-1 evidence would be stamped onto rev 2.

```
ratchet-evolve log append '{"target":"<target>","artifactId":"<id>","verdict":"KEEP",
  "verification":{...from verify --json...},
  "verifiedHash":"<from verify>","verifiedRev":<from verify>,
  "seam":{"seamMatch":"exact","independentFromBuilderMethod":true,...}}'
```

On RED, record every failure as a defect and go patch:

```
ratchet defect add '{"severity":"...","summary":"verify: <failure>","artifact":"<id>","feature":"<ledger feature id>"}'
ratchet ledger update tests '{"feature":"<id>","name":"<test>","status":"fail"}'
ratchet score confidence
```

On GREEN, the run has earned the ending — close the artifact:

```
ratchet artifact close <id>
```

Next: on red, `/ratchet:patch` the failures then re-run `/ratchet:verify`. On green, the
close above, then `/ratchet:compile`. A change isn't done because it typechecks — it's done
because the harness couldn't embarrass it, and the proof is bound to that exact revision.
Revising the artifact invalidates it: no proof → no close.
