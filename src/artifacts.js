'use strict';

const state = require('./state');
const schemas = require('./schemas');
const scoring = require('./scoring');
const lifecycle = require('./lifecycle');

// Thin helpers for the two collections skills touch most: artifacts + defects.
// Every write flips state.dirty so the Stop hook can nag if nothing was
// compiled afterward.

// The fields a revision may change. Everything else about an artifact is either
// its identity (id, kind) or the record of a gated transition.
const ARTIFACT_MUTABLE = ['title', 'path', 'status', 'holes', 'revises'];

function normalizeHoles(h) {
  if (Array.isArray(h)) return h.map((x) => String(x));
  return h ? [String(h)] : [];
}

// A probe's drain is an invariant, not a convention: build-for-learn code must
// cost confidence until disposed or promoted, even when the caller omits it.
function withProbeHole(kind, holes) {
  if (kind !== 'probe' || holes.some((h) => /disposal:\s*pending/i.test(h))) return holes;
  return holes.concat('disposal: pending');
}

function next_kind(existing) {
  return String((existing && existing.kind) || 'artifact');
}

// ONE canonical shape for the mutable fields, used by birth AND revision. When
// the two paths normalized differently (falsey defaults on one side, String()
// coercion on the other) the same payload meant different things depending on
// which door it came through — so an identical retry could count as a change and
// bump rev, silently invalidating the proof bound to the previous revision.
// `fallback` supplies what a partial update leaves alone; at birth it is absent.
function canonicalFields(kind, item, fallback) {
  const base = fallback || {};
  const pick = (key, dflt) => {
    if (item[key] != null) return String(item[key]);
    if (base[key] != null) return String(base[key]);
    return dflt;
  };
  const holesSource = item.holes !== undefined ? item.holes : base.holes;
  const out = {
    title: pick('title', 'untitled') || 'untitled',
    path: pick('path', ''),
    status: pick('status', 'v0') || 'v0',
    holes: withProbeHole(kind, normalizeHoles(holesSource)),
  };
  // `revises` is always present in the canonical shape, possibly '' — absent and
  // explicitly-empty are different intents: omitting it leaves the lineage
  // alone, clearing it retracts a lineage claim. Collapsing them meant a clear
  // was silently dropped and the old link survived.
  out.revises = item.revises !== undefined ? String(item.revises) : base.revises != null ? String(base.revises) : '';
  return out;
}

// Only an ABSENT holes value is equivalent to []. Anything PRESENT that is not
// already a flat array of strings is a real hole in the wrong shape:
// canonicalizing it made the repair compare equal to what was stored, so the
// no-op path kept the bad shape — and every `Array.isArray`/string guard
// downstream then misread it (a scalar as zero holes, a nested `[["TODO"]]` as
// an unusable hole). Repairing the shape is a genuine revision.
function hasLegacyHolesShape(record) {
  if (!Object.prototype.hasOwnProperty.call(record, 'holes')) return false;
  const h = record.holes;
  return !Array.isArray(h) || !h.every((x) => typeof x === 'string');
}

function assertArtifactInput(item) {
  const status = item.status == null ? '' : String(item.status).toLowerCase();
  if (status && schemas.ARTIFACT_TERMINAL_STATUSES.includes(status)) {
    throw new Error(
      `an artifact cannot be born or revised into "${item.status}" — terminal statuses are earned by a gated verb ` +
        '(ratchet artifact close, ratchet retract), never asserted in a payload'
    );
  }
  for (const f of schemas.ARTIFACT_RESERVED_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(item, f)) {
      throw new Error(
        `"${f}" is written by the CLI, not supplied — it is the record of a gated transition, not an input field`
      );
    }
  }
}

// One id must name one record before any bind, close, revise, or retract. A
// duplicated id makes every one of those verbs ambiguous, and guessing which
// record the caller meant is exactly how a closure lands on the wrong thing.
function findUniqueArtifact(s, id, verb) {
  const matches = (s.artifacts || []).filter((a) => a && a.id === id);
  if (matches.length > 1) {
    throw new Error(
      `${matches.length} artifacts share the id "${id}" — refusing to ${verb} an ambiguous record. ` +
        'Repair the store first: give the duplicates distinct ids in state.json, then re-run.'
    );
  }
  return matches[0] || null;
}

// The map landing is the fog entering durable state: close the fog loop that
// `score aperture` opened, so the drain tracks reality instead of nagging past
// the point the map answered it. (The map's own OPEN items keep draining as
// this artifact's holes.) The close now names its authority and its evidence,
// like every other closure in 0.8.
function closeFogLoops(s, record, now) {
  for (const l of s.openLoops || []) {
    if (l.status !== 'closed' && String(l.text || '').startsWith(schemas.FOG_LOOP_PREFIX)) {
      l.status = 'closed';
      l.closedAt = now;
      l.closedBy = record.id;
      l.evidence = `unknown-map "${record.title}" landed — the fog is now on the record as that map's OPEN items`;
    }
  }
}

