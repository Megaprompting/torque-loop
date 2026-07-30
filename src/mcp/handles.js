'use strict';

// Torque MCP build-order step 2.2: opaque, connection-scoped workspace handles.
//
// A handle is a CAPABILITY, not a shorter spelling of a pathname. It is minted
// only by the server, only from a path that step 2.1 already judged contained,
// and the registry entry keeps the facts established at that moment — which
// connection asked, which workspace it belongs to, what it is, and exactly what
// may be done with it. Downstream workspace methods will take handles and
// nothing else, so a client never re-supplies a path and the server never
// re-interprets one.
//
// Step 2.5 added verify-on-use: a grant records WHICH OBJECT it was issued over
// (device + inode), and every use re-checks that the recorded pathname still
// reaches that same object. Replacement is therefore detected and refused
// instead of inherited — the case where an attacker takes over the name and
// leaves the substitute in place.
//
// What this still does NOT do, stated precisely because the check is easy to
// over-read: it does not make use atomic. Node exposes no openat, so a gap
// remains between the identity check and whatever the caller then does with the
// path, and an attacker who wins that gap on every attempt is not stopped by
// this. Nor does it survive inode reuse — a filesystem is free to hand a
// deleted object's id to a new one, and this check would call that a match.
// What it converts is silent substitution into a named refusal.
// (Open loop, owner Danny: bind reads to an opened descriptor to close the gap.)
//
// One more boundary, named rather than implied: lookup is a Map get, so it is
// not constant-time. Against a local stdio peer that already holds its own
// handles this buys an attacker nothing, but it is not a timing-attack defence
// and is not claimed as one.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// 256 bits from the CSPRNG. The client never chooses, influences, or predicts
// this, and it is not derived from the target — two grants of the same file are
// two different capabilities.
const HANDLE_BYTES = 32;

const KINDS = ['file', 'directory', 'create-file', 'create-directory'];
const OPERATIONS = ['read', 'write', 'list'];
const TRAILING_SEPARATOR = process.platform === 'win32' ? /[\\/]$/ : /\/$/;

