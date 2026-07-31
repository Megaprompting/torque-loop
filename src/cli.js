'use strict';

const fs = require('fs');
const path = require('path');

const state = require('./state');
const ledger = require('./ledger');
const scoring = require('./scoring');
const artifacts = require('./artifacts');
const repo = require('./repoSnapshot');
const gitRefs = require('./gitRefs');
const coldStart = require('./coldStart');
const lifecycle = require('./lifecycle');
const md = require('./markdown');
const receipt = require('./receipt');
const journal = require('./evolve/journal');
const schemas = require('./schemas');
const verbs = require('./verbs');

const VERSION = require('../package.json').version;
const PLUGIN_ROOT = path.resolve(__dirname, '..');

function out(s) {
  process.stdout.write(String(s) + '\n');
}
function err(s) {
  process.stderr.write(String(s) + '\n');
}

// Resolve a JSON payload from: raw string, @file, or "-" (stdin).
function readPayload(arg) {
  if (arg == null) throw new Error('expected a JSON payload (string, @file, or - for stdin)');
  let raw;
  if (arg === '-') raw = fs.readFileSync(0, 'utf8');
  else if (arg.startsWith('@')) raw = fs.readFileSync(arg.slice(1), 'utf8');
  else raw = arg;
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error(`invalid JSON payload: ${e.message}`);
  }
}

function readStdinSafe() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch (_e) {
    return '';
  }
}

// state.set's meaning moved to src/verbs.js (shared with the MCP write tool);
// the alias keeps every other inline caller reading as before.
const { coerceScalar } = require('./verbs');

// Minimal `--key value` parser for subcommands that carry real values (defect
// lifecycle). The top-level router treats every `--flag` as boolean, which is
// fine for switches like --json but drops values like --evidence "<text>".
// Declared booleans never swallow the following positional.
function parseArgv(argv, { booleans = [] } = {}) {
  const boolSet = new Set(booleans);
  const positionals = [];
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (typeof a === 'string' && a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq !== -1) {
        opts[a.slice(2, eq)] = a.slice(eq + 1);
        continue;
      }
      const key = a.slice(2);
      const next = argv[i + 1];
      if (!boolSet.has(key) && next != null && !String(next).startsWith('--')) {
        opts[key] = next;
        i++;
      } else {
        opts[key] = true;
      }
    } else {
      positionals.push(a);
    }
  }
  return { positionals, opts };
}

// A flag value is only usable if it is a non-empty string; a bare `--evidence`
// (no value) parses as `true` and must be rejected, not stringified to "true".
function strOpt(v) {
  return v == null || v === true ? '' : String(v).trim();
}

// Agent memory isolation (propose-only) moved to the mutation boundary in 0.9
// (src/state.js) so it guards the door every public write now comes through
// instead of only the router. The CLI still asks first: refusing before the work
// is cheaper, and the message names the verb the agent actually reached for.
const { proposeOnlyAgent, assertMayWrite } = state;

// One public command is ONE transaction: the lock covers the whole verb, every
// helper underneath mutates the transaction's state instead of saving its own,
// and the commit is a single revision. `mutate` returns whatever the verb
// returned, so a routed call reads exactly like the unrouted one it replaced.
function mutate(cwd, action, fn) {
  return state.withWorkspaceMutation(cwd, { action }, fn).result;
}

// Both doors onto the irreversible wipe (`state reset --force`, `init --force`)
// ask the same two questions, so neither becomes the cheap way past the other.
// Returns the owner + reason that go into the tombstone.
function authorizeWipe(argv, verb) {
  const { opts } = parseArgv(argv, { booleans: ['force', 'json'] });
  const owner = strOpt(opts.owner);
  const reason = strOpt(opts.reason);
  if (!owner) throw new Error(`${verb} requires --owner "<who authorized the wipe>"`);
  if (!reason) throw new Error(`${verb} requires --reason "<why the record is being destroyed>"`);
  return { owner, reason };
}

// ---------------------------------------------------------------------------
// Command table.
// ---------------------------------------------------------------------------

