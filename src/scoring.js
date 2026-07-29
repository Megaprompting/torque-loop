'use strict';

// Scoring is deliberately transparent: the model can reproduce it by hand.
// No hidden weighting, no ML — just multiplicative pressure functions.

const schemas = require('./schemas');

// One predicate, one source of truth. Confidence, the state summary, and the
// QA ledger all decide "is this defect still draining?" the same way — so a
// resolved/waived/superseded defect can never lie on one surface while it drains
// on another. Terminal statuses are read from schemas so the lifecycle verbs
// and the scorer can never disagree about what "done" means.
const TERMINAL_DEFECT_STATUSES = new Set(schemas.DEFECT_TERMINAL_STATUSES.map((s) => s.toLowerCase()));
function isDefectOpen(defect) {
  const status = String((defect && defect.status) || 'open').toLowerCase();
  return !TERMINAL_DEFECT_STATUSES.has(status);
}

function clamp(n, lo, hi) {
  n = Number(n);
  if (Number.isNaN(n)) return lo;
  return Math.max(lo, Math.min(hi, n));
}

// ---------------------------------------------------------------------------
// Friction auction (canonical "Friction Auction" prompt).
//   Priority = Leverage x Certainty x Time-to-unblock x Risk
// Each factor is 1..10. Higher priority = attack this bottleneck first.
//   leverage : how much unblocking this frees up downstream (10 = unblocks all)
//   certainty: how sure we are it is actually the blocker (10 = proven)
//   speed    : time-to-unblock, where 10 = fast to clear, 1 = slow grind
//   risk     : cost of ignoring it (10 = the whole thing fails if left)
// ---------------------------------------------------------------------------

function scoreFriction(obstacles) {
  if (!Array.isArray(obstacles)) {
    throw new Error('friction expects a JSON array of obstacles');
  }
  const scored = obstacles.map((o, i) => {
    const leverage = clamp(o.leverage, 1, 10);
    const certainty = clamp(o.certainty, 1, 10);
    const speed = clamp(o.speed != null ? o.speed : o.timeToUnblock, 1, 10);
    const risk = clamp(o.risk != null ? o.risk : o.riskOfIgnoring, 1, 10);
    const priority = leverage * certainty * speed * risk;
    return {
      rank: 0,
      name: o.name || o.obstacle || `obstacle-${i + 1}`,
      leverage,
      certainty,
      speed,
      risk,
      priority, // 1..10000
      note: o.note || '',
    };
  });
  scored.sort((a, b) => b.priority - a.priority);
  scored.forEach((s, i) => (s.rank = i + 1));
  const winner = scored[0] || null;
  const runnerUp = scored[1] || null;
  return {
    obstacles: scored,
    winner,
    runnerUp,
    margin: winner && runnerUp ? winner.priority - runnerUp.priority : null,
    // A score is only honest if it names what it ranked. This ranking sees only
    // the obstacles supplied — an unlisted blocker is invisible to it.
    scope: 'only the obstacles supplied — an unlisted blocker is invisible to this ranking',
  };
}

// ---------------------------------------------------------------------------
// Confidence. Starts at 100, drained by unresolved pressure. Never below 0.
// This is the loop's stop condition: high confidence + zero critical debt.
// ---------------------------------------------------------------------------

// One band ladder, shared by every confidence layer so "converging" means the
// same thing whether it describes an artifact, a session, or the ledger.
function confidenceBand(score) {
  if (score >= 85) return 'ship-ready';
  if (score >= 65) return 'converging';
  if (score >= 40) return 'contested';
  if (score >= 20) return 'fragile';
  return 'blocked';
}

