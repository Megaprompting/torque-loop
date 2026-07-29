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
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

const tmp = path.join(os.tmpdir(), 'ratchet-concurrency-test-' + process.pid);
process.env.RATCHET_DATA_DIR = tmp;
// Isolate the evolve journal too, so nothing reads or writes the real repo's
// .ratchet/evolve-log.jsonl.
process.env.RATCHET_EVOLVE_LOG = path.join(tmp, 'evolve-log.jsonl');
fs.rmSync(tmp, { recursive: true, force: true });

const state = require('../src/state');
const schemas = require('../src/schemas');

const SRC = path.join(__dirname, '..', 'src');
const BIN = path.join(__dirname, '..', 'bin', 'ratchet');

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
const projects = [];
function freshProject(label) {
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), `ratchet-${label}-`));
  state.initProject(proj, { force: true });
  projects.push(proj);
  return proj;
}

// The canonical record, raw. A refused or crashed write is only proven harmless
// by the bytes — a matching `rev` says nothing about a churned timestamp.
function stateBytes(proj) {
  return fs.readFileSync(state.statePath(proj));
}

// Digests, so a purity failure quotes the same evidence a hand-check produces.
function sha(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex').slice(0, 12);
}

// The single public mutation the gate will expose: acquire the lock, reload the
// state UNDER it, compare expectedStateRev, run the whole command against one
// transaction context, commit exactly ONE rev, release. Until that seam exists
// the only write path is saveState, which takes no expected revision and so can
// refuse nothing.
//
// The fix is NOT expectedStateRev threaded through every saveState call: a
// command that saves twice internally would bump two revs, go stale against
// itself between them, and deadlock re-entering its own lock. So every falsifier
// below asserts ONE REV PER PUBLIC MUTATION, never one rev per save.
function attemptStaleCommit(proj, snapshot, expectedStateRev, mutate) {
  try {
    if (typeof state.withWorkspaceMutation === 'function') {
      state.withWorkspaceMutation(proj, { expectedStateRev, action: 'state.set' }, mutate);
    } else {
      mutate(snapshot);
      state.saveState(proj, snapshot);
    }
    return null;
  } catch (e) {
    return e;
  }
}

// Node has no synchronous sleep, and a falsifier body runs to completion inside
// `ok` — so block the thread the one portable way: a timed wait on a
// SharedArrayBuffer nobody ever notifies.
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Children never inherit their isolation by luck: the temp store and the temp
// journal are stated explicitly. RATCHET_AGENT is CLEARED because a propose-only
// agent leaves no footprint by design — a falsifier about racing writes must not
// be silently disarmed by whichever seat happens to run the suite.
function childEnv(proj, extra) {
  return {
    ...process.env,
    RATCHET_DATA_DIR: tmp,
    RATCHET_EVOLVE_LOG: path.join(proj, 'evolve-log.jsonl'),
    RATCHET_AGENT: '',
    ...(extra || {}),
  };
}

// Children are real OS processes launched through process.execPath (never the
// string 'node' — the race must be run on the interpreter that runs the suite),
// so these are the operating system's interleavings, not a simulation. Each
// child's LAST act is writing <label>.done; that file, not an 'exit' event, is
// how the blocked parent learns it finished.
function childScript(body) {
  return `'use strict';
const fs = require('fs');
const path = require('path');
const SRC = ${JSON.stringify(SRC)};
const label = process.argv[2];
const sync = process.argv[3];
const result = { label: label, error: null };
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
// Hold every child at one instant so each is still carrying a pre-save snapshot
// when the others save. Sentinel files are the only cross-process barrier a
// zero-dependency suite gets.
function barrier(n) {
  fs.writeFileSync(path.join(sync, label + '.at'), '1', 'utf8');
  const deadline = Date.now() + 10000;
  const arrived = () => fs.readdirSync(sync).filter((f) => f.endsWith('.at')).length;
  while (arrived() < n && Date.now() < deadline) sleepSync(5);
}
try {
${body}
} catch (e) {
  result.error = e && e.message ? e.message : String(e);
}
fs.writeFileSync(path.join(sync, label + '.done'), JSON.stringify(result), 'utf8');
`;
}

function readIfAny(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (_e) {
    return '';
  }
}

// Spawn one child per label against `proj`, then wait by POLLING the done files:
// the parent blocks its own event loop, so an 'exit' listener would never fire.
// stderr goes to a file for the same reason — an unread pipe would fill and hang.
function runChildren(proj, body, labels, extra) {
  const sync = path.join(proj, 'sync');
  fs.mkdirSync(sync, { recursive: true });
  const script = path.join(proj, 'child.js');
  fs.writeFileSync(script, childScript(body), 'utf8');
  for (const label of labels) {
    const outFile = fs.openSync(path.join(sync, `${label}.out`), 'a');
    const errFile = fs.openSync(path.join(sync, `${label}.err`), 'a');
    spawn(process.execPath, [script, label, sync], {
      cwd: proj,
      env: childEnv(proj, extra),
      stdio: ['ignore', outFile, errFile],
    });
  }
  const outstanding = () => labels.filter((l) => !fs.existsSync(path.join(sync, `${l}.done`)));
  const deadline = Date.now() + 30000;
  while (outstanding().length && Date.now() < deadline) sleepSync(20);
  const stuck = outstanding();
  if (stuck.length) {
    const detail = stuck.map((l) => `${l}: ${readIfAny(path.join(sync, `${l}.err`)).trim() || 'no stderr'}`).join(' | ');
    assert.fail(`child processes never finished — ${detail}`);
  }
  return labels.map((l) => ({
    ...JSON.parse(fs.readFileSync(path.join(sync, `${l}.done`), 'utf8')),
    // What the child PRINTED matters as much as what it wrote: a lost update can
    // hide in state.json while both processes still report having done the work.
    stdout: readIfAny(path.join(sync, `${l}.out`)),
  }));
}

function duplicates(list) {
  return list.filter((v, i) => list.indexOf(v) !== i);
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

  // Pin A's exact footprint. "Refused" means zero bytes moved, not merely that
  // the revision number happens to match.
  const bytesAfterA = stateBytes(proj);
  const historyAfterA = afterA.history.length;

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
  assert.strictEqual(afterB.history.length, historyAfterA, `a refused write must not append history — ${observed}`);
  assert.ok(stateBytes(proj).equals(bytesAfterA), `a refused write must not change one byte of state.json — ${observed}`);
});

// The rev-0 case above can be passed by an implementation that only knows how to
// guard a fresh store. This one starts at rev 7, so the check has to be a real
// comparison against the revision on disk.
ok('F-A stale refusal holds at a nonzero revision (rev 7 → 8, B refused)', () => {
  const proj = freshProject('f-a-rev7');

  // Drive the store to rev 7 through the real write path, not by hand-editing a
  // number into the file: the falsifier is about the mechanism, not the field.
  for (let i = 0; i < 7; i++) {
    const s = state.loadState(proj);
    s.tags.push(`warmup-${i}`);
    state.saveState(proj, s);
  }
  const R = state.loadState(proj).rev;
  assert.strictEqual(R, 7, `warmup must land the store at rev 7; got ${R}`);

  const snapshotA = state.loadState(proj);
  const snapshotB = state.loadState(proj);
  assert.strictEqual(snapshotB.rev, R, 'both snapshots read rev 7');

  snapshotA.objective = 'A: hold rev 8';
  state.saveState(proj, snapshotA);
  const afterA = state.loadState(proj);
  assert.strictEqual(afterA.rev, 8, 'A advanced 7 → 8');
  const bytesAfterA = stateBytes(proj);
  const historyAfterA = afterA.history.length;

  const refusal = attemptStaleCommit(proj, snapshotB, R, (s) => {
    s.objective = 'B: clobber A from rev 7';
  });

  const afterB = state.loadState(proj);
  const observed = `on disk: objective=${JSON.stringify(afterB.objective)}, rev=${afterB.rev} (expected A's write at rev 8)`;

  assert.ok(refusal, `stale write from rev ${R} must be refused — it was accepted; ${observed}`);
  assert.match(String(refusal.message), /stale|expected rev/i, `refusal must name staleness; got: ${refusal.message}`);
  assert.strictEqual(afterB.objective, 'A: hold rev 8', `A's committed change must survive the refusal — ${observed}`);
  assert.strictEqual(afterB.rev, 8, `a refused write must not advance rev — ${observed}`);
  assert.strictEqual(afterB.history.length, historyAfterA, `a refused write must not append history — ${observed}`);
  assert.ok(stateBytes(proj).equals(bytesAfterA), `a refused write must not change one byte of state.json — ${observed}`);
});

