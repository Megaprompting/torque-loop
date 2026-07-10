---
name: preflight
description: The pre-PR hostile pass for torque-loop. Runs scripts/preflight.js for the deterministic checks (tests, version alignment, dependency gate, leak scan, trace tags) then applies human judgment to the checks a script can't rule on (testless changes, prose-enforcement, diff minimality, parked-decision creep, scope, changelog). Use before any commit that will become a PR. Emits PASS/FAIL per check; never fixes silently.
argument-hint: "[base-ref, default main]"
---

# /preflight — embarrass the branch before the reviewer does

v0.7 shipped, got reviewed, and needed a same-day PATCH-THEN-KEEP hardening pass
(fog write bypassed on `--json`, probe invariants convention-only, gated reasons
unenforced). Every one was findable before the PR. This skill is that finding pass.

The mechanizable checks live in a script, not in prose — a discipline a model has to
remember to run is weak. `scripts/preflight.js` owns the deterministic verdicts; this
skill runs it, then does the judgment the script deliberately leaves open.

## Step 1 — Run the mechanical pass

```
npm run preflight          # or: node scripts/preflight.js [base-ref]   (default base: main)
```

It prints all 12 checks in a fixed shape and exits non-zero if any **MECHANICAL** check
fails. Trust its verdict on these five — they need no judgment:

- **1 green world** — `npm test` + `ratchet doctor` both exit 0.
- **4 version alignment** — five version fields + README examples all match.
- **7 dependency gate** — no new `dependencies`/`devDependencies` (or a Danny quote in `[Unreleased]`).
- **9 leak scan** — no private paths (`reference/PROBLEM-STATEMENT-*`, `*.private.md`,
  `.lucid/`, `.ratchet/`, `.sandbox-*`) and no exact private-line quotes in the diff.
- **10 trace tags** — changed durable docs (`CLAUDE.md`, `reference/*`, handoffs) carry a
  `Traced by:` tag; commits carry a `Co-authored-by` footer. `templates/` is exempt.

A MECHANICAL FAIL is real; fix it before anything else. The script's `SMALLEST PATCHES`
block names each fix.

## Step 2 — Rule on the checks the script only gathers evidence for

The script prints these as `HUMAN:` lines with the candidates it found. You make the call —
it cannot. **Read the gathered evidence, then decide PASS/FAIL for each:**

- **2 testless change** *(weak signal — distrust a clean line)*. The script's token-grep is
  noisy: common identifiers match half the suite, so "has test hits" is near-meaningless.
  For every `src/`|`bin/` hunk, name the specific test that fails without it. No name → FAIL.
- **3 weakened falsifier.** The script flags removed asserts / newly-loose lines in `test/`.
  Decide whether any assertion was genuinely loosened without a commit-body reason. If so → FAIL.
- **5 prose enforcement.** The script lists new `must`/`never`/`requires` lines in
  SKILL.md/README. For each, point at the CLI line that enforces it + the test proving the
  refusal throws, OR confirm the CHANGELOG labels it prompt-level. Unlabeled invariant → FAIL.
- **6 diff minimality.** The script catches renames + whitespace-only files (the cheap
  cases) and is blind to elegance-churn (the expensive one). Map every remaining hunk to the
  locked target yourself. Any hunk that doesn't map → FAIL: `revert this hunk`.
- **8 parked-decision creep.** The script lists parked loop ids and any the diff mentions.
  Decide whether a hunk actually *implements* a parked loop (a mention alone is fine). If so → FAIL.
- **11 scope + emptiness** *(weak signal)*. For any new score/read the script surfaced,
  confirm it exposes a `scope:` field and that new rendered sections state emptiness.
- **12 changelog.** The script shows whether `[Unreleased]` was touched and whether a
  CLI-enforced/prompt-level label is present. Decide if behavior changed and the entry is adequate.

## Output contract

Report the script's mechanical verdicts verbatim, then your judgment verdicts:

```
PREFLIGHT vs <base>
MECHANICAL (from script): 1,4,7 PASS · 9,10 <PASS|FAIL + detail>
JUDGMENT:
  2 testless ....... PASS|FAIL <file:hunk → missing falsifier>
  3 weakened ....... PASS|FAIL
  5 prose .......... PASS|FAIL <claim → where enforcement should live>
  6 minimality ..... PASS|FAIL <hunks to revert>
  8 parked ......... PASS|FAIL <loop id>
 11 scope .......... PASS|FAIL
 12 changelog ...... PASS|FAIL
VERDICT: CLEAR TO COMMIT | BLOCKED — <count> failures
SMALLEST PATCHES: <one line per failure, in fix order>
```

This skill only reports; apply patches in a follow-up step, then re-run. The next move
after CLEAR is `/release-cut` (if releasing) or the PR.

<!-- Traced by: claude-opus-4-8[1m] · 2026-07-07 (thinned to wrap scripts/preflight.js; drafted by claude-fable-5) -->
