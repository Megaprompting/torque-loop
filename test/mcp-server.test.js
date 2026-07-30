'use strict';

// Torque MCP build-order step 2.4: workspace.open and handle-bound torque://
// resources. Run: node test/mcp-server.test.js
//
// The one path-bearing call is workspace.open. It composes canonical
// containment with Git-root discovery, then returns an opaque workspace
// capability. Every later resource read carries that capability in the URI;
// no resource method accepts a pathname or re-interprets client filesystem
// text.
//
// Written RED first against an absent module.
// Traced by: openai-codex-gpt-5

const assert = require('assert');
const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PassThrough } = require('stream');

const tmp = fs.realpathSync.native(
  fs.mkdtempSync(path.join(os.tmpdir(), 'ratchet-mcp-server-test-'))
);
process.env.RATCHET_DATA_DIR = path.join(tmp, 'state-store');
process.env.RATCHET_EVOLVE_LOG = path.join(tmp, 'evolve-log.jsonl');

const mcp = require('../src/mcp/server');
const stdio = require('../src/mcp/stdio');
const state = require('../src/state');

const META = 'io.modelcontextprotocol/';
const MODERN = '2026-07-28';
const LEGACY = '2025-11-25';

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

function service(roots) {
  return mcp.createServer({
    roots,
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

function openWorkspace(conn, repo, era) {
  const call = era === 'legacy' ? legacy : modern;
  return call(conn, 'tools/call', {
    name: 'workspace.open',
    arguments: { path: repo },
  });
}

function payload(response) {
  assert.strictEqual(response.error, undefined, response.error && response.error.message);
  assert.strictEqual(response.result.isError, undefined, JSON.stringify(response.result));
  const fromText = JSON.parse(response.result.content[0].text);
  assert.deepStrictEqual(response.result.structuredContent, fromText,
    'structured and compatibility text results must carry one answer');
  return fromText;
}

ok('S1 both protocol eras advertise the fixed tools, resources, and prompts capabilities', () => {
  const root = fixture('s1-root');
  const server = service([root]);

  const modernConn = server.createConnection();
  const discover = modernConn.handleMessage({
    jsonrpc: '2.0', id: ++requestId, method: 'server/discover',
  });
  assert.deepStrictEqual(discover.result.capabilities, { tools: {}, resources: {}, prompts: {} });

  const legacyConn = server.createConnection();
  const init = initialize(legacyConn);
  assert.deepStrictEqual(init.result.capabilities, { tools: {}, resources: {}, prompts: {} });
});

ok('S2 tools/list exposes only workspace.open with a closed path schema', () => {
  const conn = service([fixture('s2-root')]).createConnection();
  const listed = modern(conn, 'tools/list');
  assert.strictEqual(listed.error, undefined);
  assert.strictEqual(listed.result.tools.length, 1);
  const tool = listed.result.tools[0];
  assert.strictEqual(tool.name, 'workspace.open');
  assert.deepStrictEqual(tool.inputSchema.required, ['path']);
  assert.strictEqual(tool.inputSchema.properties.path.type, 'string');
  assert.strictEqual(tool.inputSchema.additionalProperties, false);
  assert.strictEqual(tool.annotations.destructiveHint, false);
  assert.strictEqual(tool.annotations.idempotentHint, true);
  assert.strictEqual(tool.annotations.openWorldHint, false);
  assert.strictEqual(tool.annotations.readOnlyHint, false,
    'opening may initialize the external Torque state store');
  assert.strictEqual(listed.result.ttlMs, 300000);
  assert.strictEqual(listed.result.cacheScope, 'public');
});

ok('S3 workspace.open returns an opaque handle, stable identities, stateRev, and resource links', () => {
  const root = fixture('s3-root');
  const repo = initRepo('s3-repo');
  const conn = service([root, repo]).createConnection();
  const opened = openWorkspace(conn, repo);
  const result = payload(opened);

  assert.match(result.workspaceHandle, /^[A-Za-z0-9_-]{43}$/);
  assert.match(result.repositoryId, /^repo_[A-Za-z0-9_-]{43}$/);
  assert.match(result.worktreeId, /^worktree_[A-Za-z0-9_-]{43}$/);
  assert.strictEqual(result.stateRev, 0);
  assert.deepStrictEqual(result.resources, {
    state: `torque://workspace/${result.workspaceHandle}/state`,
    ledger: `torque://workspace/${result.workspaceHandle}/ledger`,
    receipt: `torque://workspace/${result.workspaceHandle}/receipt`,
  });
  assert.deepStrictEqual(
    opened.result.content.slice(1).map((entry) => entry.uri),
    Object.values(result.resources),
    'the tool result carries standard resource_link blocks for all three reads'
  );
  assert.ok(opened.result.content.slice(1).every((entry) => entry.type === 'resource_link'));
  assert.ok(!JSON.stringify(result).includes(repo), 'no canonical pathname crosses the MCP boundary');
});

ok('S4 root and subdirectory opens converge on one handle within a connection', () => {
  const repo = initRepo('s4-repo');
  const deep = path.join(repo, 'a', 'b');
  fs.mkdirSync(deep, { recursive: true });
  const conn = service([repo]).createConnection();
  const fromRoot = payload(openWorkspace(conn, repo));
  const fromDeep = payload(openWorkspace(conn, deep));
  assert.strictEqual(fromDeep.workspaceHandle, fromRoot.workspaceHandle);
  assert.strictEqual(fromDeep.repositoryId, fromRoot.repositoryId);
  assert.strictEqual(fromDeep.worktreeId, fromRoot.worktreeId);
});

ok('S5 stateRev refreshes without replacing the workspace handle', () => {
  const repo = initRepo('s5-repo');
  const conn = service([repo]).createConnection();
  const first = payload(openWorkspace(conn, repo));
  const snapshot = state.loadState(repo);
  snapshot.objective = 'prove the revision moved';
  state.saveState(repo, snapshot);
  const second = payload(openWorkspace(conn, repo));
  assert.strictEqual(second.workspaceHandle, first.workspaceHandle);
  assert.strictEqual(second.stateRev, 1);
});

ok('S6 handles are connection-scoped even when both connections open the same repository', () => {
  const repo = initRepo('s6-repo');
  const server = service([repo]);
  const a = server.createConnection();
  const b = server.createConnection();
  const openedA = payload(openWorkspace(a, repo));
  const openedB = payload(openWorkspace(b, repo));
  assert.notStrictEqual(openedA.workspaceHandle, openedB.workspaceHandle);
  assert.strictEqual(openedA.repositoryId, openedB.repositoryId);
  assert.strictEqual(openedA.worktreeId, openedB.worktreeId);

  const crossed = modern(b, 'resources/read', { uri: openedA.resources.state });
  assert.strictEqual(crossed.error.code, -32602);
  assert.strictEqual(crossed.error.message, 'resource is not available on this connection');
});

ok('S7 resources/list is connection-invariant; templates carry the dynamic handle boundary', () => {
  const repo = initRepo('s7-repo');
  const server = service([repo]);
  const a = server.createConnection();
  const b = server.createConnection();

  const before = modern(a, 'resources/list');
  const toolsBefore = modern(a, 'tools/list');
  payload(openWorkspace(a, repo));
  const after = modern(a, 'resources/list');
  const toolsAfter = modern(a, 'tools/list');
  const other = modern(b, 'resources/list');
  assert.deepStrictEqual(before.result.resources, []);
  assert.deepStrictEqual(after.result.resources, []);
  assert.deepStrictEqual(other.result.resources, []);
  assert.deepStrictEqual(toolsAfter.result.tools, toolsBefore.result.tools,
    'opening a workspace cannot mutate the cacheable tool list');
  assert.strictEqual(after.result.ttlMs, 300000);
  assert.strictEqual(after.result.cacheScope, 'public');

  const templates = modern(a, 'resources/templates/list');
  const otherTemplates = modern(b, 'resources/templates/list');
  assert.deepStrictEqual(
    templates.result.resourceTemplates.map((entry) => entry.uriTemplate),
    [
      'torque://workspace/{workspaceHandle}/state',
      'torque://workspace/{workspaceHandle}/ledger',
      'torque://workspace/{workspaceHandle}/receipt',
    ]
  );
  assert.deepStrictEqual(otherTemplates.result.resourceTemplates, templates.result.resourceTemplates,
    'resource templates are server-global shapes, not connection state');
  assert.ok(templates.result.resourceTemplates.every((entry) => entry.mimeType === 'application/json'));
});

ok('S8 the state resource reads the opened Git root and returns private no-cache JSON', () => {
  const repo = initRepo('s8-repo');
  const initial = state.loadState(repo);
  initial.objective = 'read me through the capability';
  state.saveState(repo, initial);

  const conn = service([repo]).createConnection();
  const opened = payload(openWorkspace(conn, repo));
  const read = modern(conn, 'resources/read', { uri: opened.resources.state });
  assert.strictEqual(read.error, undefined);
  assert.strictEqual(read.result.ttlMs, 0);
  assert.strictEqual(read.result.cacheScope, 'private');
  assert.strictEqual(read.result.contents.length, 1);
  assert.strictEqual(read.result.contents[0].uri, opened.resources.state);
  assert.strictEqual(read.result.contents[0].mimeType, 'application/json');
  assert.strictEqual(JSON.parse(read.result.contents[0].text).objective, 'read me through the capability');
});

ok('S9 ledger and receipt resources expose fixed-shape JSON through the same handle', () => {
  const repo = initRepo('s9-repo');
  const conn = service([repo]).createConnection();
  const opened = payload(openWorkspace(conn, repo));

  const ledgerRead = modern(conn, 'resources/read', { uri: opened.resources.ledger });
  const ledger = JSON.parse(ledgerRead.result.contents[0].text);
  assert.deepStrictEqual(ledger.features, []);
  assert.deepStrictEqual(ledger.tests, []);
  assert.deepStrictEqual(ledger.defects, []);

  const receiptRead = modern(conn, 'resources/read', { uri: opened.resources.receipt });
  const receipt = JSON.parse(receiptRead.result.contents[0].text);
  for (const field of ['target', 'delta', 'proof', 'verdict', 'risk', 'authority', 'state', 'next']) {
    assert.ok(Object.prototype.hasOwnProperty.call(receipt, field), `receipt keeps ${field}`);
  }
});

ok('S10 malformed, unknown, raw-path, and wrong-connection resource URIs refuse identically', () => {
  const repo = initRepo('s10-repo');
  const outside = initRepo('s10-outside');
  const server = service([repo]);
  const owner = server.createConnection();
  const other = server.createConnection();
  const opened = payload(openWorkspace(owner, repo));
  const attempts = [
    'file:///etc/passwd',
    'torque://workspace/not-a-handle/state',
    `torque://workspace/${opened.workspaceHandle}/unknown`,
    `torque://workspace/${encodeURIComponent(outside)}/state`,
  ];
  for (const uri of attempts) {
    const response = modern(owner, 'resources/read', { uri });
    assert.strictEqual(response.error.code, -32602);
    assert.strictEqual(response.error.message, 'resource is not available on this connection');
  }
  const crossed = modern(other, 'resources/read', { uri: opened.resources.receipt });
  assert.strictEqual(crossed.error.code, -32602);
  assert.strictEqual(crossed.error.message, 'resource is not available on this connection');
});

ok('S11 an outside or non-Git path is a tool error and mints no usable resource', () => {
  const allowed = fixture('s11-allowed');
  const outside = initRepo('s11-outside');
  const plain = path.join(allowed, 'plain');
  fs.mkdirSync(plain);
  const conn = service([allowed]).createConnection();

  for (const candidate of [outside, plain]) {
    const response = openWorkspace(conn, candidate);
    assert.strictEqual(response.error, undefined);
    assert.strictEqual(response.result.isError, true);
    assert.strictEqual(response.result.structuredContent, undefined);
    assert.strictEqual(response.result.content.length, 1);
    assert.ok(!response.result.content[0].text.includes(candidate),
      'a refusal must not echo the path it was asked to probe');
  }
});

ok('S12 unknown tools and malformed call envelopes are protocol errors, not fake tool results', () => {
  const root = fixture('s12-root');
  const conn = service([root]).createConnection();
  const unknown = modern(conn, 'tools/call', { name: 'workspace.delete', arguments: {} });
  assert.strictEqual(unknown.error.code, -32602);
  const malformed = modern(conn, 'tools/call', { name: 'workspace.open', arguments: { path: 7 } });
  assert.strictEqual(malformed.error, undefined);
  assert.strictEqual(malformed.result.isError, true);
  const selectedHandle = modern(conn, 'tools/call', {
    name: 'workspace.open',
    arguments: { path: root, workspaceHandle: 'client-chosen' },
  });
  assert.strictEqual(selectedHandle.result.isError, true,
    'the client cannot add a handle field to the closed input schema');
});

ok('S13 legacy responses keep legacy wire shape while serving the same resources', () => {
  const repo = initRepo('s13-repo');
  const conn = service([repo]).createConnection();
  initialize(conn);
  const listed = legacy(conn, 'tools/list');
  assert.strictEqual(listed.result.resultType, undefined);
  assert.strictEqual(listed.result.ttlMs, undefined);
  assert.strictEqual(listed.result.cacheScope, undefined);

  const opened = payload(openWorkspace(conn, repo, 'legacy'));
  const read = legacy(conn, 'resources/read', { uri: opened.resources.state });
  assert.strictEqual(read.result.resultType, undefined);
  assert.strictEqual(read.result.ttlMs, undefined);
  assert.strictEqual(read.result.cacheScope, undefined);
  assert.strictEqual(JSON.parse(read.result.contents[0].text).rev, opened.stateRev);
});

ok('S14 closing a connection kills every workspace resource immediately', () => {
  const repo = initRepo('s14-repo');
  const conn = service([repo]).createConnection();
  const opened = payload(openWorkspace(conn, repo));
  conn.close();
  const read = modern(conn, 'resources/read', { uri: opened.resources.state });
  assert.strictEqual(read.error.code, -32602);
  assert.strictEqual(read.error.message, 'resource is not available on this connection');
  const reopened = openWorkspace(conn, repo);
  assert.strictEqual(reopened.result.isError, true, 'a closed connection cannot mint a replacement');
});

ok('S15 workspace.open and resource read survive the newline-delimited stdio wire', () => {
  const repo = initRepo('s15-repo');
  const input = new PassThrough();
  const output = new PassThrough();
  const lines = [];
  output.on('data', (chunk) => lines.push(...String(chunk).split('\n').filter(Boolean)));
  const attached = stdio.attach(service([repo]), { input, output });

  input.write(JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'server/discover',
  }) + '\n');
  input.write(JSON.stringify({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: {
      name: 'workspace.open',
      arguments: { path: repo },
      _meta: modernMeta(),
    },
  }) + '\n');
  const opened = JSON.parse(lines[1]);
  const uri = opened.result.structuredContent.resources.state;
  input.write(JSON.stringify({
    jsonrpc: '2.0',
    id: 3,
    method: 'resources/read',
    params: { uri, _meta: modernMeta() },
  }) + '\n');

  const read = JSON.parse(lines[2]);
  assert.strictEqual(read.id, 3);
  assert.strictEqual(read.error, undefined);
  assert.strictEqual(read.result.contents[0].uri, uri);
  assert.strictEqual(JSON.parse(read.result.contents[0].text).rev, 0);
  attached.connection.close();
});

fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
process.stdout.write(`\n${passed} passed, ${failures.length} failed\n`);
if (failures.length) process.exitCode = 1;
