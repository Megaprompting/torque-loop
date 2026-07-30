'use strict';

// Torque MCP build-order step 2.5: stale handles, filesystem replacement, TOCTOU.
// Run: node test/mcp-toctou.test.js
//
// The invariant this suite defends:
//   A HANDLE NAMES THE OBJECT IT WAS GRANTED OVER, NOT WHATEVER LATER ANSWERS TO
//   THAT NAME. Steps 2.1-2.4 established authority at grant time and then handed
//   back a pathname to re-resolve on every use, so anything that took over the
//   name inherited the grant. Every falsifier below replaces what is on disk
//   AFTER a valid grant and demands a refusal rather than a read of the
//   substitute.
//
// What this suite does NOT claim to prove: that the read is atomic. Node exposes
// no openat, so a gap remains between the identity check and the bytes. What is
// proven is that replacement which PERSISTS past the check is detected and
// refused instead of silently followed — the class of attack where the attacker
// wins by leaving the substitute in place. The remaining window is named in
// src/mcp/handles.js and owned as an open loop.
//
// Traced by: claude-fable-5

const os = require('os');
const path = require('path');
const fs = require('fs');
const assert = require('assert');
const childProcess = require('child_process');

const tmp = fs.realpathSync.native(
  fs.mkdtempSync(path.join(os.tmpdir(), 'ratchet-mcp-toctou-test-'))
);
process.env.RATCHET_DATA_DIR = path.join(tmp, 'state');
process.env.RATCHET_EVOLVE_LOG = path.join(tmp, 'evolve-log.jsonl');

const workspace = require('../src/mcp/workspace');
const handles = require('../src/mcp/handles');
const mcp = require('../src/mcp/server');

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
function world(label) {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(tmp, `${label}-${n++}-`)));
  const root = path.join(base, 'workspace');
  fs.mkdirSync(path.join(root, 'dir'), { recursive: true });
  fs.writeFileSync(path.join(root, 'file.txt'), 'yours', 'utf8');
  const registry = handles.createRegistry({ roots: workspace.createRoots([root]) });
  return { base, root, registry, session: registry.open({}) };
}

// A refusal is only evidence if it is the refusal we asked for: a test that
// accepts any throw passes when the module breaks for an unrelated reason.
function refuses(fn, code, why) {
  let err = null;
  try {
    fn();
  } catch (e) {
    err = e;
  }
  assert.ok(err, `${why} — expected a refusal, got none`);
  assert.strictEqual(err.code, code, `${why} — refused with ${err.code}: ${err.message}`);
  return err;
}

// Replace a directory with a different directory carrying the same name. Not a
// symlink: this is the plain rename swap, which needs no special privilege and
// therefore works identically on Windows CI.
function swapDirectory(target, build) {
  const replacement = target + '.replacement';
  fs.mkdirSync(replacement, { recursive: true });
  if (build) build(replacement);
  fs.rmSync(target, { recursive: true, force: true });
  fs.renameSync(replacement, target);
}

ok('T1 a directory handle whose directory is replaced at the same path is refused on use', () => {
  const w = world('t1');
  const target = path.join(w.root, 'dir');
  const token = w.session.grant({ path: target, kind: 'directory', operations: ['read', 'list'] });
  assert.ok(w.session.use(token, 'read'), 'the grant must work before anything moves');

  swapDirectory(target, (replacement) => {
    fs.writeFileSync(path.join(replacement, 'planted.txt'), 'attacker', 'utf8');
  });

  refuses(() => w.session.use(token, 'read'), 'ERATCHETHANDLESTALE',
    'a different directory now answers to the granted name');
});

ok('T2 a file handle whose file is deleted and recreated is refused on use', () => {
  const w = world('t2');
  const target = path.join(w.root, 'file.txt');
  const token = w.session.grant({ path: target, kind: 'file', operations: ['read'] });
  assert.ok(w.session.use(token, 'read'));

  fs.rmSync(target);
  fs.writeFileSync(target, 'attacker', 'utf8');

  refuses(() => w.session.use(token, 'read'), 'ERATCHETHANDLESTALE',
    'the name survived but the object behind it did not');
});

ok('T3 rewriting a file in place does not invalidate its handle', () => {
  const w = world('t3');
  const target = path.join(w.root, 'file.txt');
  const token = w.session.grant({ path: target, kind: 'file', operations: ['read'] });

  // Same object, new contents. A handle is authority over an object, not a
  // content hash — invalidating here would make every ordinary write break
  // every open capability.
  fs.writeFileSync(target, 'legitimately edited, much longer than before', 'utf8');

  assert.strictEqual(w.session.use(token, 'read').kind, 'file',
    'content is not identity');
});

ok('T4 an untouched target stays usable', () => {
  const w = world('t4');
  const token = w.session.grant({
    path: path.join(w.root, 'dir'), kind: 'directory', operations: ['read', 'list'],
  });
  assert.ok(w.session.use(token, 'read'), 'no replacement, no refusal');
  assert.ok(w.session.use(token, 'list'), 'and it stays usable across repeated use');
});

