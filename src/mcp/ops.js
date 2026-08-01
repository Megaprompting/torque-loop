'use strict';

// Torque MCP step 4: the write-operation mechanism.
//
// Everything here serves one contract: a retried write can never apply twice,
// never claim an outcome it does not have, and survives a server restart.
// `expectedStateRev`/`expectedStateGen` give safety (a stale decision is
// refused, not merged); the operation receipt gives committed-write
// observability (a retry learns WHOSE write landed). The receipt lives inside
// the state record so it is durable atomically with the commit it describes —
// two files cannot rename atomically, so a sibling receipt file could certify
// a write that never landed or lose one that did.
//
// Traced by: claude-fable-5

const crypto = require('crypto');
const fs = require('fs');

const schemas = require('../schemas');

// Receipts kept per store. Evicting is safe by construction: an entry only
// leaves after OPERATIONS_CAP later commits, so the evicted operation's
// expectedStateRev is deeply stale and its verbatim retry refuses rather than
// re-applying.
const OPERATIONS_CAP = 32;
// A receipt entry is identifiers and verdicts, never document bodies. The cap
// is a fail-closed tripwire for a future tool that violates that: the write
// refuses BEFORE commit instead of truncating a result a replay would later
// serve as truth.
const RECEIPT_ENTRY_CAP = 4096;

// Object keys sort by Unicode CODE POINT, not UTF-16 code unit: the default
// string comparison orders astral-plane keys after U+E000..U+FFFF, and a hash
// whose input order depends on the encoding quirk is not canonical.
function compareCodePoints(a, b) {
  const A = Array.from(a);
  const B = Array.from(b);
  const n = Math.min(A.length, B.length);
  for (let i = 0; i < n; i++) {
    const d = A[i].codePointAt(0) - B[i].codePointAt(0);
    if (d) return d;
  }
  return A.length - B.length;
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    // Null prototype, because JSON-parsed input can carry "__proto__" as an
    // OWN key: on an ordinary object that assignment hits the prototype
    // setter and the key vanishes from serialization — two different
    // operations would then share one binding hash and a retained retry
    // would replay the wrong one.
    const out = Object.create(null);
    for (const key of Object.keys(value).sort(compareCodePoints)) out[key] = canonicalize(value[key]);
    return out;
  }
  return value;
}

// Canonical encoding: recursively key-sorted, array order preserved, no
// Unicode normalization, then JSON.stringify. Inputs have already crossed
// JSON-RPC, so JavaScript-only values (undefined, functions, cycles) cannot
// reach this.
function canonicalStringify(value) {
  return JSON.stringify(canonicalize(value));
}

// The binding names the operation's MEANING, not its transport: tool, semantic
// arguments, and the revision + generation the client decided against.
// `workspaceHandle` is connection-scoped and `operationId` is the key itself —
// hashing either would make a legitimate reconnect retry look like a different
// operation.
function bindingHash(tool, semanticArgs, expectedStateRev, expectedStateGen) {
  const encoded = canonicalStringify({
    tool,
    args: semanticArgs,
    expectedStateRev,
    expectedStateGen,
  });
  return `sha256:${crypto.createHash('sha256').update(encoded, 'utf8').digest('hex')}`;
}

// Record ids minted by a write derive from the operation's meaning, so a
// crash-boundary re-application converges on the SAME record instead of
// minting a duplicate. 32 hex digits keep 128 bits of the digest — collisions
// are then a fault to refuse loudly (see mintId below), never a probability to
// budget for.
function deriveId(prefix, expectedStateGen, tool, argsHash, role) {
  const digest = crypto
    .createHash('sha256')
    .update(`${expectedStateGen}\n${tool}\n${argsHash}\n${role}`, 'utf8')
    .digest('hex');
  return `${prefix}-${digest.slice(0, 32)}`;
}

// Every id-bearing state collection. A derived id colliding with ANY existing
// record refuses before the domain can interpret it — artifact add treats an
// existing id as "revise this artifact", and entropy is not permission to
// merge into a record the operation never named.
const ID_COLLECTIONS = ['decisions', 'artifacts', 'defects', 'assumptions', 'openLoops', 'history', 'operations'];

