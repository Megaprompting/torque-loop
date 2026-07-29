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

fs.rmSync(tmp, { recursive: true, force: true });
for (const p of projects) fs.rmSync(p, { recursive: true, force: true });
process.stdout.write(`\n${passed} passed, ${failures.length} failed\n`);
if (failures.length) {
  process.stdout.write(`RED (expected until the concurrency gate ships): ${failures.map((f) => f.name).join(', ')}\n`);
  process.exitCode = 1;
}
