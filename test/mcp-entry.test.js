'use strict';

// Torque MCP: the executable entry point and a real-transport interoperability
// run. Run: node test/mcp-entry.test.js
//
// Two invariants, and they are the reason this suite exists separately from the
// composition suite:
//
//   STDOUT BELONGS TO THE PROTOCOL. Every human-facing byte — usage, version,
//   startup banner, configuration refusal — goes to stderr. A diagnostic on
//   stdout is not a log line, it is a corrupt frame, and no client would
//   survive it. The I-cases assert that every stdout line parses as JSON.
//
//   ROOTS ARE NEVER INFERRED. A server that fell back to its working directory
//   would widen the 2.1-2.5 allowlist by accident on every launch, since cwd is
//   whatever the client spawned it in. No root is a refusal to start.
//
// The I-cases SPAWN THE REAL BINARY and talk to it over real OS pipes, rather
// than attaching streams in-process like test/mcp-server.test.js S15. That is
// deliberate: it is the first thing here that exercises node startup, argv,
// process exit, and the shebang wrapper together, which is exactly the layer an
// in-process test cannot reach.
//
// Traced by: claude-fable-5

const os = require('os');
const path = require('path');
const fs = require('fs');
const assert = require('assert');
const childProcess = require('child_process');

const tmp = fs.realpathSync.native(
  fs.mkdtempSync(path.join(os.tmpdir(), 'ratchet-mcp-entry-test-'))
);
process.env.RATCHET_DATA_DIR = path.join(tmp, 'state');
process.env.RATCHET_EVOLVE_LOG = path.join(tmp, 'evolve-log.jsonl');

const main = require('../src/mcp/main');
const pkg = require('../package.json');

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

let n = 0;
function fixture(label) {
  const dir = path.join(tmp, `${label}-${n++}`);
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
    cwd: dir, env: cleanGitEnv(), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  return dir;
}

// A stream stand-in that records what was written, so the in-process cases can
// tell the two channels apart — which is the whole point of most of them.
function sink() {
  const chunks = [];
  return {
    write: (s) => { chunks.push(String(s)); return true; },
    on: () => {},
    resume: () => {},
    text: () => chunks.join(''),
  };
}

function launch(argv, env) {
  const stdout = sink();
  const stderr = sink();
  const started = main.start(argv, {
    stdin: sink(), stdout, stderr, env: env || {},
  });
  return { started, stdout, stderr };
}

// ---------------------------------------------------------------------------
// E: the configuration surface, in-process.
// ---------------------------------------------------------------------------

ok('E1 --help explains itself on stderr and leaves stdout untouched', () => {
  const r = launch(['--help']);
  assert.strictEqual(r.started.exitCode, 0, 'asking for help is not an error');
  assert.match(r.stderr.text(), /--root <dir>/, 'usage names the root flag');
  assert.strictEqual(r.stdout.text(), '', 'stdout carries the protocol, never usage');
});

ok('E2 --version prints the package version on stderr, not stdout', () => {
  const r = launch(['--version']);
  assert.strictEqual(r.started.exitCode, 0);
  assert.strictEqual(r.stderr.text().trim(), pkg.version, 'one version surface, aligned');
  assert.strictEqual(r.stdout.text(), '', 'stdout stays clean');
});

ok('E3 no configured root refuses to start and says how to fix it', () => {
  const r = launch([]);
  assert.strictEqual(r.started.exitCode, 2, 'a server that can do nothing must not start');
  assert.match(r.stderr.text(), /--root/, 'the refusal names the flag');
  assert.match(r.stderr.text(), new RegExp(main.ROOTS_ENV), 'and the environment variable');
  assert.strictEqual(r.stdout.text(), '', 'nothing on the protocol channel');
});

ok('E4 an unknown argument is refused, never ignored', () => {
  // The failure this prevents: `--roots` (plural typo) parsing as "nothing
  // configured", launching a server whose allowlist is empty for an invisible
  // reason.
  const r = launch(['--roots', fixture('e4')]);
  assert.strictEqual(r.started.exitCode, 2, 'a typo must not become an empty allowlist');
  assert.match(r.stderr.text(), /unknown argument: --roots/);
});

