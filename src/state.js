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
    const e = new Error(
      `ratchet store conflict — both of these exist for one project:\n  ${legacyDir} (legacy casing)\n  ${normalizedDir} (normalized)\n` +
        'Merge or delete one by hand — refusing to guess which record is the real one.'
    );
    // Coded, because a caller that must not echo server paths (the MCP boundary)
    // cannot pass this message through and has nothing else to tell a conflict
    // apart from "the store would not open" — which sends the operator hunting.
    e.code = 'ERATCHETSTORECONFLICT';
    throw e;
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
// `beforePublish` runs in the instant between "the new bytes are on disk" and
// "the new bytes ARE the record" — the last point at which a publish can still be
// called off. Every canonical publish passes an ownership check here, because a
// check any earlier leaves the whole write-flush-close window unguarded: a
// successor that appeared in there was invisible and the rename published anyway.
function writeFileAtomic(file, data, beforePublish) {
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
    if (beforePublish) beforePublish();
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

// EVERY publish through writeJson is fenced by default. Threading the check
// through each call site would mean every future publisher has to remember it,
// and three of them (the wipe, the corrupt-record repair, the ledger) had already
// forgotten. The guard is defined further down — hoisting is fine, it only runs at
// publish time — and it is a no-op unless a lock scope covers this file.
function writeJson(file, obj, beforePublish) {
  writeFileAtomic(file, JSON.stringify(obj, null, 2) + '\n', beforePublish || (() => fenceForFile(file)));
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
    const parsed = JSON.parse(raw);
    // `null`, `false`, `0`, `""` and `[]` all parse. They are not records, and the
    // caller reinitializes over anything falsey — so they have to travel the SAME
    // preservation path as malformed bytes, or a valid-but-unusable document gets
    // replaced with no backup while the store promises it never destroys a record.
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    return rejectUnusable(file, raw, `it parsed as ${Array.isArray(parsed) ? 'an array' : JSON.stringify(parsed)}, not a record`);
  } catch (_e) {
    return rejectUnusable(file, raw, 'it is not valid JSON');
  }
}

