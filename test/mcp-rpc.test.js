'use strict';

// Zero-dependency contract suite for the Torque MCP RPC kernel (build-order step 1).
// Run: node test/mcp-rpc.test.js
// The kernel is pure — no state, no filesystem — but the isolation prelude stays so
// a future require-chain that reaches state.js can never touch a real .ratchet/.

const os = require('os');
const path = require('path');
const fs = require('fs');
const assert = require('assert');
const { PassThrough } = require('stream');

const tmp = path.join(os.tmpdir(), 'ratchet-mcp-test-' + process.pid);
fs.rmSync(tmp, { recursive: true, force: true });
fs.mkdirSync(tmp, { recursive: true });
process.env.RATCHET_DATA_DIR = tmp;
process.env.RATCHET_EVOLVE_LOG = path.join(tmp, 'evolve-log.jsonl');

const rpc = require('../src/mcp/rpc');
const stdio = require('../src/mcp/stdio');

let passed = 0;
const failures = [];
// Record-and-continue, like the concurrency suite: one red must not hide the
// others when an attack round lands a batch of falsifiers at once.
function ok(name, fn) {
  try {
    fn();
    passed++;
    process.stdout.write(`  ok  ${name}\n`);
  } catch (e) {
    failures.push(name);
    process.stdout.write(`  FAIL  ${name}\n        ${e && e.message ? e.message : e}\n`);
  }
}

const META = 'io.modelcontextprotocol/';
const MODERN = '2026-07-28';
const LEGACY = '2025-11-25';

function kernel(extraMethods) {
  return rpc.createKernel({
    serverInfo: { name: 'torque-mcp-test', version: '0.0.0' },
    capabilities: { tools: {} },
    methods: extraMethods || {},
  });
}

function modernMeta(version) {
  return {
    [META + 'protocolVersion']: version || MODERN,
    [META + 'clientCapabilities']: {},
    [META + 'clientInfo']: { name: 'test-client', version: '0' },
  };
}

// --- envelope ---------------------------------------------------------------

ok('unparseable input answers -32700 with a null id', () => {
  const conn = kernel().createConnection();
  const res = conn.handleMessage('{nope');
  assert.strictEqual(res.jsonrpc, '2.0');
  assert.strictEqual(res.id, null);
  assert.strictEqual(res.error.code, -32700);
});

ok('a non-2.0 envelope is refused as invalid, not dispatched', () => {
  const conn = kernel().createConnection();
  const res = conn.handleMessage({ jsonrpc: '1.0', id: 1, method: 'server/discover' });
  assert.strictEqual(res.error.code, -32600);
  assert.strictEqual(conn.era(), null, 'a refused envelope must not pin an era');
});

ok('a batch array is refused by name — MCP removed batching', () => {
  const conn = kernel().createConnection();
  const res = conn.handleMessage(JSON.stringify([{ jsonrpc: '2.0', id: 1, method: 'server/discover' }]));
  assert.strictEqual(res.error.code, -32600);
  assert.match(res.error.message, /batch/i);
});

// --- modern era: server/discover -------------------------------------------

ok('server/discover advertises versions, capabilities, identity — and pins modern', () => {
  const conn = kernel().createConnection();
  const res = conn.handleMessage({ jsonrpc: '2.0', id: 1, method: 'server/discover' });
  assert.strictEqual(res.error, undefined, res.error && res.error.message);
  assert.deepStrictEqual(res.result.protocolVersions, [MODERN, LEGACY]);
  assert.deepStrictEqual(res.result.serverInfo, { name: 'torque-mcp-test', version: '0.0.0' });
  assert.ok(res.result.capabilities, 'capabilities must be advertised');
  assert.strictEqual(res.result.resultType, 'complete');
  assert.strictEqual(conn.era(), 'modern');
});