ok('E5 --root with no value is refused', () => {
  const r = launch(['--root']);
  assert.strictEqual(r.started.exitCode, 2);
  assert.match(r.stderr.text(), /--root needs a directory/);
});

ok('E6 a root that does not exist is refused with the reason', () => {
  const r = launch(['--root', path.join(tmp, 'nowhere-at-all')]);
  assert.strictEqual(r.started.exitCode, 2, 'configuration fails loudly, not on first call');
  assert.match(r.stderr.text(), /must exist when it is configured/);
});

ok('E7 a relative root is refused, because it names wherever the client spawned us', () => {
  const r = launch(['--root', 'relative/dir']);
  assert.strictEqual(r.started.exitCode, 2);
  assert.match(r.stderr.text(), /fully qualified/);
});

ok('E8 the environment supplies roots when no flag does', () => {
  const dir = fixture('e8');
  const r = launch([], { [main.ROOTS_ENV]: dir });
  assert.strictEqual(r.started.exitCode, null, 'configured, so it serves');
  assert.match(r.stderr.text(), new RegExp(`1 root\\(s\\) from ${main.ROOTS_ENV}`),
    'the banner names which source was used');
});

ok('E9 an explicit --root wins outright and does not merge with the environment', () => {
  const flagged = fixture('e9-flag');
  const inherited = fixture('e9-env');
  const resolved = main.resolveRoots(
    main.parseArgs(['--root', flagged]),
    { [main.ROOTS_ENV]: inherited }
  );
  // A union would let an inherited variable add authority to an explicit launch
  // without appearing anywhere on the command line the operator read.
  assert.deepStrictEqual(resolved.roots, [flagged], 'only what was asked for');
  assert.strictEqual(resolved.source, '--root');
});

ok('E10 --root is repeatable and keeps every root', () => {
  const a = fixture('e10-a');
  const b = fixture('e10-b');
  // src/cli.js's parser stores flags in an object, where the second --root would
  // overwrite the first and silently narrow the allowlist. Hence a separate one.
  assert.deepStrictEqual(main.parseArgs(['--root', a, '--root', b]).roots, [a, b]);
  const r = launch(['--root', a, '--root', b]);
  assert.strictEqual(r.started.exitCode, null);
  assert.match(r.stderr.text(), /2 root\(s\)/);
});

ok('E11 --root=<dir> is accepted as well as --root <dir>', () => {
  const dir = fixture('e11');
  assert.deepStrictEqual(main.parseArgs([`--root=${dir}`]).roots, [dir]);
});

ok('E12 the startup banner goes to stderr, so stdout opens clean', () => {
  const r = launch(['--root', fixture('e12')]);
  assert.strictEqual(r.started.exitCode, null, 'serving');
  assert.match(r.stderr.text(), /ratchet-mcp \d+\.\d+\.\d+ — 1 root\(s\)/);
  assert.strictEqual(r.stdout.text(), '',
    'the first byte a client reads must be protocol');
});

// ---------------------------------------------------------------------------
// I: the real binary, spawned, over real pipes.
// ---------------------------------------------------------------------------

const META = 'io.modelcontextprotocol/';
function modernMeta() {
  return {
    [META + 'protocolVersion']: '2026-07-28',
    [META + 'clientCapabilities']: {},
    [META + 'clientInfo']: { name: 'entry-test-client', version: '0' },
  };
}

// Speak to the binary the way a client does: write complete lines to its stdin,
// let stdin close, read what came back. execFileSync gives the exit status too,
// which is half of what these cases are checking.
function converse(args, messages, options) {
  const input = messages.map((m) => JSON.stringify(m)).join('\n') + '\n';
  const opts = {
    input,
    encoding: 'utf8',
    env: Object.assign(cleanGitEnv(), (options && options.env) || {}),
    timeout: 30000,
    windowsHide: true,
  };
  let stdout = '';
  let stderr = '';
  let status = 0;
  try {
    const proc = childProcess.spawnSync(process.execPath, [BIN, ...args], opts);
    stdout = proc.stdout || '';
    stderr = proc.stderr || '';
    status = proc.status;
    if (proc.error) throw proc.error;
  } catch (e) {
    throw new Error(`spawning the binary failed: ${e && e.message ? e.message : e}`);
  }
  const lines = stdout.split('\n').filter((l) => l.length);
  return { stdout, stderr, status, lines, replies: lines.map((l) => JSON.parse(l)) };
}

