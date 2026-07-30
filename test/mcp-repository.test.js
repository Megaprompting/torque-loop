'use strict';

// Torque MCP build-order step 2.3: Git-root discovery and local repository
// identity. Run: node test/mcp-repository.test.js
//
// A subdirectory is not a workspace identity. Discovery converges on the
// innermost Git top-level, re-proves that top-level against the configured root
// authority, and identifies the local repository by its common Git directory.
// Linked worktrees therefore share one repository identity while retaining
// distinct worktree identities. Branches, commits, and remotes are state, not
// identity.
//
// Written RED first against an absent module.
// Traced by: openai-codex-gpt-5

const assert = require('assert');
const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.realpathSync.native(
  fs.mkdtempSync(path.join(os.tmpdir(), 'ratchet-mcp-repository-test-'))
);
process.env.RATCHET_DATA_DIR = path.join(tmp, 'state');
process.env.RATCHET_EVOLVE_LOG = path.join(tmp, 'evolve-log.jsonl');

const workspace = require('../src/mcp/workspace');
const repository = require('../src/mcp/repository');

let passed = 0;
const failures = [];
function ok(name, fn) {
  try {
    fn();
    passed++;
    process.stdout.write(`  ok    ${name}\n`);
  } catch (e) {
    failures.push(name);
    process.stdout.write(`  FAIL  ${name}\n        ${e && e.message ? e.message : e}\n`);
  }
}

let n = 0;
function fixture(label) {
  const dir = path.join(tmp, `${label}-${n++}`);
  fs.mkdirSync(dir, { recursive: true });
  return fs.realpathSync.native(dir);
}

function cleanGitEnv(extra) {
  const env = Object.assign({}, process.env, extra);
  for (const key of Object.keys(env)) {
    if (key.startsWith('GIT_')) delete env[key];
  }
  return Object.assign(env, extra);
}

function git(cwd, args, extraEnv) {
  return childProcess.execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    env: cleanGitEnv(extraEnv),
  });
}

function initRepo(label, commit) {
  const dir = fixture(label);
  git(dir, ['init', '--quiet']);
  if (commit) {
    fs.writeFileSync(path.join(dir, 'tracked.txt'), 'one\n', 'utf8');
    git(dir, ['add', 'tracked.txt']);
    git(dir, [
      '-c', 'user.name=Torque Test',
      '-c', 'user.email=torque@example.invalid',
      '-c', 'commit.gpgSign=false',
      'commit', '--quiet', '-m', 'initial',
    ]);
  }
  return dir;
}

function discovery(roots) {
  return repository.createDiscovery({ roots: workspace.createRoots(roots) });
}

function refuses(discoverer, candidate, code, why) {
  let err = null;
  try {
    discoverer.discover(candidate);
  } catch (e) {
    err = e;
  }
  assert.ok(err, `must refuse ${why}`);
  assert.strictEqual(err.code, code, `refusal for ${why} must be ${code}, got ${err.code}`);
  return err;
}

ok('G1 a subdirectory resolves to its canonical Git top-level', () => {
  const repo = initRepo('g1 repo with spaces');
  const deep = path.join(repo, 'a', 'b');
  fs.mkdirSync(deep, { recursive: true });
  const found = discovery([repo]).discover(deep);
  assert.strictEqual(found.kind, 'git');
  assert.strictEqual(found.root, fs.realpathSync.native(repo));
});

ok('G2 root and subdirectory spellings converge on one opaque identity', () => {
  const repo = initRepo('g2');
  const deep = path.join(repo, 'deep');
  fs.mkdirSync(deep);
  const find = discovery([repo]);
  const fromRoot = find.discover(repo);
  const fromDeep = find.discover(deep);
  assert.strictEqual(fromRoot.repositoryId, fromDeep.repositoryId);
  assert.strictEqual(fromRoot.worktreeId, fromDeep.worktreeId);
  assert.ok(Object.isFrozen(fromRoot), 'the established identity record is immutable');
  assert.deepStrictEqual(
    Object.keys(fromRoot).sort(),
    ['kind', 'repositoryId', 'root', 'worktreeId'].sort(),
    'only the authorized root and opaque identities leave discovery'
  );
  assert.match(fromRoot.repositoryId, /^repo_[A-Za-z0-9_-]{43}$/);
  assert.match(fromRoot.worktreeId, /^worktree_[A-Za-z0-9_-]{43}$/);
  assert.ok(!fromRoot.repositoryId.includes(path.basename(repo)),
    'an identity must not expose the pathname it was derived from');
});

ok('G3 a non-Git directory is not a workspace', () => {
  const plain = fixture('g3');
  refuses(discovery([plain]), plain, 'ERATCHETGIT', 'a directory outside any Git working tree');
});

ok('G4 a file cannot be opened as a workspace', () => {
  const repo = initRepo('g4');
  const file = path.join(repo, 'file.txt');
  fs.writeFileSync(file, 'x', 'utf8');
  refuses(discovery([repo]), file, 'ERATCHETGIT', 'a file rather than a directory');
});