ok('a modern result carries resultType and serverInfo in _meta on every response', () => {
  const conn = kernel({
    'echo/params': { eras: ['modern'], handler: (params) => ({ got: params.x }) },
  }).createConnection();
  const res = conn.handleMessage({
    jsonrpc: '2.0', id: 2, method: 'echo/params', params: { x: 7, _meta: modernMeta() },
  });
  assert.strictEqual(res.result.got, 7);
  assert.strictEqual(res.result.resultType, 'complete');
  assert.deepStrictEqual(res.result._meta[META + 'serverInfo'], { name: 'torque-mcp-test', version: '0.0.0' });
});

ok('a handler-declared resultType is honored, never overwritten', () => {
  const conn = kernel({
    'echo/interim': { eras: ['modern'], handler: () => ({ resultType: 'input_required', inputRequests: [] }) },
  }).createConnection();
  const res = conn.handleMessage({
    jsonrpc: '2.0', id: 3, method: 'echo/interim', params: { _meta: modernMeta() },
  });
  assert.strictEqual(res.result.resultType, 'input_required');
});

ok('a modern request without a protocol version is refused -32022 naming both doors', () => {
  const conn = kernel({
    'echo/params': { eras: ['modern'], handler: () => ({}) },
  }).createConnection();
  const res = conn.handleMessage({ jsonrpc: '2.0', id: 4, method: 'echo/params', params: {} });
  assert.strictEqual(res.error.code, -32022);
  assert.match(res.error.message, /2026-07-28/);
  assert.match(res.error.message, /initialize/);
  assert.strictEqual(conn.era(), null, 'a refused version must not pin an era');
});

ok('an unsupported protocol version is refused -32022 and names what is supported', () => {
  const conn = kernel({
    'echo/params': { eras: ['modern'], handler: () => ({}) },
  }).createConnection();
  const res = conn.handleMessage({
    jsonrpc: '2.0', id: 5, method: 'echo/params', params: { _meta: modernMeta('2031-01-01') },
  });
  assert.strictEqual(res.error.code, -32022);
  assert.match(res.error.message, /2031-01-01/);
  assert.match(res.error.message, /2026-07-28/);
});

ok('modern is stateless: EVERY request re-proves its version, not just the first', () => {
  const conn = kernel({
    'echo/params': { eras: ['modern'], handler: () => ({}) },
  }).createConnection();
  const first = conn.handleMessage({
    jsonrpc: '2.0', id: 6, method: 'echo/params', params: { _meta: modernMeta() },
  });
  assert.strictEqual(first.error, undefined);
  const second = conn.handleMessage({ jsonrpc: '2.0', id: 7, method: 'echo/params', params: {} });
  assert.strictEqual(second.error.code, -32022, 'a pinned-modern connection must still refuse a versionless request');
});

// --- legacy era: initialize -------------------------------------------------

ok('initialize answers the legacy handshake shape and pins legacy', () => {
  const conn = kernel().createConnection();
  const res = conn.handleMessage({
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: LEGACY, capabilities: {}, clientInfo: { name: 'c', version: '1' } },
  });
  assert.strictEqual(res.result.protocolVersion, LEGACY);
  assert.deepStrictEqual(res.result.serverInfo, { name: 'torque-mcp-test', version: '0.0.0' });
  assert.ok(res.result.capabilities);
  assert.strictEqual(res.result.resultType, undefined, 'legacy results predate resultType — the kernel must not leak modern fields');
  assert.strictEqual(conn.era(), 'legacy');
});

ok('an unknown requested legacy version is answered with our newest legacy version', () => {
  const conn = kernel().createConnection();
  const res = conn.handleMessage({
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2024-01-01', capabilities: {}, clientInfo: { name: 'c', version: '1' } },
  });
  assert.strictEqual(res.result.protocolVersion, LEGACY);
});

ok('a second initialize on the same connection is refused by name', () => {
  const conn = kernel().createConnection();
  conn.handleMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: LEGACY } });
  const res = conn.handleMessage({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: LEGACY } });
  assert.strictEqual(res.error.code, -32600);
  assert.match(res.error.message, /already/i);
});

