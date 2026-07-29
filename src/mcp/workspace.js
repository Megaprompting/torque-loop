'use strict';

// Torque MCP build-order step 2.1: the root allowlist and canonical path
// containment. Nothing else lives here yet — handles, git identity, and
// torque:// resources are later sub-steps that stand on this boundary.
//
// The invariant, stated with its boundary: no client-controlled path is
// ACCEPTED unless the components this module observed, as it observed them,
// placed it inside a configured root — directly or indirectly. A string check
// cannot establish that, because the filesystem decides what a path means: a
// symlink re-points a component, `..` means "the parent of where I actually
// am", and name comparison belongs to the filesystem, not to JavaScript. So
// containment is judged on a CANONICAL path, every component resolved through
// the filesystem in order.
//
// What this module does NOT provide: safety across time — not after the call,
// and not even at the instant it returns. Each component is observed at its own
// moment, and the filesystem can be rearranged between any two of them, so the
// result describes what was true during the walk and may already be stale on
// the way back. A pathname API cannot do better: Node exposes no `openat`-style
// primitive to bind a resolution to an opened directory. Closing that window
// means never handing back a name at all — operating through a bound handle
// instead — which is the job of the next sub-step. Named here rather than
// implied away. (Open loop, owner Danny: verify-on-use for the handle boundary.)

const fs = require('fs');
const path = require('path');

const WIN = process.platform === 'win32';

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

function describe(value) {
  // JSON.stringify throws on a BigInt, which would replace this module's named
  // refusal with someone else's TypeError.
  return typeof value === 'string' ? JSON.stringify(value) : `a ${typeof value}`;
}

// Only Windows treats a backslash as a separator. On POSIX it is an ordinary
// character in a filename, so splitting on it would turn "/srv/work\evil" —
// a SIBLING of /srv/work — into a path inside it.
const SEPARATORS = WIN ? /[\\/]/ : /\//;

function isDirectory(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch (_e) {
    return false; // unreadable or gone counts as "cannot prove it is a directory"
  }
}

// `path.isAbsolute` says yes to a Windows path like "\work", which is anchored
// to whatever drive the process happens to be on — it names a different place
// depending on the caller's state, which is precisely what a root may not do.
// "\\name\" is the same trap wearing a UNC costume: a real UNC path needs a
// server AND a share, and without one Windows resolves it against the current
// drive.
function fullyQualified(p) {
  if (!WIN) return p.startsWith('/');
  // Extended UNC ("\\?\UNC\server\share") is refused rather than half-handled:
  // its root is not what path.parse reports, so the walk below would probe an
  // incomplete server path. Use the plain \\server\share form.
  if (/^[\\/]{2}[?.][\\/]UNC[\\/]/i.test(p)) return false;
  if (/^[A-Za-z]:[\\/]/.test(p)) return true;
  if (/^[\\/]{2}[?.][\\/][A-Za-z]:[\\/]/.test(p)) return true; // \\?\C:\...
  return /^[\\/]{2}[^\\/?.][^\\/]*[\\/][^\\/]+/.test(p); // \\server\share
}

function within(canonical, root) {
  // Compared exactly, never case-folded. Both sides come from
  // realpath.native, which answers with the name the filesystem actually
  // stores, so equivalent spellings — case on Windows, unicode composition on
  // macOS — have already converged. Lowercasing here would be worse than
  // useless: JavaScript's case mapping is not the filesystem's, and
  // "İ".toLowerCase() is two code points, so distinct directories could be
  // judged the same one.
  if (canonical === root) return true;
  // The separator matters: without it "/srv/work" would contain "/srv/work-evil".
  return canonical.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
}

