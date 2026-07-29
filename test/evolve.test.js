'use strict';

// Zero-dependency smoke test for the evolve helpers. Run: node test/evolve.test.js
// Uses an isolated temp log so it never touches a real .ratchet/ dir.

const os = require('os');
const path = require('path');
const fs = require('fs');
const assert = require('assert');

const tmp = path.join(os.tmpdir(), 'ratchet-evolve-test-' + process.pid);
fs.rmSync(tmp, { recursive: true, force: true });
fs.mkdirSync(tmp, { recursive: true });
process.env.RATCHET_EVOLVE_LOG = path.join(tmp, 'evolve-log.jsonl');
process.env.RATCHET_NOW = '2026-07-03T00:00:00.000Z';

const snapshot = require('../src/evolve/snapshot');
const score = require('../src/evolve/score');
const verify = require('../src/evolve/verify');
const journal = require('../src/evolve/journal');
const pressure = require('../src/evolve/pressure');
const schema = require('../src/evolve/schema');

let passed = 0;
function ok(name, fn) {
  fn();
  passed++;
  process.stdout.write(`  ok  ${name}\n`);
}

ok('mode detection by extension', () => {
  assert.strictEqual(snapshot.detectMode('src/auth/session.js'), 'code');
  assert.strictEqual(snapshot.detectMode('README.md'), 'docs');
  assert.strictEqual(snapshot.detectMode('skills/x/SKILL.md'), 'prompt');
  assert.strictEqual(snapshot.detectMode('hooks/hooks.json'), 'workflow');
});

ok('snapshot hashes an existing file + non-file goal', () => {
  const f = path.join(tmp, 'artifact.txt');
  fs.writeFileSync(f, 'hello');
  const s1 = snapshot.snapshot({ target: f, mode: 'auto' });
  assert.strictEqual(s1.exists, true);
  assert.strictEqual(s1.bytes, 5);
  assert.ok(/^[0-9a-f]{64}$/.test(s1.baselineHash));

  const s2 = snapshot.snapshot({ target: 'a-feature-not-a-file', goal: 'x', mode: 'code' });
  assert.strictEqual(s2.exists, false);
  assert.ok(/^[0-9a-f]{64}$/.test(s2.baselineHash), 'hashes the goal when no file');
});

ok('mutation scoring picks the highest and ranks', () => {
  const r = score.scoreAndChoose([
    { name: 'weak', impact: 1, evidence: 1, reversibility: 1, goalFit: 1, risk: 5, complexity: 5 },
    { name: 'strong', impact: 5, evidence: 5, reversibility: 5, goalFit: 5, risk: 1, complexity: 1 },
  ]);
  assert.strictEqual(r.chosen.name, 'strong');
  assert.strictEqual(r.chosen.score, 5 * 5 * 5 * 5 - 1 - 1); // 623
  assert.strictEqual(r.mutations[1].score, 1 - 5 - 5); // -9
  assert.strictEqual(r.chosen.rank, 1);
});

ok('score rejects empty / non-array', () => {
  assert.throws(() => score.scoreAndChoose([]), /non-empty/);
  assert.throws(() => score.scoreAndChoose('nope'), /array/);
});

ok('verify runs a passing command', () => {
  const v = verify.verify({ target: 't', testCommand: process.platform === 'win32' ? 'cmd /c exit 0' : 'true', mode: 'code' });
  assert.strictEqual(v.result, 'pass');
  assert.strictEqual(v.commands[0].pass, true);
});

ok('verify reports a failing command', () => {
  const v = verify.verify({ target: 't', testCommand: process.platform === 'win32' ? 'cmd /c exit 1' : 'false', mode: 'code' });
  assert.strictEqual(v.result, 'fail');
  assert.strictEqual(v.commands[0].pass, false);
});

ok('verify without a command returns manual checks', () => {
  const v = verify.verify({ target: 't', mode: 'prompt' });
  assert.strictEqual(v.result, 'manual');
  assert.ok(v.manualChecks.length >= 2);
});

