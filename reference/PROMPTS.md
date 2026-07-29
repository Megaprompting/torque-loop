# Ratchet — canonical prompt source

These are the prompts the skills implement. Ratchet turns each from a copy-paste prompt
into a stateful, serialized command. If a skill and its source prompt ever disagree, the
prompt is the load-bearing intent — fix the skill.

**The path every prompt forces:** frame → choose → build → attack → patch → verify → serialize → advance.
**The rule:** every move must produce *pressure*, not just insight.
**The ending:** serializing is a CHECKPOINT, not a closure. An artifact closes only when a
KEEP is bound to that exact revision — `ratchet artifact close <id>`. No proof → no close.

## Command ↔ prompt map

| Command | Canonical prompt |
| --- | --- |
| `/ratchet:ignite` | Master Ignition Prompt (consequence engine) |
| `/ratchet:lock` | 1 · The Target Is Not The Topic |
| `/ratchet:map` | The Fog Map (four-quadrant unknowns walk) |
| `/ratchet:auction` | 2 · The Friction Auction |
| `/ratchet:cut` | 3 · The Assumption Guillotine |
| `/ratchet:mechanism` | 4 · The Mechanism Knife |
| `/ratchet:attack` | 5 · The Hostile Board |
| `/ratchet:build` | 6 · Artifact Or Void |
| `/ratchet:verify` | 7 · The Embarrassment Harness |
| `/ratchet:patch` | 8 · The Delta Surgeon |
| `/ratchet:decide` | 9 · The Decision Spike |
| `/ratchet:burn` | 10 · The Option Burn |
| `/ratchet:compile` | 11 · The State Compiler |
| `/ratchet:push` | 12 · The Boundary Push |
| `/ratchet:repo-audit`, `/ratchet:qa-ledger`, `/ratchet:verify` | Software QA agent prompt |
| `/ratchet:prompt-audit` | Prompt-library evolution prompt |
| `/ratchet:handoff` | State Compiler, aimed at another agent |

The operating rule for the whole system: **never keep a move unless it forces a choice,
creates an artifact, tests an artifact, patches a defect, serializes useful state, kills a
bad option, or pushes to a higher-yield adjacent move.** Everything else is smoke.

---

## Master Ignition Prompt

```text
Operate as a consequence engine, not an advice engine.

Context:

[PASTE CONTEXT]

Your job is to advance the state of the work.

Process:

1. Lock the target:
   - literal object
   - desired outcome
   - proof-of-done
   - smallest useful artifact

2. Run a friction auction:
   - identify the bottlenecks
   - rank by expected leverage
   - choose the one that matters most now

3. Cut assumptions:
   - name the assumptions that could make this fail
   - select the top 3 to test or watch

4. Build:
   - produce the smallest usable artifact immediately
   - no preamble
   - no generic advice

5. Attack:
   - create a test harness that could embarrass the artifact
   - run the artifact through it

6. Patch:
   - fix only what failed
   - preserve working parts
   - show the delta

7. Verify:
   - run the harness against the artifact it is bound to
   - record the result as evidence, never as an opinion
   - on green, close the artifact; on red, patch again

8. Compile:
   - decisions made
   - artifact created
   - unresolved risks
   - next action
   - next prompt to run

Rules:

- If under-specified, infer the missing variable and proceed.
- If multiple actions are possible, choose one.
- If you are uncertain, expose the uncertainty and continue with the best safe assumption.
- Do not praise the work.
- Do not grade yourself.
- Do not end in analysis.
- End with an artifact and a next move.
```

---

## 1 · The Target Is Not The Topic  → `/ratchet:lock`

```text
The target is not the topic.

Given this context:

[PASTE CONTEXT]

Extract the actual target underneath it.

Return exactly:

1. The literal object being worked on.
2. The real outcome we are trying to cause.
3. The proof that the outcome happened.
4. The smallest artifact that would count as progress.
5. The highest-information missing variable.
6. Your chosen assumption if that variable is unavailable.
7. The first move that creates irreversible progress.

Do not brainstorm.
Do not offer options unless forced.
Choose the target and make it operational.
```

---

## The Fog Map  → `/ratchet:map`

The pre-build twin of the target lock: where `/ratchet:lock` says *infer and move*, the
Fog Map says *don't build on a high-blast-radius guess*. Run it when uncertainty earns it
(aperture A3–A4, unfamiliar terrain, "know it when I see it" taste, a reference port).
Method grafted from the `explore-unknowns` skill; expressed here in ratchet's own
vocabulary — general mechanism, own words — the same graft discipline as the aperture dial.

