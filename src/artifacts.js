'use strict';

const state = require('./state');
const schemas = require('./schemas');
const scoring = require('./scoring');
const lifecycle = require('./lifecycle');
const journal = require('./evolve/journal');
const wal = require('./wal');

// A domain refusal both boundaries must tell apart from damage carries a code:
// the CLI prints the message, the MCP funnel maps the code to its one
// allowlisted sentence and the raw text never crosses the wire.
function coded(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

// Thin helpers for the two collections skills touch most: artifacts + defects.
// Every write flips state.dirty so the Stop hook can nag if nothing was
// compiled afterward.

// The fields a revision may change. Everything else about an artifact is either
// its identity (id, kind) or the record of a gated transition.
const ARTIFACT_MUTABLE = ['title', 'path', 'status', 'holes', 'revises'];

// Presence, not truthiness — the shared rule lives in schemas so the writer and
// the closure gate cannot drift into two answers about the same record.
const normalizeHoles = schemas.normalizeHoles;

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
  // Whichever object actually CARRIES the key owns the answer — a partial update
  // that never mentions holes must inherit the stored ones, including a falsey
  // one, rather than canonicalizing them away.
  const holesOwner = Object.prototype.hasOwnProperty.call(item, 'holes') ? item : base;
  const out = {
    title: pick('title', 'untitled') || 'untitled',
    path: pick('path', ''),
    status: pick('status', 'v0') || 'v0',
    holes: withProbeHole(kind, normalizeHoles(holesOwner)),
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

function reviseArtifact(s, existing, item, now, mintId) {
  if (lifecycle.isClosed(existing)) {
    throw coded(
      'ERATCHETARTIFACTCLOSED',
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
  if (!changed) return { record: existing, action: 'unchanged' };
  // '' is the canonical "no lineage" and must not persist as an empty string.
  if (!next.revises) delete next.revises;

  next.rev = (Number.isInteger(existing.rev) ? existing.rev : 1) + 1;
  next.updatedAt = now;
  s.artifacts[s.artifacts.indexOf(existing)] = next;
  s.dirty = true;
  s.history.push({ id: mintId('hist', 'history'), at: now, event: 'artifact.revised', note: `${next.id} → rev ${next.rev}` });
  if (next.kind === 'unknown-map') closeFogLoops(s, next, now);
  return { record: next, action: 'revised' };
}

// The transaction-shaped core, shared with the MCP write tool: mutates the open
// transaction's state, never loads or saves, mints ids through the caller.
function applyAdd(s, item, mintId) {
  assertArtifactInput(item);
  const now = schemas.nowIso();
  const id = item.id ? String(item.id) : '';
  if (id) {
    const existing = findUniqueArtifact(s, id, 'revise');
    if (existing) return reviseArtifact(s, existing, item, now, mintId);
  }
  const kind = item.kind ? String(item.kind) : 'artifact';
  // Same normalization as a revision — `revises` included, which is provenance
  // only: naming what this supersedes does not retire it. A lineage claim is not
  // a lifecycle event; only `retract` and `close` are.
  const record = { id: id || mintId('art', 'record'), at: now, rev: 1, kind, ...canonicalFields(kind, item, null) };
  if (!record.revises) delete record.revises;
  s.artifacts.push(record);
  s.dirty = true;
  s.history.push({ id: mintId('hist', 'history'), at: record.at, event: 'artifact.add', note: record.title });
  if (record.kind === 'unknown-map') closeFogLoops(s, record, now);
  return { record, action: 'created' };
}

function addArtifact(cwd, item) {
  const s = state.loadState(cwd);
  const res = applyAdd(s, item, (prefix) => state.makeId(prefix));
  // An unchanged revision writes nothing — the no-rev-churn rule above.
  if (res.action !== 'unchanged') state.saveState(cwd, s);
  return res.record;
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
  throw coded(
    'ERATCHETATTACH',
    `${live.length} live artifacts (${live.map((a) => `${a.id} "${a.title}"`).join(', ')}) — name the one this ` +
      'defect attacks with "artifact": "<id>". An unattached defect drains every artifact and blocks closure for all of them.'
  );
}

// Ledger mirror ids are collision-checked against the ledger they will enter —
// the derived-id rule extends over the mirror collections (4b spec).
function mintLedgerId(ledger, mintId) {
  const id = mintId(schemas.LEDGER_COLLECTIONS.defects, 'ledger');
  if ((ledger.defects || []).some((x) => x && x.id === id)) {
    throw coded('ERATCHETIDCONFLICT', `derived ledger id ${id} already names a record`);
  }
  return id;
}

// The mirror op for a defect that already lives in state. Exactly one linked
// mirror → replace it in place. Anything else — no link, a link to nothing, a
// duplicated id — is the D2b admission: mint a complete mirror from the
// post-transition defect, back-link it in the SAME state post-image, and leave
// every old row untouched; admission never guesses which row to overwrite.
function mirrorOpFor(ledger, defect, now, mintId) {
  const linked = String(defect.ledgerId || '');
  const matches = linked ? (ledger.defects || []).filter((x) => x && x.id === linked) : [];
  if (matches.length === 1) {
    // The mirror follows the record on both axes the transitions own; carrying
    // an unchanged value is a no-op inside the same replace.
    const after = { ...matches[0], severity: defect.severity, status: defect.status || 'open', updatedAt: now };
    return { collection: 'defects', id: linked, mode: 'replace', after };
  }
  const mirror = {
    id: mintLedgerId(ledger, mintId),
    at: now,
    feature: '',
    severity: defect.severity,
    summary: defect.summary,
    status: defect.status || 'open',
    foundAt: defect.at || now,
  };
  defect.ledgerId = mirror.id;
  return { collection: 'defects', id: mirror.id, mode: 'insert', after: mirror };
}

// The 4b defect.add core, shared by the CLI and MCP doors: mutates the open
// transaction's state and returns MATERIALIZED mirror ops — ids, timestamps
// and post-images final before any intent publishes. `ledger` is null only on
// the alsoLedger:false path, which writes one file and owes no mirror.
function prepareDefectAdd(cwd, s, ledger, item, mintId) {
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
  // still live. A repeat that is worse escalates the record in place; a repeat
  // that is not is a no-op decided BEFORE any intent exists.
  const key = summary.trim().toLowerCase();
  const dup = (s.defects || []).find(
    (d) => d && scoring.isDefectOpen(d) && String(d.artifact || '') === artifact && String(d.summary || '').trim().toLowerCase() === key
  );
  if (dup) {
    const from = dup.severity;
    if (schemas.SEVERITIES.indexOf(severity) >= schemas.SEVERITIES.indexOf(from)) {
      return { kind: 'noop', action: 'deduped', record: dup, result: { state: dup, ledger: null, deduped: true } };
    }
    dup.severity = severity;
    dup.log = Array.isArray(dup.log) ? dup.log : [];
    dup.log.push({ at: now, from, to: severity, note: 'severity escalated by a repeat report' });
    s.dirty = true;
    s.history.push({ id: mintId('hist', 'history'), at: now, event: 'defect.escalated', note: `${dup.id}: ${from} → ${severity}` });
    const ledgerOps = ledger ? [mirrorOpFor(ledger, dup, now, mintId)] : [];
    return { kind: 'commit', action: 'escalated', record: dup, ledgerOps, result: { state: dup, ledger: null, deduped: true } };
  }

  const record = {
    id: item.id || mintId('def', 'record'),
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
  let mirror = null;
  const ledgerOps = [];
  if (ledger) {
    mirror = {
      id: mintLedgerId(ledger, mintId),
      at: now,
      feature: item.feature || '',
      severity: record.severity,
      summary: record.summary,
      status: record.status,
      foundAt: now,
    };
    // The back-link rides the SAME post-image as the defect — the old second
    // state save (and its crash window) is what 4b exists to remove.
    record.ledgerId = mirror.id;
    ledgerOps.push({ collection: 'defects', id: mirror.id, mode: 'insert', after: mirror });
  }
  s.defects.push(record);
  s.dirty = true;
  s.history.push({ id: mintId('hist', 'history'), at: now, event: 'defect.add', note: `[${record.severity}] ${record.summary}` });
  return { kind: 'commit', action: 'created', record, ledgerOps, result: { state: record, ledger: mirror } };
}

function addDefect(cwd, item, { alsoLedger = true } = {}) {
  if (!alsoLedger) {
    // One canonical file — the ordinary boundary; no mirror, no intent.
    return state.withWorkspaceMutation(cwd, { action: 'defect add' }, (s) =>
      prepareDefectAdd(cwd, s, null, item, (prefix) => state.makeId(prefix)).result
    ).result;
  }
  // The CLI door of the 4b protocol. The operation id is an internal WAL id
  // and the args hash a diagnostic — a repeated CLI command is made safe by
  // recovery plus the dedup no-op, never by pretending it has the old id.
  return state.withMirroredMutation(cwd, {
    action: 'defect add',
    door: 'cli',
    tool: 'defect add',
    operationId: state.makeId('wal'),
    argsHash: wal.hashBytes(Buffer.from(JSON.stringify(item === undefined ? null : item), 'utf8')),
  }, (s, ledger) => {
    const prep = prepareDefectAdd(cwd, s, ledger, item, (prefix) => state.makeId(prefix));
    if (prep.kind === 'noop') return { kind: 'noop', result: prep.result };
    return { kind: 'commit', ledgerOps: prep.ledgerOps, result: prep.result };
  }).result;
}

// Move a defect through its lifecycle: open/patched/reopened → resolved | waived
// | superseded, or resolved → reopened. This is the mutation the CLI lacked in
// 0.2: a defect could be born but never cleared, so remediated work stayed
// confidence-blocking forever. The scorer already honors terminal statuses
// (scoring.isDefectOpen); this is what finally lets a defect *reach* one.
// The proof fields each terminal status records — the identity of a
// transition for the exact-repeat rule: same target, same proof → no-op;
// same target, different proof → refuse, never silently replace.
function transitionProof(d, toStatus, meta) {
  if (toStatus === 'resolved') return [String(d.evidence || ''), String(meta.evidence || '')];
  if (toStatus === 'reopened') return [String(d.reopenReason || ''), String(meta.reason || '')];
  if (toStatus === 'waived') {
    return [`${d.waivedBy || ''}\n${d.waiveReason || ''}`, `${meta.owner || ''}\n${meta.reason || ''}`];
  }
  return [String(d.supersededBy || ''), String(meta.by || '')];
}

// The 4b transition core, shared by the CLI (resolve/reopen/waive/supersede)
// and the MCP door (waive stays CLI-only by rule). Mutates the transaction's
// state and returns the materialized mirror op; the exact-repeat no-op is
// decided HERE, before any intent exists.
function prepareDefectTransition(s, ledger, id, toStatus, meta, mintId) {
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

  const d = (s.defects || []).find((x) => x.id === id);
  if (!d) throw coded('ERATCHETUNKNOWNID', `no defect with id "${id}"`);
  const now = schemas.nowIso();
  const from = d.status || 'open';

  if (from === toStatus) {
    const [recorded, offered] = transitionProof(d, toStatus, meta_);
    const linked = String(d.ledgerId || '');
    const mirrorValid = ledger
      ? linked && (ledger.defects || []).filter((x) => x && x.id === linked).length === 1
      : true;
    if (recorded === offered && mirrorValid) {
      // The exact repeat, mirror already truthful: no log line, no history, no
      // revision, no intent. Extends the 0.9 no-op property (named CHANGELOG
      // behavior change — repeats used to grow the log).
      return { kind: 'noop', record: d };
    }
    if (recorded !== offered) {
      throw new Error(
        `defect "${id}" is already ${toStatus} with different recorded proof — a repeat does not silently ` +
          'replace the original. Reopen it first if the recorded proof is wrong.'
      );
    }
    // Exact repeat but the mirror is missing or ambiguous: commit once solely
    // to perform the D2b admission below.
  }

  d.status = toStatus;
  d.log = Array.isArray(d.log) ? d.log : [];
  d.log.push({ at: now, from, to: toStatus, note: meta_.note || '' });

  // Stamp the fields each transition owns; clear stale ones on reopen.
  if (toStatus === 'resolved') {
    d.resolvedAt = now;
    if (meta_.evidence) d.evidence = meta_.evidence;
  }
  if (toStatus === 'reopened') {
    d.resolvedAt = null;
    d.reopenReason = meta_.reason || '';
  }
  if (toStatus === 'waived') {
    d.waivedBy = meta_.owner || '';
    d.waiveReason = meta_.reason || '';
  }
  if (toStatus === 'superseded') {
    d.supersededBy = meta_.by || '';
  }

  s.dirty = true;
  s.history.push({ id: mintId('hist', 'history'), at: now, event: `defect.${toStatus}`, note: `${id}: ${from} → ${toStatus}` });
  const ledgerOps = ledger ? [mirrorOpFor(ledger, d, now, mintId)] : [];
  return { kind: 'commit', record: d, ledgerOps };
}

// Move a defect through its lifecycle. Since 4b.2 the mirror is not
// best-effort: the state transition and its ledger mirror commit behind one
// write-ahead intent, a mirror failure surfaces instead of being swallowed,
// and a defect with no valid mirror is admitted on this first committed
// mutation (D2b).
function transitionDefect(cwd, id, toStatus, meta = {}) {
  return state.withMirroredMutation(cwd, {
    action: `defect ${toStatus === 'reopened' ? 'reopen' : toStatus === 'resolved' ? 'resolve' : toStatus === 'waived' ? 'waive' : 'supersede'}`,
    door: 'cli',
    tool: `defect ${toStatus === 'reopened' ? 'reopen' : toStatus === 'resolved' ? 'resolve' : toStatus === 'waived' ? 'waive' : 'supersede'}`,
    operationId: state.makeId('wal'),
    argsHash: wal.hashBytes(Buffer.from(JSON.stringify([id, toStatus, meta || null]), 'utf8')),
  }, (s, ledger) => {
    const prep = prepareDefectTransition(s, ledger, id, toStatus, meta, (prefix) => state.makeId(prefix));
    if (prep.kind === 'noop') return { kind: 'noop', result: prep.record };
    return { kind: 'commit', ledgerOps: prep.ledgerOps, result: prep.record };
  }).result;
}

// Retract an artifact whose claim turned out false or obsolete. Provenance is
// preserved (keptForProvenance) — the record stays in history, but its status
// flips to `retracted` so it stops steering cold sessions and its holes stop
// draining confidence. This is the move the T2.3 re-scope doc needed when its
// central premise ("no endpoint exists") was disproven by the live seam.
function applyRetract(s, id, { reason = '', supersededBy = '' } = {}, mintId) {
  const a = findUniqueArtifact(s, id, 'retract');
  if (!a) throw coded('ERATCHETUNKNOWNID', `no artifact with id "${id}"`);
  // A probe retraction is its lifecycle exit and must state which one: the
  // code died (disposed) or was explicitly rebuilt for keep (promoted). A
  // vague reason would let residue stop draining without either outcome.
  if (a.kind === 'probe') {
    if (!/^(disposed|promoted):/i.test(reason)) {
      throw coded(
        'ERATCHETRETRACT',
        'a probe retraction must state its outcome: --reason must start with "disposed:" (code reverted, finding recorded) or "promoted:" (rebuilt for keep)'
      );
    }
    if (/^promoted:/i.test(reason)) {
      if (!supersededBy) {
        throw coded('ERATCHETRETRACT', 'a promoted probe requires --superseded-by <artifact-id> — the build-for-keep that replaced it');
      }
      // "Promoted" is a claim that real work replaced the probe. An id nobody
      // recorded, or another probe, is the residue-keeps-shipping path wearing
      // a promotion label.
      const replacement = findUniqueArtifact(s, supersededBy, 'promote a probe into');
      if (!replacement) {
        throw coded(
          'ERATCHETRETRACT',
          `--superseded-by "${supersededBy}" names no artifact in this state — a promotion must point at the ` +
            'recorded build-for-keep that replaced the probe'
        );
      }
      if (String(replacement.kind) === 'probe') {
        throw coded(
          'ERATCHETRETRACT',
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
    id: mintId('hist', 'history'),
    at: now,
    event: 'artifact.retracted',
    note: `${id}: ${reason}${supersededBy ? ` → superseded by ${supersededBy}` : ''}`,
  });
  return a;
}

function retractArtifact(cwd, id, opts) {
  const s = state.loadState(cwd);
  const a = applyRetract(s, id, opts, (prefix) => state.makeId(prefix));
  state.saveState(cwd, s);
  return a;
}

// The closure gate's mutation, moved here from the CLI router so the MCP tool
// runs the SAME gate. The caller owns the transaction AND the journal lock
// (lock order: workspace → file) — the blocker check and the certificate it
// authorizes must share one window, or a REVERT landing between them closes an
// artifact on revoked proof. Over MCP there are no waiver arguments: opts stays
// empty, so record-scope proof and open holes refuse here by design.
function applyClose(cwd, s, id, opts, mintId) {
  const owner = String(opts.owner || '').trim();
  const reason = String(opts.reason || '').trim();
  const waiveHoles = opts.waiveHoles === true;

  const matches = (s.artifacts || []).filter((a) => a && a.id === id);
  if (matches.length > 1) {
    throw new Error(
      `${matches.length} artifacts share the id "${id}" — refusing to close an ambiguous record. ` +
        'Repair the store first: give the duplicates distinct ids in state.json, then re-run.'
    );
  }
  const artifact = matches[0];
  if (!artifact) throw coded('ERATCHETUNKNOWNID', `no artifact with id "${id}"`);

  // Idempotent: a second close of an already-certified artifact is a no-op, not
  // an error. Re-running a serialize block must never be punished.
  if (lifecycle.isClosed(artifact)) return { artifact, fp: null, bound: null, already: true };

  // FAIL CLOSED on a damaged proof record. A malformed line is a dropped event,
  // and a dropped REVERT reads exactly like no REVERT — so a mangled log used to
  // make this gate CERTIFY where it should refuse. Absence of evidence is not
  // evidence of absence when the record itself is known to be short.
  let read = { events: [], malformed: 0, file: journal.logPath(cwd) };
  try {
    read = journal.readEventsWithHealth(cwd);
  } catch (_e) {
    /* unreadable log → no events → the blockers below refuse for want of proof */
  }
  if (read.malformed) {
    throw coded(
      'ERATCHETCLOSUREBLOCKED',
      `cannot close artifact "${id}": proof record damaged — ${read.malformed} unreadable line(s) in ${read.file}. ` +
        'A dropped event is indistinguishable from no event, so this closure cannot be certified. ' +
        'Repair or archive the log, then re-run.'
    );
  }
  const events = read.events;
  const blockers = lifecycle.closureBlockers(s, events, artifact, cwd, { waiveHoles, owner, reason });
  if (blockers.length) {
    throw coded(
      'ERATCHETCLOSUREBLOCKED',
      `cannot close artifact "${id}" — ${blockers.length} blocker(s):\n` + blockers.map((b) => `  - [${b.code}] ${b.message}`).join('\n')
    );
  }

  const fp = lifecycle.fingerprint(cwd, artifact);
  // A record-scope close certifies a claim about a RECORD, not about bytes on
  // disk — a much weaker proof. It is allowed, but only with a named owner who
  // says so out loud, exactly like a seam waiver.
  if (fp.hashScope === 'record') {
    if (!owner || !reason) {
      throw coded(
        'ERATCHETHUMANAUTHORITY',
        `cannot close artifact "${id}": its proof is record-scope, not file-scope` +
          (fp.downgradeReason ? ` (${fp.downgradeReason})` : ' (the artifact points at no file)') +
          ' — that certifies a claim about the record, not about shipped bytes. ' +
          'Authorize it by name: --owner "<who accepts it>" --reason "<why record-scope proof is enough here>".'
      );
    }
  }

  const bound = lifecycle.bindingEvent(artifact, events, fp);
  const now = schemas.nowIso();
  artifact.status = 'closed';
  artifact.closedAt = now;
  artifact.closedBy = bound.id || '';
  artifact.closedRev = fp.rev;
  artifact.closedHash = fp.hash;
  if (waiveHoles && (artifact.holes || []).length) artifact.holesWaiver = { by: owner, reason };
  s.dirty = true;
  s.history.push({
    id: mintId('hist', 'history'),
    at: now,
    event: 'artifact.closed',
    note: `${id} closed at rev ${fp.rev} on ${bound.id || 'bound proof'}${owner ? ` (owner: ${owner})` : ''}`,
  });
  return { artifact, fp, bound, already: false };
}

module.exports = {
  addArtifact,
  addDefect,
  prepareDefectAdd,
  prepareDefectTransition,
  transitionDefect,
  retractArtifact,
  assertArtifactInput,
  applyAdd,
  applyRetract,
  applyClose,
};