ok('notifications/initialized is accepted silently on a legacy connection', () => {
  const conn = kernel().createConnection();
  conn.handleMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: LEGACY } });
  const res = conn.handleMessage({ jsonrpc: '2.0', method: 'notifications/initialized' });
  assert.strictEqual(res, null, 'a notification produces no response');
});

// --- era pinning: never mixed -----------------------------------------------

ok('initialize after server/discover is refused — eras never mix', () => {
  const conn = kernel().createConnection();
  conn.handleMessage({ jsonrpc: '2.0', id: 1, method: 'server/discover' });
  const res = conn.handleMessage({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: LEGACY } });
  assert.strictEqual(res.error.code, rpc.ERR_ERA_PINNED);
  assert.match(res.error.message, /modern/);
  assert.match(res.error.message, /reconnect/i, 'the refusal must hand the client its remedy');
});

ok('server/discover after initialize is refused — eras never mix', () => {
  const conn = kernel().createConnection();
  conn.handleMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: LEGACY } });
  const res = conn.handleMessage({ jsonrpc: '2.0', id: 2, method: 'server/discover' });
  assert.strictEqual(res.error.code, rpc.ERR_ERA_PINNED);
  assert.match(res.error.message, /legacy/);
});

ok('a method that only exists in the other era is an era refusal, not a -32601', () => {
  const conn = kernel({
    'modern/only': { eras: ['modern'], handler: () => ({}) },
  }).createConnection();
  conn.handleMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: LEGACY } });
  const res = conn.handleMessage({ jsonrpc: '2.0', id: 2, method: 'modern/only', params: {} });
  assert.strictEqual(res.error.code, rpc.ERR_ERA_PINNED, 'the method exists — pretending it does not would misname the boundary');
  assert.match(res.error.message, /legacy/);
});

ok('a method in neither era is a plain -32601', () => {
  const conn = kernel().createConnection();
  conn.handleMessage({ jsonrpc: '2.0', id: 1, method: 'server/discover' });
  const res = conn.handleMessage({ jsonrpc: '2.0', id: 2, method: 'no/such', params: { _meta: modernMeta() } });
  assert.strictEqual(res.error.code, -32601);
});

ok('an era refusal executes zero handler code', () => {
  let ran = 0;
  const conn = kernel({
    'modern/only': { eras: ['modern'], handler: () => { ran++; return {}; } },
  }).createConnection();
  conn.handleMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: LEGACY } });
  conn.handleMessage({ jsonrpc: '2.0', id: 2, method: 'modern/only', params: {} });
  assert.strictEqual(ran, 0);
});

// --- handler failure --------------------------------------------------------

ok('a throwing handler is a -32603 that never kills the connection', () => {
  const conn = kernel({
    'boom/now': { eras: ['modern'], handler: () => { throw new Error('kaboom'); } },
  }).createConnection();
  const res = conn.handleMessage({ jsonrpc: '2.0', id: 1, method: 'boom/now', params: { _meta: modernMeta() } });
  assert.strictEqual(res.error.code, -32603);
  const after = conn.handleMessage({ jsonrpc: '2.0', id: 2, method: 'server/discover' });
  assert.strictEqual(after.error, undefined, 'the connection must survive a handler crash');
});

ok('a handler-thrown rpc error keeps its own code and message', () => {
  const conn = kernel({
    'refuse/me': { eras: ['modern'], handler: () => { throw rpc.rpcError(-32602, 'params scope: missing target'); } },
  }).createConnection();
  const res = conn.handleMessage({ jsonrpc: '2.0', id: 1, method: 'refuse/me', params: { _meta: modernMeta() } });
  assert.strictEqual(res.error.code, -32602);
  assert.match(res.error.message, /missing target/);
});

