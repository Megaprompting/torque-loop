'use strict';

const { spawnSync } = require('child_process');

// Verification gathers EVIDENCE. It runs the test command and reports the raw
// result. It never decides KEEP/REVERT — that verdict is the model's, made from
// this evidence. No test command means no automated pass: the result is
// 'manual', and the SKILL must supply explicit manual checks instead.

function tail(s, n = 40) {
  if (!s) return '';
  const lines = String(s).trimEnd().split('\n');
  return lines.slice(-n).join('\n');
}

function runCommand(cmd, cwd = process.cwd(), timeout = 120000) {
  const res = spawnSync(cmd, {
    cwd,
    shell: true,
    encoding: 'utf8',
    timeout,
    maxBuffer: 10 * 1024 * 1024,
  });
  const timedOut = Boolean(res.error && res.error.code === 'ETIMEDOUT');
  return {
    command: cmd,
    exitCode: res.status,
    pass: res.status === 0 && !timedOut && !res.error,
    timedOut,
    stdoutTail: tail(res.stdout),
    stderrTail: tail(res.stderr),
  };
}

const MANUAL_CHECKS = {
  code: [
    'the change compiles / imports cleanly',
    'the targeted behavior actually changed',
    'no unrelated code was touched',
  ],
  prompt: [
    'a lazy model cannot escape the instruction',
    'the prompt still forces a concrete output',
    'it prevents self-praise and leaves durable state',
  ],
  docs: [
    'first-use path is unambiguous',
    'no contradiction with the rest of the doc',
    'no missing step between install and first success',
  ],
  workflow: ['a dry-run against a realistic scenario succeeds', 'no step silently no-ops'],
};

// Evidence has to name the exact thing it was gathered against, or `log append`
// cannot tell whether the file it is about to certify is still the file that was
// tested. Bound verification fingerprints BEFORE and AFTER: if the target moved
// under the harness (a test that rewrites its own subject is the classic case),
// the run proves nothing about either version and is refused.
function verify({ target, testCommand, mode = 'code', cwd = process.cwd(), artifact = null }) {
  const lifecycle = require('../lifecycle');
  const print = () => (artifact ? lifecycle.fingerprint(cwd, artifact) : null);
  const before = print();

  const result = testCommand
    ? (() => {
        const r = runCommand(testCommand, cwd);
        return { commands: [r], manualChecks: [], result: r.pass ? 'pass' : 'fail' };
      })()
    : { commands: [], manualChecks: MANUAL_CHECKS[mode] || MANUAL_CHECKS.code, result: 'manual' };

  const after = print();
  if (before && after && (before.hash !== after.hash || before.rev !== after.rev)) {
    throw new Error(
      `target changed during verification — "${target}" is not the file the harness started on, so the run ` +
        'proves nothing about either version. Settle the target and re-verify.'
    );
  }

  // The binding fields are always present; emptiness is stated, not omitted, so
  // an unbound verify has the same shape as a bound one.
  return {
    target,
    mode,
    ...result,
    artifactId: artifact ? artifact.id : '',
    verifiedHash: after ? after.hash : '',
    verifiedRev: after ? after.rev : null,
    hashScope: after ? after.hashScope : '',
    downgradeReason: after ? after.downgradeReason : '',
  };
}

module.exports = { verify, runCommand, MANUAL_CHECKS };