// Returning null tells the caller to reinitialize, which overwrites this file.
// Only say that once the bad bytes are safely copied: if the backup failed, this
// file is the ONLY copy of the record and clobbering it is a silent data loss the
// tool's whole promise forbids.
function rejectUnusable(file, raw, why) {
  if (!backupCorrupt(file, raw)) {
    throw new Error(
      `${path.basename(file)} cannot be used as a record (${why}) and could not be backed up — refusing to ` +
        'reinitialize over the only copy. Move or repair the file by hand, then re-run.'
    );
  }
  return null;
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
// (RATCHET_AGENT unset) and the scribe both return '' — they may write. `env` is
// injectable so a launch-time guard judging an INJECTED environment (the MCP
// entry point's io.env) asks this one function instead of growing a second copy
// of the role rule that could drift from it.
function proposeOnlyAgent(env) {
  const a = (((env || process.env).RATCHET_AGENT) || '').trim().toLowerCase();
  return a && !WRITER_AGENTS.has(a) ? a : '';
}

// Throw before any canonical-state mutation if a propose-only agent is driving.
// The message tells the agent what to do instead — emit the command, don't run it.
function assertMayWrite(action) {
  const a = proposeOnlyAgent();
  if (a) {
    const e = new Error(
      `agent "${a}" has propose-only memory and may not mutate canonical state (${action}). ` +
        'Emit the exact command for the caller or the ratchet-scribe to run instead. ' +
        '(Only the scribe writes canonical state; unset RATCHET_AGENT for the main caller, or set it to scribe.)'
    );
    // Coded, so a caller that swallows errors by policy (hooks) can still tell a
    // refusal apart from a failure and say which one it was.
    e.code = 'ERATCHETPROPOSEONLY';
    throw e;
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

function ownerCardPath(lockDir) {
  return path.join(lockDir, 'owner.json');
}

// Clock skew between two machines writing one store is real; a card a few
// seconds ahead is not evidence of anything. Beyond that it is not a clock.
const FUTURE_SKEW_MS = 5000;

function lockOwner(lockDir) {
  let raw = '';
  // UNREADABLE IS NOT EMPTY. Mapping every read failure to '' made two different
  // holdings nobody can read compare equal, and the break then carried off a live
  // successor believing it had verified it. `absent` (there is provably no card)
  // and `unreadable` (there may be one and we cannot see it) are different facts.
  let absent = false;
  let unreadable = false;
  try {
    raw = fs.readFileSync(ownerCardPath(lockDir), 'utf8');
  } catch (e) {
    if (e && e.code === 'ENOENT') absent = true;
    else unreadable = true;
  }
  let card = null;
  try {
    card = raw.trim() ? JSON.parse(raw) : null;
  } catch (_e) {
    card = null;
    unreadable = true; // present, but its identity cannot be established
  }
  const stamped = card ? Date.parse(card.at) : NaN;
  let ageMs;
  // `believable` gates LIVENESS, not age: a holding whose clock cannot be
  // believed is one whose pid claim cannot be believed either.
  let believable = true;
  if (!Number.isFinite(stamped)) {
    // No card, or an unreadable one: either a lock caught mid-acquisition or one
    // made by hand. Age it by the directory rather than assuming the worst —
    // assuming stale here is exactly how a live writer gets its lock stolen.
    believable = false;
    try {
      ageMs = Math.max(0, Date.now() - fs.statSync(lockDir).mtimeMs);
    } catch (_e) {
      ageMs = 0;
    }
  } else if (stamped > Date.now() + FUTURE_SKEW_MS) {
    // Age used to be clamped at 0 here, which turned one bad timestamp into a
    // permanently unbreakable lock: forever under soft-stale, forever protected.
    // An unbelievable clock makes the holding UNPROVABLE, not sacred.
    believable = false;
    ageMs = Infinity;
  } else {
    ageMs = Math.max(0, Date.now() - stamped);
  }
  return {
    // The token is what actually identifies a HOLDING: pid + host can be
    // recycled, a token cannot. Release and stale-break both compare it — and
    // where a card carries no token, `raw` is compared instead, because no card
    // shape is exempt from verification.
    token: card ? String(card.token || '') : '',
    pid: card ? Number(card.pid) : NaN,
    host: card ? String(card.host || '') : '',
    action: (card && card.action) || 'unknown',
    ageMs,
    believable,
    raw,
    card,
    absent,
    unreadable,
  };
}

// Is this the same holding we judged? Token when there is one, whole card when
// there is not. A conditional check is not a check: a tokenless judgment that
// skipped verification could carry off a live successor.
//
// An UNREADABLE identity matches nothing, including another unreadable one — that
// is the R2 hole, where '' === '' let two unrelated holdings pass as the same.
// A provably ABSENT card is a different case: it is a fact we can establish, and
// two absences do compare equal. That is a deliberate narrowing, because the
// alternative is that a lock whose owner died in the microsecond between mkdir and
// the card write becomes permanently unbreakable — and with a fail-stop restore
// that would wedge every later command. The residual window (a successor caught
// mid-acquisition, also cardless) is covered by the commit-time ownership fence,
// which refuses rather than double-writes.
function sameHolding(judged, found) {
  if (judged.unreadable || found.unreadable) return false;
  if (judged.absent || found.absent) return judged.absent && found.absent;
  return judged.token ? found.token === judged.token : found.raw === judged.raw;
}

// Everything an operator needs to resolve a wedge, in the refusal itself. A
// provably-live local owner is NEVER auto-broken, so the operator IS the recovery
// path for a wedged holder (or for a pid the OS has recycled into an unrelated
// live process) — a message that does not hand over the remedy strands them.
function lockRefusal(lockDir, owner) {
  const age = owner.ageMs === Infinity ? 'an unbelievable age (card stamped in the future)' : `${Math.round(owner.ageMs / 1000)}s`;
  const e = new Error(
    `could not acquire the ratchet lock at ${lockDir} — held by pid ${owner.pid} on host ${owner.host || 'unknown'} ` +
      `(action: ${owner.action}), held for ${age}. Wait for that command to finish. If that process is not a ratchet ` +
      `writer (it exited, or the OS reused its pid), delete the lock directory by hand to release it: ${lockDir}`
  );
  e.code = 'ERATCHETLOCK';
  e.lockDir = lockDir;
  e.ownerPid = owner.pid;
  e.ownerHost = owner.host;
  return e;
}

// A lock whose owner is PROVABLY ALIVE on this host is never broken — not at
// soft-stale, not at hard-stale, not ever. A wedged live holder produces a
// perpetual named refusal, and an honest refusal beats a stolen lock: breaking a
// live writer's lock does not unwedge it, it just adds a second writer to the
// record it is still holding open. Hard-stale therefore applies ONLY where
// liveness cannot be established at all — a dead pid, a foreign host, or an
// owner card nobody can read.
function staleVerdict(owner) {
  const soft = envMs('RATCHET_LOCK_STALE_MS', 5000);
  const hard = envMs('RATCHET_LOCK_HARD_STALE_MS', 120000);
  if (owner.ageMs < soft) return '';
  const local = owner.believable && owner.host === os.hostname() && Number.isInteger(owner.pid);
  if (local && pidAlive(owner.pid)) return ''; // alive on this host — never broken
  if (local) return 'the owning process is gone';
  // Foreign host, unreadable card, or a clock that cannot be believed: liveness
  // is unknowable from here, so only sheer age can settle it.
  if (owner.ageMs < hard) return '';
  if (owner.card && !owner.believable) return 'the owner card is stamped in the future — its clock cannot be believed';
  return owner.host ? `owner is on another host (${owner.host}) and unreachable` : 'the owner card is unreadable';
}

function breakIfStale(lockDir) {
  const owner = lockOwner(lockDir);
  const why = staleVerdict(owner);
  if (!why) return false;
  // Two waiters can reach this verdict in the same instant. Rename is atomic, so
  // only one of them can win it — but the rename moves whatever occupies .lock
  // AT THAT MOMENT, which may already be a new, live generation (ABA). So verify
  // what was actually moved before destroying it.
  const doomed = `${lockDir}.stale-${crypto.randomBytes(4).toString('hex')}`;
  try {
    fs.renameSync(lockDir, doomed);
  } catch (_e) {
    return false; // somebody else won the break, or the owner released it first
  }
  const moved = lockOwner(doomed);
  if (!sameHolding(owner, moved)) {
    // We judged one holding stale and moved a different one. Put it back if the
    // slot is still free; if it is not, a third holding is already there and
    // undoing would be a second theft — name the incident instead.
    let restored = false;
    try {
      if (!fs.existsSync(lockDir)) {
        fs.renameSync(doomed, lockDir);
        restored = true;
      }
    } catch (_e) {
      /* fall through to the loud path */
    }
    const preamble =
      `[ratchet] ABORTED a stale-lock break at ${lockDir}: judged ${owner.token ? `token ${owner.token.slice(0, 8)}` : 'a card with no token'} ` +
      `stale but moved ${moved.token ? `token ${moved.token.slice(0, 8)}` : 'a different card'} (pid ${moved.pid}).`;
    if (restored) {
      process.stderr.write(`${preamble} Restored it — no lock was destroyed.\n`);
      return false; // nothing was broken; let the loop retry against the restored holding
    }
    // FAIL-STOP. Returning "did not break" used to let the retry loop find the
    // slot empty and take it: the same invocation that stranded somebody else's
    // holding walked away with the lock it created room for. A call that broke
    // something it could not verify does not get to profit from it. A fresh
    // command may try again; this one is over.
    const e = new Error(
      `${preamble} COULD NOT RESTORE: a holding is stranded at ${doomed} and its owner still believes it holds ` +
        `the lock at ${lockDir}. Refusing to acquire in the call that stranded it. Every commit re-verifies ` +
        'ownership, so the stranded owner will refuse rather than double-write — inspect the stranded directory by hand.'
    );
    e.code = 'ERATCHETLOCKINCIDENT';
    e.lockDir = lockDir;
    e.strandedAt = doomed;
    throw e;
  }
  removeDirSync(doomed);
  process.stderr.write(
    `[ratchet] broke a stale lock at ${lockDir} — ${why}: pid ${owner.pid} (${owner.action}), ${Math.round(owner.ageMs / 1000)}s old.\n`
  );
  return true;
}

// Same reason removeDirSync retries: Windows refuses to rename a directory any
// process still has open, and every waiter polls the owner card of the lock it is
// waiting on. ENOENT is final — there is nothing left to move.
function renameWithRetry(from, to) {
  for (let i = 0; i < 5; i++) {
    try {
      fs.renameSync(from, to);
      return true;
    } catch (e) {
      if (e && e.code === 'ENOENT') return false;
      sleepSync(10);
    }
  }
  return false;
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
  const token = crypto.randomBytes(8).toString('hex');
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
          ownerCardPath(lockDir),
          JSON.stringify({ token, pid: process.pid, host: os.hostname(), at: new Date().toISOString(), action: action || 'mutation' }),
          'utf8'
        );
      } catch (e) {
        removeDirSync(lockDir); // never hold a lock nobody can identify or age
        throw e;
      }
      return { dir: lockDir, token, action: action || 'mutation' };
    }
    if (breakIfStale(lockDir)) continue;
    if (Date.now() >= deadline) throw lockRefusal(lockDir, lockOwner(lockDir));
    sleepSync(wait);
    wait = Math.min(wait * 2, 50);
  }
}

