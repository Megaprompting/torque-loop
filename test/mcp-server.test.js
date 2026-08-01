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

// S2 pinned "only workspace.open" until step 3b, which advertises the three
// derived read tools. The assertion was not weakened — it was replaced by a
// stricter one: the exact list, in order, with every descriptor's shape,
// schemas and hints pinned, so an added, renamed or silently widened tool
// fails here rather than shipping.
ok('S2 tools/list advertises exactly four tools, in order, with closed schemas', () => {
  const conn = service([fixture('s2-root')]).createConnection();
  const listed = modern(conn, 'tools/list');
  assert.strictEqual(listed.error, undefined);
  assert.deepStrictEqual(
    listed.result.tools.map((tool) => tool.name),
    ['workspace.open', 'workspace.scan', 'score.confidence', 'score.friction']
  );
  for (const tool of listed.result.tools) {
    assert.deepStrictEqual(
      Object.keys(tool),
      ['name', 'title', 'description', 'inputSchema', 'outputSchema', 'annotations'],
      `${tool.name} carries the whole descriptor shape and nothing else`
    );
    assert.strictEqual(tool.inputSchema.additionalProperties, false,
      `${tool.name} rejects additional input properties`);
    assert.strictEqual(tool.outputSchema.additionalProperties, false,
      `${tool.name} pins its public top-level output shape`);
    assert.strictEqual(tool.annotations.destructiveHint, false);
    assert.strictEqual(tool.annotations.idempotentHint, true);
    assert.strictEqual(tool.annotations.openWorldHint, false);
  }

  const [open, scan, confidence, friction] = listed.result.tools;
  assert.deepStrictEqual(open.inputSchema.required, ['path']);
  assert.strictEqual(open.inputSchema.properties.path.type, 'string');
  assert.strictEqual(open.annotations.readOnlyHint, false,
    'opening may initialize the external Torque state store');
  for (const derived of [scan, confidence, friction]) {
    assert.strictEqual(derived.annotations.readOnlyHint, true,
      `${derived.name} moves nothing, and says so`);
  }
  assert.deepStrictEqual(scan.inputSchema, confidence.inputSchema,
    'both workspace-bound tools take one handle and nothing else');
  assert.deepStrictEqual(scan.inputSchema.required, ['workspaceHandle']);
  assert.deepStrictEqual(scan.outputSchema.required, ['ok', 'configured', 'checks']);
  assert.deepStrictEqual(confidence.outputSchema.required,
    ['artifact', 'session', 'ledger', 'closure', 'stateRev', 'journal']);
  assert.deepStrictEqual(friction.inputSchema.required, ['obstacles']);
  assert.strictEqual(friction.inputSchema.properties.obstacles.items.additionalProperties, false,
    'an obstacle carries only the fields the domain function reads');
  assert.strictEqual(
    Object.prototype.hasOwnProperty.call(friction.inputSchema.properties, 'workspaceHandle'),
    false, 'the payload-only tool takes no workspace authority');
  assert.strictEqual(listed.result.ttlMs, 300000);
  assert.strictEqual(listed.result.cacheScope, 'public');

  // The whole-object pin. The assertions above give a named reason when one
  // guarantee breaks; this one catches everything they do not enumerate —
  // description text, a nested schema type, a new hint — because the fixture
  // is checked-in bytes, not a reference to the objects the server serves.
  // Changing a descriptor is allowed; doing it without touching the fixture
  // is drift, and drift fails here.
  assert.deepStrictEqual(
    listed.result.tools,
    JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'mcp-tools-list.json'), 'utf8')),
    'tools/list deep-equals the pinned descriptor fixture'
  );
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

// ---------------------------------------------------------------------------
// Step 3b: the derived read tools. Traced by: claude-opus-5
//
// Everything below holds one line: a read moves nothing. workspace.open is the
// one boundary allowed to write, and it initializes BOTH canonical records
// there — so the byte proof covers every resource and every tool, not just the
// ones that happened to find their file already on disk.
// ---------------------------------------------------------------------------

const crypto = require('crypto');
const RATCHET_BIN = path.join(__dirname, '..', 'bin', 'ratchet');

function fileDigest(file) {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  } catch (_e) {
    return 'absent';
  }
}