ok('a handler returning a non-object is a -32603, not a dead connection', () => {
  const conn = kernel({
    'bad/null': { eras: ['modern'], handler: () => null },
    'bad/scalar': { eras: ['modern'], handler: () => 42 },
  }).createConnection();
  const a = conn.handleMessage({ jsonrpc: '2.0', id: 1, method: 'bad/null', params: { _meta: modernMeta() } });
  assert.strictEqual(a.error.code, -32603);
  const b = conn.handleMessage({ jsonrpc: '2.0', id: 2, method: 'bad/scalar', params: { _meta: modernMeta() } });
  assert.strictEqual(b.error.code, -32603);
  const after = conn.handleMessage({ jsonrpc: '2.0', id: 3, method: 'server/discover' });
  assert.strictEqual(after.error, undefined, 'the connection must survive a bad handler result');
});

ok('decoration never mutates the object a handler returned', () => {
  const shared = Object.freeze({ answer: 1 });
  const conn = kernel({
    'share/frozen': { eras: ['modern'], handler: () => shared },
  }).createConnection();
  const res = conn.handleMessage({ jsonrpc: '2.0', id: 1, method: 'share/frozen', params: { _meta: modernMeta() } });
  assert.strictEqual(res.result.answer, 1);
  assert.strictEqual(res.result.resultType, 'complete');
  assert.strictEqual(shared.resultType, undefined, 'the handler object must stay untouched');
});

// --- stdio framing ----------------------------------------------------------

ok('stdio adapter frames newline-delimited JSON, including split and coalesced chunks', () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const lines = [];
  output.on('data', (chunk) => lines.push(...String(chunk).split('\n').filter((l) => l.length)));
  stdio.attach(kernel(), { input, output });
  const msg = (id) => JSON.stringify({ jsonrpc: '2.0', id, method: 'server/discover' });
  // Two messages in one chunk, then one message split across two chunks.
  input.write(msg(1) + '\n' + msg(2) + '\n');
  const third = msg(3) + '\n';
  input.write(third.slice(0, 10));
  input.write(third.slice(10));
  const parsed = lines.map((l) => JSON.parse(l));
  assert.deepStrictEqual(parsed.map((r) => r.id), [1, 2, 3]);
  for (const r of parsed) assert.strictEqual(r.error, undefined);
});

ok('stdio adapter answers a garbage line with -32700 instead of dying', () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const lines = [];
  output.on('data', (chunk) => lines.push(...String(chunk).split('\n').filter((l) => l.length)));
  stdio.attach(kernel(), { input, output });
  input.write('this is not json\n');
  input.write(JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'server/discover' }) + '\n');
  const parsed = lines.map((l) => JSON.parse(l));
  assert.strictEqual(parsed[0].error.code, -32700);
  assert.strictEqual(parsed[1].id, 9);
  assert.strictEqual(parsed[1].error, undefined);
});

ok('stdio adapter refuses a line past the cap instead of buffering it forever', () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const lines = [];
  output.on('data', (chunk) => lines.push(...String(chunk).split('\n').filter((l) => l.length)));
  stdio.attach(kernel(), { input, output, maxLineBytes: 64 });
  // A byte stream has no message boundaries: everything up to the next newline
  // is ONE line, so the refusal fires once and the rest of the line is discarded.
  input.write('x'.repeat(200)); // no newline — an honest client never does this
  input.write('y'.repeat(200)); // still the same oversized line; no second refusal
  input.write('\n'); // the line finally ends
  input.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'server/discover' }) + '\n');
  const parsed = lines.map((l) => JSON.parse(l));
  assert.strictEqual(parsed.length, 2, 'one refusal for the whole oversized line, one real answer');
  assert.strictEqual(parsed[0].error.code, -32700);
  assert.match(parsed[0].error.message, /64/, 'the refusal must name the cap');
  assert.strictEqual(parsed[1].id, 1, 'the connection must survive the oversized line');
  assert.strictEqual(parsed[1].error, undefined);
});

// --- Codex attack round 1 (2026-07-29) — one falsifier per accepted finding --
// Finding 2 (server/discover skips version validation) was RULED a design
// decision, not a defect: discover is the door a client knocks to learn what
// versions exist, and demanding proof of a version before answering that
// question is circular. The earlier discover tests codify the ruling.