function scoreConfidence(state) {
  const penalties = [];
  const openDefects = (state.defects || []).filter(isDefectOpen);
  const bySev = (sev) => openDefects.filter((d) => (d.severity || 'medium').toLowerCase() === sev);

  const critical = bySev('critical');
  const high = bySev('high');
  const medium = bySev('medium');
  const low = bySev('low');

  if (critical.length) penalties.push({ reason: `${critical.length} open critical defect(s)`, cost: 40 * critical.length });
  if (high.length) penalties.push({ reason: `${high.length} open high defect(s)`, cost: 20 * high.length });
  if (medium.length) penalties.push({ reason: `${medium.length} open medium defect(s)`, cost: 8 * medium.length });
  if (low.length) penalties.push({ reason: `${low.length} open low defect(s)`, cost: 2 * low.length });

  const untested = (state.assumptions || []).filter((a) => a.status !== 'tested' && a.status !== 'killed');
  if (untested.length) penalties.push({ reason: `${untested.length} untested assumption(s)`, cost: 10 * untested.length });

  const holey = (state.artifacts || []).filter(
    (a) => a.status !== 'retracted' && Array.isArray(a.holes) && a.holes.length > 0
  );
  if (holey.length) penalties.push({ reason: `${holey.length} artifact(s) with known holes`, cost: 6 * holey.length });

  const openLoops = (state.openLoops || []).filter((l) => l.status !== 'closed');
  if (openLoops.length) penalties.push({ reason: `${openLoops.length} open loop(s)`, cost: 3 * openLoops.length });

  if (!state.nextAction || !String(state.nextAction).trim()) {
    penalties.push({ reason: 'no defined next action', cost: 10 });
  }
  if (!state.objective || !String(state.objective).trim()) {
    penalties.push({ reason: 'no locked objective', cost: 15 });
  }

  const totalCost = penalties.reduce((s, p) => s + p.cost, 0);
  const score = Math.max(0, 100 - totalCost);
  const band = confidenceBand(score);

  // The loop may stop only when no critical/high debt remains AND nothing
  // core is untested AND there is a next action.
  const loopClear =
    critical.length === 0 &&
    high.length === 0 &&
    untested.length === 0 &&
    Boolean(state.nextAction && String(state.nextAction).trim());

  return {
    layer: 'session',
    score,
    band,
    loopClear,
    penalties,
    openDefects: openDefects.length,
    // Naming the scope is what keeps this number from gaslighting: it measures
    // recorded pressure, not correctness. A high score on an empty ledger means
    // "nothing is recorded as wrong," never "the code is right."
    scope:
      'recorded loop pressure, not correctness — open defects, untested assumptions, open loops, and whether objective/next-action are set. Whether the loop may stop, not whether any one patch is good; unrecorded fog is invisible to it',
  };
}

// ---------------------------------------------------------------------------
// Three-layer confidence. A single blunt score was the tool's worst UX bug: a
// verified-green patch could read "0/blocked" purely because of unrelated
// historical debt. Splitting the score by SCOPE fixes that — each layer answers
// a different question and can never be dragged down by the others.
//   artifact : is THIS patch good, on its own evidence?
//   session  : can the active loop stop? (scoreConfidence, above)
//   ledger   : how healthy is the historical QA record?
// ---------------------------------------------------------------------------

const ARTIFACT_SCOPE =
  'the current live artifact only — its own holes, the defects attached to it, and its verification evidence. Unrelated open defects and ledger history are deliberately invisible';
const LEDGER_SCOPE =
  'the QA ledger\'s historical hygiene — open/stale defects and failing tests across all features. Not a judgment of the current patch';

// Find the evolve event that verified a given artifact, matched by ship target
// (path) or title. Never falls back to an unrelated event — an artifact with no
// matching event is honestly "unverified", not borrowed-confidence.
function verifyingEvent(artifact, events) {
  if (!artifact || !Array.isArray(events)) return null;
  const keys = [artifact.path, artifact.title].filter(Boolean);
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e && keys.includes(e.target)) return e;
  }
  return null;
}