function treeDigest(dir) {
  const out = [];
  const walk = (rel) => {
    let entries;
    try {
      entries = fs.readdirSync(path.join(dir, rel), { withFileTypes: true });
    } catch (_e) {
      return;
    }
    for (const entry of entries.slice().sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const child = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        out.push(`d ${child}`);
        walk(child);
      } else {
        out.push(`f ${child} ${fileDigest(path.join(dir, child))}`);
      }
    }
  };
  walk('');
  return out.join('\n');
}

// Scope, named out loud: the canonical store (state + ledger + any residue),
// the workspace .ratchet directory, the evolution log, and whatever extra file
// a case names. NOT .git — a read that shells out to git can refresh git's own
// index stat cache, which is git's bookkeeping and not Torque state.
function worldSnapshot(repo, extras) {
  return JSON.stringify({
    store: treeDigest(state.projectDir(repo)),
    workspace: treeDigest(path.join(repo, '.ratchet')),
    log: fileDigest(process.env.RATCHET_EVOLVE_LOG),
    extras: (extras || []).map(fileDigest),
  });
}

// The same domain read the tools perform, reached the way a user reaches it.
// Equivalence has to be measured against the CLI actually running, not against
// a second call to the same function the server just called.
function ratchet(repo, args, env) {
  const proc = childProcess.spawnSync(process.execPath, [RATCHET_BIN, ...args], {
    cwd: repo,
    encoding: 'utf8',
    env: Object.assign(cleanGitEnv(), env || {}),
    timeout: 60000,
    windowsHide: true,
  });
  if (proc.error) throw proc.error;
  return proc;
}

function callTool(conn, name, args, era) {
  const call = era === 'legacy' ? legacy : modern;
  return call(conn, 'tools/call', { name, arguments: args });
}

const FRICTION_PAYLOAD = [
  { name: 'lock contention', leverage: 9, certainty: 8, speed: 4, risk: 9, note: 'blocks writes' },
  { obstacle: 'stale docs', leverage: 3, certainty: 9, timeToUnblock: 9, riskOfIgnoring: 2 },
];

ok('S16 workspace.open initializes BOTH canonical records before it issues a handle', () => {
  const repo = initRepo('s16-repo');
  const store = state.projectDir(repo);
  assert.strictEqual(fs.existsSync(path.join(store, 'state.json')), false, 'fresh fixture, no state yet');
  assert.strictEqual(fs.existsSync(path.join(store, 'ledger.json')), false, 'fresh fixture, no ledger yet');

  const conn = service([repo]).createConnection();
  const opened = payload(openWorkspace(conn, repo));
  assert.match(opened.workspaceHandle, /^[A-Za-z0-9_-]{43}$/);
  assert.ok(fs.existsSync(path.join(store, 'state.json')), 'open initializes the state record');
  assert.ok(fs.existsSync(path.join(store, 'ledger.json')),
    'open initializes the ledger record too — otherwise the FIRST ledger resource read writes it, ' +
    'and no read path is pure');
});