function reviseArtifact(cwd, s, existing, item, now) {
  if (lifecycle.isClosed(existing)) {
    throw new Error(
      `artifact "${existing.id}" is closed — closure is a historical fact and cannot be edited away. ` +
        'Record a new artifact with "revises": "<id>", or retract this one (ratchet retract <id> --reason "<why>").'
    );
  }
  if (item.kind != null && String(item.kind) !== String(existing.kind)) {
    throw new Error(
      `"kind" is immutable: artifact "${existing.id}" is a ${existing.kind} and cannot become a ${item.kind}. ` +
        'A different kind is a different thing — record a new artifact with "revises".'
    );
  }

  const next = { ...existing, ...canonicalFields(next_kind(existing), item, existing) };

  // An identical retry is not a revision. Bumping rev would invalidate the proof
  // bound to the current one, so re-running the same command must cost nothing:
  // no rev, no timestamp churn, no history line, no write at all. The comparison
  // runs against the EXISTING record put through the same normalization, so a
  // legacy record acquiring its missing `holes: []` is not read as a change.
  const canonicalExisting = canonicalFields(next_kind(existing), existing, existing);
  const changed =
    hasLegacyHolesShape(existing) ||
    ARTIFACT_MUTABLE.some((k) => JSON.stringify(next[k]) !== JSON.stringify(canonicalExisting[k]));
  if (!changed) return existing;
  // '' is the canonical "no lineage" and must not persist as an empty string.
  if (!next.revises) delete next.revises;

  next.rev = (Number.isInteger(existing.rev) ? existing.rev : 1) + 1;
  next.updatedAt = now;
  s.artifacts[s.artifacts.indexOf(existing)] = next;
  s.dirty = true;
  s.history.push({ id: state.makeId('hist'), at: now, event: 'artifact.revised', note: `${next.id} → rev ${next.rev}` });
  if (next.kind === 'unknown-map') closeFogLoops(s, next, now);
  state.saveState(cwd, s);
  return next;
}

function addArtifact(cwd, item) {
  assertArtifactInput(item);
  const s = state.loadState(cwd);
  const now = schemas.nowIso();
  const id = item.id ? String(item.id) : '';
  if (id) {
    const existing = findUniqueArtifact(s, id, 'revise');
    if (existing) return reviseArtifact(cwd, s, existing, item, now);
  }
  const kind = item.kind ? String(item.kind) : 'artifact';
  // Same normalization as a revision — `revises` included, which is provenance
  // only: naming what this supersedes does not retire it. A lineage claim is not
  // a lifecycle event; only `retract` and `close` are.
  const record = { id: id || state.makeId('art'), at: now, rev: 1, kind, ...canonicalFields(kind, item, null) };
  if (!record.revises) delete record.revises;
  s.artifacts.push(record);
  s.dirty = true;
  s.history.push({ id: state.makeId('hist'), at: record.at, event: 'artifact.add', note: record.title });
  if (record.kind === 'unknown-map') closeFogLoops(s, record, now);
  state.saveState(cwd, s);
  return record;
}

// Which live artifact does this defect attack? Guessing wrong is worse than
// refusing: an auto-attach to the wrong artifact blocks its closure and lets the
// real one close with the defect still open.
function resolveAttachment(cwd, s, item) {
  const explicit = String(item.artifact || '').trim();
  if (explicit) {
    if (!findUniqueArtifact(s, explicit, 'attach a defect to')) {
      throw new Error(`no artifact with id "${explicit}" to attach this defect to`);
    }
    return { artifact: explicit, attachedBy: 'explicit' };
  }
  const live = lifecycle.liveArtifacts(s);
  if (live.length === 1) return { artifact: live[0].id, attachedBy: 'auto' };
  if (live.length === 0) return { artifact: '', attachedBy: 'none' };
  throw new Error(
    `${live.length} live artifacts (${live.map((a) => `${a.id} "${a.title}"`).join(', ')}) — name the one this ` +
      'defect attacks with "artifact": "<id>". An unattached defect drains every artifact and blocks closure for all of them.'
  );
}

