'use strict';

// Torque MCP step 4c.1: ledger.update — the second single-file safe core.
// Run: node test/mcp-ledger.test.js
//
// What this suite exists to prove, in the spec's words: a ledger write names
// the exact store lineage it decided against or it is refused, not merged;
// and a retried write can never apply twice, never claim an outcome it does
// not have, and survives a server restart. The five crash-boundary replay
// tests, re-run against the LEDGER line: L3 (lost response), L15 (process
// death before the commit rename — a real child process dies at the rename),
// L16 (reconnect replay across a server replacement), L4 (binding conflict),
// L9/L10 (eviction, reset, different-gen recreation). Every refusal is also a
// zero-byte proof: the store's bytes are snapshotted around it.
//
// Traced by: claude-fable-5

const assert = require('assert');
const childProcess = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.realpathSync.native(
  fs.mkdtempSync(path.join(os.tmpdir(), 'ratchet-mcp-ledger-test-'))
);
process.env.RATCHET_DATA_DIR = path.join(tmp, 'state-store');
process.env.RATCHET_EVOLVE_LOG = path.join(tmp, 'evolve-log.jsonl');

const mcp = require('../src/mcp/server');
const ops = require('../src/mcp/ops');
const state = require('../src/state');
const schemas = require('../src/schemas');
const ledgerMod = require('../src/ledger');

const META = 'io.modelcontextprotocol/';
const MODERN = '2026-07-28';
const BIN = path.join(__dirname, '..', 'bin', 'ratchet-mcp');

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
    cwd,
    encoding: 'utf8',
    env: cleanGitEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
}

function initRepo(label) {
  const dir = fixture(label);
  git(dir, ['init', '--quiet']);
  return dir;
}

function service(roots, write) {
  return mcp.createServer({
    roots,
    write,
    serverInfo: { name: 'torque-mcp-test', version: '0.0.0' },
  });
}

function modernMeta() {
  return {
    [META + 'protocolVersion']: MODERN,
    [META + 'clientCapabilities']: {},
    [META + 'clientInfo']: { name: 'test-client', version: '0' },
  };
}

let requestId = 0;
function modern(conn, method, params) {
  return conn.handleMessage({
    jsonrpc: '2.0',
    id: ++requestId,
    method,
    params: { ...(params || {}), _meta: modernMeta() },
  });
}

function callTool(conn, name, arguments_) {
  return modern(conn, 'tools/call', { name, arguments: arguments_ });
}

function openWorkspace(conn, repo) {
  return payload(callTool(conn, 'workspace.open', { path: repo }));
}

function payload(response) {
  assert.strictEqual(response.error, undefined, response.error && response.error.message);
  assert.notStrictEqual(response.result.isError, true, JSON.stringify(response.result));
  const fromText = JSON.parse(response.result.content[0].text);
  assert.deepStrictEqual(response.result.structuredContent, fromText,
    'structured and compatibility text results must carry one answer');
  return response.result.structuredContent;
}

function refusal(response) {
  assert.strictEqual(response.error, undefined, response.error && response.error.message);
  assert.strictEqual(response.result.isError, true, JSON.stringify(response.result));
  const structured = response.result.structuredContent;
  assert.deepStrictEqual(JSON.parse(response.result.content[0].text), structured);
  assert.strictEqual(structured.ok, false);
  assert.strictEqual(structured.message, mcp.WRITE_REFUSALS[structured.error],
    'every refusal message comes from the one allowlisted table');
  return structured;
}

function boundaryRefusal(response) {
  assert.ok(response.error, `expected a protocol refusal: ${JSON.stringify(response.result)}`);
  assert.strictEqual(response.error.code, -32602);
  return response.error;
}

function opId(length) {
  const id = crypto.randomBytes(96).toString('base64url');
  return id.slice(0, length || 22);
}

function ledgerEnvelope(open, extra) {
  return Object.assign({
    workspaceHandle: open.workspaceHandle,
    expectedLedgerRev: open.ledgerRev,
    expectedLedgerGen: open.ledgerGen,
    operationId: opId(),
    collection: 'features',
  }, extra || {});
}