function scoreArtifactConfidence(state, events = []) {
  const live = (state.artifacts || []).filter((a) => a.status !== 'retracted' && a.status !== 'superseded');
  const artifact = live[live.length - 1] || null;
  const reasons = [];
  if (!artifact) {
    return { layer: 'artifact', score: null, band: 'none', artifact: null, reasons: ['no live artifact recorded'], scope: ARTIFACT_SCOPE };
  }

  let score = 100;
  const holes = Array.isArray(artifact.holes) ? artifact.holes : [];
  if (holes.length) {
    score -= 15 * holes.length;
    reasons.push(`${holes.length} explicit hole(s) in the artifact`);
  }

  // Only defects ATTACHED to this artifact and still open — never unrelated debt.
  const attached = (state.defects || []).filter((d) => d.artifact === artifact.id && isDefectOpen(d));
  for (const d of attached) {
    const sev = (d.severity || 'medium').toLowerCase();
    const cost = sev === 'critical' ? 25 : sev === 'high' ? 15 : sev === 'medium' ? 8 : 3;
    score -= cost;
  }
  if (attached.length) reasons.push(`${attached.length} open defect(s) attached to this artifact`);

  const ev = verifyingEvent(artifact, events);
  if (!ev) {
    score -= 10;
    reasons.push('no independent verification recorded for this artifact');
  } else if (ev.verdict === 'KEEP') {
    const seam = ev.seam || {};
    if (ev.mode === 'code' && seam.seamMatch && seam.seamMatch !== 'exact' && !(seam.waiver && seam.waiver.by)) {
      score -= 20;
      reasons.push(`proven only on a ${seam.seamMatch} seam — not the ship seam`);
    } else {
      reasons.push('verified: KEEP with acceptable seam evidence');
    }
    if (seam.independentFromBuilderMethod === false) {
      score -= 10;
      reasons.push('verification repeated the builder method (not independent)');
    }
  } else if (ev.verdict === 'REVERT' || ev.verdict === 'REVERTED_AND_LEARNED') {
    score -= 30;
    reasons.push(`last verdict was ${ev.verdict} — the change did not hold`);
  } else if (ev.verdict === 'ASK') {
    score -= 15;
    reasons.push('last verdict was ASK — unresolved');
  }

  score = Math.max(0, Math.min(100, score));
  return {
    layer: 'artifact',
    score,
    band: confidenceBand(score),
    artifact: { id: artifact.id, title: artifact.title, status: artifact.status },
    reasons,
    scope: ARTIFACT_SCOPE,
  };
}

function scoreLedgerHealth(ledger) {
  const defects = (ledger && ledger.defects) || [];
  const tests = (ledger && ledger.tests) || [];
  const openDefects = defects.filter(isDefectOpen).length;
  const failingTests = tests.filter((t) => t.status === 'fail').length;
  const reasons = [];
  let score = 100;
  if (openDefects) {
    score -= 10 * openDefects;
    reasons.push(`${openDefects} open ledger defect(s)`);
  }
  if (failingTests) {
    score -= 8 * failingTests;
    reasons.push(`${failingTests} failing test(s) in the ledger`);
  }
  if (!reasons.length) reasons.push('ledger clean — no open defects, no failing tests');
  score = Math.max(0, Math.min(100, score));
  return {
    layer: 'ledger',
    score,
    band: confidenceBand(score),
    counts: { openDefects, failingTests, defects: defects.length, tests: tests.length },
    reasons,
    scope: LEDGER_SCOPE,
  };
}

// The three layers together — each scoped, none able to drag the others down.
function scoreConfidenceLayers(state, ledger, events = []) {
  return {
    artifact: scoreArtifactConfidence(state, events),
    session: scoreConfidence(state),
    ledger: scoreLedgerHealth(ledger || {}),
  };
}

// ---------------------------------------------------------------------------
// Aperture (0.4). The dial that meters how much of the loop to run. Score five
// uncertainty dimensions 0..2, sum to 0..10, map to A0..A4, and emit the ratchet
// skill sequence to run at that depth. The point is anti-ceremony: spend the
// full loop only when uncertainty earns it; snap when it doesn't.
//   ambiguity     : are goals / acceptance criteria / constraints unclear?
//   terrain       : is the codebase / domain / tooling unfamiliar?
//   taste         : would the user recognize the right answer only once shown?
//   blastRadius   : could it hit data, security, production, many files/users?
//   reversibility : is the change hard to undo or validate?
// ---------------------------------------------------------------------------

