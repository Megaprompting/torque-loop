'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const schemas = require('./schemas');

// ---------------------------------------------------------------------------
// Location. State survives plugin updates when CLAUDE_PLUGIN_DATA is set.
// Everything is scoped per-project so multiple repos never collide in one
// shared plugin data directory.
// ---------------------------------------------------------------------------

function baseDir() {
  const explicit = process.env.RATCHET_DATA_DIR || process.env.CLAUDE_PLUGIN_DATA;
  if (explicit && explicit.trim()) return explicit.trim();
  const home = process.env.HOME || process.env.USERPROFILE || os.homedir();
  return path.join(home, '.ratchet');
}

function slugFor(root, lowercase) {
  const name = path
    .basename(root)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'project';
  const resolved = path.resolve(root);
  const hash = crypto
    .createHash('sha1')
    .update(lowercase ? resolved.toLowerCase() : resolved)
    .digest('hex')
    .slice(0, 8);
  return `${name}-${hash}`;
}

// The one authority on how this path is really spelled. A caller may type
// `d:\repo` for a directory stored as `D:\Repo`, and on Windows both open it —
// so the caller's casing is not evidence of anything. realpathSync.native asks
// the filesystem, which knows. Falls back to the plain resolve when the path
// does not exist yet or native is unavailable.
function caseExactPath(cwd) {
  const root = path.resolve(cwd || process.cwd());
  try {
    if (typeof fs.realpathSync.native === 'function') return fs.realpathSync.native(root);
  } catch (_e) {
    /* not on disk yet, or no native impl — fall through */
  }
  try {
    return fs.realpathSync(root);
  } catch (_e) {
    return root;
  }
}

// The slug a pre-0.8 store was created under: hashed from the path's TRUE
// casing, not the caller's. Deriving it from the caller meant a caller who
// happened to type lowercase produced legacy === normalized, the migration
// check short-circuited, and the real mixed-case store was stranded behind a
// fresh empty one — forever, because the trigger depended on a casing the
// caller no longer supplied.
function legacySlugFor(cwd) {
  return slugFor(caseExactPath(cwd), false);
}

function normalizedSlugFor(cwd) {
  if (process.platform !== 'win32') return slugFor(cwd || process.cwd(), false);
  return slugFor(caseExactPath(cwd), true);
}

// Windows paths are case-insensitive, so `D:\Repo` and `d:\repo` are one
// project — but hashing the raw casing gave them two separate stores, and a
// session that spelled the cwd differently silently resumed from an empty one.
// Normalize by lowercasing before the hash.
//
// A store created under the old casing is MIGRATED, once, by moving it to the
// normalized slug. Merely reading it in place would require this discovery to
// succeed on every future call, and it does not: spell the cwd in its already-
// lowercase form and `normalized === legacy`, the discovery never runs, and the
// old store is stranded while a fresh empty one opens beside it.
function projectSlug(cwd) {
  const root = cwd || process.cwd();
  if (process.platform !== 'win32') return slugFor(root, false);
  // Both slugs come from the on-disk casing, so the answer no longer depends on
  // how the caller spelled the path. When the true path is already all-lowercase
  // the two coincide and there is genuinely nothing to migrate.
  const normalized = normalizedSlugFor(root);
  const legacy = legacySlugFor(root);
  if (normalized === legacy) return normalized;

  const projects = path.join(baseDir(), 'projects');
  const legacyDir = path.join(projects, legacy);
  const normalizedDir = path.join(projects, normalized);
  if (!fs.existsSync(legacyDir)) return normalized;

  // Both exist: two records for one project. Merging is not ours to invent and
  // picking one silently loses the other, so name both and stop.
  if (fs.existsSync(normalizedDir)) {
    throw new Error(
      `ratchet store conflict — both of these exist for one project:\n  ${legacyDir} (legacy casing)\n  ${normalizedDir} (normalized)\n` +
        'Merge or delete one by hand — refusing to guess which record is the real one.'
    );
  }
  fs.renameSync(legacyDir, normalizedDir);
  process.stderr.write(`[ratchet] migrated store ${legacy} → ${normalized} (Windows path casing normalized).\n`);
  return normalized;
}

function projectDir(cwd) {
  return path.join(baseDir(), 'projects', projectSlug(cwd));
}

function statePath(cwd) {
  return path.join(projectDir(cwd), 'state.json');
}

function ledgerPath(cwd) {
  return path.join(projectDir(cwd), 'ledger.json');
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

// ---------------------------------------------------------------------------
// Read / write JSON safely.
// ---------------------------------------------------------------------------

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_e) {
    return null;
  }
}

function writeJson(file, obj) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

