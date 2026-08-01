'use strict';

// Default document shapes + light validation. No external deps.

const crypto = require('crypto');

const STATE_VERSION = 1;
const LEDGER_VERSION = 2;

// The GENERATION of a record: which incarnation of this store it belongs to. A
// wipe starts a new one, and a delta computed against a previous generation must
// never be rebased into it — the whole point of an authorized reset is that
// pre-reset intent stops applying.
//
// It is CSPRNG entropy, never a timestamp, for the same reason the lock's owner
// card carries a token: `createdAt` comes from nowIso, which honours RATCHET_NOW,
// and under a frozen clock — a supported mode — two generations stamp identically
// and the check silently compares equal. Identity that can be made to collide by
// a supported configuration is not identity. Minted here rather than through
// state.makeId only because state.js requires this file, not the other way round;
// same shape, same source of randomness.
function newGeneration() {
  return `gen-${Date.now().toString(36)}-${crypto.randomBytes(8).toString('hex')}`;
}

// The ledger's own lineage name (4c). Distinct prefix on purpose: a state
// generation copied into a ledger (or the reverse) must fail the format check
// rather than alias a lineage it never named. Bounded at mint AND at load
// (LEDGER_GEN_MAX_BYTES) so a stored gen can never overflow the receipts that
// embed it — the bound is what makes the receipt-cap verdict a function of the
// request, not of the store.
const LEDGER_GEN_MAX_BYTES = 64;

// FIXED WIDTH, deliberately. This generation is minted DURING an admission
// write and lands in that write's receipt before the byte cap is measured, so
// a variable-width clock component (base 36 gains a digit in 2059) would let
// the environment flip an identical request between accept and
// ReceiptTooLarge — the same class of defect the fixed-width receipt stamp
// exists to prevent. Eleven characters cover the whole JavaScript date domain.
// The state generation is NOT in this class: it is minted at creation and at a
// wipe, never inside a receipt-bearing commit.
function newLedgerGeneration() {
  return `lgen-${Date.now().toString(36).padStart(11, '0')}-${crypto.randomBytes(8).toString('hex')}`;
}

// Format check for a STORED ledger generation: the minted shape above —
// `lgen-` prefix, lowercase base36/hex charset — within the byte bound. A
// prefix-plus-non-empty check admitted an arbitrarily long gen (round-6
// finding), which then overflowed receipts through no fault of the request.
function isLedgerGeneration(value) {
  return (
    typeof value === 'string' &&
    /^lgen-[0-9a-z]+-[0-9a-f]+$/.test(value) &&
    Buffer.byteLength(value, 'utf8') <= LEDGER_GEN_MAX_BYTES
  );
}

function nowIso(clock) {
  // Clock is injected so callers (and tests) can control time.
  // process.env.RATCHET_NOW lets hooks stamp deterministically if needed.
  if (clock) return clock;
  if (process.env.RATCHET_NOW) return process.env.RATCHET_NOW;
  return new Date().toISOString();
}

function newState(clock) {
  const t = nowIso(clock);
  return {
    version: STATE_VERSION,
    // Monotonic write counter, incremented by saveState. Dormant in 0.8 —
    // nothing reads it. It ships now because a lost-update check added later
    // can only work if the counter already exists in the wild; a state file
    // written before it started counting can never be retro-numbered.
    rev: 0,
    // Which incarnation of this store the record belongs to (see newGeneration).
    // Every creation and every wipe mints a fresh one, so no caller can forget to.
    gen: newGeneration(),
    createdAt: t,
    updatedAt: t,
    title: '',
    objective: '',
    bottleneck: '',
    phase: 'idle', // idle | lock | auction | cut | build | attack | patch | compile
    dirty: false,
    lastCompileAt: null,
    confidence: null,
    nextAction: '',
    nextCommand: '',
    tags: [],
    decisions: [], // { id, at, choice, rejected, tripwire }
    artifacts: [], // { id, at, kind, title, path, status, holes }
    defects: [], // { id, at, severity, summary, status }
    assumptions: [], // { id, at, text, killTest, status }
    openLoops: [], // { id, at, text, status }
    touchedFiles: [], // { path, at }
    history: [], // { id, at, event, note }
    // Operation receipts for boundary-retried writes (MCP step 4). They live
    // INSIDE this record because a receipt is only truthful if it is durable
    // atomically with the commit it describes — a sibling file can be lost or
    // land without its commit, and either way the receipt lies about whether
    // the write happened. Bounded ring: entries are { id: operationId, tool,
    // argsHash, gen, rev, at, result }, appended only when a write commits.
    operations: [],
  };
}