const APERTURE_DIMENSIONS = ['ambiguity', 'terrain', 'taste', 'blastRadius', 'reversibility'];

// Two invariants hold across every band, and a test pins both: the sequence ENDS
// on compile (work that is never serialized is work the next session cannot
// resume), and any sequence that builds VERIFIES after its last build/patch
// (otherwise the last edit ships unrun). A0 gained compile and A3 gained verify
// on exactly those grounds; A4 ends on compile because a decision is an artifact.
const APERTURE_LEVELS = [
  { max: 2, level: 'A0', name: 'Snap', implement: true, sequence: ['build', 'verify', 'compile'] },
  { max: 4, level: 'A1', name: 'Narrow', implement: true, sequence: ['lock', 'build', 'verify', 'compile'] },
  { max: 6, level: 'A2', name: 'Working', implement: true, sequence: ['lock', 'cut', 'build', 'attack', 'patch', 'verify', 'compile'] },
  { max: 8, level: 'A3', name: 'Wide', implement: true, sequence: ['lock', 'map', 'auction', 'cut', 'decide', 'build', 'attack', 'patch', 'verify', 'compile'] },
  { max: 10, level: 'A4', name: 'Max', implement: false, sequence: ['lock', 'map', 'cut', 'decide', 'compile'] },
];

// A missing dimension defaults to 1 (neutral), never 0 — treating unknown
// uncertainty as "certain" would under-open the aperture, the exact failure the
// dial exists to prevent.
function apertureDim(dims, key) {
  const v = dims ? dims[key] : undefined;
  return v == null ? 1 : clamp(v, 0, 2);
}

function scoreAperture(dims) {
  if (dims == null || typeof dims !== 'object' || Array.isArray(dims)) {
    throw new Error(
      'aperture expects a JSON object of dimensions (ambiguity, terrain, taste, blastRadius, reversibility), each 0-2'
    );
  }
  const scored = {};
  let total = 0;
  for (const key of APERTURE_DIMENSIONS) {
    const v = apertureDim(dims, key);
    scored[key] = v;
    total += v;
  }
  const band = APERTURE_LEVELS.find((b) => total <= b.max) || APERTURE_LEVELS[APERTURE_LEVELS.length - 1];
  // The pre-build fog gate (/ratchet:map) is earned by high overall uncertainty
  // (A3+), OR by a single dimension the summed score under-weights: "know it when
  // I see it" taste, or unfamiliar terrain paired with any goal ambiguity. Those
  // can sit below the A3 band yet still make a confident build the wrong move — so
  // the flag can fire even when the metered sequence for this band does not
  // include `map`, signalling "map first anyway."
  const mapRequired =
    total >= 7 || scored.taste === 2 || (scored.terrain === 2 && scored.ambiguity >= 1);
  return {
    score: total, // 0..10
    level: band.level, // A0..A4
    name: band.name,
    implement: band.implement, // A4: do NOT build until constraints are locked
    sequence: band.sequence.slice(), // ratchet skills to run at this depth
    mapRequired, // route through /ratchet:map before building (see above)
    dimensions: scored,
    // This reading is only valid for the task as scored, at scoring time.
    scope: 'the one task scored, at scoring time — re-score if the task or its constraints change',
  };
}

module.exports = {
  scoreFriction,
  scoreConfidence,
  scoreArtifactConfidence,
  scoreLedgerHealth,
  scoreConfidenceLayers,
  confidenceBand,
  scoreAperture,
  clamp,
  isDefectOpen,
  TERMINAL_DEFECT_STATUSES,
  APERTURE_DIMENSIONS,
  APERTURE_LEVELS,
};
