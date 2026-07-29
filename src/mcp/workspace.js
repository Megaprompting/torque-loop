'use strict';

// Torque MCP build-order step 2.1: the root allowlist and canonical path
// containment. Nothing else lives here yet — handles, git identity, and
// torque:// resources are later sub-steps that stand on this boundary.
//
// The invariant: NO CLIENT-CONTROLLED PATH CROSSES THE CONFIGURED ROOTS,
// directly or indirectly. A string check cannot enforce that, because the
// filesystem decides what a path means: `..` normalizes away, a symlink
// re-points a component, Windows compares names case-insensitively, and a NUL
// truncates the path inside the syscall. So containment is judged on a
// CANONICAL path — every component resolved through the filesystem — never on
// the text the client sent.

const fs = require('fs');
const path = require('path');

// Windows compares path names case-insensitively, so containment must too;
// elsewhere two names differing in case are two different files.
const CASE_INSENSITIVE = process.platform === 'win32';

function refuse(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function escaped(what) {
  // Deliberately does NOT echo the resolved target: telling a caller where its
  // traversal landed answers the question it was asking.
  return refuse('ERATCHETPATHESCAPE', `${what} — it is outside the configured roots`);
}

function comparable(p) {
  return CASE_INSENSITIVE ? p.toLowerCase() : p;
}

function within(canonical, root) {
  const a = comparable(canonical);
  const b = comparable(root);
  if (a === b) return true;
  // The separator matters: without it "/srv/work" would contain "/srv/work-evil".
  return a.startsWith(b.endsWith(path.sep) ? b : b + path.sep);
}

// Resolve every component through the filesystem. Walking down (rather than
// calling realpath once) is what catches a link partway along a path that does
// not exist yet: realpath would fail with ENOENT and tell us nothing about the
// link we already passed through.
function canonicalize(resolved) {
  const parsed = path.parse(resolved);
  const parts = resolved.slice(parsed.root.length).split(path.sep).filter(Boolean);
  let current = parsed.root;

  for (let i = 0; i < parts.length; i++) {
    const next = path.join(current, parts[i]);
    let stat = null;
    try {
      stat = fs.lstatSync(next);
    } catch (_e) {
      stat = null; // nothing here — the remainder is a path that does not exist yet
    }
    if (stat === null) {
      let base = current;
      try {
        base = fs.realpathSync.native(current);
      } catch (_e) {
        // The existing prefix vanished mid-walk; the text we have is all we can
        // judge, and the containment check below still has to pass.
      }
      return path.join(base, ...parts.slice(i));
    }
    if (stat.isSymbolicLink()) {
      try {
        current = fs.realpathSync.native(next);
      } catch (_e) {
        // A dangling link names a destination nothing can confirm. An
        // unprovable target is refused, never assumed to stay inside.
        throw escaped('a link on this path cannot be followed to a real destination');
      }
    } else {
      current = next;
    }
  }

  try {
    return fs.realpathSync.native(current);
  } catch (_e) {
    return current;
  }
}

function createRoots(list) {
  if (!Array.isArray(list)) {
    throw refuse('ERATCHETROOT', 'roots must be an array of absolute directory paths');
  }
  const roots = list.map((entry) => {
    if (typeof entry !== 'string' || !entry.length || entry.indexOf('\u0000') !== -1) {
      throw refuse('ERATCHETROOT', `a root must be a non-empty path string: ${JSON.stringify(entry)}`);
    }
    if (!path.isAbsolute(entry)) {
      throw refuse('ERATCHETROOT', `a root must be absolute, so it names one place on this machine: ${entry}`);
    }
    let real;
    try {
      real = fs.realpathSync.native(entry);
    } catch (_e) {
      // A root that does not exist yet cannot be canonicalized, and a path that
      // appears later is a different place than the one that was configured.
      throw refuse('ERATCHETROOT', `a root must exist when it is configured: ${entry}`);
    }
    let stat;
    try {
      stat = fs.statSync(real);
    } catch (_e) {
      throw refuse('ERATCHETROOT', `a root must be readable when it is configured: ${entry}`);
    }
    if (!stat.isDirectory()) {
      throw refuse('ERATCHETROOT', `a root must be a directory: ${entry}`);
    }
    return real;
  });

  function resolve(candidate) {
    if (typeof candidate !== 'string' || !candidate.length) {
      throw escaped('a path must be a non-empty string');
    }
    if (candidate.indexOf('\u0000') !== -1) {
      // Every syscall stops at the NUL, so the bytes after it are a lie: the
      // containment check would read one path and the open would use another.
      throw escaped('a path may not contain a NUL');
    }
    if (!path.isAbsolute(candidate)) {
      // With more than one root there is no base to guess from, and guessing
      // with one root would silently change meaning when a second is added.
      throw escaped('a path must be absolute');
    }
    // Zero roots is a closed allowlist, not an open one — the refusal below
    // fires for every path, which is the safe direction to fail.
    const canonical = canonicalize(path.resolve(candidate));
    for (const root of roots) {
      if (within(canonical, root)) return canonical;
    }
    throw escaped('this path resolves outside every configured root');
  }

  return {
    resolve,
    // The configured roots, canonical — later sub-steps mint handles from these.
    list: () => roots.slice(),
  };
}

module.exports = { createRoots };