// Release removes OUR holding or nothing. A blind rmdir is how a process that
// overran its own lock (broken as stale, re-acquired by a successor) deletes the
// successor's live lock on its way out — two writers, no lock, and neither of
// them ever learns. So the token is checked first, and a failed removal is
// neutralized rather than shrugged off: a .lock nobody owns and nobody can
// delete blocks every future writer until the timeout, every time.
function releaseLock(handle) {
  if (!handle || !handle.dir) return true;
  if (!fs.existsSync(handle.dir)) return true; // already gone (broken as stale)
  // VERIFY BY MOVING, the same primitive the break uses. Reading the owner card
  // and then deleting the directory is two steps, and a successor that acquires
  // between them is deleted by a process that had already "checked" — the exact
  // TOCTOU the release was supposed to be immune to. After an atomic rename, what
  // we are holding is ours alone to inspect and nobody else can be inside it.
  const releasing = `${handle.dir}.releasing-${crypto.randomBytes(4).toString('hex')}`;
  if (!renameWithRetry(handle.dir, releasing)) {
    // Windows refuses to rename a directory any process still has open, and other
    // writers poll this one constantly. After the retries have failed, a lock we
    // will not move is a lock nobody can take, so fall back to the older
    // verify-in-place delete rather than wedging every future writer. That
    // fallback carries the TOCTOU this function exists to remove — it needs a
    // successor to acquire in the window AND five consecutive rename failures, and
    // a stuck lock is the more likely harm.
    const inPlace = lockOwner(handle.dir);
    if (!fs.existsSync(handle.dir)) return true;
    if (inPlace.unreadable || inPlace.token !== handle.token) {
      process.stderr.write(`[ratchet] NOT releasing ${handle.dir}: could not move it and it is not ours. Leaving it alone.\n`);
      return false;
    }
    return removeDirSync(handle.dir);
  }
  const owner = lockOwner(releasing);
  if (!sameHolding({ token: handle.token, raw: '', absent: false, unreadable: false }, owner)) {
    // Not ours. Put it back if the slot is free; never delete a holding we cannot
    // prove is ours, and never leave one stranded in silence.
    let restored = false;
    try {
      if (!fs.existsSync(handle.dir)) {
        fs.renameSync(releasing, handle.dir);
        restored = true;
      }
    } catch (_e) {
      /* fall through to the loud path */
    }
    process.stderr.write(
      `[ratchet] NOT releasing ${handle.dir}: it holds ${owner.token ? `token ${owner.token.slice(0, 8)}` : 'no readable owner card'} ` +
        `(pid ${owner.pid}, ${owner.action}), not this process's ${handle.token.slice(0, 8)}. Our holding was broken or ` +
        `replaced. ${restored ? 'Put it back untouched.' : `STRANDED at ${releasing} — inspect by hand.`}\n`
    );
    return false;
  }
  if (removeDirSync(releasing)) return true;
  process.stderr.write(
    `[ratchet] could not delete ${releasing} (pid ${process.pid}); the lock slot is free, the residue is not. ` +
      'Remove that directory by hand.\n'
  );
  return false;
}