// --- F-B: real two-process lost update ---------------------------------------

ok('F-B two processes saving from the same snapshot lose neither mutation', () => {
  const proj = freshProject('f-b');
  const startRev = state.loadState(proj).rev;

  // Both children load, meet at the barrier holding their pre-save snapshots,
  // then save through the real state path. Nothing here is stubbed: this is the
  // shape of two agents in one repo.
  const results = runChildren(
    proj,
    `  const state = require(path.join(SRC, 'state.js'));
  const cwd = process.cwd();
  const s = state.loadState(cwd);
  result.loadedRev = s.rev;
  barrier(2);
  s.touchedFiles.push({ path: 'from-' + label, at: new Date().toISOString() });
  state.saveState(cwd, s);
  result.savedRev = s.rev;`,
    ['a', 'b']
  );
  for (const r of results) assert.strictEqual(r.error, null, `child ${r.label} failed: ${r.error}`);

  const final = state.loadState(proj);
  const touched = (final.touchedFiles || []).map((t) => t.path);
  const observed = `touchedFiles=${JSON.stringify(touched)}, rev ${startRev} → ${final.rev}, children loaded rev ${results
    .map((r) => r.loadedRev)
    .join('/')}`;

  assert.ok(touched.includes('from-a'), `A's mutation must survive B — ${observed}`);
  assert.ok(touched.includes('from-b'), `B's mutation must survive A — ${observed}`);
  // Two public mutations → two revisions, in order. One increment means one of
  // the two writes was overwritten wholesale.
  assert.strictEqual(final.rev, startRev + 2, `two committed mutations must be two ordered revisions — ${observed}`);
});

// --- F-C: confidence read purity ---------------------------------------------

// Both confidence branches are scored by ONE method, deliberately: if the two
// falsifiers measured purity differently, a difference in their verdicts would
// be evidence about the harness rather than about the code.
function assertConfidenceReadIsPure(label, argv) {
  const proj = freshProject(label);
  // Give the read something to score, so purity is not proven on an empty file.
  const seed = state.loadState(proj);
  seed.objective = 'C: read must not write';
  seed.artifacts.push({ id: 'art-c', at: schemas.nowIso(), kind: 'code', title: 'c', path: '', status: 'v0', holes: [] });
  state.saveState(proj, seed);

  const before = stateBytes(proj);
  const res = spawnSync(process.execPath, [BIN, ...argv], {
    cwd: proj,
    env: childEnv(proj),
    encoding: 'utf8',
  });
  // A read that crashed is not a pure read — pin the exit code before the bytes.
  assert.strictEqual(res.status, 0, `the real CLI read must succeed; exit ${res.status}, stderr: ${String(res.stderr).trim()}`);

  const after = stateBytes(proj);
  assert.ok(
    after.equals(before),
    `a read must not write: state.json changed across \`ratchet ${argv.join(' ')}\` — ` +
      `sha256 ${sha(before)} → ${sha(after)}; ${before.length} → ${after.length} bytes; ` +
      `rev ${JSON.parse(before).rev} → ${JSON.parse(after).rev}, ` +
      `updatedAt ${JSON.parse(before).updatedAt} → ${JSON.parse(after).updatedAt}, ` +
      `confidence ${JSON.stringify(JSON.parse(before).confidence)} → ${JSON.stringify(JSON.parse(after).confidence)}`
  );
}

ok('F-C score confidence --json changes zero bytes of canonical state', () => {
  assertConfidenceReadIsPure('f-c', ['score', 'confidence', '--json']);
});

// The default (markdown) branch caches the session score back into state, so the
// read moves bytes. v0.9 removes that cache: EVERY branch of score confidence is
// a pure derived read, and the only deliberate mutation in the score family is
// the fog-recording branch of `score aperture` (F-D's territory).
ok('F-C2 score confidence (markdown, no --json) changes zero bytes of canonical state', () => {
  assertConfidenceReadIsPure('f-c2', ['score', 'confidence']);
});

// --- F-D: the aperture write carve-out ---------------------------------------

ok('F-D two concurrent aperture scores record one fog loop and one revision', () => {
  const proj = freshProject('f-d');
  const startRev = state.loadState(proj).rev;

  // `{"taste":2}` trips mapRequired below the A3 band, so both children run the
  // real fog-recording branch of `score aperture` — the one score that writes.
  //
  // The barrier sits INSIDE the read-modify-write window: each child's first
  // loadState returns, then it waits for the other to also be holding a
  // pre-write snapshot. Nothing about the mechanism is stubbed — only the
  // scheduling is pinned, so an interleaving that is always possible becomes
  // observable instead of decided by microseconds of module-load time.
  const results = runChildren(
    proj,
    `  const state = require(path.join(SRC, 'state.js'));
  const realLoad = state.loadState;
  let armed = true;
  state.loadState = function (cwd) {
    const s = realLoad.call(state, cwd);
    if (armed) {
      armed = false;
      barrier(2);
    }
    return s;
  };
  const cli = require(path.join(SRC, 'cli.js'));
  cli.run(['node', 'ratchet', 'score', 'aperture', '{"taste":2}', '--json']);`,
    ['a', 'b']
  );
  for (const r of results) assert.strictEqual(r.error, null, `child ${r.label} failed: ${r.error}`);

  const final = state.loadState(proj);
  const liveFog = (final.openLoops || []).filter(
    (l) => l.status !== 'closed' && String(l.text || '').startsWith(schemas.FOG_LOOP_PREFIX)
  );
  const fogHistory = (final.history || []).filter((h) => h.event === 'fog.recorded');
  // The counter alone cannot see this race: both children compute rev from their
  // OWN snapshot (state.js saveState), so two writes at rev 0 both land as rev 1
  // and the second silently replaces the first. Count the processes that each
  // believed they recorded the fog — under a lock the loser reloads, sees the
  // open loop, and records nothing.
  const recorders = results.filter((r) => {
    try {
      return JSON.parse(r.stdout).recordedFog === true;
    } catch (_e) {
      return false;
    }
  });
  const observed =
    `${recorders.length} of ${results.length} processes recorded the fog; ` +
    `${liveFog.length} live fog loop(s), ${fogHistory.length} fog.recorded entr(ies), rev ${startRev} → ${final.rev}`;

  assert.strictEqual(recorders.length, 1, `one fog is recorded once, by one process — ${observed}`);
  assert.strictEqual(liveFog.length, 1, `one fog is one open loop — ${observed}`);
  assert.strictEqual(fogHistory.length, 1, `one fog is one history entry — ${observed}`);
  assert.strictEqual(final.rev, startRev + 1, `one recorded fog is ONE public mutation → one revision — ${observed}`);
});

// --- F-E: cross-process identifier collision ---------------------------------

