'use strict';

// Torque MCP build-order step 2.2: opaque, connection-scoped workspace handles.
// Run: node test/mcp-handles.test.js
//
// The invariant this suite defends:
//   A HANDLE IS A CAPABILITY, NOT A SHORTER SPELLING OF A PATHNAME. It is minted
//   only by the server, only from an already-contained path, and it carries the
//   authority that was granted with it. It is useless on any other connection,
//   dead the moment its connection closes, and unforgeable and unselectable by
//   the client. Every rejection that would reveal whether a handle EXISTS reads
//   identically, so the registry is not an oracle.
//
// What a handle does NOT do: eliminate the race between validation and use. It
// removes client-controlled path substitution and repeated authority
// interpretation at the protocol boundary. The filesystem underneath can still
// change. That boundary is named, not closed.
// Written RED first against an absent module. Traced by: claude-fable-5

const os = require('os');
const path = require('path');
const fs = require('fs');
const assert = require('assert');

const tmp = path.join(os.tmpdir(), 'ratchet-mcp-handles-test-' + process.pid);
fs.rmSync(tmp, { recursive: true, force: true });
fs.mkdirSync(tmp, { recursive: true });
process.env.RATCHET_DATA_DIR = path.join(tmp, 'state');
process.env.RATCHET_EVOLVE_LOG = path.join(tmp, 'evolve-log.jsonl');

const workspace = require('../src/mcp/workspace');
const handles = require('../src/mcp/handles');

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
  const outside = path.join(base, 'outside');
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.mkdirSync(path.join(root, 'dir'), { recursive: true });
  fs.writeFileSync(path.join(root, 'file.txt'), 'yours', 'utf8');
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'not yours', 'utf8');
  const registry = handles.createRegistry({ roots: workspace.createRoots([root]) });
  return { base, root, outside, registry };
}

// Every rejection that could reveal whether a handle exists must be this one.
function refusesUniformly(session, token, why) {
  let err = null;
  try {
    session.use(token, 'read');
  } catch (e) {
    err = e;
  }
  assert.ok(err, `must refuse ${why}`);
  assert.strictEqual(err.code, 'ERATCHETHANDLE', `refusal for ${why} must be the handle refusal, got ${err.code}`);
  return err;
}

// --- minting -----------------------------------------------------------------

ok('H1 a handle is server-minted, high-entropy, and says nothing about its path', () => {
  const { root, registry } = world('h1');
  const session = registry.open();
  const target = path.join(root, 'file.txt');
  const token = session.grant({ path: target, kind: 'file', operations: ['read'] });
  assert.strictEqual(typeof token, 'string');
  assert.ok(token.length >= 32, `a handle must not be guessable, got ${token.length} chars`);
  assert.ok(!token.includes('file.txt'), 'a handle must not carry its filename');
  assert.ok(!token.includes(root), 'a handle must not carry its path');
  assert.ok(!/[\\/]/.test(token), 'a handle must not look like a path at all');
  // Two grants of the SAME path must still be two different handles: the token
  // is an issuance, not a hash of what it points at.
  const again = session.grant({ path: target, kind: 'file', operations: ['read'] });
  assert.notStrictEqual(token, again, 'a handle must not be derived from its target');
});

ok('H2 the client cannot choose its own handle', () => {
  const { root, registry } = world('h2');
  const session = registry.open();
  const chosen = 'client-chosen-token';
  const token = session.grant({
    path: path.join(root, 'file.txt'), kind: 'file', operations: ['read'],
    handle: chosen, id: chosen, token: chosen,
  });
  assert.notStrictEqual(token, chosen, 'a client-supplied id must be ignored, not honored');
  refusesUniformly(session, chosen, 'the id the client tried to choose');
});

ok('H3 a handle can only be minted from a contained path', () => {
  const { outside, registry } = world('h3');
  const session = registry.open();
  let err = null;
  try {
    session.grant({ path: path.join(outside, 'secret.txt'), kind: 'file', operations: ['read'] });
  } catch (e) {
    err = e;
  }
  assert.ok(err, 'granting outside the roots must fail');
  assert.strictEqual(err.code, 'ERATCHETPATHESCAPE', 'and it must fail as a containment refusal');
});

ok('H4 handles are never recycled within a connection', () => {
  const { root, registry } = world('h4');
  const session = registry.open();
  const seen = new Set();
  for (let i = 0; i < 50; i++) {
    const t = session.grant({ path: path.join(root, 'file.txt'), kind: 'file', operations: ['read'] });
    assert.ok(!seen.has(t), 'a handle value must never be issued twice');
    seen.add(t);
    session.revoke(t);
  }
  // Revoked is not recycled: a revoked handle stays dead, it does not become
  // someone else's live handle later.
  for (const t of seen) refusesUniformly(session, t, 'a revoked handle');
});