ok('T5 swapping a mid-path directory retargets the name and is refused', () => {
  const w = world('t5');
  const middle = path.join(w.root, 'dir');
  const target = path.join(middle, 'leaf.txt');
  fs.writeFileSync(target, 'yours', 'utf8');
  const token = w.session.grant({ path: target, kind: 'file', operations: ['read'] });

  // The leaf keeps its name and its content; only its PARENT is swapped. A
  // check that re-resolved the recorded pathname without comparing identity
  // would read the planted file and call it the granted one.
  swapDirectory(middle, (replacement) => {
    fs.writeFileSync(path.join(replacement, 'leaf.txt'), 'yours', 'utf8');
  });

  refuses(() => w.session.use(token, 'read'), 'ERATCHETHANDLESTALE',
    'the leaf name resolves through a directory that was exchanged underneath it');
});

ok('T6 a deleted target is refused as stale, not as an unknown handle', () => {
  const w = world('t6');
  const target = path.join(w.root, 'file.txt');
  const token = w.session.grant({ path: target, kind: 'file', operations: ['read'] });
  fs.rmSync(target);

  // The holder already proved this handle exists by presenting it, so naming
  // the real reason reveals nothing new and sends them to the right place.
  refuses(() => w.session.use(token, 'read'), 'ERATCHETHANDLESTALE',
    'the object is gone');
});

ok('T7 a file replaced by a directory at the same name is refused', () => {
  const w = world('t7');
  const target = path.join(w.root, 'file.txt');
  const token = w.session.grant({ path: target, kind: 'file', operations: ['read'] });

  fs.rmSync(target);
  fs.mkdirSync(target);

  refuses(() => w.session.use(token, 'read'), 'ERATCHETHANDLESTALE',
    'the kind established at grant time no longer describes what is there');
});

ok('T8 a create handle is refused once something occupies its path', () => {
  const w = world('t8');
  const target = path.join(w.root, 'new.txt');
  const token = w.session.grant({ path: target, kind: 'create-file', operations: ['write'] });
  assert.strictEqual(w.session.use(token, 'write').kind, 'create-file');

  fs.writeFileSync(target, 'planted by someone else', 'utf8');

  refuses(() => w.session.use(token, 'write'), 'ERATCHETHANDLESTALE',
    'a create grant asserted absence, and something is there now');
});

ok('T8b a create handle whose parent directory was swapped is refused', () => {
  const w = world('t8b');
  const parent = path.join(w.root, 'dir');
  const token = w.session.grant({
    path: path.join(parent, 'new.txt'), kind: 'create-file', operations: ['write'],
  });

  // Absence at the target is not enough: the target is still absent inside a
  // DIFFERENT directory, so a check that only asked "is anything there?" would
  // let the create land in the attacker's directory.
  swapDirectory(parent);

  refuses(() => w.session.use(token, 'write'), 'ERATCHETHANDLESTALE',
    'the directory this would be created in is not the one that was authorized');
});

ok('T9 a create handle whose path is still free stays usable', () => {
  const w = world('t9');
  const token = w.session.grant({
    path: path.join(w.root, 'new.txt'), kind: 'create-file', operations: ['write'],
  });
  assert.strictEqual(w.session.use(token, 'write').kind, 'create-file',
    'nothing appeared, so nothing is stale');
});

ok('T10 revocation outranks staleness — a revoked handle is unknown, never stale', () => {
  const w = world('t10');
  const target = path.join(w.root, 'file.txt');
  const token = w.session.grant({ path: target, kind: 'file', operations: ['read'] });
  w.session.revoke(token);
  fs.rmSync(target);

  // Order matters for the enumeration guarantee: if a revoked token answered
  // "stale" while an unissued one answered "unknown", the difference would tell
  // an attacker which tokens were once real.
  refuses(() => w.session.use(token, 'read'), 'ERATCHETHANDLE',
    'a revoked handle must stay indistinguishable from one that never existed');
});

ok('T11 a second name for the same object does not invalidate the handle', () => {
  const w = world('t11');
  const target = path.join(w.root, 'file.txt');
  const token = w.session.grant({ path: target, kind: 'file', operations: ['read'] });

  let linked = true;
  try {
    fs.linkSync(target, path.join(w.root, 'second-name.txt'));
  } catch (_e) {
    linked = false;
  }
  if (!linked) return; // filesystem without hard links; nothing to prove here

  assert.strictEqual(w.session.use(token, 'read').kind, 'file',
    'another name for the same object changes nothing about the object');
});