ok('F-E ids stay unique when three processes share one clock', () => {
  const proj = freshProject('f-e');
  const FIXED = 1767225600000; // fixed epoch ms: same wall clock in every child

  // The id scheme is time36 + a PROCESS-LOCAL counter, so freezing the clock is
  // all it takes for separate processes to hand out the same ids. The override
  // goes in before the require because makeId reads Date.now on every call.
  const results = runChildren(
    proj,
    `  Date.now = () => ${FIXED};
  const state = require(path.join(SRC, 'state.js'));
  result.ids = [];
  for (let i = 0; i < 5; i++) result.ids.push(state.makeId('loop'));`,
    ['a', 'b', 'c']
  );
  for (const r of results) assert.strictEqual(r.error, null, `child ${r.label} failed: ${r.error}`);

  const all = results.reduce((acc, r) => acc.concat(r.ids || []), []);
  assert.strictEqual(all.length, 15, `every child must produce 5 ids; got ${all.length}`);
  const dupes = duplicates(all);
  assert.strictEqual(
    dupes.length,
    0,
    `ids must be unique across processes — ${dupes.length} collisions, e.g. ${[...new Set(dupes)].slice(0, 3).join(', ')}`
  );
});

// --- F-F: evolution journal append race --------------------------------------

ok('F-F concurrent journal appends keep every event, one per line, ids unique', () => {
  const proj = freshProject('f-f');
  const labels = ['a', 'b', 'c'];
  const perChild = 3;
  const expected = labels.length * perChild;

  // Known defect shape: nextId derives identity from count-of-today's-events + 1,
  // which every racing process computes from the same pre-append count.
  const results = runChildren(
    proj,
    `  const journal = require(path.join(SRC, 'evolve', 'journal.js'));
  const cwd = process.cwd();
  barrier(3);
  result.ids = [];
  for (let i = 0; i < ${perChild}; i++) {
    const e = journal.appendEvent(cwd, {
      target: 'f-f',
      goal: 'race the journal',
      verdict: 'ASK',
      chosenMutation: label + '-' + i,
    });
    result.ids.push(e.id);
  }`,
    labels
  );
  for (const r of results) assert.strictEqual(r.error, null, `child ${r.label} failed: ${r.error}`);

  const raw = fs.readFileSync(path.join(proj, 'evolve-log.jsonl'), 'utf8');
  const lines = raw.split('\n').filter((l) => l.length);
  const parsed = [];
  const malformed = [];
  lines.forEach((l, i) => {
    try {
      parsed.push(JSON.parse(l));
    } catch (_e) {
      malformed.push(`line ${i + 1}: ${l.slice(0, 60)}`);
    }
  });

  assert.strictEqual(malformed.length, 0, `every line must hold exactly one valid JSON event — ${malformed.join(' | ')}`);
  assert.ok(raw.endsWith('\n'), 'the journal must end on a line boundary, never a half-written event');
  assert.strictEqual(lines.length, expected, `${expected} appends must be ${expected} lines; got ${lines.length}`);

  const ids = parsed.map((e) => e.id);
  const dupes = duplicates(ids);
  assert.strictEqual(
    dupes.length,
    0,
    `event identity must be unique — ${dupes.length} duplicate id(s): ${[...new Set(dupes)].join(', ')}`
  );
  const mutations = new Set(parsed.map((e) => e.chosenMutation));
  assert.strictEqual(mutations.size, expected, `no event may be overwritten — kept ${mutations.size} of ${expected} distinct events`);
});

// --- F-G: interrupted canonical write ----------------------------------------

ok('F-G a write that dies mid-file leaves the old canonical bytes intact', () => {
  const proj = freshProject('f-g');
  const seed = state.loadState(proj);
  seed.objective = 'G: the record that must survive a crash';
  state.saveState(proj, seed);
  const before = stateBytes(proj);

  // Inject the crash class a canonical write has no answer for — power loss,
  // ENOSPC, SIGKILL between the truncate and the last byte — by writing half the
  // JSON and throwing. In a child, so the patched fs never touches this process.
  //
  // The trigger is the PAYLOAD, not the destination. It was written as
  // `file === statePath`, which only fires against an implementation that writes
  // the record in place — the very design this falsifier exists to kill. Under
  // temp-file + atomic rename nothing ever writes that path with a string, the
  // injection would silently never fire, and the suite would go green on a
  // no-op. Keyed on the bytes it fires on BOTH designs, so a future in-place
  // regression still trips it. (Changed with the 0.9 implementation; the law and
  // every assertion below are untouched.)
  const [res] = runChildren(
    proj,
    `  const state = require(path.join(SRC, 'state.js'));
  const cwd = process.cwd();
  const s = state.loadState(cwd);
  s.objective = 'G: interrupted';
  const realWrite = fs.writeFileSync;
  fs.writeFileSync = function (file, data, ...rest) {
    if (typeof data === 'string' && data.includes('G: interrupted')) {
      realWrite.call(fs, file, data.slice(0, Math.floor(data.length / 2)), ...rest);
      throw new Error('simulated crash mid-write (ENOSPC)');
    }
    return realWrite.call(fs, file, data, ...rest);
  };
  try {
    state.saveState(cwd, s);
  } finally {
    fs.writeFileSync = realWrite;
  }`,
    ['g']
  );
  assert.match(String(res.error), /simulated crash mid-write/, `the injection must fire; child reported: ${res.error}`);

  const after = stateBytes(proj);
  let parseError = null;
  try {
    JSON.parse(after.toString('utf8'));
  } catch (e) {
    parseError = e.message;
  }
  assert.strictEqual(parseError, null, `canonical state.json must stay parseable after a failed write — ${parseError}`);
  assert.ok(
    after.equals(before),
    `a write that never completed must not replace the record — ${before.length} → ${after.length} bytes`
  );

  // The recovery contract's other half: whatever residue a failed write leaves is
  // NAMED as residue. Nothing extra beside the record is the honest version too.
  const residue = fs
    .readdirSync(state.projectDir(proj))
    .filter((f) => f !== 'state.json' && f !== 'ledger.json' && !/\.(tmp|partial|new|corrupt)\b/.test(f));
  assert.strictEqual(residue.join(', '), '', `residue beside the record must name itself temporary — found ${residue.join(', ')}`);
});

// ===========================================================================
// Patch cycle — the Codex review of the first implementation. Each falsifier
// below states a law that implementation broke, and was written RED against it.
// Traced by: claude-opus-5
// ===========================================================================

const artifacts = require('../src/artifacts');
const journal = require('../src/evolve/journal');
const cli = require('../src/cli');

// The lock the journal actually uses, resolved the same way the implementation
// resolves it — a test that guesses the path proves nothing about the lock.
function journalLockDir(proj) {
  const log = journal.logPath(proj);
  try {
    return path.join(fs.realpathSync(path.dirname(log)), `${path.basename(log)}.lock`);
  } catch (_e) {
    return `${log}.lock`;
  }
}

function workspaceLockDir(proj) {
  return path.join(state.projectDir(proj), '.lock');
}

// An owner card exactly like the one acquireLock writes, so a planted lock is
// indistinguishable from a real holding.
function plantLock(lockDir, { pid, host, ageMs, action = 'planted', token = 'plantedtoken' }) {
  fs.mkdirSync(lockDir, { recursive: true });
  fs.writeFileSync(
    path.join(lockDir, 'owner.json'),
    JSON.stringify({
      token,
      pid: pid == null ? process.pid : pid,
      host: host == null ? os.hostname() : host,
      at: new Date(Date.now() - (ageMs || 0)).toISOString(),
      action,
    }),
    'utf8'
  );
  return lockDir;
}

function readToken(lockDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(lockDir, 'owner.json'), 'utf8')).token;
  } catch (_e) {
    return '';
  }
}

