'use strict';

const fs = require('fs');
const path = require('path');

const { newEvent, validateKeepGate } = require('./schema');

// The evolution log lives in the project, not the shared plugin data dir:
// evolution events are tied to specific artifacts in this repo, so the trail
// belongs next to them. Override with RATCHET_EVOLVE_LOG.

function logPath(cwd = process.cwd()) {
  if (process.env.RATCHET_EVOLVE_LOG && process.env.RATCHET_EVOLVE_LOG.trim()) {
    return process.env.RATCHET_EVOLVE_LOG.trim();
  }
  return path.join(cwd, '.ratchet', 'evolve-log.jsonl');
}

function readEvents(cwd = process.cwd()) {
  const file = logPath(cwd);
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch (_e) {
        return null;
      }
    })
    .filter(Boolean);
}

function dateStamp(iso) {
  // evo_2026_07_03_001 — derive the date part from the event timestamp.
  return String(iso).slice(0, 10).replace(/-/g, '_');
}

function nextId(cwd, iso) {
  const day = dateStamp(iso);
  const sameDay = readEvents(cwd).filter((e) => String(e.id).includes(`evo_${day}_`));
  const seq = String(sameDay.length + 1).padStart(3, '0');
  return `evo_${day}_${seq}`;
}

// Artifacts that never point at a file still have a mode: derive it from what
// kind of thing the record is, so a record-scope `code` artifact still meets the
// seam gate instead of slipping through as prose.
const KIND_MODE = {
  code: 'code',
  patch: 'code',
  'code-patch': 'code',
  'test-suite': 'code',
  prompt: 'prompt',
  skill: 'prompt',
  workflow: 'workflow',
  'operating-procedure': 'workflow',
  'qa-ledger': 'workflow',
};

// Every bound event is written by this CLI path; the field records that fact.
const BOUND_SOURCE = 'evolve';

// Compute the binding the CLI will stamp, refusing everything a caller could
// use to launder an unproven KEEP into the log. This stops IN-BAND laundering
// by the model — it is not tamper-proofing: the journal is plaintext on a
// caller-selectable path (RATCHET_EVOLVE_LOG), so anyone who can write files can
// write lines. The gate closes the path the loop itself runs through.
function resolveBinding(cwd, fields, opts) {
  const state = require('../state');
  const lifecycle = require('../lifecycle');
  const { detectMode } = require('./snapshot');

  if (fields.artifactRev != null || (fields.artifactHash && String(fields.artifactHash).trim())) {
    throw new Error('artifactRev/artifactHash are computed by the CLI, not supplied.');
  }
  if (fields.id) {
    throw new Error('a bound event takes a machine id, not a caller-supplied one — omit "id".');
  }

  const id = String(fields.artifactId).trim();
  const s = state.loadState(cwd);
  const matches = (s.artifacts || []).filter((a) => a && a.id === id);
  if (matches.length > 1) {
    throw new Error(
      `${matches.length} artifacts share the id "${id}" — refusing to bind proof to an ambiguous record. ` +
        'Repair the store first: give the duplicates distinct ids in state.json, then re-run.'
    );
  }
  const artifact = matches[0];
  if (!artifact) throw new Error(`no artifact with id "${id}" to bind this proof to`);
  if (lifecycle.isOutOfLifecycle(artifact) || lifecycle.isClosed(artifact)) {
    throw new Error(`artifact "${id}" is ${artifact.status} — it has left the lifecycle and takes no new proof`);
  }

  const fp = lifecycle.fingerprint(cwd, artifact);

  // Mode decides which gates apply, so the caller does not get to pick it: a
  // code artifact bound through mode:"docs" would dodge the seam gate entirely.
  const derived =
    fp.hashScope === 'file' ? detectMode(artifact.path) : KIND_MODE[String(artifact.kind || '').toLowerCase()] || 'docs';
  const claimed = fields.mode && fields.mode !== 'auto' ? String(fields.mode) : '';
  if (claimed && claimed !== derived) {
    throw new Error(
      `mode "${claimed}" contradicts the bound artifact: "${id}" derives mode "${derived}" — ` +
        'mode selects which gates apply and is derived, not claimed'
    );
  }

  const verifiedHash = String((opts && opts.verifiedHash) || '').trim();
  if (!verifiedHash) {
    throw new Error(
      'a bound event requires the verifiedHash from `ratchet-evolve verify <target> --artifact <id>` — ' +
        'proof must name the exact bytes it was gathered against'
    );
  }
  if (verifiedHash !== fp.hash) {
    throw new Error('file changed after verification — re-verify.');
  }
  // The hash alone cannot see a metadata-only revision: retitle an artifact and
  // the FILE is untouched, so rev-1 evidence would be stamped onto rev 2. The
  // revision the harness actually ran against has to be carried and matched.
  const verifiedRev = opts ? opts.verifiedRev : undefined;
  if (!Number.isInteger(verifiedRev)) {
    throw new Error(
      'a bound event requires the verifiedRev from `ratchet-evolve verify <target> --artifact <id>` — ' +
        'proof must name the exact revision it was gathered against'
    );
  }
  if (verifiedRev !== fp.rev) {
    throw new Error(
      `artifact revised after verification — evidence is from rev ${verifiedRev}, the artifact is at rev ${fp.rev}. Re-verify.`
    );
  }

  // Provenance is stamped, not claimed. Refusing only a DIFFERENT value is the
  // weaker gate — the forgery that matters supplies the RIGHT-looking one, and
  // an empty or falsey value slips a hand-written line past just as well. If the
  // caller mentions `source` at all, refuse: the CLI always stamps it.
  if (Object.prototype.hasOwnProperty.call(fields, 'source')) {
    throw new Error(
      `source is stamped by the CLI on a bound event, not supplied (got ${JSON.stringify(fields.source)}) — omit "source".`
    );
  }

  return {
    artifactId: id,
    artifactRev: fp.rev,
    artifactHash: fp.hash,
    hashScope: fp.hashScope,
    mode: derived,
    source: BOUND_SOURCE,
  };
}

function appendEvent(cwd, fields, opts = {}) {
  const f = fields || {};
  const binding = String(f.artifactId || '').trim() ? resolveBinding(cwd, f, opts) : null;
  const event = newEvent(binding ? { ...f, ...binding } : f);
  // Proof gate: refuse to persist a KEEP without verification evidence. Throws
  // before any write, so the log never contains an unproven kept mutation.
  validateKeepGate(event);
  if (!event.id) event.id = nextId(cwd, event.timestamp);
  const file = logPath(cwd);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(event) + '\n', 'utf8');
  return event;
}

function status(cwd = process.cwd()) {
  const events = readEvents(cwd);
  if (!events.length) {
    return { events: 0, kept: 0, reverted: 0, revertedAndLearned: 0, asks: 0, targets: [], last: null };
  }
  const targets = [...new Set(events.map((e) => e.target))];
  const last = events[events.length - 1];
  const kept = events.filter((e) => e.verdict === 'KEEP').length;
  const reverted = events.filter((e) => e.verdict === 'REVERT').length;
  const revertedAndLearned = events.filter((e) => e.verdict === 'REVERTED_AND_LEARNED').length;
  const asks = events.filter((e) => e.verdict === 'ASK').length;
  return { events: events.length, kept, reverted, revertedAndLearned, asks, targets, last };
}

module.exports = { logPath, readEvents, appendEvent, nextId, status };
