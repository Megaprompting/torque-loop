'use strict';

// Torque MCP step 4 (safe core): the write envelope on the state.set canary.
// Run: node test/mcp-write.test.js
//
// What this suite exists to prove, in the spec's words: a retried write can
// never apply twice, never claim an outcome it does not have, and survives a
// server restart. The five crash-boundary replay tests are W11 (lost
// response), W21 (process death before commit — a real child process dies at
// the rename), W20 (reconnect replay over the real wire, new handle), W12
// (binding conflict) and W14/W15 (eviction, reset, out-of-band recreation).
// Every refusal is also a zero-byte proof: the store's bytes are snapshotted
// around it.
//
// Traced by: claude-fable-5

const assert = require('assert');
const childProcess = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.realpathSync.native(
  fs.mkdtempSync(path.join(os.tmpdir(), 'ratchet-mcp-write-test-'))
);
process.env.RATCHET_DATA_DIR = path.join(tmp, 'state-store');
process.env.RATCHET_EVOLVE_LOG = path.join(tmp, 'evolve-log.jsonl');

const mcp = require('../src/mcp/server');
const ops = require('../src/mcp/ops');
const state = require('../src/state');
const schemas = require('../src/schemas');

const META = 'io.modelcontextprotocol/';
const MODERN = '2026-07-28';
const LEGACY = '2025-11-25';
const BIN = path.join(__dirname, '..', 'bin', 'ratchet-mcp');
const RATCHET = path.join(__dirname, '..', 'bin', 'ratchet');

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

function initialize(conn) {
  return conn.handleMessage({
    jsonrpc: '2.0',
    id: ++requestId,
    method: 'initialize',
    params: {
      protocolVersion: LEGACY,
      capabilities: {},
      clientInfo: { name: 'test-client', version: '0' },
    },
  });
}

function legacy(conn, method, params) {
  return conn.handleMessage({
    jsonrpc: '2.0',
    id: ++requestId,
    method,
    params: params || {},
  });
}

function callTool(conn, era, name, arguments_) {
  const call = era === 'legacy' ? legacy : modern;
  return call(conn, 'tools/call', { name, arguments: arguments_ });
}

function openWorkspace(conn, repo, era) {
  return payload(callTool(conn, era, 'workspace.open', { path: repo }));
}

// A successful tool result: no protocol error, no isError, structured ===
// text — one answer on both channels.
function payload(response) {
  assert.strictEqual(response.error, undefined, response.error && response.error.message);
  assert.notStrictEqual(response.result.isError, true, JSON.stringify(response.result));
  const fromText = JSON.parse(response.result.content[0].text);
  assert.deepStrictEqual(response.result.structuredContent, fromText,
    'structured and compatibility text results must carry one answer');
  return response.result.structuredContent;
}

// A structured write refusal: isError, conforming error branch, one answer.
function refusal(response) {
  assert.strictEqual(response.error, undefined, response.error && response.error.message);
  assert.strictEqual(response.result.isError, true, JSON.stringify(response.result));
  const structured = response.result.structuredContent;
  assert.deepStrictEqual(JSON.parse(response.result.content[0].text), structured);
  assert.strictEqual(structured.ok, false);
  assert.strictEqual(typeof structured.error, 'string');
  assert.strictEqual(structured.message, mcp.WRITE_REFUSALS[structured.error],
    'every refusal message comes from the one allowlisted table');
  return structured;
}

function boundaryRefusal(response) {
  assert.ok(response.error, `expected a protocol refusal: ${JSON.stringify(response.result)}`);
  assert.strictEqual(response.error.code, -32602);
  return response.error;
}

function opId() {
  return crypto.randomBytes(16).toString('base64url');
}

function envelopeFor(open, extra) {
  return Object.assign({
    workspaceHandle: open.workspaceHandle,
    expectedStateRev: open.stateRev,
    expectedStateGen: open.stateGen,
    operationId: opId(),
  }, extra || {});
}

// Byte snapshot of one workspace's store directory: relative path -> hex.
// The zero-byte refusal proofs compare these before and after.
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

