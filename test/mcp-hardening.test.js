'use strict';

// Core hardening: three defects the 4c design review (rounds 2-3, 2026-08-01)
// found LIVE in the shipped safe core, each with the falsifier that saw the
// unpatched behavior red:
//   H1  the binding-hash canonicalizer assigned sorted keys into a plain
//       object, so a JSON-parsed own `__proto__` key invoked the prototype
//       setter and vanished from the hash — two different operations hashed
//       identically and a retained retry FALSELY REPLAYED instead of refusing
//       OperationIdConflict.
//   H2  both receipt-cap predicates measured JSON.stringify().length — UTF-16
//       code units — where the contract says 4 KiB of UTF-8 bytes, so an
//       astral-heavy result committed a receipt bigger than the cap.
//   H3  revisions passed Number.isInteger, which admits 2^53 — where `+ 1`
//       silently stops advancing and a stale CAS matches forever.
//   H4  a valid, small, deeply nested item blew the recursive canonicalizer's
//       stack and surfaced as -32603 internal error instead of a -32602
//       boundary refusal.
// Run: node test/mcp-hardening.test.js
//
// Traced by: claude-fable-5

const assert = require('assert');
const childProcess = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.realpathSync.native(
  fs.mkdtempSync(path.join(os.tmpdir(), 'ratchet-mcp-hardening-test-'))
);
process.env.RATCHET_DATA_DIR = path.join(tmp, 'state-store');
process.env.RATCHET_EVOLVE_LOG = path.join(tmp, 'evolve-log.jsonl');

const mcp = require('../src/mcp/server');
const ops = require('../src/mcp/ops');
const state = require('../src/state');

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