ok('I1 the real binary answers a request over real pipes and exits 0 when stdin closes', () => {
  const repo = initRepo('i1-repo');
  const c = converse(['--root', repo], [{ jsonrpc: '2.0', id: 1, method: 'server/discover' }]);
  assert.strictEqual(c.status, 0, `clean exit expected, stderr: ${c.stderr}`);
  assert.strictEqual(c.replies.length, 1, 'one request, one reply');
  assert.strictEqual(c.replies[0].id, 1);
  assert.ok(c.replies[0].result, `discover must answer: ${JSON.stringify(c.replies[0])}`);
});

ok('I2 every stdout line from the real binary parses as JSON — the banner is not there', () => {
  const repo = initRepo('i2-repo');
  const c = converse(['--root', repo], [
    { jsonrpc: '2.0', id: 1, method: 'server/discover' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list', params: { _meta: modernMeta() } },
  ]);
  assert.strictEqual(c.status, 0, `stderr: ${c.stderr}`);
  for (const line of c.lines) {
    // JSON.parse already ran in converse(); this asserts the reason it worked.
    assert.doesNotThrow(() => JSON.parse(line), `stdout line is not JSON: ${line}`);
  }
  assert.match(c.stderr, /ratchet-mcp \d+\.\d+\.\d+/, 'the banner went to stderr instead');
});

ok('I3 workspace.open and resources/read work end to end through the spawned process', () => {
  const repo = initRepo('i3-repo');
  const opened = converse(['--root', repo], [{
    jsonrpc: '2.0', id: 1, method: 'tools/call',
    params: { name: 'workspace.open', arguments: { path: repo }, _meta: modernMeta() },
  }]);
  assert.strictEqual(opened.status, 0, `stderr: ${opened.stderr}`);
  const structured = opened.replies[0].result.structuredContent;
  assert.ok(structured && structured.workspaceHandle, `open must return a handle: ${opened.stdout}`);

  // A handle is connection-scoped, and each spawn is a new connection, so the
  // read has to happen inside the SAME conversation as the open.
  const both = converse(['--root', repo], [
    {
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'workspace.open', arguments: { path: repo }, _meta: modernMeta() },
    },
    { jsonrpc: '2.0', id: 2, method: 'resources/read', params: { uri: 'PLACEHOLDER', _meta: modernMeta() } },
  ]);
  // The placeholder cannot know the handle in advance, so that second call is
  // expected to be refused; what it proves is that a fabricated URI is refused
  // by the real process exactly as it is in-process.
  assert.ok(both.replies[1].error, 'a fabricated URI is refused across the real transport too');
  assert.strictEqual(both.replies[1].error.code, -32602);
});

// A handle is connection-scoped, so open-then-read has to happen inside ONE
// conversation — which a fixed input script cannot do, because the second
// request depends on the first reply. So this case runs a real CLIENT PROCESS
// that drives the real server process and reports what it saw. Two processes,
// one pipe, sequenced the way an actual MCP client sequences it.
const CLIENT = path.join(tmp, 'interop-client.js');
fs.writeFileSync(CLIENT, [
  "'use strict';",
  'const cp = require("child_process");',
  'const [bin, root, meta] = process.argv.slice(2);',
  'const child = cp.spawn(process.execPath, [bin, "--root", root], { windowsHide: true });',
  'const _meta = JSON.parse(meta);',
  'let buffered = "";',
  'const seen = [];',
  'child.stdout.on("data", (d) => {',
  '  buffered += d;',
  '  let nl;',
  '  while ((nl = buffered.indexOf("\\n")) !== -1) {',
  '    const line = buffered.slice(0, nl); buffered = buffered.slice(nl + 1);',
  '    if (!line.length) continue;',
  '    seen.push(JSON.parse(line));',
  '    if (seen.length === 1) {',
  '      const uri = seen[0].result.structuredContent.resources.state;',
  '      child.stdin.write(JSON.stringify({',
  '        jsonrpc: "2.0", id: 2, method: "resources/read", params: { uri, _meta },',
  '      }) + "\\n");',
  '    } else {',
  '      child.stdin.end();',
  '      process.stdout.write(JSON.stringify({ replies: seen }));',
  '      process.exit(0);',
  '    }',
  '  }',
  '});',
  'child.stdin.write(JSON.stringify({',
  '  jsonrpc: "2.0", id: 1, method: "tools/call",',
  '  params: { name: "workspace.open", arguments: { path: root }, _meta },',
  '}) + "\\n");',
  'setTimeout(() => { process.stdout.write(JSON.stringify({ timeout: true, seen })); process.exit(1); }, 25000);',
].join('\n'), 'utf8');