function readState(repo) {
  return JSON.parse(fs.readFileSync(path.join(state.projectDir(repo), 'state.json'), 'utf8'));
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// ---------------------------------------------------------------------------
// Mechanism units: canonical encoding and deterministic ids.
// ---------------------------------------------------------------------------

ok('U1 canonical encoding sorts keys recursively, preserves arrays, golden vectors', () => {
  assert.strictEqual(ops.canonicalStringify({ b: 1, a: 2 }), '{"a":2,"b":1}');
  assert.strictEqual(
    ops.canonicalStringify({ z: { y: 1, x: [3, 1, 2] }, a: '' }),
    '{"a":"","z":{"x":[3,1,2],"y":1}}'
  );
  assert.strictEqual(ops.canonicalStringify([{ b: 0, a: null }]), '[{"a":null,"b":0}]');
  assert.strictEqual(ops.canonicalStringify({}), '{}');
  // Non-ASCII values survive untouched (no normalization).
  assert.strictEqual(ops.canonicalStringify({ k: 'Ünïcode ✓' }), '{"k":"Ünïcode ✓"}');
});

ok('U2 key order is Unicode code point, not UTF-16 code unit', () => {
  // U+FFFD sorts BEFORE U+1F600 by code point; default string comparison puts
  // the surrogate pair (0xD83D...) first. This vector discriminates the two.
  const encoded = ops.canonicalStringify({ '\u{1F600}': 1, '�': 2 });
  assert.ok(encoded.indexOf('�') < encoded.indexOf('\u{1F600}'), encoded);
});

ok('U3 binding hash covers meaning, not transport, and moves with every input', () => {
  const base = ops.bindingHash('state.set', { key: 'objective', value: 'x' }, 3, 'gen-a');
  assert.match(base, /^sha256:[0-9a-f]{64}$/);
  assert.strictEqual(base, ops.bindingHash('state.set', { value: 'x', key: 'objective' }, 3, 'gen-a'),
    'argument key order is canonicalized away');
  for (const varied of [
    ops.bindingHash('state.append', { key: 'objective', value: 'x' }, 3, 'gen-a'),
    ops.bindingHash('state.set', { key: 'objective', value: 'y' }, 3, 'gen-a'),
    ops.bindingHash('state.set', { key: 'objective', value: 'x' }, 4, 'gen-a'),
    ops.bindingHash('state.set', { key: 'objective', value: 'x' }, 3, 'gen-b'),
  ]) {
    assert.notStrictEqual(base, varied);
  }
});

ok('U4 derived ids keep 128 bits, are deterministic, and vary by role', () => {
  const a = ops.deriveId('hist', 'gen-a', 'state.set', 'sha256:00', 'history');
  assert.match(a, /^hist-[0-9a-f]{32}$/);
  assert.strictEqual(a, ops.deriveId('hist', 'gen-a', 'state.set', 'sha256:00', 'history'));
  assert.notStrictEqual(a, ops.deriveId('hist', 'gen-a', 'state.set', 'sha256:00', 'defect'));
  assert.notStrictEqual(a, ops.deriveId('hist', 'gen-b', 'state.set', 'sha256:00', 'history'));
});

// ---------------------------------------------------------------------------
// Discovery and the write opt-in.
// ---------------------------------------------------------------------------

ok('W1 a flagless server registers no write tools and cannot dispatch one', () => {
  const repo = initRepo('w1-repo');
  const conn = service([repo], false).createConnection();
  const listed = modern(conn, 'tools/list', {}).result.tools.map((t) => t.name);
  assert.deepStrictEqual(listed, ['workspace.open', 'workspace.scan', 'score.confidence', 'score.friction']);
  const open = openWorkspace(conn, repo);
  const response = callTool(conn, 'modern', 'state.set', envelopeFor(open, { key: 'objective', value: 'x' }));
  assert.ok(response.error, 'an unregistered tool is undispatchable');
  assert.strictEqual(response.error.code, -32602);
  assert.match(response.error.message, /unknown tool/);
});

ok('W2 a --write server advertises state.set with the pinned descriptor, both eras', () => {
  const repo = initRepo('w2-repo');
  const server = service([repo], true);
  const conn = server.createConnection();
  const tools = modern(conn, 'tools/list', {}).result.tools;
  assert.deepStrictEqual(tools.map((t) => t.name),
    ['workspace.open', 'workspace.scan', 'score.confidence', 'score.friction', 'state.set']);
  const descriptor = tools[4];
  assert.deepStrictEqual(descriptor.annotations,
    { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false });
  assert.deepStrictEqual(descriptor.inputSchema.required,
    ['workspaceHandle', 'expectedStateRev', 'expectedStateGen', 'operationId', 'key', 'value']);
  assert.strictEqual(descriptor.inputSchema.additionalProperties, false);
  assert.strictEqual(descriptor.outputSchema.oneOf.length, 2, 'success and error branches');
  const [success, error] = descriptor.outputSchema.oneOf;
  assert.deepStrictEqual(success.required, ['ok', 'committed', 'stateRev', 'replayed', 'key']);
  assert.deepStrictEqual(error.required, ['ok', 'error', 'message']);
  const legacyConn = server.createConnection();
  initialize(legacyConn);
  const legacyTools = legacy(legacyConn, 'tools/list', {}).result.tools.map((t) => t.name);
  assert.ok(legacyTools.includes('state.set'), 'the write roster exists on the legacy era too');
});

ok('W3 workspace.open reports stateGen from the same snapshot as stateRev', () => {
  const repo = initRepo('w3-repo');
  const conn = service([repo], true).createConnection();
  const open = openWorkspace(conn, repo);
  assert.strictEqual(typeof open.stateGen, 'string');
  assert.ok(open.stateGen.length, 'a fresh store has a generation');
  const disk = readState(repo);
  assert.strictEqual(open.stateGen, disk.gen);
  assert.strictEqual(open.stateRev, disk.rev);
});

// ---------------------------------------------------------------------------
// The committed path.
// ---------------------------------------------------------------------------

ok('W4 a committed write moves one revision and carries its receipt in the same commit', () => {
  const repo = initRepo('w4-repo');
  const conn = service([repo], true).createConnection();
  const open = openWorkspace(conn, repo);
  const envelope = envelopeFor(open, { key: 'objective', value: 'ship step 4' });
  const result = payload(callTool(conn, 'modern', 'state.set', envelope));
  assert.deepStrictEqual(result,
    { ok: true, committed: true, stateRev: open.stateRev + 1, replayed: false, key: 'objective' });
  const disk = readState(repo);
  assert.strictEqual(disk.objective, 'ship step 4');
  assert.strictEqual(disk.dirty, true);
  assert.strictEqual(disk.rev, open.stateRev + 1);
  assert.strictEqual(disk.history.length, 1);
  assert.match(disk.history[0].id, /^hist-[0-9a-f]{32}$/, 'MCP-minted ids are derived, not random');
  assert.strictEqual(disk.operations.length, 1, 'the receipt rode the same commit');
  const receipt = disk.operations[0];
  assert.strictEqual(receipt.id, envelope.operationId);
  assert.strictEqual(receipt.tool, 'state.set');
  assert.match(receipt.argsHash, /^sha256:[0-9a-f]{64}$/);
  assert.strictEqual(receipt.gen, open.stateGen);
  assert.strictEqual(receipt.rev, disk.rev);
  assert.deepStrictEqual(receipt.result, result, 'the persisted result is the replay answer');
});

ok('W5 the MCP verb and the CLI verb write the same record (ids and stamps aside)', () => {
  const mcpRepo = initRepo('w5-mcp');
  const cliRepo = initRepo('w5-cli');
  const conn = service([mcpRepo], true).createConnection();
  const open = openWorkspace(conn, mcpRepo);
  payload(callTool(conn, 'modern', 'state.set', envelopeFor(open, { key: 'bottleneck', value: 'the seam' })));
  childProcess.execFileSync(process.execPath, [RATCHET, 'state', 'set', 'bottleneck', 'the seam'], {
    cwd: cliRepo, encoding: 'utf8', env: cleanGitEnv(), windowsHide: true,
  });
  const viaMcp = readState(mcpRepo);
  const viaCli = readState(cliRepo);
  assert.strictEqual(viaMcp.bottleneck, viaCli.bottleneck);
  assert.strictEqual(viaMcp.dirty, viaCli.dirty);
  const strip = (h) => ({ event: h.event, note: h.note });
  assert.deepStrictEqual(viaMcp.history.map(strip), viaCli.history.map(strip),
    'one verb meaning on both boundaries');
  assert.match(viaMcp.history[0].id, /^hist-[0-9a-f]{32}$/);
  assert.match(viaCli.history[0].id, /^hist-[0-9a-z]+-[0-9a-f]+$/, 'the CLI keeps random ids');
});

ok('W5b confidence coerces to a number through the shared helper', () => {
  const repo = initRepo('w5b-repo');
  const conn = service([repo], true).createConnection();
  const open = openWorkspace(conn, repo);
  payload(callTool(conn, 'modern', 'state.set', envelopeFor(open, { key: 'confidence', value: '7' })));
  assert.strictEqual(readState(repo).confidence, 7);
});

// ---------------------------------------------------------------------------
// Boundary refusals: the envelope.
// ---------------------------------------------------------------------------

ok('W6 a malformed envelope is refused at the boundary with zero bytes moved', () => {
  const repo = initRepo('w6-repo');
  const conn = service([repo], true).createConnection();
  const open = openWorkspace(conn, repo);
  const before = storeSnapshot(repo);
  const good = () => envelopeFor(open, { key: 'objective', value: 'x' });
  const bad = [
    (e) => { delete e.operationId; },
    (e) => { e.operationId = 'too-short-21-chars-aa'; },
    (e) => { e.operationId = 'has spaces which are not allowed'; },
    (e) => { delete e.expectedStateRev; },
    (e) => { e.expectedStateRev = -1; },
    (e) => { e.expectedStateRev = '0'; },
    (e) => { delete e.expectedStateGen; },
    (e) => { e.expectedStateGen = 7; },
    (e) => { e.extra = true; },
    (e) => { delete e.key; },
    (e) => { e.key = 'rev'; },
    (e) => { e.value = 42; },
  ];
  for (const mutate of bad) {
    const envelope = good();
    mutate(envelope);
    boundaryRefusal(callTool(conn, 'modern', 'state.set', envelope));
  }
  assert.deepStrictEqual(storeSnapshot(repo), before, 'no refusal moved a byte');
});

ok('W7 handle authority is one non-enumerating answer on the write door', () => {
  const repo = initRepo('w7-repo');
  const server = service([repo], true);
  const conn = server.createConnection();
  const open = openWorkspace(conn, repo);
  const fabricated = boundaryRefusal(callTool(conn, 'modern', 'state.set',
    envelopeFor({ ...open, workspaceHandle: 'A'.repeat(43) }, { key: 'objective', value: 'x' })));
  const foreignConn = server.createConnection();
  const foreign = boundaryRefusal(callTool(foreignConn, 'modern', 'state.set',
    envelopeFor(open, { key: 'objective', value: 'x' })));
  assert.strictEqual(fabricated.message, foreign.message,
    'fabricated and foreign handles get one answer');
});

// ---------------------------------------------------------------------------
// Domain refusals: CAS over revision, generation, existence.
// ---------------------------------------------------------------------------

ok('W8 a store destroyed after open refuses StateNotInitialized and creates nothing', () => {
  const repo = initRepo('w8-repo');
  const conn = service([repo], true).createConnection();
  const open = openWorkspace(conn, repo);
  fs.rmSync(path.join(state.projectDir(repo), 'state.json'));
  const before = storeSnapshot(repo);
  const structured = refusal(callTool(conn, 'modern', 'state.set',
    envelopeFor(open, { key: 'objective', value: 'x' })));
  assert.strictEqual(structured.error, 'StateNotInitialized');
  assert.strictEqual(structured.actualStateRev, null);
  assert.strictEqual(structured.actualStateGen, null);
  assert.deepStrictEqual(storeSnapshot(repo), before,
    'the refusal did not mint a fresh store');
});

ok('W9 a reset store refuses StaleGeneration for pre-reset envelopes', () => {
  const repo = initRepo('w9-repo');
  const conn = service([repo], true).createConnection();
  const open = openWorkspace(conn, repo);
  state.initProject(repo, { force: true, resetBy: 'test', resetReason: 'lineage test' });
  const before = storeSnapshot(repo);
  const structured = refusal(callTool(conn, 'modern', 'state.set',
    envelopeFor(open, { key: 'objective', value: 'pre-reset intent' })));
  assert.strictEqual(structured.error, 'StaleGeneration');
  assert.strictEqual(structured.expectedStateGen, open.stateGen);
  assert.notStrictEqual(structured.actualStateGen, open.stateGen);
  assert.deepStrictEqual(storeSnapshot(repo), before);
  assert.notStrictEqual(readState(repo).objective, 'pre-reset intent',
    'pre-reset intent never lands');
});

ok('W10 a moved revision refuses StaleStateRev, past or future, with the actual named', () => {
  const repo = initRepo('w10-repo');
  const conn = service([repo], true).createConnection();
  const open = openWorkspace(conn, repo);
  payload(callTool(conn, 'modern', 'state.set', envelopeFor(open, { key: 'objective', value: 'first' })));
  const before = storeSnapshot(repo);
  const stale = refusal(callTool(conn, 'modern', 'state.set',
    envelopeFor(open, { key: 'objective', value: 'second' })));
  assert.strictEqual(stale.error, 'StaleStateRev');
  assert.strictEqual(stale.expectedStateRev, open.stateRev);
  assert.strictEqual(stale.actualStateRev, open.stateRev + 1);
  const future = refusal(callTool(conn, 'modern', 'state.set',
    envelopeFor({ ...open, stateRev: open.stateRev + 5 }, { key: 'objective', value: 'third' })));
  assert.strictEqual(future.error, 'StaleStateRev');
  assert.deepStrictEqual(storeSnapshot(repo), before);
  assert.strictEqual(readState(repo).objective, 'first');
});

// ---------------------------------------------------------------------------
// Crash-boundary test 1: lost response — the verbatim retry replays.
// ---------------------------------------------------------------------------

ok('W11 a verbatim retry returns the persisted receipt and moves nothing, both eras', () => {
  for (const era of ['modern', 'legacy']) {
    const repo = initRepo(`w11-${era}`);
    const conn = service([repo], true).createConnection();
    if (era === 'legacy') initialize(conn);
    const open = openWorkspace(conn, repo, era);
    const envelope = envelopeFor(open, { key: 'objective', value: 'landed' });
    const first = payload(callTool(conn, era, 'state.set', envelope));
    const before = storeSnapshot(repo);
    const retry = payload(callTool(conn, era, 'state.set', envelope));
    assert.deepStrictEqual(retry, { ...first, replayed: true },
      'the retry is the recorded outcome, marked replayed');
    assert.deepStrictEqual(storeSnapshot(repo), before, 'a replay is a pure read');
    const stored = readState(repo).operations[0];
    assert.strictEqual(stored.result.replayed, false,
      'the stored bytes keep replayed:false; decoration happens on a copy');
  }
});

// ---------------------------------------------------------------------------
// Crash-boundary test 4: one id, two meanings.
// ---------------------------------------------------------------------------

ok('W12 the same operationId with a different binding refuses OperationIdConflict', () => {
  const repo = initRepo('w12-repo');
  const conn = service([repo], true).createConnection();
  const open = openWorkspace(conn, repo);
  const envelope = envelopeFor(open, { key: 'objective', value: 'meaning one' });
  payload(callTool(conn, 'modern', 'state.set', envelope));
  const before = storeSnapshot(repo);
  for (const varied of [
    { ...envelope, value: 'meaning two' },
    { ...envelope, key: 'bottleneck' },
    { ...envelope, expectedStateRev: open.stateRev + 1 },
    { ...envelope, expectedStateGen: 'gen-other' },
  ]) {
    const structured = refusal(callTool(conn, 'modern', 'state.set', varied));
    assert.strictEqual(structured.error, 'OperationIdConflict', JSON.stringify(varied));
  }
  assert.deepStrictEqual(storeSnapshot(repo), before);
  assert.strictEqual(readState(repo).operations.length, 1, 'the ring is unchanged');
});

// ---------------------------------------------------------------------------
// No-ops: safety without durable observability (the stated limit).
// ---------------------------------------------------------------------------

ok('W13 a no-op commits nothing, records no receipt, and repeats as a no-op', () => {
  const repo = initRepo('w13-repo');
  state.loadState(repo); // initialize the store the runner will refuse to create
  const before = storeSnapshot(repo);
  const disk = readState(repo);
  const call = () => ops.executeWrite({
    state,
    root: repo,
    tool: 'state.set',
    operationId: 'noop-operation-id-0000000000',
    expectedStateRev: disk.rev,
    expectedStateGen: disk.gen,
    semanticArgs: { key: 'objective', value: '' },
    apply: () => ({ key: 'objective' }),
  });
  const first = call();
  assert.strictEqual(first.kind, 'noop');
  assert.deepStrictEqual(first.result,
    { ok: true, committed: false, stateRev: disk.rev, replayed: false, key: 'objective' });
  assert.deepStrictEqual(storeSnapshot(repo), before, 'a no-op moves nothing');
  const again = call();
  assert.strictEqual(again.kind, 'noop', 'retrying a no-op re-runs it; nothing was stored to replay');
  assert.deepStrictEqual(storeSnapshot(repo), before);
  assert.ok(!readState(repo).operations || !readState(repo).operations.length,
    'no receipt exists for a no-op');
});

// ---------------------------------------------------------------------------
// Crash-boundary test 5: eviction, reset, recreation.
// ---------------------------------------------------------------------------

ok('W14 an evicted receipt cannot replay — the stale refusal answers instead', () => {
  const repo = initRepo('w14-repo');
  const conn = service([repo], true).createConnection();
  const open = openWorkspace(conn, repo);
  const firstEnvelope = envelopeFor(open, { key: 'objective', value: 'v0' });
  payload(callTool(conn, 'modern', 'state.set', firstEnvelope));
  for (let i = 1; i <= ops.OPERATIONS_CAP; i++) {
    payload(callTool(conn, 'modern', 'state.set', envelopeFor(
      { ...open, stateRev: open.stateRev + i },
      { key: 'objective', value: `v${i}` }
    )));
  }
  const disk = readState(repo);
  assert.strictEqual(disk.operations.length, ops.OPERATIONS_CAP, 'the ring is bounded');
  assert.ok(!disk.operations.some((e) => e.id === firstEnvelope.operationId),
    'the first receipt was evicted');
  const before = storeSnapshot(repo);
  const structured = refusal(callTool(conn, 'modern', 'state.set', firstEnvelope));
  assert.strictEqual(structured.error, 'StaleStateRev',
    'a verbatim retry of an evicted operation refuses; it never re-applies');
  assert.deepStrictEqual(storeSnapshot(repo), before);
  assert.strictEqual(readState(repo).objective, `v${ops.OPERATIONS_CAP}`);
});

ok('W15 reset wipes the ring on a continued revision line; recreation trips the generation', () => {
  const repo = initRepo('w15-repo');
  const conn = service([repo], true).createConnection();
  const open = openWorkspace(conn, repo);
  const envelope = envelopeFor(open, { key: 'objective', value: 'pre-reset' });
  payload(callTool(conn, 'modern', 'state.set', envelope));
  const revBefore = readState(repo).rev;
  state.initProject(repo, { force: true, resetBy: 'test', resetReason: 'wipe' });
  const wiped = readState(repo);
  assert.strictEqual(wiped.rev, revBefore + 1, 'the revision line CONTINUES across a wipe');
  assert.deepStrictEqual(wiped.operations, [], 'the ring is wiped with the record it lives in');
  const afterReset = refusal(callTool(conn, 'modern', 'state.set', envelope));
  assert.strictEqual(afterReset.error, 'StaleGeneration', 'post-reset, the old envelope refuses');

  // Out-of-band recreation: destroy the store, rebuild it, and drive the
  // revision back to the number the old envelope names. Only the generation
  // can tell the two lineages apart — and it does.
  fs.rmSync(state.projectDir(repo), { recursive: true, force: true });
  state.loadState(repo); // fresh store: rev 0 again, NEW generation
  const rebuilt = service([repo], true).createConnection();
  const reopened = openWorkspace(rebuilt, repo);
  assert.strictEqual(reopened.stateRev, envelope.expectedStateRev,
    'the recreated store reuses the numeric revision the old envelope names');
  assert.notStrictEqual(reopened.stateGen, envelope.expectedStateGen);
  const recreated = refusal(callTool(conn, 'modern', 'state.set', envelope));
  assert.strictEqual(recreated.error, 'StaleGeneration',
    'a same-revision recreation still refuses the old lineage');
  assert.notStrictEqual(readState(repo).objective, 'pre-reset');
});

// ---------------------------------------------------------------------------
// Deterministic-id collision: entropy is not permission to merge.
// ---------------------------------------------------------------------------

ok('W16 a derived id colliding with an existing record refuses with zero bytes', () => {
  const repo = initRepo('w16-repo');
  const conn = service([repo], true).createConnection();
  const open = openWorkspace(conn, repo);
  // Plan the write against the revision AFTER the injection commit, derive the
  // id it will mint, then plant that id first.
  const plannedRev = open.stateRev + 1;
  const semantic = { key: 'objective', value: 'collide' };
  const argsHash = ops.bindingHash('state.set', semantic, plannedRev, open.stateGen);
  const plantedId = ops.deriveId('hist', open.stateGen, 'state.set', argsHash, 'history');
  state.withWorkspaceMutation(repo, { action: 'test-inject' }, (s) => {
    s.history.push({ id: plantedId, at: schemas.nowIso(), event: 'planted', note: '' });
  });
  const before = storeSnapshot(repo);
  const structured = refusal(callTool(conn, 'modern', 'state.set',
    envelopeFor({ ...open, stateRev: plannedRev }, semantic)));
  assert.strictEqual(structured.error, 'DeterministicIdConflict');
  assert.deepStrictEqual(storeSnapshot(repo), before);
});

// ---------------------------------------------------------------------------
// The receipt entry cap fails closed.
// ---------------------------------------------------------------------------

ok('W17 an oversized result refuses before commit instead of truncating', () => {
  const repo = initRepo('w17-repo');
  state.loadState(repo);
  const disk = readState(repo);
  const before = storeSnapshot(repo);
  const outcome = ops.executeWrite({
    state,
    root: repo,
    tool: 'state.set',
    operationId: 'oversized-result-op-00000000',
    expectedStateRev: disk.rev,
    expectedStateGen: disk.gen,
    semanticArgs: { key: 'objective', value: 'big' },
    apply: (s) => {
      s.objective = 'big';
      return { key: 'x'.repeat(ops.RECEIPT_ENTRY_CAP) };
    },
  });
  assert.strictEqual(outcome.kind, 'capOverflow');
  assert.deepStrictEqual(storeSnapshot(repo), before,
    'the aborted transaction committed nothing — not even the verb mutation');
});

// ---------------------------------------------------------------------------
// The error funnel leaks nothing.
// ---------------------------------------------------------------------------

ok('W18 every refusal sentence is allowlisted and names no path, errno, or store', () => {
  for (const [code, sentence] of Object.entries(mcp.WRITE_REFUSALS)) {
    assert.strictEqual(typeof sentence, 'string', code);
    assert.ok(!/[\\/]/.test(sentence), `no path separators: ${sentence}`);
    assert.ok(!/E[A-Z]{2,}/.test(sentence), `no errno codes: ${sentence}`);
    assert.ok(!sentence.includes(tmp), 'no store locations');
  }
});

// ---------------------------------------------------------------------------
// The launch-time agent guard: a propose-only role may read, never --write.
// ---------------------------------------------------------------------------

ok('W19 --write under a propose-only RATCHET_AGENT refuses at startup; reads stay open', () => {
  const main = require('../src/mcp/main');
  const { PassThrough } = require('stream');
  const repo = initRepo('w19-repo');
  const io = () => {
    let text = '';
    const err = new PassThrough();
    err.on('data', (d) => { text += d; });
    return {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: err,
      env: { RATCHET_AGENT: 'builder' },
      read: () => text,
    };
  };
  const refused = io();
  const started = main.start(['--root', repo, '--write'], refused);
  assert.strictEqual(started.exitCode, 2, 'a propose-only writer is a launch error');
  assert.match(refused.read(), /RATCHET_AGENT=builder/, 'the diagnostic names the conflict');
  assert.match(refused.read(), /propose-only/);

  const allowed = io();
  const readOnly = main.start(['--root', repo], allowed);
  assert.strictEqual(readOnly.exitCode, null, 'the same role launches a read-only server');
  readOnly.server && readOnly.attached && readOnly.attached.detach && readOnly.attached.detach();
  // And the read path itself stays open to that role: reads never cross
  // assertMayWrite, and a plain open initializes without a wipe.
  process.env.RATCHET_AGENT = 'builder';
  try {
    const conn = service([repo], false).createConnection();
    const open = openWorkspace(conn, repo);
    assert.ok(open.workspaceHandle, 'a propose-only agent can still orient');
  } finally {
    delete process.env.RATCHET_AGENT;
  }
});

// ---------------------------------------------------------------------------
// Crash-boundary test 2: real process death before the commit rename.
// ---------------------------------------------------------------------------

const CRASHER = path.join(tmp, 'crash-before-commit.js');
fs.writeFileSync(CRASHER, [
  "'use strict';",
  '// Dies AT the state.json publish rename: the transaction is armed only',
  '// after workspace.open, so open itself commits normally.',
  'const fs = require("fs");',
  'const [repo] = process.argv.slice(2);',
  'const mcp = require(process.env.SERVER_MODULE);',
  'const real = fs.renameSync;',
  'let armed = false;',
  'fs.renameSync = (from, to) => {',
  '  if (armed && String(to).endsWith("state.json")) process.exit(41);',
  '  return real(from, to);',
  '};',
  'const conn = mcp.createServer({ roots: [repo], write: true }).createConnection();',
  'const meta = {',
  '  "io.modelcontextprotocol/protocolVersion": "2026-07-28",',
  '  "io.modelcontextprotocol/clientCapabilities": {},',
  '  "io.modelcontextprotocol/clientInfo": { name: "crash-client", version: "0" },',
  '};',
  'const call = (id, name, args) => conn.handleMessage({',
  '  jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args, _meta: meta },',
  '});',
  'const open = call(1, "workspace.open", { path: repo }).result.structuredContent;',
  'armed = true;',
  'call(2, "state.set", {',
  '  workspaceHandle: open.workspaceHandle,',
  '  expectedStateRev: open.stateRev,',
  '  expectedStateGen: open.stateGen,',
  '  operationId: process.env.CRASH_OPERATION_ID,',
  '  key: "objective", value: "died mid-commit",',
  '});',
  'process.exit(7); // reaching here means the failpoint never fired',
].join('\n'), 'utf8');

ok('W21 a process dead before the commit rename leaves nothing; the retry applies once', () => {
  const repo = initRepo('w21-repo');
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
  const disk = readState(repo);
  assert.strictEqual(disk.objective, '', 'no state change survived the death');
  assert.strictEqual(disk.rev, 0, 'no revision moved');
  assert.ok(!disk.operations || !disk.operations.length, 'no receipt survived either');

  // The dead process may still hold the workspace lock; a dead pid goes
  // soft-stale, and the retry may break it.
  process.env.RATCHET_LOCK_STALE_MS = '1';
  try {
    sleep(30);
    const conn = service([repo], true).createConnection();
    const open = openWorkspace(conn, repo);
    const retry = payload(callTool(conn, 'modern', 'state.set', {
      workspaceHandle: open.workspaceHandle,
      expectedStateRev: open.stateRev,
      expectedStateGen: open.stateGen,
      operationId,
      key: 'objective',
      value: 'died mid-commit',
    }));
    assert.deepStrictEqual(retry,
      { ok: true, committed: true, stateRev: open.stateRev + 1, replayed: false, key: 'objective' },
      'the retry applies cleanly — the operation never happened');
    const after = readState(repo);
    assert.strictEqual(after.objective, 'died mid-commit');
    assert.strictEqual(after.history.length, 1, 'exactly one application');
  } finally {
    delete process.env.RATCHET_LOCK_STALE_MS;
  }
});

// ---------------------------------------------------------------------------
// Crash-boundary test 3: reconnect replay over the real wire — the server
// process is REPLACED, the client reopens (new handle), and the verbatim
// retry still returns the receipt. Proves the binding excludes the transport.
// ---------------------------------------------------------------------------

const RECONNECT_CLIENT = path.join(tmp, 'reconnect-client.js');
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
  '  params: { name: "state.set", arguments: {',
  '    workspaceHandle: open.workspaceHandle,',
  '    expectedStateRev: open.stateRev,',
  '    expectedStateGen: open.stateGen,',
  '    operationId, key: "objective", value: "written before the crash",',
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
  '  // Server one is dead. Server two, fresh process, fresh connection state.',
  '  drive([',
  '    () => openReq(3),',
  '    (seen) => {',
  '      const reopened = seen[0].result.structuredContent;',
  '      // The RETRY: new handle (the old one died with its connection), same',
  '      // operationId, same revision + generation OBSERVED BEFORE the write.',
  '      return envelope({',
  '        workspaceHandle: reopened.workspaceHandle,',
  '        stateRev: firstOpen.stateRev,',
  '        stateGen: firstOpen.stateGen,',
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

ok('W20 a reconnect after server death replays the receipt through a new handle', () => {
  const repo = initRepo('w20-repo');
  const proc = childProcess.spawnSync(
    process.execPath,
    [RECONNECT_CLIENT, BIN, repo, opId()],
    { encoding: 'utf8', env: cleanGitEnv(), timeout: 60000, windowsHide: true }
  );
  assert.strictEqual(proc.status, 0, `client must finish: ${proc.stdout} ${proc.stderr}`);
  const report = JSON.parse(proc.stdout);
  const first = report.firstWrite.structuredContent;
  assert.deepStrictEqual(first,
    { ok: true, committed: true, stateRev: report.firstOpen.stateRev + 1, replayed: false, key: 'objective' });
  assert.notStrictEqual(report.reopen.workspaceHandle, report.firstOpen.workspaceHandle,
    'the second server minted a different handle');
  assert.strictEqual(report.reopen.stateGen, report.firstOpen.stateGen,
    'same store lineage across the restart');
  assert.deepStrictEqual(report.retry.structuredContent, { ...first, replayed: true },
    'the verbatim retry through the NEW handle replays the recorded outcome');
  const disk = readState(repo);
  assert.strictEqual(disk.rev, report.firstOpen.stateRev + 1, 'one commit total');
  assert.strictEqual(disk.history.length, 1, 'one application total');
});

// ---------------------------------------------------------------------------

process.stdout.write(`\n${passed} passed, ${failures.length} failed\n`);
if (failures.length) {
  process.exitCode = 1;
}