function initRepo(label) {
  const dir = fixture(label);
  childProcess.execFileSync('git', ['init', '--quiet'], {
    cwd: dir, encoding: 'utf8', env: cleanGitEnv(), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  return dir;
}

function service(roots) {
  return mcp.createServer({
    roots,
    write: true,
    serverInfo: { name: 'torque-mcp-hardening-test', version: '0.0.0' },
  }).createConnection();
}

let requestId = 0;
function modern(conn, method, params) {
  return conn.handleMessage({
    jsonrpc: '2.0',
    id: ++requestId,
    method,
    params: {
      ...(params || {}),
      _meta: {
        [META + 'protocolVersion']: MODERN,
        [META + 'clientCapabilities']: {},
        [META + 'clientInfo']: { name: 'test-client', version: '0' },
      },
    },
  });
}

function call(conn, name, arguments_) {
  return modern(conn, 'tools/call', { name, arguments: arguments_ });
}

function payload(response) {
  assert.strictEqual(response.error, undefined, response.error && response.error.message);
  assert.notStrictEqual(response.result.isError, true, JSON.stringify(response.result));
  return response.result.structuredContent;
}

function opId() {
  return crypto.randomBytes(16).toString('base64url');
}

// JSON.parse is the only honest way to mint an object whose OWN key is
// "__proto__" — an object literal in source would hit the setter here too.
function protoItem(x) {
  return JSON.parse(`{"name":"p","__proto__":{"x":${x}}}`);
}

ok('H1a two items differing only inside an own __proto__ key hash differently', () => {
  const a = ops.bindingHash('state.append', { collection: 'decisions', item: protoItem(1) }, 3, 'gen-x');
  const b = ops.bindingHash('state.append', { collection: 'decisions', item: protoItem(2) }, 3, 'gen-x');
  assert.notStrictEqual(a, b,
    'the canonicalizer dropped the own __proto__ key: two different operations share one binding hash');
});

ok('H1b a retained retry with a different __proto__ payload refuses OperationIdConflict, never replays', () => {
  const repo = initRepo('proto-conflict');
  const conn = service([repo]);
  const open = payload(call(conn, 'workspace.open', { path: repo }));
  const envelope = {
    workspaceHandle: open.workspaceHandle,
    expectedStateRev: open.stateRev,
    expectedStateGen: open.stateGen,
    operationId: opId(),
  };
  const first = payload(call(conn, 'state.append', {
    ...envelope, collection: 'decisions', item: protoItem(1),
  }));
  assert.strictEqual(first.committed, true);
  const second = call(conn, 'state.append', {
    ...envelope, collection: 'decisions', item: protoItem(2),
  });
  assert.strictEqual(second.error, undefined);
  assert.strictEqual(second.result.isError, true,
    `a DIFFERENT operation under a retained id must refuse, got: ${JSON.stringify(second.result.structuredContent)}`);
  assert.strictEqual(second.result.structuredContent.error, 'OperationIdConflict');
});

ok('H2 the receipt cap measures UTF-8 bytes, not UTF-16 code units', () => {
  const repo = initRepo('astral-cap');
  state.initProject(repo);
  const s = state.loadState(repo);
  // 1300 astral chars: 2,600 code units but 5,200 UTF-8 bytes. Entry overhead
  // keeps units < 4096 while bytes land well past the cap.
  const astral = '\u{1F4A5}'.repeat(1300);
  const outcome = ops.executeWrite({
    state,
    root: repo,
    tool: 'state.set',
    operationId: opId(),
    expectedStateRev: s.rev || 0,
    expectedStateGen: String(s.gen),
    semanticArgs: { key: 'title', value: 'x' },
    apply: (record) => {
      record.title = 'x';
      return { echoed: astral };
    },
  });
  assert.strictEqual(outcome.kind, 'capOverflow',
    `an over-cap-in-bytes receipt must refuse before commit, got: ${outcome.kind}`);
});

ok('H3 a store whose revision cannot advance safely refuses instead of freezing CAS', () => {
  const repo = initRepo('rev-ceiling');
  state.initProject(repo);
  state.withWorkspaceMutation(repo, { action: 'seed' }, (s) => {
    s.title = 'seed';
  });
  const file = path.join(state.projectDir(repo), 'state.json');
  const record = JSON.parse(fs.readFileSync(file, 'utf8'));
  record.rev = 9007199254740992; // 2^53: isInteger true, isSafeInteger false, +1 is a no-op
  fs.writeFileSync(file, JSON.stringify(record, null, 2) + '\n');
  assert.throws(
    () => state.withWorkspaceMutation(repo, { action: 'advance' }, (s) => {
      s.title = 'moved';
    }),
    /revision/i,
    'committing atop an unadvanceable revision must throw, not publish a rev that did not move'
  );
  const after = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.strictEqual(after.title, 'seed', 'the refused commit must not publish its mutation');
});

ok('H4 a small but deeply nested item refuses -32602 at the boundary, not -32603 from the stack', () => {
  const repo = initRepo('deep-item');
  const conn = service([repo]);
  const open = payload(call(conn, 'workspace.open', { path: repo }));
  let deep = [];
  for (let i = 0; i < 20000; i++) deep = [deep];
  const response = call(conn, 'state.append', {
    workspaceHandle: open.workspaceHandle,
    expectedStateRev: open.stateRev,
    expectedStateGen: open.stateGen,
    operationId: opId(),
    collection: 'decisions',
    item: { name: 'deep', payload: deep },
  });
  assert.ok(response.error, `expected a protocol refusal, got: ${JSON.stringify(response.result)}`);
  assert.strictEqual(response.error.code, -32602,
    `nesting beyond the stated limit is malformed input (-32602), got ${response.error.code}`);
});

ok('H5 an unsafe-integer expectedStateRev refuses -32602 at the boundary', () => {
  const repo = initRepo('unsafe-expectation');
  const conn = service([repo]);
  const open = payload(call(conn, 'workspace.open', { path: repo }));
  const response = call(conn, 'state.set', {
    workspaceHandle: open.workspaceHandle,
    expectedStateRev: 9007199254740992,
    expectedStateGen: open.stateGen,
    operationId: opId(),
    key: 'title',
    value: 'x',
  });
  assert.ok(response.error, `expected a protocol refusal, got: ${JSON.stringify(response.result)}`);
  assert.strictEqual(response.error.code, -32602);
});

process.stdout.write(`\n${passed} passed${failures.length ? `, ${failures.length} FAILED: ${failures.join(', ')}` : ''}\n`);
if (failures.length) process.exit(1);