function newLedger(clock) {
  const t = nowIso(clock);
  return {
    version: LEDGER_VERSION,
    // The ledger's own revision line (4c): advanced by exactly one on every
    // committed update-family write, monotonic within a lineage. WAL mirror
    // publishes are rev-silent by rule (D2) — they change only records the
    // family cannot reach.
    ledgerRev: 0,
    // Which incarnation of this ledger the record belongs to. Every creation
    // and every wipe mints a fresh one, so a recreated ledger can never
    // CAS-match an expectation formed against the old lineage.
    ledgerGen: newLedgerGeneration(),
    createdAt: t,
    updatedAt: t,
    features: [], // { id, name, area, workflow, routes, status }
    tests: [], // { id, feature, name, kind, status, lastRun }
    defects: [], // { id, feature, severity, summary, status, foundAt }
    // The ledger's receipt ring, same contract as state.operations: a receipt
    // exists iff the write that earned it landed, because both ride one rename.
    operations: [],
  };
}

// Collections that `state append` accepts, mapped to their id prefix.
const STATE_COLLECTIONS = {
  decisions: 'dec',
  artifacts: 'art',
  defects: 'def',
  assumptions: 'asm',
  openLoops: 'loop',
  touchedFiles: 'file',
  history: 'hist',
};

// Top-level scalar fields that `state set` accepts. `dirty` and `lastCompileAt`
// are deliberately absent: they are the checkpoint, and a checkpoint you can
// assert by hand is not a record of anything. `ratchet compile done` is the only
// transition that moves them.
const STATE_SCALARS = new Set([
  'title',
  'objective',
  'bottleneck',
  'phase',
  'nextAction',
  'nextCommand',
  'confidence',
]);

const LEDGER_COLLECTIONS = {
  features: 'feat',
  tests: 'test',
  defects: 'ldef',
};

const SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'];

// The ONE rule for what an artifact's holes are. It takes the owning record, not
// the value, because ABSENCE is the only thing that means zero — and absence is
// a fact about the object, not about the value's truthiness. `holes: ""`,
// `null`, `0` and `false` are values somebody wrote, and a value somebody wrote
// is at least one unexplained hole.
//
// It lives here, used by BOTH the artifacts writer and the closure gate, because
// two copies of this rule is exactly how they came to disagree: the gate counted
// a falsey hole while the writer erased it, so an artifact could lose a blocker
// at birth that the gate would have raised had it survived to disk.
function normalizeHoles(owner) {
  if (!owner || !Object.prototype.hasOwnProperty.call(owner, 'holes')) return [];
  const raw = owner.holes;
  return Array.isArray(raw) ? raw.map((x) => String(x)) : [String(raw)];
}

// The fog loop's text prefix. One constant, two ends of the lifecycle: the CLI
// opens a loop with this prefix when `score aperture` raises mapRequired, and
// artifacts.addArtifact closes loops with this prefix when the unknown-map
// lands. Shared so the open and close can never drift apart.
const FOG_LOOP_PREFIX = 'fog: pre-build map required';
const PHASES = ['idle', 'lock', 'auction', 'cut', 'build', 'attack', 'patch', 'compile', 'loop'];

// Defect lifecycle. `open`/`patched`/`reopened` are still-live pressure and
// drain confidence; the TERMINAL set does not. `closed` is the pre-0.3 alias
// for `resolved`. A defect only leaves the terminal set by being reopened.
const DEFECT_STATUSES = ['open', 'patched', 'reopened', 'resolved', 'waived', 'superseded', 'closed'];
const DEFECT_TERMINAL_STATUSES = ['resolved', 'closed', 'waived', 'superseded'];
// `closed` is READ-ONLY: it stays terminal for stores written before 0.3, but it
// is not a status anything may transition INTO. It was the one terminal status
// with no proof attached to it, so writing it cleared the drain with no evidence
// while `resolved` next door demanded --evidence.
const DEFECT_WRITABLE_STATUSES = DEFECT_STATUSES.filter((s) => s !== 'closed');