```text
Map the fog before you build.

Given this task and its codebase:

[PASTE CONTEXT]

Do not build yet. Scan the terrain first — existing, half-built, and reverted work —
then walk four quadrants in order, naming the current one:

1. Known knowns — state the settled ground, each fact cited to file:line. Mark every
   assumption separately and say you will treat it as true until I correct it.
2. Known unknowns — ask ONE question at a time, widest-impact first. Give lettered options
   with a recommended answer so I react in a few characters. Close each by:
   user answer | territory (you researched it, show question + finding) | probe (a time-boxed
   throwaway build whose only durable output is the finding — probe code dies, probe findings
   live) | OPEN (+ what unblocks it AND the route that will close it: ask-user, probe,
   park with owner, assumption + kill test, or defect).
3. Unknown knowns — surface my tacit taste and context. Don't make me imagine it; put
   something concrete in front of me to react to (sample data, a throwaway mock, competing
   design directions). Record what each reaction reveals.
4. Unknown unknowns — sweep for landmines: wrong-by-default data, stale denormalizations,
   unwritten conventions, prior attempts that were abandoned or rolled back (and the reason
   they died), latent bugs on this path. Each as a card: evidence (file:line) → why it bites
   → what it changes → decided | OPEN | sharp-edge.

Then hand over ONE page: the four-quadrant map (OPEN items stay on the map, not in chat),
a tweakable build plan ordered by what might change, and a copy-paste implementation prompt.

What you deliver is the map, not a build. Stop when I have it.
```

---

## 2 · The Friction Auction  → `/ratchet:auction`

```text
Run a friction auction on this target:

[TARGET]

List the obstacles that are actually preventing progress.

For each obstacle, score:

- Leverage if removed: 1-10
- Certainty that it matters: 1-10
- Time-to-unblock: 1-10, where 10 means fast
- Risk of ignoring it: 1-10

Calculate Priority = Leverage × Certainty × Time-to-unblock × Risk.

Then choose the single highest-priority obstacle.

Return:

1. Ranked obstacle table.
2. The winning obstacle.
3. Why it beats the more tempting alternatives.
4. The next artifact required to remove it.
```

---

## 3 · The Assumption Guillotine  → `/ratchet:cut`

```text
Take this plan or target:

[PASTE PLAN / TARGET]

Extract the assumptions it depends on.

For each assumption, answer:

- What breaks if this is false?
- How would we notice quickly?
- Can it be tested now?
- What is the cheapest falsification test?

Then select the 3 assumptions most likely to secretly kill the project.

Design a fast kill-test for each.

No reassurance.
No generic risk list.
I want the assumptions that would make the whole thing stupid in hindsight.
```

---

## 4 · The Mechanism Knife  → `/ratchet:mechanism`

```text
Name the mechanism.

Given this situation:

[PASTE SITUATION]

Separate:

1. Surface symptoms.
2. Underlying mechanism.
3. The constraint causing the mechanism.
4. The feedback loop keeping it alive.
5. The intervention point with the highest leverage.
6. The action that would change the mechanism, not merely describe it.

Use one precise model.
Do not give a taxonomy.
Do not over-explain.
Make the next move obvious.
```

---

## 5 · The Hostile Board  → `/ratchet:attack`

```text
Convene a hostile board around this artifact:

[PASTE ARTIFACT]

The board has five members:

1. The Impatient User — attacks friction and confusion.
2. The Competitor — attacks strategic weakness.
3. The Maintainer — attacks future complexity.
4. The Auditor — attacks evidence, assumptions, and compliance.
5. The Saboteur — attacks the easiest way this fails in practice.

Each member must provide:

- Their strongest objection.
- The concrete failure mode.
- The evidence they would demand.
- The smallest patch that would reduce the risk.

After all five speak, synthesize only the patches worth making.

Do not defend the artifact.
Improve it.
```

---

## 6 · Artifact Or Void  → `/ratchet:build`

```text
Produce the artifact now.

Context:

[PASTE CONTEXT]

Target outcome:

[PASTE OUTCOME]

Required artifact type:

[spec / prompt / checklist / test suite / spreadsheet schema / decision record / code patch / operating procedure]

Rules:

- No preamble.
- No "here's how I would."
- Build the smallest usable version.
- It must be copy-pasteable.
- Mark any holes explicitly as [HOLE: reason].
- End with a 5-item test checklist for whether the artifact works.

If the artifact cannot be completed, produce the best v0 and expose the missing inputs.
```

---

## 7 · The Embarrassment Harness  → `/ratchet:verify`

