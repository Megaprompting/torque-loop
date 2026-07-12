// torque-loop skill graph — GENERATED, do not edit by hand.
// Source: skills/*/SKILL.md frontmatter + reference/PROMPTS.md
// Regenerate: node scripts/graph-gen.js   Drift guard: test/plugin-shape.test.js
// Scope: DERIVED from torque-loop source only. The aperture cross-links are a
// parked, declared decision — see reference/graph/README.md, not this file.
// Traced by: claude-opus-4-8[1m]

// Delete-and-rebuild: drop the whole namespace first, so a shrunk or reordered
// graph can never leave a stale node or STEP edge behind as if it were truth.
MATCH (n {ns: 'torque-loop'}) DETACH DELETE n;

// --- skills (21) ---
MERGE (s:RatchetSkill {ns: 'torque-loop', name: 'attack'})
  SET s.command = '/ratchet:attack', s.description = 'Run adversarial review on a finished-looking artifact. Use to replace self-praise with hostile pressure before shipping. Convenes a five-voice review board (impatient user, competitor, maintainer, auditor, saboteur), returns concrete failure modes with severity and evidence demanded, and the smallest patch each requires.';
MERGE (s:RatchetSkill {ns: 'torque-loop', name: 'auction'})
  SET s.command = '/ratchet:auction', s.description = 'Rank the real blockers by leverage and pick the one bottleneck to attack. Use when there are many possible next moves and you risk doing interesting-but-not-advancing work. Scores obstacles by Leverage × Certainty × Speed-to-unblock × Risk-of-ignoring and names the winner and why it beats the tempting alternative.';
MERGE (s:RatchetSkill {ns: 'torque-loop', name: 'build'})
  SET s.command = '/ratchet:build', s.description = 'Force artifact production — stop talking and make the thing. Use when a target is locked and something concrete must exist. Produces the smallest usable v0 (spec, prompt, checklist, test-suite, decision-record, code-patch, qa-ledger, or operating-procedure) with explicit holes and a 5-point working test.';
MERGE (s:RatchetSkill {ns: 'torque-loop', name: 'burn'})
  SET s.command = '/ratchet:burn', s.description = 'Kill or park the options that are quietly draining energy. Use when you are carrying option debt — too many open possibilities, none advancing. Returns a kill / park / keep table, why each option is attractive, what fear keeps it alive, what gets simpler if it dies, and one option to burn right now.';
MERGE (s:RatchetSkill {ns: 'torque-loop', name: 'compile'})
  SET s.command = '/ratchet:compile', s.description = 'Serialize the current session into durable state — the breadcrumb the next session resumes from. Use at the end of a work session or after any real advance. Returns working title, objective, decisions, artifacts, defects/risks, open loops, next action, next command, retrieval tags, and a one-sentence memory. Only keeps information that changes future behavior.';
MERGE (s:RatchetSkill {ns: 'torque-loop', name: 'cut'})
  SET s.command = '/ratchet:cut', s.description = 'Attack the hidden assumptions that could make the current plan look stupid in hindsight. Use before committing effort to a direction. Returns the load-bearing assumptions, how each breaks, the signal that would reveal the break, and the cheapest test to falsify it — then the top three kill-tests to run now.';
MERGE (s:RatchetSkill {ns: 'torque-loop', name: 'decide'})
  SET s.command = '/ratchet:decide', s.description = 'Force a single defended choice instead of a menu of options. Use when analysis has produced alternatives but no commitment. Scores options on upside, reversibility, time-to-feedback, strategic compounding, cost-of-being-wrong, and unlock value; returns the chosen path, the most tempting rejected path and why it loses, the first action, and the reversal tripwire.';
MERGE (s:RatchetSkill {ns: 'torque-loop', name: 'evolve'})
  SET s.command = '/ratchet:evolve', s.description = 'Evolve one artifact through a bounded, evidence-gated mutation loop — lock target, snapshot baseline, apply one pressure, generate candidate deltas, judge, patch, verify, keep or revert, record state, and name the next edge. Not brainstorming and not a general \'make this better\': every kept change must be proven. Use to harden a specific code file, prompt, skill, test suite, README, spec, or workflow along a chosen pressure vector.';