function recordIdExists(s, id) {
  for (const name of ID_COLLECTIONS) {
    const list = s[name];
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      if (item && typeof item === 'object' && String(item.id) === id) return true;
    }
  }
  return false;
}

function successResult(committed, stateRev, verbFields) {
  return Object.assign({ ok: true, committed, stateRev, replayed: false }, verbFields || {});
}

// ONE cap predicate for both publishers — the round-4 review caught that two
// inline copies let a regression split them. The cap is UTF-8 BYTES on disk,
// not UTF-16 code units in memory: .length undercounts astral characters 2:1
// and commits receipts the strict reader's byte cap must reject.
function assertReceiptCap(entry) {
  if (Buffer.byteLength(JSON.stringify(entry), 'utf8') > RECEIPT_ENTRY_CAP) {
    const e = new Error(`operation receipt exceeds ${RECEIPT_ENTRY_CAP} bytes`);
    e.code = 'ERATCHETRECEIPTCAP';
    throw e;
  }
}

function revOf(s) {
  return s && Number.isInteger(s.rev) ? s.rev : 0;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

// The ordered write semantics, all under the one workspace lock the mutation
// boundary takes. The checks live INSIDE the transaction (not in
// withWorkspaceMutation's own expectedStateRev opt) because the replay lookup
// must come FIRST: a committed operation's verbatim retry is stale by
// definition — its receipt is the answer, and a revision refusal ahead of the
// ring lookup would turn every legitimate replay into a dead end.
//
// Outcome kinds: replayed | conflict | stateMissing | staleGen | staleRev |
// noop | committed | idConflict | capOverflow | unknownId. Every kind except
// `committed` moves zero bytes — a refusal that leaves a fresh store or a
// half-applied verb behind is not a refusal.
// Coded domain throws that are outcomes, not faults. Each rides out of the
// aborted transaction as a zero-byte refusal kind the boundary maps to its one
// allowlisted sentence — the raw message (which may name store files) never
// crosses the wire.
const CODED_OUTCOMES = {
  ERATCHETIDCONFLICT: 'idConflict',
  ERATCHETRECEIPTCAP: 'capOverflow',
  ERATCHETUNKNOWNID: 'unknownId',
  ERATCHETARTIFACTCLOSED: 'artifactClosed',
  ERATCHETCLOSUREBLOCKED: 'closureBlocked',
  ERATCHETHUMANAUTHORITY: 'humanAuthority',
  ERATCHETRETRACT: 'retractRefused',
  // 4b: strict recovery could not prove the store legal / defect attachment
  // needs an explicit artifact. ERATCHETMIRRORPENDING is deliberately ABSENT:
  // a post-decision mirror failure is not an outcome to answer with — the
  // throw funnels to the retryable WriteFailed and the retry recovers first.
  ERATCHETMIRROR: 'mirror',
  ERATCHETATTACH: 'attachAmbiguous',
};

function executeWrite(opts) {
  const { state, root, tool, operationId, expectedStateRev, expectedStateGen, semanticArgs, apply, alsoLockFile } = opts;
  const argsHash = bindingHash(tool, semanticArgs, expectedStateRev, expectedStateGen);

  // Refusing over a store that does not exist must not CREATE it: the mutation
  // boundary's own load would initialize a missing record before the refusal
  // could be spoken. After workspace.open this store exists, so this only
  // fires for out-of-band destruction — the server-local damage class.
  if (!fs.existsSync(state.statePath(root))) return { kind: 'stateMissing' };

  let outcome = null;
  try {
    // `alsoLockFile` extends the transaction over a second file, commit
    // included (the closure gate reads its proof from the journal) — same
    // contract as the CLI boundary, lock order workspace → file.
    state.withWorkspaceMutation(root, alsoLockFile ? { action: tool, alsoLockFile } : { action: tool }, (s) => {
      // Lookup against the ring the lock re-read — pre-lock peeks could race a
      // concurrent commit of this same operationId into a duplicate-id ring.
      const ring = Array.isArray(s.operations) ? s.operations : null;
      const hit = ring ? ring.find((entry) => entry && entry.id === operationId) : undefined;
      if (hit) {
        outcome = hit.argsHash === argsHash
          ? { kind: 'replayed', result: clone(hit.result) }
          : { kind: 'conflict' };
        return;
      }
      if (String(s.gen || '') !== expectedStateGen) {
        outcome = { kind: 'staleGen', actualStateGen: String(s.gen || '') || null };
        return;
      }
      const rev = revOf(s);
      if (rev !== expectedStateRev) {
        outcome = { kind: 'staleRev', actualStateRev: rev };
        return;
      }
      const before = JSON.stringify(s);
      const mintId = (prefix, role) => {
        const id = deriveId(prefix, expectedStateGen, tool, argsHash, role);
        if (recordIdExists(s, id)) {
          const e = new Error(`derived id ${id} already names a record`);
          e.code = 'ERATCHETIDCONFLICT';
          throw e;
        }
        return id;
      };
      const verbFields = apply(s, mintId) || {};
      if (JSON.stringify(s) === before) {
        // No receipt for a no-op: it moved nothing, so its second application
        // moves nothing either. The safety claim needs no durability — and the
        // observability limit is stated in the spec, not hidden here.
        outcome = { kind: 'noop', result: successResult(false, rev, verbFields) };
        return;
      }
      const result = successResult(true, rev + 1, verbFields);
      const entry = {
        id: operationId,
        tool,
        argsHash,
        gen: expectedStateGen,
        rev: rev + 1,
        at: schemas.nowIso(),
        result,
      };
      assertReceiptCap(entry);
      // The ring is created on the first committed write so a refusal against a
      // pre-step-4 record never mutates it just by being looked at.
      if (!Array.isArray(s.operations)) s.operations = [];
      s.operations.push(entry);
      while (s.operations.length > OPERATIONS_CAP) s.operations.shift();
      outcome = { kind: 'committed', result };
    });
  } catch (error) {
    // A throw inside the transaction aborts it — nothing was committed. The
    // coded throws become outcomes; anything else is the caller's to map
    // through its one error funnel.
    const kind = error && CODED_OUTCOMES[error.code];
    if (kind) return { kind };
    throw error;
  }
  return outcome;
}

// The cross-file variant (4b): the same ordered replay → generation → revision
// checks, but the mutation runs through state.withMirroredMutation, so the
// ledger half rides a write-ahead intent and a death between the two files is
// a recoverable lag. `prepare(s, ledger, mintId)` returns null after recording
// a refusal outcome, { kind: 'noop', verbFields }, or
// { kind: 'commit', ledgerOps, verbFields }.
function executeMirroredWrite(opts) {
  const { state, root, tool, operationId, expectedStateRev, expectedStateGen, semanticArgs, prepare } = opts;
  const argsHash = bindingHash(tool, semanticArgs, expectedStateRev, expectedStateGen);
  if (!fs.existsSync(state.statePath(root))) return { kind: 'stateMissing' };

  let outcome = null;
  try {
    state.withMirroredMutation(root, { action: tool, door: 'mcp', tool, operationId, argsHash }, (s, ledger) => {
      const ring = Array.isArray(s.operations) ? s.operations : null;
      const hit = ring ? ring.find((entry) => entry && entry.id === operationId) : undefined;
      if (hit) {
        outcome = hit.argsHash === argsHash
          ? { kind: 'replayed', result: clone(hit.result) }
          : { kind: 'conflict' };
        return null;
      }
      if (String(s.gen || '') !== expectedStateGen) {
        outcome = { kind: 'staleGen', actualStateGen: String(s.gen || '') || null };
        return null;
      }
      const rev = revOf(s);
      if (rev !== expectedStateRev) {
        outcome = { kind: 'staleRev', actualStateRev: rev };
        return null;
      }
      const mintId = (prefix, role) => {
        const id = deriveId(prefix, expectedStateGen, tool, argsHash, role);
        if (recordIdExists(s, id)) {
          const e = new Error(`derived id ${id} already names a record`);
          e.code = 'ERATCHETIDCONFLICT';
          throw e;
        }
        return id;
      };
      const prep = prepare(s, ledger, mintId);
      if (!prep || prep.kind === 'noop') {
        outcome = { kind: 'noop', result: successResult(false, rev, prep && prep.verbFields) };
        return null;
      }
      const result = successResult(true, rev + 1, prep.verbFields);
      const entry = {
        id: operationId,
        tool,
        argsHash,
        gen: expectedStateGen,
        rev: rev + 1,
        at: schemas.nowIso(),
        result,
      };
      assertReceiptCap(entry);
      if (!Array.isArray(s.operations)) s.operations = [];
      s.operations.push(entry);
      while (s.operations.length > OPERATIONS_CAP) s.operations.shift();
      outcome = { kind: 'committed', result };
      return { kind: 'commit', ledgerOps: prep.ledgerOps, result };
    });
  } catch (error) {
    const kind = error && CODED_OUTCOMES[error.code];
    if (kind) return { kind };
    throw error;
  }
  return outcome;
}

// ---------------------------------------------------------------------------
// 4c: the ledger write executor — the 4.1 mechanism pointed at the second
// file. One canonical file, one rename, its own revision line, its own
// receipt ring; no intent, no recovery table. Ordered semantics under the one
// workspace lock: strict load → replay → lineage (D4 hash-bound admission) →
// revision → domain → commit through the one family publisher.
// ---------------------------------------------------------------------------

// The ledger binding: tool, collection, item, and the lineage the client
// decided against — with expectedLedgerHash normalized to null on version-2
// writes (the supersededBy precedent), so a verbatim retry hashes identically
// whether or not the field was spelled. Handle and operationId excluded, for
// the reconnect reason 4.1 proved the hard way.
function ledgerBindingHash(collection, item, expectedLedgerRev, expectedLedgerGen, expectedLedgerHash) {
  const encoded = canonicalStringify({
    tool: 'ledger.update',
    collection,
    item,
    expectedLedgerRev,
    expectedLedgerGen,
    expectedLedgerHash,
  });
  return `sha256:${crypto.createHash('sha256').update(encoded, 'utf8').digest('hex')}`;
}

function sha256Of(bytes) {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

// Coded throws that are ledger outcomes, not faults. capOverflow maps to the
// non-retryable ReceiptTooLarge on THIS tool (the state-side writers keep
// their inherited WriteFailed mapping for the identical condition — open loop
// loop-msajcsie-660c97a22e6f, owner: Danny).
const LEDGER_CODED_OUTCOMES = {
  ERATCHETLEDGERDAMAGED: 'ledgerDamaged',
  ERATCHETLEDGEREXHAUSTED: 'ledgerExhausted',
  ERATCHETRECEIPTCAP: 'capOverflow',
  ERATCHETIDCONFLICT: 'idConflict',
  ERATCHETMIRROR: 'mirror',
};

function executeLedgerWrite(opts) {
  const { state, ledger: ledgerMod, root, operationId, collection, item } = opts;
  const expectedLedgerRev = opts.expectedLedgerRev;
  const expectedLedgerGen = opts.expectedLedgerGen;
  // Normalized at the executor so every caller means the same null.
  const expectedLedgerHash = opts.expectedLedgerHash === undefined ? null : opts.expectedLedgerHash;
  const tool = 'ledger.update';
  const argsHash = ledgerBindingHash(collection, item, expectedLedgerRev, expectedLedgerGen, expectedLedgerHash);

  let outcome = null;
  try {
    // The lock's post-acquire path runs 4b recovery, so this write begins
    // against a recovered store by construction.
    state.withWorkspaceLock(root, tool, () => {
      // STRICT load first, by necessity: the receipt ring lives inside these
      // bytes, and a ring cannot be inspected before the record holding it
      // has been proven. ABSENT refuses too, on the wire only: workspace.open
      // already initialized this store, so a missing file behind a live
      // handle is out-of-band destruction, not a fresh repo.
      const loaded = state.readLedgerStrict(root);
      if (loaded.absent) {
        outcome = { kind: 'ledgerDamaged' };
        return;
      }
      // Replay precedes CAS (the 4.1 order, for the 4.1 reason). A version-1
      // ledger has no ring and needs none: its original attempt either
      // committed the admission (making the store version 2 with the receipt
      // inside) or left it version 1 and the retry applies fresh.
      if (loaded.version === 2) {
        const hit = loaded.ledger.operations.find((entry) => entry && entry.id === operationId);
        if (hit) {
          outcome = hit.argsHash === argsHash
            ? { kind: 'replayed', result: clone(hit.result) }
            : { kind: 'conflict' };
          return;
        }
      }
      // Lineage: the null pair matches only a version-1 ledger, and then the
      // admission binds the exact observed bytes (D4 as re-ruled) — the gen
      // wins before the revision comparison on every path.
      if (expectedLedgerGen === null) {
        if (loaded.version !== 1) {
          outcome = { kind: 'staleLedgerGen', actualLedgerGen: loaded.ledger.ledgerGen };
          return;
        }
        const actualHash = sha256Of(loaded.bytes);
        if (expectedLedgerHash !== actualHash) {
          outcome = { kind: 'staleLedgerGen', actualLedgerGen: null, actualLedgerHash: actualHash };
          return;
        }
      } else if (loaded.version === 1) {
        outcome = { kind: 'staleLedgerGen', actualLedgerGen: null, actualLedgerHash: sha256Of(loaded.bytes) };
        return;
      } else if (loaded.ledger.ledgerGen !== expectedLedgerGen) {
        outcome = { kind: 'staleLedgerGen', actualLedgerGen: loaded.ledger.ledgerGen };
        return;
      }
      if (expectedLedgerRev !== null && loaded.ledger.ledgerRev !== expectedLedgerRev) {
        outcome = { kind: 'staleLedgerRev', actualLedgerRev: loaded.ledger.ledgerRev };
        return;
      }
      // Domain: the one shared merge. Created-record ids derive from the
      // operation's meaning, with the observed-bytes hash standing in for the
      // absent gen on an admission write — the observed bytes ARE the lineage
      // there, so an admission retry converges on the same id. Collision is
      // checked against the TARGET collection before any bytes change.
      const lineageKey = expectedLedgerGen === null ? expectedLedgerHash : expectedLedgerGen;
      const mintId = (prefix) => {
        const id = deriveId(prefix, lineageKey, tool, argsHash, collection);
        if (loaded.ledger[collection].some((x) => x && String(x.id) === id)) {
          const e = new Error(`derived id ${id} already names a record`);
          e.code = 'ERATCHETIDCONFLICT';
          throw e;
        }
        return id;
      };
      const now = schemas.nowIso();
      const up = ledgerMod.applyUpsert(loaded.ledger, collection, item, { now, mintId });
      if (up.noop) {
        outcome = {
          kind: 'noop',
          result: {
            ok: true,
            committed: false,
            // null in exactly one case: a no-op against a still-version-1
            // ledger — a no-op admits nothing, so there is no revision to
            // report. Emptiness stated, not omitted.
            ledgerRev: loaded.version === 2 ? loaded.ledger.ledgerRev : null,
            replayed: false,
            collection,
            recordId: String(up.record.id),
            action: up.action,
          },
        };
        return;
      }
      // The receipt stamp must be the canonical fixed-width form. A
      // non-canonical override (RATCHET_NOW is environment-dodgeable) refuses
      // locally with honest RETRYABLE semantics — fix the environment and the
      // identical request proceeds — so it rides the WriteFailed funnel, not
      // a coded outcome.
      if (!schemas.LEDGER_STAMP_PATTERN.test(now)) {
        throw new Error('receipt stamp override is not the canonical 24-byte UTC form — fix RATCHET_NOW and retry');
      }
      const committed = state.commitLedgerFamily(root, tool, loaded, up.after, {
        receipt: (gen, rev) => {
          const result = {
            ok: true,
            committed: true,
            replayed: false,
            ledgerRev: rev,
            collection,
            recordId: String(up.record.id),
            action: up.action,
          };
          const entry = { id: operationId, tool, argsHash, gen, rev, at: now, result };
          assertReceiptCap(entry);
          return entry;
        },
      });
      outcome = {
        kind: 'committed',
        result: {
          ok: true,
          committed: true,
          ledgerRev: committed.ledgerRev,
          replayed: false,
          collection,
          recordId: String(up.record.id),
          action: up.action,
        },
      };
    });
  } catch (error) {
    const kind = error && LEDGER_CODED_OUTCOMES[error.code];
    if (kind) return { kind };
    throw error;
  }
  return outcome;
}

module.exports = {
  OPERATIONS_CAP,
  RECEIPT_ENTRY_CAP,
  canonicalStringify,
  bindingHash,
  ledgerBindingHash,
  deriveId,
  recordIdExists,
  executeWrite,
  executeMirroredWrite,
  executeLedgerWrite,
};