ok('G5 the configured root authority is checked before Git discovery', () => {
  const allowed = fixture('g5-allowed');
  const outside = initRepo('g5-outside');
  refuses(discovery([allowed]), outside, 'ERATCHETPATHESCAPE', 'a Git repository outside the allowlist');
});

ok('G6 a discovered Git top-level outside the allowlist is refused too', () => {
  const repo = initRepo('g6');
  const allowedSubdirectory = path.join(repo, 'allowed');
  fs.mkdirSync(allowedSubdirectory);
  const find = discovery([allowedSubdirectory]);
  refuses(find, allowedSubdirectory, 'ERATCHETPATHESCAPE',
    'a subdirectory whose repository root crosses the configured authority boundary');
});

ok('G7 an internal directory link converges on the real repository root', () => {
  const base = fixture('g7');
  const repo = path.join(base, 'repo');
  const link = path.join(base, 'repo-link');
  fs.mkdirSync(repo);
  git(repo, ['init', '--quiet']);
  fs.symlinkSync(repo, link, 'junction');
  const found = discovery([base]).discover(link);
  assert.strictEqual(found.root, fs.realpathSync.native(repo));
});

ok('G8 an inner repository wins over its containing repository', () => {
  const outer = initRepo('g8-outer');
  const inner = path.join(outer, 'nested');
  fs.mkdirSync(inner);
  git(inner, ['init', '--quiet']);
  const find = discovery([outer]);
  const outerFound = find.discover(outer);
  const innerFound = find.discover(inner);
  assert.strictEqual(innerFound.root, fs.realpathSync.native(inner));
  assert.notStrictEqual(innerFound.repositoryId, outerFound.repositoryId,
    'a nested repository has its own object database and identity');
});

ok('G9 sibling repositories have different repository identities', () => {
  const base = fixture('g9');
  const a = path.join(base, 'a');
  const b = path.join(base, 'b');
  fs.mkdirSync(a);
  fs.mkdirSync(b);
  git(a, ['init', '--quiet']);
  git(b, ['init', '--quiet']);
  const find = discovery([base]);
  assert.notStrictEqual(find.discover(a).repositoryId, find.discover(b).repositoryId);
});

ok('G10 linked worktrees share a repository identity but not a worktree identity', () => {
  const base = fixture('g10');
  const main = path.join(base, 'main');
  const linked = path.join(base, 'linked');
  fs.mkdirSync(main);
  git(main, ['init', '--quiet']);
  fs.writeFileSync(path.join(main, 'tracked.txt'), 'one\n', 'utf8');
  git(main, ['add', 'tracked.txt']);
  git(main, [
    '-c', 'user.name=Torque Test',
    '-c', 'user.email=torque@example.invalid',
    '-c', 'commit.gpgSign=false',
    'commit', '--quiet', '-m', 'initial',
  ]);
  git(main, ['worktree', 'add', '--quiet', '--detach', linked, 'HEAD']);

  const primary = discovery([main]).discover(main);
  // The linked worktree is authorized on its own. Its shared Git metadata is
  // outside that allowlist, so it may inform the digest but must not become a
  // returned path or workspace capability.
  const secondary = discovery([linked]).discover(linked);
  assert.strictEqual(primary.repositoryId, secondary.repositoryId);
  assert.notStrictEqual(primary.worktreeId, secondary.worktreeId);
  assert.notStrictEqual(primary.root, secondary.root);
  assert.ok(!Object.prototype.hasOwnProperty.call(secondary, 'commonDir'),
    'the Git metadata path is identity material, not workspace authority or output');
});

ok('G11 ambient Git directory variables cannot redirect discovery', () => {
  const expected = initRepo('g11-expected');
  const decoy = initRepo('g11-decoy');
  const oldDir = process.env.GIT_DIR;
  const oldTree = process.env.GIT_WORK_TREE;
  process.env.GIT_DIR = path.join(decoy, '.git');
  process.env.GIT_WORK_TREE = decoy;
  try {
    const found = discovery([expected]).discover(expected);
    assert.strictEqual(found.root, fs.realpathSync.native(expected));
  } finally {
    if (oldDir === undefined) delete process.env.GIT_DIR;
    else process.env.GIT_DIR = oldDir;
    if (oldTree === undefined) delete process.env.GIT_WORK_TREE;
    else process.env.GIT_WORK_TREE = oldTree;
  }
});

ok('G12 branch and HEAD changes do not change repository or worktree identity', () => {
  const repo = initRepo('g12', true);
  const find = discovery([repo]);
  const before = find.discover(repo);
  git(repo, ['switch', '--quiet', '-c', 'identity-test']);
  fs.writeFileSync(path.join(repo, 'tracked.txt'), 'two\n', 'utf8');
  git(repo, ['add', 'tracked.txt']);
  git(repo, [
    '-c', 'user.name=Torque Test',
    '-c', 'user.email=torque@example.invalid',
    '-c', 'commit.gpgSign=false',
    'commit', '--quiet', '-m', 'second',
  ]);
  const after = find.discover(repo);
  assert.strictEqual(after.repositoryId, before.repositoryId);
  assert.strictEqual(after.worktreeId, before.worktreeId);
});

fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
process.stdout.write(`\n${passed} passed, ${failures.length} failed\n`);
if (failures.length) process.exitCode = 1;