// A pid that is certainly not running: claim one, let it exit, reuse the number.
function deadPid() {
  const done = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
  return done.pid;
}

// --- C1: the close reads its proof under the journal lock --------------------

ok('C1 artifact close reads the journal under the journal lock, inside the workspace lock', () => {
  const proj = freshProject('c1');
  const art = artifacts.addArtifact(proj, { title: 'c1', kind: 'code', path: 'x.js', holes: [] });

  // The proof this gate reads lives in the journal. Reading it unlocked leaves a
  // window in which a REVERT lands after the read and before the commit, and the
  // artifact closes on a KEEP the record had already revoked.
  // Both readers are probed: the gate reads its proof through the health-reporting
  // one (a damaged log must not certify), and a future refactor back to the plain
  // reader must not slip past this falsifier.
  const realRead = journal.readEvents;
  const realHealth = journal.readEventsWithHealth;
  const observed = [];
  const note = () =>
    observed.push({
      journalLocked: fs.existsSync(journalLockDir(proj)),
      workspaceLocked: fs.existsSync(workspaceLockDir(proj)),
    });
  journal.readEvents = function (cwd) {
    note();
    return realRead.call(journal, cwd);
  };
  journal.readEventsWithHealth = function (cwd) {
    note();
    return realHealth.call(journal, cwd);
  };
  const prevCwd = process.cwd();
  try {
    process.chdir(proj);
    // It will refuse to close (no bound proof) — the refusal is not the point.
    // The point is where the journal read happened.
    try {
      cli.run(['node', 'ratchet', 'artifact', 'close', art.id]);
    } catch (_e) {
      /* blockers — expected */
    }
  } finally {
    process.chdir(prevCwd);
    journal.readEvents = realRead;
    journal.readEventsWithHealth = realHealth;
  }

  assert.ok(observed.length, 'the close must actually read the journal');
  const unlocked = observed.filter((o) => !o.journalLocked);
  assert.strictEqual(
    unlocked.length,
    0,
    `every proof read inside artifact close must hold the journal lock — ${unlocked.length} of ${observed.length} did not`
  );
  assert.ok(
    observed.every((o) => o.workspaceLocked),
    'and it must hold the workspace lock too — the order is workspace → journal, never the reverse'
  );
});

ok('C1 the lock order is enforced, not merely documented', () => {
  const proj = freshProject('c1-order');
  // Taking the workspace lock while holding a file lock is the ABBA wedge. It
  // must fail by name, not resolve into two mysterious timeouts.
  assert.throws(
    () =>
      state.withFileLock(journal.logPath(proj), 'test', () => {
        state.withWorkspaceLock(proj, 'inverted', () => {});
      }),
    /lock order/i,
    'workspace-inside-file must be refused by name'
  );
  // The permitted direction still works.
  let ran = false;
  state.withWorkspaceLock(proj, 'outer', () => {
    state.withFileLock(journal.logPath(proj), 'inner', () => {
      ran = true;
    });
  });
  assert.ok(ran, 'workspace → file is the allowed order and must still run');
});

// --- C2: a first read never publishes over a committed record ----------------

ok('C2 creating the store on first read takes the lock instead of racing it', () => {
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'ratchet-c2-'));
  projects.push(proj);
  // Deliberately NOT initialized: this is the empty-store case.
  assert.ok(!fs.existsSync(state.statePath(proj)), 'the store must start absent');

  // Hold the workspace lock, then ask a child to read the empty store. An
  // unlocked auto-init publishes its fresh rev-0 record immediately — and that
  // record can land on top of a revision the lock holder is about to commit, a
  // read erasing a write. Under the fix the child has to wait for the lock, so a
  // short timeout turns the race into a visible refusal.
  const [res] = (() => {
    let out;
    state.withWorkspaceLock(proj, 'c2 holder', () => {
      out = runChildren(
        proj,
        `  const state = require(path.join(SRC, 'state.js'));
  const s = state.loadState(process.cwd());
  result.rev = s.rev;`,
        ['reader'],
        { RATCHET_LOCK_TIMEOUT_MS: '1200', RATCHET_LOCK_STALE_MS: '600000' }
      );
      // Commit a real revision while the reader is queued behind the lock.
      const s = state.loadState(proj);
      s.objective = 'C2: the record the reader must not erase';
      state.saveState(proj, s);
    });
    return out;
  })();

  assert.ok(
    /could not acquire/i.test(String(res.error)),
    `the reader must queue behind the lock, not write through it — child reported: ${res.error}`
  );
  const after = state.loadState(proj);
  assert.strictEqual(
    after.objective,
    'C2: the record the reader must not erase',
    'the lock holder\'s committed record must survive the concurrent first read'
  );
});

ok('C2 a first-time creation refuses to replace a record that appeared meanwhile', () => {
  const proj = freshProject('c2-exclusive');
  const before = stateBytes(proj);
  // The primitive underneath: publishing a fresh record is create-or-fail, so
  // even a caller that reached the create with a stale "it is absent" belief
  // cannot overwrite the record that exists now.
  const created = state.createJsonExclusive(state.statePath(proj), schemas.newState());
  assert.strictEqual(created, false, 'creating over an existing record must refuse');
  assert.ok(stateBytes(proj).equals(before), 'and must not move one byte of it');
});

// --- C3: liveness beats age, and release is ownership-verified ---------------

ok('C3 a lock whose owner is alive on this host is never broken, at any age', () => {
  const proj = freshProject('c3-live');
  // Ten minutes old — far past hard-stale — but the owner is THIS process, which
  // is provably running. Breaking it would not unwedge the holder; it would add
  // a second writer to the record the holder still has open.
  const lockDir = plantLock(workspaceLockDir(proj), { ageMs: 600000, token: 'liveowner', action: 'wedged but alive' });
  let refusal = null;
  try {
    state.withWorkspaceLock(proj, 'contender', () => {});
  } catch (e) {
    refusal = e;
  }
  assert.ok(refusal, 'a live owner must produce a refusal, not a stolen lock');
  assert.strictEqual(refusal.code, 'ERATCHETLOCK', `the refusal must name the lock; got: ${refusal.message}`);
  assert.match(refusal.message, /wedged but alive/, 'and must name the holder it is waiting on');
  assert.strictEqual(readToken(lockDir), 'liveowner', 'the live holding must still be there, untouched');
  fs.rmSync(lockDir, { recursive: true, force: true });
});

ok('C3 a dead owner past soft-stale still loses the lock', () => {
  const proj = freshProject('c3-dead');
  // The other half of the same rule: liveness is what protects a lock, so an
  // owner that is provably gone must not protect one.
  plantLock(workspaceLockDir(proj), { pid: deadPid(), ageMs: 30000, token: 'deadowner' });
  let ran = false;
  state.withWorkspaceLock(proj, 'contender', () => {
    ran = true;
  });
  assert.ok(ran, 'a provably dead owner past soft-stale must be recovered from');
});

ok('C3 release removes OUR holding or nothing at all', () => {
  const proj = freshProject('c3-release');
  const lockDir = workspaceLockDir(proj);
  // Our holding is broken as stale and a successor takes the slot. On the way
  // out we must not delete the successor's live lock — that is two writers with
  // no lock between them, and neither of them ever finds out.
  state.withWorkspaceLock(proj, 'overrunner', () => {
    fs.writeFileSync(
      path.join(lockDir, 'owner.json'),
      JSON.stringify({ token: 'successor', pid: process.pid, host: os.hostname(), at: new Date().toISOString(), action: 'successor' }),
      'utf8'
    );
  });
  assert.ok(fs.existsSync(lockDir), "the successor's lock must survive our release");
  assert.strictEqual(readToken(lockDir), 'successor', 'and must still be the successor holding, untouched');
  fs.rmSync(lockDir, { recursive: true, force: true });
});

