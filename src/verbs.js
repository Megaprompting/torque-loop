'use strict';

// Domain verbs shared by the CLI and the MCP write tools. One implementation,
// two boundaries: the CLI router and the MCP server both dispatch INTO these,
// so the two surfaces cannot drift into two meanings for one verb. Extracted
// verb-by-verb as MCP step 4 ships each tool (spec: 2026-07-31 write tools);
// verbs the MCP surface does not expose stay inline in cli.js.
//
// A verb takes the OPEN transaction's state object and mutates it. It never
// loads, saves, locks, or checks revisions — that is the boundary's job. The
// id minter is a parameter because the two boundaries mint differently: the
// CLI has no retry, so ids are random (state.makeId); an MCP write can be
// retried across a crash, so ids derive from the operation and re-application
// converges on the same record instead of duplicating it.
//
// Traced by: claude-fable-5

const schemas = require('./schemas');

function coerceScalar(key, value) {
  if (key === 'dirty') return value === 'true' || value === true;
  if (key === 'confidence') return value === '' ? null : Number(value);
  return value;
}

// `state set`: assign one settable scalar, mark the session dirty, and record
// the assignment in history. Key validation is the caller's (both boundaries
// refuse before entering the transaction); the mutation itself is the shared
// meaning.
function setScalar(s, key, value, mintId) {
  s[key] = coerceScalar(key, value);
  if (key !== 'dirty') s.dirty = true;
  s.history.push({ id: mintId('hist', 'history'), at: schemas.nowIso(), event: 'state.set', note: `${key} = ${value}` });
}

// Birth status is forced, not accepted: an assumption born "tested" and a loop
// born "closed" are exactly the two lies that make the drain lie.
const BIRTH_STATUS = Object.freeze({ assumptions: 'untested', openLoops: 'open' });

// `state append`: push one record onto an appendable collection. Collection
// validation (and the artifacts/defects refusal — their constructors are
// gated) is the caller's. Same-text loops and assumptions dedup here, under
// the caller's lock against the reloaded record, so two writers appending the
// same text produce one entry, not two. Returns { record } or { dup }.
function appendItem(s, collection, item, mintId) {
  const birth = BIRTH_STATUS[collection];
  if (birth) {
    const claimed = item.status == null ? '' : String(item.status);
    if (claimed && claimed !== birth) {
      throw new Error(
        `${collection} are born "${birth}", never "${claimed}" — reaching any other status is a transition ` +
          `(ratchet state close ${collection} <id> …), not a birth field`
      );
    }
    item.status = birth;
    const key = String(item.text || '').trim().toLowerCase();
    const dup = key && (s[collection] || []).find((x) => String((x && x.text) || '').trim().toLowerCase() === key);
    if (dup) return { dup };
  }
  const record = { id: item.id || mintId(schemas.STATE_COLLECTIONS[collection], 'record'), at: schemas.nowIso(), ...item };
  s[collection].push(record);
  s.dirty = true;
  return { record };
}

// `state close`: transition one openLoop or assumption to its terminal status.
// Parking is a close too: it stops the nagging, but it STILL DRAINS, because a
// parked question is an unanswered question with an owner, not an answered
// one. The unknown-id throw is coded so the MCP boundary can map it to a
// structured refusal; the flag-gate throws stay CLI-only — over MCP those
// gates travel as required schema fields and refuse before the transaction.
function closeRecord(s, collection, id, opts, mintId) {
  const need = (val, msg) => {
    if (!val) throw new Error(msg);
    return val;
  };
  const record = (s[collection] || []).find((x) => x && x.id === id);
  if (!record) {
    const e = new Error(`no ${collection} entry with id "${id}"`);
    e.code = 'ERATCHETUNKNOWNID';
    throw e;
  }
  const now = schemas.nowIso();
  const evidence = opts.evidence || '';
  let to;

  if (collection === 'openLoops') {
    if (opts.park === true) {
      const owner = need(opts.owner, 'parking a loop requires --owner "<who carries it>"');
      const trigger = need(
        opts.revisitTrigger,
        'parking a loop requires --revisit-trigger "<what brings it back>" — a park with no trigger is a drop'
      );
      to = 'parked';
      record.owner = owner;
      record.revisitTrigger = trigger;
    } else {
      need(evidence, 'closing a loop requires --evidence "<what actually closed it>" — no proof, no close');
      to = 'closed';
      record.evidence = evidence;
    }
  } else {
    const outcome = opts.outcome || '';
    if (outcome !== 'tested' && outcome !== 'killed') {
      throw new Error('closing an assumption requires --outcome tested|killed — an assumption ends proven or dead');
    }
    need(evidence, 'closing an assumption requires --evidence "<the result that settled it>"');
    to = outcome;
    record.evidence = evidence;
  }

  const from = record.status || '';
  record.status = to;
  record.closedAt = now;
  s.dirty = true;
  s.history.push({
    id: mintId('hist', 'history'),
    at: now,
    event: `${collection === 'openLoops' ? 'loop' : 'assumption'}.${to}`,
    note: `${id}: ${from} → ${to}${evidence ? ` — ${evidence}` : ''}`,
  });
  return to;
}

// The fog-on-record check both aperture boundaries share. An already-open fog
// loop or a live unknown-map means the fog is on the record; writing a second
// loop would double the drain for one uncertainty.
function fogAlreadyOnRecord(s) {
  const openFog = (s.openLoops || []).some(
    (l) => l.status !== 'closed' && String(l.text || '').startsWith(schemas.FOG_LOOP_PREFIX)
  );
  const liveMap = (s.artifacts || []).some(
    (a) => a.kind === 'unknown-map' && a.status !== 'retracted' && a.status !== 'superseded'
  );
  return openFog || liveMap;
}

// `score aperture`'s conditional write: serialize the fog the moment the dial
// names it. The check that DECIDES runs here, against the state the caller's
// lock reloaded — first racer wins, the loser writes nothing. Returns true
// only when a fog loop was actually written.
function recordFog(s, result, mintId) {
  if (!result.mapRequired || fogAlreadyOnRecord(s)) return false;
  const now = schemas.nowIso();
  s.openLoops.push({
    id: mintId('loop', 'record'),
    at: now,
    text: `${schemas.FOG_LOOP_PREFIX} (aperture ${result.level}, score ${result.score}/10) — run /ratchet:map; closes when the unknown-map artifact lands`,
    status: 'open',
  });
  s.dirty = true;
  s.history.push({ id: mintId('hist', 'history'), at: now, event: 'fog.recorded', note: `aperture ${result.level} raised mapRequired` });
  return true;
}

// `compile done`: atomically mark the session CHECKPOINTED. Unlike a scalar
// set this CLEARS dirty and stamps lastCompileAt in one move — a checkpoint
// says the record is current, never that the work is finished. Returns the
// stamp so both boundaries report the time that was actually recorded.
function compileDone(s, mintId) {
  const now = schemas.nowIso();
  s.lastCompileAt = now;
  s.dirty = false;
  s.history.push({ id: mintId('hist', 'history'), at: now, event: 'compile.done', note: 'state serialized' });
  return now;
}

module.exports = {
  coerceScalar,
  setScalar,
  BIRTH_STATUS,
  appendItem,
  closeRecord,
  compileDone,
  fogAlreadyOnRecord,
  recordFog,
};
