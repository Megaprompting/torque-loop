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

// A malformed line is a LOST EVENT. Dropping it silently means the trail is short
// by one and every count derived from it is wrong with no sign that it is — and a
// dropped REVERT reads as "no REVERT", which is how a damaged log CERTIFIES a
// closure instead of blocking it. So the damage is part of the RESULT, not just a
// stderr side effect: each caller decides what it means for the question it is
// asking, and the gate that certifies closure decides it means "refuse".
function readEventsWithHealth(cwd = process.cwd()) {
  const file = logPath(cwd);
  if (!fs.existsSync(file)) return { events: [], malformed: 0, file };
  const events = [];
  let malformed = 0;
  for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    try {
      events.push(JSON.parse(line));
    } catch (_e) {
      malformed++;
    }
  }
  return { events, malformed, file };
}

// The warning is per (file, count) and is best-effort NOISE CONTROL only. It is
// deliberately not the mechanism any decision rests on: a process-global dedup
// means an earlier read can silence a later one, so a gate that depended on
// seeing this line would fail open exactly when it mattered most.
let _warnedMalformed = '';

function readEvents(cwd = process.cwd()) {
  const read = readEventsWithHealth(cwd);
  if (read.malformed && _warnedMalformed !== `${read.file}:${read.malformed}`) {
    _warnedMalformed = `${read.file}:${read.malformed}`;
    process.stderr.write(
      `[ratchet] ${read.malformed} unreadable line(s) in ${read.file} — those events are NOT counted in any verdict, ` +
        'proof, or closure check. Repair or archive the log before trusting a count from it.\n'
    );
  }
  return read.events;
}

function dateStamp(iso) {
  // evo_2026_07_03_001 — derive the date part from the event timestamp.
  return String(iso).slice(0, 10).replace(/-/g, '_');
}

// Identity is the highest sequence ALREADY on the log plus one — not the count
// of today's events. A count re-derives the same number for every process that
// reads before any of them writes, and it also re-uses an id the moment one is
// missing. Called under the append lock (appendEvent), so "highest" cannot move
// underneath the caller.
function nextId(cwd, iso) {
  const day = dateStamp(iso);
  const seqOf = new RegExp(`^evo_${day}_(\\d+)$`);
  let max = 0;
  for (const e of readEvents(cwd)) {
    const m = seqOf.exec(String(e && e.id));
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `evo_${day}_${String(max + 1).padStart(3, '0')}`;
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

// An append that died mid-line leaves the file not ending in a newline, and the
// NEXT append then concatenates itself onto that fragment: one malformed line
// where there should be a damaged one and a good one, so the new event is lost
// too. Terminate the fragment first — it stays malformed and gets counted as
// such by readEvents, but it stops eating its successors.
function quarantinePartialLine(file) {
  let size = 0;
  try {
    size = fs.statSync(file).size;
  } catch (_e) {
    return; // no file yet
  }
  if (!size) return;
  const fd = fs.openSync(file, 'r');
  try {
    const tail = Buffer.alloc(1);
    fs.readSync(fd, tail, 0, 1, size - 1);
    if (tail[0] === 0x0a) return;
  } finally {
    fs.closeSync(fd);
  }
  fs.appendFileSync(file, '\n', 'utf8');
  process.stderr.write(
    `[ratchet] ${file} did not end on a line boundary — an append died mid-event. Closed the partial line so ` +
      'this event is not swallowed by it; the fragment stays on the log as an unreadable line.\n'
  );
}

function appendEvent(cwd, fields, opts = {}) {
  const f = fields || {};
  const state = require('../state');
  const file = logPath(cwd);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // A BOUND event's validation binds evidence to an artifact's exact revision and
  // hash, and the writers that can MOVE that revision take the workspace lock,
  // not the journal's. Holding only the journal lock excluded the wrong
  // processes: the artifact could go rev 1 → rev 2 between validation and append
  // without touching the journal at all. So a bound append holds both, in the
  // declared order — and the state read that materializes the store happens
  // INSIDE the workspace lock, where it simply joins the open scope.
  //
  // An UNBOUND event binds to nothing in state and reads nothing from it, so it
  // takes the journal lock alone. It used to call loadState unconditionally, which
  // on a fresh store IS the locked init transition — so an unbound append queued
  // behind (and on a busy store, died on) a lock it never needed.
  const bound = String(f.artifactId || '').trim();
  const run = () => appendLocked(cwd, f, opts, file, bound);
  if (!bound) return run();
  return state.withWorkspaceLock(cwd, 'evolve append (bound)', () => {
    state.loadState(cwd); // materialize the store under the lock we already hold
    return run();
  });
}

function appendLocked(cwd, f, opts, file, bound) {
  return require('../state').withFileLock(file, 'evolve append', () => {
    // Validation happens UNDER the lock, not before it: the artifact can be
    // revised, closed, or re-bound between a pre-flight check and the append,
    // and evidence validated against a revision that is no longer current is
    // exactly the stale proof the binding exists to refuse.
    const binding = bound ? resolveBinding(cwd, f, opts) : null;
    const event = newEvent(binding ? { ...f, ...binding } : f);
    // Proof gate: refuse to persist a KEEP without verification evidence. Throws
    // before any write, so the log never contains an unproven kept mutation.
    validateKeepGate(event);
    // Naming the event and appending it are ONE step. Split, two processes read
    // the same log, mint the same id, and the second append is a duplicate
    // identity on a record whose whole job is to be the trail. The lock lives
    // beside the log, not in the workspace store: the log's path is
    // caller-selectable (RATCHET_EVOLVE_LOG), so the workspace lock would be the
    // wrong scope in both directions.
    if (!event.id) {
      event.id = nextId(cwd, event.timestamp);
    } else if (readEvents(cwd).some((e) => e && String(e.id) === String(event.id))) {
      // REFUSED, not regenerated. A caller that supplies an id is naming a
      // specific event; quietly renaming it would leave the caller holding an id
      // that means something else on the log, which is worse than a hard stop.
      throw new Error(
        `event id "${event.id}" is already on the log — refusing to append a second event under one identity. ` +
          'Omit "id" and the CLI mints one.'
      );
    }
    quarantinePartialLine(file);
    fs.appendFileSync(file, JSON.stringify(event) + '\n', 'utf8');
    return event;
  });
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

module.exports = { logPath, readEvents, readEventsWithHealth, appendEvent, nextId, status };