// --- C4: ABA on the stale break ----------------------------------------------

ok('C4 a stale break that moves a different holding puts it back', () => {
  const proj = freshProject('c4');
  const lockDir = workspaceLockDir(proj);
  plantLock(lockDir, { pid: deadPid(), ageMs: 30000, token: 'judgedstale' });

  // The break decides on one owner and then renames whatever occupies .lock at
  // that instant. Swap in a NEW live holding in between — the exact ABA the
  // decision cannot see — and the break must notice it moved the wrong thing.
  const realRename = fs.renameSync;
  let swapped = false;
  fs.renameSync = function (from, to) {
    if (!swapped && String(from) === lockDir) {
      swapped = true;
      realRename.call(fs, from, `${lockDir}.decoy`);
      plantLock(lockDir, { ageMs: 0, token: 'newlive', action: 'fresh live holding' });
    }
    return realRename.call(fs, from, to);
  };
  let refusal = null;
  try {
    state.withWorkspaceLock(proj, 'breaker', () => {});
  } catch (e) {
    refusal = e;
  } finally {
    fs.renameSync = realRename;
  }

  assert.ok(swapped, 'the injection must fire — otherwise this proves nothing');
  assert.ok(fs.existsSync(lockDir), 'the new live holding must not be destroyed by a break aimed at its predecessor');
  assert.strictEqual(readToken(lockDir), 'newlive', 'and it must still be the new holding');
  assert.ok(refusal, 'the breaker must end up refused, not holding a stolen lock');
  fs.rmSync(lockDir, { recursive: true, force: true });
  fs.rmSync(`${lockDir}.decoy`, { recursive: true, force: true });
});

// --- H5: base snapshots survive losing object identity -----------------------

ok('H5 a snapshot that lost its object identity still rebases by revision', () => {
  const proj = freshProject('h5');
  const loaded = state.loadState(proj);
  // Anything that copies a snapshot — a JSON round trip, structuredClone, an IPC
  // hop — drops the identity the base map was keyed on. The revision it carries
  // is still the truth about what it was read from.
  const copy = JSON.parse(JSON.stringify(loaded));

  const other = state.loadState(proj);
  other.tags.push('landed-while-you-were-thinking');
  state.saveState(proj, other);

  copy.tags.push('mine');
  state.saveState(proj, copy);

  const final = state.loadState(proj);
  assert.ok(final.tags.includes('landed-while-you-were-thinking'), `the committed write must survive — tags: ${final.tags}`);
  assert.ok(final.tags.includes('mine'), `and so must the rebased one — tags: ${final.tags}`);
});

ok('H5 a snapshot at an unknown revision is refused, never written blind', () => {
  const proj = freshProject('h5-blind');
  const s = state.loadState(proj);
  s.objective = 'the record';
  state.saveState(proj, s);
  const before = stateBytes(proj);

  // A hand-built object claiming a revision nobody remembers reading. There is
  // no delta to rebase and no claim to honour: overwriting it blind is the v0.8
  // defect wearing a 0.9 lock.
  const forged = { ...JSON.parse(before.toString('utf8')), rev: 99, objective: 'blind overwrite' };
  let refusal = null;
  try {
    state.saveState(proj, forged);
  } catch (e) {
    refusal = e;
  }
  assert.ok(refusal, 'a blind overwrite must be refused');
  assert.strictEqual(refusal.code, 'ERATCHETSTALE', `refusal must be coded stale; got ${refusal.code}: ${refusal.message}`);
  assert.ok(stateBytes(proj).equals(before), 'and must move zero bytes');
});

// --- H6: a partial line does not eat its successor ---------------------------

ok('H6 an append after a half-written line keeps both lines separate', () => {
  const proj = freshProject('h6');
  const log = journal.logPath(proj);
  fs.mkdirSync(path.dirname(log), { recursive: true });
  // A previous append died mid-line. Without quarantine the next event is
  // concatenated onto the fragment and BOTH vanish behind one unreadable line.
  fs.writeFileSync(log, '{"id":"evo_partial","targ', 'utf8');

  const e = journal.appendEvent(proj, { target: 'h6', verdict: 'ASK', chosenMutation: 'after the fragment' });
  const lines = fs.readFileSync(log, 'utf8').split('\n').filter((l) => l.length);
  assert.strictEqual(lines.length, 2, `the fragment and the new event must be two lines; got ${lines.length}`);
  const parsed = lines.map((l) => {
    try {
      return JSON.parse(l);
    } catch (_e) {
      return null;
    }
  });
  assert.strictEqual(parsed[0], null, 'the fragment stays unreadable — it is damaged, not repairable');
  assert.ok(parsed[1] && parsed[1].id === e.id, 'the new event must survive intact as its own line');
  assert.deepStrictEqual(
    journal.readEvents(proj).map((x) => x.id),
    [e.id],
    'and must be the one event the reader returns'
  );
});

// --- H8: duplicate ids never hybridize ---------------------------------------

ok('H8 a rebase never merges two records that merely share an id', () => {
  const proj = freshProject('h8');
  const seed = state.loadState(proj);
  // A store that is already broken: one id, two records. Matching them by "the
  // Nth record carrying this id" is only stable while both sides agree on the
  // order — and nothing makes them agree. Once the committed order moves, the
  // Nth-occurrence match pairs UNRELATED rows and merging them field-by-field
  // builds a record that never existed: this record's title, that record's
  // status. That is not a lost update, it is a fabricated one.
  seed.artifacts = [
    { id: 'dup', at: schemas.nowIso(), kind: 'code', title: 'first', status: 'v0', holes: [] },
    { id: 'dup', at: schemas.nowIso(), kind: 'code', title: 'second', status: 'v0', holes: [] },
  ];
  state.saveState(proj, seed);

  const mine = state.loadState(proj);
  const theirs = state.loadState(proj);
  theirs.artifacts.reverse(); // the committed order moves under me
  theirs.artifacts[0].status = 'committed-by-them';
  state.saveState(proj, theirs);

  mine.artifacts[0].status = 'edited-by-me'; // I edited the one titled "first"
  mine.tags.push('mine-also-appended');
  state.saveState(proj, mine);

  const final = state.loadState(proj);
  const rows = final.artifacts.map((a) => `${a.title}:${a.status}`);
  assert.ok(
    !rows.includes('second:edited-by-me') && !rows.includes('first:committed-by-them'),
    `no record may wear another record's field — got ${JSON.stringify(rows)}`
  );
  assert.deepStrictEqual(
    rows,
    ['second:committed-by-them', 'first:v0'],
    `an ambiguous id falls back to committed order, whole records only — got ${JSON.stringify(rows)}`
  );
  assert.strictEqual(final.artifacts.length, 2, 'and must not duplicate the ambiguous records');
  assert.ok(final.tags.includes('mine-also-appended'), 'unambiguous work in the same save still rebases normally');
});

// --- H9: a release that cannot delete still frees the slot -------------------