// --- scope -------------------------------------------------------------------

ok('H5 a handle is useless on another connection, even from the same client', () => {
  const { root, registry } = world('h5');
  const a = registry.open({ client: 'same-client' });
  const b = registry.open({ client: 'same-client' });
  const token = a.grant({ path: path.join(root, 'file.txt'), kind: 'file', operations: ['read'] });
  assert.ok(a.use(token, 'read'), 'the issuing connection can use it');
  refusesUniformly(b, token, 'a handle presented on another connection');
});

ok('H6 closing a connection kills its handles immediately', () => {
  const { root, registry } = world('h6');
  const session = registry.open();
  const token = session.grant({ path: path.join(root, 'file.txt'), kind: 'file', operations: ['read'] });
  assert.ok(session.use(token, 'read'));
  session.close();
  refusesUniformly(session, token, 'a handle after its connection closed');
  // And the registry must not hand it back through a NEW connection either.
  refusesUniformly(registry.open(), token, 'a dead handle on a fresh connection');
});

ok('H7 a new connection does not inherit, and cannot mint into, a closed one', () => {
  const { root, registry } = world('h7');
  const first = registry.open();
  first.close();
  let err = null;
  try {
    first.grant({ path: path.join(root, 'file.txt'), kind: 'file', operations: ['read'] });
  } catch (e) {
    err = e;
  }
  assert.ok(err, 'a closed connection must not mint handles');
  assert.strictEqual(err.code, 'ERATCHETHANDLE');
});

// --- the registry is not an oracle -------------------------------------------

ok('H8 unknown, malformed, revoked, and cross-connection all read identically', () => {
  const { root, registry } = world('h8');
  const a = registry.open();
  const b = registry.open();
  const live = a.grant({ path: path.join(root, 'file.txt'), kind: 'file', operations: ['read'] });
  const revoked = a.grant({ path: path.join(root, 'file.txt'), kind: 'file', operations: ['read'] });
  a.revoke(revoked);

  const messages = new Set();
  const codes = new Set();
  for (const [token, why] of [
    ['never-issued-at-all', 'an unknown handle'],
    ['', 'an empty handle'],
    [revoked, 'a revoked handle'],
    [live, 'a handle belonging to another connection'],
    [42, 'a handle of the wrong type'],
    [null, 'a null handle'],
  ]) {
    const err = refusesUniformly(b, token, why);
    messages.add(err.message);
    codes.add(err.code);
  }
  assert.strictEqual(codes.size, 1, 'every unknown-handle refusal must share one code');
  assert.strictEqual(messages.size, 1,
    `every unknown-handle refusal must read identically, got: ${[...messages].join(' | ')}`);
});

// --- authority ---------------------------------------------------------------

ok('H9 a handle grants only the operations it was issued with', () => {
  const { root, registry } = world('h9');
  const session = registry.open();
  const token = session.grant({ path: path.join(root, 'file.txt'), kind: 'file', operations: ['read'] });
  assert.ok(session.use(token, 'read'), 'the granted operation works');
  let err = null;
  try {
    session.use(token, 'write');
  } catch (e) {
    err = e;
  }
  assert.ok(err, 'an ungranted operation must be refused');
  assert.strictEqual(err.code, 'ERATCHETHANDLEOP',
    'and it must NOT be the unknown-handle refusal — the holder already knows this handle exists');
});

ok('H10 a handle carries its kind, and the kind must match what is there', () => {
  const { root, registry } = world('h10');
  const session = registry.open();
  const fileToken = session.grant({ path: path.join(root, 'file.txt'), kind: 'file', operations: ['read'] });
  assert.strictEqual(session.use(fileToken, 'read').kind, 'file');
  const dirToken = session.grant({ path: path.join(root, 'dir'), kind: 'directory', operations: ['read'] });
  assert.strictEqual(session.use(dirToken, 'read').kind, 'directory');

  for (const [target, kind] of [
    [path.join(root, 'file.txt'), 'directory'],
    [path.join(root, 'dir'), 'file'],
  ]) {
    let err = null;
    try {
      session.grant({ path: target, kind, operations: ['read'] });
    } catch (e) {
      err = e;
    }
    assert.ok(err, `granting ${kind} on the wrong sort of target must fail`);
    assert.strictEqual(err.code, 'ERATCHETHANDLEKIND');
  }
});

