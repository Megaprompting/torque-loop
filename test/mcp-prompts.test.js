'use strict';

// Torque MCP build-order step 3a: the canonical prompts as an MCP prompt surface.
// Run: node test/mcp-prompts.test.js
//
// The invariant this suite defends:
//   THE WIRE SURFACE IS A READOUT OF reference/PROMPTS.md, NOT A SECOND COPY OF IT.
//   The prompts are generated at build time (scripts/prompts-gen.js) and the
//   committed artifact is byte-matched by plugin-shape, so a prompt cannot be
//   edited into the server without editing the source it claims to serve. What is
//   proven here is the other half: the generator refuses an ambiguous section
//   instead of quietly dropping it, and the runtime refuses an unfilled template
//   instead of shipping a prompt with a hole in it.
//
// Written RED first against an absent module.
// Traced by: claude-opus-5
// Traced by: openai-codex-gpt-5

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.realpathSync.native(
  fs.mkdtempSync(path.join(os.tmpdir(), 'ratchet-mcp-prompts-test-'))
);
process.env.RATCHET_DATA_DIR = path.join(tmp, 'state');
process.env.RATCHET_EVOLVE_LOG = path.join(tmp, 'evolve-log.jsonl');

const promptsGen = require('../scripts/prompts-gen');
const prompts = require('../src/mcp/prompts');
const mcp = require('../src/mcp/server');

const META = 'io.modelcontextprotocol/';
const MODERN = '2026-07-28';
const LEGACY = '2025-11-25';

// The 16 commands PROMPTS.md declares, written out rather than re-derived: a test
// that parses the source the same way the generator does would pass on the same
// mistake twice (convention 14).
const EXPECTED = [
  'ignite', 'lock', 'map', 'auction', 'cut', 'mechanism', 'attack', 'build',
  'verify', 'patch', 'decide', 'burn', 'compile', 'push', 'repo-audit', 'prompt-audit',
];

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

// A refusal is only evidence if it is the refusal we asked for: a test that
// accepts any throw passes when the module breaks for an unrelated reason.
function refuses(fn, code, needle, why) {
  let err = null;
  try {
    fn();
  } catch (e) {
    err = e;
  }
  assert.ok(err, `${why} — expected a refusal, got none`);
  assert.ok(err.rpc, `${why} — refused without an rpc code: ${err.message}`);
  assert.strictEqual(err.rpc.code, code, `${why} — refused with ${err.rpc.code}: ${err.message}`);
  assert.ok(err.message.includes(needle), `${why} — refused for the wrong reason: ${err.message}`);
  return err;
}

let fixtureNumber = 0;
function fixture(label) {
  const dir = path.join(tmp, `${label}-${fixtureNumber++}`);
  fs.mkdirSync(dir, { recursive: true });
  return fs.realpathSync.native(dir);
}

function service(label) {
  return mcp.createServer({
    roots: [fixture(label)],
    serverInfo: { name: 'torque-mcp-test', version: '0.0.0' },
  });
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
        [META + 'clientInfo']: { name: 'prompts-client', version: '0' },
      },
    },
  });
}

function legacyConnection(label) {
  const conn = service(label).createConnection({});
  const init = conn.handleMessage({
    jsonrpc: '2.0',
    id: ++requestId,
    method: 'initialize',
    params: {
      protocolVersion: LEGACY,
      capabilities: {},
      clientInfo: { name: 'prompts-client', version: '0' },
    },
  });
  assert.strictEqual(init.error, undefined, 'the legacy handshake must succeed');
  return conn;
}

function legacy(conn, method, params) {
  return conn.handleMessage({
    jsonrpc: '2.0',
    id: ++requestId,
    method,
    params: params || {},
  });
}

function answer(response) {
  assert.strictEqual(response.error, undefined, response.error && response.error.message);
  return response.result;
}

// ---------------------------------------------------------------------------
// Coverage: what the source declares is exactly what the surface serves.
// ---------------------------------------------------------------------------

