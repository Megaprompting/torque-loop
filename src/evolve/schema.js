'use strict';

// Shapes + constants for the evolution loop. The model drives the reasoning;
// these keep the record deterministic.

const PRESSURES = [
  'clarity',
  'correctness',
  'testability',
  'brevity',
  'specificity',
  'robustness',
  'user-friction',
  'security',
  'maintainability',
  'novelty',
  'conversion',
];

const MODES = ['code', 'prompt', 'docs', 'workflow', 'auto'];
// REVERTED_AND_LEARNED is a *successful* outcome: a mutation was reverted after
// verification and a reusable lesson/test remained. Like REVERT it never claims
// a kept improvement, so it bypasses the KEEP proof gate.
const VERDICTS = ['KEEP', 'REVERT', 'ASK', 'REVERTED_AND_LEARNED'];

// Seam fidelity (0.3). How close the tested seam is to the seam the artifact
// actually ships on, and what kind of evidence produced the claim.
const SEAM_MATCHES = ['exact', 'close-proxy', 'weak-proxy', 'mismatch'];
const EVIDENCE_TYPES = ['test', 'manual', 'code-read', 'live-call', 'static-analysis', 'eval', 're-run'];

// A human waiver is only valid if it names who accepts the risk and why.
function normalizeWaiver(w) {
  if (!w || typeof w !== 'object') return null;
  const by = w.by || w.owner || '';
  const reason = w.reason || '';
  return by && reason ? { by, reason } : null;
}

function nowIso() {
  if (process.env.RATCHET_NOW) return process.env.RATCHET_NOW;
  return new Date().toISOString();
}

// One line of .ratchet/evolve-log.jsonl.
function newEvent(f = {}) {
  return {
    id: f.id || null,
    target: f.target || '',
    goal: f.goal || '',
    iteration: f.iteration != null ? f.iteration : 1,
    mode: MODES.includes(f.mode) ? f.mode : '',
    pressure: {
      primary: f.pressure?.primary || (f.primary || ''),
      secondary: f.pressure?.secondary || (f.secondary || ''),
    },
    chosenMutation: f.chosenMutation || '',
    filesTouched: Array.isArray(f.filesTouched) ? f.filesTouched : [],
    verification: {
      commands: f.verification?.commands || [],
      manualChecks: f.verification?.manualChecks || [],
      result: f.verification?.result || 'manual', // pass | fail | manual
    },
    // Seam-fidelity metadata: what was tested, how, and whether that seam is the
    // one the artifact actually ships on. The KEEP gate reads this for code.
    seam: {
      evidenceType: f.seam?.evidenceType || f.evidenceType || '',
      method: f.seam?.method || f.method || '',
      independentFromBuilderMethod: f.seam?.independentFromBuilderMethod ?? f.independentFromBuilderMethod ?? null,
      testedSeam: f.seam?.testedSeam || f.testedSeam || '',
      shipSeam: f.seam?.shipSeam || f.shipSeam || '',
      seamMatch: SEAM_MATCHES.includes(f.seam?.seamMatch || f.seamMatch) ? f.seam?.seamMatch || f.seamMatch : '',
      proxyWarning: f.seam?.proxyWarning ?? f.proxyWarning ?? null,
      waiver: normalizeWaiver(f.seam?.waiver || f.waiver),
    },
    verdict: VERDICTS.includes(f.verdict) ? f.verdict : 'ASK',
    remainingRisks: Array.isArray(f.remainingRisks) ? f.remainingRisks : [],
    nextEdge: f.nextEdge || '',
    timestamp: f.timestamp || nowIso(),
  };
}

// The proof gate. "No proof → no keep": a KEEP verdict may only be recorded when
// verification actually produced evidence and did not fail. REVERT and ASK are
// exempt — they exist precisely to record the absence of a proven improvement.
// Throws (does not return a boolean) so a bad KEEP can never be silently written.
function validateKeepGate(event) {
  if (!event || event.verdict !== 'KEEP') return event;
  const v = event.verification || {};
  const result = v.result;
  const commands = Array.isArray(v.commands) ? v.commands : [];
  const manualChecks = Array.isArray(v.manualChecks) ? v.manualChecks : [];

  if (result === 'fail') {
    throw new Error('cannot KEEP: verification failed');
  }
  if (!commands.length && !manualChecks.length) {
    throw new Error('cannot KEEP: no verification evidence');
  }
  // The summary field is a claim; the commands are the evidence. Derive the
  // result from the commands and let the derivation win, so a red run can never
  // be laundered into a KEEP by relabelling `result`. A command entry with no
  // `pass` field (a bare string) carries no machine verdict at all — it is a
  // note, not proof.
  if (commands.length) {
    const unverdicted = commands.filter((c) => !c || typeof c !== 'object' || !('pass' in c));
    if (unverdicted.length) {
      throw new Error(
        'cannot KEEP: a verification command carries no machine verdict — record {command, pass} entries ' +
          '(the shape `ratchet-evolve verify` emits), not bare strings'
      );
    }
    const failed = commands.filter((c) => c.pass !== true);
    if (failed.length) {
      throw new Error(
        `cannot KEEP: verification command did not pass (${failed.map((c) => c.command || 'unnamed command').join(', ')})`
      );
    }
    if (result !== 'pass') {
      throw new Error(`cannot KEEP: claimed result "${result || 'unset'}" contradicts the commands run (derived "pass")`);
    }
  }
  if (result === 'manual' && !manualChecks.length) {
    throw new Error('cannot KEEP: manual verification requires explicit checks');
  }

  // Seam gate (0.3 — "wrong proof → no ship"). Production code cannot be KEPT on
  // evidence from a different seam than the one it ships on: a proxy eval can
  // show the right-looking number and still point at the wrong decision. Require
  // an exact ship-seam match (or an explicit, named human waiver). Non-code
  // artifacts (docs/prompt/workflow) keep the lighter manual-evidence contract.
  if (event.mode === 'code') {
    const seam = event.seam || {};
    const waived = Boolean(seam.waiver && seam.waiver.by && seam.waiver.reason);
    if (!waived) {
      if (seam.seamMatch !== 'exact') {
        throw new Error(
          `cannot KEEP production code: evidence seam is "${seam.seamMatch || 'unspecified'}", not "exact" — ` +
            'test the ship seam, or waive with a named owner + reason (wrong proof → no ship)'
        );
      }
      // Strictly true. An omitted/null flag is an unmade claim, and an unmade
      // claim about independence is exactly the one a self-verifying builder
      // leaves out — so silence refuses like a denial does.
      if (seam.independentFromBuilderMethod !== true) {
        throw new Error(
          "cannot KEEP production code: verification did not declare itself independent from the builder's own " +
            'method (seam.independentFromBuilderMethod must be true) — vary the method, or waive with a named owner + reason'
        );
      }
    }
  }
  return event;
}

module.exports = { PRESSURES, MODES, VERDICTS, SEAM_MATCHES, EVIDENCE_TYPES, nowIso, newEvent, validateKeepGate };