ok('journal appends events with dated ids and status', () => {
  const e1 = journal.appendEvent(process.cwd(), {
    target: 'a.md',
    verdict: 'KEEP',
    nextEdge: 'do x',
    verification: { manualChecks: ['reviewed the delta'], result: 'manual' },
  });
  assert.strictEqual(e1.id, 'evo_2026_07_03_001');
  const e2 = journal.appendEvent(process.cwd(), { target: 'a.md', verdict: 'REVERT' });
  assert.strictEqual(e2.id, 'evo_2026_07_03_002');
  const s = journal.status(process.cwd());
  assert.strictEqual(s.events, 2);
  assert.strictEqual(s.kept, 1);
  assert.strictEqual(s.reverted, 1);
  assert.strictEqual(s.asks, 0);
  assert.strictEqual(s.last.verdict, 'REVERT');
});

ok('proof gate: KEEP is allowed with command or manual evidence', () => {
  const keep = (over) => schema.newEvent({ target: 't', verdict: 'KEEP', ...over });
  // passing command evidence
  schema.validateKeepGate(keep({ verification: { commands: [{ pass: true }], result: 'pass' } }));
  // explicit manual checks
  schema.validateKeepGate(keep({ verification: { manualChecks: ['a lazy model cannot escape'], result: 'manual' } }));
});

ok('proof gate: KEEP is rejected without proof', () => {
  const keep = (over) => schema.newEvent({ target: 't', verdict: 'KEEP', ...over });
  // failed verification
  assert.throws(
    () => schema.validateKeepGate(keep({ verification: { commands: [{ pass: false }], result: 'fail' } })),
    /verification failed/
  );
  // no evidence at all
  assert.throws(
    () => schema.validateKeepGate(keep({ verification: { commands: [], manualChecks: [], result: 'manual' } })),
    /no verification evidence/
  );
  // claims pass but carries no evidence
  assert.throws(
    () => schema.validateKeepGate(keep({ verification: { commands: [], manualChecks: [], result: 'pass' } })),
    /no verification evidence/
  );
});

ok('proof gate: a red command refuses the KEEP whatever the summary claims', () => {
  const keep = (over) => schema.newEvent({ target: 't', verdict: 'KEEP', ...over });
  // The laundering path: relabel the summary field and a failed command rides
  // through. The derived result wins over the claimed one.
  assert.throws(
    () => schema.validateKeepGate(keep({ verification: { commands: [{ pass: false }], result: 'pass' } })),
    /did not pass/
  );
  // one green + one red is still red
  assert.throws(
    () => schema.validateKeepGate(keep({ verification: { commands: [{ command: 'a', pass: true }, { command: 'b', pass: false }], result: 'pass' } })),
    /did not pass/
  );
  // a command entry with no machine verdict is not proof
  assert.throws(
    () => schema.validateKeepGate(keep({ verification: { commands: ['npm test'], result: 'pass' } })),
    /no machine verdict/
  );
  // green commands but a summary that says otherwise: the contradiction is refused
  assert.throws(
    () => schema.validateKeepGate(keep({ verification: { commands: [{ pass: true }], result: 'manual' } })),
    /contradicts/
  );
});

ok('seam gate: omitted independence is refused, not defaulted through', () => {
  const keepCode = (over) =>
    schema.newEvent({
      target: 'src/router.js',
      mode: 'code',
      verdict: 'KEEP',
      verification: { commands: [{ pass: true }], result: 'pass' },
      ...over,
    });
  // null / omitted is the common shape — it must refuse exactly like false.
  assert.throws(() => schema.validateKeepGate(keepCode({ seam: { seamMatch: 'exact' } })), /independent/i);
  assert.throws(
    () => schema.validateKeepGate(keepCode({ seam: { seamMatch: 'exact', independentFromBuilderMethod: null } })),
    /independent/i
  );
  // a named waiver still overrides
  schema.validateKeepGate(keepCode({ seam: { seamMatch: 'exact', waiver: { by: 'danny', reason: 'hotfix' } } }));
});

ok('seam gate: production KEEP needs an exact ship-seam match', () => {
  const keepCode = (over) =>
    schema.newEvent({
      target: 'src/router.js',
      mode: 'code',
      verdict: 'KEEP',
      verification: { commands: [{ pass: true }], result: 'pass' },
      ...over,
    });
  // The T2.3 case: a proxy eval that looked good but measured the wrong seam.
  assert.throws(() => schema.validateKeepGate(keepCode({ seam: { seamMatch: 'weak-proxy' } })), /seam/i);
  // No seam declared at all → cannot ship.
  assert.throws(() => schema.validateKeepGate(keepCode({})), /seam/i);
  // Exact ship-seam match, independent method → allowed.
  schema.validateKeepGate(keepCode({ seam: { seamMatch: 'exact', independentFromBuilderMethod: true } }));
});