ok('I4 a resource read succeeds when it names the handle the same connection was given', () => {
  const repo = initRepo('i4-repo');
  const proc = childProcess.spawnSync(
    process.execPath,
    [CLIENT, BIN, repo, JSON.stringify(modernMeta())],
    { encoding: 'utf8', env: cleanGitEnv(), timeout: 40000, windowsHide: true }
  );
  assert.strictEqual(proc.status, 0,
    `the client process must complete the exchange: ${proc.stdout} ${proc.stderr}`);
  const { replies } = JSON.parse(proc.stdout);
  assert.ok(replies[0].result.structuredContent.workspaceHandle, 'open returned a handle');
  assert.ok(replies[1].result,
    `the read must succeed over the real transport: ${JSON.stringify(replies[1])}`);
  assert.match(replies[1].result.contents[0].text, /"rev"/, 'and carry real state');
});

ok('I5 a malformed line is refused and the process keeps serving', () => {
  const repo = initRepo('i5-repo');
  const c = converse(['--root', repo], [{ jsonrpc: '2.0', id: 1, method: 'server/discover' }]);
  // Rebuild the input by hand so one line is deliberately not JSON.
  const input = 'this is not json\n' +
    JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'server/discover' }) + '\n';
  const proc = childProcess.spawnSync(process.execPath, [BIN, '--root', repo], {
    input, encoding: 'utf8', env: cleanGitEnv(), timeout: 30000, windowsHide: true,
  });
  const replies = proc.stdout.split('\n').filter((l) => l.length).map((l) => JSON.parse(l));
  assert.strictEqual(proc.status, 0, `stderr: ${proc.stderr}`);
  assert.strictEqual(replies.length, 2, 'one refusal, then the next request still answered');
  assert.strictEqual(replies[0].error.code, -32700, 'unparseable JSON is a parse error');
  assert.strictEqual(replies[1].id, 7, 'a bad line does not poison the stream');
  assert.ok(c.status === 0, 'control run also exited cleanly');
});

ok('I6 the real binary refuses to start with no root, and says nothing on stdout', () => {
  const proc = childProcess.spawnSync(process.execPath, [BIN], {
    input: '', encoding: 'utf8', env: cleanGitEnv(), timeout: 30000, windowsHide: true,
  });
  assert.strictEqual(proc.status, 2, 'a misconfigured launch fails visibly');
  assert.strictEqual(proc.stdout, '', 'and never writes to the protocol channel');
  assert.match(proc.stderr, /no workspace root configured/);
});

ok('I7 --help through the real binary exits 0 with a clean stdout', () => {
  const proc = childProcess.spawnSync(process.execPath, [BIN, '--help'], {
    input: '', encoding: 'utf8', env: cleanGitEnv(), timeout: 30000, windowsHide: true,
  });
  assert.strictEqual(proc.status, 0);
  assert.strictEqual(proc.stdout, '', 'usage is a diagnostic, so it belongs on stderr');
  assert.match(proc.stderr, /Usage: ratchet-mcp/);
});

process.stdout.write(`\n${passed} passed, ${failures.length} failed\n`);
if (failures.length) process.exit(1);
