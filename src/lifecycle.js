'use strict';

const fs = require('fs');
const path = require('path');

const scoring = require('./scoring');
const { sha256 } = require('./evolve/snapshot');

// Closure derivation. One pure module that answers, from records only: what is
// this artifact's identity right now, which proof is bound to THAT identity,
// what still blocks closing it, and what the single next transition is.
//
// Pure on purpose — it never reads the journal itself (events are always passed
// in) and never writes. Four surfaces call it (receipt, state summary, compile
// done, the stop hook) so they cannot drift into four different answers about
// whether the work is closed.

// A retracted or superseded artifact is out of the lifecycle. `closed` is NOT
// in this set: a bare status:'closed' from a pre-0.8 store is an uncertified
// claim, and it must be made to earn the certificate like anything else.
const OUT_OF_LIFECYCLE = new Set(['retracted', 'superseded']);

function isOutOfLifecycle(a) {
  return Boolean(a) && OUT_OF_LIFECYCLE.has(String(a.status || '').toLowerCase());
}

// The closure certificate. A close is only real if it names the proof that
// authorized it and the exact revision + hash it was granted against — that
// triple is what a later revision invalidates. Status alone is a claim.
function isClosed(a) {
  return Boolean(
    a &&
      String(a.status || '').toLowerCase() === 'closed' &&
      a.closedBy &&
      Number.isInteger(a.closedRev) &&
      a.closedHash
  );
}

// Artifacts still in play: not retracted, not superseded, not certified closed.
function liveArtifacts(state) {
  return ((state && state.artifacts) || []).filter((a) => a && !isOutOfLifecycle(a) && !isClosed(a));
}

// The artifact the loop is currently steering — the most recent one that has
// not left the lifecycle. A certified-closed artifact stays active (it is still
// what this session produced); `liveArtifacts` is the set that still needs work.
function activeArtifact(state) {
  const inPlay = ((state && state.artifacts) || []).filter((a) => a && !isOutOfLifecycle(a));
  return inPlay[inPlay.length - 1] || null;
}

function sameCase(p) {
  return process.platform === 'win32' ? String(p).toLowerCase() : String(p);
}

function isInside(root, candidate) {
  const r = sameCase(root);
  const c = sameCase(candidate);
  return c === r || c.startsWith(r.endsWith(path.sep) ? r : r + path.sep);
}

// The identity a proof binds to. Record scope hashes what the record itself
// claims, so a retitled or re-holed artifact is a different thing to prove.
function recordPayload(a) {
  return `record:${a.kind || ''}\n${a.title || ''}\n${JSON.stringify(a.holes || [])}`;
}

// { rev, hash, hashScope, downgradeReason }. hashScope is 'file' when the
// artifact points at real bytes and 'record' when it does not — never silently
// one pretending to be the other, because a file-scope hash is a much stronger
// claim and the difference has to reach every render.
function fingerprint(cwd, artifact) {
  const a = artifact || {};
  const rev = Number.isInteger(a.rev) && a.rev > 0 ? a.rev : 1;
  const raw = String(a.path || '').trim();
  const asRecord = (downgradeReason) => ({ rev, hash: sha256(recordPayload(a)), hashScope: 'record', downgradeReason });

  if (!raw) return asRecord('');

  const root = path.resolve(cwd || process.cwd());
  const resolved = path.resolve(root, raw);
  // Containment is checked before existence so an absolute path outside the
  // project is refused rather than quietly downgraded into a record hash.
  if (!isInside(root, resolved)) {
    throw new Error(
      `cannot bind artifact "${a.id || ''}": path "${raw}" resolves outside the project — binding refused`
    );
  }
  let real;
  try {
    real = fs.realpathSync(resolved);
  } catch (_e) {
    // Not a path on disk at all (the common case is a fragment or anchor like
    // "CHANGELOG.md#unreleased"). Downgrade, but say so everywhere.
    return asRecord(`path "${raw}" does not resolve to a file — hashed as a record, not file bytes`);
  }
  // Re-check after realpath: a symlink inside the project can point out of it.
  if (!isInside(fs.realpathSync(root), real)) {
    throw new Error(
      `cannot bind artifact "${a.id || ''}": path "${raw}" links outside the project (${real}) — binding refused`
    );
  }
  if (!fs.statSync(real).isFile()) {
    throw new Error(`cannot bind artifact "${a.id || ''}": path "${raw}" is not a regular file — binding refused`);
  }
  // Hash the raw BYTES, not a decoded string: reading as utf8 maps every invalid
  // byte to U+FFFD, so two different binaries hash identically and a KEEP bound
  // to one authorizes closing the other. Valid UTF-8 hashes the same either way,
  // so no existing text binding moves.
  return { rev, hash: sha256(fs.readFileSync(real)), hashScope: 'file', downgradeReason: '' };
}

