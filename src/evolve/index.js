'use strict';

const fs = require('fs');

const { snapshot } = require('./snapshot');
const { scoreAndChoose } = require('./score');
const { verify } = require('./verify');
const journal = require('./journal');
const pressure = require('./pressure');
const { PRESSURES, MODES } = require('./schema');

const VERSION = require('../../package.json').version;

function out(s) {
  process.stdout.write(String(s) + '\n');
}

// Parse: positionals + `--key value` / `--key=value` / boolean `--flag`.
function parseArgs(argv) {
  const pos = [];
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq >= 0) {
        opts[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const key = a.slice(2);
        const next = argv[i + 1];
        if (next != null && !next.startsWith('--')) {
          opts[key] = next;
          i++;
        } else {
          opts[key] = true;
        }
      }
    } else {
      pos.push(a);
    }
  }
  return { pos, opts };
}

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

// --- renderers -------------------------------------------------------------

function renderScore(result) {
  const rows = result.mutations
    .map(
      (m) =>
        `| ${m.rank} | ${m.name} | ${m.impact} | ${m.evidence} | ${m.reversibility} | ${m.goalFit} | ${m.risk} | ${m.complexity} | **${m.score}** |`
    )
    .join('\n');
  const o = [];
  o.push('### Mutation judging');
  o.push('Score = Impact × Evidence × Reversibility × Goal-Fit − Risk − Complexity (factors 1–5).');
  o.push('');
  o.push('| # | Mutation | Imp | Evi | Rev | Fit | Risk | Cpx | Score |');
  o.push('| - | -------- | --- | --- | --- | --- | ---- | --- | ----- |');
  o.push(rows);
  o.push('');
  o.push(`**Chosen mutation:** ${result.chosen.name} (score ${result.chosen.score}).`);
  if (result.runnerUp) {
    o.push(`Beats runner-up "${result.runnerUp.name}" (${result.runnerUp.score}) by ${result.margin}.`);
  }
  return o.join('\n');
}

function renderVerify(v) {
  const o = [];
  o.push(`### Verify — ${v.target} (${v.mode})`);
  o.push(`Result: **${v.result.toUpperCase()}**`);
  // The binding is always stated, including when there is none — an unbound run
  // is evidence about a file and cannot authorize closing a record.
  if (v.artifactId) {
    o.push(`Bound to \`${v.artifactId}\` rev ${v.verifiedRev} · ${v.hashScope} hash \`${String(v.verifiedHash).slice(0, 8)}\``);
    if (v.downgradeReason) o.push(`⚠ ${v.downgradeReason}`);
  } else {
    o.push('Bound to: — nothing (unbound: this cannot authorize closing an artifact; re-run with `--artifact <id>`)');
  }
  if (v.commands.length) {
    for (const c of v.commands) {
      o.push('');
      o.push(`- \`${c.command}\` → exit ${c.exitCode}${c.timedOut ? ' (timed out)' : ''} — ${c.pass ? 'PASS' : 'FAIL'}`);
      if (!c.pass && c.stderrTail) o.push('```\n' + c.stderrTail + '\n```');
      else if (c.stdoutTail) o.push('```\n' + c.stdoutTail.split('\n').slice(-8).join('\n') + '\n```');
    }
  } else {
    o.push('');
    o.push('No test command — manual checks required (evidence, not self-grading):');
    o.push(v.manualChecks.map((m) => `- [ ] ${m}`).join('\n'));
  }
  return o.join('\n');
}

function renderStatus(s) {
  if (!s.events) return '### Evolve log\n_empty — no evolution events recorded yet._';
  const o = [];
  o.push('### Evolve log');
  o.push(`- Events: ${s.events}`);
  o.push(`- Kept: ${s.kept}`);
  o.push(`- Reverted: ${s.reverted}`);
  if (s.revertedAndLearned) {
    o.push(`- Reverted & learned: ${s.revertedAndLearned} (successful loop — corrected knowledge, no bad code kept)`);
  }
  o.push(`- Asks: ${s.asks}`);
  o.push('- Active targets:');
  for (const t of s.targets) o.push(`  - ${t}`);
  if (s.last) {
    o.push(`- Last verdict: ${s.last.verdict} (${s.last.id})`);
    if (s.last.seam && s.last.seam.seamMatch) {
      o.push(`- Last seam match: ${s.last.seam.seamMatch}${s.last.seam.shipSeam ? ` (ship seam: ${s.last.seam.shipSeam})` : ''}`);
    }
    if (s.last.nextEdge) o.push(`- Next edge: ${s.last.nextEdge}`);
  }
  return o.join('\n');
}

function renderNext(s) {
  const edge = s.last && s.last.nextEdge ? s.last.nextEdge : '';
  if (!edge) return '### Next edge\n_none recorded — run an evolve iteration first._';
  const o = ['### Next edge', edge];
  if (s.last && s.last.target) o.push('', `Target: ${s.last.target}`);
  return o.join('\n');
}

// --- dispatch --------------------------------------------------------------