// Preserve, never silently lose. A tool whose promise is persistent state must
// not throw away a malformed file — a bad write or a manual edit could corrupt
// it. Missing/empty → fresh (quiet). Malformed → copy the bad bytes to
// <file>.corrupt.<timestamp>.json, warn, then let the caller reinitialize.
function backupCorrupt(file, raw) {
  try {
    // The stamp comes from nowIso, which reads RATCHET_NOW — caller-controlled
    // text landing in a filename. Allowlist it to [0-9A-Za-z-] so no separator,
    // drive letter, or traversal can steer where the backup is written.
    const stamp = String(schemas.nowIso()).replace(/[^0-9A-Za-z]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'unstamped';
    const dest = `${file}.corrupt.${stamp}.json`;
    fs.writeFileSync(dest, raw, 'utf8');
    process.stderr.write(
      `[ratchet] ${path.basename(file)} was malformed — backed up to ${path.basename(dest)} and reinitialized.\n`
    );
    return dest;
  } catch (_e) {
    return null; // the caller decides; a failed backup must not become a delete
  }
}

function readJsonResilient(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    // ENOENT is the only error that means "there is no record yet". Anything
    // else — an ACL that denies read but permits write, a lock, EIO — means the
    // record EXISTS and cannot be seen, and returning null tells the caller to
    // reinitialize straight over it.
    if (e && e.code === 'ENOENT') return null;
    throw new Error(
      `${path.basename(file)} exists but could not be read (${e && e.code ? e.code : 'unknown error'}) — ` +
        'refusing to reinitialize over a record that is present but unreadable. Fix access, then re-run.'
    );
  }
  if (!raw.trim()) return null; // empty file → fresh, no noisy backup
  try {
    return JSON.parse(raw);
  } catch (_e) {
    // Returning null tells the caller to reinitialize, which overwrites this
    // file. Only say that once the bad bytes are safely copied: if the backup
    // failed, the corrupt file is the ONLY copy of the record and clobbering it
    // is a silent data loss the tool's whole promise forbids.
    if (!backupCorrupt(file, raw)) {
      throw new Error(
        `${path.basename(file)} is malformed and could not be backed up — refusing to reinitialize over the only copy. ` +
          'Move or repair the file by hand, then re-run.'
      );
    }
    return null;
  }
}

// ---------------------------------------------------------------------------
// State lifecycle.
// ---------------------------------------------------------------------------

function initProject(cwd, { force = false, resetBy = '', resetReason = '' } = {}) {
  ensureDir(projectDir(cwd));
  const sPath = statePath(cwd);
  const lPath = ledgerPath(cwd);
  let created = false;
  if (force || !fs.existsSync(sPath)) {
    const fresh = schemas.newState();
    // A wipe destroys the only record of why the wipe happened. The tombstone is
    // the one line that survives it, so the next cold session reads "danny reset
    // this on 2026-07-29 to start a new run" instead of an unexplained blank.
    if (resetBy || resetReason) {
      fresh.history.push({
        id: makeId('hist'),
        at: fresh.createdAt,
        event: 'state.reset',
        note: `state wiped by ${resetBy || 'unnamed'} — ${resetReason || 'no reason recorded'}`,
      });
    }
    writeJson(sPath, fresh);
    created = true;
  }
  if (force || !fs.existsSync(lPath)) {
    writeJson(lPath, schemas.newLedger());
  }
  return { dir: projectDir(cwd), created, statePath: sPath, ledgerPath: lPath };
}

function loadState(cwd) {
  const existing = readJsonResilient(statePath(cwd));
  if (existing) return existing;
  // Auto-init on first read so skills never hit a missing file. A corrupt file
  // has already been backed up by readJsonResilient before we overwrite it.
  const fresh = schemas.newState();
  writeJson(statePath(cwd), fresh);
  return fresh;
}

function saveState(cwd, state) {
  state.updatedAt = schemas.nowIso();
  // Lazy migration: a pre-0.8 file has no rev, so it counts as 0 and starts
  // counting on its next write. Nothing rewrites it just to add the field.
  state.rev = (Number.isInteger(state.rev) ? state.rev : 0) + 1;
  writeJson(statePath(cwd), state);
  return state;
}

function loadLedger(cwd) {
  const existing = readJsonResilient(ledgerPath(cwd));
  if (existing) return existing;
  const fresh = schemas.newLedger();
  writeJson(ledgerPath(cwd), fresh);
  return fresh;
}

function saveLedger(cwd, ledger) {
  ledger.updatedAt = schemas.nowIso();
  writeJson(ledgerPath(cwd), ledger);
  return ledger;
}

// Short, sortable, collision-resistant id: <prefix>-<time36>-<rand>
let _counter = 0;
function makeId(prefix) {
  _counter = (_counter + 1) % 1000;
  const t = Date.now().toString(36);
  const c = _counter.toString(36).padStart(2, '0');
  return `${prefix || 'id'}-${t}${c}`;
}

module.exports = {
  baseDir,
  projectSlug,
  normalizedSlugFor,
  legacySlugFor,
  projectDir,
  statePath,
  ledgerPath,
  ensureDir,
  readJson,
  writeJson,
  initProject,
  loadState,
  saveState,
  loadLedger,
  saveLedger,
  makeId,
};
