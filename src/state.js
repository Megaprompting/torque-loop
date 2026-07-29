'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { isDeepStrictEqual } = require('util');

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

// Recovering the true casing must NOT follow aliases. realpath dereferences:
// `C:\Users\All Users` comes back as `C:\ProgramData`, so a session run through
// a junction silently adopts the target's store — and the alias-keyed store it
// used to write is never migrated or conflict-detected, because nothing computes
// its slug again. readdir returns the junction's OWN name, so walking segment by
// segment corrects the casing while leaving the alias its own identity.
//
// A segment whose parent is unreadable, or that does not exist yet, keeps its
// lexical spelling — a store dir is often computed before the project exists.
const _caseCache = new Map();

function caseExactPath(cwd) {
  const lexical = path.resolve(cwd || process.cwd());
  if (process.platform !== 'win32') return lexical;
  const cached = _caseCache.get(lexical);
  if (cached) return cached;

  const parsed = path.parse(lexical);
  // Drive letters are case-insensitive and readdir cannot report their casing,
  // so canonicalize them; otherwise `c:\x` and `C:\x` fork into two stores.
  let current = parsed.root.toUpperCase();
  for (const seg of lexical.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    let actual = seg;
    try {
      const lower = seg.toLowerCase();
      const match = fs.readdirSync(current).find((e) => e.toLowerCase() === lower);
      if (match) actual = match;
    } catch (_e) {
      /* unreadable or missing parent — keep the lexical spelling */
    }
    current = path.join(current, actual);
  }
  // The hook path calls this on every invocation; the walk is one readdir per
  // segment, so memoize it. A CLI process is short-lived enough that a rename
  // mid-run is not a case worth invalidating for.
  _caseCache.set(lexical, current);
  return current;
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

// Serialize somewhere else, then swap. An in-place write is a window in which
// the canonical record is neither the old value nor the new one, and a death
// inside that window (ENOSPC, SIGKILL, power loss) leaves an unparseable file
// where the only copy of the record used to be. A rename WITHIN one directory
// is the closest thing every supported filesystem has to a single-instant swap
// — including Windows, where fs.renameSync replaces an existing destination.
function writeFileAtomic(file, data) {
  ensureDir(path.dirname(file));
  // 'wx' so the temp name is never an existing file, and the pid keeps two
  // processes committing at the same instant off each other's scratch space.
  const tmp = `${file}.tmp-${process.pid.toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
  let fd;
  try {
    fd = fs.openSync(tmp, 'wx');
    fs.writeFileSync(fd, data, 'utf8');
    // Atomicity is not durability: without the flush the rename can reach the
    // disk ahead of the bytes, and a power cut then swaps in an empty record.
    try {
      fs.fsyncSync(fd);
    } catch (_e) {
      /* fsync is unsupported on some filesystems — the rename still swaps */
    }
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tmp, file);
  } catch (e) {
    // A half-written temp file is residue, not a record. Name it, then drop it.
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch (_e) {
        /* already closed */
      }
    }
    try {
      fs.rmSync(tmp, { force: true });
    } catch (_e) {
      /* the .tmp- name says what it is if it survives */
    }
    throw e;
  }
}

function writeJson(file, obj) {
  writeFileAtomic(file, JSON.stringify(obj, null, 2) + '\n');
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
// Agent memory isolation (propose-only). Registered agents get isolated memory
// by ROLE: only the scribe writes canonical state. A builder or auditor is a
// propose-only agent — it emits the mutation for the caller (or the scribe) to
// run, and its own process is refused write access, so two agents can never
// clobber each other's record. Identity comes from RATCHET_AGENT; the writer set
// is the scribe (and the unset/main caller). It lives HERE, at the mutation
// boundary, rather than in the CLI router: a guard that only one caller performs
// is a convention, and 0.9 gave every public mutation one door to come through.
// ---------------------------------------------------------------------------

const WRITER_AGENTS = new Set(['scribe']);

// Returns the propose-only agent name if one is active, else ''. The main caller
// (RATCHET_AGENT unset) and the scribe both return '' — they may write.
function proposeOnlyAgent() {
  const a = (process.env.RATCHET_AGENT || '').trim().toLowerCase();
  return a && !WRITER_AGENTS.has(a) ? a : '';
}

// Throw before any canonical-state mutation if a propose-only agent is driving.
// The message tells the agent what to do instead — emit the command, don't run it.
function assertMayWrite(action) {
  const a = proposeOnlyAgent();
  if (a) {
    throw new Error(
      `agent "${a}" has propose-only memory and may not mutate canonical state (${action}). ` +
        'Emit the exact command for the caller or the ratchet-scribe to run instead. ' +
        '(Only the scribe writes canonical state; unset RATCHET_AGENT for the main caller, or set it to scribe.)'
    );
  }
}

// ---------------------------------------------------------------------------
// The lock. No lock → no write.
//
// mkdir is the one create-or-fail primitive every supported filesystem agrees
// is atomic, so the lock IS a directory and the owner card lives inside it.
// Zero dependencies, cross-process, and visible to a human with `ls`.
// ---------------------------------------------------------------------------

const LOCK_DIR_NAME = '.lock';

function envMs(name, dflt) {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? raw : dflt;
}

// Node has no synchronous sleep and this whole write path is synchronous, so
// block the thread the one portable way: a timed wait nobody ever notifies.
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// EPERM means the pid exists and belongs to someone else — alive, not stale.
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return Boolean(e && e.code === 'EPERM');
  }
}

function lockOwner(lockDir) {
  const card = readJson(path.join(lockDir, 'owner.json'));
  let at = card ? Date.parse(card.at) : NaN;
  if (!Number.isFinite(at)) {
    // No card, or an unreadable one: either a lock caught mid-acquisition or one
    // made by hand. Age it by the directory rather than assuming the worst —
    // assuming stale here is exactly how a live writer gets its lock stolen.
    try {
      at = fs.statSync(lockDir).mtimeMs;
    } catch (_e) {
      at = Date.now();
    }
  }
  return {
    pid: card ? Number(card.pid) : NaN,
    host: card ? String(card.host || '') : '',
    action: (card && card.action) || 'unknown',
    ageMs: Math.max(0, Date.now() - at),
  };
}

// Stale recovery weighs AGE and LIVENESS together, never liveness alone: pids
// are recycled, so process.kill(pid, 0) on a long-dead owner can answer "alive"
// about a stranger's process — and on another host it answers about the wrong
// machine entirely. Under SOFT the lock is never broken (a slow writer is not a
// dead one); past SOFT a provably dead owner on THIS host loses it; past HARD
// nobody keeps a workspace lock, alive, wedged, or impersonated.
function breakIfStale(lockDir) {
  const soft = envMs('RATCHET_LOCK_STALE_MS', 5000);
  const hard = envMs('RATCHET_LOCK_HARD_STALE_MS', 120000);
  const owner = lockOwner(lockDir);
  const provablyDead = owner.host === os.hostname() && !pidAlive(owner.pid);
  if (owner.ageMs < soft) return false;
  if (!provablyDead && owner.ageMs < hard) return false;
  // Two waiters can reach this verdict in the same instant. Rename is atomic and
  // only one of them can win it, so exactly one process ever breaks a given
  // lock — and the loser retries against a directory that is already gone.
  const doomed = `${lockDir}.stale-${crypto.randomBytes(4).toString('hex')}`;
  try {
    fs.renameSync(lockDir, doomed);
  } catch (_e) {
    return false; // somebody else won the break, or the owner released it first
  }
  removeDirSync(doomed);
  process.stderr.write(
    `[ratchet] broke a stale lock at ${lockDir} — owner pid ${owner.pid} (${owner.action}), ${Math.round(owner.ageMs / 1000)}s old.\n`
  );
  return true;
}

// Windows answers EBUSY/EPERM for a directory whose handles the OS has not
// finished releasing. A lock we fail to remove is a lock nobody else can take,
// so retry briefly before giving up.
function removeDirSync(dir) {
  for (let i = 0; i < 5; i++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return true;
    } catch (_e) {
      sleepSync(10);
    }
  }
  return false;
}

function acquireLock(lockDir, action) {
  ensureDir(path.dirname(lockDir));
  const deadline = Date.now() + envMs('RATCHET_LOCK_TIMEOUT_MS', 15000);
  let wait = 2;
  for (;;) {
    let held = false;
    try {
      fs.mkdirSync(lockDir);
      held = true;
    } catch (e) {
      if (!e || e.code !== 'EEXIST') throw e;
    }
    if (held) {
      try {
        // Real wall clock, never schemas.nowIso: RATCHET_NOW is a frozen record
        // clock, and a lock stamped with a frozen time is born stale.
        fs.writeFileSync(
          path.join(lockDir, 'owner.json'),
          JSON.stringify({ pid: process.pid, host: os.hostname(), at: new Date().toISOString(), action: action || 'mutation' }),
          'utf8'
        );
      } catch (e) {
        removeDirSync(lockDir); // never hold a lock nobody can identify or age
        throw e;
      }
      return lockDir;
    }
    if (breakIfStale(lockDir)) continue;
    if (Date.now() >= deadline) {
      const owner = lockOwner(lockDir);
      const e = new Error(
        `could not acquire the ratchet lock at ${lockDir} — held by pid ${owner.pid} (${owner.action}) for ` +
          `${Math.round(owner.ageMs / 1000)}s. Wait for that command to finish, or delete the directory if the process is gone.`
      );
      e.code = 'ERATCHETLOCK';
      throw e;
    }
    sleepSync(wait);
    wait = Math.min(wait * 2, 50);
  }
}

function releaseLock(lockDir) {
  if (lockDir) removeDirSync(lockDir);
}

// At most ONE lock scope is open per process, and it is remembered here. The
// lock is not recursive at the filesystem level, so a nested acquire would wait
// on a lock this very process holds: a silent self-deadlock. Nested callers with
// the same scope JOIN the open one instead — helpers never lock.
let _scope = null;

// Lock a store directory for the duration of fn. Use this for a public command
// whose write is not a state.json revision (ledger upserts, the init/reset wipe)
// — everything that revises state goes through withWorkspaceMutation below.
function withWorkspaceLock(cwd, action, fn) {
  const dir = projectDir(cwd);
  if (_scope) {
    if (_scope.dir === dir) return fn();
    throw new Error(
      `refusing to lock ${dir} while ${_scope.dir} is open (${_scope.action}) — one process holds one workspace at a time.`
    );
  }
  const lockDir = acquireLock(path.join(dir, LOCK_DIR_NAME), action);
  _scope = { dir, action, state: null };
  try {
    return fn();
  } finally {
    _scope = null;
    releaseLock(lockDir);
  }
}

// A generic lock for a file that is NOT in the workspace store — the evolution
// journal, whose path is caller-selectable (RATCHET_EVOLVE_LOG) and therefore
// cannot borrow the workspace's lock without making unrelated writers queue
// behind each other in both directions.
function withFileLock(file, action, fn) {
  const lockDir = acquireLock(`${file}${LOCK_DIR_NAME}`, action);
  try {
    return fn();
  } finally {
    releaseLock(lockDir);
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

// What each loaded snapshot was read FROM. A save that names no expected
// revision still has to know what its caller CHANGED, and the only honest
// answer is the bytes that caller actually read. WeakMap, so a dropped snapshot
// is not a leak.
const _base = new WeakMap();

function clone(o) {
  return JSON.parse(JSON.stringify(o));
}

// Lazy migration: a pre-0.8 file has no rev, so it counts as 0 and starts
// counting on its next write. Nothing rewrites it just to add the field.
function revOf(s) {
  return s && Number.isInteger(s.rev) ? s.rev : 0;
}

function loadState(cwd) {
  // Inside an open transaction there is exactly one live state object, and it
  // is the one the boundary reloaded under the lock. Handing a helper a second
  // copy read from disk is how a command loses half of its own mutation.
  if (_scope && _scope.state && _scope.dir === projectDir(cwd)) return _scope.state;
  const existing = readJsonResilient(statePath(cwd));
  if (existing) {
    _base.set(existing, clone(existing));
    return existing;
  }
  // Auto-init on first read so skills never hit a missing file. A corrupt file
  // has already been backed up by readJsonResilient before we overwrite it.
  const fresh = schemas.newState();
  writeJson(statePath(cwd), fresh);
  _base.set(fresh, clone(fresh));
  return fresh;
}

function commitState(cwd, state, baseRev) {
  state.updatedAt = schemas.nowIso();
  state.rev = baseRev + 1;
  writeJson(statePath(cwd), state);
  // The caller may save the same object again; its base has to move with it or
  // the second save would rebase against a revision that is two writes old.
  _base.set(state, clone(state));
  return state;
}

// Merge a delta computed against `base` onto whatever is on disk now. A caller
// who supplied no expectedStateRev never claimed exclusivity, so its change is
// REBASED onto the writes that landed while it was thinking rather than
// overwriting them. Arrays merge element-wise because every collection in the
// state schema is an append-mostly log; a scalar only moves where the caller
// actually moved it.
function mergeValue(base, mine, theirs) {
  if (isDeepStrictEqual(mine, theirs)) return theirs;
  if (isDeepStrictEqual(mine, base)) return theirs; // I changed nothing here
  if (isDeepStrictEqual(theirs, base)) return mine; // they changed nothing here
  if (Array.isArray(mine) && Array.isArray(theirs)) return mergeArray(Array.isArray(base) ? base : [], mine, theirs);
  if (isPlainObject(mine) && isPlainObject(theirs)) return mergeObject(isPlainObject(base) ? base : {}, mine, theirs);
  // Two edits to one scalar. The writer holding the lock is the later one, and a
  // last-writer-wins scalar is the one conflict this merge cannot resolve.
  return mine;
}

function isPlainObject(v) {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

// Identity for merge purposes: the record id when there is one, else the value
// itself. The occurrence counter keeps two byte-identical entries (two touches
// of the same file in the same millisecond) from collapsing into one.
function keyOf(item, seen) {
  const base = isPlainObject(item) && item.id != null ? `id:${item.id}` : `v:${JSON.stringify(item)}`;
  const n = (seen.get(base) || 0) + 1;
  seen.set(base, n);
  return `${base}#${n}`;
}

function indexBy(list) {
  const seen = new Map();
  const index = new Map();
  list.forEach((item) => index.set(keyOf(item, seen), item));
  return index;
}

function mergeArray(base, mine, theirs) {
  const baseIdx = indexBy(base);
  const mineIdx = indexBy(mine);
  const out = [];
  const takenFromMine = new Set();
  // Their order is the committed order and stays authoritative.
  for (const [key, item] of indexBy(theirs)) {
    if (mineIdx.has(key)) {
      takenFromMine.add(key);
      out.push(mergeValue(baseIdx.get(key), mineIdx.get(key), item));
    } else if (!baseIdx.has(key)) {
      out.push(item); // they appended it
    } else {
      out.push(item); // I dropped it; a concurrent delete is not a mutation this
      // schema has a verb for, so the surviving record wins.
    }
  }
  // Then whatever I appended, in the order I appended it.
  for (const [key, item] of mineIdx) {
    if (!takenFromMine.has(key) && !baseIdx.has(key)) out.push(item);
  }
  return out;
}

function mergeObject(base, mine, theirs) {
  const out = {};
  for (const k of Object.keys(theirs)) {
    if (!Object.prototype.hasOwnProperty.call(mine, k)) {
      // I removed a key they still have — only honor it if I am the one who
      // changed it (they left it exactly as the base had it).
      if (Object.prototype.hasOwnProperty.call(base, k) && isDeepStrictEqual(base[k], theirs[k])) continue;
      out[k] = theirs[k];
      continue;
    }
    const merged = mergeValue(base[k], mine[k], theirs[k]);
    if (merged !== undefined) out[k] = merged;
  }
  for (const k of Object.keys(mine)) {
    if (!Object.prototype.hasOwnProperty.call(out, k) && !Object.prototype.hasOwnProperty.call(theirs, k)) out[k] = mine[k];
  }
  return out;
}

// The low-level write. It is no longer "put these bytes there": it takes the
// lock, re-reads what is actually on disk, and rebases the caller's snapshot
// onto it, so two processes that loaded the same revision both keep their work.
// Callers that want a REFUSAL instead of a rebase name their revision through
// withWorkspaceMutation.
function saveState(cwd, state) {
  const dir = projectDir(cwd);
  if (_scope && _scope.dir === dir) {
    if (_scope.state) {
      // Deferred: one public mutation is one revision, so a command that saves
      // three times on its way through still commits exactly once.
      if (state !== _scope.state) Object.assign(_scope.state, state);
      return _scope.state;
    }
    return rebaseAndCommit(cwd, state); // a lock scope is already open — do not re-take it
  }
  return withWorkspaceLock(cwd, 'saveState', () => rebaseAndCommit(cwd, state));
}

function rebaseAndCommit(cwd, state) {
  const disk = readJsonResilient(statePath(cwd));
  const base = _base.get(state);
  // No disk record, or a snapshot this process never loaded (so there is no
  // delta to compute): the caller's object IS the record. Named, not hidden —
  // an unloaded object cannot be rebased, only written.
  if (!disk || !base || revOf(disk) === revOf(base)) return commitState(cwd, state, revOf(disk || state));
  const merged = mergeObject(base, state, disk);
  return commitState(cwd, Object.assign(state, merged), revOf(disk));
}

// THE transaction boundary. One public mutation = acquire the lock → reload the
// state under it → compare the revision the caller believes it is editing →
// apply → commit exactly one revision → release, on every path.
//
// A mismatch is REFUSED, not merged: a caller that names a revision is claiming
// it read that exact record, and silently rebasing its decision onto a record it
// never saw is how a stale agent's conclusion gets written as if it were fresh.
// A refusal moves zero bytes, zero revisions, zero history.
function withWorkspaceMutation(cwd, opts, mutate) {
  const o = opts || {};
  const action = o.action || 'mutation';
  if (_scope) {
    throw new Error(
      `nested workspace mutation refused: "${action}" inside "${_scope.action}" — one public command is one ` +
        'transaction, and helpers mutate the open transaction instead of opening their own.'
    );
  }
  assertMayWrite(action);
  if (o.expectedStateRev != null && !Number.isInteger(o.expectedStateRev)) {
    throw new Error(`expectedStateRev must be an integer revision (got ${JSON.stringify(o.expectedStateRev)})`);
  }
  const dir = projectDir(cwd);
  const lockDir = acquireLock(path.join(dir, LOCK_DIR_NAME), action);
  _scope = { dir, action, state: null };
  try {
    const s = loadState(cwd);
    const baseRev = revOf(s);
    if (o.expectedStateRev != null && o.expectedStateRev !== baseRev) {
      const e = new Error(
        `refused a stale write (${action}): expected rev ${o.expectedStateRev}, the workspace is at rev ${baseRev}. ` +
          'Reload the state and re-apply the change against what is actually recorded.'
      );
      e.code = 'ERATCHETSTALE';
      e.expectedStateRev = o.expectedStateRev;
      e.actualStateRev = baseRev;
      throw e;
    }
    const before = JSON.stringify(s);
    _scope.state = s;
    const result = mutate(s);
    _scope.state = null;
    // An idempotent re-run costs nothing: no revision, no timestamp churn, no
    // write at all. Comparing the serialized record is what makes that a
    // property of the boundary rather than a convention each verb remembers.
    if (JSON.stringify(s) === before) return { committed: false, rev: baseRev, state: s, result };
    commitState(cwd, s, baseRev);
    return { committed: true, rev: s.rev, state: s, result };
  } finally {
    _scope = null;
    releaseLock(lockDir);
  }
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
  writeFileAtomic,
  initProject,
  loadState,
  saveState,
  withWorkspaceLock,
  withWorkspaceMutation,
  withFileLock,
  loadLedger,
  saveLedger,
  makeId,
  proposeOnlyAgent,
  assertMayWrite,
};