ok('P1 every prompt section in PROMPTS.md becomes a prompt, and the map table does not', () => {
  const listed = prompts.list().prompts;
  assert.deepStrictEqual(listed.map((p) => p.name), EXPECTED,
    'the served set is the 16 declared commands, in source order');

  // The map table is a `## ` section too. It carries no prompt body, so serving
  // it would mean serving a table of contents as if it were a prompt.
  for (const p of listed) {
    assert.ok(!/Command .. prompt map/.test(p.title || ''),
      `the command↔prompt map is not a prompt: ${p.title}`);
    assert.ok(p.body === undefined, 'list() advertises prompts, it does not ship their bodies');
  }
});

ok('P2 the Software QA prompt keeps its second command as an alias, not a second prompt', () => {
  // One section, two commands. The extra command has to go somewhere visible or
  // /ratchet:qa-ledger silently stops having a canonical prompt on the wire.
  const listed = prompts.list().prompts;
  const audit = listed.find((p) => p.name === 'repo-audit');
  assert.ok(audit, 'repo-audit is served');
  assert.ok(audit.description.includes('/ratchet:qa-ledger'),
    `the alias command is named in the description: ${audit.description}`);
  assert.strictEqual(listed.filter((p) => p.name === 'qa-ledger').length, 0,
    'one section is one prompt, even when two commands implement it');
});

ok('P3 arguments are derived from the placeholders actually in the body', () => {
  const byName = new Map(prompts.list().prompts.map((p) => [p.name, p]));
  assert.deepStrictEqual(byName.get('lock').arguments.map((a) => a.name), ['context']);
  assert.deepStrictEqual(byName.get('auction').arguments.map((a) => a.name), ['target']);
  assert.deepStrictEqual(byName.get('patch').arguments.map((a) => a.name), ['artifact', 'failures']);
  assert.deepStrictEqual(byName.get('build').arguments.map((a) => a.name), ['context', 'outcome']);
  for (const p of prompts.list().prompts) {
    for (const arg of p.arguments) {
      assert.strictEqual(arg.required, true, `${p.name}.${arg.name} is required`);
    }
  }
});

// ---------------------------------------------------------------------------
// The wire surface.
// ---------------------------------------------------------------------------

ok('P4 prompts/list is deterministic and identical across two connections', () => {
  const server = service('p4');
  const a = answer(modern(server.createConnection({}), 'prompts/list'));
  const b = answer(modern(server.createConnection({}), 'prompts/list'));
  assert.deepStrictEqual(a, b, 'a second connection sees the same list');
  assert.strictEqual(JSON.stringify(a), JSON.stringify(b), 'byte-for-byte, including order');
  assert.strictEqual(a.prompts.length, EXPECTED.length);
});

ok('P5 prompts/get substitutes the supplied argument and leaves no placeholder behind', () => {
  const conn = service('p5').createConnection({});
  const got = answer(modern(conn, 'prompts/get', {
    name: 'lock',
    arguments: { context: 'the release branch is red' },
  }));
  const text = got.messages[0].content.text;
  assert.strictEqual(got.messages[0].role, 'user');
  assert.strictEqual(got.messages[0].content.type, 'text');
  assert.ok(text.includes('the release branch is red'), 'the value landed in the body');
  assert.ok(!text.includes('[PASTE CONTEXT]'), 'the placeholder is gone');
  assert.strictEqual(text.indexOf('['), -1,
    `no bracketed placeholder survives in a fully-argumented prompt: ${text}`);
});

ok('P6 an argument value is inserted literally, never read as a replacement pattern', () => {
  // The reason substitution is split/join and not String.replace: `$&` and `$1`
  // in a client-supplied value would otherwise rewrite themselves.
  const conn = service('p6').createConnection({});
  const value = 'cost $5 for $& and $1 and $`';
  const text = answer(modern(conn, 'prompts/get', {
    name: 'lock', arguments: { context: value },
  })).messages[0].content.text;
  assert.ok(text.includes(value), `the value survives verbatim: ${text}`);
});