// At most ONE lock scope is open per process, and it is remembered here. The
// lock is not recursive at the filesystem level, so a nested acquire would wait
// on a lock this very process holds: a silent self-deadlock. Nested callers with
// the same scope JOIN the open one instead — helpers never lock.
let _scope = null;

// LOCK ORDER: workspace → file, never the reverse.
//
// Two lock families exist (the workspace store, and per-file locks such as the
// evolution journal). A process that holds one and waits for the other in the
// opposite order to another process is the textbook ABBA wedge; here it would
// resolve as a pair of timeouts rather than a hang, but a pair of timeouts is
// still two failed commands and no diagnosis. So the order is declared and
// ENFORCED: taking a workspace lock while holding a file lock throws by name.
// The file locks currently open in this process, innermost last.
const _fileScopes = [];

function assertLockOrder(what) {
  if (_fileScopes.length) {
    throw new Error(
      `lock order violation: refusing to take the workspace lock (${what}) while holding the file lock ` +
        `${_fileScopes[_fileScopes.length - 1].dir}. The order is workspace → file, never the reverse — ` +
        'acquire the workspace lock (or let the read that creates the store run) before entering the file lock.'
    );
  }
}

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
  assertLockOrder(action);
  const handle = acquireLock(path.join(dir, LOCK_DIR_NAME), action);
  _scope = { dir, action, state: null, handle };
  try {
    return fn();
  } finally {
    _scope = null;
    releaseLock(handle);
  }
}

// Defense in depth for the last instant before a canonical publish. Every
// residual hole in the lock protocol — a break that stranded a live holding, an
// ABA steal, a writer that bypassed the lock entirely — ends in the same state:
// two processes each believing they hold one lock. Re-reading the owner card
// immediately before the write turns every one of those into a LOSER-SIDE
// REFUSAL that writes nothing, instead of a silent double write nobody detects.
// The fence as writeJson applies it: does an open lock scope cover this file? If
// so, our holding has to still be ours before the rename publishes it. Keyed on
// the directory, so state.json, ledger.json and every future file in the store
// are all covered without naming any of them.
function fenceForFile(file) {
  if (!_scope || !_scope.handle) return;
  if (path.resolve(path.dirname(file)) !== path.resolve(_scope.dir)) return;
  assertStillOwnerOfScope(path.basename(file));
}

function assertStillOwner(cwd, what) {
  const dir = projectDir(cwd);
  if (!_scope || _scope.dir !== dir || !_scope.handle) return;
  assertStillOwnerOfScope(what);
}

