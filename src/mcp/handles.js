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
// What this does NOT do: close the window between validation and use. The
// filesystem underneath a handle can still change; what a handle removes is
// client-controlled path substitution and repeated authority interpretation at
// the protocol boundary. Naming that is the point — an opaque token that merely
// maps back to a string would otherwise look like it had solved a race it never
// touched. (Open loop, owner Danny: verify-on-use against the recorded identity.)
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

function mintToken() {
  return crypto.randomBytes(HANDLE_BYTES).toString('base64url');
}

function statIfPresent(target, label) {
  try {
    return fs.statSync(target);
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
      if (wantsExisting) {
        if (!stat) throw refuse('ERATCHETHANDLEKIND', `nothing is there to grant a ${kind} handle over`);
        const actual = stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'special filesystem object';
        if (actual !== kind) {
          throw refuse('ERATCHETHANDLEKIND', `that is a ${actual}, not a ${kind}`);
        }
      } else {
        if (stat) throw refuse('ERATCHETHANDLEKIND', `something is already there, so it cannot be created`);
        const parent = statIfPresent(path.dirname(target), 'the parent directory');
        if (!parent || !parent.isDirectory()) {
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

    function use(token, operation) {
      const entry = lookup(token);
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