function run(argv) {
  const args = argv.slice(2);
  const cwd = process.cwd();
  const flags = new Set(args.filter((a) => a.startsWith('--')));
  const pos = args.filter((a) => !a.startsWith('--'));
  const asJson = flags.has('--json');
  const [group, sub, ...rest] = pos;

  // `--version` / `--help` are flags, so they never land in `group`; handle them
  // up front or `ratchet --version` silently falls through to the help text.
  if (flags.has('--version')) return out(`ratchet ${VERSION}`);
  if (flags.has('--help') && group == null) return help();

  switch (group) {
    case undefined:
    case 'help':
    case '-h':
    case '--help':
      return help();

    case 'version':
    case '-v':
    case '--version':
      return out(`ratchet ${VERSION}`);

    case 'init': {
      // `init --force` is the SAME irreversible wipe as `state reset --force` —
      // it just used to be the door with no lock on it. One authority check, one
      // tombstone, whichever verb the caller reached for. Plain init only ensures
      // the dir exists, so a propose-only agent may still orient.
      if (flags.has('--force')) {
        assertMayWrite('init --force');
        const wipe = authorizeWipe(args, 'ratchet init --force');
        // A wipe REPLACES the record, under the lock — and CONTINUES the revision
        // counter, so a snapshot of the previous generation can never match the
        // fresh one and overwrite it (initProject owns that rule).
        const forced = state.withWorkspaceLock(cwd, 'init --force', () =>
          state.initProject(cwd, { force: true, resetBy: wipe.owner, resetReason: wipe.reason })
        );
        return out(`Ratchet re-initialized at ${forced.dir} (owner: ${wipe.owner})`);
      }
      const res = state.initProject(cwd);
      return out(`Ratchet initialized at ${res.dir}${res.created ? '' : ' (already existed)'}`);
    }

    case 'state':
      // The raw argv travels too: the top-level split drops `--key value` pairs,
      // and the closure verbs carry real values (--evidence, --owner, --reason).
      return cmdState(cwd, sub, rest, asJson, flags, args);

    case 'receipt': {
      const r = receipt.assemble(cwd);
      // --save writes the source-of-truth index: one always-current file a cold
      // agent can read instead of doing archaeology. Derived + regenerable, so it
      // is not a canonical-state write (propose-only agents may refresh it).
      if (flags.has('--save')) {
        const dir = path.join(cwd, '.ratchet');
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'current.json'), JSON.stringify(r, null, 2) + '\n', 'utf8');
        fs.writeFileSync(path.join(dir, 'current.md'), md.receipt(r) + '\n', 'utf8');
        if (!asJson) out(`saved .ratchet/current.json + .ratchet/current.md`);
      }
      return out(asJson ? JSON.stringify(r, null, 2) : md.receipt(r));
    }

    case 'ledger':
      return cmdLedger(cwd, sub, rest, asJson);

    case 'artifact': {
      if (sub === 'close') return cmdArtifactClose(cwd, args);
      if (sub !== 'add') throw new Error('usage: ratchet artifact add <json> | ratchet artifact close <id>');
      assertMayWrite('artifact add');
      const payload = readPayload(rest[0]);
      const rec = mutate(cwd, 'artifact add', () => artifacts.addArtifact(cwd, payload));
      return out(`artifact ${rec.id} ${rec.rev > 1 ? `revised → rev ${rec.rev}` : 'added'}: ${rec.title} (${rec.status})`);
    }

    case 'defect':
      return cmdDefect(cwd, args, asJson);

    case 'retract':
      return cmdRetract(cwd, args);

    case 'score':
      return cmdScore(cwd, sub, rest, asJson);

    case 'snapshot': {
      const target = rest[0] || cwd;
      const snap = repo.snapshot(target);
      return out(asJson ? JSON.stringify(snap, null, 2) : md.repoSnapshot(snap));
    }

    case 'git': {
      if (sub !== 'status-refs' && sub !== 'status') {
        throw new Error('usage: ratchet git status-refs [--json]');
      }
      const refs = gitRefs.statusRefs(cwd);
      return out(asJson ? JSON.stringify(refs, null, 2) : md.gitStatusRefs(refs));
    }

    case 'export':
      return cmdExport(cwd, sub);

    case 'status': {
      const s = state.loadState(cwd);
      return out(asJson ? JSON.stringify(s, null, 2) : md.stateSummary(s));
    }

    case 'compile': {
      if (sub !== 'done') throw new Error('usage: ratchet compile done [--json]');
      assertMayWrite('compile done');
      return cmdCompileDone(cwd, asJson);
    }

    case 'doctor':
      if (sub === 'cold-start') return cmdColdStart(cwd, asJson);
      return cmdDoctor(cwd, asJson);

    case 'touch': {
      const file = sub;
      if (!file) throw new Error('usage: ratchet touch <file>');
      assertMayWrite('touch');
      mutate(cwd, 'touch', (s) => {
        s.touchedFiles.push({ path: file, at: schemas.nowIso() });
        s.dirty = true;
      });
      return out(`touched ${file}`);
    }

    case 'hook':
      return cmdHook(cwd, sub);

    default:
      err(`unknown command: ${group}`);
      help();
      process.exitCode = 2;
  }
}

