'use strict';

// Torque step 4b.1: the write-ahead intent slot on the defect.add canary.
// Run: node test/mcp-wal.test.js
//
// What this suite exists to prove, in the ratified spec's words: one operation
// writes two canonical files behind one intent, a process death anywhere lands
// on one of three legal hash pairs, recovery finishes or discards the work —
// byte-exactly, proven against the hashes the intent recorded — and anything
// recovery cannot prove preserves every byte and refuses loudly. The crash
// matrix uses REAL child processes dying at the actual rename/link/unlink
// calls, on both the normal path and inside recovery itself.
//
// Traced by: claude-fable-5

const assert = require('assert');
const childProcess = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.realpathSync.native(
  fs.mkdtempSync(path.join(os.tmpdir(), 'ratchet-mcp-wal-test-'))
);
process.env.RATCHET_DATA_DIR = path.join(tmp, 'state-store');
process.env.RATCHET_EVOLVE_LOG = path.join(tmp, 'evolve-log.jsonl');

const wal = require('../src/wal');
const state = require('../src/state');
const artifacts = require('../src/artifacts');
const mcp = require('../src/mcp/server');

const META = 'io.modelcontextprotocol/';
const MODERN = '2026-07-28';

let passed = 0;
const failures = [];
function ok(name, fn) {
  try {
    fn();
    passed++;
    process.stdout.write(`  ok    ${name}\n`);
  } catch (e) {
    failures.push(name);
    process.stdout.write(`  FAIL  ${name}\n        ${e && e.message ? e.message : e}\n`);
  }
}

let fixtureNumber = 0;
function fixture(label) {
  const dir = path.join(tmp, `${label}-${fixtureNumber++}`);
  fs.mkdirSync(dir, { recursive: true });
  return fs.realpathSync.native(dir);
}

function cleanGitEnv() {
  const env = Object.assign({}, process.env);
  for (const key of Object.keys(env)) {
    if (key.toUpperCase().startsWith('GIT_')) delete env[key];
  }
  return env;
}