ok('H11 a create handle names something that does NOT exist, inside a real parent', () => {
  const { root, registry } = world('h11');
  const session = registry.open();
  const fresh = session.grant({
    path: path.join(root, 'dir', 'new.txt'), kind: 'create-file', operations: ['write'],
  });
  assert.strictEqual(session.use(fresh, 'write').kind, 'create-file');

  let existing = null;
  try {
    session.grant({ path: path.join(root, 'file.txt'), kind: 'create-file', operations: ['write'] });
  } catch (e) {
    existing = e;
  }
  assert.strictEqual(existing && existing.code, 'ERATCHETHANDLEKIND',
    'create must refuse a target that is already there');

  let noParent = null;
  try {
    session.grant({
      path: path.join(root, 'absent-dir', 'new.txt'), kind: 'create-file', operations: ['write'],
    });
  } catch (e) {
    noParent = e;
  }
  assert.strictEqual(noParent && noParent.code, 'ERATCHETHANDLEKIND',
    'create must refuse a target whose parent does not exist');
});

ok('H12 an unknown kind or operation is refused at grant, not silently accepted', () => {
  const { root, registry } = world('h12');
  const session = registry.open();
  for (const bad of [
    { kind: 'anything', operations: ['read'] },
    { kind: 'file', operations: ['sudo'] },
    { kind: 'file', operations: [] },
    { kind: 'file', operations: 'read' },
    { kind: undefined, operations: ['read'] },
  ]) {
    let err = null;
    try {
      session.grant(Object.assign({ path: path.join(root, 'file.txt') }, bad));
    } catch (e) {
      err = e;
    }
    assert.ok(err, `grant must refuse ${JSON.stringify(bad)}`);
    assert.ok(err.code === 'ERATCHETHANDLEKIND' || err.code === 'ERATCHETHANDLEOP',
      `and name why, got ${err.code}`);
  }
});

// --- what the entry remembers ------------------------------------------------

ok('H13 the entry carries the facts established at issue time, not just a path', () => {
  const { root, registry } = world('h13');
  const session = registry.open({ client: 'test-client' });
  const token = session.grant({
    path: path.join(root, 'dir', 'new.txt'), kind: 'create-file', operations: ['write'],
  });
  const grant = session.use(token, 'write');
  assert.strictEqual(grant.path, path.join(fs.realpathSync.native(root), 'dir', 'new.txt'));
  assert.strictEqual(grant.root, fs.realpathSync.native(root), 'the workspace it belongs to');
  assert.strictEqual(grant.relative, path.join('dir', 'new.txt'), 'its name within that workspace');
  assert.strictEqual(grant.kind, 'create-file');
  assert.deepStrictEqual(grant.operations, ['write']);
  assert.ok(grant.connection, 'the connection it was issued to');
  assert.ok(grant.issued, 'the issuance nonce that distinguishes it from any reissue');
  assert.strictEqual(grant.connection, session.id());
});

ok('H14 a grant is a snapshot the holder cannot edit into more authority', () => {
  const { root, registry } = world('h14');
  const session = registry.open();
  const token = session.grant({ path: path.join(root, 'file.txt'), kind: 'file', operations: ['read'] });
  const grant = session.use(token, 'read');
  grant.operations.push('write');
  grant.path = path.join(root, '..', 'outside', 'secret.txt');
  grant.kind = 'directory';
  const again = session.use(token, 'read');
  assert.deepStrictEqual(again.operations, ['read'], 'a mutated copy must not become the record');
  assert.strictEqual(again.path, path.join(fs.realpathSync.native(root), 'file.txt'));
  assert.strictEqual(again.kind, 'file');
  let err = null;
  try {
    session.use(token, 'write');
  } catch (e) {
    err = e;
  }
  assert.ok(err, 'and the pushed operation must not have been granted');
});

ok('H15 a raw path is never accepted as authority', () => {
  const { root, registry } = world('h15');
  const session = registry.open();
  session.grant({ path: path.join(root, 'file.txt'), kind: 'file', operations: ['read'] });
  // The whole point of 2.2: after this step, a pathname is not a credential.
  refusesUniformly(session, path.join(root, 'file.txt'), 'a raw absolute path used as a handle');
  refusesUniformly(session, 'file.txt', 'a raw relative path used as a handle');
});

ok('H16 handles are per-connection, and one connection closing does not touch another', () => {
  const { root, registry } = world('h16');
  const a = registry.open();
  const b = registry.open();
  const ta = a.grant({ path: path.join(root, 'file.txt'), kind: 'file', operations: ['read'] });
  const tb = b.grant({ path: path.join(root, 'file.txt'), kind: 'file', operations: ['read'] });
  assert.notStrictEqual(ta, tb);
  a.close();
  refusesUniformly(a, ta, 'the closed connection\'s handle');
  assert.ok(b.use(tb, 'read'), 'the other connection is untouched');
  assert.notStrictEqual(a.id(), b.id(), 'connections are distinguishable');
});

fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
process.stdout.write(`\n${passed} passed, ${failures.length} failed\n`);
if (failures.length) process.exitCode = 1;