function assertStillOwnerOfScope(what) {
  const owner = lockOwner(_scope.handle.dir);
  if (owner.token === _scope.handle.token) return;
  const e = new Error(
    `refusing to publish ${what}: this process no longer owns the ratchet lock at ${_scope.handle.dir}. ` +
      `It now holds ${owner.token ? `token ${owner.token.slice(0, 8)} (pid ${owner.pid}, ${owner.action})` : 'no readable owner card'}, ` +
      `not ours (${_scope.handle.token.slice(0, 8)}). Our holding was broken or removed mid-transaction — nothing was written. Re-run.`
  );
  e.code = 'ERATCHETLOCKLOST';
  throw e;
}

// The lock has to name the same FILE for every caller, and two callers can spell
// one file differently. Resolving only the PARENT left the final component as
// typed, so a symlinked FILE was two names, two lock keys, and no exclusion at
// all between two processes appending to one log. Resolve the file itself when it
// exists; fall back to the resolved parent plus the basename when it does not
// (a lock is often taken to create the thing it protects).
//
// It does NOT fix hard links: two names for one inode are two paths no matter
// how they are resolved, and keying a lock by inode is not buildable
// dependency-free. It does not fix Windows path CASING either — realpath returns
// the spelling it was given there. Both are named in the CHANGELOG boundary list
// rather than assumed away.
function fileLockDir(file) {
  try {
    return `${fs.realpathSync(file)}${LOCK_DIR_NAME}`;
  } catch (_e) {
    /* the file does not exist yet — or it is a link to something that does not */
  }
  // A DANGLING symlink makes realpath fail, and falling back to the link's own
  // name changed the lock identity the moment the target appeared: the alias was
  // locked as `alias.lock` before creation and as `real.lock` after, so one file
  // could be held under two keys at once, each holder believing it was exclusive.
  // Follow the link by hand instead — the target's name is knowable even when the
  // target is not there yet.
  const resolved = resolveLinkTarget(file);
  try {
    return path.join(fs.realpathSync(path.dirname(resolved)), `${path.basename(resolved)}${LOCK_DIR_NAME}`);
  } catch (_e) {
    return `${resolved}${LOCK_DIR_NAME}`; // parent does not exist either — lexical is all there is
  }
}

// Walk a chain of symlinks to the name it finally points at, whether or not that
// name exists. Bounded, because a link cycle is a real thing and a hang is worse
// than a bad lock key.
function resolveLinkTarget(file) {
  let current = path.resolve(file);
  for (let hops = 0; hops < 32; hops++) {
    let target;
    try {
      target = fs.readlinkSync(current);
    } catch (_e) {
      return current; // not a link (or unreadable): this is the final name
    }
    current = path.resolve(path.dirname(current), target);
  }
  return current;
}

// A generic lock for a file that is NOT in the workspace store — the evolution
// journal, whose path is caller-selectable (RATCHET_EVOLVE_LOG) and therefore
// cannot borrow the workspace's lock without making unrelated writers queue
// behind each other in both directions.
function withFileLock(file, action, fn) {
  const dir = fileLockDir(file);
  const already = _fileScopes.find((s) => s.dir === dir);
  if (already) return fn(); // same file, same process — join, never re-acquire
  const handle = acquireLock(dir, action);
  _fileScopes.push({ dir, action });
  try {
    return fn();
  } finally {
    _fileScopes.pop();
    releaseLock(handle);
  }
}

// ---------------------------------------------------------------------------
// State lifecycle.
// ---------------------------------------------------------------------------

