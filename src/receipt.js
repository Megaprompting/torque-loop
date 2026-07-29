'use strict';

const state = require('./state');
const scoring = require('./scoring');
const journal = require('./evolve/journal');
const gitRefs = require('./gitRefs');
const coldStart = require('./coldStart');

// The receipt: one stable, always-same-shape answer to "what is true, what
// changed, what was proven, what is at risk, what is safe, and what happens
// next" — so a cold human or agent resumes without transcript archaeology. It
// joins the records the loop keeps: session state, the evolve journal
// (proof/seam/verdict), the QA ledger (historical health), and git (authority
// state). Every field is always present; emptiness is stated explicitly, never
// omitted, so the shape does not shift between commands or sessions — that
// stability is what makes it readable in under a minute.

function uniq(arr) {
  return [...new Set(arr)];
}

// Files touched since the last compile — the honest "what changed" set. Before
// the first compile, everything tracked counts as uncompiled delta.
function touchedSinceCompile(s) {
  const compileAt = s.lastCompileAt || '';
  const touched = Array.isArray(s.touchedFiles) ? s.touchedFiles : [];
  const since = compileAt ? touched.filter((f) => f && f.at && f.at > compileAt) : touched;
  return uniq(since.map((f) => f && f.path).filter(Boolean));
}

// The authority ladder: how far this work has traveled toward irreversibility.
// Dirty tree wins (there is uncommitted work on top of everything else), then a
// tag (released), then a remote branch containing HEAD (pushed), else local.
function authorityState(git) {
  if (!git || !git.isRepo) return { level: 'no-vcs', label: 'not a git repository' };
  if (git.dirty) return { level: 'uncommitted', label: 'uncommitted — working tree dirty' };
  if (git.headTags && git.headTags.length) {
    return { level: 'released', label: `released — tag ${git.headTags.join(', ')}` };
  }
  if (git.remoteContainsHead) return { level: 'pushed', label: 'pushed — a remote branch contains HEAD' };
  return { level: 'committed-local', label: 'committed-local — HEAD is on no remote branch' };
}