ok('H9 a lock that cannot be deleted is moved aside, never left blocking', () => {
  const proj = freshProject('h9');
  // In a child, so the patched fs never touches this process. Deleting the lock
  // fails; if that is shrugged off, the .lock survives with a dead owner's pid
  // and every future writer waits out the full timeout.
  const [res] = runChildren(
    proj,
    `  const state = require(path.join(SRC, 'state.js'));
  const lockDir = path.join(state.projectDir(process.cwd()), '.lock');
  const realRm = fs.rmSync;
  fs.rmSync = function (target, ...rest) {
    if (String(target) === lockDir) throw Object.assign(new Error('EBUSY: simulated undeletable lock'), { code: 'EBUSY' });
    return realRm.call(fs, target, ...rest);
  };
  const s = state.loadState(process.cwd());
  s.objective = 'H9';
  state.saveState(process.cwd(), s);
  result.lockLeft = fs.existsSync(lockDir);`,
    ['h9']
  );
  assert.strictEqual(res.error, null, `child failed: ${res.error}`);
  assert.strictEqual(res.lockLeft, false, 'a lock that could not be deleted must be moved aside, not left in place');

  // The real proof: the next writer is not blocked.
  const started = Date.now();
  const s = state.loadState(proj);
  s.objective = 'H9 next writer';
  state.saveState(proj, s);
  assert.ok(Date.now() - started < 2000, `the next writer must not wait for a timeout — took ${Date.now() - started}ms`);
  assert.strictEqual(state.loadState(proj).objective, 'H9 next writer', 'and must actually commit');
});

// --- H10: a refusal creates nothing ------------------------------------------

ok('H10 a CAS refusal on an absent store leaves the store absent', () => {
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'ratchet-h10-'));
  projects.push(proj);
  const sPath = state.statePath(proj);
  assert.ok(!fs.existsSync(sPath), 'the store must start absent');

  let refusal = null;
  try {
    state.withWorkspaceMutation(proj, { expectedStateRev: 0, action: 'cas on nothing' }, (s) => {
      s.objective = 'should never land';
    });
  } catch (e) {
    refusal = e;
  }
  assert.ok(refusal, 'naming a revision on a store that does not exist must be refused');
  assert.strictEqual(refusal.code, 'ERATCHETSTALE', `coded stale; got ${refusal.code}`);
  assert.ok(
    !fs.existsSync(sPath),
    'a zero-byte refusal means zero bytes — the refusal must not leave a freshly minted state.json behind'
  );
});

// --- M12: saveState and saveLedger are the same door -------------------------

ok('M12 a propose-only agent cannot write through saveState or saveLedger', () => {
  const proj = freshProject('m12');
  const s = state.loadState(proj);
  const l = state.loadLedger(proj);
  const before = stateBytes(proj);
  process.env.RATCHET_AGENT = 'ratchet-builder';
  try {
    s.objective = 'written by a propose-only agent';
    assert.throws(() => state.saveState(proj, s), /propose-only/, 'saveState must not be the softer second door');
    assert.throws(() => state.saveLedger(proj, l), /propose-only/, 'and neither must saveLedger');
  } finally {
    delete process.env.RATCHET_AGENT;
  }
  assert.ok(stateBytes(proj).equals(before), 'the refused writes must move zero bytes');
});

// --- M11: proof is validated under the lock that protects the append ---------

ok('M11 a bound event validates its proof under the journal lock, not before it', () => {
  const proj = freshProject('m11');
  const lifecycle = require('../src/lifecycle');
  fs.mkdirSync(path.join(proj, 'src'), { recursive: true });
  fs.writeFileSync(path.join(proj, 'src', 'thing.js'), 'module.exports = 1;\n', 'utf8');
  const art = artifacts.addArtifact(proj, { title: 'm11', kind: 'code', path: 'src/thing.js' });
  const fp = lifecycle.fingerprint(proj, art);

  // Validation binds evidence to an exact revision and hash. Doing that BEFORE
  // taking the lock leaves a window in which the artifact is revised, closed, or
  // re-bound — and the append then lands evidence that was true when it was
  // checked and false when it was written. fingerprint runs only during
  // validation, so it is the honest place to ask "was the lock held?".
  const realFingerprint = lifecycle.fingerprint;
  const seen = [];
  lifecycle.fingerprint = function (cwd, artifact) {
    seen.push(fs.existsSync(journalLockDir(proj)));
    return realFingerprint.call(lifecycle, cwd, artifact);
  };
  try {
    journal.appendEvent(
      proj,
      {
        target: 'src/thing.js',
        artifactId: art.id,
        verdict: 'KEEP',
        verification: { commands: [{ command: 'node -e 0', pass: true }], result: 'pass' },
        seam: { evidenceType: 'test', testedSeam: 'x', shipSeam: 'x', seamMatch: 'exact', independentFromBuilderMethod: true },
      },
      { verifiedHash: fp.hash, verifiedRev: fp.rev }
    );
  } finally {
    lifecycle.fingerprint = realFingerprint;
  }

  assert.ok(seen.length, 'the append must actually validate the binding');
  assert.ok(
    seen.every((locked) => locked),
    `every validation of a bound event must run under the journal lock — ${seen.filter((l) => !l).length} of ${seen.length} did not`
  );
});

// --- M13: one identity, one event --------------------------------------------

ok('M13 a supplied event id that is already on the log is refused', () => {
  const proj = freshProject('m13');
  const first = journal.appendEvent(proj, { id: 'evo_hand_1', target: 'm13', verdict: 'ASK' });
  assert.strictEqual(first.id, 'evo_hand_1', 'an unbound event may still carry a caller id');
  assert.throws(
    () => journal.appendEvent(proj, { id: 'evo_hand_1', target: 'm13', verdict: 'REVERT' }),
    /already on the log/,
    'but not a second time — one identity names one event'
  );
  // The log is shared across this suite's projects (one RATCHET_EVOLVE_LOG), so
  // count the identity in question, not the file.
  assert.strictEqual(
    journal.readEvents(proj).filter((e) => e && e.id === 'evo_hand_1').length,
    1,
    'and the refused append writes no line — one identity, one event'
  );
});

// ===========================================================================
// Patch cycle 2 — the re-verification of cycle 1. Four findings cycle 1 only
// MOVED, and seven the patch itself introduced. Same discipline: red first.
// Traced by: claude-opus-5
// ===========================================================================

const lifecycle = require('../src/lifecycle');

// A child that runs to completion and reports what it caught, synchronously —
// so it can be launched from inside an injected hook while this process is
// blocked mid-write. spawnSync IS the barrier; no sentinel files needed.
function childRun(proj, body, extraEnv) {
  const script = `'use strict';
const fs = require('fs');
const path = require('path');
const SRC = ${JSON.stringify(SRC)};
const out = { error: null, code: null, extra: null };
try {
${body}
} catch (e) {
  out.error = e && e.message ? e.message : String(e);
  out.code = (e && e.code) || null;
}
process.stdout.write(JSON.stringify(out));`;
  const r = spawnSync(process.execPath, ['-e', script], {
    cwd: proj,
    env: childEnv(proj, extraEnv),
    encoding: 'utf8',
  });
  try {
    return JSON.parse(r.stdout);
  } catch (_e) {
    return { error: `child produced no result (stdout: ${r.stdout}) (stderr: ${String(r.stderr).slice(0, 300)})`, code: null };
  }
}

// The suite shares one journal across projects; a test that damages the log must
// not damage every test after it.
function withOwnJournal(proj, fn) {
  const prev = process.env.RATCHET_EVOLVE_LOG;
  const log = path.join(proj, 'own-evolve-log.jsonl');
  process.env.RATCHET_EVOLVE_LOG = log;
  try {
    return fn(log);
  } finally {
    if (prev === undefined) delete process.env.RATCHET_EVOLVE_LOG;
    else process.env.RATCHET_EVOLVE_LOG = prev;
  }
}