MERGE (s:RatchetSkill {ns: 'torque-loop', name: 'handoff'})
  SET s.command = '/ratchet:handoff', s.description = 'Produce a compact handoff for another model, agent, teammate, or future session. Use when work must transfer without losing state. Returns a self-contained brief — objective, what\'s done, what\'s decided, what\'s open, the exact next action, and the context needed to act — compressed so the receiver can start immediately with zero re-derivation.';
MERGE (s:RatchetSkill {ns: 'torque-loop', name: 'ignite'})
  SET s.command = '/ratchet:ignite', s.description = 'Run the full consequence loop on any messy task, project state, prompt pile, codebase goal, or vague direction. Use this when you do not know which Ratchet command to use. Locks a target, ranks blockers, cuts assumptions, builds the smallest artifact, attacks it, patches failures, and serializes state — ending with the single next move.';
MERGE (s:RatchetSkill {ns: 'torque-loop', name: 'lock'})
  SET s.command = '/ratchet:lock', s.description = 'Convert vague input into a locked, executable target. Use when a task is fuzzy, over-broad, or stated as a wish. Returns the literal object, operation, output shape, real outcome, proof-of-done, smallest progress artifact, the highest-information missing variable, and the assumption to adopt if it stays missing.';
MERGE (s:RatchetSkill {ns: 'torque-loop', name: 'loop'})
  SET s.command = '/ratchet:loop', s.description = 'Run recursive improvement — build → attack → patch → compile — until the artifact is genuinely done. Use to drive an artifact to a stable, tested, serialized state without stopping at the first draft. Repeats the cycle and reports an iteration log and confidence score, stopping only when no critical/high defect, no untested core assumption, and no missing next action remain.';
MERGE (s:RatchetSkill {ns: 'torque-loop', name: 'map'})
  SET s.command = '/ratchet:map', s.description = 'Map the fog before you build. Use when uncertainty is high (aperture A3–A4), the terrain is unfamiliar, the taste is "I\'ll know it when I see it", or you are porting a reference implementation. Walks the task through four unknown-quadrants — known knowns (settled ground with file evidence), known unknowns (one blast-radius-ordered question at a time), unknown knowns (tacit taste surfaced by putting something concrete in front of the user), and unknown unknowns (a swept landmine field) — then hands over one durable four-quadrant map, a tweakable build plan, and a copy-paste implementation prompt. What you deliver is the map, not a build; you do not write code until it is handed over.';
MERGE (s:RatchetSkill {ns: 'torque-loop', name: 'mechanism'})
  SET s.command = '/ratchet:mechanism', s.description = 'Name the mechanism when a situation feels confusing. Use to cut through a tangle to the one causal handle. Separates surface symptoms from the underlying mechanism, the constraint causing it, the feedback loop keeping it alive, and the highest-leverage intervention point — then the action that changes the mechanism rather than describing it.';
MERGE (s:RatchetSkill {ns: 'torque-loop', name: 'patch'})
  SET s.command = '/ratchet:patch', s.description = 'Fix only what failed — nothing else. Use after an attack surfaced defects, to prevent the model from rewriting everything for elegance. Returns the minimal delta under REMOVE / ADD / CHANGE, the patched artifact, the relevant retest result, and any defects still open.';
MERGE (s:RatchetSkill {ns: 'torque-loop', name: 'prompt-audit'})
  SET s.command = '/ratchet:prompt-audit', s.description = 'Audit a prompt library as an operating system, not a pile of prompts. Use to find what a prompt collection over-does, under-does, and where it leaks into meta-looping. Classifies each prompt by the work it performs, finds overrepresented and missing moves, flags prompts that cause meta-loops or never produce artifacts, and returns the minimum upgraded set as a sequenced workflow.';
MERGE (s:RatchetSkill {ns: 'torque-loop', name: 'push'})
  SET s.command = '/ratchet:push', s.description = 'Push the boundary after a safe version already exists. Use to find the boldest adjacent move that could multiply the result without turning it into fantasy. Returns the safe default, the boundary-pushing path, why it might work, why it might be stupid, the cheapest experiment that distinguishes them, the version to try, and the first irreversible move. Controlled aggression, never recklessness.';