function cmdState(cwd, sub, rest, asJson, flags = new Set(), argv = []) {
  switch (sub) {
    case undefined:
    case 'get': {
      const s = state.loadState(cwd);
      const key = rest[0];
      if (key) {
        const v = s[key];
        return out(typeof v === 'object' ? JSON.stringify(v, null, 2) : String(v == null ? '' : v));
      }
      return out(asJson ? JSON.stringify(s, null, 2) : md.stateSummary(s));
    }
    case 'set': {
      assertMayWrite('state set');
      const [key, ...valueParts] = rest;
      if (!key) throw new Error('usage: ratchet state set <key> <value>');
      if (!schemas.STATE_SCALARS.has(key)) {
        throw new Error(`"${key}" is not a settable scalar. valid: ${[...schemas.STATE_SCALARS].join(', ')}`);
      }
      const value = valueParts.join(' ');
      mutate(cwd, 'state set', (s) => {
        verbs.setScalar(s, key, value, (prefix) => state.makeId(prefix));
      });
      return out(`${key} set`);
    }
    case 'append': {
      assertMayWrite('state append');
      const [collection, payloadArg] = rest;
      if (!schemas.STATE_COLLECTIONS[collection]) {
        throw new Error(`unknown collection "${collection}". valid: ${Object.keys(schemas.STATE_COLLECTIONS).join(', ')}`);
      }
      // Artifacts and defects have gated constructors (identity, attachment,
      // reserved fields, dedup). A raw append walks straight past all of them,
      // which is how a "closed" artifact or a "resolved" defect gets minted with
      // no transition behind it.
      if (collection === 'artifacts' || collection === 'defects') {
        throw new Error(
          `${collection} are not appendable: use ${collection === 'artifacts' ? 'ratchet artifact add' : 'ratchet defect add'} ` +
            '<json>, which enforces the identity, attachment, and status gates a raw append bypasses.'
        );
      }
      const item = readPayload(payloadArg);
      // Birth status is forced, not accepted: an assumption born "tested" and a
      // loop born "closed" are exactly the two lies that make the drain lie.
      const BIRTH_STATUS = { assumptions: 'untested', openLoops: 'open' };
      const birth = BIRTH_STATUS[collection];
      const appended = mutate(cwd, 'state append', (s) => {
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
          // The dedup runs UNDER the lock against the reloaded record, so two
          // processes appending the same text produce one entry, not two.
          if (dup) return { dup };
        }
        const record = { id: item.id || state.makeId(schemas.STATE_COLLECTIONS[collection]), at: schemas.nowIso(), ...item };
        s[collection].push(record);
        s.dirty = true;
        return { record };
      });
      if (appended.dup) return out(`already recorded in ${collection}: ${appended.dup.id}`);
      return out(`appended to ${collection}: ${appended.record.id}`);
    }
    case 'close':
      return cmdStateClose(cwd, argv);
    case 'reset': {
      assertMayWrite('state reset');
      // Authority gate: wiping session state (objective, defects, artifacts,
      // decisions, history) is irreversible. Like every other irreversible verb
      // in the CLI, it must be explicitly authorized — a bare `state reset` must
      // not be able to erase the record by accident. --force says "I mean it";
      // --owner/--reason say who meant it and why, because the wipe destroys the
      // only record of that answer.
      if (!flags.has('--force')) {
        throw new Error(
          'ratchet state reset wipes all session state (objective, defects, artifacts, decisions, history) — ' +
            'this is irreversible. Re-run with --force to authorize.'
        );
      }
      const wipe = authorizeWipe(argv, 'state reset --force');
      // Same door as `init --force`: a wipe replaces the record, so it holds the
      // lock (nobody may be mid-write) but resets the revision counter.
      state.withWorkspaceLock(cwd, 'state reset --force', () =>
        state.initProject(cwd, { force: true, resetBy: wipe.owner, resetReason: wipe.reason })
      );
      return out(`state reset (owner: ${wipe.owner})`);
    }
    default:
      throw new Error(`unknown state subcommand: ${sub}`);
  }
}

// Loops and assumptions could be born but never finished — the same hole the
// defect lifecycle had before 0.2. An open loop that was actually answered kept
// draining confidence, so the drain stopped tracking reality and the number
// stopped meaning anything. Parking is a close too: it stops the nagging, but it
// STILL DRAINS, because a parked question is an unanswered question with an
// owner, not an answered one.
function cmdStateClose(cwd, argv) {
  assertMayWrite('state close');
  const { positionals, opts } = parseArgv(argv, { booleans: ['park', 'json'] });
  const collection = positionals[2];
  const id = positionals[3];
  const need = (val, msg) => {
    if (!val) throw new Error(msg);
    return val;
  };

  if (collection !== 'openLoops' && collection !== 'assumptions') {
    throw new Error(
      `ratchet state close handles openLoops and assumptions${collection ? ` (got "${collection}")` : ''} — ` +
        'defects transition with ratchet defect resolve|waive|supersede, artifacts with ratchet artifact close.'
    );
  }
  need(id, `usage: ratchet state close ${collection} <id> ...`);

  const to = mutate(cwd, `state close ${collection}`, (s) => closeRecord(s, collection, id, opts));
  return out(`${collection} ${id} → ${to}`);
}

