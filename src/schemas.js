'use strict';

// Default document shapes + light validation. No external deps.

const crypto = require('crypto');

const STATE_VERSION = 1;
const LEDGER_VERSION = 1;

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
  };
}

function newLedger(clock) {
  const t = nowIso(clock);
  return {
    version: LEDGER_VERSION,
    createdAt: t,
    updatedAt: t,
    features: [], // { id, name, area, workflow, routes, status }
    tests: [], // { id, feature, name, kind, status, lastRun }
    defects: [], // { id, feature, severity, summary, status, foundAt }
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

module.exports = {
  STATE_VERSION,
  LEDGER_VERSION,
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