// Artifact lifecycle exits. Each is reached by a gated verb (`artifact close`,
// `retract`) and none may be asserted in an `artifact add` payload — a status
// that can be typed is not a gate.
const ARTIFACT_TERMINAL_STATUSES = ['closed', 'retracted', 'superseded'];
// Fields the CLI writes as the record of a gated transition. A caller that
// could supply them could forge a closure certificate in a JSON payload.
const ARTIFACT_RESERVED_FIELDS = [
  'rev',
  'closedAt',
  'closedBy',
  'closedRev',
  'closedHash',
  'holesWaiver',
  'retracted',
  'supersededBy',
];

// ---------------------------------------------------------------------------
// The strict ledger validation matrix (4c). One contract for the loader, the
// doctor, AND the fixtures: exactly two admissible shapes, everything else
// unprovable. It REFUSES rather than repairs because every door that consults
// it (wire write, CLI update, workspace.open) has sworn off inventing a fresh
// ledger over damaged bytes.
// ---------------------------------------------------------------------------

const LEDGER_OPERATIONS_CAP = 32;
const LEDGER_RECEIPT_ENTRY_CAP = 4096;
// The update family's collections: defects is NOT a member (D3) — the state
// defect family owns the mirror end-to-end, on both doors, permanently.
const LEDGER_FAMILY_COLLECTIONS = ['features', 'tests'];

const LEDGER_V1_KEYS = ['version', 'createdAt', 'updatedAt', 'features', 'tests', 'defects'];
const LEDGER_V2_KEYS = [...LEDGER_V1_KEYS, 'ledgerRev', 'ledgerGen', 'operations'];
const LEDGER_RECEIPT_KEYS = ['id', 'tool', 'argsHash', 'gen', 'rev', 'at', 'result'];
const LEDGER_RESULT_KEYS = ['ok', 'committed', 'replayed', 'ledgerRev', 'collection', 'recordId', 'action'];

