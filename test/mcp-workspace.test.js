'use strict';

// Torque MCP build-order step 2.1: the root allowlist and canonical path
// containment. Run: node test/mcp-workspace.test.js
//
// The invariant this suite exists to defend:
//   NO CLIENT-CONTROLLED PATH CROSSES THE CONFIGURED ROOTS — directly or
//   indirectly. Directly means `..` and absolute escapes; indirectly means
//   symlinks, dangling links, canonical-casing tricks, and names that merely
//   share a root's prefix.
// Written RED first against an absent module. Traced by: claude-fable-5

const os = require('os');
const path = require('path');
const fs = require('fs');
const assert = require('assert');

const tmp = path.join(os.tmpdir(), 'ratchet-mcp-ws-test-' + process.pid);
fs.rmSync(tmp, { recursive: true, force: true });
fs.mkdirSync(tmp, { recursive: true });
process.env.RATCHET_DATA_DIR = path.join(tmp, 'state');
process.env.RATCHET_EVOLVE_LOG = path.join(tmp, 'evolve-log.jsonl');

const workspace = require('../src/mcp/workspace');

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

// A root and an outside directory that share a parent — the outside is what
// every escape in this suite is trying to reach.
function world(label) {
  const base = fixture(label);
  const root = path.join(base, 'workspace');
  const outside = path.join(base, 'outside');
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'not yours', 'utf8');
  fs.writeFileSync(path.join(root, 'inside.txt'), 'yours', 'utf8');
  return { base, root, outside };
}

function refuses(roots, p, why) {
  let err = null;
  try {
    roots.resolve(p);
  } catch (e) {
    err = e;
  }
  assert.ok(err, `must refuse ${why}: ${p}`);
  assert.strictEqual(err.code, 'ERATCHETPATHESCAPE', `refusal for ${why} must name the boundary, got ${err.code}`);
  return err;
}

function symlinkOrFail(target, link, type) {
  let linked = true;
  try {
    fs.symlinkSync(target, link, type);
  } catch (_e) {
    linked = false;
  }
  // A platform without symlink permission cannot host these falsifiers; say so
  // rather than passing quietly.
  assert.ok(linked, 'this platform must allow symlinks for this falsifier to mean anything');
}

// --- direct crossings -------------------------------------------------------

ok('W1 a relative path is refused — there is no base to guess from', () => {
  const { root } = world('w1');
  const roots = workspace.createRoots([root]);
  refuses(roots, 'inside.txt', 'a relative path');
  refuses(roots, './inside.txt', 'a dot-relative path');
});

ok('W2 dot-dot out of a root is refused however it is spelled', () => {
  const { root, outside } = world('w2');
  const roots = workspace.createRoots([root]);
  refuses(roots, path.join(root, '..', 'outside', 'secret.txt'), 'dot-dot traversal');
  refuses(roots, path.join(root, 'a', '..', '..', 'outside'), 'traversal through a subdir');
  refuses(roots, outside, 'a plain sibling path');
});

ok('W3 an absolute path outside every root is refused', () => {
  const { root } = world('w3');
  const roots = workspace.createRoots([root]);
  refuses(roots, path.join(os.tmpdir(), 'somewhere-else'), 'an unrelated absolute path');
  refuses(roots, path.parse(root).root, 'the filesystem root itself');
});

ok('W4 a sibling that merely shares the root\'s name prefix is refused', () => {
  const { base, root } = world('w4');
  const evil = `${root}-evil`;
  fs.mkdirSync(evil, { recursive: true });
  fs.writeFileSync(path.join(evil, 'x.txt'), 'no', 'utf8');
  const roots = workspace.createRoots([root]);
  refuses(roots, path.join(evil, 'x.txt'), 'a prefix-sharing sibling');
  assert.ok(evil.startsWith(root), 'the fixture must actually share the string prefix');
  assert.ok(base);
});

// --- indirect crossings -----------------------------------------------------

ok('W5 a symlink inside a root pointing outside is refused', () => {
  const { root, outside } = world('w5');
  const link = path.join(root, 'escape');
  symlinkOrFail(path.join(outside, 'secret.txt'), link, 'file');
  const roots = workspace.createRoots([root]);
  refuses(roots, link, 'a symlink leading out of the root');
});

ok('W6 a symlinked DIRECTORY mid-path is refused, not just a final link', () => {
  const { root, outside } = world('w6');
  const link = path.join(root, 'door');
  symlinkOrFail(outside, link, 'junction');
  const roots = workspace.createRoots([root]);
  refuses(roots, path.join(link, 'secret.txt'), 'a path through a symlinked directory');
});

ok('W7 a link whose target cannot be proven is refused, never assumed innocent', () => {
  const { root, outside } = world('w7');
  const link = path.join(root, 'dangling');
  symlinkOrFail(path.join(outside, 'does-not-exist.txt'), link, 'file');
  const roots = workspace.createRoots([root]);
  refuses(roots, link, 'a dangling symlink');
});

ok('W13 a root that is itself a symlink is canonicalized, so real paths under it are allowed', () => {
  const { base, root } = world('w13');
  const alias = path.join(base, 'alias-root');
  symlinkOrFail(root, alias, 'junction');
  const roots = workspace.createRoots([alias]);
  const resolved = roots.resolve(path.join(root, 'inside.txt'));
  assert.strictEqual(resolved, fs.realpathSync.native(path.join(root, 'inside.txt')),
    'a canonical path under a symlinked root must be contained, not refused');
});

// --- positive controls: containment must not become refuse-everything -------