// Create a file that does not exist yet, atomically, and REFUSE if it appeared
// in the meantime. A rename always replaces its destination — which is right for
// a revision and catastrophically wrong for a first-time creation, where the
// thing being replaced is somebody else's committed record and the replacement
// is an empty one. Hard-linking the temp file into place is the same atomic
// publish with create-or-fail semantics; where links are unavailable, an
// exclusive 'wx' open is the fallback.
function createJsonExclusive(file, obj) {
  ensureDir(path.dirname(file));
  const data = JSON.stringify(obj, null, 2) + '\n';
  const tmp = `${file}.tmp-${process.pid.toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
  try {
    writeFileAtomic(tmp, data);
    try {
      // The link IS the publish here, so it carries the same fence a rename does.
      fenceForFile(file);
      fs.linkSync(tmp, file);
      return true;
    } catch (e) {
      if (e && e.code === 'EEXIST') return false; // somebody else created it first
      if (e && (e.code === 'EPERM' || e.code === 'ENOSYS' || e.code === 'EXDEV' || e.code === 'EOPNOTSUPP')) {
        // No hard links on this filesystem. The obvious fallback — an exclusive
        // 'wx' open of the canonical path — writes the record IN PLACE, and a
        // death mid-write then leaves a permanently malformed state.json that
        // creation refuses to repair (EEXIST) while every reader spawns another
        // .corrupt backup. Atomicity matters more than exclusivity here: this
        // path only runs under the workspace lock, so the exclusivity it gives up
        // is exclusivity against writers that bypass the lock entirely — which
        // nothing in this codebase does, and which no advisory lock can stop.
        if (fs.existsSync(file)) return false;
        writeFileAtomic(file, data, () => fenceForFile(file));
        return true;
      }
      throw e;
    }
  } finally {
    try {
      fs.rmSync(tmp, { force: true });
    } catch (_e) {
      /* the .tmp- name says what it is if it survives */
    }
  }
}

function initProject(cwd, opts = {}) {
  // The library entry point is the same door as the CLI verb. `init --force` is
  // an irreversible wipe, and the CLI's guard only ever covered the CLI: an
  // auditor agent could reset the store by calling this directly. A plain init
  // creates nothing that exists and wipes nothing, so it stays open — a
  // propose-only agent must still be able to orient.
  if (opts.force) assertMayWrite('init --force');
  // Creating the store is a WRITE, so it happens under the lock like every other
  // write. Without it, a first read on an empty store could publish its fresh
  // rev-0 record over a revision a locked writer had already committed — a read
  // erasing a write, which is the exact failure the gate exists to make
  // impossible. A caller that already holds this workspace just joins the scope.
  return withWorkspaceLock(cwd, opts.force ? 'init --force' : 'init', () => initProjectLocked(cwd, opts));
}

function initProjectLocked(cwd, { force = false, resetBy = '', resetReason = '' } = {}) {
  ensureDir(projectDir(cwd));
  const sPath = statePath(cwd);
  const lPath = ledgerPath(cwd);
  let created = false;
  if (force || !fs.existsSync(sPath)) {
    const fresh = schemas.newState();
    // A wipe CONTINUES the revision line; it does not restart it. Restarting
    // meant a writer that had loaded the old generation at rev 0 came back, found
    // rev 0 again, matched, took the fast path and wrote its pre-reset record
    // straight over the fresh one — erasing a deliberate, authorized wipe with a
    // stale snapshot. One ordered truth: a store's revisions never restart while
    // the store exists. A genuinely new store still opens at rev 0.
    if (force) {
      const previous = readJson(sPath);
      if (previous) fresh.rev = revOf(previous) + 1;
    }
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
    // A wipe is a deliberate replacement; a first creation is not allowed to
    // replace anything.
    if (force) writeJson(sPath, fresh);
    else created = createJsonExclusive(sPath, fresh);
    if (force) created = true;
  }
  if (force) writeJson(lPath, schemas.newLedger());
  else if (!fs.existsSync(lPath)) createJsonExclusive(lPath, schemas.newLedger());
  return { dir: projectDir(cwd), created, statePath: sPath, ledgerPath: lPath };
}

// What each loaded snapshot was read FROM. A save that names no expected
// revision still has to know what its caller CHANGED, and the only honest
// answer is the bytes that caller actually read. WeakMap, so a dropped snapshot
// is not a leak.
const _base = new WeakMap();

// The same answer, keyed by <statePath>@<rev> instead of by object identity.
// Object identity is lost the moment a snapshot crosses a boundary that copies
// it — structuredClone, JSON round-trip, an IPC hop, a helper that spreads it —
// and a snapshot with no remembered base used to fall through to a blind
// overwrite, which is precisely the v0.8 lost update wearing a 0.9 lock. The
// revision it claims is enough to find what it was read from. Bounded, because
// this is a cache and not a record.
const _baseByRev = new Map();
const BASE_CACHE_MAX = 64;

function baseKey(cwd, rev) {
  return `${statePath(cwd)}@${rev}`;
}

function rememberBase(cwd, snapshot) {
  const copy = clone(snapshot);
  _base.set(snapshot, copy);
  const key = baseKey(cwd, revOf(snapshot));
  _baseByRev.delete(key); // re-insert so the newest key is last for eviction
  _baseByRev.set(key, copy);
  if (_baseByRev.size > BASE_CACHE_MAX) _baseByRev.delete(_baseByRev.keys().next().value);
  return snapshot;
}

function baseFor(cwd, state) {
  return _base.get(state) || _baseByRev.get(baseKey(cwd, revOf(state))) || null;
}

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
  // Parse-only peek: no backup, no write, no lock. The overwhelmingly common case
  // is a healthy record, and that case must cost one read.
  const healthy = readJson(statePath(cwd));
  if (healthy) return rememberBase(cwd, healthy);
  // Absent, empty, or malformed. All three need the lock from here, because all
  // three end in a WRITE — the corrupt-bytes backup as much as the creation, and
  // an unlocked backup-then-reinitialize is a read racing a writer.
  return withWorkspaceLock(cwd, 'state init', () => {
    // Under the lock, and only now: the resilient read, which backs the corrupt
    // bytes up before anything can overwrite them, and throws rather than
    // reinitialize over a record that is present but unreadable.
    const existing = readJsonResilient(statePath(cwd));
    if (existing) return rememberBase(cwd, existing);
    const fresh = schemas.newState();
    if (fs.existsSync(statePath(cwd))) {
      // Present but unusable, and its bytes are now safely backed up: REPLACING
      // it is the repair. Refusing here (create-or-fail) left the bad file in
      // place forever, so every future read backed it up again and the store
      // could never be opened — a repair loop that never repaired.
      writeJson(statePath(cwd), fresh);
    } else if (!createJsonExclusive(statePath(cwd), fresh)) {
      const raced = readJsonResilient(statePath(cwd));
      if (raced) return rememberBase(cwd, raced);
    }
    return rememberBase(cwd, fresh);
  });
}

function commitState(cwd, state, baseRev) {
  // Last instant before the canonical publish: do we still own the lock?
  assertStillOwner(cwd, `state rev ${baseRev + 1}`);
  state.updatedAt = schemas.nowIso();
  state.rev = baseRev + 1;
  writeJson(statePath(cwd), state);
  // The caller may save the same object again; its base has to move with it or
  // the second save would rebase against a revision that is two writes old.
  rememberBase(cwd, state);
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

// Ids that appear more than once in ANY of the three lists. Matching records by
// "the Nth record carrying id X" pairs two records that merely share an id and
// an ordinal, and merging them field-by-field builds a record that never existed
// — A's evidence stapled onto B's status. A duplicated id means the store is
// already broken; the merge refuses to make it worse.
function duplicatedIds(lists) {
  const dupes = new Set();
  for (const list of lists) {
    const seen = new Set();
    for (const item of list) {
      if (!isPlainObject(item) || item.id == null) continue;
      const id = String(item.id);
      if (seen.has(id)) dupes.add(id);
      seen.add(id);
    }
  }
  return dupes;
}

function idOf(item) {
  return isPlainObject(item) && item.id != null ? String(item.id) : null;
}

function mergeArray(base, mine, theirs) {
  const baseIdx = indexBy(base);
  const mineIdx = indexBy(mine);
  const dupes = duplicatedIds([base, mine, theirs]);
  const out = [];
  const takenFromMine = new Set();
  // Their order is the committed order and stays authoritative.
  for (const [key, item] of indexBy(theirs)) {
    const id = idOf(item);
    if (id && dupes.has(id)) {
      out.push(item); // committed order wins outright for an ambiguous id
      continue;
    }
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
    const id = idOf(item);
    if (id && dupes.has(id)) continue; // never re-add an ambiguous id
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
  // saveState is a PUBLIC write, not a private helper, so it answers to the same
  // rules the boundary does. It used to be the softer second door: no authority
  // check, no no-op detection — a propose-only agent could write through it and
  // an identical resave still burned a revision, invalidating proof bound to the
  // previous one.
  assertMayWrite('saveState');
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
  if (!disk) return commitState(cwd, state, revOf(state)); // nothing on disk to lose
  // A wipe starts a new GENERATION of the record, and `gen` is its name. A delta
  // computed against the old generation must never be merged into the new one,
  // however the revision numbers happen to line up: the entire point of an
  // authorized reset is that pre-reset intent stops applying, so rebasing it back
  // in resurrects exactly what somebody deliberately destroyed.
  //
  // This was `createdAt` and that was a hole: createdAt comes from nowIso, so a
  // frozen RATCHET_NOW (supported, used by hooks and deterministic tests) made
  // both generations stamp identically and the check passed. A record written
  // before `gen` existed has none, and two such records compare equal — the
  // pre-0.9 boundary, named in the CHANGELOG rather than papered over.
  if (String(state.gen || '') !== String(disk.gen || '')) {
    const e = new Error(
      `refused a write from a previous generation of this record (saveState): the snapshot belongs to generation ` +
        `${state.gen || '(none recorded)'} and the workspace record to ${disk.gen || '(none recorded)'} — the store ` +
        'was reset in between. Reload the state; the change has to be re-decided against the record that exists now.'
    );
    e.code = 'ERATCHETSTALE';
    e.expectedStateRev = revOf(state);
    e.actualStateRev = revOf(disk);
    throw e;
  }
  const base = baseFor(cwd, state);
  if (revOf(disk) !== revOf(state) && !base) {
    // A snapshot at a revision that is no longer current, and nothing remembers
    // what it was read from. There is no delta to rebase and no claim to honour,
    // so the only options are to overwrite blindly — the v0.8 defect — or to
    // refuse. Refuse.
    const e = new Error(
      `refused a blind overwrite (saveState): the snapshot is at rev ${revOf(state)}, the workspace is at ` +
        `rev ${revOf(disk)}, and this process has no record of what rev ${revOf(state)} contained. ` +
        'Reload the state and re-apply the change.'
    );
    e.code = 'ERATCHETSTALE';
    e.expectedStateRev = revOf(state);
    e.actualStateRev = revOf(disk);
    throw e;
  }
  const next = base && revOf(disk) !== revOf(base) ? Object.assign(state, mergeObject(base, state, disk)) : state;
  // A save that would not move the record is not a write. Bumping rev for it
  // would invalidate every proof bound to the current revision for nothing. The
  // volatile stamps are excluded because they are the write, not the change.
  if (unchangedFrom(disk, next)) return next;
  return commitState(cwd, next, revOf(disk));
}

// Same record? Compare everything except the two fields a commit stamps.
function unchangedFrom(disk, next) {
  const strip = (o) => {
    const c = { ...o };
    delete c.rev;
    delete c.updatedAt;
    return c;
  };
  return isDeepStrictEqual(strip(disk), strip(next));
}

// THE transaction boundary. One public mutation = acquire the lock → reload the
// state under it → compare the revision the caller believes it is editing →
// apply → commit exactly one revision → release, on every path.
//
// `alsoLockFile` extends the transaction over a second file for its whole
// duration, COMMIT INCLUDED. A verb whose decision depends on another file's
// contents (the closure gate reads its proof from the journal) cannot release
// that file's lock before it publishes: doing so does not close the window
// between reading the evidence and acting on it, it just moves the window later.
// Acquired inside the workspace lock, so the declared order still holds.
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
  assertLockOrder(action);
  const handle = acquireLock(path.join(dir, LOCK_DIR_NAME), action);
  _scope = { dir, action, state: null, handle };
  try {
    // The second lock, if the verb asked for one, wraps everything below —
    // validation AND commit — and is released by withFileLock's own finally.
    return o.alsoLockFile
      ? withFileLock(o.alsoLockFile, `${action} (spans the commit)`, () => runMutation(cwd, o, action, mutate))
      : runMutation(cwd, o, action, mutate);
  } finally {
    _scope = null;
    releaseLock(handle);
  }
}

function runMutation(cwd, o, action, mutate) {
  {
    // The revision check comes BEFORE the read that would create the store. A
    // caller naming a revision on a store that does not exist is refusing to be
    // told "there was nothing there, so I made you something" — and a refusal
    // that leaves a freshly minted state.json behind is not a zero-byte refusal.
    const onDisk = readJsonResilient(statePath(cwd));
    if (o.expectedStateRev != null) {
      if (!onDisk) {
        const e = new Error(
          `refused a stale write (${action}): expected rev ${o.expectedStateRev}, but this workspace has no ` +
            'record yet — nothing can match a named revision on a store that does not exist. Initialize it first.'
        );
        e.code = 'ERATCHETSTALE';
        e.expectedStateRev = o.expectedStateRev;
        e.actualStateRev = null;
        throw e;
      }
      if (o.expectedStateRev !== revOf(onDisk)) {
        const e = new Error(
          `refused a stale write (${action}): expected rev ${o.expectedStateRev}, the workspace is at rev ${revOf(onDisk)}. ` +
            'Reload the state and re-apply the change against what is actually recorded.'
        );
        e.code = 'ERATCHETSTALE';
        e.expectedStateRev = o.expectedStateRev;
        e.actualStateRev = revOf(onDisk);
        throw e;
      }
    }
    const s = onDisk ? rememberBase(cwd, onDisk) : loadState(cwd);
    const baseRev = revOf(s);
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
  }
}

function loadLedger(cwd) {
  const existing = readJsonResilient(ledgerPath(cwd));
  if (existing) return existing;
  // Same rule as the state record: creating it is a write, so it is locked and
  // it never replaces a ledger that appeared while we queued.
  return withWorkspaceLock(cwd, 'ledger init', () => {
    const appeared = readJsonResilient(ledgerPath(cwd));
    if (appeared) return appeared;
    const fresh = schemas.newLedger();
    if (!createJsonExclusive(ledgerPath(cwd), fresh)) {
      const raced = readJsonResilient(ledgerPath(cwd));
      if (raced) return raced;
    }
    return fresh;
  });
}

// The ledger is a second canonical file in the same store, so it answers to the
// same lock. It used to write directly: two processes holding stale ledger
// snapshots simply lost one of the two saves, with nothing to detect it. (The
// ledger has no revision counter, so this serializes writes rather than rebasing
// them — the last writer under the lock still wins. Named in the CHANGELOG.)
function saveLedger(cwd, ledger) {
  assertMayWrite('saveLedger'); // the ledger is canonical too — one door standard
  return withWorkspaceLock(cwd, 'saveLedger', () => {
    assertStillOwner(cwd, 'the ledger');
    ledger.updatedAt = schemas.nowIso();
    writeJson(ledgerPath(cwd), ledger);
    return ledger;
  });
}

// Short, sortable, collision-resistant id: <prefix>-<time36>-<rand>. The time
// prefix keeps ids scannable and roughly ordered; the entropy is what makes them
// unique. The counter this replaced was PROCESS-LOCAL, so two processes sharing
// a clock handed out the same ids — a CSPRNG has no such shared state.
function makeId(prefix) {
  return `${prefix || 'id'}-${Date.now().toString(36)}-${crypto.randomBytes(6).toString('hex')}`;
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
  createJsonExclusive,
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