// The canonical receipt stamp: exactly the 24-byte YYYY-MM-DDTHH:MM:SS.mmmZ
// form. An exact WIDTH, not a ceiling — a variable-width stamp lets the
// environment (RATCHET_NOW) flip an identical request between accept and
// ReceiptTooLarge (round-7 counterexample), so every accepted clock value
// must contribute the same bytes.
const LEDGER_STAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function isPlainRecord(v) {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

function hasExactKeys(obj, keys) {
  const own = Object.keys(obj);
  return own.length === keys.length && keys.every((k) => Object.prototype.hasOwnProperty.call(obj, k));
}

function isCollectionOfRecords(list) {
  return Array.isArray(list) && list.every(isPlainRecord);
}

// Verdict: { ok: true, version } or { ok: false, row, detail }. `row` names
// the failing matrix row so the doctor can print the exact local diagnosis
// (and its repair) while the wire keeps its one sentence.
function validateLedgerRecord(obj) {
  const bad = (row, detail) => ({ ok: false, row, detail });
  if (!isPlainRecord(obj)) return bad('record', 'not a JSON object record');
  if (obj.version !== 1 && obj.version !== 2) return bad('version', `unknown ledger version ${JSON.stringify(obj.version)}`);
  if (obj.version === 1) {
    // A v1 record carrying ANY lineage field — including a user-invented
    // `operations` key — is a HYBRID: admission must never adopt fields it
    // did not mint.
    if (!hasExactKeys(obj, LEDGER_V1_KEYS)) {
      return bad('keys', 'a version-1 ledger carries exactly the six version-1 keys — a lineage field on version 1 is a hybrid');
    }
  } else if (!hasExactKeys(obj, LEDGER_V2_KEYS)) {
    return bad('keys', 'a version-2 ledger carries exactly the version-1 keys plus ledgerRev, ledgerGen, operations');
  }
  for (const k of ['createdAt', 'updatedAt']) {
    if (typeof obj[k] !== 'string' || !obj[k]) return bad('timestamps', `${k} is not a non-empty string`);
  }
  for (const k of ['features', 'tests', 'defects']) {
    if (!isCollectionOfRecords(obj[k])) return bad('collections', `${k} is not an array of plain objects`);
  }
  if (obj.version === 1) return { ok: true, version: 1 };

  // A record AT Number.MAX_SAFE_INTEGER is matrix-VALID and read-servable;
  // only a mutating commit atop it refuses (LedgerRevisionExhausted).
  if (!Number.isSafeInteger(obj.ledgerRev) || obj.ledgerRev < 0) {
    return bad('ledgerRev', 'ledgerRev is not a non-negative safe integer');
  }
  if (!isLedgerGeneration(obj.ledgerGen)) {
    return bad('ledgerGen', `ledgerGen is missing, over ${LEDGER_GEN_MAX_BYTES} bytes, or not in the generated format`);
  }
  if (!Array.isArray(obj.operations) || obj.operations.length > LEDGER_OPERATIONS_CAP) {
    return bad('operations', `operations is not an array of at most ${LEDGER_OPERATIONS_CAP} entries`);
  }
  const seenIds = new Set();
  let lastRev = 0;
  for (const entry of obj.operations) {
    if (!isPlainRecord(entry) || !hasExactKeys(entry, LEDGER_RECEIPT_KEYS)) {
      return bad('ring', 'a receipt entry does not carry exactly the receipt keys');
    }
    if (typeof entry.id !== 'string' || !/^[A-Za-z0-9_-]{22,128}$/.test(entry.id)) {
      return bad('ring', 'a receipt id is not a valid operationId');
    }
    // Duplicate ids would make replay depend on which `find` wins.
    if (seenIds.has(entry.id)) return bad('ring', 'duplicate receipt ids in the ring');
    seenIds.add(entry.id);
    if (entry.tool !== 'ledger.update') return bad('ring', `a receipt names a tool outside the family: ${JSON.stringify(entry.tool)}`);
    if (typeof entry.argsHash !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(entry.argsHash)) {
      return bad('ring', 'a receipt argsHash is not a sha256 binding');
    }
    if (entry.gen !== obj.ledgerGen) return bad('ring', 'a receipt names a generation other than the record\'s own');
    if (!Number.isSafeInteger(entry.rev) || entry.rev <= 0 || entry.rev > obj.ledgerRev) {
      return bad('ring', 'a receipt revision is not a positive safe integer within the record\'s own ledgerRev');
    }
    if (entry.rev <= lastRev) return bad('ring', 'ring revisions are not unique and strictly increasing');
    lastRev = entry.rev;
    if (typeof entry.at !== 'string' || !LEDGER_STAMP_PATTERN.test(entry.at)) {
      return bad('ring', 'a receipt stamp is not the canonical 24-byte UTC form');
    }
    const r = entry.result;
    // Receipts persist only committed live results: a stored replayed:true or
    // committed:false is unprovable.
    if (!isPlainRecord(r) || !hasExactKeys(r, LEDGER_RESULT_KEYS)) {
      return bad('ring', 'a receipt result does not carry exactly the persisted success keys');
    }
    if (r.ok !== true || r.committed !== true || r.replayed !== false) {
      return bad('ring', 'a receipt result is not a committed live success');
    }
    if (r.ledgerRev !== entry.rev) return bad('ring', 'a receipt result names a revision other than its entry');
    if (!LEDGER_FAMILY_COLLECTIONS.includes(r.collection)) return bad('ring', 'a receipt result names a collection outside the family');
    if (typeof r.recordId !== 'string' || !r.recordId) return bad('ring', 'a receipt result recordId is not a non-empty string');
    if (r.action !== 'created' && r.action !== 'updated') return bad('ring', 'a receipt result action is not created|updated');
    if (Buffer.byteLength(JSON.stringify(entry), 'utf8') > LEDGER_RECEIPT_ENTRY_CAP) {
      return bad('ring', `a receipt entry exceeds ${LEDGER_RECEIPT_ENTRY_CAP} UTF-8 bytes`);
    }
  }
  return { ok: true, version: 2 };
}

module.exports = {
  STATE_VERSION,
  LEDGER_VERSION,
  LEDGER_GEN_MAX_BYTES,
  LEDGER_OPERATIONS_CAP,
  LEDGER_RECEIPT_ENTRY_CAP,
  LEDGER_FAMILY_COLLECTIONS,
  LEDGER_STAMP_PATTERN,
  newLedgerGeneration,
  isLedgerGeneration,
  validateLedgerRecord,
  nowIso,
  newGeneration,
  newState,
  newLedger,
  STATE_COLLECTIONS,
  STATE_SCALARS,
  LEDGER_COLLECTIONS,
  SEVERITIES,
  normalizeHoles,
  FOG_LOOP_PREFIX,
  PHASES,
  DEFECT_STATUSES,
  DEFECT_TERMINAL_STATUSES,
  DEFECT_WRITABLE_STATUSES,
  ARTIFACT_TERMINAL_STATUSES,
  ARTIFACT_RESERVED_FIELDS,
};
