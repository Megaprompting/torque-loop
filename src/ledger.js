'use strict';

const state = require('./state');
const schemas = require('./schemas');
const scoring = require('./scoring');

// The QA ledger is the canonical feature/test/defect record for a repo.
// It is separate from session state: state is "this session"; the ledger is
// "everything we know about this codebase's quality surface".

function create(cwd) {
  return state.loadLedger(cwd); // load auto-creates if absent
}

// `via` names the caller's authority. The defect mirror's status is written by
// state defect transitions and nothing else — a hand-written ledger status makes
// the mirror disagree with the record it mirrors, and the ledger is the surface
// people read for "is it fixed". Default-deny, so the CLI path is gated without
// a second check living in the router.
function upsert(cwd, collection, item, { via = 'caller' } = {}) {
  const prefix = schemas.LEDGER_COLLECTIONS[collection];
  if (!prefix) {
    throw new Error(
      `unknown ledger collection "${collection}". valid: ${Object.keys(schemas.LEDGER_COLLECTIONS).join(', ')}`
    );
  }
  if (collection === 'defects' && via !== 'transition' && item && Object.prototype.hasOwnProperty.call(item, 'status')) {
    throw new Error(
      'the ledger defect mirror\'s "status" is written only by a state defect transition ' +
        '(ratchet defect resolve|reopen|waive|supersede) — a hand-written status makes the mirror lie about the record.'
    );
  }
  const ledger = state.loadLedger(cwd);
  const list = ledger[collection];
  const now = schemas.nowIso();

  if (item.id) {
    const idx = list.findIndex((x) => x.id === item.id);
    if (idx >= 0) {
      list[idx] = { ...list[idx], ...item, updatedAt: now };
      state.saveLedger(cwd, ledger);
      return { action: 'updated', item: list[idx], ledger };
    }
  }
  const record = { id: item.id || state.makeId(prefix), at: now, ...item };
  list.push(record);
  state.saveLedger(cwd, ledger);
  return { action: 'created', item: record, ledger };
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

module.exports = { create, upsert, summary };
