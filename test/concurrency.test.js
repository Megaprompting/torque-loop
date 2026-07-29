'use strict';

// v0.9 "Concurrency Gate" falsifier suite. Run: node test/concurrency.test.js
// RED BY DESIGN: every falsifier here states a law the CURRENT code breaks, so a
// failing run is the evidence, not a regression. Deliberately NOT wired into
// `npm test` until the implementation lands — the three shipped suites must stay
// green for every other session while these are red.
//
// Gate law: no lock → no write.
// Traced by: claude-opus-5

const os = require('os');
const path = require('path');
const fs = require('fs');
const assert = require('assert');

const tmp = path.join(os.tmpdir(), 'ratchet-concurrency-test-' + process.pid);
process.env.RATCHET_DATA_DIR = tmp;
// Isolate the evolve journal too, so nothing reads or writes the real repo's
// .ratchet/evolve-log.jsonl.
process.env.RATCHET_EVOLVE_LOG = path.join(tmp, 'evolve-log.jsonl');
fs.rmSync(tmp, { recursive: true, force: true });

const state = require('../src/state');

let passed = 0;
const failures = [];
// The shipped suites let an assertion throw and abort the run. A red-first suite
// cannot: F-A failing must not hide what F-B..F-G report. So record and continue,
// then exit non-zero on any red.
function ok(name, fn) {
  try {
    fn();
    passed++;
    process.stdout.write(`  ok    ${name}\n`);
  } catch (e) {
    failures.push({ name, message: e && e.message ? e.message : String(e) });
    process.stdout.write(`  FAIL  ${name}\n        ${e && e.message ? e.message : e}\n`);
  }
}

// Each falsifier gets its own project dir so a lost update in one cannot be
// mistaken for state left behind by another.
function freshProject(label) {
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), `ratchet-${label}-`));
  state.initProject(proj, { force: true });
  return proj;
}

// --- F-A: stale snapshot refusal --------------------------------------------

ok('F-A two snapshots at rev R: the second commit is refused as stale', () => {
  const proj = freshProject('f-a');

  // Two sessions read the same revision. Neither knows about the other.
  const snapshotA = state.loadState(proj);
  const snapshotB = state.loadState(proj);
  const R = snapshotA.rev;
  assert.strictEqual(snapshotB.rev, R, 'both snapshots start at the same revision');

  // A commits first against R. This must succeed — the gate refuses staleness,
  // not concurrency.
  snapshotA.objective = 'A: land the concurrency gate';
  state.saveState(proj, snapshotA);
  const afterA = state.loadState(proj);
  assert.strictEqual(afterA.objective, 'A: land the concurrency gate', 'A commits against a current revision');
  assert.strictEqual(afterA.rev, R + 1, 'A advanced the revision');

  // B now commits against R, which is no longer current. The contract the
  // implementation will satisfy is a core transaction boundary shaped like
  // withWorkspaceMutation(cwd, { expectedStateRev, action }, mutate) — until it
  // exists, the only write path is saveState, which takes no expected revision
  // and therefore cannot refuse anything.
  snapshotB.objective = 'B: clobber A';
  let refusal = null;
  try {
    if (typeof state.withWorkspaceMutation === 'function') {
      state.withWorkspaceMutation(proj, { expectedStateRev: R, action: 'state.set' }, (s) => {
        s.objective = 'B: clobber A';
      });
    } else {
      state.saveState(proj, snapshotB);
    }
  } catch (e) {
    refusal = e;
  }

  const afterB = state.loadState(proj);
  const observed = `on disk: objective=${JSON.stringify(afterB.objective)}, rev=${afterB.rev} (expected A's write at rev ${R + 1})`;

  assert.ok(refusal, `stale write from rev ${R} must be refused — it was accepted; ${observed}`);
  assert.match(String(refusal.message), /stale|expected rev/i, `refusal must name staleness; got: ${refusal.message}`);
  assert.strictEqual(afterB.objective, 'A: land the concurrency gate', `A's committed change must survive the refused write — ${observed}`);
  assert.strictEqual(afterB.rev, R + 1, `a refused write must not advance rev — ${observed}`);
});

// --- F-B..F-G land here ------------------------------------------------------

fs.rmSync(tmp, { recursive: true, force: true });
process.stdout.write(`\n${passed} passed, ${failures.length} failed\n`);
if (failures.length) {
  process.stdout.write(`RED (expected until the concurrency gate ships): ${failures.map((f) => f.name).join(', ')}\n`);
  process.exitCode = 1;
}