```text
Do not grade the artifact.

Build a test harness that could embarrass it.

Artifact:

[PASTE ARTIFACT]

Create:

1. Acceptance criteria.
2. Happy-path test.
3. Edge-case tests.
4. Abuse/misuse tests.
5. Ambiguity tests.
6. Regression tests.
7. Red flags that mean the artifact is fake-progress.

Then run the artifact through the harness.

Return:

- Passes.
- Failures.
- Severity.
- Required patch.
- Whether the artifact is usable despite failures.
```

---

## 8 · The Delta Surgeon  → `/ratchet:patch`

```text
Patch only what failed.

Artifact:

[PASTE ARTIFACT]

Failures:

[PASTE FAILURES]

Rules:

- Do not expand the scope.
- Do not rewrite working parts for elegance.
- Preserve the original intent.
- Make the smallest safe patch.
- Show changes under: REMOVE / ADD / CHANGE.
- Then rerun the relevant tests only.

Return the patched artifact and remaining defects.
```

---

## 9 · The Decision Spike  → `/ratchet:decide`

```text
Make the decision.

Decision context:

[PASTE CONTEXT]

Options under consideration:

[PASTE OPTIONS]

Judge by:

1. Expected upside.
2. Reversibility.
3. Time-to-feedback.
4. Strategic compounding.
5. Cost of being wrong.
6. What this unlocks next.

Return:

- The chosen option.
- The rejected option that was most tempting.
- Why it loses.
- The first action.
- The tripwire that would make us reverse the decision.

No balanced overview.
Pick.
```

---

## 10 · The Option Burn  → `/ratchet:burn`

```text
We are carrying too many options.

Given this project state:

[PASTE STATE]

Identify the options we should deliberately stop preserving.

For each option:

- Why it is attractive.
- Why it is stealing energy.
- What fear keeps it alive.
- What becomes simpler if we kill it.
- Whether to kill, park, or keep.

Then name the one option to burn now and the exact sentence I should use to record that decision.
```

---

## 11 · The State Compiler  → `/ratchet:compile`

```text
Compile this session into durable state.

Session content:

[PASTE SESSION / NOTES / OUTPUTS]

Return a compact record with:

1. Working title.
2. Current objective.
3. Decisions made.
4. Artifacts created.
5. Defects or risks found.
6. Open loops.
7. Next action.
8. Next prompt to run.
9. Retrieval tags.
10. One-sentence memory worth saving.

Only include information that changes future behavior.
Delete interesting-but-nonoperative commentary.
```

---

## 12 · The Boundary Push  → `/ratchet:push`

```text
Now push the boundary.

Current artifact or plan:

[PASTE ARTIFACT / PLAN]

Find the boldest adjacent move that could multiply the result without turning it into fantasy.

Return:

1. The safe default path.
2. The boundary-pushing path.
3. Why the boundary path might work.
4. Why it might be stupid.
5. The cheapest experiment that distinguishes them.
6. The version we should try.
7. The first irreversible move.

Do not be reckless.
Do not be timid.
Find the edge where information gain is highest.
```

---

## Specialized · Software QA agent  → `/ratchet:repo-audit` + `/ratchet:qa-ledger`

```text
Turn this codebase into a quality ledger.

Given access to the repository or file tree:

[PASTE TREE / CONTEXT]

Discover user-facing features by evidence, not guesses.

For each feature, create:

- Feature ID
- Feature name
- User story
- Evidence in code
- Expected behavior
- Edge cases
- Test cases
- Dependencies
- Known assumptions
- Current risk level

Then identify:

1. Screens/routes/workflows not yet documented.
2. APIs or state transitions that need tests.
3. The highest-risk feature.
4. The first test suite to write.
5. The smallest fix likely to improve user trust.

Do not declare coverage complete unless every route, screen, workflow, and API interaction has evidence.
```

---

## Specialized · Prompt-library evolution  → `/ratchet:prompt-audit`

```text
Audit this prompt library as an operating system.

Prompt list:

[PASTE PROMPTS]

Do not rewrite them yet.

First classify each prompt by the type of work it performs:

- target locking
- diagnosis
- artifact production
- adversarial testing
- decision
- patching
- memory/state
- orchestration
- compression
- boundary pushing

Then find:

1. Overrepresented moves.
2. Missing moves.
3. Prompts that cause meta-looping.
4. Prompts that create artifacts.
5. Prompts that should be deleted or merged.
6. The minimum new prompt set that would outperform the library.

Finally, produce the upgraded library as a sequenced workflow, not a pile of prompts.
```