ok('S17 first read of every resource and every derived tool moves zero bytes and zero revisions', () => {
  const repo = initRepo('s17-repo');
  // A configured surface joins the snapshot scope: the scan OPENS this file,
  // and a read that opens a file is exactly the read that could touch it.
  const surface = path.join(repo, 'NOTES.md');
  fs.writeFileSync(surface, 'plain surface content\n');
  fs.mkdirSync(path.join(repo, '.ratchet'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.ratchet', 'cold-start.json'),
    JSON.stringify({ surfaces: [{ path: 'NOTES.md' }] }));
  const conn = service([repo]).createConnection();
  const opened = payload(openWorkspace(conn, repo));
  const before = worldSnapshot(repo, [surface]);

  for (const name of ['state', 'ledger', 'receipt']) {
    const read = modern(conn, 'resources/read', { uri: opened.resources[name] });
    assert.strictEqual(read.error, undefined, `${name} must read: ${JSON.stringify(read.error)}`);
    assert.strictEqual(worldSnapshot(repo, [surface]), before, `reading the ${name} resource moved bytes`);
  }

  const calls = [
    ['workspace.scan', { workspaceHandle: opened.workspaceHandle }],
    ['score.confidence', { workspaceHandle: opened.workspaceHandle }],
    ['score.friction', { obstacles: FRICTION_PAYLOAD }],
  ];
  for (const [name, args] of calls) {
    const result = callTool(conn, name, args);
    assert.strictEqual(result.error, undefined, `${name} must answer: ${JSON.stringify(result.error)}`);
    assert.strictEqual(result.result.isError, undefined, `${name}: ${JSON.stringify(result.result)}`);
    assert.strictEqual(worldSnapshot(repo, [surface]), before, `${name} moved bytes`);
  }

  const reopened = payload(openWorkspace(conn, repo));
  assert.strictEqual(reopened.stateRev, opened.stateRev, 'no revision moved either');
  assert.strictEqual(worldSnapshot(repo, [surface]), before, 're-opening an open workspace moved bytes');
});

ok('S18 workspace.scan deep-equals ratchet doctor cold-start --json for the same workspace', () => {
  const repo = initRepo('s18-repo');
  const conn = service([repo]).createConnection();
  const opened = payload(openWorkspace(conn, repo));
  const wire = payload(callTool(conn, 'workspace.scan', { workspaceHandle: opened.workspaceHandle }));
  const cli = JSON.parse(ratchet(repo, ['doctor', 'cold-start', '--json']).stdout);
  assert.deepStrictEqual(wire, cli, 'one domain answer, two surfaces');
  assert.strictEqual(wire.configured, false, 'this fixture declares no project surfaces');
  assert.ok(wire.checks.length > 0 && wire.checks.every((c) => typeof c.detail === 'string'),
    'emptiness is rendered, never omitted');
});

ok('S19 score.confidence deep-equals ratchet score confidence --json once its MCP-only fields are set aside', () => {
  const repo = initRepo('s19-repo');
  const conn = service([repo]).createConnection();
  payload(openWorkspace(conn, repo));

  const snapshot = state.loadState(repo);
  snapshot.objective = 'prove the layers agree across surfaces';
  snapshot.nextAction = 'compare the wire to the CLI';
  snapshot.artifacts = [{ id: 'art-1', title: 'spec', kind: 'spec', status: 'v1', holes: ['one hole'] }];
  snapshot.defects = [{ id: 'def-1', artifact: 'art-1', severity: 'high', status: 'open', title: 'unproven' }];
  state.saveState(repo, snapshot);
  const ledger = state.loadLedger(repo);
  ledger.features = [{ id: 'feat-1', name: 'derived reads', evidence: 'src/mcp/server.js' }];
  state.saveLedger(repo, ledger);

  const opened = payload(openWorkspace(conn, repo));
  const wire = payload(callTool(conn, 'score.confidence', { workspaceHandle: opened.workspaceHandle }));
  const cli = JSON.parse(ratchet(repo, ['score', 'confidence', '--json']).stdout);

  const domain = { ...wire };
  delete domain.stateRev;
  delete domain.journal;
  assert.deepStrictEqual(domain, cli, 'the derived layers and closure are the CLI answer');
  assert.strictEqual(wire.stateRev, state.loadState(repo).rev, 'stateRev names the record it scored');
  assert.strictEqual(wire.stateRev, opened.stateRev, 'and agrees with the handle that was just issued');
  assert.deepStrictEqual(Object.keys(wire),
    ['artifact', 'session', 'ledger', 'closure', 'stateRev', 'journal'],
    'fixed-shape output, same keys every run');
});

ok('S20 score.confidence loads state exactly once — stateRev comes from the scored snapshot', () => {
  // A second load for the revision alone would let a write that landed in
  // between make stateRev describe a record the layers never saw.
  const repo = initRepo('s20-repo');
  const conn = service([repo]).createConnection();
  const opened = payload(openWorkspace(conn, repo));
  // 4b.3: the read path peeks (byte-pure), so the counted loader is peekState —
  // and the resilient, store-creating loadState must not be touched at all.
  const realPeek = state.peekState;
  const realLoad = state.loadState;
  let peeks = 0;
  let loads = 0;
  try {
    state.peekState = function counted(cwd) {
      peeks++;
      return realPeek.call(state, cwd);
    };
    state.loadState = function counted(cwd) {
      loads++;
      return realLoad.call(state, cwd);
    };
    payload(callTool(conn, 'score.confidence', { workspaceHandle: opened.workspaceHandle }));
  } finally {
    state.peekState = realPeek;
    state.loadState = realLoad;
  }
  assert.strictEqual(peeks, 1, `score.confidence read state ${peeks} times; the contract is one snapshot`);
  assert.strictEqual(loads, 0, 'a derived read never touches the creating loader');
});

ok('S21 journal damage is on the wire, not on stderr where no client reads', () => {
  const repo = initRepo('s21-repo');
  const conn = service([repo]).createConnection();
  const opened = payload(openWorkspace(conn, repo));
  const realLog = process.env.RATCHET_EVOLVE_LOG;
  const damaged = path.join(tmp, 's21-damaged.jsonl');
  const good = (id) => JSON.stringify({ id, target: 'x', verdict: 'ASK', timestamp: '2026-07-30T00:00:00.000Z' });
  fs.writeFileSync(damaged, [good('evo_1'), '{not json', good('evo_2'), 'truncated {"a":'].join('\n') + '\n');
  try {
    process.env.RATCHET_EVOLVE_LOG = damaged;
    const wire = payload(callTool(conn, 'score.confidence', { workspaceHandle: opened.workspaceHandle }));
    assert.deepStrictEqual(wire.journal, { counted: 2, malformed: 2 },
      'two events scored, two unreadable lines excluded — and the caller is told');

    process.env.RATCHET_EVOLVE_LOG = path.join(tmp, 's21-absent.jsonl');
    const empty = payload(callTool(conn, 'score.confidence', { workspaceHandle: opened.workspaceHandle }));
    assert.deepStrictEqual(empty.journal, { counted: 0, malformed: 0 },
      'an absent log is stated as zero, never omitted');
  } finally {
    process.env.RATCHET_EVOLVE_LOG = realLog;
  }
});

ok('S22 an escaping cold-start surface is refused by name and never opened', () => {
  const repo = initRepo('s22-repo');
  const outsideDir = fixture('s22-outside');
  const absolute = path.join(outsideDir, 'absolute.md');
  fs.writeFileSync(absolute, 'OUTSIDEPOISON 43 ahead\n');
  fs.writeFileSync(path.join(path.dirname(repo), 's22-sibling.md'), 'OUTSIDEPOISON 43 ahead\n');
  fs.mkdirSync(path.join(repo, '.ratchet'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'inside.md'), 'INSIDEPOISON 43 ahead\n');
  fs.writeFileSync(path.join(repo, '.ratchet', 'cold-start.json'), JSON.stringify({
    surfaces: [
      { path: absolute, checks: ['base-qualified-git'] },
      { path: '../s22-sibling.md', checks: ['base-qualified-git'] },
      { path: 'inside.md', checks: ['base-qualified-git'] },
    ],
  }));

  const conn = service([repo]).createConnection();
  const opened = payload(openWorkspace(conn, repo));
  const seen = [];
  const realRead = fs.readFileSync;
  let wire;
  try {
    fs.readFileSync = function spy(file, ...rest) {
      seen.push(String(file));
      return realRead.call(fs, file, ...rest);
    };
    wire = payload(callTool(conn, 'workspace.scan', { workspaceHandle: opened.workspaceHandle }));
  } finally {
    fs.readFileSync = realRead;
  }

  const escaped = wire.checks.filter((c) => c.detail === 'surface escapes workspace root — not read');
  assert.strictEqual(escaped.length, 2, `both escaping surfaces are named: ${JSON.stringify(wire.checks)}`);
  assert.ok(!JSON.stringify(wire).includes('OUTSIDEPOISON'),
    'a file outside the handle\'s root cannot reach the wire through a check detail');
  assert.ok(!seen.includes(absolute) && !seen.includes(path.join(path.dirname(repo), 's22-sibling.md')),
    `an escaping surface is never opened: ${seen.join(', ')}`);
  const inside = wire.checks.find((c) => c.name.includes('inside.md'));
  assert.strictEqual(inside.level, 'fail', 'a contained surface is still scanned');
  assert.match(inside.detail, /INSIDEPOISON/, 'so the refusal is containment, not blindness');
  assert.strictEqual(wire.configured, true);
});

ok('S23 every handle refusal is one answer, for resources and tools alike', () => {
  const repo = initRepo('s23-repo');
  const server = service([repo]);
  const owner = server.createConnection();
  const stranger = server.createConnection();
  const opened = payload(openWorkspace(owner, repo));
  const foreign = payload(openWorkspace(stranger, repo)).workspaceHandle;
  const doomed = server.createConnection();
  const closedHandle = payload(openWorkspace(doomed, repo)).workspaceHandle;
  doomed.close();

  const refused = [
    ['missing', {}],
    ['non-string', { workspaceHandle: 7 }],
    ['malformed', { workspaceHandle: 'not-a-handle' }],
    ['fabricated', { workspaceHandle: 'A'.repeat(43) }],
    ['foreign connection', { workspaceHandle: foreign }],
    ['closed connection', { workspaceHandle: closedHandle }],
    ['extra argument', { workspaceHandle: opened.workspaceHandle, path: repo }],
    ['no arguments at all', undefined],
  ];
  for (const [label, args] of refused) {
    for (const tool of ['workspace.scan', 'score.confidence']) {
      const response = callTool(owner, tool, args);
      assert.ok(response.error, `${tool} must refuse a ${label} handle, got ${JSON.stringify(response.result)}`);
      assert.strictEqual(response.error.code, -32602, `${tool} · ${label}`);
      assert.strictEqual(response.error.message, 'resource is not available on this connection',
        `${tool} · ${label} must not be distinguishable from any other refusal`);
    }
  }
  // The same handles through the resource door give the identical answer, which
  // is the point of one shared resolveHandle.
  for (const handle of [foreign, closedHandle, 'A'.repeat(43)]) {
    const read = modern(owner, 'resources/read', { uri: `torque://workspace/${handle}/state` });
    assert.strictEqual(read.error.code, -32602);
    assert.strictEqual(read.error.message, 'resource is not available on this connection');
  }
  // And the owner's own handle still works, so the refusals above are the check
  // doing its job rather than the tools being broken.
  assert.ok(payload(callTool(owner, 'workspace.scan', { workspaceHandle: opened.workspaceHandle })).checks.length);
});

ok('S24 score.friction ranks its payload, deep-equals the CLI, and touches no workspace', () => {
  const repo = initRepo('s24-repo');
  const conn = service([repo]).createConnection();
  const before = worldSnapshot(repo);
  const wire = payload(callTool(conn, 'score.friction', { obstacles: FRICTION_PAYLOAD }));
  const cli = JSON.parse(ratchet(repo, ['score', 'friction', JSON.stringify(FRICTION_PAYLOAD), '--json']).stdout);
  assert.deepStrictEqual(wire, cli, 'one ranking, two surfaces');
  assert.strictEqual(wire.winner.name, 'lock contention');
  assert.strictEqual(wire.obstacles[1].name, 'stale docs', 'the obstacle alias still resolves');
  assert.strictEqual(wire.obstacles[1].speed, 9, 'timeToUnblock still resolves');
  assert.strictEqual(wire.obstacles[1].risk, 2, 'riskOfIgnoring still resolves');
  assert.ok(wire.scope.includes('unlisted'), 'the ranking names what it cannot see');
  assert.strictEqual(worldSnapshot(repo), before,
    'a payload-only tool never opened a workspace, so nothing moved');
  // No handle was ever minted on this connection, and none is needed.
  assert.strictEqual(worldSnapshot(repo).includes('state.json'), false, 'no store was created either');
});

ok('S24b decimal factors flow through to a fractional margin, and the schema says number', () => {
  // Factors are clamped, never rounded, so this valid input MUST produce a
  // non-integer margin — which is why the advertised schema says number, not
  // integer. Written red against a descriptor that claimed integer|null.
  const conn = service([fixture('s24b-root')]).createConnection();
  const wire = payload(callTool(conn, 'score.friction', {
    obstacles: [
      { name: 'a', leverage: 2.5, certainty: 2, speed: 2, risk: 2 },
      { name: 'b', leverage: 2, certainty: 2, speed: 2, risk: 2 },
    ],
  }));
  assert.strictEqual(wire.winner.name, 'a');
  assert.strictEqual(wire.margin, 4, '2.5·2·2·2 − 2·2·2·2 = 20 − 16');
  const half = payload(callTool(conn, 'score.friction', {
    obstacles: [
      { name: 'a', leverage: 2.2, certainty: 2, speed: 2, risk: 2 },
      { name: 'b', leverage: 2, certainty: 2, speed: 2, risk: 2 },
    ],
  }));
  assert.ok(!Number.isInteger(half.margin) && half.margin > 0,
    `a fractional margin is a valid result (got ${half.margin})`);
  const listed = modern(conn, 'tools/list');
  const friction = listed.result.tools.find((tool) => tool.name === 'score.friction');
  assert.deepStrictEqual(friction.outputSchema.properties.margin.type, ['number', 'null'],
    'the advertised type admits the results the domain actually returns');
});

ok('S25 malformed score.friction arguments are refused at the boundary, not normalized', () => {
  const conn = service([fixture('s25-root')]).createConnection();
  const bad = [
    undefined,
    {},
    { obstacles: 'not an array' },
    { obstacles: [null] },
    { obstacles: ['a string'] },
    { obstacles: [{ name: 'x', leverage: 5, unknownField: 1 }] },
    { obstacles: [], extra: true },
  ];
  for (const args of bad) {
    const response = callTool(conn, 'score.friction', args);
    assert.ok(response.error, `refused: ${JSON.stringify(args)}`);
    assert.strictEqual(response.error.code, -32602);
    assert.match(response.error.message, /^score\.friction takes one argument/);
  }
  // A factor outside 1..10 is domain normalization, not a boundary error.
  const clamped = payload(callTool(conn, 'score.friction', {
    obstacles: [{ name: 'x', leverage: 99, certainty: 0, speed: 5, risk: 5 }],
  }));
  assert.strictEqual(clamped.obstacles[0].leverage, 10);
  assert.strictEqual(clamped.obstacles[0].certainty, 1);
});

ok('S26 every advertised tool is dispatchable, and only advertised tools are', () => {
  const repo = initRepo('s26-repo');
  const conn = service([repo]).createConnection();
  const advertised = modern(conn, 'tools/list').result.tools.map((tool) => tool.name);
  for (const name of advertised) {
    const response = callTool(conn, name, {});
    const message = (response.error && response.error.message) || '';
    assert.ok(!/^unknown tool/.test(message),
      `${name} is advertised but has no handler behind it`);
  }
  for (const name of ['workspace.delete', 'score.aperture', 'status', 'defect.list', 'workspace.scan ']) {
    const response = callTool(conn, name, {});
    assert.strictEqual(response.error.code, -32602, `${name} is not a tool`);
    assert.match(response.error.message, /^unknown tool: /);
  }
});

ok('S27 the legacy era serves the derived tools with legacy wire shape', () => {
  const repo = initRepo('s27-repo');
  const conn = service([repo]).createConnection();
  initialize(conn);
  const listed = legacy(conn, 'tools/list');
  assert.deepStrictEqual(
    listed.result.tools.map((tool) => tool.name),
    ['workspace.open', 'workspace.scan', 'score.confidence', 'score.friction']
  );
  assert.strictEqual(listed.result.ttlMs, undefined, 'legacy carries no modern cache metadata');

  const opened = payload(openWorkspace(conn, repo, 'legacy'));
  const before = worldSnapshot(repo);
  const scan = payload(callTool(conn, 'workspace.scan', { workspaceHandle: opened.workspaceHandle }, 'legacy'));
  const confidence = payload(callTool(conn, 'score.confidence', { workspaceHandle: opened.workspaceHandle }, 'legacy'));
  const friction = payload(callTool(conn, 'score.friction', { obstacles: FRICTION_PAYLOAD }, 'legacy'));
  assert.ok(Array.isArray(scan.checks) && scan.checks.length);
  assert.strictEqual(confidence.stateRev, opened.stateRev);
  assert.strictEqual(friction.winner.name, 'lock contention');
  assert.strictEqual(worldSnapshot(repo), before, 'legacy reads move nothing either');
});

ok('S28 a store conflict is a named, actionable refusal that carries no server path', () => {
  const message = mcp.safeOpenError(Object.assign(new Error('two records'), { code: 'ERATCHETSTORECONFLICT' }));
  assert.strictEqual(message,
    'workspace store has conflicting project records — operator must merge or delete one');
  assert.notStrictEqual(message, mcp.safeOpenError(new Error('anything else')),
    'the conflict no longer collapses into the generic open failure');
  assert.ok(!/[\\/]/.test(message), 'and it names no path');

  if (process.platform !== 'win32') {
    process.stdout.write('        (skipped the end-to-end collision: slug casing conflicts are win32-only)\n');
    return;
  }
  // The real thing: two store records for one project, reached through the tool.
  const repo = initRepo('S28-Repo-MixedCase');
  const projects = path.join(process.env.RATCHET_DATA_DIR, 'projects');
  for (const slug of [state.legacySlugFor(repo), state.normalizedSlugFor(repo)]) {
    fs.mkdirSync(path.join(projects, slug), { recursive: true });
  }
  const conn = service([repo]).createConnection();
  const response = openWorkspace(conn, repo);
  assert.strictEqual(response.result.isError, true, 'a conflicted store issues no handle');
  assert.strictEqual(response.result.structuredContent, undefined);
  assert.strictEqual(response.result.content[0].text,
    'workspace store has conflicting project records — operator must merge or delete one');
});

fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
process.stdout.write(`\n${passed} passed, ${failures.length} failed\n`);
if (failures.length) process.exitCode = 1;