function assemble(cwd = process.cwd()) {
  const s = state.loadState(cwd);
  let ledger = {};
  try {
    ledger = state.loadLedger(cwd);
  } catch (_e) {
    ledger = {};
  }

  let events = [];
  try {
    events = journal.readEvents(cwd);
  } catch (_e) {
    events = [];
  }
  const lastEvent = events.length ? events[events.length - 1] : null;
  const lastKeep = [...events].reverse().find((e) => e && e.verdict === 'KEEP') || null;
  // Seam is read from the most recent proven KEEP if there is one, else the last
  // event — a REVERT still carries the seam it was judged on.
  const seamSource = lastKeep || lastEvent;

  const layers = scoring.scoreConfidenceLayers(s, ledger, events);

  let git = null;
  try {
    git = gitRefs.statusRefs(cwd);
  } catch (_e) {
    git = null;
  }

  let controlScan = { ok: true, configured: false, checks: [] };
  try {
    controlScan = coldStart.scan(cwd);
  } catch (e) {
    // A control-plane scan that crashes is itself unsafe steering. Keep the
    // receipt usable, but say the one cold read cannot be trusted as clean.
    controlScan = {
      ok: false,
      configured: false,
      checks: [{ name: 'cold-start scan', level: 'fail', detail: e && e.message ? e.message : String(e) }],
    };
  }
  const controlChecks = Array.isArray(controlScan.checks) ? controlScan.checks : [];
  const controlFailures = controlChecks.filter((c) => c.level === 'fail').length;
  const controlWarnings = controlChecks.filter((c) => c.level === 'warn').length;

  const artifactsArr = s.artifacts || [];
  const defectsArr = s.defects || [];
  const liveArtifacts = artifactsArr.filter((a) => a.status !== 'retracted' && a.status !== 'superseded');
  const lastArtifact = artifactsArr[artifactsArr.length - 1] || null;
  const openDefects = defectsArr.filter(scoring.isDefectOpen);
  const untested = (s.assumptions || []).filter((a) => a.status !== 'tested' && a.status !== 'killed');
  const openLoops = (s.openLoops || []).filter((l) => l.status !== 'closed');
  const stale = Boolean(s.dirty && (!s.lastCompileAt || s.lastCompileAt < s.updatedAt));

  // FOG — build-for-learn state, cold-start-safe: live unknown-maps with their
  // OPEN item counts (their holes), fog loops the aperture recorded but no map
  // answered, and probes split live (residue) / disposed (completed).
  const probeArts = artifactsArr.filter((a) => a.kind === 'probe');
  const fog = {
    maps: liveArtifacts
      .filter((a) => a.kind === 'unknown-map')
      .map((a) => ({ id: a.id, title: a.title, openItems: Array.isArray(a.holes) ? a.holes.length : 0 })),
    fogLoops: openLoops.filter((l) => /^fog:/i.test(String(l.text || ''))).length,
    probes: {
      live: probeArts.filter((a) => a.status !== 'retracted' && a.status !== 'superseded').length,
      disposed: probeArts.filter((a) => a.status === 'retracted' || a.status === 'superseded').length,
    },
  };

  // PROOF — the evidence card for the most recent KEEP, plus defects cleared
  // with recorded proof. The KEEP gate already guarantees this data exists for a
  // kept mutation; the receipt just makes it a first-class card.
  const resolvedWithEvidence = defectsArr
    .filter((d) => (d.status === 'resolved' || d.status === 'closed') && d.evidence)
    .map((d) => ({ id: d.id, summary: d.summary, evidence: d.evidence }));

  const keepCard = lastKeep
    ? {
        id: lastKeep.id || '',
        target: lastKeep.target || '',
        mutation: lastKeep.chosenMutation || '',
        mode: lastKeep.mode || '',
        evidenceType: (lastKeep.seam && lastKeep.seam.evidenceType) || '',
        result: (lastKeep.verification && lastKeep.verification.result) || '',
        commands: (lastKeep.verification && lastKeep.verification.commands) || [],
        manualChecks: (lastKeep.verification && lastKeep.verification.manualChecks) || [],
        independent: lastKeep.seam ? lastKeep.seam.independentFromBuilderMethod : null,
      }
    : null;

  const seam =
    seamSource && seamSource.seam
      ? {
          present: Boolean(
            seamSource.seam.testedSeam || seamSource.seam.shipSeam || seamSource.seam.seamMatch
          ),
          testedSeam: seamSource.seam.testedSeam || '',
          shipSeam: seamSource.seam.shipSeam || '',
          seamMatch: seamSource.seam.seamMatch || '',
          independent: seamSource.seam.independentFromBuilderMethod,
          proxyWarning: seamSource.seam.proxyWarning,
          waiver: seamSource.seam.waiver || null,
          fromVerdict: seamSource.verdict || '',
        }
      : { present: false };

  // Ship decision: can the current evidence justify shipping? Exact seam (or a
  // named waiver) → justified. Any proxy/weak/mismatch seam → cannot-justify,
  // said out loud so proxy proof never masquerades as ship proof.
  let shipDecision = 'n/a';
  if (seam.present && seam.seamMatch) {
    const waived = Boolean(seam.waiver && seam.waiver.by);
    shipDecision = seam.seamMatch === 'exact' || waived ? 'justified' : 'cannot-justify';
  }

  // RISK — what is still open. Remaining risks the loop recorded, plus live
  // artifact holes, plus open critical/high defects. This is the "what must not
  // be trusted yet" surface.
  const risk = [];
  if (lastEvent && Array.isArray(lastEvent.remainingRisks)) {
    for (const t of lastEvent.remainingRisks) risk.push({ text: t, from: 'evolve' });
  }
  for (const a of liveArtifacts) {
    for (const h of Array.isArray(a.holes) ? a.holes : []) risk.push({ text: `${a.title}: ${h}`, from: 'artifact-hole' });
  }
  for (const d of openDefects) {
    const sev = (d.severity || '').toLowerCase();
    if (sev === 'critical' || sev === 'high') risk.push({ text: `[${d.severity}] ${d.summary}`, from: 'defect' });
  }

  // AUTHORITY — every irreversible action taken and the named owner who
  // authorized it. An irreversible action with no owner is exactly what the
  // gates refuse, so this list can only be populated by authorized moves.
  const waivedDefects = defectsArr
    .filter((d) => d.status === 'waived')
    .map((d) => ({ id: d.id, summary: d.summary, by: d.waivedBy || '', reason: d.waiveReason || '' }));
  const retractedArtifacts = artifactsArr
    .filter((a) => a.status === 'retracted')
    .map((a) => ({
      id: a.id,
      title: a.title,
      reason: (a.retracted && a.retracted.reason) || '',
      supersededBy: (a.retracted && a.retracted.supersededBy) || '',
    }));
  const seamWaivers = events
    .filter((e) => e && e.seam && e.seam.waiver && e.seam.waiver.by)
    .map((e) => ({ id: e.id, by: e.seam.waiver.by, reason: e.seam.waiver.reason || '' }));

  return {
    validAsOf: s.updatedAt || '',
    target: {
      locked: Boolean(s.objective && String(s.objective).trim()),
      objective: s.objective || '',
      bottleneck: s.bottleneck || '',
      evolveTarget: lastEvent ? { target: lastEvent.target || '', goal: lastEvent.goal || '' } : null,
    },
    delta: {
      stale,
      dirty: Boolean(s.dirty),
      lastCompileAt: s.lastCompileAt || null,
      touched: touchedSinceCompile(s),
      lastArtifact: lastArtifact
        ? { title: lastArtifact.title, kind: lastArtifact.kind, status: lastArtifact.status }
        : null,
      gitDirty: git ? Boolean(git.dirty) : null,
    },
    proof: {
      keep: keepCard,
      seam,
      shipDecision,
      resolvedWithEvidence,
    },
    verdict: {
      loop: lastEvent ? lastEvent.verdict : '',
      artifact: layers.artifact,
      session: layers.session,
      ledger: layers.ledger,
    },
    risk,
    controlPlane: {
      ok: Boolean(controlScan.ok),
      configured: Boolean(controlScan.configured),
      failures: controlFailures,
      warnings: controlWarnings,
      checks: controlChecks.map((c) => ({ name: c.name || '', level: c.level || 'warn', detail: c.detail || '' })),
    },
    authority: {
      authorityState: authorityState(git),
      waivedDefects,
      retractedArtifacts,
      seamWaivers,
      enforced: [
        'state reset — requires --force + --owner + --reason',
        'artifact close — requires a KEEP bound to this exact revision',
        'defect resolve — requires --evidence',
        'defect waive — requires --owner + --reason',
        'artifact retract — requires --reason',
        'code KEEP — requires exact ship-seam match or a named waiver',
        'canonical writes — only the scribe; builder/auditor are propose-only (RATCHET_AGENT)',
      ],
    },
    state: {
      phase: s.phase || 'idle',
      openDefects: openDefects.map((d) => ({ severity: d.severity, summary: d.summary })),
      untested: untested.length,
      openLoops: openLoops.length,
      fog,
      dirty: Boolean(s.dirty),
      stale,
      git:
        git && git.isRepo
          ? {
              branch: git.branch,
              head: git.head,
              dirty: git.dirty,
              comparisons: git.comparisons || [],
              unpushed: git.unpushed,
            }
          : null,
    },
    next: {
      action: s.nextAction || '',
      command: s.nextCommand || '',
      edge: lastEvent ? lastEvent.nextEdge || '' : '',
    },
    gaps: openLoops.map((l) => ({ text: l.text, status: l.status })),
  };
}

module.exports = { assemble, touchedSinceCompile, authorityState };