// The transition itself, applied to the transaction's state. Split out only so
// the boundary above owns the load/save and this owns the rules.
function closeRecord(s, collection, id, opts) {
  const need = (val, msg) => {
    if (!val) throw new Error(msg);
    return val;
  };
  const record = (s[collection] || []).find((x) => x && x.id === id);
  if (!record) throw new Error(`no ${collection} entry with id "${id}"`);
  const now = schemas.nowIso();
  const evidence = strOpt(opts.evidence);
  let to;

  if (collection === 'openLoops') {
    if (opts.park === true) {
      const owner = need(strOpt(opts.owner), 'parking a loop requires --owner "<who carries it>"');
      const trigger = need(
        strOpt(opts['revisit-trigger']),
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
    const outcome = strOpt(opts.outcome);
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
    id: state.makeId('hist'),
    at: now,
    event: `${collection === 'openLoops' ? 'loop' : 'assumption'}.${to}`,
    note: `${id}: ${from} → ${to}${evidence ? ` — ${evidence}` : ''}`,
  });
  return to;
}

// The closure gate. `compile done` says the record is current; this says the
// work is finished — and it will only say so when a KEEP is bound to THIS exact
// revision. Checkpoint is not closure.
function cmdArtifactClose(cwd, argv) {
  assertMayWrite('artifact close');
  const { positionals, opts } = parseArgv(argv, { booleans: ['waive-holes', 'json'] });
  const id = positionals[2];
  if (!id) throw new Error('usage: ratchet artifact close <id> [--waive-holes --owner "<who>" --reason "<why>"]');
  // The blocker check and the certificate it authorizes run inside ONE
  // transaction: a defect landing between them would otherwise be closed over.
  // The journal lock is taken by the BOUNDARY so it spans the state commit too.
  // Locking only the proof READ moved the window instead of closing it: a REVERT
  // appended after the read but before the commit still landed on evidence this
  // gate had stopped watching, and the artifact still closed on a revoked KEEP.
  // Lock order: workspace → journal.
  return out(
    state.withWorkspaceMutation(cwd, { action: 'artifact close', alsoLockFile: journal.logPath(cwd) }, (s) =>
      closeArtifact(cwd, s, id, opts)
    ).result
  );
}

function closeArtifact(cwd, s, id, opts) {
  const matches = (s.artifacts || []).filter((a) => a && a.id === id);
  if (matches.length > 1) {
    throw new Error(
      `${matches.length} artifacts share the id "${id}" — refusing to close an ambiguous record. ` +
        'Repair the store first: give the duplicates distinct ids in state.json, then re-run.'
    );
  }
  const artifact = matches[0];
  if (!artifact) throw new Error(`no artifact with id "${id}"`);

  // Idempotent: a second close of an already-certified artifact is a no-op, not
  // an error. Re-running a serialize block must never be punished.
  if (lifecycle.isClosed(artifact)) {
    return `artifact ${id} is already closed (rev ${artifact.closedRev}, by ${artifact.closedBy}) — no change`;
  }

  const owner = strOpt(opts.owner);
  const reason = strOpt(opts.reason);
  const waiveHoles = opts['waive-holes'] === true;

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
    throw new Error(
      `cannot close artifact "${id}": proof record damaged — ${read.malformed} unreadable line(s) in ${read.file}. ` +
        'A dropped event is indistinguishable from no event, so this closure cannot be certified. ' +
        'Repair or archive the log, then re-run.'
    );
  }
  const events = read.events;
  const blockers = lifecycle.closureBlockers(s, events, artifact, cwd, { waiveHoles, owner, reason });
  if (blockers.length) {
    throw new Error(
      `cannot close artifact "${id}" — ${blockers.length} blocker(s):\n` + blockers.map((b) => `  - [${b.code}] ${b.message}`).join('\n')
    );
  }

  const fp = lifecycle.fingerprint(cwd, artifact);
  // A record-scope close certifies a claim about a RECORD, not about bytes on
  // disk — a much weaker proof. It is allowed, but only with a named owner who
  // says so out loud, exactly like a seam waiver.
  if (fp.hashScope === 'record') {
    if (!owner || !reason) {
      throw new Error(
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
    id: state.makeId('hist'),
    at: now,
    event: 'artifact.closed',
    note: `${id} closed at rev ${fp.rev} on ${bound.id || 'bound proof'}${owner ? ` (owner: ${owner})` : ''}`,
  });
  return `artifact ${id} closed — rev ${fp.rev}, ${fp.hashScope} hash ${String(fp.hash).slice(0, 8)}, proof ${bound.id || '—'}`;
}

function cmdLedger(cwd, sub, rest, asJson) {
  switch (sub) {
    case 'create': {
      assertMayWrite('ledger create');
      // The ledger is a second file in the same store, so it takes the same lock
      // — but it is not a state revision, so it never bumps rev.
      const l = state.withWorkspaceLock(cwd, 'ledger create', () => ledger.create(cwd));
      return out(`ledger ready (${md.dash(l.updatedAt)})`);
    }
    case 'update': {
      assertMayWrite('ledger update');
      const [collection, payloadArg] = rest;
      const payload = readPayload(payloadArg);
      const res = state.withWorkspaceLock(cwd, 'ledger update', () => ledger.upsert(cwd, collection, payload));
      return out(`${res.action} ${collection}: ${res.item.id}`);
    }
    case undefined:
    case 'get': {
      const l = state.loadLedger(cwd);
      if (asJson) return out(JSON.stringify(l, null, 2));
      const s = ledger.summary(l);
      return out(
        `### QA ledger\n- Features: ${s.features}\n- Tests: ${s.tests} (${s.failingTests} failing)\n- Defects: ${s.defects} (${s.openDefects} open)`
      );
    }
    default:
      throw new Error(`unknown ledger subcommand: ${sub}`);
  }
}

// Defect lifecycle — the mutation the CLI lacked in 0.2. `add` keeps its JSON
// contract; every other verb transitions an existing defect by id and (for the
// clearing verbs) demands the proof/reason that makes the clear honest.
function cmdDefect(cwd, argv, asJson) {
  // argv still includes the leading "defect" group token → positionals[0].
  const { positionals, opts } = parseArgv(argv, { booleans: ['json'] });
  const sub = positionals[1];
  const id = positionals[2];
  const json = asJson || opts.json === true;

  const need = (val, msg) => {
    if (!val) throw new Error(msg);
    return val;
  };

  // Read verbs (list/get) are open to every agent; the mutating verbs are not.
  if (sub && sub !== 'list' && sub !== 'get') assertMayWrite(`defect ${sub}`);

  switch (sub) {
    case 'add': {
      const payload = readPayload(positionals[2]);
      const rec = mutate(cwd, 'defect add', () => artifacts.addDefect(cwd, payload));
      return out(`defect ${rec.state.id} added: [${rec.state.severity}] ${rec.state.summary}`);
    }
    case 'list': {
      const s = state.loadState(cwd);
      return out(json ? JSON.stringify(s.defects || [], null, 2) : md.defectList(s.defects || []));
    }
    case 'get': {
      need(id, 'usage: ratchet defect get <id> [--json]');
      const s = state.loadState(cwd);
      const d = (s.defects || []).find((x) => x.id === id);
      if (!d) throw new Error(`no defect with id "${id}"`);
      return out(json ? JSON.stringify(d, null, 2) : md.defectOne(d));
    }
    case 'resolve': {
      need(id, 'usage: ratchet defect resolve <id> --evidence "<proof>"');
      const evidence = strOpt(opts.evidence);
      // Proof gate, same spirit as the evolve KEEP gate: a defect cannot be
      // marked fixed without stating the proof that it is actually fixed.
      need(evidence, 'defect resolve requires --evidence "<proof it is actually fixed>" — no proof, no resolve');
      mutate(cwd, 'defect resolve', () => artifacts.transitionDefect(cwd, id, 'resolved', { evidence, note: `resolved: ${evidence}` }));
      return out(`defect ${id} → resolved`);
    }
    case 'reopen': {
      need(id, 'usage: ratchet defect reopen <id> --reason "<why>"');
      const reason = strOpt(opts.reason);
      need(reason, 'defect reopen requires --reason "<why it is not actually fixed>"');
      mutate(cwd, 'defect reopen', () => artifacts.transitionDefect(cwd, id, 'reopened', { reason, note: `reopened: ${reason}` }));
      return out(`defect ${id} → reopened`);
    }
    case 'waive': {
      need(id, 'usage: ratchet defect waive <id> --owner "<name>" --reason "<why>"');
      const owner = strOpt(opts.owner);
      const reason = strOpt(opts.reason);
      need(owner, 'defect waive requires --owner "<who accepts the risk>"');
      need(reason, 'defect waive requires --reason "<why shipping anyway is acceptable>"');
      mutate(cwd, 'defect waive', () =>
        artifacts.transitionDefect(cwd, id, 'waived', { owner, reason, note: `waived by ${owner}: ${reason}` })
      );
      return out(`defect ${id} → waived (owner: ${owner})`);
    }
    case 'supersede': {
      need(id, 'usage: ratchet defect supersede <id> --by <artifact-or-defect-id>');
      const by = strOpt(opts.by);
      need(by, 'defect supersede requires --by <artifact-or-defect-id>');
      const reason = strOpt(opts.reason);
      mutate(cwd, 'defect supersede', () =>
        artifacts.transitionDefect(cwd, id, 'superseded', {
          by,
          reason,
          note: `superseded by ${by}${reason ? `: ${reason}` : ''}`,
        })
      );
      return out(`defect ${id} → superseded (by: ${by})`);
    }
    default:
      throw new Error(
        'usage: ratchet defect <add|list|get|resolve|reopen|waive|supersede> ...' + (sub ? ` (got "${sub}")` : '')
      );
  }
}

// Retract an artifact whose central claim became false or obsolete. Requires a
// reason (proof-gate spirit: never retract silently); --superseded-by links the
// replacement so provenance survives.
function cmdRetract(cwd, argv) {
  assertMayWrite('retract');
  const { positionals, opts } = parseArgv(argv, {});
  const id = positionals[1];
  if (!id) throw new Error('usage: ratchet retract <artifact-id> --reason "<why>" [--superseded-by <id>]');
  const reason = strOpt(opts.reason);
  if (!reason) throw new Error("retract requires --reason \"<why this artifact's claim is false or obsolete>\"");
  const supersededBy = strOpt(opts['superseded-by']);
  mutate(cwd, 'retract', () => artifacts.retractArtifact(cwd, id, { reason, supersededBy }));
  return out(`artifact ${id} retracted${supersededBy ? ` (superseded by ${supersededBy})` : ''}`);
}

// Serialize the fog the moment the dial names it (a write). Steering the state
// never saw cannot drain confidence, warn a cold start, or survive a handoff.
// A propose-only agent still gets the read — no footprint; an already-open fog
// loop or a live unknown-map means the fog is already on the record. The loop
// closes itself when the unknown-map artifact lands (artifacts.js). Returns
// true only when a fog loop was actually written.
function fogAlreadyOnRecord(s) {
  const openFog = (s.openLoops || []).some(
    (l) => l.status !== 'closed' && String(l.text || '').startsWith(schemas.FOG_LOOP_PREFIX)
  );
  const liveMap = (s.artifacts || []).some(
    (a) => a.kind === 'unknown-map' && a.status !== 'retracted' && a.status !== 'superseded'
  );
  return openFog || liveMap;
}

function recordApertureFog(cwd, result) {
  if (!result.mapRequired || proposeOnlyAgent()) return false;
  // Double-checked on purpose. The common case is "already on the record", and
  // taking the workspace lock for a read that will write nothing would make an
  // aperture score queue behind every unrelated writer. The check that DECIDES
  // runs under the lock, against the state reloaded there.
  if (fogAlreadyOnRecord(state.loadState(cwd))) return false;
  let recorded = false;
  state.withWorkspaceMutation(cwd, { action: 'fog.recorded' }, (s) => {
    if (fogAlreadyOnRecord(s)) return; // the racer that got here first recorded it
    const now = schemas.nowIso();
    s.openLoops.push({
      id: state.makeId('loop'),
      at: now,
      text: `${schemas.FOG_LOOP_PREFIX} (aperture ${result.level}, score ${result.score}/10) — run /ratchet:map; closes when the unknown-map artifact lands`,
      status: 'open',
    });
    s.dirty = true;
    s.history.push({ id: state.makeId('hist'), at: now, event: 'fog.recorded', note: `aperture ${result.level} raised mapRequired` });
    recorded = true;
  });
  return recorded;
}

function cmdScore(cwd, sub, rest, asJson) {
  switch (sub) {
    case 'friction': {
      const result = scoring.scoreFriction(readPayload(rest[0]));
      return out(asJson ? JSON.stringify(result, null, 2) : md.friction(result));
    }
    case 'confidence': {
      const s = state.loadState(cwd);
      const ledger = state.loadLedger(cwd);
      let events = [];
      try {
        events = journal.readEvents(cwd);
      } catch (_e) {
        events = [];
      }
      const layers = scoring.scoreConfidenceLayers(s, ledger, events);
      // The fourth read: closure is a fact with named blockers, not a score, and
      // it ships beside the scores so a high number can never read as "done".
      const closure = lifecycle.workflowClosed(s, events, cwd);
      if (asJson) return out(JSON.stringify({ ...layers, closure }, null, 2));
      // No cache write. Until 0.9 the markdown branch wrote the session score
      // back into state, so the SAME read moved bytes on one output mode and not
      // the other — a read that revises the record it is reporting on can lose a
      // concurrent write and can never be trusted as a read. Confidence is
      // derived on every call; nothing needs it stored.
      return out(md.confidenceLayers(layers, closure));
    }
    case 'aperture': {
      const result = scoring.scoreAperture(readPayload(rest[0]));
      // Serialize the fog on BOTH output modes — a mapRequired that lives only
      // on stdout is the undrained-fog hole, and --json callers (the ones most
      // likely to automate this read) must not silently bypass the write. The
      // JSON result says whether the write happened (recordedFog).
      const recordedFog = recordApertureFog(cwd, result);
      if (asJson) return out(JSON.stringify({ ...result, recordedFog }, null, 2));
      return out(
        md.aperture(result) +
          (recordedFog
            ? '\n_Fog recorded as an open loop — it drains confidence until `/ratchet:map` lands the unknown-map artifact._'
            : '')
      );
    }
    default:
      throw new Error(`unknown score subcommand: ${sub} (friction | confidence | aperture)`);
  }
}

function cmdExport(cwd, sub) {
  const s = state.loadState(cwd);
  if (sub === 'json') return out(JSON.stringify(s, null, 2));
  const l = state.loadLedger(cwd);
  return out(md.fullExport(s, l));
}

// ---------------------------------------------------------------------------
// Hooks. These read Claude Code hook JSON on stdin and MUST never throw in a
// way that disrupts the session — always exit 0.
// ---------------------------------------------------------------------------

function cmdHook(cwd, sub) {
  try {
    switch (sub) {
      case 'session-start': {
        state.initProject(cwd);
        return; // silent
      }
      case 'post-edit': {
        const raw = readStdinSafe();
        let file = '';
        try {
          const data = JSON.parse(raw || '{}');
          file = data?.tool_input?.file_path || data?.tool_input?.path || data?.file_path || '';
        } catch (_e) {
          /* ignore malformed */
        }
        if (file) {
          // A hook fires while the session's own commands are running, so this
          // is the write most likely to race one. It goes through the boundary
          // like every other mutation — and, like every other mutation, it is
          // refused for a propose-only agent (which leaves no footprint at all).
          mutate(cwd, 'hook post-edit', (s) => {
            s.touchedFiles.push({ path: file, at: schemas.nowIso() });
            s.dirty = true;
          });
        }
        return; // silent, non-blocking
      }
      case 'stop-check': {
        const s = state.loadState(cwd);
        const stale = s.dirty && (!s.lastCompileAt || s.lastCompileAt < s.updatedAt);
        if (stale) {
          const n = (s.touchedFiles || []).length;
          err(
            `[ratchet] Work changed since last compile${n ? ` (${n} file touch(es) tracked)` : ''}. ` +
              `Run /ratchet:compile to serialize state before the trail goes cold.`
          );
        }
        // The same derivation the receipt and compile print. A session that ends
        // without it ends on whatever the model last believed.
        let events = [];
        try {
          events = journal.readEvents(cwd);
        } catch (_e) {
          events = [];
        }
        const next = lifecycle.nextTransition(s, events, cwd);
        err(`[ratchet] NEXT REQUIRED TRANSITION: ${next.label} -> ${next.command}`);
        return;
      }
      default:
        return;
    }
  } catch (e) {
    // Hooks fail closed: never break the session — but silence here reads as
    // "nothing to do", which is the one thing an unreadable closure state must
    // never imply. Say it cannot be trusted, then exit 0 like every hook.
    //
    // A propose-only agent hitting the write guard is NOT an unreadable state,
    // and reporting it as one sends the reader looking for corruption that is
    // not there. Name the actual refusal.
    try {
      if (e && e.code === 'ERATCHETPROPOSEONLY') {
        err(`[ratchet] ${proposeOnlyAgent()} is propose-only — this hook's edit was not recorded (no footprint by design).`);
      } else {
        err('[ratchet] closure state unreadable — do not claim closed.');
      }
    } catch (_e2) {
      /* nothing left to try */
    }
  }
}

// Atomically mark a session as CHECKPOINTED. Unlike `state set`, this CLEARS
// dirty (so the Stop hook stops nagging) and stamps lastCompileAt in one move.
// Compile completion is an event, not a scalar edit — it must never re-dirty the
// state, and it must never be mistaken for closure: it says the record is
// current, not that the work is finished.
function cmdCompileDone(cwd, asJson) {
  const now = schemas.nowIso();
  const s = mutate(cwd, 'compile done', (st) => {
    st.lastCompileAt = now;
    st.dirty = false;
    st.history.push({ id: state.makeId('hist'), at: now, event: 'compile.done', note: 'state serialized' });
    return st;
  });

  let events = [];
  try {
    events = journal.readEvents(cwd);
  } catch (_e) {
    events = [];
  }
  const next = lifecycle.nextTransition(s, events, cwd);
  if (asJson) {
    return out(JSON.stringify({ checkpointed: true, closed: lifecycle.workflowClosed(s, events, cwd).closed, next }, null, 2));
  }
  out('CHECKPOINTED, NOT CLOSED — state serialized');
  return out(`NEXT REQUIRED TRANSITION: ${next.label} -> ${next.command}`);
}

// Extract the raw YAML frontmatter block from a SKILL.md / agent .md file.
function frontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  return m ? m[1] : null;
}