// Resolve component by component, in order, exactly as the OS would. Two things
// make this different from calling realpath once:
//   - realpath fails outright on a path that does not exist yet, and a server
//     must be able to name a file it is about to create;
//   - `..` must be applied to where the path has ACTUALLY arrived, after any
//     link on the way. Collapsing it lexically first (as path.resolve does)
//     turns "<root>/link-to-elsewhere/.." into "<root>", which is a different
//     directory than the one the client named.
function canonicalize(candidate) {
  const parsed = path.parse(candidate);
  const parts = candidate.slice(parsed.root.length).split(SEPARATORS).filter(Boolean);
  let current = parsed.root;

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (part === '.') continue;
    if (part === '..') {
      current = path.dirname(current); // the parent of where we really are
      continue;
    }

    const next = path.join(current, part);
    let stat;
    try {
      stat = fs.lstatSync(next);
    } catch (e) {
      if (e.code !== 'ENOENT') {
        // Unreadable is not absent. A component we were not allowed to examine
        // may be a link to anywhere, so the only honest answer is refusal.
        throw escaped(`a component of this path could not be examined (${e.code})`);
      }
      const tail = parts.slice(i).filter((p) => p !== '.');
      if (tail.indexOf('..') !== -1) {
        // "Parent of a directory that does not exist" has no answer the
        // filesystem would agree with; guessing it lexically is how a
        // not-yet-created path escapes.
        throw escaped('a path may not climb past a component that does not exist');
      }
      let base;
      try {
        base = fs.realpathSync.native(current);
      } catch (_e) {
        throw escaped('the existing part of this path could not be canonicalized');
      }
      return path.join(base, ...tail);
    }

    if (stat.isSymbolicLink()) {
      try {
        current = fs.realpathSync.native(next);
      } catch (_e) {
        // A dangling link names a destination nothing can confirm. An
        // unprovable target is refused, never assumed to stay inside.
        throw escaped('a link on this path cannot be followed to a real destination');
      }
      // A link to a FILE cannot be walked through either — including by a `..`
      // that would otherwise climb out of it as if it had been a directory.
      if (i !== parts.length - 1 && !isDirectory(current)) {
        throw escaped('a link on this path leads to a file, and a file has no contents to descend into');
      }
    } else if (!stat.isDirectory() && i !== parts.length - 1) {
      // A file cannot contain the rest of the path; accepting it would return a
      // location that can never exist.
      throw escaped('a component of this path is a file, not a directory');
    } else {
      current = next;
    }
  }

  try {
    return fs.realpathSync.native(current);
  } catch (e) {
    if (e.code === 'ENOENT') return current;
    throw escaped(`this path could not be canonicalized (${e.code})`);
  }
}

function createRoots(list) {
  if (!Array.isArray(list)) {
    throw refuse('ERATCHETROOT', 'roots must be an array of absolute directory paths');
  }
  const roots = list.map((entry) => {
    if (typeof entry !== 'string' || !entry.length || entry.indexOf('\u0000') !== -1) {
      throw refuse('ERATCHETROOT', `a root must be a non-empty path string: ${describe(entry)}`);
    }
    if (!fullyQualified(entry)) {
      throw refuse('ERATCHETROOT',
        `a root must be fully qualified, so it names one place whatever the process's state: ${entry}`);
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
      // Node refuses a NUL in a path itself, with its own error. Refusing it
      // here keeps the boundary's own vocabulary on the boundary's own failures
      // rather than leaking ERR_INVALID_ARG_VALUE to a client.
      throw escaped('a path may not contain a NUL');
    }
    if (!fullyQualified(candidate)) {
      // With more than one root there is no base to guess from, and a
      // drive-relative Windows path names wherever the process happens to be.
      throw escaped('a path must be fully qualified');
    }
    // Zero roots is a closed allowlist, not an open one — the loop below finds
    // nothing and the refusal fires, which is the safe direction to fail.
    const canonical = canonicalize(candidate);
    if (SEPARATORS.test(candidate[candidate.length - 1]) && fs.existsSync(canonical) && !isDirectory(canonical)) {
      // A trailing separator asserts "this is a directory". The OS answers
      // ENOTDIR when it is not, and so does this.
      throw escaped('this path ends in a separator but does not name a directory');
    }
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