ok('seam gate: verification that repeats the builder method is not independent', () => {
  const ev = schema.newEvent({
    target: 'src/router.js',
    mode: 'code',
    verdict: 'KEEP',
    verification: { commands: [{ pass: true }], result: 'pass' },
    seam: { seamMatch: 'exact', independentFromBuilderMethod: false },
  });
  assert.throws(() => schema.validateKeepGate(ev), /independent/i);
});

ok('seam gate: a named human waiver overrides a proxy seam', () => {
  const ev = schema.newEvent({
    target: 'src/router.js',
    mode: 'code',
    verdict: 'KEEP',
    verification: { commands: [{ pass: true }], result: 'pass' },
    seam: { seamMatch: 'mismatch', waiver: { by: 'danny', reason: 'hotfix; seam eval to follow' } },
  });
  schema.validateKeepGate(ev); // does not throw
});

ok('seam gate: docs/prompt KEEP stays exempt (manual evidence is enough)', () => {
  schema.validateKeepGate(
    schema.newEvent({
      target: 'README.md',
      mode: 'docs',
      verdict: 'KEEP',
      verification: { manualChecks: ['first-use path is unambiguous'], result: 'manual' },
    })
  );
});

ok('seam fields round-trip through newEvent', () => {
  const e = schema.newEvent({
    target: 'src/x.js',
    mode: 'code',
    verdict: 'ASK',
    seam: {
      evidenceType: 'live-call',
      method: 'recursive grep + live endpoint call',
      independentFromBuilderMethod: true,
      testedSeam: 'rerank_candidates',
      shipSeam: 'rerank_candidates',
      seamMatch: 'exact',
      proxyWarning: null,
    },
  });
  assert.strictEqual(e.seam.seamMatch, 'exact');
  assert.strictEqual(e.seam.testedSeam, 'rerank_candidates');
  assert.strictEqual(e.seam.evidenceType, 'live-call');
  assert.strictEqual(e.mode, 'code');
});

ok('proof gate: REVERT and ASK bypass the gate', () => {
  schema.validateKeepGate(schema.newEvent({ target: 't', verdict: 'REVERT', verification: { result: 'fail' } }));
  schema.validateKeepGate(schema.newEvent({ target: 't', verdict: 'ASK' }));
});

ok('proof gate: appendEvent refuses to persist an unproven KEEP', () => {
  assert.throws(() => journal.appendEvent(process.cwd(), { target: 'b.md', verdict: 'KEEP' }), /cannot KEEP/);
  const s = journal.status(process.cwd());
  assert.ok(!s.targets.includes('b.md'), 'the rejected KEEP was never written');
});

ok('REVERTED_AND_LEARNED is a successful outcome that bypasses the KEEP gate', () => {
  // Reverting a mutation after verification (even a failing one) is valid and gate-exempt.
  schema.validateKeepGate(
    schema.newEvent({ target: 'src/router.js', mode: 'code', verdict: 'REVERTED_AND_LEARNED', verification: { result: 'fail' } })
  );
  journal.appendEvent(process.cwd(), {
    target: 'src/router.js',
    verdict: 'REVERTED_AND_LEARNED',
    nextEdge: 'ship the live-seam eval harness, not the flag',
  });
  const s = journal.status(process.cwd());
  assert.ok(s.revertedAndLearned >= 1, 'counted as a reverted-and-learned outcome');
  assert.strictEqual(s.last.verdict, 'REVERTED_AND_LEARNED');
});

ok('pressure suggests a vector and flags the rewrite trap', () => {
  const p = pressure.suggest('docs');
  assert.ok(p.primaryCandidates.includes('clarity'));
  assert.strictEqual(p.avoid, 'novelty');
});

fs.rmSync(tmp, { recursive: true, force: true });
process.stdout.write(`\n${passed} passed\n`);