MERGE (s:RatchetSkill {ns: 'torque-loop', name: 'qa-ledger'})
  SET s.command = '/ratchet:qa-ledger', s.description = 'Create or update the canonical feature / test / defect ledger for a codebase. Use to turn a repo into a durable quality record that survives sessions. Maintains features (with evidence), tests (with status), and defects (with severity) via the ratchet CLI so quality state is queryable, not remembered.';
MERGE (s:RatchetSkill {ns: 'torque-loop', name: 'repo-audit'})
  SET s.command = '/ratchet:repo-audit', s.description = 'Discover user-facing features, workflows, routes, APIs, configs, and tests in a codebase by evidence, not guesses. Use to turn an unfamiliar or under-documented repo into an inventory of what actually ships. Returns features with code evidence, undocumented screens/routes/workflows, APIs and state transitions needing tests, the highest-risk feature, and the first test suite to write.';
MERGE (s:RatchetSkill {ns: 'torque-loop', name: 'status'})
  SET s.command = '/ratchet:status', s.description = 'Read the current ratchet state so the loop doesn\'t rediscover itself. Use to orient at the start of a session or between moves. Returns the current objective, active artifact, last decision, open defects, confidence, next recommended command, and a staleness warning if work changed without a compile.';
MERGE (s:RatchetSkill {ns: 'torque-loop', name: 'verify'})
  SET s.command = '/ratchet:verify', s.description = 'Run a change (or an artifact) through a test harness built to embarrass it, then record the results as defects. Use instead of asking whether the work is good — never self-grade. Builds acceptance / happy-path / edge / abuse / ambiguity / regression tests plus fake-progress red flags, runs the artifact through them, and returns passes, failures, severity, required patches, and whether it is usable despite failures.';

// --- canonical phase path (frame -> choose -> build -> attack -> patch -> verify -> serialize -> advance) ---
MERGE (p:RatchetPhase {ns: 'torque-loop', name: 'frame'}) SET p.step = 0;
MERGE (p:RatchetPhase {ns: 'torque-loop', name: 'choose'}) SET p.step = 1;
MERGE (p:RatchetPhase {ns: 'torque-loop', name: 'build'}) SET p.step = 2;
MERGE (p:RatchetPhase {ns: 'torque-loop', name: 'attack'}) SET p.step = 3;
MERGE (p:RatchetPhase {ns: 'torque-loop', name: 'patch'}) SET p.step = 4;
MERGE (p:RatchetPhase {ns: 'torque-loop', name: 'verify'}) SET p.step = 5;
MERGE (p:RatchetPhase {ns: 'torque-loop', name: 'serialize'}) SET p.step = 6;
MERGE (p:RatchetPhase {ns: 'torque-loop', name: 'advance'}) SET p.step = 7;
MATCH (a:RatchetPhase {ns: 'torque-loop', name: 'frame'}), (b:RatchetPhase {ns: 'torque-loop', name: 'choose'}) MERGE (a)-[:NEXT_PHASE]->(b);
MATCH (a:RatchetPhase {ns: 'torque-loop', name: 'choose'}), (b:RatchetPhase {ns: 'torque-loop', name: 'build'}) MERGE (a)-[:NEXT_PHASE]->(b);
MATCH (a:RatchetPhase {ns: 'torque-loop', name: 'build'}), (b:RatchetPhase {ns: 'torque-loop', name: 'attack'}) MERGE (a)-[:NEXT_PHASE]->(b);
MATCH (a:RatchetPhase {ns: 'torque-loop', name: 'attack'}), (b:RatchetPhase {ns: 'torque-loop', name: 'patch'}) MERGE (a)-[:NEXT_PHASE]->(b);
MATCH (a:RatchetPhase {ns: 'torque-loop', name: 'patch'}), (b:RatchetPhase {ns: 'torque-loop', name: 'verify'}) MERGE (a)-[:NEXT_PHASE]->(b);
MATCH (a:RatchetPhase {ns: 'torque-loop', name: 'verify'}), (b:RatchetPhase {ns: 'torque-loop', name: 'serialize'}) MERGE (a)-[:NEXT_PHASE]->(b);
MATCH (a:RatchetPhase {ns: 'torque-loop', name: 'serialize'}), (b:RatchetPhase {ns: 'torque-loop', name: 'advance'}) MERGE (a)-[:NEXT_PHASE]->(b);