ok('P7 an unknown prompt name is refused', () => {
  const conn = service('p7').createConnection({});
  const res = modern(conn, 'prompts/get', { name: 'not-a-prompt', arguments: {} });
  assert.ok(res.error, `expected a refusal, got ${JSON.stringify(res.result)}`);
  assert.strictEqual(res.error.code, -32602);
  assert.ok(/unknown prompt/.test(res.error.message), res.error.message);

  refuses(() => prompts.get('not-a-prompt', {}), -32602, 'unknown prompt',
    'the module refuses on its own, not only behind the server');
  refuses(() => prompts.get(undefined, {}), -32602, 'prompt name',
    'a missing name is refused as a missing name, not as an unknown one');
});

ok('P8 a missing required argument is refused', () => {
  const conn = service('p8').createConnection({});
  const res = modern(conn, 'prompts/get', { name: 'lock', arguments: {} });
  assert.ok(res.error, `expected a refusal, got ${JSON.stringify(res.result)}`);
  assert.strictEqual(res.error.code, -32602);
  assert.ok(/context/.test(res.error.message), res.error.message);

  refuses(() => prompts.get('lock', undefined), -32602, 'context',
    'no arguments object at all is still a missing argument');
  refuses(() => prompts.get('patch', { artifact: 'a' }), -32602, 'failures',
    'the refusal names the argument that is missing, not the first one');
});

ok('P9 a non-string argument is refused', () => {
  const conn = service('p9').createConnection({});
  for (const value of [7, null, ['a'], { text: 'a' }, true]) {
    const res = modern(conn, 'prompts/get', { name: 'lock', arguments: { context: value } });
    assert.ok(res.error, `${JSON.stringify(value)} must be refused, got ${JSON.stringify(res.result)}`);
    assert.strictEqual(res.error.code, -32602, res.error.message);
    assert.ok(/context/.test(res.error.message), res.error.message);
  }
});

ok('P10 a returned prompt is a copy, so a caller cannot edit the registry', () => {
  const first = prompts.get('lock', { context: 'one' });
  first.messages[0].content.text = 'poisoned';
  first.messages.push({ role: 'user', content: { type: 'text', text: 'extra' } });
  first.description = 'poisoned';
  const second = prompts.get('lock', { context: 'two' });
  assert.strictEqual(second.messages.length, 1, 'the registry did not grow a message');
  assert.ok(second.messages[0].content.text.includes('two'), 'the second read is its own body');
  assert.ok(!second.messages[0].content.text.includes('poisoned'), second.messages[0].content.text);
  assert.ok(!/poisoned/.test(second.description), second.description);

  const listedOnce = prompts.list();
  listedOnce.prompts[0].name = 'poisoned';
  listedOnce.prompts[0].arguments.push({ name: 'poisoned', required: true });
  listedOnce.prompts.length = 1;
  const listedTwice = prompts.list();
  assert.deepStrictEqual(listedTwice.prompts.map((p) => p.name), EXPECTED,
    'the advertised list is rebuilt, not handed out');
  assert.ok(!listedTwice.prompts[0].arguments.some((a) => a.name === 'poisoned'),
    'a returned argument array cannot mutate the registry');
  assert.deepStrictEqual(
    listedTwice.prompts[0].arguments.map((a) => a.name),
    prompts.list().prompts[0].arguments.map((a) => a.name),
    'the argument arrays are copies too'
  );
});

ok('P11 the modern era carries the list cache fields and the legacy era omits them', () => {
  const modernResult = answer(modern(service('p11m').createConnection({}), 'prompts/list'));
  assert.strictEqual(modernResult.ttlMs, 300000);
  assert.strictEqual(modernResult.cacheScope, 'public');

  const legacyResult = answer(legacy(legacyConnection('p11l'), 'prompts/list'));
  assert.strictEqual(legacyResult.ttlMs, undefined, 'legacy has no cache contract to state');
  assert.strictEqual(legacyResult.cacheScope, undefined);
  assert.strictEqual(legacyResult.prompts.length, EXPECTED.length,
    'both eras serve the same prompts');
});

