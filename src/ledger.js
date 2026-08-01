'use strict';

const { isDeepStrictEqual } = require('util');

const state = require('./state');
const schemas = require('./schemas');
const scoring = require('./scoring');

// The QA ledger is the canonical feature/test/defect record for a repo.
// It is separate from session state: state is "this session"; the ledger is
// "everything we know about this codebase's quality surface".
//
// 4c: the ledger is a first-class record with its own revision line. Every
// committed update-family write goes through state.commitLedgerFamily — the
// one rev-advancing publisher — and the merge semantics below are the ONE
// implementation behind both doors (CLI and ledger.update on the wire).

function create(cwd) {
  return state.loadLedger(cwd); // load auto-creates if absent
}

// Compare a merged record to the existing one ignoring the updatedAt restamp:
// the restamp is the write, not the change, and a no-op must not burn a
// revision or move a byte.
function sameRecord(a, b) {
  const strip = (o) => {
    const c = { ...o };
    delete c.updatedAt;
    return c;
  };
  return isDeepStrictEqual(strip(a), strip(b));
}

// The pure family merge: deep-copies the loaded ledger, applies one upsert,
// and reports whether the merge changed anything. Never touches disk — the
// caller decides whether the result is a commit (through
// state.commitLedgerFamily) or a no-op (zero bytes).
//
// `via` names the caller's authority, kept for the two layered gates beneath
// the boundary refusals: the D3 collection refusal first, then the older
// status-only gate as its backstop (subsumed, not deleted).
function applyUpsert(ledger, collection, item, { via = 'caller', now, mintId } = {}) {
  const prefix = schemas.LEDGER_COLLECTIONS[collection];
  if (!prefix) {
    throw new Error(
      `unknown ledger collection "${collection}". valid: ${Object.keys(schemas.LEDGER_COLLECTIONS).join(', ')}`
    );
  }
  // D3, both doors: after 4b the state defect family owns the mirror's
  // status, severity AND summary end-to-end — a generic edit to any of them
  // makes the mirror disagree with the record it mirrors while wearing a
  // receipt. Defect records enter and change ONLY through the defect verbs.
  if (collection === 'defects') {
    throw new Error(
      'the ledger defect mirror is written only by the defect verbs ' +
        '(ratchet defect add|resolve|reopen|waive|supersede) — ledger update addresses features and tests.'
    );
  }
  if (collection === 'defects' && via !== 'transition' && item && Object.prototype.hasOwnProperty.call(item, 'status')) {
    throw new Error(
      'the ledger defect mirror\'s "status" is written only by a state defect transition ' +
        '(ratchet defect resolve|reopen|waive|supersede) — a hand-written status makes the mirror lie about the record.'
    );
  }
  // A numeric or object id creates a record no later string lookup can
  // address (strict-equality compare), so the shape is refused, not coerced.
  if (item && item.id !== undefined && (typeof item.id !== 'string' || !item.id)) {
    throw new Error('ledger item.id must be a non-empty string when present');
  }
  const stamp = now || schemas.nowIso();
  const after = JSON.parse(JSON.stringify(ledger));
  const list = after[collection];

  if (item.id) {
    const idx = list.findIndex((x) => x.id === item.id);
    if (idx >= 0) {
      const merged = { ...list[idx], ...item, updatedAt: stamp };
      const noop = sameRecord(merged, list[idx]);
      list[idx] = merged;
      return { after, action: 'updated', record: merged, noop };
    }
  }
  const record = { id: item.id || (mintId ? mintId(prefix) : state.makeId(prefix)), at: stamp, ...item };
  list.push(record);
  return { after, action: 'created', record, noop: false };
}

// The CLI door. Strict load for bytes that EXIST (a damaged ledger refuses
// with the doctor route instead of being resiliently reborn mid-upsert);
// ABSENT keeps the locked auto-create — the CLI invocation is its own
// initialization boundary, unlike the wire, whose boundary is workspace.open.
// A committed write advances ledgerRev (admitting a version-1 ledger on first
// touch, D4); an identical merge is a no-op: no revision, no restamp, no
// bytes. The CLI names no expectation and records no receipt.
function upsert(cwd, collection, item, { via = 'caller' } = {}) {
  // The library entry point is the same door as the CLI verb: a propose-only
  // agent is refused before any lock is taken or byte read.
  state.assertMayWrite('ledger update');
  return state.withWorkspaceLock(cwd, 'ledger update', () => {
    let loaded = state.readLedgerStrict(cwd);
    if (loaded.absent) loaded = state.createLedgerStrict(cwd);
    const up = applyUpsert(loaded.ledger, collection, item, { via });
    if (up.noop) {
      // ledgerRev is null exactly when there is no revision to report: a
      // no-op against a still-version-1 ledger admits nothing.
      return {
        action: 'unchanged',
        item: up.record,
        ledger: loaded.ledger,
        committed: false,
        ledgerRev: loaded.version === 2 ? loaded.ledger.ledgerRev : null,
      };
    }
    const committed = state.commitLedgerFamily(cwd, 'ledger update', loaded, up.after);
    return {
      action: up.action,
      item: up.record,
      ledger: up.after,
      committed: true,
      ledgerRev: committed.ledgerRev,
      admitted: committed.admitted,
    };
  });
}

function summary(ledger) {
  const openDefects = (ledger.defects || []).filter(scoring.isDefectOpen);
  const failingTests = (ledger.tests || []).filter((t) => t.status === 'fail');
  return {
    features: (ledger.features || []).length,
    tests: (ledger.tests || []).length,
    failingTests: failingTests.length,
    defects: (ledger.defects || []).length,
    openDefects: openDefects.length,
  };
}

module.exports = { create, applyUpsert, upsert, summary };