// --- canonical prompts (17) ---
MERGE (p:RatchetPrompt {ns: 'torque-loop', slug: '1-the-target-is-not-the-topic'}) SET p.title = '1 · The Target Is Not The Topic';
MERGE (p:RatchetPrompt {ns: 'torque-loop', slug: '10-the-option-burn'}) SET p.title = '10 · The Option Burn';
MERGE (p:RatchetPrompt {ns: 'torque-loop', slug: '11-the-state-compiler'}) SET p.title = '11 · The State Compiler';
MERGE (p:RatchetPrompt {ns: 'torque-loop', slug: '12-the-boundary-push'}) SET p.title = '12 · The Boundary Push';
MERGE (p:RatchetPrompt {ns: 'torque-loop', slug: '2-the-friction-auction'}) SET p.title = '2 · The Friction Auction';
MERGE (p:RatchetPrompt {ns: 'torque-loop', slug: '3-the-assumption-guillotine'}) SET p.title = '3 · The Assumption Guillotine';
MERGE (p:RatchetPrompt {ns: 'torque-loop', slug: '4-the-mechanism-knife'}) SET p.title = '4 · The Mechanism Knife';
MERGE (p:RatchetPrompt {ns: 'torque-loop', slug: '5-the-hostile-board'}) SET p.title = '5 · The Hostile Board';
MERGE (p:RatchetPrompt {ns: 'torque-loop', slug: '6-artifact-or-void'}) SET p.title = '6 · Artifact Or Void';
MERGE (p:RatchetPrompt {ns: 'torque-loop', slug: '7-the-embarrassment-harness'}) SET p.title = '7 · The Embarrassment Harness';
MERGE (p:RatchetPrompt {ns: 'torque-loop', slug: '8-the-delta-surgeon'}) SET p.title = '8 · The Delta Surgeon';
MERGE (p:RatchetPrompt {ns: 'torque-loop', slug: '9-the-decision-spike'}) SET p.title = '9 · The Decision Spike';
MERGE (p:RatchetPrompt {ns: 'torque-loop', slug: 'master-ignition-prompt-consequence-engine'}) SET p.title = 'Master Ignition Prompt (consequence engine)';
MERGE (p:RatchetPrompt {ns: 'torque-loop', slug: 'prompt-library-evolution-prompt'}) SET p.title = 'Prompt-library evolution prompt';
MERGE (p:RatchetPrompt {ns: 'torque-loop', slug: 'software-qa-agent-prompt'}) SET p.title = 'Software QA agent prompt';
MERGE (p:RatchetPrompt {ns: 'torque-loop', slug: 'state-compiler-aimed-at-another-agent'}) SET p.title = 'State Compiler, aimed at another agent';
MERGE (p:RatchetPrompt {ns: 'torque-loop', slug: 'the-fog-map-four-quadrant-unknowns-walk'}) SET p.title = 'The Fog Map (four-quadrant unknowns walk)';

