'use strict';

// Torque MCP build-order step 2.1: the root allowlist and canonical path
// containment. Run: node test/mcp-workspace.test.js
//
// The invariant this suite exists to defend:
//   NO CLIENT-CONTROLLED PATH IS ACCEPTED unless the components the resolver
//   observed placed it inside a configured root — directly or indirectly.
//   Directly means `..` and absolute escapes; indirectly means symlinks,
//   dangling links, name-spelling tricks, separators the platform does not
//   recognize, and names that merely share a root's prefix. The resolver
//   observes each component at its own moment and promises nothing about later
//   ones: that window is the next sub-step's problem, not this suite's.
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

function within(candidate, root) {
  return candidate === root || candidate.startsWith(root + path.sep);
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
  // Built by concatenation, NOT path.join: join normalizes the dot segments
  // away before the module ever sees them, which would test nothing.
  const sep = path.sep;
  refuses(roots, `${root}${sep}..${sep}outside${sep}secret.txt`, 'dot-dot traversal');
  refuses(roots, `${root}${sep}a${sep}..${sep}..${sep}outside`, 'traversal through a subdir');
  refuses(roots, `${root}${sep}.${sep}..${sep}outside`, 'dot-dot behind a dot segment');
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
  assert.ok(evil.startsWith(root), 'the fixture must actually share the string prefix');
  refuses(roots, path.join(evil, 'x.txt'), 'a prefix-sharing sibling');
  assert.strictEqual(roots.resolve(path.join(root, 'inside.txt')), fs.realpathSync.native(path.join(root, 'inside.txt')),
    'and the real root must still work — the separator rule is not a blanket refusal');
  assert.ok(base.length && !within(base, root), 'the fixture parent is genuinely outside the root');
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
  const sep = path.sep;
  assert.strictEqual(roots.resolve(`${root}${sep}.${sep}inside.txt`), want, 'a dot segment is noise, not an escape');
  // The subdirectory must EXIST for this to exercise the dot-dot branch at all;
  // climbing out of a component that is not there is a different case (W22).
  fs.mkdirSync(path.join(root, 'sub'), { recursive: true });
  assert.strictEqual(roots.resolve(`${root}${sep}sub${sep}..${sep}inside.txt`), want,
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

ok('W18 name spelling is settled by the filesystem, not by lowercasing', () => {
  const { base, root } = world('w18');
  const roots = workspace.createRoots([root]);
  const inside = path.join(root, 'inside.txt');
  // Whatever the platform, an existing path must canonicalize to the ONE name
  // the filesystem stores — that is what makes exact comparison safe.
  assert.strictEqual(roots.resolve(inside), fs.realpathSync.native(inside));
  if (process.platform === 'win32') {
    // Windows opens these as the same file, so containment must agree — and it
    // must agree by canonicalizing, not by folding case in JavaScript.
    assert.strictEqual(roots.resolve(inside.toUpperCase()), roots.resolve(inside),
      'a differently-cased path names the same file on Windows');
  } else {
    // Case-sensitive: a sibling of the root differing only in case is a
    // DIFFERENT directory, and folding case would hand it over.
    const twin = path.join(base, 'WORKSPACE');
    fs.mkdirSync(twin, { recursive: true });
    fs.writeFileSync(path.join(twin, 'secret.txt'), 'not yours', 'utf8');
    refuses(roots, path.join(twin, 'secret.txt'), 'a case-variant sibling of the root');
  }
});

ok('W19 a link resolves before the tail that follows it, in both directions', () => {
  // The branch neither W9 (no link) nor W17 (no missing tail) reaches.
  const { root, outside } = world('w19');
  const roots = workspace.createRoots([root]);

  const out = path.join(root, 'out-door');
  symlinkOrFail(outside, out, 'junction');
  refuses(roots, path.join(out, 'new.txt'), 'a not-yet-existing file behind an escaping link');

  const real = path.join(root, 'real');
  fs.mkdirSync(real, { recursive: true });
  const inDoor = path.join(root, 'in-door');
  symlinkOrFail(real, inDoor, 'junction');
  assert.strictEqual(roots.resolve(path.join(inDoor, 'new.txt')),
    path.join(fs.realpathSync.native(real), 'new.txt'),
    'a not-yet-existing file behind an internal link resolves through it');
});

ok('W20 dot-dot means the parent of where the path really arrived', () => {
  // path.resolve collapses ".." before links are followed; the OS does not.
  const { root, outside } = world('w20');
  const roots = workspace.createRoots([root]);
  const sep = path.sep;

  const out = path.join(root, 'out-door');
  symlinkOrFail(outside, out, 'junction');
  refuses(roots, `${out}${sep}..${sep}secret.txt`, 'dot-dot climbing out of an escaping link');

  const deep = path.join(root, 'a', 'b');
  fs.mkdirSync(deep, { recursive: true });
  fs.writeFileSync(path.join(root, 'a', 'target.txt'), 'yours', 'utf8');
  const inDoor = path.join(root, 'in-door');
  symlinkOrFail(deep, inDoor, 'junction');
  assert.strictEqual(roots.resolve(`${inDoor}${sep}..${sep}target.txt`),
    fs.realpathSync.native(path.join(root, 'a', 'target.txt')),
    'dot-dot through an internal link lands inside and must be allowed');
});

ok('W21 a component that cannot be examined is refused, not treated as absent', () => {
  const { root } = world('w21');
  const roots = workspace.createRoots([root]);
  const sep = path.sep;
  // A file cannot contain further components: this path can never exist, so
  // returning it as a legal future target would be a lie.
  refuses(roots, path.join(root, 'inside.txt', 'child.txt'), 'a path descending through a file');
  // Literal, not path.join: join would normalize this to a plain outside path
  // and the file component would never reach the module.
  refuses(roots, `${root}${sep}inside.txt${sep}..${sep}..${sep}outside${sep}secret.txt`,
    'a traversal laundered through a file component');
});

ok('W25 a backslash is a separator only where the platform says so', () => {
  const { base, root } = world('w25');
  const roots = workspace.createRoots([root]);
  if (process.platform === 'win32') {
    assert.strictEqual(roots.resolve(`${root}/inside.txt`), fs.realpathSync.native(path.join(root, 'inside.txt')),
      'Windows accepts either separator');
  } else {
    // On POSIX "workspace\evil" is ONE filename, a sibling of the root. Reading
    // the backslash as a separator would silently retarget it inside.
    const sibling = path.join(base, 'workspace\\evil');
    fs.mkdirSync(sibling, { recursive: true });
    fs.writeFileSync(path.join(sibling, 'secret.txt'), 'not yours', 'utf8');
    refuses(roots, path.join(sibling, 'secret.txt'), 'a sibling whose name contains a backslash');
  }
});

ok('W26 a UNC path without a share is not a location', () => {
  const { root } = world('w26');
  const roots = workspace.createRoots([root]);
  if (process.platform !== 'win32') {
    refuses(roots, '\\\\server\\share\\file.txt', 'a UNC path on POSIX');
    return;
  }
  // The fixture has to be a name that RESOLVES, or the refusal proves nothing
  // but "that path does not exist". A single-component "\\name\" is not a UNC
  // path at all: Windows anchors it to the current drive, so it names a
  // different directory depending on where the process is running.
  const here = process.cwd();
  const firstSegment = here.slice(path.parse(here).root.length).split(path.sep)[0];
  const driveRelative = `${path.sep}${path.sep}${firstSegment}${path.sep}`;
  assert.ok(fs.existsSync(driveRelative), `the fixture must resolve to be worth refusing: ${driveRelative}`);
  refuses(roots, driveRelative, 'a UNC-shaped path naming no share');
  refuses(roots, '\\\\?\\UNC\\server\\share\\x', 'an extended UNC path this module does not handle');
  for (const bad of [driveRelative, '\\\\?\\UNC\\server\\share']) {
    let err = null;
    try {
      workspace.createRoots([bad]);
    } catch (e) {
      err = e;
    }
    assert.strictEqual(err && err.code, 'ERATCHETROOT', `must not be configurable as a root: ${bad}`);
  }
});

ok('W27 a file cannot be descended into, through a link or a trailing separator', () => {
  const { root } = world('w27');
  const roots = workspace.createRoots([root]);
  const sep = path.sep;
  const link = path.join(root, 'file-link');
  symlinkOrFail(path.join(root, 'inside.txt'), link, 'file');
  // The link resolves to a FILE; climbing out of it with .. would treat that
  // file as a directory, which the OS never does.
  refuses(roots, `${link}${sep}..${sep}inside.txt`, 'dot-dot climbing out of a link to a file');
  refuses(roots, `${link}${sep}child.txt`, 'a path descending through a link to a file');
  refuses(roots, path.join(root, 'inside.txt') + sep, 'a file named with a trailing separator');
  // The control: a trailing separator on a real directory is just framing.
  assert.strictEqual(roots.resolve(root + sep), root);
});

ok('W28 two names that only a lowercase() would confuse stay distinct', () => {
  // The regression test for case folding. U+0130 (dotted capital I) lowercases
  // in JavaScript to "i" + U+0307 — two code points — so an implementation
  // comparing lowercased strings judges these two directories the same one.
  // Written as escapes: the precomposed and decomposed forms are
  // indistinguishable by eye, and a case-VARIANT pair would prove nothing
  // because Windows correctly treats those as one name.
  const base = fixture('w28');
  const dotted = path.join(base, 'İ-root');
  const decomposed = path.join(base, 'i̇-root');
  assert.strictEqual('İ-root'.toLowerCase(), 'i̇-root'.toLowerCase(),
    'the fixture only means something if JavaScript folds these together');
  fs.mkdirSync(dotted, { recursive: true });
  assert.ok(!fs.existsSync(decomposed),
    'this filesystem must keep the two spellings distinct for this falsifier to mean anything');
  fs.mkdirSync(decomposed, { recursive: true });
  fs.writeFileSync(path.join(decomposed, 'secret.txt'), 'not yours', 'utf8');
  const roots = workspace.createRoots([dotted]);
  refuses(roots, path.join(decomposed, 'secret.txt'), 'a sibling whose lowercase form collides with the root');
});
ok('W22 a path that does not exist may not climb past what does not exist', () => {
  const { root } = world('w22');
  const roots = workspace.createRoots([root]);
  const sep = path.sep;
  refuses(roots, `${root}${sep}absent${sep}..${sep}..${sep}outside${sep}new.txt`,
    'dot-dot through a missing component');
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
  // Written as an escape on purpose: a raw NUL is invisible in source. Node
  // rejects a NUL in a path with its own ERR_INVALID_ARG_VALUE before any
  // syscall runs, so this is defence in depth — the point is that a client
  // gets this boundary's refusal, in its vocabulary, rather than Node's.
  refuses(roots, path.join(root, 'inside.txt') + '\u0000.png', 'a path carrying a NUL');
});

ok('W23 a drive-relative Windows path is not "absolute enough" to be a root or a target', () => {
  const { root } = world('w23');
  const roots = workspace.createRoots([root]);
  if (process.platform === 'win32') {
    // Node calls "\work" absolute, but it means a different place depending on
    // the process's current drive — a root may not be that.
    refuses(roots, '\\Windows\\System32', 'a drive-less rooted Windows path');
    refuses(roots, 'C:relative', 'a drive-relative Windows path');
    let err = null;
    try {
      workspace.createRoots(['\\some\\where']);
    } catch (e) {
      err = e;
    }
    assert.strictEqual(err && err.code, 'ERATCHETROOT', 'and it may not be configured as a root either');
  } else {
    refuses(roots, 'C:\\Windows', 'a Windows-shaped path on POSIX is not absolute here');
  }
});

ok('W24 a root that cannot even be described is refused with this module\'s own error', () => {
  // JSON.stringify throws on a BigInt; the refusal must be ours, not a TypeError
  // escaping from inside the error message.
  for (const bad of [1n, Symbol('x'), () => {}]) {
    let err = null;
    try {
      workspace.createRoots([bad]);
    } catch (e) {
      err = e;
    }
    assert.strictEqual(err && err.code, 'ERATCHETROOT', `construction must name its own refusal for ${String(bad)}`);
  }
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
