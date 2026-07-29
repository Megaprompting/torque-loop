---
name: attack
description: Run adversarial review on a finished-looking artifact. Use to replace self-praise with hostile pressure before shipping. Convenes a five-voice review board (impatient user, competitor, maintainer, auditor, saboteur), returns concrete failure modes with severity and evidence demanded, and the smallest patch each requires.
---

# /ratchet:attack — hostile validation

Self-review is theater. The model that built the artifact is the worst judge of it. This
command assumes the artifact is wrong and spends its effort proving where.

## Step 0 — Load state and target

```
ratchet status
```

Identify the artifact under attack (usually the last one in state). For anything that
looks finished, delegate the assault to the `ratchet-auditor` subagent.

## The five-voice board

Speak in each voice distinctly. Do not blur them into generic "concerns".

1. **Impatient User** — slower, harder, or more confusing than the alternative.
2. **Competitor** — where a rival beats this and takes the user.
3. **Maintainer** — how this rots or becomes unchangeable in six months.
4. **Auditor** — which claims are asserted without evidence.
5. **Saboteur** — the specific input or state that makes it fall over.

## Rules

- **Every objection is a concrete failure scenario:** specific input/state → wrong output
  or crash. "Might be fragile" is not a finding; "empty input throws at step 3" is.
- **Rank by severity:** critical / high / medium / low. Critical = wrong result, data
  loss, or unusable. Order most-severe first.
- **Demand evidence** for every self-serving claim ("robust", "fast", "complete"). Find
  the contradicting case or mark the claim unproven.
- **Name the smallest patch** each finding needs — REMOVE / ADD / CHANGE. You specify the
  delta; you do not apply it here.
- **Flag fog, not just defects.** A finding that says the *premise* was wrong — a hidden
  convention, wrong-by-default data, a claim that contradicts the locked target or the
  unknowns-map — is fog the aperture missed, not merely a bug. Serialize it
  (`ratchet state append assumptions ...` with a kill test, or an `openLoops` entry
  prefixed `fog:`), and at two or more such findings recommend `/ratchet:map` before any
  further patching: you are patching inside unmapped terrain.

## Output contract

```
VERDICT: ship | patch-then-ship | do-not-ship
FINDINGS (most severe first):
- [CRITICAL] <voice> — <failure scenario> → <REMOVE/ADD/CHANGE ...>
- [HIGH] ...
UNPROVEN CLAIMS:
- "<quote>" — evidence demanded: ...
```

## Serialize

Record every real defect (one call each) so confidence reflects reality:

```
ratchet defect add '{"severity":"critical","summary":"...","artifact":"<id>"}'
ratchet state set phase attack
```

Name the artifact the defect attacks. With exactly one live artifact the CLI attaches it
for you; with two or more it refuses rather than guess, because attaching to the wrong one
blocks the innocent artifact's closure and lets the guilty one close clean.

If nothing critical or high survived a genuine attack, say so plainly — that is a real
result. Next: `/ratchet:patch` to fix exactly what failed.