function addDefect(cwd, item, { alsoLedger = true } = {}) {
  const s = state.loadState(cwd);
  const now = schemas.nowIso();
  const sev = (item.severity || 'medium').toLowerCase();
  const severity = schemas.SEVERITIES.includes(sev) ? sev : 'medium';
  const summary = String(item.summary || item.title || 'unspecified defect');
  const status = String(item.status || 'open').toLowerCase();
  if (schemas.DEFECT_TERMINAL_STATUSES.includes(status)) {
    throw new Error(
      `a defect cannot be born "${item.status}" — a terminal status is a transition ` +
        '(ratchet defect resolve | waive | supersede), not a birth field'
    );
  }

  const { artifact, attachedBy } = resolveAttachment(cwd, s, item);

  // The same finding reported twice is one defect, not two drains. Match on the
  // pair that identifies it — which artifact, and what it says — while it is
  // still live. A repeat that is worse escalates the record in place.
  const key = summary.trim().toLowerCase();
  const dup = (s.defects || []).find(
    (d) => d && scoring.isDefectOpen(d) && String(d.artifact || '') === artifact && String(d.summary || '').trim().toLowerCase() === key
  );
  if (dup) {
    const from = dup.severity;
    if (schemas.SEVERITIES.indexOf(severity) < schemas.SEVERITIES.indexOf(from)) {
      dup.severity = severity;
      dup.log = Array.isArray(dup.log) ? dup.log : [];
      dup.log.push({ at: now, from, to: severity, note: 'severity escalated by a repeat report' });
      s.dirty = true;
      s.history.push({ id: state.makeId('hist'), at: now, event: 'defect.escalated', note: `${dup.id}: ${from} → ${severity}` });
      state.saveState(cwd, s);
      if (dup.ledgerId) {
        try {
          require('./ledger').upsert(cwd, 'defects', { id: dup.ledgerId, severity }, { via: 'transition' });
        } catch (_e) {
          /* ledger sync is best-effort */
        }
      }
    }
    return { state: dup, ledger: null, deduped: true };
  }

  const record = {
    id: item.id || state.makeId('def'),
    at: now,
    severity,
    summary,
    status: item.status || 'open',
    artifact,
    attachedBy,
    // Which revision of the artifact this defect was found against. A defect
    // raised on rev 2 is not evidence about rev 5.
    artifactRev: null,
    artifactHash: '',
  };
  if (artifact) {
    try {
      const fp = lifecycle.fingerprint(cwd, (s.artifacts || []).find((a) => a.id === artifact));
      record.artifactRev = fp.rev;
      record.artifactHash = fp.hash;
    } catch (e) {
      // The stamp is what makes an attachment mean something. Without it the
      // defect would sit attached with no evidence of WHICH revision it attacks,
      // blocking that artifact's closure on an association nobody can check.
      // Recording the finding still matters more than the stamp, so keep the
      // defect and detach it loudly rather than half-attaching it in silence.
      record.artifact = '';
      record.attachedBy = 'error';
      record.attachError = e && e.message ? e.message : String(e);
    }
  }
  s.defects.push(record);
  s.dirty = true;
  s.history.push({ id: state.makeId('hist'), at: now, event: 'defect.add', note: `[${record.severity}] ${record.summary}` });
  state.saveState(cwd, s);

  let ledgerRecord = null;
  if (alsoLedger) {
    const ledger = require('./ledger');
    ledgerRecord = ledger.upsert(cwd, 'defects', {
      feature: item.feature || '',
      severity: record.severity,
      summary: record.summary,
      status: record.status,
      foundAt: now,
    }, { via: 'transition' }).item;
    // Link the state defect to its ledger mirror so lifecycle transitions can
    // keep both surfaces honest instead of letting the ledger silently drift.
    record.ledgerId = ledgerRecord.id;
    state.saveState(cwd, s);
  }
  return { state: record, ledger: ledgerRecord };
}