function refuse(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

// Every rejection that would reveal whether a handle EXISTS reads exactly like
// this one — unknown, malformed, revoked, closed, and belonging-to-someone-else
// are one answer, so the registry cannot be used to enumerate handles.
function unknownHandle() {
  return refuse('ERATCHETHANDLE', 'no such handle on this connection');
}

// A different refusal from `unknownHandle` on purpose, and safe to distinguish:
// the holder has already proven this handle exists by presenting it, so naming
// staleness reveals nothing the registry did not just confirm — and it sends
// them somewhere useful instead of implying they hold a forgery. Revocation is
// still checked FIRST, so a revoked token never earns this reply.
function stale(why) {
  return refuse('ERATCHETHANDLESTALE', `this handle no longer names what it was granted over — ${why}`);
}

function mintToken() {
  return crypto.randomBytes(HANDLE_BYTES).toString('base64url');
}

// The OS answers "is this the same object?" with the containing device and the
// inode, so that pair is what a grant records. Read in the WIDE form on
// purpose: NTFS file ids and large inodes exceed 2^53, where adjacent values
// collide as JS Numbers (10696049115337591 rounds to ...592), and an identity
// check that compared those would call two different objects one.
function objectIdentity(stat) {
  return { dev: stat.dev, ino: stat.ino };
}

function sameObject(recorded, current) {
  return recorded.dev === current.dev && recorded.ino === current.ino;
}

function statIfPresent(target, label) {
  try {
    return fs.statSync(target, { bigint: true });
  } catch (e) {
    if (e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) return null;
    const code = e && e.code ? e.code : 'unknown error';
    throw refuse('ERATCHETHANDLEKIND', `${label} could not be examined (${code})`);
  }
}

function createRegistry({ roots }) {
  if (!roots || typeof roots.resolve !== 'function') {
    throw refuse('ERATCHETHANDLE', 'a handle registry needs the contained-path resolver to mint from');
  }

  // Uniqueness belongs to the registry, not to one connection. Otherwise an
  // RNG collision could make a token retired by connection A become live again
  // on connection B — exactly the cross-connection substitution this boundary
  // exists to prevent.
  const connectionTokens = new Set();
  const issuedHandles = new Set();
  const issuanceTokens = new Set();

  function uniqueToken(retired) {
    let token = mintToken();
    while (retired.has(token)) token = mintToken();
    retired.add(token);
    return token;
  }

  function copyClient(value) {
    if (value === undefined) return undefined;
    try {
      return structuredClone(value);
    } catch (_e) {
      throw refuse('ERATCHETHANDLECLIENT', 'connection client metadata must be cloneable');
    }
  }

  function open(options) {
    const id = 'conn-' + uniqueToken(connectionTokens);
    // Connection identity is a fact fixed when the connection opens. Keeping a
    // caller-owned object here would let later mutation rewrite every grant.
    const client = copyClient(options && options.client);
    const live = new Map();
    let closed = false;

    function grant(request) {
      if (closed) throw unknownHandle();
      const req = request || {};

      const kind = req.kind;
      const requestedOperations = req.operations;
      const requestedPath = req.path;
      if (KINDS.indexOf(kind) === -1) {
        throw refuse('ERATCHETHANDLEKIND', `a handle kind must be one of: ${KINDS.join(', ')}`);
      }
      if (!Array.isArray(requestedOperations) || requestedOperations.length === 0) {
        throw refuse('ERATCHETHANDLEOP', `a handle must grant at least one operation: ${OPERATIONS.join(', ')}`);
      }
      // Snapshot first, then validate and store that same inert array. Reading a
      // getter once for validation and again for storage lets the request grant
      // more authority than the value that passed validation.
      const operations = requestedOperations.slice();
      for (const op of operations) {
        if (OPERATIONS.indexOf(op) === -1) {
          throw refuse('ERATCHETHANDLEOP', `unknown operation ${JSON.stringify(op)}; known: ${OPERATIONS.join(', ')}`);
        }
      }

      // Containment first: a handle can only ever be minted from a path step
      // 2.1 accepted, so there is no second way into the workspace.
      const target = roots.resolve(requestedPath);
      if (kind === 'create-file' && TRAILING_SEPARATOR.test(requestedPath)) {
        throw refuse('ERATCHETHANDLEKIND',
          'a path ending in a separator asserts directory, not create-file');
      }

      // The kind is a claim about what is there, checked once, now — which is
      // also how a "create" intent survives into the capability instead of
      // being lost in a returned pathname.
      const wantsExisting = kind === 'file' || kind === 'directory';
      const stat = statIfPresent(target, 'the handle target');
      let parentStat = null;
      if (wantsExisting) {
        if (!stat) throw refuse('ERATCHETHANDLEKIND', `nothing is there to grant a ${kind} handle over`);
        const actual = stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'special filesystem object';
        if (actual !== kind) {
          throw refuse('ERATCHETHANDLEKIND', `that is a ${actual}, not a ${kind}`);
        }
      } else {
        if (stat) throw refuse('ERATCHETHANDLEKIND', `something is already there, so it cannot be created`);
        parentStat = statIfPresent(path.dirname(target), 'the parent directory');
        if (!parentStat || !parentStat.isDirectory()) {
          throw refuse('ERATCHETHANDLEKIND', 'the parent directory this would be created in does not exist');
        }
      }

      const root = owningRoot(target);
      if (!root) throw refuse('ERATCHETPATHESCAPE', 'this path resolves outside every configured root');

      const token = uniqueToken(issuedHandles);

      live.set(token, {
        connection: id,
        client,
        root,
        path: target,
        relative: path.relative(root, target),
        kind,
        operations,
        // Taken from the SAME stat that validated the kind above. A second stat
        // would record the object as it was a moment later than the one that
        // passed validation, which is the very substitution being defended
        // against. A create grant has no object yet, so it records absence.
        object: stat ? objectIdentity(stat) : null,
        // For a create grant, absence at the target says nothing about WHERE it
        // would be created: the name is still free inside a directory that was
        // swapped underneath it. The parent is the object that grant authorized.
        parent: parentStat ? objectIdentity(parentStat) : null,
        // Distinguishes this issuance from any other grant over the same path,
        // including a reissue after revocation.
        issued: uniqueToken(issuanceTokens),
      });
      return token;
    }

    function lookup(token) {
      if (closed || typeof token !== 'string' || !token.length) throw unknownHandle();
      const entry = live.get(token);
      if (!entry) throw unknownHandle();
      return entry;
    }

    // Nothing here re-interprets a client string: the pathname re-checked is the
    // canonical one this registry recorded at grant time. The question is
    // narrower than containment — is the object still the one the grant was
    // issued over? Containment does not need re-deciding, because the same
    // object is necessarily in the same place it was judged to be.
    function stillGranted(entry) {
      const current = statIfPresent(entry.path, 'the handle target');
      if (!entry.object) {
        // A create grant asserted that nothing was there. If something is now,
        // writing would target an object the client never had authority over.
        if (current) throw stale('this handle was granted to create something, and something is there now');
        const parent = statIfPresent(path.dirname(entry.path), 'the parent directory');
        if (!parent) throw stale('the directory it would be created in is gone');
        if (!sameObject(entry.parent, objectIdentity(parent))) {
          throw stale('a different directory now answers to the place it would be created in');
        }
        return;
      }
      if (!current) throw stale('the object it was granted over is gone');
      if (!sameObject(entry.object, objectIdentity(current))) {
        // Type changes come free with this check: an inode cannot change what
        // kind of object it is, so a file replaced by a directory is a
        // different object and fails here rather than needing its own rule.
        throw stale('a different object now answers to that name');
      }
    }

    function use(token, operation) {
      const entry = lookup(token);
      stillGranted(entry);
      if (entry.operations.indexOf(operation) === -1) {
        // A different refusal on purpose: the holder has already proven this
        // handle exists, so naming the missing authority reveals nothing new.
        throw refuse('ERATCHETHANDLEOP',
          `this handle grants ${entry.operations.join(', ')} — not ${operation}`);
      }
      // A copy, so a holder cannot edit its own record into more authority.
      return {
        connection: entry.connection,
        client: copyClient(entry.client),
        root: entry.root,
        path: entry.path,
        relative: entry.relative,
        kind: entry.kind,
        operations: entry.operations.slice(),
        issued: entry.issued,
      };
    }

    function revoke(token) {
      if (typeof token !== 'string') return false;
      return live.delete(token); // stays in `issued`, so it is never handed out again
    }

    function close() {
      closed = true;
      live.clear();
    }

    return { id: () => id, grant, use, revoke, close, size: () => live.size };
  }

  function owningRoot(target) {
    let owner = null;
    for (const root of roots.list()) {
      const within = target === root ||
        target.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
      if (within && (!owner || root.length > owner.length)) owner = root;
    }
    return owner;
  }

  return { open, KINDS: KINDS.slice(), OPERATIONS: OPERATIONS.slice() };
}

module.exports = { createRegistry };