// The one KEEP that authorizes closing THIS revision of THIS artifact.
// The LATEST event on the binding wins whatever its verdict, so a REVERT
// recorded after a KEEP on the same revision revokes it. There is deliberately
// no fallback to matching by path or title: an unbound event is evidence about
// a file, never authority over a record.
function bindingEvent(artifact, events, fp) {
  if (!artifact || !Array.isArray(events) || !fp) return null;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (!e || !e.artifactId || e.artifactId !== artifact.id) continue;
    if (e.artifactRev !== fp.rev || e.artifactHash !== fp.hash) continue;
    // Scope is part of the identity, not decoration. Record scope hashes
    // `record:<kind>\n<title>\n<holes>`, so a FILE containing exactly those bytes
    // collides — and without this check an old record/manual KEEP would close a
    // new code file, skipping both the seam gate and the record-owner gate.
    if (String(e.hashScope || '') !== fp.hashScope) continue;
    return e.verdict === 'KEEP' ? e : null;
  }
  return null;
}

const BLOCKER_ORDER = ['terminal', 'probe', 'no-bound-proof', 'open-defects', 'holes'];

// Everything standing between this artifact and a certified close, in one
// fixed order so the refusal text never reshuffles between runs. Empty = closable.
function closureBlockers(state, events, artifact, cwd, request = {}) {
  const s = state || {};
  const out = [];
  if (!artifact) return [{ code: 'terminal', message: 'no artifact to close' }];

  if (isOutOfLifecycle(artifact)) {
    out.push({
      code: 'terminal',
      message: `artifact "${artifact.id}" is ${artifact.status} — it has already left the lifecycle and cannot be closed`,
    });
  }

  if (String(artifact.kind || '') === 'probe') {
    out.push({
      code: 'probe',
      message:
        'a probe never closes — it is disposed or promoted: ' +
        `ratchet retract ${artifact.id} --reason "disposed: …" or "promoted: …" --superseded-by <id>.`,
    });
  }

  let fp = null;
  let fpError = '';
  try {
    fp = fingerprint(cwd, artifact);
  } catch (e) {
    fpError = e && e.message ? e.message : String(e);
  }
  const bound = fp ? bindingEvent(artifact, events || [], fp) : null;
  if (!bound) {
    out.push({
      code: 'no-bound-proof',
      message: fpError
        ? `cannot close artifact "${artifact.id}": ${fpError}`
        : `cannot close artifact "${artifact.id}": no KEEP proof bound to this exact revision ` +
          `(rev ${fp.rev}, ${fp.hashScope} hash ${String(fp.hash).slice(0, 8)}). ` +
          'Run the harness and record it (ratchet-evolve verify --artifact, then log append), then close. ' +
          'Revising an artifact invalidates earlier proof. Checkpoint is not closure; no proof → no close.',
    });
  }

  const attached = (s.defects || []).filter((d) => d && d.artifact === artifact.id && scoring.isDefectOpen(d));
  if (attached.length) {
    out.push({
      code: 'open-defects',
      message:
        `cannot close artifact "${artifact.id}": ${attached.length} open defect(s) attached ` +
        `(${attached.map((d) => d.id).join(', ')}) — clear each with ratchet defect resolve <id> --evidence "<proof>" ` +
        '(or waive with --owner + --reason).',
    });
  }

  const holes = Array.isArray(artifact.holes) ? artifact.holes : [];
  const waived = Boolean(request.waiveHoles && String(request.owner || '').trim() && String(request.reason || '').trim());
  if (holes.length && !waived) {
    out.push({
      code: 'holes',
      message:
        `cannot close artifact "${artifact.id}": ${holes.length} open hole(s) (${holes.join('; ')}) — ` +
        'fill them and revise the artifact, or accept them with ' +
        `ratchet artifact close ${artifact.id} --waive-holes --owner "<who>" --reason "<why>".`,
    });
  }

  out.sort((a, b) => BLOCKER_ORDER.indexOf(a.code) - BLOCKER_ORDER.indexOf(b.code));
  return out;
}

const WORKFLOW_SCOPE =
  'the active artifact and the defects recorded against it — unrecorded work is invisible to it, and a checkpoint (compile done) never changes this answer';