// "Is my plugin healthy?" — validate the plugin shape against what Claude Code
// and Codex expect, plus version alignment and a live state/snapshot check.
// Exits non-zero on any failure so CI and `npm test` can gate a release on it.
function cmdDoctor(cwd, asJson) {
  const root = PLUGIN_ROOT;
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok: Boolean(ok), detail: detail || '' });
  const readJsonFile = (rel) => {
    try {
      return { ok: true, data: JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8')) };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  };

  const major = Number(process.versions.node.split('.')[0]);
  add('node >= 18', major >= 18, `found ${process.version}`);

  const pkg = readJsonFile('package.json');
  add('package.json parses', pkg.ok, pkg.ok ? '' : pkg.error);
  const claudePlugin = readJsonFile('.claude-plugin/plugin.json');
  add('.claude-plugin/plugin.json parses', claudePlugin.ok, claudePlugin.ok ? '' : claudePlugin.error);
  const claudeMarket = readJsonFile('.claude-plugin/marketplace.json');
  add('.claude-plugin/marketplace.json parses', claudeMarket.ok, claudeMarket.ok ? '' : claudeMarket.error);
  const codexPlugin = readJsonFile('.codex-plugin/plugin.json');
  add('.codex-plugin/plugin.json parses', codexPlugin.ok, codexPlugin.ok ? '' : codexPlugin.error);
  const codexMarket = readJsonFile('.agents/plugins/marketplace.json');
  add('.agents/plugins/marketplace.json parses', codexMarket.ok, codexMarket.ok ? '' : codexMarket.error);

  if (pkg.ok && claudePlugin.ok && claudeMarket.ok && codexPlugin.ok) {
    const pv = pkg.data.version;
    const others = [
      ['.claude-plugin/plugin.json', claudePlugin.data.version],
      ['.claude-plugin/marketplace.metadata', claudeMarket.data.metadata && claudeMarket.data.metadata.version],
      ['.claude-plugin/marketplace.plugins[0]', claudeMarket.data.plugins && claudeMarket.data.plugins[0] && claudeMarket.data.plugins[0].version],
      ['.codex-plugin/plugin.json', codexPlugin.data.version],
    ];
    const mismatch = others.filter(([, v]) => v !== pv).map(([k, v]) => `${k}=${v}`);
    add('versions aligned', mismatch.length === 0, mismatch.length ? `package=${pv} but ${mismatch.join(', ')}` : `all ${pv}`);
  }

  if (codexPlugin.ok) {
    const iface = codexPlugin.data.interface || {};
    const required = ['displayName', 'shortDescription', 'longDescription', 'developerName', 'category'];
    const missing = required.filter((field) => !iface[field]);
    add('Codex manifest required interface fields exist', missing.length === 0, missing.join(', '));
    add('Codex manifest points at skills', codexPlugin.data.skills === './skills/');
  }

  if (codexPlugin.ok && codexMarket.ok) {
    const plugins = Array.isArray(codexMarket.data.plugins) ? codexMarket.data.plugins : [];
    const entry = plugins.find((p) => p && p.name === codexPlugin.data.name);
    add('Codex marketplace entry exists', Boolean(entry), codexPlugin.data.name);
    if (entry) {
      const sourceOk = entry.source && entry.source.source === 'local' && entry.source.path === './';
      const policyOk = entry.policy && entry.policy.installation === 'AVAILABLE' && entry.policy.authentication === 'ON_INSTALL';
      add('Codex marketplace source is local repo root', sourceOk);
      add('Codex marketplace policy is installable', policyOk);
    }
  }

  for (const d of ['.agents', '.claude-plugin', '.codex-plugin', 'skills', 'agents', 'hooks', 'bin', 'src']) {
    const p = path.join(root, d);
    add(`dir ${d}/ exists`, fs.existsSync(p) && fs.statSync(p).isDirectory());
  }

  const hooks = readJsonFile('hooks/hooks.json');
  add('hooks/hooks.json parses', hooks.ok, hooks.ok ? '' : hooks.error);

  add('bin/ratchet exists', fs.existsSync(path.join(root, 'bin', 'ratchet')));
  add('bin/ratchet-evolve exists', fs.existsSync(path.join(root, 'bin', 'ratchet-evolve')));

  const skillProblems = [];
  try {
    for (const name of fs.readdirSync(path.join(root, 'skills'))) {
      const skillMd = path.join(root, 'skills', name, 'SKILL.md');
      if (!fs.existsSync(skillMd)) {
        skillProblems.push(`${name}: no SKILL.md`);
        continue;
      }
      const fm = frontmatter(fs.readFileSync(skillMd, 'utf8'));
      if (!fm) skillProblems.push(`${name}: no frontmatter`);
      else if (!/(^|\n)description:/.test(fm)) skillProblems.push(`${name}: no description`);
    }
  } catch (e) {
    skillProblems.push(e.message);
  }
  add('every skills/*/SKILL.md has frontmatter + description', skillProblems.length === 0, skillProblems.join('; '));

  let stateDetail = '';
  let stateOk = true;
  try {
    state.initProject(cwd);
    stateDetail = state.projectDir(cwd);
  } catch (e) {
    stateOk = false;
    stateDetail = e.message;
  }
  add('state dir writable', stateOk, stateDetail);

  let snapOk = true;
  let snapDetail = '';
  try {
    const snap = repo.snapshot(cwd);
    snapDetail = `${snap.fileCount} files`;
  } catch (e) {
    snapOk = false;
    snapDetail = e.message;
  }
  add('repo snapshot works', snapOk, snapDetail);

  const failed = checks.filter((c) => !c.ok);
  if (asJson) {
    out(JSON.stringify({ ok: failed.length === 0, checks }, null, 2));
  } else {
    out('ratchet doctor');
    out('');
    for (const c of checks) out(`  ${c.ok ? 'ok  ' : 'FAIL'} ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
    out('');
    out(failed.length === 0 ? 'healthy — plugin shape looks good.' : `${failed.length} problem(s) found.`);
  }
  if (failed.length) process.exitCode = 1;
}

// Cold-start poison scan: does the current state / operator surfaces steer the
// next session into the wrong world? Generic ratchet-state checks always run;
// project surfaces are opt-in via .ratchet/cold-start.json. FAIL = contradiction.
function cmdColdStart(cwd, asJson) {
  const result = coldStart.scan(cwd);
  if (asJson) {
    out(JSON.stringify(result, null, 2));
  } else {
    out('ratchet doctor cold-start');
    out('');
    for (const c of result.checks) {
      const tag = c.level === 'ok' ? 'ok  ' : c.level === 'warn' ? 'warn' : 'FAIL';
      out(`  ${tag} ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
    }
    out('');
    const fails = result.checks.filter((c) => c.level === 'fail').length;
    const warns = result.checks.filter((c) => c.level === 'warn').length;
    if (fails) out(`${fails} contradiction(s), ${warns} warning(s) — cold-start surfaces may steer the next session wrong.`);
    else if (warns) out(`no contradictions, ${warns} warning(s).`);
    else out('clean — no stale steering detected.');
    if (!result.configured) out('(generic checks only — add .ratchet/cold-start.json to scan project surfaces)');
  }
  if (!result.ok) process.exitCode = 1;
}

function help() {
  out(
    [
      `ratchet ${VERSION} — consequence-engine state tooling`,
      '',
      'RESUME',
      '  ratchet receipt [--json] [--save] one stable cockpit: target·delta·proof·verdict·risk·authority·state·next',
      '                                    --save writes .ratchet/current.json + .md (the source-of-truth index)',
      '',
      'STATE',
      '  ratchet init                        create the project data dir',
      '  ratchet init --force --owner "<n>" --reason "<r>"',
      '                                     RE-init: the same irreversible wipe as state reset --force',
      '  ratchet status [--json]            render current state',
      '  ratchet state get [key] [--json]   read state (or one key)',
      '  ratchet state set <key> <value>    set objective|title|bottleneck|phase|nextAction|nextCommand|...',
      '  ratchet state append <coll> <json> append to decisions|assumptions|openLoops|touchedFiles|history',
      '  ratchet state close openLoops <id> --evidence "<what closed it>"',
      '                                     or --park --owner "<n>" --revisit-trigger "<t>" (parked still drains)',
      '  ratchet state close assumptions <id> --outcome tested|killed --evidence "<result>"',
      '  ratchet compile done               CHECKPOINT the session (clear dirty, stamp lastCompileAt) — not closure',
      '  ratchet state reset --force --owner "<n>" --reason "<r>"   wipe session state (irreversible)',
      '',
      'ARTIFACTS & DEFECTS',
      '  ratchet artifact add <json>        record an artifact ({title,kind,status,path,holes}); an existing id revises it',
      '  ratchet artifact close <id> [--waive-holes --owner "<n>" --reason "<r>"]',
      '                                     CLOSE it — needs a KEEP bound to this exact revision (no proof → no close)',
      '  ratchet defect add <json>          record a defect ({severity,summary,feature}) — also hits ledger',
      '  ratchet defect list [--json]       list defects (○ draining / ● terminal)',
      '  ratchet defect get <id> [--json]   show one defect + its lifecycle log',
      '  ratchet defect resolve <id> --evidence "<proof>"            mark fixed (proof required)',
      '  ratchet defect reopen <id> --reason "<why>"                 a resolved defect regressed',
      '  ratchet defect waive <id> --owner "<name>" --reason "<why>" accept the risk, stop the drain',
      '  ratchet defect supersede <id> --by <artifact-id>            replaced by newer work',
      '  ratchet retract <id> --reason "<why>" [--superseded-by <id>] retract a false/obsolete artifact',
      '',
      'LEDGER (QA canonical record)',
      '  ratchet ledger create              ensure ledger exists',
      '  ratchet ledger update <coll> <json> upsert features|tests|defects',
      '  ratchet ledger get [--json]        ledger summary',
      '',
      'SCORING',
      '  ratchet score friction <json>      rank obstacles ([{name,leverage,certainty,speed,risk}])',
      '  ratchet score confidence           three scoped layers: artifact · session · ledger health',
      '  ratchet score aperture <json>      meter loop depth from uncertainty ({ambiguity,terrain,taste,blastRadius,reversibility} 0-2)',
      '',
      'CONTEXT',
      '  ratchet snapshot repo [path]       cheap repo read (files, dirs, git)',
      '  ratchet git status-refs [--json]   ahead/behind vs every base ref, each named',
      '  ratchet export markdown            full session compile',
      '  ratchet export json                raw state',
      '',
      'PLUGIN HEALTH',
      '  ratchet doctor [--json]            check plugin shape, version alignment, state dir',
      '  ratchet doctor cold-start [--json] scan for stale steering (opt-in surfaces via .ratchet/cold-start.json)',
      '',
      'json args accept a raw string, @file, or - for stdin.',
      '',
      'AGENT MEMORY (isolation by role)',
      '  RATCHET_AGENT=<name>  identify the driving agent. Only the scribe writes canonical',
      '                        state; builder/auditor are propose-only — mutating verbs are',
      '                        refused so they emit the command instead of clobbering the record.',
    ].join('\n')
  );
}

module.exports = { run, VERSION };