function run(argv) {
  const args = argv.slice(2);
  const { pos, opts } = parseArgs(args);
  const cwd = process.cwd();
  const asJson = Boolean(opts.json);
  const [group, sub] = pos;

  // `--version` / `--help` parse into opts, not pos, so handle them before the
  // positional dispatch — otherwise `ratchet-evolve --version` prints help.
  if (opts.version) return out(`ratchet-evolve ${VERSION}`);
  if (opts.help && group == null) return help();

  switch (group) {
    case undefined:
    case 'help':
    case '-h':
    case '--help':
      return help();

    case 'version':
    case '-v':
    case '--version':
      return out(`ratchet-evolve ${VERSION}`);

    case 'snapshot': {
      const target = sub;
      const snap = snapshot({ target, goal: opts.goal || '', mode: opts.mode || 'auto', cwd });
      return out(JSON.stringify(snap, null, 2));
    }

    case 'score': {
      // `score mutation <json>` or `score <json>`
      const payloadArg = sub === 'mutation' ? pos[2] : sub;
      const result = scoreAndChoose(readPayload(payloadArg));
      return out(asJson ? JSON.stringify(result, null, 2) : renderScore(result));
    }

    case 'verify': {
      const target = sub;
      if (!target) throw new Error('usage: ratchet-evolve verify <target> [--test "cmd"] [--mode m] [--artifact <id>]');
      // --artifact binds the run to a state record, so the evidence carries the
      // exact revision + hash `log append` will demand back.
      const artifactId = typeof opts.artifact === 'string' ? opts.artifact.trim() : '';
      let artifact = null;
      if (artifactId) {
        const s = require('../state').loadState(cwd);
        const matches = (s.artifacts || []).filter((a) => a && a.id === artifactId);
        if (matches.length > 1) throw new Error(`${matches.length} artifacts share the id "${artifactId}" — repair the store first`);
        artifact = matches[0];
        if (!artifact) throw new Error(`no artifact with id "${artifactId}"`);
      }
      const v = verify({ target, testCommand: opts.test, mode: opts.mode || 'auto', cwd, artifact });
      return out(asJson ? JSON.stringify(v, null, 2) : renderVerify(v));
    }

    case 'log': {
      if (sub === 'append') {
        // verifiedHash travels in the payload (it comes straight out of
        // `verify --json`) but it is not an event field — it is the proof that
        // the bytes have not moved since the harness ran.
        const payload = readPayload(pos[2]);
        const { verifiedHash, verifiedRev, ...fields } = payload || {};
        const event = journal.appendEvent(cwd, fields, { verifiedHash, verifiedRev });
        return out(`logged ${event.id} — ${event.target} — ${event.verdict}`);
      }
      // show
      const events = journal.readEvents(cwd);
      return out(asJson ? JSON.stringify(events, null, 2) : renderStatus(journal.status(cwd)));
    }

    case 'status': {
      const s = journal.status(cwd);
      return out(asJson ? JSON.stringify(s, null, 2) : renderStatus(s));
    }

    case 'next': {
      const s = journal.status(cwd);
      if (asJson) {
        const edge = s.last && s.last.nextEdge ? s.last.nextEdge : '';
        return out(JSON.stringify({ nextEdge: edge, from: s.last ? s.last.id : null, target: s.last ? s.last.target : null }, null, 2));
      }
      return out(renderNext(s));
    }

    case 'pressure': {
      const info = pressure.suggest(sub || 'code');
      return out(asJson ? JSON.stringify(info, null, 2) : JSON.stringify(info, null, 2));
    }

    default:
      process.stderr.write(`unknown command: ${group}\n`);
      help();
      process.exitCode = 2;
  }
}

function help() {
  out(
    [
      `ratchet-evolve ${VERSION} — bounded artifact evolution helpers`,
      '',
      'The model drives the loop; these helpers make it deterministic and evidence-gated.',
      '',
      '  ratchet-evolve snapshot <target> [--goal g] [--mode m]   capture baseline (hash, git, mode)',
      '  ratchet-evolve score mutation <json>                     rank candidates, pick one (--json)',
      '  ratchet-evolve verify <target> [--test "cmd"] [--mode m] gather verification evidence (--json)',
      '  ratchet-evolve log append <json>                         write an evolution event (KEEP needs proof)',
      '      code KEEP also needs seam:{seamMatch:"exact",...} or seam.waiver:{by,reason} — wrong proof → no ship',
      '  ratchet-evolve log | status                              read the evolve log (--json)',
      '  ratchet-evolve next                                      show the last recorded next edge (--json)',
      '  ratchet-evolve pressure [mode]                           suggested pressure vector for a mode',
      '',
      `  modes:     ${MODES.join(', ')}`,
      `  pressures: ${PRESSURES.join(', ')}`,
      '',
      'Log lives at <project>/.ratchet/evolve-log.jsonl (override: RATCHET_EVOLVE_LOG).',
      'json args accept a raw string, @file, or - for stdin.',
    ].join('\n')
  );
}

module.exports = { run, VERSION, parseArgs };