ok('T12 one connection\'s stale target does not disturb another connection\'s live handle', () => {
  const w = world('t12');
  const other = w.registry.open({});
  const doomed = path.join(w.root, 'file.txt');
  const safe = path.join(w.root, 'dir');

  const a = w.session.grant({ path: doomed, kind: 'file', operations: ['read'] });
  const b = other.grant({ path: safe, kind: 'directory', operations: ['read'] });

  fs.rmSync(doomed);

  refuses(() => w.session.use(a, 'read'), 'ERATCHETHANDLESTALE', 'A lost its object');
  assert.ok(other.use(b, 'read'), 'B is untouched by A misfortune');
});

ok('T13 object identity is compared at full width, never through a lossy Number', () => {
  const w = world('t13');
  const target = path.join(w.root, 'file.txt');

  // NTFS file ids and large inode numbers exceed 2^53, where adjacent values
  // collide as JS Numbers (10696049115337591 rounds to ...592). An identity
  // check that read stat without bigint could therefore call two different
  // objects the same one, so the module must ask for the wide form every time
  // it establishes or re-checks identity.
  const real = fs.statSync;
  const seen = [];
  fs.statSync = function (p, options) {
    if (String(p) === String(target)) seen.push(options && options.bigint === true);
    return real.apply(this, arguments);
  };
  try {
    const token = w.session.grant({ path: target, kind: 'file', operations: ['read'] });
    w.session.use(token, 'read');
  } finally {
    fs.statSync = real;
  }

  assert.ok(seen.length >= 2, `expected identity to be read at grant and at use, saw ${seen.length}`);
  assert.ok(seen.every(Boolean),
    'every identity read must pass { bigint: true } or large inodes silently collide');
});

ok('T14 a stale directory handle is refused for every granted operation, not just read', () => {
  const w = world('t14');
  const target = path.join(w.root, 'dir');
  const token = w.session.grant({ path: target, kind: 'directory', operations: ['read', 'list'] });
  swapDirectory(target);

  refuses(() => w.session.use(token, 'read'), 'ERATCHETHANDLESTALE', 'read must refuse');
  refuses(() => w.session.use(token, 'list'), 'ERATCHETHANDLESTALE', 'list must refuse too');
});

// ---------------------------------------------------------------------------
// The same replacement, driven through the public server surface.
// ---------------------------------------------------------------------------

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

const META = 'io.modelcontextprotocol/';
let requestId = 0;
function modern(conn, method, params) {
  return conn.handleMessage({
    jsonrpc: '2.0',
    id: ++requestId,
    method,
    params: {
      ...(params || {}),
      _meta: {
        [META + 'protocolVersion']: '2026-07-28',
        [META + 'clientCapabilities']: {},
        [META + 'clientInfo']: { name: 'toctou-client', version: '0' },
      },
    },
  });
}

function repoWorld(label) {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(tmp, `${label}-${n++}-`)));
  const root = path.join(base, 'repo');
  fs.mkdirSync(root, { recursive: true });
  git(root, ['init', '--quiet']);
  const server = mcp.createServer({
    roots: [base],
    serverInfo: { name: 'torque-mcp-test', version: '0.0.0' },
  });
  return { base, root, conn: server.createConnection({}) };
}

function openWorkspace(conn, target) {
  return modern(conn, 'tools/call', { name: 'workspace.open', arguments: { path: target } });
}

ok('R1 a root replaced by a different repository does not keep handing back the dead handle', () => {
  const w = repoWorld('r1');
  const first = openWorkspace(w.conn, w.root);
  assert.ok(first.result && !first.result.isError, `open must succeed: ${JSON.stringify(first.result)}`);
  const firstHandle = first.result.structuredContent.workspaceHandle;

  // A different repository takes over the same pathname. The cached record is
  // keyed by that pathname, so without a freshness check the server hands back
  // the handle it minted over the directory that is no longer there.
  fs.rmSync(w.root, { recursive: true, force: true });
  fs.mkdirSync(w.root, { recursive: true });
  git(w.root, ['init', '--quiet']);

  const second = openWorkspace(w.conn, w.root);
  assert.ok(second.result && !second.result.isError,
    `reopening a real repository must still work: ${JSON.stringify(second.result)}`);
  assert.notStrictEqual(second.result.structuredContent.workspaceHandle, firstHandle,
    'the handle minted over the replaced directory must not be reissued as current authority');
});

ok('R2 resources/read is refused after the opened root is replaced', () => {
  const w = repoWorld('r2');
  const opened = openWorkspace(w.conn, w.root);
  assert.ok(opened.result && !opened.result.isError, 'open must succeed');
  const uri = opened.result.structuredContent.resources.state;

  fs.rmSync(w.root, { recursive: true, force: true });
  fs.mkdirSync(w.root, { recursive: true });
  git(w.root, ['init', '--quiet']);

  const read = modern(w.conn, 'resources/read', { uri });
  assert.ok(read.error, `a read through stale authority must be refused, got ${JSON.stringify(read.result)}`);
  assert.strictEqual(read.error.code, -32602, 'refused as an invalid resource, revealing nothing further');
});

process.stdout.write(`\n${passed} passed, ${failures.length} failed\n`);
if (failures.length) process.exit(1);