function git(cwd, args) {
  return childProcess.execFileSync('git', args, {
    cwd, encoding: 'utf8', env: cleanGitEnv(), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
}

function initRepo(label) {
  const dir = fixture(label);
  git(dir, ['init', '--quiet']);
  return dir;
}

function initStore(repo) {
  state.initProject(repo);
  state.loadLedger(repo);
}

function readIntent(repo) {
  return JSON.parse(fs.readFileSync(state.intentPath(repo), 'utf8'));
}

function bytesOf(file) {
  return fs.readFileSync(file);
}

function hashOf(file) {
  return wal.hashBytes(bytesOf(file));
}

// Canonical bytes only. A process killed mid-transaction leaves its lock
// owner card and (before the intent publishes) a named .tmp- scratch file —
// both inert, both self-describing, both explicitly outside the recovery
// claim, which covers the two records and the slot.
function storeSnapshot(repo) {
  const dir = state.projectDir(repo);
  const out = {};
  if (!fs.existsSync(dir)) return out;
  const walk = (d, rel) => {
    for (const name of fs.readdirSync(d)) {
      if (name === '.lock' || name.includes('.tmp-')) continue;
      const full = path.join(d, name);
      const key = rel ? `${rel}/${name}` : name;
      const stat = fs.lstatSync(full);
      if (stat.isDirectory()) walk(full, key);
      else out[key] = fs.readFileSync(full).toString('hex');
    }
  };
  walk(dir, '');
  return out;
}

function readState(repo) {
  return JSON.parse(fs.readFileSync(state.statePath(repo), 'utf8'));
}

function readLedger(repo) {
  return JSON.parse(fs.readFileSync(state.ledgerPath(repo), 'utf8'));
}

// The spec's own degraded outcome, honored the way a user would. On this
// host, an external hold on a freshly replaced mirror can outlive even the
// publish deadline (measured: src movable, dest opens r+, the replace refused
// for seconds) — the operation then surfaces ERATCHETMIRRORPENDING and says
// "re-run the command". The harness does exactly that, a bounded number of
// times with a breather between. What the assertions pin is CONVERGENCE —
// recovery completes the mirror and the verb no-ops or answers — never a
// silent swallow of a different error.
function settled(fn) {
  for (let attempt = 0; ; attempt++) {
    try {
      return fn();
    } catch (e) {
      if (!e || e.code !== 'ERATCHETMIRRORPENDING' || attempt >= 2) throw e;
      sleep(500);
    }
  }
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Trigger the recovery choke point through a supported writer that changes
// nothing itself: an empty locked section — with the same settled patience,
// because recovery's own mirror publish can meet the same external hold.
function triggerRecovery(repo) {
  settled(() => state.withWorkspaceLock(repo, 'wal-test recovery probe', () => {}));
}

// A store with one committed defect and a crafted, internally-consistent
// intent in the requested phase. Crafting (rather than crashing) gives the
// ambiguity tests a slot whose every field is under test control; the crash
// matrix below produces the real thing.
function craftedSlot(repo, phase) {
  initStore(repo);
  const stateBytes = bytesOf(state.statePath(repo));
  const ledgerBytes = bytesOf(state.ledgerPath(repo));
  const ledgerObj = JSON.parse(ledgerBytes.toString('utf8'));
  const mirror = {
    id: 'ldef-crafted', at: '2026-07-31T00:00:00.000Z', feature: '', severity: 'high',
    summary: 'crafted', status: 'open', foundAt: '2026-07-31T00:00:00.000Z',
  };
  const ops = [{ collection: 'defects', id: 'ldef-crafted', mode: 'insert', after: mirror }];
  const now = '2026-07-31T00:00:00.000Z';
  const stateObj = JSON.parse(stateBytes.toString('utf8'));
  stateObj.defects.push({ id: 'def-crafted', at: now, severity: 'high', summary: 'crafted', status: 'open', artifact: '', attachedBy: 'none', artifactRev: null, artifactHash: '', ledgerId: 'ldef-crafted' });
  stateObj.dirty = true;
  stateObj.rev = (Number.isInteger(stateObj.rev) ? stateObj.rev : 0) + 1;
  stateObj.updatedAt = now;
  const stateAfterBytes = wal.serializeRecord(stateObj);
  const ledgerAfterBytes = wal.serializeRecord(wal.applyLedgerOps(ledgerObj, ops, now));
  const intent = {
    version: 1, door: 'cli', operationId: 'wal-crafted-operation', tool: 'defect add',
    argsHash: wal.hashBytes(Buffer.from('crafted', 'utf8')),
    stateGen: String(stateObj.gen || '') || '(none)',
    baseStateRev: stateObj.rev - 1, targetStateRev: stateObj.rev,
    stateBeforeHash: wal.hashBytes(stateBytes),
    stateAfterHash: wal.hashBytes(stateAfterBytes),
    ledgerBeforeHash: wal.hashBytes(ledgerBytes),
    ledgerAfterHash: wal.hashBytes(ledgerAfterBytes),
    ledgerUpdatedAt: now, ledgerOps: ops, at: now,
  };
  if (phase === 'after-state' || phase === 'after-ledger') {
    fs.writeFileSync(state.statePath(repo), stateAfterBytes);
  }
  if (phase === 'after-ledger') {
    fs.writeFileSync(state.ledgerPath(repo), ledgerAfterBytes);
  }
  fs.writeFileSync(state.intentPath(repo), wal.serializeRecord(intent));
  return { intent, stateAfterBytes, ledgerAfterBytes };
}

// ---------------------------------------------------------------------------
// Unit: the strict parser and the op applier.
// ---------------------------------------------------------------------------

function validIntent(over) {
  const sha = `sha256:${'0'.repeat(64)}`;
  return Object.assign({
    version: 1, door: 'cli', operationId: 'op-1234567890', tool: 'defect add',
    argsHash: sha, stateGen: 'gen-x', baseStateRev: 3, targetStateRev: 4,
    stateBeforeHash: sha, stateAfterHash: sha, ledgerBeforeHash: sha, ledgerAfterHash: sha,
    ledgerUpdatedAt: 't', at: 't',
    ledgerOps: [{ collection: 'defects', id: 'ldef-1', mode: 'insert', after: { id: 'ldef-1' } }],
  }, over || {});
}

function parses(intent) {
  return wal.parseIntent(Buffer.from(wal.serializeRecord(intent), 'utf8'));
}

ok('U1 the version-1 parser accepts exactly the documented shape and nothing else', () => {
  assert.ok(parses(validIntent()));
  const rejects = [
    validIntent({ version: 2 }),
    validIntent({ door: 'ssh' }),
    validIntent({ tool: 'ledger.update' }),
    validIntent({ operationId: '' }),
    validIntent({ argsHash: 'sha256:short' }),
    validIntent({ targetStateRev: 5 }),
    validIntent({ baseStateRev: -1 }),
    validIntent({ stateAfterHash: 'nope' }),
    validIntent({ ledgerOps: [] }),
    validIntent({ ledgerOps: [{ collection: 'features', id: 'x', mode: 'insert', after: { id: 'x' } }] }),
    validIntent({ ledgerOps: [{ collection: 'defects', id: 'x', mode: 'merge', after: { id: 'x' } }] }),
    validIntent({ ledgerOps: [{ collection: 'defects', id: 'x', mode: 'insert', after: { id: 'y' } }] }),
    validIntent({
      ledgerOps: [
        { collection: 'defects', id: 'x', mode: 'insert', after: { id: 'x' } },
        { collection: 'defects', id: 'x', mode: 'replace', after: { id: 'x' } },
      ],
    }),
    Object.assign(validIntent(), { extra: true }),
  ];
  for (const bad of rejects) {
    assert.throws(() => parses(bad), (e) => e.code === 'ERATCHETMIRROR', JSON.stringify(bad).slice(0, 120));
  }
  const missing = validIntent();
  delete missing.ledgerUpdatedAt;
  assert.throws(() => parses(missing), (e) => e.code === 'ERATCHETMIRROR');
  assert.throws(() => wal.parseIntent(Buffer.from('not json', 'utf8')), (e) => e.code === 'ERATCHETMIRROR');
  assert.throws(() => wal.parseIntent(Buffer.alloc(wal.INTENT_CAP + 1)), (e) => e.code === 'ERATCHETMIRROR');
});

ok('U2 ledger ops apply exactly: insert needs absence, replace needs exactly one', () => {
  const ledger = { defects: [{ id: 'a', severity: 'low' }], features: [], tests: [], updatedAt: 'old' };
  const out = wal.applyLedgerOps(ledger, [
    { collection: 'defects', id: 'b', mode: 'insert', after: { id: 'b', severity: 'high' } },
    { collection: 'defects', id: 'a', mode: 'replace', after: { id: 'a', severity: 'critical' } },
  ], 'new-time');
  assert.deepStrictEqual(out.defects.map((d) => [d.id, d.severity]), [['a', 'critical'], ['b', 'high']]);
  assert.strictEqual(out.updatedAt, 'new-time');
  assert.deepStrictEqual(ledger.defects.map((d) => d.severity), ['low'], 'the before-image is never mutated');
  assert.throws(() => wal.applyLedgerOps(ledger, [{ collection: 'defects', id: 'a', mode: 'insert', after: { id: 'a' } }], 't'),
    (e) => e.code === 'ERATCHETMIRROR');
  assert.throws(() => wal.applyLedgerOps(ledger, [{ collection: 'defects', id: 'zz', mode: 'replace', after: { id: 'zz' } }], 't'),
    (e) => e.code === 'ERATCHETMIRROR');
});

ok('U3 the canonical publish retries a transient rename refusal; persistent refusals still throw', () => {
  const dir = fixture('u3');
  const file = path.join(dir, 'target.json');
  const orig = fs.renameSync;
  let denials = 2;
  fs.renameSync = (a, b) => {
    if (path.basename(String(b)) === 'target.json' && denials > 0) {
      denials--;
      const e = new Error('injected transient denial');
      e.code = 'EPERM';
      throw e;
    }
    return orig(a, b);
  };
  try {
    state.writeFileAtomic(file, 'published\n');
  } finally {
    fs.renameSync = orig;
  }
  assert.strictEqual(fs.readFileSync(file, 'utf8'), 'published\n',
    'a scanner holding the destination for an instant does not fail the publish');
  fs.renameSync = (a, b) => {
    if (path.basename(String(b)) === 'never.json') {
      const e = new Error('denied for good');
      e.code = 'EPERM';
      throw e;
    }
    return orig(a, b);
  };
  process.env.RATCHET_PUBLISH_TIMEOUT_MS = '150';
  try {
    assert.throws(() => state.writeFileAtomic(path.join(dir, 'never.json'), 'x\n'), /denied for good/,
      'the deadline never becomes a swallow');
  } finally {
    fs.renameSync = orig;
    delete process.env.RATCHET_PUBLISH_TIMEOUT_MS;
  }
});

// ---------------------------------------------------------------------------
// The three-state machine and its refusal to guess.
// ---------------------------------------------------------------------------

ok('R1 a slot whose state decision never published is discarded byte-purely', () => {
  const repo = fixture('r1');
  craftedSlot(repo, 'before');
  const stateHash = hashOf(state.statePath(repo));
  const ledgerHash = hashOf(state.ledgerPath(repo));
  assert.deepStrictEqual(state.diagnoseIntent(repo), { pending: true, verdict: 'discarded' });
  triggerRecovery(repo);
  assert.ok(!fs.existsSync(state.intentPath(repo)), 'the slot is cleared');
  assert.strictEqual(hashOf(state.statePath(repo)), stateHash, 'state bytes untouched');
  assert.strictEqual(hashOf(state.ledgerPath(repo)), ledgerHash, 'ledger bytes untouched');
});

ok('R2 a state-decided slot completes its mirror to the exact recorded bytes', () => {
  const repo = fixture('r2');
  const { intent } = craftedSlot(repo, 'after-state');
  assert.deepStrictEqual(state.diagnoseIntent(repo), { pending: true, verdict: 'completed' });
  triggerRecovery(repo);
  assert.ok(!fs.existsSync(state.intentPath(repo)));
  assert.strictEqual(hashOf(state.statePath(repo)), intent.stateAfterHash);
  assert.strictEqual(hashOf(state.ledgerPath(repo)), intent.ledgerAfterHash,
    'the recovered mirror is byte-identical to the bytes the intent proved');
  const disk = readState(repo);
  const mirror = readLedger(repo).defects.find((d) => d.id === disk.defects[0].ledgerId);
  assert.strictEqual(mirror.severity, disk.defects[0].severity, 'mirror and state agree');
});

ok('R3 a slot whose mirror already landed only clears', () => {
  const repo = fixture('r3');
  craftedSlot(repo, 'after-ledger');
  const before = storeSnapshot(repo);
  assert.deepStrictEqual(state.diagnoseIntent(repo), { pending: true, verdict: 'cleared' });
  triggerRecovery(repo);
  assert.ok(!fs.existsSync(state.intentPath(repo)));
  delete before['intent.json'];
  assert.deepStrictEqual(storeSnapshot(repo), before, 'nothing but the slot moved');
});

ok('R4 every unprovable observation preserves every byte and refuses by name', () => {
  const variants = [
    ['tampered state bytes', (repo) => {
      craftedSlot(repo, 'after-state');
      const s = readState(repo);
      s.objective = 'tampered out-of-band';
      fs.writeFileSync(state.statePath(repo), wal.serializeRecord(s));
    }],
    ['corrupt intent json', (repo) => {
      craftedSlot(repo, 'before');
      fs.writeFileSync(state.intentPath(repo), '{not json');
    }],
    ['unknown intent version', (repo) => {
      const { intent } = craftedSlot(repo, 'before');
      intent.version = 9;
      fs.writeFileSync(state.intentPath(repo), wal.serializeRecord(intent));
    }],
    ['mcp door without its receipt', (repo) => {
      const { intent } = craftedSlot(repo, 'after-state');
      intent.door = 'mcp';
      fs.writeFileSync(state.intentPath(repo), wal.serializeRecord(intent));
    }],
    ['reconstruction cannot reproduce the after-hash', (repo) => {
      const { intent } = craftedSlot(repo, 'after-state');
      intent.ledgerAfterHash = `sha256:${'f'.repeat(64)}`;
      fs.writeFileSync(state.intentPath(repo), wal.serializeRecord(intent));
    }],
  ];
  for (const [name, arm] of variants) {
    const repo = fixture('r4');
    arm(repo);
    const before = storeSnapshot(repo);
    assert.strictEqual(state.diagnoseIntent(repo).verdict, 'ambiguous', name);
    assert.throws(() => triggerRecovery(repo), (e) => e.code === 'ERATCHETMIRROR', name);
    assert.throws(() => artifacts.addDefect(repo, { summary: 'blocked' }), (e) => e.code === 'ERATCHETMIRROR',
      `${name}: the mirrored writer refuses too`);
    assert.deepStrictEqual(storeSnapshot(repo), before, `${name}: every byte preserved, slot included`);
  }
});

ok('R5 the choke point covers the supported writers, not just the mirrored one', () => {
  // Each supported door, given a discardable slot, resolves it before working.
  const doors = [
    ['withWorkspaceMutation', (repo) => state.withWorkspaceMutation(repo, { action: 'probe' }, () => {})],
    ['saveLedger', (repo) => state.saveLedger(repo, state.loadLedger(repo))],
    ['initProject', (repo) => state.initProject(repo)],
  ];
  for (const [name, act] of doors) {
    const repo = fixture('r5');
    craftedSlot(repo, 'before');
    act(repo);
    assert.ok(!fs.existsSync(state.intentPath(repo)), `${name} recovered the slot on its way in`);
  }
});

// ---------------------------------------------------------------------------
// The CLI door: defect add through the WAL.
// ---------------------------------------------------------------------------

ok('D1 a CLI defect add commits state, mirror, and back-link in one operation, slot cleared', () => {
  const repo = fixture('d1');
  initStore(repo);
  const res = settled(() => artifacts.addDefect(repo, { severity: 'high', summary: 'wal canary' }));
  assert.ok(!fs.existsSync(state.intentPath(repo)), 'the slot does not outlive the operation');
  const disk = readState(repo);
  const defect = disk.defects[0];
  assert.strictEqual(defect.id, res.state.id);
  assert.ok(defect.ledgerId, 'the back-link rides the same post-image');
  const mirror = readLedger(repo).defects.find((d) => d.id === defect.ledgerId);
  assert.ok(mirror, 'the mirror landed');
  assert.deepStrictEqual(
    { severity: mirror.severity, summary: mirror.summary, status: mirror.status },
    { severity: 'high', summary: 'wal canary', status: 'open' },
    'mirror and state agree'
  );
  // A settled retry answers with the dedup shape (ledger: null); the disk
  // assertions above are the invariant either way.
  if (res.ledger) assert.strictEqual(res.ledger.id, defect.ledgerId);
});

ok('D2 a dedup repeat is a no-op decided before any intent; an escalation mirrors', () => {
  const repo = fixture('d2');
  initStore(repo);
  settled(() => artifacts.addDefect(repo, { severity: 'medium', summary: 'same finding' }));
  const before = storeSnapshot(repo);
  const dup = settled(() => artifacts.addDefect(repo, { severity: 'medium', summary: 'same finding' }));
  assert.strictEqual(dup.deduped, true);
  assert.deepStrictEqual(storeSnapshot(repo), before, 'a dedup writes no slot, no revision, no mirror');
  const esc = settled(() => artifacts.addDefect(repo, { severity: 'critical', summary: 'same finding' }));
  assert.strictEqual(esc.state.severity, 'critical');
  const disk = readState(repo);
  const mirror = readLedger(repo).defects.find((d) => d.id === disk.defects[0].ledgerId);
  assert.strictEqual(mirror.severity, 'critical', 'the escalation reached the mirror in the same operation');
  assert.strictEqual(readLedger(repo).defects.length, 1, 'escalation replaces; it does not mint a second mirror');
});

ok('D3 a legacy defect with no valid mirror is admitted on its first committed escalation', () => {
  const repo = fixture('d3');
  initStore(repo);
  // A pre-4b shape: defect on the record, no ledgerId, no mirror.
  state.withWorkspaceMutation(repo, { action: 'seed legacy' }, (s) => {
    s.defects.push({ id: 'def-legacy', at: 'old', severity: 'low', summary: 'legacy finding', status: 'open', artifact: '', attachedBy: 'none' });
  });
  const mirrorsBefore = readLedger(repo).defects.length;
  settled(() => artifacts.addDefect(repo, { severity: 'high', summary: 'legacy finding' }));
  const disk = readState(repo);
  const legacy = disk.defects.find((d) => d.id === 'def-legacy');
  assert.strictEqual(legacy.severity, 'high');
  assert.ok(legacy.ledgerId, 'admission minted and back-linked a mirror');
  const mirror = readLedger(repo).defects.find((d) => d.id === legacy.ledgerId);
  assert.strictEqual(mirror.severity, 'high');
  assert.strictEqual(mirror.summary, 'legacy finding');
  assert.strictEqual(readLedger(repo).defects.length, mirrorsBefore + 1, 'old rows untouched, one admission');
});

// ---------------------------------------------------------------------------
// The crash matrix: real processes dying at the real file operations.
// ---------------------------------------------------------------------------

const CRASH_CHILD = path.join(tmp, 'wal-crash-child.js');
fs.writeFileSync(CRASH_CHILD, `
'use strict';
// argv: [node, script, repo, killPoint, mode]
// killPoint: intent | state | ledger | clear — die immediately BEFORE that
// canonical operation. mode 'recover' arms the failpoint and then triggers
// recovery (so recovery itself dies mid-flight); mode 'add' runs a defect add.
const fs = require('fs');
const path = require('path');
const repo = process.argv[2];
const killPoint = process.argv[3];
const mode = process.argv[4] || 'add';
const orig = { rename: fs.renameSync, link: fs.linkSync, unlink: fs.unlinkSync };
const die = () => process.exit(87);
const ends = (p, name) => String(p).replace(/\\\\/g, '/').endsWith('/' + name) || path.basename(String(p)) === name;
fs.renameSync = (a, b) => {
  if (killPoint === 'state' && ends(b, 'state.json')) die();
  if (killPoint === 'ledger' && ends(b, 'ledger.json')) die();
  return orig.rename(a, b);
};
fs.linkSync = (a, b) => {
  if (killPoint === 'intent' && ends(b, 'intent.json')) die();
  return orig.link(a, b);
};
fs.unlinkSync = (p) => {
  if (killPoint === 'clear' && ends(p, 'intent.json')) die();
  return orig.unlink(p);
};
const state = require(process.argv[5]);
const artifacts = require(process.argv[6]);
if (mode === 'recover') {
  state.withWorkspaceLock(repo, 'crash-child recovery', () => {});
} else if (mode === 'resolve') {
  artifacts.transitionDefect(repo, process.argv[7], 'resolved', { evidence: 'crash resolve', note: 'resolved: crash resolve' });
} else {
  artifacts.addDefect(repo, { severity: 'high', summary: 'crash matrix finding' });
}
process.stdout.write('SURVIVED');
`, 'utf8');

function crashChild(repo, killPoint, mode, extra) {
  const res = childProcess.spawnSync(process.execPath, [
    CRASH_CHILD, repo, killPoint, mode || 'add',
    path.join(__dirname, '..', 'src', 'state.js'),
    path.join(__dirname, '..', 'src', 'artifacts.js'),
    extra || '',
  ], { encoding: 'utf8', env: Object.assign({}, cleanGitEnv(), { RATCHET_LOCK_STALE_MS: '1' }), windowsHide: true });
  return res;
}

ok('X1 death before the intent publish leaves nothing anywhere', () => {
  const repo = fixture('x1');
  initStore(repo);
  const before = storeSnapshot(repo);
  const res = crashChild(repo, 'intent');
  assert.strictEqual(res.status, 87, res.stderr);
  assert.deepStrictEqual(storeSnapshot(repo), before, 'no slot, no state, no mirror');
  const retry = settled(() => artifacts.addDefect(repo, { severity: 'high', summary: 'crash matrix finding' }));
  assert.ok(retry.state.id, 'the retry applies exactly once');
  assert.strictEqual(readState(repo).defects.length, 1);
});

ok('X2 death before the state commit: intent discarded, retry applies once', () => {
  const repo = fixture('x2');
  initStore(repo);
  const res = crashChild(repo, 'state');
  assert.strictEqual(res.status, 87, res.stderr);
  assert.ok(fs.existsSync(state.intentPath(repo)), 'the slot survived the death');
  assert.deepStrictEqual(state.diagnoseIntent(repo), { pending: true, verdict: 'discarded' });
  settled(() => artifacts.addDefect(repo, { severity: 'high', summary: 'crash matrix finding' }));
  assert.ok(!fs.existsSync(state.intentPath(repo)));
  assert.strictEqual(readState(repo).defects.length, 1, 'exactly one application');
  assert.strictEqual(readLedger(repo).defects.length, 1);
});

ok('X3 death between state and mirror: recovery completes the exact recorded bytes', () => {
  const repo = fixture('x3');
  initStore(repo);
  const res = crashChild(repo, 'ledger');
  assert.strictEqual(res.status, 87, res.stderr);
  const intent = readIntent(repo);
  assert.strictEqual(hashOf(state.statePath(repo)), intent.stateAfterHash, 'the decision landed');
  assert.strictEqual(hashOf(state.ledgerPath(repo)), intent.ledgerBeforeHash, 'the mirror is owed');
  triggerRecovery(repo);
  assert.ok(!fs.existsSync(state.intentPath(repo)));
  assert.strictEqual(hashOf(state.ledgerPath(repo)), intent.ledgerAfterHash,
    'the mirror converged to the bytes the crashed process proved before dying');
  const disk = readState(repo);
  const mirror = readLedger(repo).defects.find((d) => d.id === disk.defects[0].ledgerId);
  assert.strictEqual(mirror.severity, disk.defects[0].severity);
});

ok('X4 death before the clear: recovery clears without rewriting a byte', () => {
  const repo = fixture('x4');
  initStore(repo);
  const res = crashChild(repo, 'clear');
  assert.strictEqual(res.status, 87, res.stderr);
  const intent = readIntent(repo);
  assert.strictEqual(hashOf(state.ledgerPath(repo)), intent.ledgerAfterHash, 'mirror already landed');
  const before = storeSnapshot(repo);
  triggerRecovery(repo);
  delete before['intent.json'];
  assert.deepStrictEqual(storeSnapshot(repo), before, 'only the slot moved');
});

ok('X5 recovery killed mid-flight restarts and converges to the same bytes', () => {
  const repo = fixture('x5');
  initStore(repo);
  assert.strictEqual(crashChild(repo, 'ledger').status, 87, 'arm: mirror owed');
  const intent = readIntent(repo);
  // Recovery dies at ITS ledger publish — the slot and the owed mirror survive.
  const rec = crashChild(repo, 'ledger', 'recover');
  assert.strictEqual(rec.status, 87, rec.stderr);
  assert.ok(fs.existsSync(state.intentPath(repo)), 'the slot survives a death inside recovery');
  // A second recovery death, this time at the clear: the mirror has landed.
  const rec2 = crashChild(repo, 'clear', 'recover');
  assert.strictEqual(rec2.status, 87, rec2.stderr);
  assert.strictEqual(hashOf(state.ledgerPath(repo)), intent.ledgerAfterHash);
  triggerRecovery(repo);
  assert.ok(!fs.existsSync(state.intentPath(repo)));
  assert.strictEqual(hashOf(state.statePath(repo)), intent.stateAfterHash);
  assert.strictEqual(hashOf(state.ledgerPath(repo)), intent.ledgerAfterHash,
    'N deaths later, the store is byte-identical to the crash-free outcome');
});

// ---------------------------------------------------------------------------
// The MCP door: defect.add over the wire.
// ---------------------------------------------------------------------------

function service(roots, write) {
  return mcp.createServer({ roots, write, serverInfo: { name: 'torque-mcp-test', version: '0.0.0' } });
}

let requestId = 0;
function modern(conn, method, params) {
  return conn.handleMessage({
    jsonrpc: '2.0', id: ++requestId, method,
    params: { ...(params || {}), _meta: {
      [META + 'protocolVersion']: MODERN,
      [META + 'clientCapabilities']: {},
      [META + 'clientInfo']: { name: 'test-client', version: '0' },
    } },
  });
}

function callTool(conn, name, arguments_) {
  return modern(conn, 'tools/call', { name, arguments: arguments_ });
}

function payload(response) {
  assert.strictEqual(response.error, undefined, response.error && response.error.message);
  assert.notStrictEqual(response.result.isError, true, JSON.stringify(response.result));
  assert.deepStrictEqual(response.result.structuredContent, JSON.parse(response.result.content[0].text));
  return response.result.structuredContent;
}

function refusal(response) {
  assert.strictEqual(response.error, undefined, response.error && response.error.message);
  assert.strictEqual(response.result.isError, true, JSON.stringify(response.result));
  const structured = response.result.structuredContent;
  assert.strictEqual(structured.message, mcp.WRITE_REFUSALS[structured.error],
    'every refusal message comes from the one allowlisted table');
  return structured;
}

function opId() {
  return crypto.randomBytes(16).toString('base64url');
}

function openWorkspace(conn, repo) {
  return payload(callTool(conn, 'workspace.open', { path: repo }));
}

function envelopeFor(open, extra) {
  return Object.assign({
    workspaceHandle: open.workspaceHandle,
    expectedStateRev: open.stateRev,
    expectedStateGen: open.stateGen,
    operationId: opId(),
  }, extra || {});
}

ok('M1 defect.add commits state + mirror with derived ids; the CLI writes the same meaning', () => {
  const mcpRepo = initRepo('m1-mcp');
  const cliRepo = initRepo('m1-cli');
  const conn = service([mcpRepo], true).createConnection();
  const open = openWorkspace(conn, mcpRepo);
  assert.strictEqual(open.pendingIntent, false);
  const result = payload(callTool(conn, 'defect.add',
    envelopeFor(open, { item: { severity: 'high', summary: 'wire finding' } })));
  assert.strictEqual(result.committed, true);
  assert.strictEqual(result.action, 'created');
  assert.match(result.defectId, /^def-[0-9a-f]{32}$/);
  assert.match(result.ledgerId, /^ldef-[0-9a-f]{32}$/);
  assert.strictEqual(result.artifact, null);
  assert.ok(!fs.existsSync(state.intentPath(mcpRepo)));
  const disk = readState(mcpRepo);
  assert.strictEqual(disk.defects[0].ledgerId, result.ledgerId);
  const mirror = readLedger(mcpRepo).defects.find((d) => d.id === result.ledgerId);
  assert.strictEqual(mirror.severity, 'high');
  assert.strictEqual(disk.operations.length, 1, 'the receipt rode the state commit');
  // Same settled contract for the spawned CLI: the pending-mirror exit says
  // "re-run the command", so the harness reruns it exactly once.
  const cliArgs = [path.join(__dirname, '..', 'bin', 'ratchet'), 'defect', 'add', '{"severity":"high","summary":"wire finding"}'];
  const cliRun = childProcess.spawnSync(process.execPath, cliArgs,
    { cwd: cliRepo, encoding: 'utf8', env: cleanGitEnv(), windowsHide: true });
  if (cliRun.status !== 0) {
    assert.match(String(cliRun.stderr), /mirror is pending recovery/, cliRun.stderr);
    const rerun = childProcess.spawnSync(process.execPath, cliArgs,
      { cwd: cliRepo, encoding: 'utf8', env: cleanGitEnv(), windowsHide: true });
    assert.strictEqual(rerun.status, 0, rerun.stderr);
  }
  const viaCli = readState(cliRepo).defects[0];
  const strip = (d) => ({ severity: d.severity, summary: d.summary, status: d.status, artifact: d.artifact, attachedBy: d.attachedBy });
  assert.deepStrictEqual(strip(readState(mcpRepo).defects[0]), strip(viaCli));
  const cliMirror = readLedger(cliRepo).defects.find((d) => d.id === viaCli.ledgerId);
  const stripM = (m) => ({ severity: m.severity, summary: m.summary, status: m.status });
  assert.deepStrictEqual(stripM(mirror), stripM(cliMirror), 'one mirror meaning on both doors');
});

ok('M2 dedup no-ops byte-purely; escalation commits and mirrors; replay answers the retry', () => {
  const repo = initRepo('m2-repo');
  const conn = service([repo], true).createConnection();
  const open = openWorkspace(conn, repo);
  payload(callTool(conn, 'defect.add', envelopeFor(open, { item: { severity: 'medium', summary: 'finding' } })));
  const before = storeSnapshot(repo);
  const dup = payload(callTool(conn, 'defect.add',
    envelopeFor({ ...open, stateRev: open.stateRev + 1 }, { item: { severity: 'medium', summary: 'finding' } })));
  assert.strictEqual(dup.committed, false);
  assert.strictEqual(dup.action, 'deduped');
  assert.deepStrictEqual(storeSnapshot(repo), before, 'a dedup moves nothing');
  const escalate = envelopeFor({ ...open, stateRev: open.stateRev + 1 }, { item: { severity: 'critical', summary: 'finding' } });
  const esc = payload(callTool(conn, 'defect.add', escalate));
  assert.strictEqual(esc.action, 'escalated');
  assert.strictEqual(esc.severity, 'critical');
  const mirror = readLedger(repo).defects.find((d) => d.id === esc.ledgerId);
  assert.strictEqual(mirror.severity, 'critical');
  const after = storeSnapshot(repo);
  const retry = payload(callTool(conn, 'defect.add', escalate));
  assert.deepStrictEqual(retry, { ...esc, replayed: true }, 'the verbatim retry is the receipt');
  assert.deepStrictEqual(storeSnapshot(repo), after, 'a replay is a pure read');
});

ok('M3 several live artifacts refuse AttachmentAmbiguous with zero bytes', () => {
  const repo = initRepo('m3-repo');
  const conn = service([repo], true).createConnection();
  const open = openWorkspace(conn, repo);
  payload(callTool(conn, 'artifact.add', envelopeFor(open, { item: { title: 'one' } })));
  payload(callTool(conn, 'artifact.add', envelopeFor({ ...open, stateRev: open.stateRev + 1 }, { item: { title: 'two' } })));
  const before = storeSnapshot(repo);
  const refused = refusal(callTool(conn, 'defect.add',
    envelopeFor({ ...open, stateRev: open.stateRev + 2 }, { item: { summary: 'homeless finding' } })));
  assert.strictEqual(refused.error, 'AttachmentAmbiguous');
  assert.deepStrictEqual(storeSnapshot(repo), before, 'the refusal moved zero bytes');
  const claimed = callTool(conn, 'defect.add',
    envelopeFor({ ...open, stateRev: open.stateRev + 2 }, { item: { summary: 'x', status: 'resolved' } }));
  assert.ok(claimed.error && claimed.error.code === -32602, 'a terminal birth refuses at the boundary');
});

ok('M4 a post-decision mirror failure answers WriteFailed; the exact retry recovers then replays', () => {
  const repo = initRepo('m4-repo');
  const conn = service([repo], true).createConnection();
  const open = openWorkspace(conn, repo);
  const envelope = envelopeFor(open, { item: { severity: 'high', summary: 'interrupted finding' } });
  const origRename = fs.renameSync;
  fs.renameSync = (a, b) => {
    if (path.basename(String(b)) === 'ledger.json') {
      const e = new Error('injected mirror failure');
      e.code = 'EIO';
      throw e;
    }
    return origRename(a, b);
  };
  let failed;
  try {
    failed = refusal(callTool(conn, 'defect.add', envelope));
  } finally {
    fs.renameSync = origRename;
  }
  assert.strictEqual(failed.error, 'WriteFailed', 'no success is emitted before mirror + clear');
  assert.ok(fs.existsSync(state.intentPath(repo)), 'the slot survives for the next writer');
  assert.strictEqual(readState(repo).operations.length, 1, 'the decision itself landed');
  const retry = payload(callTool(conn, 'defect.add', envelope));
  assert.strictEqual(retry.replayed, true, 'the retry recovers the mirror, then answers from the receipt');
  assert.ok(!fs.existsSync(state.intentPath(repo)));
  const disk = readState(repo);
  const mirror = readLedger(repo).defects.find((d) => d.id === disk.defects[0].ledgerId);
  assert.strictEqual(mirror.severity, 'high', 'the mirror was completed by recovery');
});

ok('M5 an unprovable slot refuses MirrorUnrecoverable on every write door and on open', () => {
  const repo = initRepo('m5-repo');
  const conn = service([repo], true).createConnection();
  const open = openWorkspace(conn, repo);
  craftedSlot(repo, 'after-state');
  const broken = readIntent(repo);
  broken.ledgerAfterHash = `sha256:${'f'.repeat(64)}`;
  fs.writeFileSync(state.intentPath(repo), wal.serializeRecord(broken));
  const before = storeSnapshot(repo);
  const mirrored = refusal(callTool(conn, 'defect.add', envelopeFor(open, { item: { summary: 'x' } })));
  assert.strictEqual(mirrored.error, 'MirrorUnrecoverable');
  const single = refusal(callTool(conn, 'state.set', envelopeFor(open, { key: 'objective', value: 'x' })));
  assert.strictEqual(single.error, 'MirrorUnrecoverable', 'the safe-core writers refuse over the same store');
  assert.deepStrictEqual(storeSnapshot(repo), before, 'no refusal moved a byte');
  const conn2 = service([repo], true).createConnection();
  const reopened = callTool(conn2, 'workspace.open', { path: repo });
  assert.strictEqual(reopened.result.isError, true);
  assert.strictEqual(reopened.result.content[0].text, mcp.WRITE_REFUSALS.MirrorUnrecoverable,
    'open speaks the same allowlisted sentence');
});

ok('M6 pendingIntent is stated on every read, true under an occupied slot, reads stay pure', () => {
  const repo = initRepo('m6-repo');
  const conn = service([repo], true).createConnection();
  const open = openWorkspace(conn, repo);
  const stateUri = open.resources.state;
  const readOnce = () => {
    const res = modern(conn, 'resources/read', { uri: stateUri });
    assert.strictEqual(res.error, undefined);
    return JSON.parse(res.result.contents[0].text);
  };
  assert.strictEqual(readOnce().pendingIntent, false, 'a settled store says so');
  craftedSlot(repo, 'after-state');
  const before = storeSnapshot(repo);
  assert.strictEqual(readOnce().pendingIntent, true, 'an occupied slot is stated, never hidden');
  assert.deepStrictEqual(storeSnapshot(repo), before, 'the read repaired nothing');
  assert.ok(!('pendingIntent' in readState(repo)), 'disk bytes never gain the flag');
});

// ---------------------------------------------------------------------------
// 4b.2: the transitions ride the same slot.
// ---------------------------------------------------------------------------

ok('T1 a CLI resolve moves state and mirror in one op; the exact repeat is a no-op; a conflicting repeat refuses', () => {
  const repo = fixture('t1');
  initStore(repo);
  const added = settled(() => artifacts.addDefect(repo, { severity: 'high', summary: 'transition me' }));
  settled(() => artifacts.transitionDefect(repo, added.state.id, 'resolved', { evidence: 'the fix shipped', note: 'resolved: the fix shipped' }));
  const disk = readState(repo);
  const defect = disk.defects[0];
  assert.strictEqual(defect.status, 'resolved');
  const mirror = readLedger(repo).defects.find((d) => d.id === defect.ledgerId);
  assert.strictEqual(mirror.status, 'resolved', 'the mirror followed in the same operation');
  assert.ok(!fs.existsSync(state.intentPath(repo)));
  const before = storeSnapshot(repo);
  const repeat = settled(() => artifacts.transitionDefect(repo, added.state.id, 'resolved', { evidence: 'the fix shipped', note: 'resolved: the fix shipped' }));
  assert.strictEqual(repeat.status, 'resolved');
  assert.deepStrictEqual(storeSnapshot(repo), before,
    'the exact repeat pushes no log, no history, no revision, no intent');
  assert.throws(
    () => artifacts.transitionDefect(repo, added.state.id, 'resolved', { evidence: 'a different story' }),
    /different recorded proof/,
    'a conflicting repeat never silently replaces the original proof'
  );
  assert.deepStrictEqual(storeSnapshot(repo), before, 'the conflicting refusal moved zero bytes');
});

ok('T2 the CLI-only waive rides the WAL too; wire and internal rosters stay distinct', () => {
  const repo = fixture('t2');
  initStore(repo);
  const added = settled(() => artifacts.addDefect(repo, { severity: 'medium', summary: 'waive me' }));
  settled(() => artifacts.transitionDefect(repo, added.state.id, 'waived', { owner: 'danny', reason: 'ships anyway', note: 'waived by danny: ships anyway' }));
  const defect = readState(repo).defects[0];
  assert.strictEqual(defect.status, 'waived');
  assert.strictEqual(defect.waivedBy, 'danny');
  const mirror = readLedger(repo).defects.find((d) => d.id === defect.ledgerId);
  assert.strictEqual(mirror.status, 'waived', 'the internal waiver keeps the mirror truthful');
  assert.ok(!fs.existsSync(state.intentPath(repo)));
});

ok('T3 a legacy defect is admitted by its first committed transition, mirror born in the new status', () => {
  const repo = fixture('t3');
  initStore(repo);
  state.withWorkspaceMutation(repo, { action: 'seed legacy' }, (s) => {
    s.defects.push({ id: 'def-old', at: 'old', severity: 'high', summary: 'ancient finding', status: 'open', artifact: '', attachedBy: 'none' });
  });
  settled(() => artifacts.transitionDefect(repo, 'def-old', 'resolved', { evidence: 'finally fixed' }));
  const defect = readState(repo).defects.find((d) => d.id === 'def-old');
  assert.ok(defect.ledgerId, 'admission minted and back-linked the mirror');
  const mirror = readLedger(repo).defects.find((d) => d.id === defect.ledgerId);
  assert.strictEqual(mirror.status, 'resolved');
  assert.strictEqual(mirror.summary, 'ancient finding');
});

ok('T4 death between a transition and its mirror recovers to the exact recorded bytes', () => {
  const repo = fixture('t4');
  initStore(repo);
  const added = settled(() => artifacts.addDefect(repo, { severity: 'high', summary: 'crash matrix finding' }));
  const res = crashChild(repo, 'ledger', 'resolve', added.state.id);
  assert.strictEqual(res.status, 87, res.stderr);
  const intent = readIntent(repo);
  assert.strictEqual(intent.tool, 'defect resolve');
  assert.strictEqual(hashOf(state.statePath(repo)), intent.stateAfterHash, 'the transition landed');
  triggerRecovery(repo);
  assert.strictEqual(hashOf(state.ledgerPath(repo)), intent.ledgerAfterHash, 'the mirror converged byte-exactly');
  const defect = readState(repo).defects[0];
  assert.strictEqual(defect.status, 'resolved');
  assert.strictEqual(readLedger(repo).defects.find((d) => d.id === defect.ledgerId).status, 'resolved');
});

ok('T5 the wire transitions mean the CLI meaning; replay answers the retry; supersede reason is one optional', () => {
  const repo = initRepo('t5-repo');
  const conn = service([repo], true).createConnection();
  const open = openWorkspace(conn, repo);
  const rev = () => readState(repo).rev;
  const added = payload(callTool(conn, 'defect.add',
    envelopeFor(open, { item: { severity: 'high', summary: 'wire lifecycle' } })));
  const resolveEnvelope = envelopeFor({ ...open, stateRev: rev() }, { id: added.defectId, evidence: 'proven fixed' });
  const resolved = payload(callTool(conn, 'defect.resolve', resolveEnvelope));
  assert.deepStrictEqual(resolved, {
    ok: true, committed: true, stateRev: resolveEnvelope.expectedStateRev + 1, replayed: false,
    defectId: added.defectId, status: 'resolved', ledgerId: added.ledgerId,
  });
  assert.strictEqual(readLedger(repo).defects.find((d) => d.id === added.ledgerId).status, 'resolved');
  const retry = payload(callTool(conn, 'defect.resolve', resolveEnvelope));
  assert.deepStrictEqual(retry, { ...resolved, replayed: true }, 'the verbatim retry is the receipt');
  // The exact repeat under a FRESH operation id is the no-op, not a refusal.
  const again = payload(callTool(conn, 'defect.resolve',
    envelopeFor({ ...open, stateRev: rev() }, { id: added.defectId, evidence: 'proven fixed' })));
  assert.strictEqual(again.committed, false, 'an exact repeat with a new id no-ops');
  const reopened = payload(callTool(conn, 'defect.reopen',
    envelopeFor({ ...open, stateRev: rev() }, { id: added.defectId, reason: 'regressed on windows' })));
  assert.strictEqual(reopened.status, 'reopened');
  const superseded = payload(callTool(conn, 'defect.supersede',
    envelopeFor({ ...open, stateRev: rev() }, { id: added.defectId, by: 'art-replacement' })));
  assert.strictEqual(superseded.status, 'superseded');
  assert.strictEqual(readState(repo).defects[0].supersededBy, 'art-replacement');
  assert.strictEqual(readLedger(repo).defects.find((d) => d.id === added.ledgerId).status, 'superseded',
    'every wire transition kept the mirror truthful');
});

// ---------------------------------------------------------------------------
// 4b.3: falsifiers from the independent review round (Codex, 2026-08-01).
// Each one was seen RED against main @ b029c81 before its fix landed.
// ---------------------------------------------------------------------------

ok('W1 a slot whose bytes are not UTF-8 refuses instead of parsing a lossy normalization', () => {
  const repo = fixture('w1');
  craftedSlot(repo);
  const slotFile = state.intentPath(repo);
  const bytes = Buffer.from(bytesOf(slotFile));
  const at = bytes.indexOf(Buffer.from('wal-crafted-operation', 'utf8'));
  assert.ok(at > 0, 'the crafted operationId is in the slot');
  bytes[at + 4] = 0xff; // one invalid byte inside a JSON string
  fs.writeFileSync(slotFile, bytes);
  const before = storeSnapshot(repo);
  assert.throws(() => triggerRecovery(repo), (e) => Boolean(e) && e.code === 'ERATCHETMIRROR',
    'invalid bytes are ambiguous — a U+FFFD substitute is a different operationId, not this one');
  assert.deepStrictEqual(storeSnapshot(repo), before, 'the refusal preserved every byte');
});

ok('W2 recovery refuses a post-state slot whose tool contradicts the receipt it names', () => {
  const repo = initRepo('w2');
  const conn = service([repo], true).createConnection();
  const open = openWorkspace(conn, repo);
  const origRename = fs.renameSync;
  fs.renameSync = (a, b) => {
    if (path.basename(String(b)) === 'ledger.json') {
      const e = new Error('injected mirror failure');
      e.code = 'EIO';
      throw e;
    }
    return origRename(a, b);
  };
  let failed;
  try {
    failed = refusal(callTool(conn, 'defect.add', envelopeFor(open, { item: { severity: 'high', summary: 'tool binding' } })));
  } finally {
    fs.renameSync = origRename;
  }
  assert.strictEqual(failed.error, 'WriteFailed');
  const slot = readIntent(repo);
  assert.strictEqual(slot.tool, 'defect.add');
  slot.tool = 'defect.resolve'; // a known tool — just not the one this receipt earned
  fs.writeFileSync(state.intentPath(repo), wal.serializeRecord(slot));
  const before = storeSnapshot(repo);
  assert.throws(() => triggerRecovery(repo), (e) => Boolean(e) && e.code === 'ERATCHETMIRROR',
    'an after-image receipt must carry the tool the intent names');
  assert.deepStrictEqual(storeSnapshot(repo), before, 'nothing moved under the contradiction');
});

ok('W3 an exact repeat over a stale mirror commits once and trues status, severity, and summary', () => {
  const repo = fixture('w3');
  initStore(repo);
  const added = settled(() => artifacts.addDefect(repo, { severity: 'high', summary: 'truth drifts' }));
  settled(() => artifacts.transitionDefect(repo, added.state.id, 'resolved', { evidence: 'fixed', note: 'resolved: fixed' }));
  const ledgerId = readState(repo).defects[0].ledgerId;
  const settledState = readState(repo);
  const audit = {
    history: settledState.history.length,
    log: settledState.defects[0].log.length,
    resolvedAt: settledState.defects[0].resolvedAt,
  };
  const ledger = readLedger(repo);
  const row = ledger.defects.find((d) => d.id === ledgerId);
  row.status = 'open';
  row.severity = 'low';
  row.summary = 'STALE SUMMARY';
  fs.writeFileSync(state.ledgerPath(repo), wal.serializeRecord(ledger));
  const repeat = settled(() => artifacts.transitionDefect(repo, added.state.id, 'resolved', { evidence: 'fixed', note: 'resolved: fixed' }));
  assert.strictEqual(repeat.status, 'resolved');
  const truedState = readState(repo);
  assert.deepStrictEqual(
    { history: truedState.history.length, log: truedState.defects[0].log.length, resolvedAt: truedState.defects[0].resolvedAt },
    audit,
    'the truing commit moved ONLY the mirror — no duplicate audit line, no restamped proof');
  const trued = readLedger(repo).defects.find((d) => d.id === ledgerId);
  assert.deepStrictEqual(
    { status: trued.status, severity: trued.severity, summary: trued.summary },
    { status: 'resolved', severity: 'high', summary: 'truth drifts' },
    'the one committed repeat trues every axis the spec projection names');
  const settledBytes = storeSnapshot(repo);
  settled(() => artifacts.transitionDefect(repo, added.state.id, 'resolved', { evidence: 'fixed', note: 'resolved: fixed' }));
  assert.deepStrictEqual(storeSnapshot(repo), settledBytes, 'once truthful, the repeat is a no-op again');
});

ok('W4 doctor observes a pending slot without recovering it', () => {
  const repo = fixture('w4');
  craftedSlot(repo, 'after-state'); // recoverable: the mirror is owed
  const before = storeSnapshot(repo);
  const run = childProcess.spawnSync(process.execPath, [path.join(__dirname, '..', 'bin', 'ratchet'), 'doctor'],
    { cwd: repo, encoding: 'utf8', env: cleanGitEnv(), windowsHide: true });
  assert.match(String(run.stdout), /pending/i, 'doctor names the slot it sees');
  assert.deepStrictEqual(storeSnapshot(repo), before, 'diagnosis moved zero bytes — doctor never recovers');
});

ok('W4b a slot landing after the diagnosis sample still survives doctor', () => {
  const repo = initRepo('w4b');
  const cli = require('../src/cli');
  const realDiagnose = state.diagnoseIntent;
  const realWrite = process.stdout.write;
  const realExit = process.exitCode;
  const realCwd = process.cwd();
  let planted = null;
  try {
    state.diagnoseIntent = function raced(cwd) {
      const res = realDiagnose.call(state, cwd);
      planted = craftedSlot(repo, 'after-state'); // the slot lands right after the sample
      return res;
    };
    process.chdir(repo);
    process.stdout.write = () => true; // doctor's report is not under test; its writes are
    cli.run(['node', 'ratchet', 'doctor', '--json']);
  } finally {
    process.stdout.write = realWrite;
    process.chdir(realCwd);
    state.diagnoseIntent = realDiagnose;
    process.exitCode = realExit;
  }
  assert.ok(fs.existsSync(state.intentPath(repo)), 'the late slot is not consumed by the probe');
  assert.strictEqual(hashOf(state.ledgerPath(repo)), planted.intent.ledgerBeforeHash,
    'the owed mirror is still owed — doctor recovered nothing');
});

ok('W4c doctor never travels the write door — a missing store is probed, not initialized', () => {
  const repo = initRepo('w4c'); // no initStore: the store directory does not exist
  const cli = require('../src/cli');
  const realInit = state.initProject;
  const realWrite = process.stdout.write;
  const realExit = process.exitCode;
  const realCwd = process.cwd();
  let entered = 0;
  let captured = '';
  try {
    state.initProject = function counted(...a) {
      entered++;
      return realInit.apply(state, a);
    };
    process.chdir(repo);
    process.stdout.write = (s) => {
      captured += String(s);
      return true;
    };
    cli.run(['node', 'ratchet', 'doctor', '--json']);
  } finally {
    process.stdout.write = realWrite;
    process.chdir(realCwd);
    state.initProject = realInit;
    process.exitCode = realExit;
  }
  const writable = JSON.parse(captured).checks.find((c) => c.name === 'state dir writable');
  assert.strictEqual(entered, 0,
    'the probe must never enter initProject — its lock would recover whatever store just appeared');
  assert.strictEqual(writable.ok, true, 'the writability answer is still a real answer');
  assert.ok(!fs.existsSync(state.projectDir(repo)), 'diagnosis created no store');
});

ok('W8 a mirrored write over a state record with invalid UTF-8 refuses and moves nothing', () => {
  const repo = fixture('w8');
  initStore(repo);
  settled(() => artifacts.addDefect(repo, { severity: 'high', summary: 'utf8 sentinel state' }));
  const stateFile = state.statePath(repo);
  const bytes = Buffer.from(bytesOf(stateFile));
  const at = bytes.indexOf(Buffer.from('utf8 sentinel state', 'utf8'));
  assert.ok(at > 0);
  bytes[at + 2] = 0xff; // one invalid byte inside the recorded summary
  fs.writeFileSync(stateFile, bytes);
  const before = storeSnapshot(repo);
  assert.throws(
    () => artifacts.addDefect(repo, { severity: 'low', summary: 'a different lawful finding' }),
    (e) => Boolean(e) && e.code === 'ERATCHETMIRROR',
    'a strict read never normalizes canonical bytes into a record nobody wrote');
  assert.deepStrictEqual(storeSnapshot(repo), before, 'the refusal moved zero bytes');
});

ok('W9 a mirrored write over a ledger record with invalid UTF-8 refuses and moves nothing', () => {
  const repo = fixture('w9');
  initStore(repo);
  settled(() => artifacts.addDefect(repo, { severity: 'high', summary: 'utf8 sentinel ledger' }));
  const ledgerFile = state.ledgerPath(repo);
  const bytes = Buffer.from(bytesOf(ledgerFile));
  const at = bytes.indexOf(Buffer.from('utf8 sentinel ledger', 'utf8'));
  assert.ok(at > 0);
  bytes[at + 2] = 0xff;
  fs.writeFileSync(ledgerFile, bytes);
  const before = storeSnapshot(repo);
  assert.throws(
    () => artifacts.addDefect(repo, { severity: 'low', summary: 'a different lawful finding' }),
    (e) => Boolean(e) && e.code === 'ERATCHETMIRROR',
    'the mirror side is held to the same strict decode as the state side');
  assert.deepStrictEqual(storeSnapshot(repo), before, 'the refusal moved zero bytes');
});

ok('W7 a peeked record with invalid UTF-8 refuses instead of serving a normalized projection', () => {
  const repo = initRepo('w7');
  const conn = service([repo], true).createConnection();
  const open = openWorkspace(conn, repo);
  const stateFile = state.statePath(repo);
  const bytes = Buffer.from(bytesOf(stateFile));
  const at = bytes.indexOf(Buffer.from('objective', 'utf8'));
  assert.ok(at > 0, 'the state record carries an objective field');
  bytes[at + 3] = 0xff; // one invalid byte inside a JSON string
  fs.writeFileSync(stateFile, bytes);
  const res = modern(conn, 'resources/read', { uri: open.resources.state });
  assert.ok(res.error, 'an unprovable record is a refusal, not a lossy U+FFFD projection');
  assert.strictEqual(res.error.message, mcp.WRITE_REFUSALS.MirrorUnrecoverable,
    'the refusal speaks the allowlisted sentence, never a store path');
  assert.ok(bytes.equals(bytesOf(stateFile)), 'the read changed nothing');
});

ok('W5 a resource read over an unreadable ledger refuses conservatively and writes nothing', () => {
  const repo = initRepo('w5');
  const conn = service([repo], true).createConnection();
  const open = openWorkspace(conn, repo);
  craftedSlot(repo); // occupy the slot so the store is mid-story
  fs.writeFileSync(state.ledgerPath(repo), '{ this is not a record');
  const files = () => fs.readdirSync(state.projectDir(repo)).filter((n) => n !== '.lock' && !n.includes('.tmp-')).sort();
  const filesBefore = files();
  const ledgerBytes = bytesOf(state.ledgerPath(repo));
  const res = modern(conn, 'resources/read', { uri: open.resources.ledger });
  assert.ok(res.error, 'an unprovable ledger is a refusal, not a fresh projection');
  assert.strictEqual(res.error.message, mcp.WRITE_REFUSALS.MirrorUnrecoverable,
    'the refusal speaks the allowlisted sentence, never a store path');
  assert.deepStrictEqual(files(), filesBefore, 'the read created no backup, no fresh record, no residue');
  assert.ok(ledgerBytes.equals(bytesOf(state.ledgerPath(repo))), 'the unreadable bytes are untouched');
});

ok('W6 clear verifies the slot it deletes is the slot it proved', () => {
  const repo = fixture('w6');
  craftedSlot(repo); // before/before: recovery would discard, then clear
  const slotFile = state.intentPath(repo);
  const substitute = Object.assign(readIntent(repo), { operationId: 'wal-substituted-operation' });
  const origRead = fs.readFileSync;
  let swapped = false;
  fs.readFileSync = function (file, ...rest) {
    const out = origRead.call(fs, file, ...rest);
    if (!swapped && String(file) === slotFile) {
      swapped = true; // swap AFTER recovery has read and proven the original
      fs.writeFileSync(slotFile, wal.serializeRecord(substitute));
    }
    return out;
  };
  try {
    assert.throws(() => triggerRecovery(repo), (e) => Boolean(e) && e.code === 'ERATCHETMIRROR',
      'deleting bytes that no longer match the proven slot is ambiguous, not a clear');
  } finally {
    fs.readFileSync = origRead;
  }
  assert.strictEqual(readIntent(repo).operationId, 'wal-substituted-operation',
    'the substituted slot survived the refused clear');
});

// ---------------------------------------------------------------------------

process.stdout.write(`\n${passed} passed, ${failures.length} failed\n`);
if (failures.length) {
  process.exitCode = 1;
}