ok('C1 a legacy connection refuses a request carrying the modern protocol marker', () => {
  const conn = kernel({
    'dual/method': { eras: ['modern', 'legacy'], handler: () => ({ ran: true }) },
  }).createConnection();
  conn.handleMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: LEGACY } });
  const res = conn.handleMessage({
    jsonrpc: '2.0', id: 2, method: 'dual/method', params: { _meta: modernMeta() },
  });
  assert.strictEqual(res.error && res.error.code, rpc.ERR_ERA_PINNED,
    'a modern-marked request executing under legacy IS a mixed connection');
  assert.match(res.error.message, /legacy/);
});

ok('C3 a notification-shaped handshake pins nothing — silently poisoning the era is worse than dropping', () => {
  const a = kernel().createConnection();
  a.handleMessage({ jsonrpc: '2.0', method: 'initialize', params: { protocolVersion: LEGACY } });
  assert.strictEqual(a.era(), null, 'an initialize with no id cannot complete a handshake');
  const discover = a.handleMessage({ jsonrpc: '2.0', id: 1, method: 'server/discover' });
  assert.strictEqual(discover.error, undefined, 'the connection must still be free to pin modern');
  const b = kernel().createConnection();
  b.handleMessage({ jsonrpc: '2.0', method: 'server/discover' });
  assert.strictEqual(b.era(), null, 'a discover with no id pins nothing either');
  const init = b.handleMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: LEGACY } });
  assert.strictEqual(init.error, undefined, 'the connection must still be free to pin legacy');
});

ok('C4 an id outside string/number/null is -32600 and never dispatched', () => {
  const conn = kernel().createConnection();
  const res = conn.handleMessage({ jsonrpc: '2.0', id: { bad: 1 }, method: 'server/discover' });
  assert.strictEqual(res.error.code, -32600);
  assert.strictEqual(res.id, null, 'an unusable id cannot be echoed');
  assert.strictEqual(conn.era(), null, 'a refused envelope must not pin');
  const zero = conn.handleMessage({ jsonrpc: '2.0', id: 0, method: 'server/discover' });
  assert.strictEqual(zero.error, undefined, 'id 0 is a legal id, not a notification');
  assert.strictEqual(zero.id, 0);
});

ok('C5 a result whose getter throws is a -32603, not a dead connection', () => {
  const conn = kernel({
    'trap/get': {
      eras: ['modern'],
      handler: () => Object.defineProperty({}, 'answer', { enumerable: true, get() { throw new Error('getter boom'); } }),
    },
  }).createConnection();
  const res = conn.handleMessage({ jsonrpc: '2.0', id: 1, method: 'trap/get', params: { _meta: modernMeta() } });
  assert.strictEqual(res.error.code, -32603);
  const after = conn.handleMessage({ jsonrpc: '2.0', id: 2, method: 'server/discover' });
  assert.strictEqual(after.error, undefined);
});

ok('C6 an unserializable result answers -32603 on the wire instead of killing the stream', () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const lines = [];
  output.on('data', (chunk) => lines.push(...String(chunk).split('\n').filter((l) => l.length)));
  stdio.attach(kernel({
    'big/int': { eras: ['modern'], handler: () => ({ n: 1n }) },
  }), { input, output });
  input.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'big/int', params: { _meta: modernMeta() } }) + '\n');
  input.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'server/discover' }) + '\n');
  const parsed = lines.map((l) => JSON.parse(l));
  assert.strictEqual(parsed[0].error.code, -32603);
  assert.strictEqual(parsed[1].id, 2, 'the stream must survive the unserializable result');
  assert.strictEqual(parsed[1].error, undefined);
});

ok('C7 a multi-byte character split across chunks arrives intact', () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const lines = [];
  output.on('data', (chunk) => lines.push(...String(chunk).split('\n').filter((l) => l.length)));
  stdio.attach(kernel({
    'echo/text': { eras: ['modern'], handler: (params) => ({ text: params.text }) },
  }), { input, output });
  const wire = Buffer.from(JSON.stringify({
    jsonrpc: '2.0', id: 1, method: 'echo/text', params: { text: 'A€B', _meta: modernMeta() },
  }) + '\n');
  const cut = wire.indexOf(0xe2) + 1; // split inside the euro sign's three bytes
  input.write(wire.subarray(0, cut));
  input.write(wire.subarray(cut));
  const res = JSON.parse(lines[0]);
  assert.strictEqual(res.result.text, 'A€B', 'String(chunk) on a mid-codepoint cut corrupts the text');
});