// An artifact that will actually close: real file, bound KEEP, seam evidence.
function closableArtifact(proj) {
  fs.mkdirSync(path.join(proj, 'src'), { recursive: true });
  fs.writeFileSync(path.join(proj, 'src', 'a.js'), 'module.exports = 1;\n', 'utf8');
  const art = artifacts.addArtifact(proj, { title: 'closable', kind: 'code', path: 'src/a.js' });
  const fp = lifecycle.fingerprint(proj, art);
  journal.appendEvent(
    proj,
    {
      target: 'src/a.js',
      artifactId: art.id,
      verdict: 'KEEP',
      verification: { commands: [{ command: 'node -e 0', pass: true }], result: 'pass' },
      seam: { evidenceType: 'test', testedSeam: 'x', shipSeam: 'x', seamMatch: 'exact', independentFromBuilderMethod: true },
    },
    { verifiedHash: fp.hash, verifiedRev: fp.rev }
  );
  return art;
}

// --- C4 residual: no card shape is exempt from verification ------------------

ok('C4 a tokenless judgment still verifies what the break moved', () => {
  const proj = freshProject('c4-tokenless');
  const lockDir = workspaceLockDir(proj);
  // An older-format or hand-planted card carries no token. Cycle 1 made the
  // moved-card check conditional on having one, so a tokenless judgment skipped
  // verification entirely and could carry off a live successor.
  fs.mkdirSync(lockDir, { recursive: true });
  fs.writeFileSync(
    path.join(lockDir, 'owner.json'),
    JSON.stringify({ pid: deadPid(), host: os.hostname(), at: new Date(Date.now() - 30000).toISOString(), action: 'tokenless' }),
    'utf8'
  );

  const realRename = fs.renameSync;
  let swapped = false;
  fs.renameSync = function (from, to) {
    if (!swapped && String(from) === lockDir) {
      swapped = true;
      realRename.call(fs, from, `${lockDir}.decoy`);
      plantLock(lockDir, { ageMs: 0, token: 'liveB', action: 'live successor' });
    }
    return realRename.call(fs, from, to);
  };
  let refusal = null;
  try {
    state.withWorkspaceLock(proj, 'breaker', () => {});
  } catch (e) {
    refusal = e;
  } finally {
    fs.renameSync = realRename;
  }

  assert.ok(swapped, 'the injection must fire');
  assert.ok(fs.existsSync(lockDir), 'the live successor must survive a break aimed at a tokenless predecessor');
  assert.strictEqual(readToken(lockDir), 'liveB', 'and must still be the successor holding');
  assert.ok(refusal, 'the breaker must end up refused');
  fs.rmSync(lockDir, { recursive: true, force: true });
  fs.rmSync(`${lockDir}.decoy`, { recursive: true, force: true });
});

// --- M12 residual: the ledger is canonical too -------------------------------

ok('M12 saveLedger takes the workspace lock like every other write', () => {
  const proj = freshProject('m12-ledger');
  const ledger = state.loadLedger(proj);
  const lockDir = plantLock(workspaceLockDir(proj), { ageMs: 0, token: 'ledgerholder', action: 'holding the store' });
  const prevTimeout = process.env.RATCHET_LOCK_TIMEOUT_MS;
  process.env.RATCHET_LOCK_TIMEOUT_MS = '400';
  let refusal = null;
  try {
    ledger.features.push({ id: 'f1', name: 'written past the lock' });
    state.saveLedger(proj, ledger);
  } catch (e) {
    refusal = e;
  } finally {
    if (prevTimeout === undefined) delete process.env.RATCHET_LOCK_TIMEOUT_MS;
    else process.env.RATCHET_LOCK_TIMEOUT_MS = prevTimeout;
  }
  assert.ok(refusal, 'a ledger write must queue behind the workspace lock, not walk past it');
  assert.strictEqual(refusal.code, 'ERATCHETLOCK', `and must be refused by the lock; got ${refusal.code}: ${refusal.message}`);
  assert.strictEqual(
    (state.loadLedger(proj).features || []).length,
    0,
    'and the refused write must leave the ledger untouched'
  );
  fs.rmSync(lockDir, { recursive: true, force: true });
});

// --- N1: a commit re-verifies that it still owns the lock --------------------

ok('N1 a commit aborts if this process no longer owns the lock', () => {
  const proj = freshProject('n1');
  const s0 = state.loadState(proj);
  s0.objective = 'the record before';
  state.saveState(proj, s0);
  const before = stateBytes(proj);
  const lockDir = workspaceLockDir(proj);

  // Every residual steal window — a failed restore, an ABA break, a
  // lock-bypassing writer — ends the same way: two processes believe they hold
  // one lock. Defense in depth is to check at the last possible instant, so a
  // theft becomes a loser-side refusal that writes nothing instead of a silent
  // double write.
  let refusal = null;
  try {
    state.withWorkspaceMutation(proj, { action: 'n1' }, (s) => {
      s.objective = 'must never land';
      fs.writeFileSync(
        path.join(lockDir, 'owner.json'),
        JSON.stringify({ token: 'somebodyelse', pid: process.pid, host: os.hostname(), at: new Date().toISOString(), action: 'thief' }),
        'utf8'
      );
    });
  } catch (e) {
    refusal = e;
  }
  assert.ok(refusal, 'a commit that no longer owns its lock must abort');
  assert.strictEqual(refusal.code, 'ERATCHETLOCKLOST', `coded lock-lost; got ${refusal.code}: ${refusal.message}`);
  assert.ok(stateBytes(proj).equals(before), 'and must write zero canonical bytes');
  fs.rmSync(lockDir, { recursive: true, force: true });
});

// --- N2: the revision line never restarts while the store exists ------------

ok('N2 a force reset continues the revision line instead of reusing rev 0', () => {
  const proj = freshProject('n2-counter');
  assert.strictEqual(state.loadState(proj).rev, 0, 'a fresh store on an EMPTY dir still opens at rev 0');
  const s = state.loadState(proj);
  s.objective = 'pre-reset';
  state.saveState(proj, s);
  assert.strictEqual(state.loadState(proj).rev, 1, 'work advances it');
  state.initProject(proj, { force: true, resetBy: 'test', resetReason: 'n2' });
  const after = state.loadState(proj);
  assert.strictEqual(after.objective, '', 'the reset still wipes the record');
  assert.strictEqual(after.rev, 2, `a reset is one more revision, not a restart — got rev ${after.rev}`);
});

ok('N2 a writer paused across a reset cannot resurrect the pre-reset record', () => {
  const proj = freshProject('n2-resurrect');
  const sync = path.join(proj, 'n2sync');
  fs.mkdirSync(sync, { recursive: true });

  // The child loads the freshly initialized store (rev 0) and waits. While it
  // waits, real work lands and then the store is RESET. If a reset reuses rev 0,
  // the child's stale snapshot matches the fresh generation's revision exactly,
  // takes the fast path, and writes its whole pre-reset record over the reset —
  // erasing a deliberate, authorized wipe.
  const child = spawn(
    process.execPath,
    [
      '-e',
      `'use strict';
const fs = require('fs'); const path = require('path');
const state = require(path.join(${JSON.stringify(SRC)}, 'state.js'));
const sync = ${JSON.stringify(sync)};
const s = state.loadState(process.cwd());
fs.writeFileSync(path.join(sync, 'loaded'), String(s.rev), 'utf8');
const deadline = Date.now() + 20000;
while (!fs.existsSync(path.join(sync, 'go')) && Date.now() < deadline) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
}
const res = { error: null, code: null };
try { s.objective = 'resurrected by a paused writer'; state.saveState(process.cwd(), s); }
catch (e) { res.error = e.message; res.code = e.code || null; }
fs.writeFileSync(path.join(sync, 'done'), JSON.stringify(res), 'utf8');`,
    ],
    { cwd: proj, env: childEnv(proj), stdio: 'ignore' }
  );
  child.unref();
  const waitFor = (f) => {
    const deadline = Date.now() + 20000;
    while (!fs.existsSync(path.join(sync, f)) && Date.now() < deadline) sleepSync(20);
    assert.ok(fs.existsSync(path.join(sync, f)), `child never reached "${f}"`);
  };
  waitFor('loaded');
  assert.strictEqual(fs.readFileSync(path.join(sync, 'loaded'), 'utf8'), '0', 'the child holds a rev-0 snapshot');

  const s = state.loadState(proj);
  s.objective = 'work that happened before the reset';
  state.saveState(proj, s);
  state.initProject(proj, { force: true, resetBy: 'danny', resetReason: 'start a new run' });

  fs.writeFileSync(path.join(sync, 'go'), '1', 'utf8');
  waitFor('done');
  const res = JSON.parse(fs.readFileSync(path.join(sync, 'done'), 'utf8'));

  const final = state.loadState(proj);
  assert.strictEqual(
    final.objective,
    '',
    `an authorized reset must survive a paused writer — objective is ${JSON.stringify(final.objective)}, child said ${JSON.stringify(res)}`
  );
  assert.ok(res.error, `the stale writer must be refused, not merged — child reported: ${JSON.stringify(res)}`);
  assert.strictEqual(res.code, 'ERATCHETSTALE', `and refused as stale; got ${res.code}`);
});

