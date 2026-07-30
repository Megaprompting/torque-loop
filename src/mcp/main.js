'use strict';

// Torque MCP: the executable entry point.
//
// The kernel, the framing, and the composed workspace surface already existed;
// what was missing was a way to LAUNCH them. Two decisions carry the weight:
//
// stdout belongs to the protocol. A diagnostic written there is not a log line,
// it is a corrupt frame, so everything this module says to a human goes to
// stderr. The 2026-07-28 revision deprecated protocol logging for the same
// reason.
//
// Roots are never inferred. Steps 2.1-2.5 built a closed allowlist, and a
// server that fell back to its working directory would widen that allowlist by
// accident on every launch — the process's cwd is whatever the client happened
// to spawn it in. So no configured root is a configuration error the operator
// sees immediately, not a server that starts fine and refuses every call.
//
// Traced by: claude-fable-5

const path = require('path');
const pkg = require('../../package.json');
const mcp = require('./server');
const stdio = require('./stdio');

const VERSION = pkg.version;
const ROOTS_ENV = 'RATCHET_MCP_ROOTS';

const USAGE = [
  'ratchet-mcp — Torque Loop MCP server (stdio transport)',
  '',
  'Usage: ratchet-mcp --root <dir> [--root <dir> ...]',
  '',
  'Options:',
  '  --root <dir>   Allow this directory as a workspace root. Repeatable.',
  '                 Must be an existing, fully qualified directory.',
  '  --help, -h     Show this message.',
  '  --version      Print the version.',
  '',
  `Environment:`,
  `  ${ROOTS_ENV}   ${path.delimiter}-separated roots, used only when no --root is given.`,
  '',
  'The server speaks newline-delimited JSON-RPC on stdin/stdout. Diagnostics go',
  'to stderr, because stdout carries the protocol.',
].join('\n');

// A dedicated parser rather than the one in src/cli.js: --root is REPEATABLE,
// and that parser stores flags in a plain object where the second --root would
// silently overwrite the first. Silently narrowing an allowlist is the wrong
// direction to be wrong in.
function parseArgs(argv) {
  const roots = [];
  const flags = { help: false, version: false };
  const errors = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      flags.help = true;
      continue;
    }
    if (arg === '--version') {
      flags.version = true;
      continue;
    }
    let value = null;
    if (arg === '--root') {
      value = argv[i + 1];
      i++;
    } else if (arg.startsWith('--root=')) {
      value = arg.slice('--root='.length);
    } else {
      // An unknown flag is refused, never ignored. A typo like `--roots` that
      // parsed as "nothing configured" would launch a server whose allowlist is
      // empty for a reason the operator cannot see.
      errors.push(`unknown argument: ${arg}`);
      continue;
    }
    if (typeof value !== 'string' || !value.length || value.startsWith('--')) {
      errors.push('--root needs a directory');
      continue;
    }
    roots.push(value);
  }

  return { roots, flags, errors };
}

// Flags win outright rather than merging with the environment: a union would
// mean an inherited variable could quietly add authority to an explicit launch,
// and the operator reading the command line would not see it.
function resolveRoots(parsed, env) {
  if (parsed.roots.length) return { roots: parsed.roots, source: '--root' };
  const raw = env && env[ROOTS_ENV];
  if (typeof raw === 'string' && raw.length) {
    const roots = raw.split(path.delimiter).filter((entry) => entry.length);
    if (roots.length) return { roots, source: ROOTS_ENV };
  }
  return { roots: [], source: 'nothing' };
}

// Returns an exit code for the paths that end immediately, or null when the
// server is attached and the process should stay alive on stdin. Streams are
// injected so this is drivable in-process by a test without spawning anything.
function start(argv, io) {
  const out = io.stdout;
  const err = io.stderr;
  const parsed = parseArgs(argv);

  if (parsed.flags.help) {
    err.write(USAGE + '\n');
    return { exitCode: 0 };
  }
  if (parsed.flags.version) {
    err.write(VERSION + '\n');
    return { exitCode: 0 };
  }
  if (parsed.errors.length) {
    for (const message of parsed.errors) err.write(`ratchet-mcp: ${message}\n`);
    err.write(USAGE + '\n');
    return { exitCode: 2 };
  }

  const { roots, source } = resolveRoots(parsed, io.env || {});
  if (!roots.length) {
    err.write('ratchet-mcp: no workspace root configured, so every request would be refused\n');
    err.write(`ratchet-mcp: pass --root <dir> (repeatable) or set ${ROOTS_ENV}\n`);
    return { exitCode: 2 };
  }

  let server;
  try {
    server = mcp.createServer({ roots });
  } catch (e) {
    // Root validation is the one configuration check that must fail loudly:
    // createRoots refuses a root that does not exist, is not a directory, or is
    // not fully qualified, and the operator needs the reason now.
    err.write(`ratchet-mcp: ${e && e.message ? e.message : e}\n`);
    return { exitCode: 2 };
  }

  const attached = stdio.attach(server, { input: io.stdin, output: out });
  err.write(`ratchet-mcp ${VERSION} — ${roots.length} root(s) from ${source}\n`);
  return { exitCode: null, attached, server };
}

function run(argv, overrides) {
  const io = Object.assign({
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
    env: process.env,
  }, overrides);

  const started = start(argv.slice(2), io);
  if (started.exitCode !== null) {
    process.exitCode = started.exitCode;
    return started;
  }

  // The client closing stdin is the ordinary end of a stdio session, not a
  // fault. A broken stdout is the same event seen from the other side: there is
  // nobody left to answer, and a thrown EPIPE would turn that into a crash.
  io.stdin.on('end', () => { process.exitCode = 0; });
  io.stdout.on('error', (e) => {
    if (!e || e.code !== 'EPIPE') throw e;
    process.exitCode = 0;
  });
  if (typeof io.stdin.resume === 'function') io.stdin.resume();
  return started;
}

module.exports = { run, start, parseArgs, resolveRoots, USAGE, VERSION, ROOTS_ENV };