ok('C8 a COMPLETE line over the cap is refused too — the cap is per line, not per stall', () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const lines = [];
  output.on('data', (chunk) => lines.push(...String(chunk).split('\n').filter((l) => l.length)));
  stdio.attach(kernel(), { input, output, maxLineBytes: 16 });
  input.write(JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'server/discover' }) + '\n');
  const res = JSON.parse(lines[0]);
  assert.strictEqual(res.error.code, -32700);
  assert.match(res.error.message, /16/);
});

ok('C9 a modern request without clientCapabilities is refused naming the missing key', () => {
  const conn = kernel({
    'echo/params': { eras: ['modern'], handler: () => ({}) },
  }).createConnection();
  const res = conn.handleMessage({
    jsonrpc: '2.0', id: 1, method: 'echo/params',
    params: { _meta: { [META + 'protocolVersion']: MODERN } },
  });
  assert.strictEqual(res.error.code, -32602);
  assert.match(res.error.message, /clientCapabilities/);
});

ok('C10 initialize with null or shapeless params refuses -32602 and pins nothing', () => {
  const conn = kernel().createConnection();
  const bad = conn.handleMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: null });
  assert.strictEqual(bad.error.code, -32602);
  assert.strictEqual(conn.era(), null, 'a refused handshake must not pin');
  const good = conn.handleMessage({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: LEGACY } });
  assert.strictEqual(good.error, undefined, 'the connection is still free to initialize properly');
});

ok('C11 Object.prototype members are not registered methods', () => {
  for (const name of ['constructor', '__proto__', 'hasOwnProperty', 'toString']) {
    const conn = kernel().createConnection();
    const res = conn.handleMessage({
      jsonrpc: '2.0', id: 1, method: name, params: { _meta: modernMeta() },
    });
    assert.strictEqual(res.error && res.error.code, -32601, `${name} must be method-not-found, not a dispatch`);
  }
});

ok('C12 version re-proof comes before method resolution — a wrong version never reaches -32601', () => {
  const conn = kernel({
    'echo/params': { eras: ['modern'], handler: () => ({}) },
  }).createConnection();
  conn.handleMessage({ jsonrpc: '2.0', id: 1, method: 'echo/params', params: { _meta: modernMeta() } });
  const res = conn.handleMessage({
    jsonrpc: '2.0', id: 2, method: 'no/such', params: { _meta: modernMeta('WRONG') },
  });
  assert.strictEqual(res.error.code, -32022, 'the stateless contract outranks method lookup');
});

ok('C14 notifications/initialized moves no era, anywhere', () => {
  const legacy = kernel().createConnection();
  legacy.handleMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: LEGACY } });
  assert.strictEqual(legacy.handleMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
  assert.strictEqual(legacy.era(), 'legacy');
  const modern = kernel().createConnection();
  modern.handleMessage({ jsonrpc: '2.0', id: 1, method: 'server/discover' });
  assert.strictEqual(modern.handleMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
  assert.strictEqual(modern.era(), 'modern', 'a dropped legacy notification must not unpin or flip modern');
  const unpinned = kernel().createConnection();
  assert.strictEqual(unpinned.handleMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
  assert.strictEqual(unpinned.era(), null);
});

ok('C15 the second-initialize refusal hands the client its remedy', () => {
  const conn = kernel().createConnection();
  conn.handleMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: LEGACY } });
  const res = conn.handleMessage({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: LEGACY } });
  assert.match(res.error.message, /reconnect/i);
});

process.stdout.write(`\n${passed} passed, ${failures.length} failed\n`);
if (failures.length) process.exitCode = 1;