// Move a defect through its lifecycle: open/patched/reopened → resolved | waived
// | superseded, or resolved → reopened. This is the mutation the CLI lacked in
// 0.2: a defect could be born but never cleared, so remediated work stayed
// confidence-blocking forever. The scorer already honors terminal statuses
// (scoring.isDefectOpen); this is what finally lets a defect *reach* one.
function transitionDefect(cwd, id, toStatus, meta = {}) {
  if (toStatus === 'closed') {
    throw new Error(
      '"closed" is a read-only legacy alias (pre-0.3) and cannot be transitioned into — it is terminal with no ' +
        'proof attached. Use resolve (--evidence), waive (--owner + --reason), or supersede (--by).'
    );
  }
  if (!schemas.DEFECT_WRITABLE_STATUSES.includes(toStatus)) {
    throw new Error(`unknown defect status "${toStatus}". valid: ${schemas.DEFECT_WRITABLE_STATUSES.join(', ')}`);
  }
  // The proof each clearing verb owes, enforced HERE rather than only in the
  // CLI: cmdDefect is one caller, and a gate that lives in one caller is a
  // convention. The CLI keeps its own (friendlier) messages in front of these.
  const meta_ = meta || {};
  const need = (val, msg) => {
    if (!String(val || '').trim()) throw new Error(msg);
  };
  if (toStatus === 'resolved') need(meta_.evidence, `cannot resolve defect "${id}": no proof supplied — no proof, no resolve`);
  if (toStatus === 'reopened') need(meta_.reason, `cannot reopen defect "${id}": a reason is required (why it is not actually fixed)`);
  if (toStatus === 'waived') {
    need(meta_.owner, `cannot waive defect "${id}": an owner is required (who accepts the risk)`);
    need(meta_.reason, `cannot waive defect "${id}": a reason is required (why shipping anyway is acceptable)`);
  }
  if (toStatus === 'superseded') need(meta_.by, `cannot supersede defect "${id}": --by must name what replaced it`);

  const s = state.loadState(cwd);
  const d = (s.defects || []).find((x) => x.id === id);
  if (!d) throw new Error(`no defect with id "${id}"`);
  const now = schemas.nowIso();
  const from = d.status || 'open';

  d.status = toStatus;
  d.log = Array.isArray(d.log) ? d.log : [];
  d.log.push({ at: now, from, to: toStatus, note: meta.note || '' });

  // Stamp the fields each transition owns; clear stale ones on reopen.
  if (toStatus === 'resolved') {
    d.resolvedAt = now;
    if (meta.evidence) d.evidence = meta.evidence;
  }
  if (toStatus === 'reopened') {
    d.resolvedAt = null;
    d.reopenReason = meta.reason || '';
  }
  if (toStatus === 'waived') {
    d.waivedBy = meta.owner || '';
    d.waiveReason = meta.reason || '';
  }
  if (toStatus === 'superseded') {
    d.supersededBy = meta.by || '';
  }

  s.dirty = true;
  s.history.push({ id: state.makeId('hist'), at: now, event: `defect.${toStatus}`, note: `${id}: ${from} → ${toStatus}` });
  state.saveState(cwd, s);

  // Keep the QA ledger mirror in step. Best-effort: a defect added before the
  // link existed has no mirror to sync, and a ledger hiccup must never strand a
  // state transition that already succeeded.
  if (d.ledgerId) {
    try {
      require('./ledger').upsert(cwd, 'defects', { id: d.ledgerId, status: toStatus }, { via: 'transition' });
    } catch (_e) {
      /* ledger sync is best-effort */
    }
  }
  return d;
}

// Retract an artifact whose claim turned out false or obsolete. Provenance is
// preserved (keptForProvenance) — the record stays in history, but its status
// flips to `retracted` so it stops steering cold sessions and its holes stop
// draining confidence. This is the move the T2.3 re-scope doc needed when its
// central premise ("no endpoint exists") was disproven by the live seam.
function retractArtifact(cwd, id, { reason = '', supersededBy = '' } = {}) {
  const s = state.loadState(cwd);
  const a = findUniqueArtifact(s, id, 'retract');
  if (!a) throw new Error(`no artifact with id "${id}"`);
  // A probe retraction is its lifecycle exit and must state which one: the
  // code died (disposed) or was explicitly rebuilt for keep (promoted). A
  // vague reason would let residue stop draining without either outcome.
  if (a.kind === 'probe') {
    if (!/^(disposed|promoted):/i.test(reason)) {
      throw new Error(
        'a probe retraction must state its outcome: --reason must start with "disposed:" (code reverted, finding recorded) or "promoted:" (rebuilt for keep)'
      );
    }
    if (/^promoted:/i.test(reason)) {
      if (!supersededBy) {
        throw new Error('a promoted probe requires --superseded-by <artifact-id> — the build-for-keep that replaced it');
      }
      // "Promoted" is a claim that real work replaced the probe. An id nobody
      // recorded, or another probe, is the residue-keeps-shipping path wearing
      // a promotion label.
      const replacement = findUniqueArtifact(s, supersededBy, 'promote a probe into');
      if (!replacement) {
        throw new Error(
          `--superseded-by "${supersededBy}" names no artifact in this state — a promotion must point at the ` +
            'recorded build-for-keep that replaced the probe'
        );
      }
      if (String(replacement.kind) === 'probe') {
        throw new Error(
          `--superseded-by "${supersededBy}" is itself a probe — a promotion must point at a build-for-keep, not another probe`
        );
      }
    }
  }
  const now = schemas.nowIso();
  a.status = 'retracted';
  a.retracted = { at: now, reason, supersededBy, keptForProvenance: true };
  s.dirty = true;
  s.history.push({
    id: state.makeId('hist'),
    at: now,
    event: 'artifact.retracted',
    note: `${id}: ${reason}${supersededBy ? ` → superseded by ${supersededBy}` : ''}`,
  });
  state.saveState(cwd, s);
  return a;
}

module.exports = { addArtifact, addDefect, transitionDefect, retractArtifact };