ok('W8 a path inside a root resolves to its canonical form', () => {
  const { root } = world('w8');
  const roots = workspace.createRoots([root]);
  const want = fs.realpathSync.native(path.join(root, 'inside.txt'));
  assert.strictEqual(roots.resolve(path.join(root, 'inside.txt')), want);
  assert.strictEqual(roots.resolve(path.join(root, '.', 'inside.txt')), want, 'a dot segment is noise, not an escape');
  assert.strictEqual(roots.resolve(path.join(root, 'sub', '..', 'inside.txt')), want,
    'dot-dot that lands back inside is allowed — the destination is what matters');
});

ok('W9 a not-yet-existing file inside a root resolves; its escaping twin does not', () => {
  const { root } = world('w9');
  const roots = workspace.createRoots([root]);
  const fresh = path.join(root, 'new-dir', 'new-file.txt');
  assert.strictEqual(roots.resolve(fresh), fresh, 'a file that does not exist yet is still a legal target');
  refuses(roots, path.join(root, 'new-dir', '..', '..', 'outside', 'new.txt'), 'a non-existent path that escapes');
});

ok('W12 a root resolves to itself and its parent does not', () => {
  const { base, root } = world('w12');
  const roots = workspace.createRoots([root]);
  assert.strictEqual(roots.resolve(root), root);
  assert.strictEqual(roots.resolve(root + path.sep), root, 'a trailing separator is framing, not a different path');
  refuses(roots, base, 'the root\'s own parent');
});

ok('W14 more than one root is honored, each contained independently', () => {
  const a = world('w14a');
  const b = world('w14b');
  const roots = workspace.createRoots([a.root, b.root]);
  assert.strictEqual(roots.resolve(path.join(a.root, 'inside.txt')), fs.realpathSync.native(path.join(a.root, 'inside.txt')));
  assert.strictEqual(roots.resolve(path.join(b.root, 'inside.txt')), fs.realpathSync.native(path.join(b.root, 'inside.txt')));
  refuses(roots, a.outside, 'outside the first root');
  refuses(roots, b.outside, 'outside the second root');
});

ok('W17 a link that stays inside the root is FOLLOWED, not refused', () => {
  // Without this control the whole suite would pass against an implementation
  // that simply refuses every symlink — escapes blocked, feature destroyed.
  const { root } = world('w17');
  const target = path.join(root, 'real', 'file.txt');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, 'yours', 'utf8');
  const link = path.join(root, 'shortcut');
  symlinkOrFail(target, link, 'file');
  const roots = workspace.createRoots([root]);
  assert.strictEqual(roots.resolve(link), fs.realpathSync.native(target),
    'an internal link must resolve to its target, not be treated as an escape');

  const dirLink = path.join(root, 'dir-shortcut');
  symlinkOrFail(path.dirname(target), dirLink, 'junction');
  assert.strictEqual(roots.resolve(path.join(dirLink, 'file.txt')), fs.realpathSync.native(target),
    'a path through an internal directory link must resolve too');
});

ok('W18 name comparison follows the platform, not the string', () => {
  const { root } = world('w18');
  const roots = workspace.createRoots([root]);
  const inside = path.join(root, 'inside.txt');
  if (process.platform === 'win32') {
    // Windows opens these as the same file, so containment must agree.
    assert.strictEqual(roots.resolve(inside.toUpperCase()), roots.resolve(inside),
      'a differently-cased path names the same file on Windows');
  } else {
    // Elsewhere they are different names; the upper-cased one simply does not
    // exist yet, and must still be judged inside the root rather than refused.
    assert.strictEqual(roots.resolve(path.join(root, 'INSIDE.TXT')), path.join(root, 'INSIDE.TXT'));
  }
});

// --- construction and shape -------------------------------------------------

ok('W10 zero roots refuses everything — an empty allowlist is closed, not open', () => {
  const { root } = world('w10');
  const roots = workspace.createRoots([]);
  refuses(roots, path.join(root, 'inside.txt'), 'any path when no root is configured');
});

ok('W11 a path that is not a usable string is refused', () => {
  const { root } = world('w11');
  const roots = workspace.createRoots([root]);
  for (const bad of ['', null, undefined, 42, {}, []]) {
    refuses(roots, bad, `a non-path value ${JSON.stringify(bad)}`);
  }
  // Written as an escape on purpose: a raw NUL is invisible in source. Every
  // syscall truncates at it, so the bytes after it are a lie the filesystem
  // never sees — the containment check would read one path, the open another.
  refuses(roots, path.join(root, 'inside.txt') + '\u0000.png', 'a NUL-truncated path');
});

ok('W15 a root that is relative, missing, or not a directory is refused at construction', () => {
  const { root } = world('w15');
  for (const bad of ['relative/root', path.join(root, 'no-such-dir'), path.join(root, 'inside.txt')]) {
    let err = null;
    try {
      workspace.createRoots([bad]);
    } catch (e) {
      err = e;
    }
    assert.ok(err, `construction must refuse root: ${bad}`);
    assert.strictEqual(err.code, 'ERATCHETROOT', `construction refusal must name itself, got ${err.code}`);
  }
});

ok('W16 the refusal names the boundary and does not leak the resolved target', () => {
  const { root, outside } = world('w16');
  const roots = workspace.createRoots([root]);
  const err = refuses(roots, path.join(root, '..', 'outside', 'secret.txt'), 'a traversal');
  assert.match(err.message, /outside the configured roots/i, 'the refusal must say what it refused');
  assert.ok(!err.message.includes(path.join(outside, 'secret.txt')),
    'the refusal must not hand back the out-of-bounds path it resolved to');
});

fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
process.stdout.write(`\n${passed} passed, ${failures.length} failed\n`);
if (failures.length) process.exitCode = 1;