ok('P12 prompts/list has one fixed page, and prompts is an advertised capability', () => {
  const conn = service('p12').createConnection({});
  const paged = modern(conn, 'prompts/list', { cursor: 'abc' });
  assert.ok(paged.error, 'a cursor is refused like every other fixed list');
  assert.strictEqual(paged.error.code, -32602);

  const discover = conn.handleMessage({ jsonrpc: '2.0', id: ++requestId, method: 'server/discover' });
  assert.deepStrictEqual(discover.result.capabilities, { tools: {}, resources: {}, prompts: {} },
    'a client that cannot see the capability will never ask for the prompts');
});

ok('P13 a legacy connection can get a prompt too', () => {
  const conn = legacyConnection('p13');
  const text = answer(legacy(conn, 'prompts/get', {
    name: 'attack', arguments: { artifact: 'the receipt renderer' },
  })).messages[0].content.text;
  assert.ok(text.includes('the receipt renderer'), text);
});

// ---------------------------------------------------------------------------
// The generator fails loudly, so a drifted source can never silently shrink
// the surface.
// ---------------------------------------------------------------------------

ok('G1 a prompt section with no command arrow makes the generator throw', () => {
  const source = [
    '# fixture',
    '',
    '## Command ↔ prompt map',
    '',
    '| Command | Canonical prompt |',
    '| --- | --- |',
    '| `/ratchet:lock` | 1 · The Target Is Not The Topic |',
    '',
    '## 1 · The Target Is Not The Topic  → `/ratchet:lock`',
    '',
    '```text',
    'Lock [PASTE CONTEXT].',
    '```',
    '',
    '## An Orphan Prompt',
    '',
    '```text',
    'Do the thing.',
    '```',
    '',
  ].join('\n');
  assert.throws(() => promptsGen.parsePrompts(source), /An Orphan Prompt/,
    'a body with no command must name itself in the failure, not be skipped');
});

ok('G2 a section with two prompt bodies makes the generator throw', () => {
  const source = [
    '## 1 · Double  → `/ratchet:lock`',
    '',
    '```text',
    'first',
    '```',
    '',
    '```text',
    'second',
    '```',
    '',
  ].join('\n');
  assert.throws(() => promptsGen.parsePrompts(source), /two|2|one prompt body/i,
    'which of the two is the prompt is not a guess the generator gets to make');
});

ok('G3 a heading-shaped line inside a text fence stays in the prompt body', () => {
  const source = [
    '## Embedded heading  → `/ratchet:lock`',
    '',
    '```text',
    'Keep this line.',
    '## This is prompt text, not a document section',
    'Keep this too.',
    '```',
    '',
  ].join('\n');
  const parsed = promptsGen.parsePrompts(source);
  assert.strictEqual(parsed.length, 1, 'a body heading cannot silently delete its prompt');
  assert.ok(parsed[0].body.includes('## This is prompt text, not a document section'));
});

ok('G4 the generator parses the real source and only skips bodiless sections', () => {
  const parsed = promptsGen.parsePrompts(fs.readFileSync(
    path.join(__dirname, '..', 'reference', 'PROMPTS.md'), 'utf8'
  ));
  assert.deepStrictEqual(parsed.map((p) => p.name), EXPECTED);
  for (const p of parsed) {
    assert.ok(p.body.trim().length > 40, `${p.name} carries a real body`);
    assert.ok(!/^\s*```/.test(p.body), `${p.name} body excludes its fence`);
  }
});

ok('G5 the generated artifact is CRLF-insensitive and byte-stable', () => {
  const once = promptsGen.buildPrompts();
  const twice = promptsGen.buildPrompts();
  assert.strictEqual(once, twice, 'two generations agree');
  assert.strictEqual(once.indexOf('\r'), -1, 'the artifact is \\n only');
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'reference', 'PROMPTS.md'), 'utf8'
  ).replace(/\n/g, '\r\n');
  assert.deepStrictEqual(
    promptsGen.parsePrompts(source).map((p) => p.name),
    EXPECTED,
    'a CRLF checkout parses the same sections (convention 16)'
  );
});

process.stdout.write(`\n${passed} passed, ${failures.length} failed\n`);
if (failures.length) process.exit(1);