// Is the WORKFLOW closed, not merely serialized? Distinct from `compile done`,
// which only says the record is current. Legacy orphan defects (no artifact)
// block it: work nobody attached is still work nobody cleared.
function workflowClosed(state, events, cwd) {
  const s = state || {};
  const blockers = [];
  const artifact = activeArtifact(s);

  if (!artifact) {
    blockers.push({ code: 'no-artifact', message: 'no live artifact recorded — nothing has been built to close' });
  } else if (!isClosed(artifact)) {
    const b = closureBlockers(s, events, artifact, cwd);
    if (b.length) blockers.push(...b);
    else
      blockers.push({
        code: 'not-closed',
        message: `artifact "${artifact.id}" is closable but not closed: ratchet artifact close ${artifact.id}`,
      });
  }

  const orphans = (s.defects || []).filter((d) => d && scoring.isDefectOpen(d) && !String(d.artifact || '').trim());
  if (orphans.length) {
    blockers.push({
      code: 'unattached-defects',
      message:
        `${orphans.length} open defect(s) attach to no artifact (${orphans.map((d) => d.id).join(', ')}) — ` +
        'attach or clear them; unowned work cannot ride out on someone else\'s closure.',
    });
  }

  return {
    closed: blockers.length === 0,
    artifact: artifact ? { id: artifact.id, title: artifact.title, status: artifact.status } : null,
    blockers,
    scope: WORKFLOW_SCOPE,
  };
}

const TRANSITION_SCOPE = 'recorded state only — the next move it names is the next RECORDED gap, not the next good idea';

function remedyFor(blocker, artifact, state) {
  switch (blocker.code) {
    case 'terminal':
      return {
        label: `artifact ${artifact.id} has left the lifecycle — record its replacement`,
        command: 'ratchet artifact add \'{"title":"<replacement>","kind":"<kind>"}\'',
      };
    case 'probe':
      return {
        label: `dispose or promote probe ${artifact.id}`,
        command: `ratchet retract ${artifact.id} --reason "disposed: <finding recorded>"`,
      };
    case 'no-bound-proof':
      return {
        label: `bind proof to ${artifact.id} rev ${Number.isInteger(artifact.rev) ? artifact.rev : 1}`,
        command: `ratchet-evolve verify ${artifact.path || '<target>'} --artifact ${artifact.id}`,
      };
    case 'open-defects': {
      const first = ((state && state.defects) || []).find(
        (d) => d && d.artifact === artifact.id && scoring.isDefectOpen(d)
      );
      return {
        label: `clear the defects attached to ${artifact.id}`,
        command: `ratchet defect resolve ${first ? first.id : '<id>'} --evidence "<proof it is fixed>"`,
      };
    }
    case 'holes':
      return {
        label: `fill or waive the open holes on ${artifact.id}`,
        command: `ratchet artifact close ${artifact.id} --waive-holes --owner "<who>" --reason "<why>"`,
      };
    default:
      return { label: blocker.code, command: blocker.message };
  }
}

// The single next move, derived — never stored, so it cannot go stale. Fixed
// shape: every caller renders the same four fields whatever the state.
function nextTransition(state, events, cwd) {
  const s = state || {};
  const fixed = (label, command, reason) => ({ label, command, reason, scope: TRANSITION_SCOPE });

  if (!String(s.objective || '').trim()) {
    return fixed('lock the target', '/ratchet:lock', 'no objective is locked — every other move is guesswork until one is');
  }

  const blocking = (s.defects || []).filter((d) => {
    const sev = String((d && d.severity) || '').toLowerCase();
    return d && scoring.isDefectOpen(d) && (sev === 'critical' || sev === 'high');
  });
  if (blocking.length) {
    const d = blocking[0];
    return fixed(
      `resolve ${d.severity} defect ${d.id}`,
      `ratchet defect resolve ${d.id} --evidence "<proof it is fixed>"`,
      `${blocking.length} open critical/high defect(s) outrank everything else`
    );
  }

  const live = liveArtifacts(s);
  const artifact = live[live.length - 1] || null;
  if (artifact) {
    const blockers = closureBlockers(s, events, artifact, cwd);
    if (blockers.length) {
      const r = remedyFor(blockers[0], artifact, s);
      return fixed(r.label, r.command, blockers[0].message);
    }
    return fixed(
      `close artifact ${artifact.id}`,
      `ratchet artifact close ${artifact.id}`,
      'proof is bound to this exact revision and nothing else blocks it — closure is earned'
    );
  }

  if (s.dirty) {
    return fixed(
      'checkpoint the session',
      'ratchet compile done',
      'every artifact is closed and the record has uncompiled changes'
    );
  }

  const stored = String(s.nextCommand || '').trim();
  if (stored) return fixed(String(s.nextAction || '').trim() || 'run the recorded next command', stored, 'taken from recorded state');
  return fixed('nothing pending', 'nothing pending', 'no objective gap, no blocking defect, no open artifact, nothing uncompiled');
}

module.exports = {
  isClosed,
  isOutOfLifecycle,
  liveArtifacts,
  activeArtifact,
  fingerprint,
  bindingEvent,
  closureBlockers,
  workflowClosed,
  nextTransition,
  BLOCKER_ORDER,
};
