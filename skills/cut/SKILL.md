---
name: cut
description: Attack the hidden assumptions that could make the current plan look stupid in hindsight. Use before committing effort to a direction. Returns the load-bearing assumptions, how each breaks, the signal that would reveal the break, and the cheapest test to falsify it — then the top three kill-tests to run now.
---

# /ratchet:cut — the anti-delusion pass

Every plan rests on assumptions. Most are fine. A few are load-bearing and wrong, and
those are the ones that waste days. This command finds them and hands you the cheapest
test to kill each before it costs you.

## Step 0 — Load state

```
ratchet status
```

## Procedure

1. **Surface the assumptions** the current objective and chosen bottleneck depend on.
   Include the silent ones — "the API returns what the docs say", "the user actually
   wants this", "this file is the source of truth", "the test suite covers this path".

2. For each assumption, specify:
   - **Breakage mode** — what specifically goes wrong if it is false.
   - **Detection signal** — the observable that would reveal the break.
   - **Falsification test** — the cheapest action that would prove it false. Prefer a
     five-minute check over a five-hour build.

3. **Rank by damage × likelihood.** An assumption that is cheap to test and catastrophic
   if wrong goes first.

4. **Pick the top three kill-tests** — the ones worth running before any further build.
   A kill-test is a test designed to *end* the plan cheaply, not to confirm it.

5. **A SURVIVE is only as strong as the attack shown.** When a kill-test fails to kill,
   report SURVIVE with the attack visible and still name the specific break case, so the
   next reviewer knows where the edge is. "Could not break it" is the only evidence of
   soundness; a weak attack yields a weak SURVIVE.

## Output contract

```
ASSUMPTIONS (ranked by damage × likelihood):
- <assumption> | breaks: <mode> | signal: <detection> | test: <cheapest falsification>
- ...

TOP 3 KILL-TESTS (run before building):
1. <test> — kills the plan if: <result>
2. ...
3. ...
```

## Serialize

Record the riskiest untested assumptions so the loop can't forget them:

```
ratchet state append assumptions '{"text":"...","killTest":"...","status":"untested"}'
ratchet state set phase cut
```

Untested assumptions drain confidence (`ratchet score confidence`). Run the kill-tests,
then mark survivors: append with `"status":"tested"` or `"status":"killed"`.

Next: if the plan survives, `/ratchet:build`. If a kill-test lands, `/ratchet:lock` again.