// --- skill implements prompt (19) ---
MATCH (s:RatchetSkill {ns: 'torque-loop', name: 'attack'}), (p:RatchetPrompt {ns: 'torque-loop', slug: '5-the-hostile-board'}) MERGE (s)-[:IMPLEMENTS]->(p);
MATCH (s:RatchetSkill {ns: 'torque-loop', name: 'auction'}), (p:RatchetPrompt {ns: 'torque-loop', slug: '2-the-friction-auction'}) MERGE (s)-[:IMPLEMENTS]->(p);
MATCH (s:RatchetSkill {ns: 'torque-loop', name: 'build'}), (p:RatchetPrompt {ns: 'torque-loop', slug: '6-artifact-or-void'}) MERGE (s)-[:IMPLEMENTS]->(p);
MATCH (s:RatchetSkill {ns: 'torque-loop', name: 'burn'}), (p:RatchetPrompt {ns: 'torque-loop', slug: '10-the-option-burn'}) MERGE (s)-[:IMPLEMENTS]->(p);
MATCH (s:RatchetSkill {ns: 'torque-loop', name: 'compile'}), (p:RatchetPrompt {ns: 'torque-loop', slug: '11-the-state-compiler'}) MERGE (s)-[:IMPLEMENTS]->(p);
MATCH (s:RatchetSkill {ns: 'torque-loop', name: 'cut'}), (p:RatchetPrompt {ns: 'torque-loop', slug: '3-the-assumption-guillotine'}) MERGE (s)-[:IMPLEMENTS]->(p);
MATCH (s:RatchetSkill {ns: 'torque-loop', name: 'decide'}), (p:RatchetPrompt {ns: 'torque-loop', slug: '9-the-decision-spike'}) MERGE (s)-[:IMPLEMENTS]->(p);
MATCH (s:RatchetSkill {ns: 'torque-loop', name: 'handoff'}), (p:RatchetPrompt {ns: 'torque-loop', slug: 'state-compiler-aimed-at-another-agent'}) MERGE (s)-[:IMPLEMENTS]->(p);
MATCH (s:RatchetSkill {ns: 'torque-loop', name: 'ignite'}), (p:RatchetPrompt {ns: 'torque-loop', slug: 'master-ignition-prompt-consequence-engine'}) MERGE (s)-[:IMPLEMENTS]->(p);
MATCH (s:RatchetSkill {ns: 'torque-loop', name: 'lock'}), (p:RatchetPrompt {ns: 'torque-loop', slug: '1-the-target-is-not-the-topic'}) MERGE (s)-[:IMPLEMENTS]->(p);
MATCH (s:RatchetSkill {ns: 'torque-loop', name: 'map'}), (p:RatchetPrompt {ns: 'torque-loop', slug: 'the-fog-map-four-quadrant-unknowns-walk'}) MERGE (s)-[:IMPLEMENTS]->(p);
MATCH (s:RatchetSkill {ns: 'torque-loop', name: 'mechanism'}), (p:RatchetPrompt {ns: 'torque-loop', slug: '4-the-mechanism-knife'}) MERGE (s)-[:IMPLEMENTS]->(p);
MATCH (s:RatchetSkill {ns: 'torque-loop', name: 'patch'}), (p:RatchetPrompt {ns: 'torque-loop', slug: '8-the-delta-surgeon'}) MERGE (s)-[:IMPLEMENTS]->(p);
MATCH (s:RatchetSkill {ns: 'torque-loop', name: 'prompt-audit'}), (p:RatchetPrompt {ns: 'torque-loop', slug: 'prompt-library-evolution-prompt'}) MERGE (s)-[:IMPLEMENTS]->(p);
MATCH (s:RatchetSkill {ns: 'torque-loop', name: 'push'}), (p:RatchetPrompt {ns: 'torque-loop', slug: '12-the-boundary-push'}) MERGE (s)-[:IMPLEMENTS]->(p);
MATCH (s:RatchetSkill {ns: 'torque-loop', name: 'qa-ledger'}), (p:RatchetPrompt {ns: 'torque-loop', slug: 'software-qa-agent-prompt'}) MERGE (s)-[:IMPLEMENTS]->(p);
MATCH (s:RatchetSkill {ns: 'torque-loop', name: 'repo-audit'}), (p:RatchetPrompt {ns: 'torque-loop', slug: 'software-qa-agent-prompt'}) MERGE (s)-[:IMPLEMENTS]->(p);
MATCH (s:RatchetSkill {ns: 'torque-loop', name: 'verify'}), (p:RatchetPrompt {ns: 'torque-loop', slug: '7-the-embarrassment-harness'}) MERGE (s)-[:IMPLEMENTS]->(p);
MATCH (s:RatchetSkill {ns: 'torque-loop', name: 'verify'}), (p:RatchetPrompt {ns: 'torque-loop', slug: 'software-qa-agent-prompt'}) MERGE (s)-[:IMPLEMENTS]->(p);