// --- N3: no fallback ever writes the canonical path in place -----------------

ok('N3 a creation that dies mid-write never leaves a malformed record', () => {
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'ratchet-n3-'));
  projects.push(proj);
  // Force the no-hard-links fallback, then kill the write halfway. The 'wx'
  // fallback opened the CANONICAL path and wrote into it, so a failure left a
  // permanently malformed state.json that creation then refused to repair
  // (EEXIST) while every reader spawned another .corrupt backup.
  // The FIRST write of the record is the scratch copy every design makes; the
  // SECOND is where the designs differ — an in-place canonical write, or another
  // scratch file destined for a rename. Failing the second is what tells them
  // apart, so the counter is the injection, not the path.
  const [res] = runChildren(
    proj,
    `  const state = require(path.join(SRC, 'state.js'));
  fs.linkSync = function () { throw Object.assign(new Error('EPERM: no hard links here'), { code: 'EPERM' }); };
  const realWrite = fs.writeFileSync;
  let records = 0;
  fs.writeFileSync = function (file, data, ...rest) {
    if (typeof data === 'string' && data.includes('"createdAt"')) {
      records++;
      if (records >= 2) {
        realWrite.call(fs, file, data.slice(0, Math.floor(data.length / 2)), ...rest);
        throw new Error('simulated ENOSPC mid-creation');
      }
    }
    return realWrite.call(fs, file, data, ...rest);
  };
  try { state.loadState(process.cwd()); } finally { fs.writeFileSync = realWrite; }`,
    ['n3']
  );
  assert.match(String(res.error), /simulated ENOSPC/, `the injection must fire; child said: ${res.error}`);

  const sPath = state.statePath(proj);
  if (fs.existsSync(sPath)) {
    const raw = fs.readFileSync(sPath, 'utf8');
    let parseError = null;
    try {
      JSON.parse(raw);
    } catch (e) {
      parseError = e.message;
    }
    assert.strictEqual(parseError, null, `a failed creation must never publish half a record — ${parseError}`);
  }
  // And the store must still be openable afterwards, without a repair loop.
  assert.strictEqual(state.loadState(proj).rev, 0, 'the next read opens a clean store');
});

// --- N6/N10: a nonsense clock is not a shield; a refusal hands over the fix --

ok('N6 a future-dated owner card cannot protect a lock forever', () => {
  const proj = freshProject('n6');
  // Age was computed as now - card.at, so a card stamped in the future clamped
  // to age 0 and sat under soft-stale permanently — an unbreakable lock built
  // from one bad timestamp. A clock that cannot be believed makes liveness
  // unprovable; it does not make the holding sacred.
  plantLock(workspaceLockDir(proj), { ageMs: -3600000, token: 'futurecard', action: 'stamped in the future' });
  let ran = false;
  state.withWorkspaceLock(proj, 'contender', () => {
    ran = true;
  });
  assert.ok(ran, 'a card with an unbelievable timestamp must be recoverable');
});

ok('N10 a lock refusal hands the operator the resolution', () => {
  const proj = freshProject('n10');
  const lockDir = plantLock(workspaceLockDir(proj), { ageMs: 1000, token: 'livewedge', action: 'wedged writer' });
  const prevTimeout = process.env.RATCHET_LOCK_TIMEOUT_MS;
  process.env.RATCHET_LOCK_TIMEOUT_MS = '300';
  let refusal = null;
  try {
    state.withWorkspaceLock(proj, 'contender', () => {});
  } catch (e) {
    refusal = e;
  } finally {
    if (prevTimeout === undefined) delete process.env.RATCHET_LOCK_TIMEOUT_MS;
    else process.env.RATCHET_LOCK_TIMEOUT_MS = prevTimeout;
  }
  assert.ok(refusal, 'a live holder produces a refusal');
  const m = refusal.message;
  // A wedged live holder is never auto-broken by policy, so the operator IS the
  // recovery path — the message has to contain everything that decision needs.
  assert.ok(m.includes(lockDir), `the refusal must name the lock directory; got: ${m}`);
  assert.ok(m.includes(String(process.pid)), `and the owner pid; got: ${m}`);
  assert.ok(m.includes(os.hostname()), `and the owner host; got: ${m}`);
  assert.ok(/wedged writer/.test(m), `and what it is doing; got: ${m}`);
  assert.ok(/\bdelete\b/i.test(m) && /\.lock/.test(m), `and the manual remedy; got: ${m}`);
  fs.rmSync(lockDir, { recursive: true, force: true });
});

// --- N7: the library door is the same door ----------------------------------

ok('N7 a propose-only agent cannot wipe the store through initProject', () => {
  const proj = freshProject('n7');
  const s = state.loadState(proj);
  s.objective = 'the record an auditor must not wipe';
  state.saveState(proj, s);
  const before = stateBytes(proj);
  process.env.RATCHET_AGENT = 'ratchet-auditor';
  try {
    assert.throws(() => state.initProject(proj, { force: true }), /propose-only/, 'the library wipe is a wipe');
    // A plain init still orients: it creates nothing that exists and wipes nothing.
    assert.doesNotThrow(() => state.initProject(proj), 'a non-destructive init stays open to a propose-only agent');
  } finally {
    delete process.env.RATCHET_AGENT;
  }
  assert.ok(stateBytes(proj).equals(before), 'the refused wipe must move zero bytes');
});

// --- N8: the corrupt backup is a write, so it happens under the lock --------

ok('N8 backing up a corrupt record happens under the workspace lock', () => {
  const proj = freshProject('n8');
  fs.writeFileSync(state.statePath(proj), '{ this is not json', 'utf8');
  const realWrite = fs.writeFileSync;
  const backups = [];
  fs.writeFileSync = function (file, ...rest) {
    if (String(file).includes('.corrupt.')) backups.push(fs.existsSync(workspaceLockDir(proj)));
    return realWrite.call(fs, file, ...rest);
  };
  try {
    state.loadState(proj);
  } finally {
    fs.writeFileSync = realWrite;
  }
  assert.strictEqual(backups.length, 1, `the corrupt record must be backed up exactly once; got ${backups.length}`);
  assert.strictEqual(backups[0], true, 'and the backup — a write — must happen under the workspace lock');
});

fs.rmSync(tmp, { recursive: true, force: true });
for (const p of projects) fs.rmSync(p, { recursive: true, force: true });
process.stdout.write(`\n${passed} passed, ${failures.length} failed\n`);
if (failures.length) {
  process.stdout.write(`RED (expected until the concurrency gate ships): ${failures.map((f) => f.name).join(', ')}\n`);
  process.exitCode = 1;
}