function storeSnapshot(repo) {
  const dir = state.projectDir(repo);
  const out = {};
  if (!fs.existsSync(dir)) return out;
  const walk = (d, rel) => {
    for (const name of fs.readdirSync(d)) {
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

function readLedger(repo) {
  return JSON.parse(fs.readFileSync(state.ledgerPath(repo), 'utf8'));
}

function ledgerBytes(repo) {
  return fs.readFileSync(state.ledgerPath(repo));
}

// A hand-crafted version-1 ledger in the store, byte-shaped like writeJson
// writes records. The store's state record is created first so the write does
// not race the directory into existence.
function plantV1Ledger(repo, over) {
  state.loadState(repo);
  const v1 = Object.assign({
    version: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    features: [],
    tests: [],
    defects: [],
  }, over || {});
  fs.writeFileSync(state.ledgerPath(repo), JSON.stringify(v1, null, 2) + '\n', 'utf8');
  return v1;
}

function plantLedgerBytes(repo, bytes) {
  state.loadState(repo);
  fs.writeFileSync(state.ledgerPath(repo), bytes);
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// ---------------------------------------------------------------------------
// Mechanism units: the ledger binding.
// ---------------------------------------------------------------------------

ok('U1 the ledger binding covers meaning, not transport, and moves with every input', () => {
  const base = ops.ledgerBindingHash('features', { name: 'x' }, 3, 'lgen-a', null);
  assert.match(base, /^sha256:[0-9a-f]{64}$/);
  assert.strictEqual(base, ops.ledgerBindingHash('features', { name: 'x' }, 3, 'lgen-a', null),
    'deterministic');
  for (const varied of [
    ops.ledgerBindingHash('tests', { name: 'x' }, 3, 'lgen-a', null),
    ops.ledgerBindingHash('features', { name: 'y' }, 3, 'lgen-a', null),
    ops.ledgerBindingHash('features', { name: 'x' }, 4, 'lgen-a', null),
    ops.ledgerBindingHash('features', { name: 'x' }, 3, 'lgen-b', null),
    ops.ledgerBindingHash('features', { name: 'x' }, null, null, 'sha256:00'),
  ]) {
    assert.notStrictEqual(base, varied);
  }
});

ok('U2 the strict matrix accepts exactly the two shapes and refuses hybrids', () => {
  const v2 = schemas.newLedger();
  assert.deepStrictEqual(schemas.validateLedgerRecord(v2), { ok: true, version: 2 });
  const v1 = {
    version: 1, createdAt: 't', updatedAt: 't', features: [], tests: [], defects: [],
  };
  assert.deepStrictEqual(schemas.validateLedgerRecord(v1), { ok: true, version: 1 });
  // A v1 record carrying ANY lineage field is a hybrid — admission must never
  // adopt fields it did not mint, a user-invented operations key included.
  for (const extra of [{ ledgerRev: 0 }, { ledgerGen: 'lgen-a-b' }, { operations: [] }]) {
    assert.strictEqual(schemas.validateLedgerRecord({ ...v1, ...extra }).ok, false, JSON.stringify(extra));
  }
  for (const broken of [
    { ...v2, ledgerRev: -1 },
    { ...v2, ledgerRev: 2 ** 53 },
    { ...v2, ledgerGen: 'gen-not-ledger-prefix' },
    { ...v2, ledgerGen: `lgen-a-${'0'.repeat(80)}` },
    { ...v2, operations: [{}] },
    { ...v2, version: 3 },
  ]) {
    assert.strictEqual(schemas.validateLedgerRecord(broken).ok, false);
  }
  // AT the ceiling is matrix-valid: only a mutating commit refuses.
  assert.strictEqual(schemas.validateLedgerRecord({ ...v2, ledgerRev: Number.MAX_SAFE_INTEGER }).ok, true);
});

// ---------------------------------------------------------------------------
// Discovery: the roster and the pinned descriptor.
// ---------------------------------------------------------------------------

ok('L1 ledger.update is tool #19 under --write, absent without it, descriptor pinned', () => {
  const repo = initRepo('l1-repo');
  const flagless = service([repo], false).createConnection();
  const readNames = modern(flagless, 'tools/list', {}).result.tools.map((t) => t.name);
  assert.deepStrictEqual(readNames, ['workspace.open', 'workspace.scan', 'score.confidence', 'score.friction']);

  const conn = service([repo], true).createConnection();
  const tools = modern(conn, 'tools/list', {}).result.tools;
  assert.strictEqual(tools.length, 19, 'the write roster is nineteen tools');
  assert.strictEqual(tools[18].name, 'ledger.update', 'appended in advertised order');
  const tool = tools[18];
  assert.deepStrictEqual(tool.annotations,
    { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false });
  assert.deepStrictEqual(tool.inputSchema.required,
    ['workspaceHandle', 'expectedLedgerRev', 'expectedLedgerGen', 'operationId', 'collection', 'item']);
  assert.ok(tool.inputSchema.properties.expectedLedgerHash, 'the admission hash is optional wire surface');
  assert.deepStrictEqual(tool.inputSchema.properties.expectedLedgerRev.type, ['integer', 'null']);
  assert.strictEqual(tool.inputSchema.properties.expectedLedgerRev.maximum, 9007199254740991);
  assert.deepStrictEqual(tool.inputSchema.properties.collection.enum, ['features'],
    '4c.1 ships the features canary; tests widens the enum in 4c.2');
  assert.strictEqual(tool.inputSchema.additionalProperties, false);
  const [success, error] = tool.outputSchema.oneOf;
  assert.deepStrictEqual(success.required,
    ['ok', 'committed', 'ledgerRev', 'replayed', 'collection', 'recordId', 'action']);
  assert.deepStrictEqual(success.properties.ledgerRev.type, ['integer', 'null']);
  assert.ok(!('stateRev' in success.properties), 'stateRev never appears on this tool');
  // All NINE reachable codes, enumerated so the schema cannot undercount.
  assert.deepStrictEqual(error.properties.error.enum, [
    'StaleLedgerRev', 'StaleLedgerGen', 'LedgerDamaged', 'LedgerRevisionExhausted',
    'ReceiptTooLarge', 'OperationIdConflict', 'DeterministicIdConflict',
    'MirrorUnrecoverable', 'WriteFailed',
  ]);
  assert.strictEqual(error.properties.expectedLedgerRev.type, 'integer', 'StaleLedgerRev fields are integer-only');
  assert.strictEqual(error.properties.actualLedgerRev.type, 'integer');
});

ok('L1b workspace.open projects the ledger lineage from the same locked read', () => {
  const repo = initRepo('l1b-repo');
  const conn = service([repo], true).createConnection();
  const open = openWorkspace(conn, repo);
  const disk = readLedger(repo);
  assert.strictEqual(disk.version, 2, 'a fresh store is born version 2');
  assert.strictEqual(open.ledgerRev, disk.ledgerRev);
  assert.strictEqual(open.ledgerGen, disk.ledgerGen);
  assert.ok(!('ledgerBytesHash' in open), 'the hash is omitted, never null, on version-2 stores');
});

// ---------------------------------------------------------------------------
// The committed path: one rename, revision + receipt together.
// ---------------------------------------------------------------------------

ok('L2 a committed write moves ledgerRev exactly once with its receipt in the same bytes', () => {
  const repo = initRepo('l2-repo');
  const conn = service([repo], true).createConnection();
  const open = openWorkspace(conn, repo);
  const envelope = ledgerEnvelope(open, { item: { name: 'checkout', area: 'commerce' } });
  const result = payload(callTool(conn, 'ledger.update', envelope));
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.committed, true);
  assert.strictEqual(result.ledgerRev, open.ledgerRev + 1);
  assert.strictEqual(result.replayed, false);
  assert.strictEqual(result.collection, 'features');
  assert.strictEqual(result.action, 'created');
  const disk = readLedger(repo);
  assert.strictEqual(disk.ledgerRev, open.ledgerRev + 1);
  assert.strictEqual(disk.ledgerGen, open.ledgerGen, 'a commit never moves the lineage');
  assert.strictEqual(disk.features.length, 1);
  assert.strictEqual(disk.features[0].id, result.recordId);
  // The deterministic id derives from the operation's meaning.
  const argsHash = ops.ledgerBindingHash('features', envelope.item, open.ledgerRev, open.ledgerGen, null);
  assert.strictEqual(result.recordId,
    ops.deriveId('feat', open.ledgerGen, 'ledger.update', argsHash, 'features'));
  // The receipt landed in the SAME bytes as the revision it certifies.
  assert.strictEqual(disk.operations.length, 1);
  const entry = disk.operations[0];
  assert.strictEqual(entry.id, envelope.operationId);
  assert.strictEqual(entry.tool, 'ledger.update');
  assert.strictEqual(entry.gen, disk.ledgerGen);
  assert.strictEqual(entry.rev, disk.ledgerRev);
  assert.match(entry.at, schemas.LEDGER_STAMP_PATTERN);
  assert.deepStrictEqual(entry.result, {
    ok: true, committed: true, replayed: false,
    ledgerRev: disk.ledgerRev, collection: 'features', recordId: result.recordId, action: 'created',
  });
  // The strict matrix accepts what the commit published.
  assert.deepStrictEqual(schemas.validateLedgerRecord(disk), { ok: true, version: 2 });
  // The STATE line did not move.
  const stateDisk = JSON.parse(fs.readFileSync(state.statePath(repo), 'utf8'));
  assert.strictEqual(stateDisk.rev, open.stateRev, 'this tool touches no state bytes');
  assert.ok(!(stateDisk.operations || []).length, 'and writes no state receipt');
});

// Crash-boundary test 1: lost response.
ok('L3 a verbatim retry returns the persisted receipt and moves nothing', () => {
  const repo = initRepo('l3-repo');
  const conn = service([repo], true).createConnection();
  const open = openWorkspace(conn, repo);
  const envelope = ledgerEnvelope(open, { item: { name: 'router' } });
  const first = payload(callTool(conn, 'ledger.update', envelope));
  const before = storeSnapshot(repo);
  const retry = payload(callTool(conn, 'ledger.update', envelope));
  assert.deepStrictEqual(retry, { ...first, replayed: true },
    'the retry is the recorded outcome, marked replayed');
  assert.deepStrictEqual(storeSnapshot(repo), before, 'a replay is a pure read');
  assert.strictEqual(readLedger(repo).operations[0].result.replayed, false,
    'the stored bytes keep replayed:false; decoration happens on a copy');
});

// Crash-boundary test 4: one id, two meanings.
ok('L4 the same operationId with a different binding refuses OperationIdConflict', () => {
  const repo = initRepo('l4-repo');
  const conn = service([repo], true).createConnection();
  const open = openWorkspace(conn, repo);
  const envelope = ledgerEnvelope(open, { item: { name: 'meaning one' } });
  payload(callTool(conn, 'ledger.update', envelope));
  const before = storeSnapshot(repo);
  for (const varied of [
    { ...envelope, item: { name: 'meaning two' } },
    { ...envelope, expectedLedgerRev: open.ledgerRev + 1 },
    { ...envelope, expectedLedgerGen: 'lgen-0-00' },
  ]) {
    const structured = refusal(callTool(conn, 'ledger.update', varied));
    assert.strictEqual(structured.error, 'OperationIdConflict', JSON.stringify(varied));
  }
  assert.deepStrictEqual(storeSnapshot(repo), before);
});

ok('L5 a moved ledger revision refuses StaleLedgerRev with integer fields and zero bytes', () => {
  const repo = initRepo('l5-repo');
  const conn = service([repo], true).createConnection();
  const open = openWorkspace(conn, repo);
  payload(callTool(conn, 'ledger.update', ledgerEnvelope(open, { item: { name: 'first' } })));
  const before = storeSnapshot(repo);
  const structured = refusal(callTool(conn, 'ledger.update',
    ledgerEnvelope(open, { item: { name: 'second' } })));
  assert.strictEqual(structured.error, 'StaleLedgerRev');
  assert.strictEqual(structured.expectedLedgerRev, open.ledgerRev);
  assert.strictEqual(structured.actualLedgerRev, open.ledgerRev + 1);
  assert.deepStrictEqual(storeSnapshot(repo), before);
});

ok('L6 a foreign or null-pair lineage claim refuses StaleLedgerGen before the revision check', () => {
  const repo = initRepo('l6-repo');
  const conn = service([repo], true).createConnection();
  const open = openWorkspace(conn, repo);
  const before = storeSnapshot(repo);
  // Wrong gen — even with a WRONG revision too, the gen wins.
  const wrongGen = refusal(callTool(conn, 'ledger.update', ledgerEnvelope(open, {
    expectedLedgerRev: open.ledgerRev + 7, expectedLedgerGen: 'lgen-0-00', item: { name: 'x' },
  })));
  assert.strictEqual(wrongGen.error, 'StaleLedgerGen');
  assert.strictEqual(wrongGen.actualLedgerGen, open.ledgerGen);
  // The null pair matches only a version-1 ledger.
  const nullPair = refusal(callTool(conn, 'ledger.update', ledgerEnvelope(open, {
    expectedLedgerRev: null, expectedLedgerGen: null,
    expectedLedgerHash: `sha256:${'0'.repeat(64)}`, item: { name: 'x' },
  })));
  assert.strictEqual(nullPair.error, 'StaleLedgerGen');
  assert.strictEqual(nullPair.actualLedgerGen, open.ledgerGen);
  assert.deepStrictEqual(storeSnapshot(repo), before);
});

// ---------------------------------------------------------------------------
// D4: hash-bound admission.
// ---------------------------------------------------------------------------

ok('L7 a version-1 ledger admits exactly once, in one rename, bound to its observed bytes', () => {
  const repo = initRepo('l7-repo');
  plantV1Ledger(repo);
  const conn = service([repo], true).createConnection();
  const open = openWorkspace(conn, repo);
  assert.strictEqual(open.ledgerRev, null, 'version 1 projects the explicit null pair');
  assert.strictEqual(open.ledgerGen, null);
  assert.match(open.ledgerBytesHash, /^sha256:[0-9a-f]{64}$/);

  const envelope = ledgerEnvelope(open, {
    expectedLedgerRev: null,
    expectedLedgerGen: null,
    expectedLedgerHash: open.ledgerBytesHash,
    item: { name: 'admitted-with-the-domain-change' },
  });
  const result = payload(callTool(conn, 'ledger.update', envelope));
  assert.strictEqual(result.committed, true);
  assert.strictEqual(result.ledgerRev, 1, 'the admitting commit is revision 1');
  const disk = readLedger(repo);
  assert.strictEqual(disk.version, 2);
  assert.ok(schemas.isLedgerGeneration(disk.ledgerGen), 'a fresh generation was minted');
  assert.strictEqual(disk.ledgerRev, 1);
  assert.strictEqual(disk.features.length, 1, 'the domain change rode the same rename');
  assert.strictEqual(disk.operations.length, 1, 'so did the receipt');
  // The deterministic id used the observed-bytes hash in place of the absent gen.
  const argsHash = ops.ledgerBindingHash('features', envelope.item, null, null, open.ledgerBytesHash);
  assert.strictEqual(result.recordId,
    ops.deriveId('feat', open.ledgerBytesHash, 'ledger.update', argsHash, 'features'));

  // The second admitter lost the race: actual gen is now non-null.
  const before = storeSnapshot(repo);
  const raced = refusal(callTool(conn, 'ledger.update', ledgerEnvelope(open, {
    expectedLedgerRev: null, expectedLedgerGen: null,
    expectedLedgerHash: open.ledgerBytesHash, item: { name: 'second admitter' },
  })));
  assert.strictEqual(raced.error, 'StaleLedgerGen');
  assert.strictEqual(raced.actualLedgerGen, disk.ledgerGen);
  assert.deepStrictEqual(storeSnapshot(repo), before);

  // A verbatim retry of the ADMISSION replays from the version-2 ring.
  const retry = payload(callTool(conn, 'ledger.update', envelope));
  assert.deepStrictEqual(retry, { ...result, replayed: true });
  assert.deepStrictEqual(storeSnapshot(repo), before);
});

ok('L7b an admission against different v1 bytes refuses on hash with the actual named', () => {
  const repo = initRepo('l7b-repo');
  plantV1Ledger(repo, { features: [{ id: 'feat-old', name: 'a different v1 world' }] });
  const conn = service([repo], true).createConnection();
  const open = openWorkspace(conn, repo);
  const before = storeSnapshot(repo);
  const structured = refusal(callTool(conn, 'ledger.update', ledgerEnvelope(open, {
    expectedLedgerRev: null, expectedLedgerGen: null,
    expectedLedgerHash: `sha256:${'a'.repeat(64)}`, item: { name: 'x' },
  })));
  assert.strictEqual(structured.error, 'StaleLedgerGen');
  assert.strictEqual(structured.actualLedgerGen, null);
  assert.strictEqual(structured.actualLedgerHash, open.ledgerBytesHash,
    'the actual bytes hash lets the client re-read and re-decide');
  assert.deepStrictEqual(storeSnapshot(repo), before);
  assert.strictEqual(readLedger(repo).version, 1, 'no admission happened');
});

ok('L7c a non-null pair against a version-1 ledger refuses with the null actual and the hash', () => {
  const repo = initRepo('l7c-repo');
  plantV1Ledger(repo);
  const conn = service([repo], true).createConnection();
  const open = openWorkspace(conn, repo);
  const before = storeSnapshot(repo);
  const structured = refusal(callTool(conn, 'ledger.update', ledgerEnvelope(open, {
    expectedLedgerRev: 3, expectedLedgerGen: 'lgen-0-00', item: { name: 'x' },
  })));
  assert.strictEqual(structured.error, 'StaleLedgerGen');
  assert.strictEqual(structured.actualLedgerGen, null);
  assert.strictEqual(structured.actualLedgerHash, open.ledgerBytesHash);
  assert.deepStrictEqual(storeSnapshot(repo), before);
});

// ---------------------------------------------------------------------------
// No-ops.
// ---------------------------------------------------------------------------

ok('L8 an identical merge is a no-op: no revision, no receipt, no restamp, zero bytes', () => {
  const repo = initRepo('l8-repo');
  const conn = service([repo], true).createConnection();
  let open = openWorkspace(conn, repo);
  const created = payload(callTool(conn, 'ledger.update',
    ledgerEnvelope(open, { item: { id: 'feat-stable', name: 'stable', status: 'covered' } })));
  assert.strictEqual(created.action, 'created');
  open = openWorkspace(conn, repo);
  const before = storeSnapshot(repo);
  const noop = payload(callTool(conn, 'ledger.update',
    ledgerEnvelope(open, { item: { id: 'feat-stable', name: 'stable', status: 'covered' } })));
  assert.strictEqual(noop.committed, false);
  assert.strictEqual(noop.ledgerRev, open.ledgerRev, 'the current revision is reported, not null');
  assert.strictEqual(noop.action, 'updated');
  assert.deepStrictEqual(storeSnapshot(repo), before, 'a no-op moves nothing');
  // Lost no-op response, unchanged ledger: the retry repeats the no-op.
  const again = payload(callTool(conn, 'ledger.update',
    ledgerEnvelope(open, { item: { id: 'feat-stable', name: 'stable', status: 'covered' } })));
  assert.strictEqual(again.committed, false);
  assert.deepStrictEqual(storeSnapshot(repo), before);
});

ok('L8b a no-op against a version-1 ledger reports ledgerRev null and admits nothing', () => {
  const repo = initRepo('l8b-repo');
  plantV1Ledger(repo, { features: [{ id: 'feat-v1', name: 'already-there' }] });
  const conn = service([repo], true).createConnection();
  const open = openWorkspace(conn, repo);
  const before = storeSnapshot(repo);
  const noop = payload(callTool(conn, 'ledger.update', ledgerEnvelope(open, {
    expectedLedgerRev: null, expectedLedgerGen: null, expectedLedgerHash: open.ledgerBytesHash,
    item: { id: 'feat-v1', name: 'already-there' },
  })));
  assert.strictEqual(noop.committed, false);
  assert.strictEqual(noop.ledgerRev, null, 'a no-op admits nothing — there is no revision to report');
  assert.deepStrictEqual(storeSnapshot(repo), before);
  assert.strictEqual(readLedger(repo).version, 1, 'still version 1');
});

// ---------------------------------------------------------------------------
// Crash-boundary test 5: eviction, reset, recreation.
// ---------------------------------------------------------------------------

ok('L9 an evicted ledger receipt cannot replay — the stale refusal answers instead', () => {
  const repo = initRepo('l9-repo');
  const conn = service([repo], true).createConnection();
  const open = openWorkspace(conn, repo);
  const firstEnvelope = ledgerEnvelope(open, { item: { id: 'feat-a', name: 'v0' } });
  payload(callTool(conn, 'ledger.update', firstEnvelope));
  for (let i = 1; i <= schemas.LEDGER_OPERATIONS_CAP; i++) {
    payload(callTool(conn, 'ledger.update', ledgerEnvelope(
      { ...open, ledgerRev: open.ledgerRev + i },
      { item: { id: 'feat-a', name: `v${i}` } }
    )));
  }
  const disk = readLedger(repo);
  assert.strictEqual(disk.operations.length, schemas.LEDGER_OPERATIONS_CAP, 'the ring is bounded');
  assert.ok(!disk.operations.some((e) => e.id === firstEnvelope.operationId),
    'the first receipt was evicted');
  const before = storeSnapshot(repo);
  const structured = refusal(callTool(conn, 'ledger.update', firstEnvelope));
  assert.strictEqual(structured.error, 'StaleLedgerRev',
    'a verbatim retry of an evicted operation refuses; it never re-applies');
  assert.deepStrictEqual(storeSnapshot(repo), before);
});

ok('L10 a wipe mints a new lineage: pre-wipe envelopes refuse StaleLedgerGen forever', () => {
  const repo = initRepo('l10-repo');
  const conn = service([repo], true).createConnection();
  const open = openWorkspace(conn, repo);
  const envelope = ledgerEnvelope(open, { item: { name: 'pre-wipe' } });
  payload(callTool(conn, 'ledger.update', envelope));
  state.initProject(repo, { force: true, resetBy: 'test', resetReason: 'wipe' });
  const wiped = readLedger(repo);
  assert.strictEqual(wiped.ledgerRev, 0, 'a wipe is a lineage REPLACEMENT: new gen, rev 0');
  assert.notStrictEqual(wiped.ledgerGen, open.ledgerGen);
  assert.deepStrictEqual(wiped.operations, [], 'the ring dies with the lineage');
  const structured = refusal(callTool(conn, 'ledger.update', envelope));
  assert.strictEqual(structured.error, 'StaleLedgerGen',
    'the old expectation names a lineage that no longer exists');
});

// ---------------------------------------------------------------------------
// The boundary: the exhaustive envelope rule.
// ---------------------------------------------------------------------------

ok('L11 malformed ledger envelopes refuse -32602 at the boundary with zero bytes', () => {
  const repo = initRepo('l11-repo');
  const conn = service([repo], true).createConnection();
  const open = openWorkspace(conn, repo);
  const before = storeSnapshot(repo);
  const hash = `sha256:${'0'.repeat(64)}`;
  for (const args of [
    // Mixed pairs.
    ledgerEnvelope(open, { expectedLedgerRev: null, item: { name: 'x' } }),
    ledgerEnvelope(open, { expectedLedgerGen: null, item: { name: 'x' } }),
    // Null pair without the hash; non-null pair carrying one.
    ledgerEnvelope(open, { expectedLedgerRev: null, expectedLedgerGen: null, item: { name: 'x' } }),
    ledgerEnvelope(open, { expectedLedgerHash: hash, item: { name: 'x' } }),
    // A malformed hash on an admission spelling.
    ledgerEnvelope(open, { expectedLedgerRev: null, expectedLedgerGen: null, expectedLedgerHash: 'sha256:xyz', item: { name: 'x' } }),
    // Collections outside the canary — including the permanently excluded one.
    ledgerEnvelope(open, { collection: 'tests', item: { name: 'x' } }),
    ledgerEnvelope(open, { collection: 'defects', item: { name: 'x' } }),
    // item.id must be a non-empty string.
    ledgerEnvelope(open, { item: { id: 7, name: 'x' } }),
    ledgerEnvelope(open, { item: { id: '', name: 'x' } }),
    // The 16 KiB canonical item cap.
    ledgerEnvelope(open, { item: { name: 'x'.repeat(17000) } }),
    // Unsafe / negative revisions.
    ledgerEnvelope(open, { expectedLedgerRev: 2 ** 53, item: { name: 'x' } }),
    ledgerEnvelope(open, { expectedLedgerRev: -1, item: { name: 'x' } }),
    // Unknown and missing keys.
    ledgerEnvelope(open, { item: { name: 'x' }, extra: true }),
    (() => { const a = ledgerEnvelope(open, { item: { name: 'x' } }); delete a.collection; return a; })(),
  ]) {
    boundaryRefusal(callTool(conn, 'ledger.update', args));
  }
  assert.deepStrictEqual(storeSnapshot(repo), before, 'boundary refusals move zero bytes');
});

// ---------------------------------------------------------------------------
// Strict load: the damaged-ledger matrix on the write door and the open.
// ---------------------------------------------------------------------------

ok('L12 damaged ledger bytes refuse LedgerDamaged on the write door: no repair, no backup', () => {
  const damagedFixtures = [
    ['malformed JSON', Buffer.from('{not json', 'utf8')],
    ['invalid UTF-8', Buffer.concat([Buffer.from('{"version":1', 'utf8'), Buffer.from([0xff]), Buffer.from('}', 'utf8')])],
    ['empty file', Buffer.alloc(0)],
    ['wrong shape', Buffer.from(JSON.stringify({ version: 1, createdAt: 't' }) + '\n', 'utf8')],
    ['hybrid v1 with lineage', Buffer.from(JSON.stringify({
      version: 1, createdAt: 't', updatedAt: 't', features: [], tests: [], defects: [], ledgerRev: 3,
    }, null, 2) + '\n', 'utf8')],
    ['oversized stored gen', Buffer.from(JSON.stringify({
      ...JSON.parse(JSON.stringify(schemas.newLedger())), ledgerGen: `lgen-a-${'0'.repeat(90)}`,
    }, null, 2) + '\n', 'utf8')],
  ];
  for (const [name, bytes] of damagedFixtures) {
    const repo = initRepo(`l12-${fixtureNumber}`);
    // Open FIRST (healthy), so a handle exists; then damage out-of-band.
    const conn = service([repo], true).createConnection();
    const open = openWorkspace(conn, repo);
    plantLedgerBytes(repo, bytes);
    const before = storeSnapshot(repo);
    const structured = refusal(callTool(conn, 'ledger.update', ledgerEnvelope(open, { item: { name: 'x' } })));
    assert.strictEqual(structured.error, 'LedgerDamaged', name);
    assert.deepStrictEqual(storeSnapshot(repo), before, `${name}: zero bytes, no backup, no fresh ledger`);
  }
  // Absence behind a live handle is out-of-band destruction, not a fresh repo.
  const repo = initRepo('l12-absent');
  const conn = service([repo], true).createConnection();
  const open = openWorkspace(conn, repo);
  fs.rmSync(state.ledgerPath(repo));
  const structured = refusal(callTool(conn, 'ledger.update', ledgerEnvelope(open, { item: { name: 'x' } })));
  assert.strictEqual(structured.error, 'LedgerDamaged');
  assert.ok(!fs.existsSync(state.ledgerPath(repo)), 'the refusal created nothing');
});

ok('L12b the open boundary refuses unhealthy existing bytes: no handle, no backup, byte-identical store', () => {
  const repo = initRepo('l12b-repo');
  plantLedgerBytes(repo, Buffer.from('{"version":1,broken', 'utf8'));
  const before = storeSnapshot(repo);
  const conn = service([repo], true).createConnection();
  const response = callTool(conn, 'workspace.open', { path: repo });
  assert.strictEqual(response.result.isError, true, 'the open refuses');
  assert.strictEqual(response.result.content[0].text, mcp.WRITE_REFUSALS.LedgerDamaged,
    'through open\'s existing tool-error shape, with the one allowlisted sentence');
  assert.deepStrictEqual(storeSnapshot(repo), before,
    'no .corrupt backup, no fresh ledger, no state initialization leaked past the probe');
});

ok('L12c genuine absence creates version-2 bytes create-exclusive at the open', () => {
  const repo = initRepo('l12c-repo');
  const conn = service([repo], true).createConnection();
  const open = openWorkspace(conn, repo);
  const disk = readLedger(repo);
  assert.strictEqual(disk.version, 2);
  assert.strictEqual(open.ledgerRev, 0);
  assert.strictEqual(open.ledgerGen, disk.ledgerGen);
});

// ---------------------------------------------------------------------------
// The ceiling.
// ---------------------------------------------------------------------------

ok('L13 MAX-1 → MAX commits one after-image; mutation at MAX refuses LedgerRevisionExhausted', () => {
  const repo = initRepo('l13-repo');
  const conn = service([repo], true).createConnection();
  openWorkspace(conn, repo);
  // Drive the stored revision to MAX-1 out-of-band (9e15 real commits away).
  const nearCeiling = readLedger(repo);
  nearCeiling.ledgerRev = Number.MAX_SAFE_INTEGER - 1;
  plantLedgerBytes(repo, Buffer.from(JSON.stringify(nearCeiling, null, 2) + '\n', 'utf8'));
  const open = openWorkspace(conn, repo);
  assert.strictEqual(open.ledgerRev, Number.MAX_SAFE_INTEGER - 1, 'the record is read-servable');
  const committed = payload(callTool(conn, 'ledger.update', ledgerEnvelope(open, { item: { name: 'the last commit' } })));
  assert.strictEqual(committed.ledgerRev, Number.MAX_SAFE_INTEGER, 'reaching the ceiling is a success');

  const atMax = openWorkspace(conn, repo);
  assert.strictEqual(atMax.ledgerRev, Number.MAX_SAFE_INTEGER);
  const before = storeSnapshot(repo);
  const structured = refusal(callTool(conn, 'ledger.update', ledgerEnvelope(atMax, { item: { name: 'one too many' } })));
  assert.strictEqual(structured.error, 'LedgerRevisionExhausted');
  assert.deepStrictEqual(storeSnapshot(repo), before, 'zero bytes at the ceiling');
  // Replay and no-ops still work at the ceiling.
  const noop = payload(callTool(conn, 'ledger.update', ledgerEnvelope(atMax, {
    item: { id: readLedger(repo).features.find((f) => f.name === 'the last commit').id, name: 'the last commit' },
  })));
  assert.strictEqual(noop.committed, false);
  // And doctor names the operator condition, read-only.
  const rows = state.diagnoseLedger(repo);
  const headroom = rows.find((r) => r.name === 'ledger revision headroom');
  assert.ok(headroom && !headroom.ok && /archive or reset/.test(headroom.detail),
    'doctor carries the ceiling row with its stated repair');
});

// ---------------------------------------------------------------------------
// ReceiptTooLarge: deterministic, compositional, non-retryable.
// ---------------------------------------------------------------------------

ok('L14 an oversized receipt refuses ReceiptTooLarge; the verdict is compositional', () => {
  const repo = initRepo('l14-repo');
  const conn = service([repo], true).createConnection();
  let open = openWorkspace(conn, repo);
  // A ~5,000-byte id stays under the 16-KiB item cap while blowing the 4-KiB
  // receipt cap (the receipt echoes recordId).
  const hugeId = `feat-${'x'.repeat(5000)}`;
  const before = storeSnapshot(repo);
  const structured = refusal(callTool(conn, 'ledger.update',
    ledgerEnvelope(open, { item: { id: hugeId, name: 'blows the ring cap' } })));
  assert.strictEqual(structured.error, 'ReceiptTooLarge');
  assert.deepStrictEqual(storeSnapshot(repo), before, 'refused before commit — zero bytes');
  // A CREATE with a shorter id proceeds as a new operation.
  const shorter = payload(callTool(conn, 'ledger.update',
    ledgerEnvelope(open, { item: { id: 'feat-short', name: 'fits' } })));
  assert.strictEqual(shorter.committed, true);

  // Compositional: the SAME near-cap record admits under a 22-byte
  // operationId and refuses under a legal 128-byte one — the verdict is a
  // function of the whole serialized entry, never of the environment.
  open = openWorkspace(conn, repo);
  const mock = {
    id: 'o'.repeat(128),
    tool: 'ledger.update',
    argsHash: `sha256:${'0'.repeat(64)}`,
    gen: open.ledgerGen,
    rev: open.ledgerRev + 1,
    at: '2026-01-01T00:00:00.000Z',
    result: {
      ok: true, committed: true, replayed: false, ledgerRev: open.ledgerRev + 1,
      collection: 'features', recordId: '', action: 'created',
    },
  };
  const overhead = Buffer.byteLength(JSON.stringify(mock), 'utf8');
  // Aim the long-op entry ~40 bytes over the cap; the 106-byte opId delta
  // then puts the short-op entry comfortably under it.
  const idLength = 4096 - overhead + 40;
  const nearCapId = `f${'y'.repeat(idLength)}`;
  const longOp = refusal(callTool(conn, 'ledger.update', ledgerEnvelope(open, {
    operationId: opId(128), item: { id: nearCapId, name: 'n' },
  })));
  assert.strictEqual(longOp.error, 'ReceiptTooLarge', 'the 128-byte operationId composition refuses');
  const shortOp = payload(callTool(conn, 'ledger.update', ledgerEnvelope(open, {
    operationId: opId(22), item: { id: nearCapId, name: 'n' },
  })));
  assert.strictEqual(shortOp.committed, true,
    'a shorter (still-valid) operationId admits what a longer one cannot');
});

// ---------------------------------------------------------------------------
// Two rings, two lines.
// ---------------------------------------------------------------------------

ok('L17 conflict enforcement is per receipt ring: one id can serve both lines', () => {
  const repo = initRepo('l17-repo');
  const conn = service([repo], true).createConnection();
  const open = openWorkspace(conn, repo);
  const sharedId = opId();
  const stateWrite = payload(callTool(conn, 'state.set', {
    workspaceHandle: open.workspaceHandle,
    expectedStateRev: open.stateRev,
    expectedStateGen: open.stateGen,
    operationId: sharedId,
    key: 'objective', value: 'state line',
  }));
  assert.strictEqual(stateWrite.committed, true);
  // The client's global MUST-NOT-reuse rule still stands; the server just
  // does not consult the other retained ring.
  const ledgerWrite = payload(callTool(conn, 'ledger.update',
    ledgerEnvelope(open, { operationId: sharedId, item: { name: 'ledger line' } })));
  assert.strictEqual(ledgerWrite.committed, true, 'no cross-ring conflict');
});

ok('L18 WAL mirror publishes stay rev-, gen-, and ring-silent on a version-2 ledger', () => {
  const repo = initRepo('l18-repo');
  const conn = service([repo], true).createConnection();
  let open = openWorkspace(conn, repo);
  payload(callTool(conn, 'ledger.update', ledgerEnvelope(open, { item: { name: 'family record' } })));
  const beforeMirror = readLedger(repo);
  open = openWorkspace(conn, repo);
  const defect = payload(callTool(conn, 'defect.add', {
    workspaceHandle: open.workspaceHandle,
    expectedStateRev: open.stateRev,
    expectedStateGen: open.stateGen,
    operationId: opId(),
    item: { severity: 'high', summary: 'mirrored beside the family' },
  }));
  assert.ok(defect.ledgerId, 'the mirror landed');
  const after = readLedger(repo);
  assert.strictEqual(after.ledgerRev, beforeMirror.ledgerRev, 'the mirror is rev-silent');
  assert.strictEqual(after.ledgerGen, beforeMirror.ledgerGen, 'and gen-silent');
  assert.deepStrictEqual(after.operations, beforeMirror.operations, 'and ring-silent');
  assert.strictEqual(after.defects.length, 1);
  // A family expectation formed BEFORE the mirror still matches after it.
  const family = payload(callTool(conn, 'ledger.update',
    ledgerEnvelope({ ...open, ledgerRev: beforeMirror.ledgerRev, ledgerGen: beforeMirror.ledgerGen },
      { item: { name: 'after the mirror' } })));
  assert.strictEqual(family.committed, true,
    'the mirror moved only records the family cannot reach');
  assert.strictEqual(readLedger(repo).defects.length, 1, 'and the commit preserved the mirror bytes');
});

ok('L18b a CLI defect add over a version-1 ledger never admits it', () => {
  const repo = initRepo('l18b-repo');
  plantV1Ledger(repo);
  const artifacts = require('../src/artifacts');
  state.withWorkspaceMutation(repo, { action: 'seed artifact' }, (s) => {
    s.artifacts.push({ id: 'art-1', at: schemas.nowIso(), kind: 'spec', title: 'seed', status: 'v1' });
  });
  artifacts.addDefect(repo, { severity: 'high', summary: 'mirrored into v1' });
  const disk = readLedger(repo);
  assert.strictEqual(disk.version, 1, 'WAL mirror publishes NEVER admit');
  assert.strictEqual(disk.defects.length, 1, 'but the mirror landed');
});

// ---------------------------------------------------------------------------
// Read projections.
// ---------------------------------------------------------------------------

ok('L19 the ledger resource and the receipt serve the lineage projection on both eras of store', () => {
  // Version 2: the lineage is in the served bytes; no hash.
  const v2repo = initRepo('l19-v2');
  const conn = service([v2repo], true).createConnection();
  const open = openWorkspace(conn, v2repo);
  const v2read = modern(conn, 'resources/read', { uri: open.resources.ledger });
  const v2doc = JSON.parse(v2read.result.contents[0].text);
  assert.strictEqual(v2doc.ledgerRev, open.ledgerRev);
  assert.strictEqual(v2doc.ledgerGen, open.ledgerGen);
  assert.ok(!('ledgerBytesHash' in v2doc), 'no hash on a version-2 projection');
  const v2receipt = JSON.parse(modern(conn, 'resources/read', { uri: open.resources.receipt }).result.contents[0].text);
  assert.strictEqual(v2receipt.ledgerRev, open.ledgerRev, 'the receipt carries the lineage');
  assert.strictEqual(v2receipt.ledgerGen, open.ledgerGen);

  // Version 1: explicit nulls plus the hash of the exact bytes served.
  const v1repo = initRepo('l19-v1');
  plantV1Ledger(v1repo);
  const v1conn = service([v1repo], true).createConnection();
  const v1open = openWorkspace(v1conn, v1repo);
  const v1doc = JSON.parse(modern(v1conn, 'resources/read', { uri: v1open.resources.ledger }).result.contents[0].text);
  assert.strictEqual(v1doc.ledgerRev, null);
  assert.strictEqual(v1doc.ledgerGen, null);
  assert.strictEqual(v1doc.ledgerBytesHash, v1open.ledgerBytesHash);
  const v1receipt = JSON.parse(modern(v1conn, 'resources/read', { uri: v1open.resources.receipt }).result.contents[0].text);
  assert.strictEqual(v1receipt.ledgerRev, null);
  assert.strictEqual(v1receipt.ledgerBytesHash, v1open.ledgerBytesHash);
});

// ---------------------------------------------------------------------------
// Crash-boundary test 2: real process death before the commit rename.
// ---------------------------------------------------------------------------

const CRASHER = path.join(tmp, 'crash-before-ledger-commit.js');
fs.writeFileSync(CRASHER, [
  "'use strict';",
  '// Dies AT the ledger.json publish rename: armed only after workspace.open,',
  '// so open itself (which may create the ledger) commits normally.',
  'const fs = require("fs");',
  'const [repo] = process.argv.slice(2);',
  'const mcp = require(process.env.SERVER_MODULE);',
  'const real = fs.renameSync;',
  'let armed = false;',
  'fs.renameSync = (from, to) => {',
  '  if (armed && String(to).endsWith("ledger.json")) process.exit(41);',
  '  return real(from, to);',
  '};',
  'const meta = {',
  '  "io.modelcontextprotocol/protocolVersion": "2026-07-28",',
  '  "io.modelcontextprotocol/clientCapabilities": {},',
  '  "io.modelcontextprotocol/clientInfo": { name: "crash-client", version: "0" },',
  '};',
  'const conn = mcp.createServer({ roots: [repo], write: true }).createConnection();',
  'const call = (id, name, args) => conn.handleMessage({',
  '  jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args, _meta: meta },',
  '});',
  'const open = call(1, "workspace.open", { path: repo }).result.structuredContent;',
  'armed = true;',
  'call(2, "ledger.update", {',
  '  workspaceHandle: open.workspaceHandle,',
  '  expectedLedgerRev: open.ledgerRev,',
  '  expectedLedgerGen: open.ledgerGen,',
  '  operationId: process.env.CRASH_OPERATION_ID,',
  '  collection: "features", item: { name: "died mid-commit" },',
  '});',
  'process.exit(7); // reaching here means the failpoint never fired',
].join('\n'), 'utf8');

ok('L15 a process dead before the ledger rename leaves nothing; the retry applies once', () => {
  const repo = initRepo('l15-repo');
  const operationId = opId();
  const crashed = childProcess.spawnSync(process.execPath, [CRASHER, repo], {
    encoding: 'utf8',
    env: Object.assign(cleanGitEnv(), {
      SERVER_MODULE: path.join(__dirname, '..', 'src', 'mcp', 'server.js'),
      CRASH_OPERATION_ID: operationId,
    }),
    timeout: 30000,
    windowsHide: true,
  });
  assert.strictEqual(crashed.status, 41, `the child must die at the rename: ${crashed.stderr}`);
  const disk = readLedger(repo);
  assert.strictEqual(disk.ledgerRev, 0, 'no revision moved — the before-bytes are the record');
  assert.strictEqual(disk.features.length, 0, 'no record survived the death');
  assert.strictEqual(disk.operations.length, 0, 'no receipt survived either');

  process.env.RATCHET_LOCK_STALE_MS = '1';
  try {
    sleep(30);
    const conn = service([repo], true).createConnection();
    const open = openWorkspace(conn, repo);
    const retry = payload(callTool(conn, 'ledger.update', {
      workspaceHandle: open.workspaceHandle,
      expectedLedgerRev: open.ledgerRev,
      expectedLedgerGen: open.ledgerGen,
      operationId,
      collection: 'features',
      item: { name: 'died mid-commit' },
    }));
    assert.strictEqual(retry.committed, true, 'the retry applies cleanly — the operation never happened');
    assert.strictEqual(retry.replayed, false);
    const after = readLedger(repo);
    assert.strictEqual(after.ledgerRev, open.ledgerRev + 1);
    assert.strictEqual(after.features.length, 1, 'exactly one application');
  } finally {
    delete process.env.RATCHET_LOCK_STALE_MS;
  }
});

// ---------------------------------------------------------------------------
// Crash-boundary test 3: reconnect replay over the real wire — the server
// process is REPLACED, the client reopens (new handle), and the verbatim
// retry still returns the receipt. Proves the binding excludes the transport.
// ---------------------------------------------------------------------------

const RECONNECT_CLIENT = path.join(tmp, 'ledger-reconnect-client.js');
fs.writeFileSync(RECONNECT_CLIENT, [
  "'use strict';",
  'const cp = require("child_process");',
  'const [bin, root, operationId] = process.argv.slice(2);',
  'const meta = {',
  '  "io.modelcontextprotocol/protocolVersion": "2026-07-28",',
  '  "io.modelcontextprotocol/clientCapabilities": {},',
  '  "io.modelcontextprotocol/clientInfo": { name: "reconnect-client", version: "0" },',
  '};',
  'function drive(requests, done) {',
  '  const child = cp.spawn(process.execPath, [bin, "--root", root, "--write"], { windowsHide: true });',
  '  let buffered = "";',
  '  const seen = [];',
  '  let index = 0;',
  '  const send = () => child.stdin.write(JSON.stringify(requests[index](seen)) + "\\n");',
  '  child.stdout.on("data", (d) => {',
  '    buffered += d;',
  '    let nl;',
  '    while ((nl = buffered.indexOf("\\n")) !== -1) {',
  '      const line = buffered.slice(0, nl); buffered = buffered.slice(nl + 1);',
  '      if (!line.length) continue;',
  '      seen.push(JSON.parse(line));',
  '      index++;',
  '      if (index < requests.length) send();',
  '      else { child.kill(); done(seen); return; }',
  '    }',
  '  });',
  '  send();',
  '}',
  'const envelope = (open, id) => ({',
  '  jsonrpc: "2.0", id, method: "tools/call",',
  '  params: { name: "ledger.update", arguments: {',
  '    workspaceHandle: open.workspaceHandle,',
  '    expectedLedgerRev: open.ledgerRev,',
  '    expectedLedgerGen: open.ledgerGen,',
  '    operationId, collection: "features", item: { name: "written before the crash" },',
  '  }, _meta: meta },',
  '});',
  'const openReq = (id) => ({',
  '  jsonrpc: "2.0", id, method: "tools/call",',
  '  params: { name: "workspace.open", arguments: { path: root }, _meta: meta },',
  '});',
  'drive([',
  '  () => openReq(1),',
  '  (seen) => envelope(seen[0].result.structuredContent, 2),',
  '], (firstRun) => {',
  '  const firstOpen = firstRun[0].result.structuredContent;',
  '  drive([',
  '    () => openReq(3),',
  '    (seen) => {',
  '      const reopened = seen[0].result.structuredContent;',
  '      // The RETRY: new handle, same operationId, same lineage OBSERVED',
  '      // BEFORE the write.',
  '      return envelope({',
  '        workspaceHandle: reopened.workspaceHandle,',
  '        ledgerRev: firstOpen.ledgerRev,',
  '        ledgerGen: firstOpen.ledgerGen,',
  '      }, 4);',
  '    },',
  '  ], (secondRun) => {',
  '    process.stdout.write(JSON.stringify({',
  '      firstOpen,',
  '      firstWrite: firstRun[1].result,',
  '      reopen: secondRun[0].result.structuredContent,',
  '      retry: secondRun[1].result,',
  '    }));',
  '    process.exit(0);',
  '  });',
  '});',
  'setTimeout(() => { process.stderr.write("timeout"); process.exit(1); }, 45000);',
].join('\n'), 'utf8');

ok('L16 a reconnect after server death replays the ledger receipt through a new handle', () => {
  const repo = initRepo('l16-repo');
  const proc = childProcess.spawnSync(
    process.execPath,
    [RECONNECT_CLIENT, BIN, repo, opId()],
    { encoding: 'utf8', env: cleanGitEnv(), timeout: 60000, windowsHide: true }
  );
  assert.strictEqual(proc.status, 0, `client must finish: ${proc.stdout} ${proc.stderr}`);
  const report = JSON.parse(proc.stdout);
  const first = report.firstWrite.structuredContent;
  assert.strictEqual(first.committed, true);
  assert.strictEqual(first.ledgerRev, report.firstOpen.ledgerRev + 1);
  assert.notStrictEqual(report.reopen.workspaceHandle, report.firstOpen.workspaceHandle,
    'the second server minted a different handle');
  assert.strictEqual(report.reopen.ledgerGen, report.firstOpen.ledgerGen,
    'same ledger lineage across the restart');
  assert.deepStrictEqual(report.retry.structuredContent, { ...first, replayed: true },
    'the verbatim retry through the NEW handle replays the recorded outcome');
  const disk = readLedger(repo);
  assert.strictEqual(disk.ledgerRev, report.firstOpen.ledgerRev + 1, 'one commit total');
  assert.strictEqual(disk.features.length, 1, 'one application total');
});

// ---------------------------------------------------------------------------
// The deterministic-id collision and the funnel.
// ---------------------------------------------------------------------------

ok('L20 a derived id colliding with an existing target-collection record refuses', () => {
  const repo = initRepo('l20-repo');
  const conn = service([repo], true).createConnection();
  const open = openWorkspace(conn, repo);
  // Plant the id the NEXT write would mint.
  const item = { name: 'collide' };
  const argsHash = ops.ledgerBindingHash('features', item, open.ledgerRev + 1, open.ledgerGen, null);
  const plantedId = ops.deriveId('feat', open.ledgerGen, 'ledger.update', argsHash, 'features');
  payload(callTool(conn, 'ledger.update', ledgerEnvelope(open, { item: { id: plantedId, name: 'squatter' } })));
  const before = storeSnapshot(repo);
  const structured = refusal(callTool(conn, 'ledger.update',
    ledgerEnvelope({ ...open, ledgerRev: open.ledgerRev + 1 }, { item })));
  assert.strictEqual(structured.error, 'DeterministicIdConflict');
  assert.deepStrictEqual(storeSnapshot(repo), before);
});

ok('L21 the five ledger sentences are allowlisted: no path, errno, or store location', () => {
  for (const code of ['StaleLedgerRev', 'StaleLedgerGen', 'LedgerDamaged', 'LedgerRevisionExhausted', 'ReceiptTooLarge']) {
    const sentence = mcp.WRITE_REFUSALS[code];
    assert.strictEqual(typeof sentence, 'string', code);
    assert.ok(!/[\\/]/.test(sentence), `no path separators: ${sentence}`);
    assert.ok(!/E[A-Z]{2,}/.test(sentence), `no errno codes: ${sentence}`);
    assert.ok(!sentence.includes(tmp), 'no store locations');
  }
});

process.stdout.write(`\n${passed} passed, ${failures.length} failed\n`);
if (failures.length) {
  process.stdout.write(`RED: ${failures.join(', ')}\n`);
  process.exitCode = 1;
}
