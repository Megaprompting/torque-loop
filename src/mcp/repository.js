'use strict';

// Torque MCP build-order step 2.3: Git-root discovery and local repository
// identity.
//
// The Git top-level is the workspace boundary; the directory a client happened
// to name is not. Discovery starts only after step 2.1 accepts that directory,
// then re-runs the discovered top-level through the same root authority. That
// second check matters when an allowlisted subdirectory belongs to a repository
// whose real root sits outside the allowlist.
//
// Repository identity is local on purpose. The canonical common Git directory
// is shared by linked worktrees but not by sibling clones or nested repositories.
// Branch names, commits, and remotes can all change without changing which local
// repository the server has opened. A separate worktree identity binds the
// exact canonical top-level used by state and future resource reads.
//
// Traced by: openai-codex-gpt-5

const childProcess = require('child_process');
const crypto = require('crypto');
const fs = require('fs');

function refuse(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function cleanGitEnv() {
  const env = Object.assign({}, process.env);
  // Repository-discovery variables are authority inputs in disguise. Inherit
  // ordinary process configuration, but never let an ambient GIT_DIR,
  // GIT_WORK_TREE, or related override redirect the repository being opened.
  for (const key of Object.keys(env)) {
    if (key.toUpperCase().startsWith('GIT_')) delete env[key];
  }
  return env;
}

function gitValue(cwd, option) {
  let output;
  try {
    output = childProcess.execFileSync(
      'git',
      ['-C', cwd, 'rev-parse', '--path-format=absolute', option],
      {
        encoding: 'utf8',
        env: cleanGitEnv(),
        timeout: 10000,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      }
    );
  } catch (_e) {
    throw refuse('ERATCHETGIT', 'workspace must be an accessible Git working tree directory');
  }

  // Remove Git's one record terminator, not arbitrary whitespace: spaces and
  // even newlines may be legal pathname data on the host filesystem.
  if (output.endsWith('\r\n')) output = output.slice(0, -2);
  else if (output.endsWith('\n')) output = output.slice(0, -1);
  if (!output || output.indexOf('\u0000') !== -1) {
    throw refuse('ERATCHETGIT', 'Git returned no usable repository location');
  }
  return output;
}

function canonicalDirectory(candidate, label) {
  let canonical;
  let stat;
  try {
    canonical = fs.realpathSync.native(candidate);
    stat = fs.statSync(canonical);
  } catch (_e) {
    throw refuse('ERATCHETGIT', `${label} could not be examined`);
  }
  if (!stat.isDirectory()) {
    throw refuse('ERATCHETGIT', `${label} must be a directory`);
  }
  return canonical;
}

function identity(prefix, canonicalPath) {
  const digest = crypto
    .createHash('sha256')
    .update(`torque-mcp:${prefix}\u0000`, 'utf8')
    .update(canonicalPath, 'utf8')
    .digest('base64url');
  return `${prefix}_${digest}`;
}

function createDiscovery({ roots }) {
  if (!roots || typeof roots.resolve !== 'function') {
    throw refuse('ERATCHETGIT', 'repository discovery needs the configured root authority');
  }

  function discover(candidate) {
    // This is the only client-controlled pathname read in this module. Every
    // Git-derived pathname below is re-canonicalized and the worktree root is
    // re-authorized before an identity is returned.
    const contained = roots.resolve(candidate);
    const start = canonicalDirectory(contained, 'workspace candidate');

    const reportedRoot = gitValue(start, '--show-toplevel');
    const root = canonicalDirectory(reportedRoot, 'Git working-tree root');
    const authorizedRoot = roots.resolve(root);
    if (authorizedRoot !== root) {
      // `roots.resolve` normally returns the same canonical string. Keeping the
      // equality explicit prevents a future resolver from authorizing one path
      // and silently substituting another identity here.
      throw refuse('ERATCHETGIT', 'Git working-tree root changed during authority resolution');
    }

    const reportedCommonDir = gitValue(start, '--git-common-dir');
    const commonDir = canonicalDirectory(reportedCommonDir, 'Git common directory');

    return Object.freeze({
      kind: 'git',
      root,
      repositoryId: identity('repo', commonDir),
      worktreeId: identity('worktree', root),
    });
  }

  return { discover };
}

module.exports = { createDiscovery };
