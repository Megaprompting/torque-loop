'use strict';

// Zero-dependency plugin-shape test. Run: node test/plugin-shape.test.js
// Validates the packaging surface Claude Code and Codex expect — so a broken plugin
// package (missing SKILL.md, drifted version, stale command name) fails CI
// before a user ever installs it. Reads the real repo, writes nothing.

const path = require('path');
const fs = require('fs');
const assert = require('assert');

const root = path.resolve(__dirname, '..');
const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8'));
const exists = (rel) => fs.existsSync(path.join(root, rel));
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const frontmatter = (text) => {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  return m ? m[1] : null;
};

let passed = 0;
function ok(name, fn) {
  fn();
  passed++;
  process.stdout.write(`  ok  ${name}\n`);
}

const pkg = readJson('package.json');
const claudePlugin = readJson('.claude-plugin/plugin.json');
const claudeMarket = readJson('.claude-plugin/marketplace.json');
const codexPlugin = readJson('.codex-plugin/plugin.json');
const codexMarket = readJson('.agents/plugins/marketplace.json');

ok('manifests exist and parse', () => {
  assert.ok(pkg.version, 'package.json has a version');
  assert.ok(claudePlugin.version, 'Claude plugin.json has a version');
  assert.ok(claudeMarket.metadata && claudeMarket.metadata.version, 'Claude marketplace metadata has a version');
  assert.ok(Array.isArray(claudeMarket.plugins) && claudeMarket.plugins.length, 'Claude marketplace lists plugins');
  assert.ok(codexPlugin.version, 'Codex plugin.json has a version');
  assert.ok(Array.isArray(codexMarket.plugins) && codexMarket.plugins.length, 'Codex marketplace lists plugins');
});

ok('versions are aligned across every surface', () => {
  const v = pkg.version;
  assert.strictEqual(claudePlugin.version, v, 'Claude plugin.json version matches package.json');
  assert.strictEqual(claudeMarket.metadata.version, v, 'Claude marketplace metadata version matches package.json');
  assert.strictEqual(claudeMarket.plugins[0].version, v, 'Claude marketplace plugin version matches package.json');
  assert.strictEqual(codexPlugin.version, v, 'Codex plugin.json version matches package.json');
});

ok('Codex manifest has required install metadata', () => {
  assert.strictEqual(codexPlugin.name, 'torque-loop', 'Codex plugin name matches repo identity');
  assert.strictEqual(codexPlugin.skills, './skills/', 'Codex manifest points at skills');
  assert.ok(codexPlugin.author && codexPlugin.author.name, 'Codex manifest has author.name');
  assert.ok(codexPlugin.interface, 'Codex manifest has interface metadata');
  for (const field of ['displayName', 'shortDescription', 'longDescription', 'developerName', 'category']) {
    assert.ok(codexPlugin.interface[field], `Codex interface.${field} exists`);
  }
  assert.ok(Array.isArray(codexPlugin.interface.capabilities), 'Codex interface.capabilities is an array');
  assert.ok(Array.isArray(codexPlugin.interface.defaultPrompt), 'Codex interface.defaultPrompt is an array');
});

ok('Codex marketplace installs this repo as a local plugin source', () => {
  const entry = codexMarket.plugins.find((p) => p.name === codexPlugin.name);
  assert.ok(entry, 'Codex marketplace has a torque-loop entry');
  assert.deepStrictEqual(entry.source, { source: 'local', path: './' });
  assert.deepStrictEqual(entry.policy, { installation: 'AVAILABLE', authentication: 'ON_INSTALL' });
  assert.strictEqual(entry.category, 'Developer Tools');
});

ok('CLI VERSION constants match package.json', () => {
  const cli = require('../src/cli');
  const evolve = require('../src/evolve/index');
  assert.strictEqual(cli.VERSION, pkg.version, 'ratchet CLI version matches package.json');
  assert.strictEqual(evolve.VERSION, pkg.version, 'ratchet-evolve CLI version matches package.json');
});

ok('hooks/hooks.json exists and parses', () => {
  const hooks = readJson('hooks/hooks.json');
  assert.ok(hooks.hooks, 'hooks.json has a hooks map');
});

ok('every hooks.json command resolves to a real CLI hook subcommand', () => {
  // cmdHook's default: returns silently (hooks must never break a session), so a
  // renamed or misspelled subcommand in hooks.json would no-op forever in every
  // installed copy. This is the only tripwire for that drift.
  const hooks = readJson('hooks/hooks.json');
  const wired = [];
  for (const entries of Object.values(hooks.hooks)) {
    for (const entry of entries) {
      for (const h of entry.hooks || []) {
        const m = /bin\/ratchet"?\s+hook\s+([a-z][a-z-]*)/.exec(h.command || '');
        assert.ok(m, `hook command is a ratchet hook invocation: ${h.command}`);
        wired.push(m[1]);
      }
    }
  }
  assert.ok(wired.length >= 3, 'hooks.json wires at least session-start, post-edit, stop-check');
  const body = /function cmdHook[\s\S]*?\r?\n\}/.exec(read('src/cli.js'));
  assert.ok(body, 'src/cli.js defines cmdHook');
  const handled = new Set(Array.from(body[0].matchAll(/case '([^']+)':/g), (m) => m[1]));
  for (const sub of wired) {
    assert.ok(handled.has(sub), `hooks.json wires "hook ${sub}" but cmdHook does not handle it (silent no-op)`);
  }
});

ok('every bin target from package.json exists', () => {
  for (const [name, rel] of Object.entries(pkg.bin || {})) {
    assert.ok(exists(rel), `bin ${name} -> ${rel} exists`);
  }
  assert.ok(exists('bin/ratchet'), 'bin/ratchet exists');
  assert.ok(exists('bin/ratchet-evolve'), 'bin/ratchet-evolve exists');
});

ok('required plugin directories exist', () => {
  for (const d of ['.agents', '.claude-plugin', '.codex-plugin', 'skills', 'agents', 'hooks', 'bin', 'src']) {
    assert.ok(fs.existsSync(path.join(root, d)), `${d}/ exists`);
  }
});

const skillDirs = fs
  .readdirSync(path.join(root, 'skills'), { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name);

ok('every skill has a SKILL.md with frontmatter + description', () => {
  assert.ok(skillDirs.length > 0, 'at least one skill');
  for (const name of skillDirs) {
    const rel = `skills/${name}/SKILL.md`;
    assert.ok(exists(rel), `${rel} exists`);
    const fm = frontmatter(read(rel));
    assert.ok(fm, `${name}: SKILL.md has YAML frontmatter`);
    assert.ok(/(^|\n)description:/.test(fm), `${name}: SKILL.md frontmatter has a description`);
  }
});

ok('every agent has a .md with frontmatter', () => {
  const agents = fs.readdirSync(path.join(root, 'agents')).filter((f) => f.endsWith('.md'));
  assert.ok(agents.length > 0, 'at least one agent');
  for (const f of agents) {
    const fm = frontmatter(read(`agents/${f}`));
    assert.ok(fm, `agents/${f} has frontmatter`);
    assert.ok(/(^|\n)description:/.test(fm), `agents/${f} frontmatter has a description`);
  }
});

ok('the evolution command was renamed to /ratchet:evolve', () => {
  assert.ok(skillDirs.includes('evolve'), 'skills/evolve exists');
  assert.ok(!skillDirs.includes('ratchet-evolve'), 'skills/ratchet-evolve was removed');
});

ok('README command list matches the skill folders', () => {
  const readme = read('README.md');
  for (const name of skillDirs) {
    assert.ok(readme.includes(`/ratchet:${name}`), `README references /ratchet:${name}`);
  }
});

ok('README version examples match package.json (readouts must not drift)', () => {
  // The project's whole claim is state/readout trust — a README that shows a
  // stale `ratchet --version` output is the exact poison the receipt hunts.
  // Any `-> ratchet <semver>` example in the README is a version surface.
  const readme = read('README.md');
  const hits = readme.match(/->\s*ratchet\s+\d+\.\d+\.\d+/g) || [];
  assert.ok(hits.length >= 1, 'README shows a ratchet --version example');
  for (const hit of hits) {
    const v = hit.match(/(\d+\.\d+\.\d+)/)[1];
    assert.strictEqual(v, pkg.version, `README version example "${hit.trim()}" matches package.json`);
  }
});

ok('README does not mention removed command names', () => {
  const readme = read('README.md');
  assert.ok(!readme.includes('/ratchet:ratchet-evolve'), 'no stale /ratchet:ratchet-evolve in README');
});

ok('the /ratchet:map fog gate is wired into the prompt catalog', () => {
  // The generic loops above already force skills/map to carry frontmatter and be
  // listed in the README. PROMPTS.md sync is otherwise untested, so guard it here:
  // the map skill exists AND its canonical intent lives in the prompt source of truth.
  assert.ok(skillDirs.includes('map'), 'skills/map exists');
  const prompts = read('reference/PROMPTS.md');
  assert.ok(prompts.includes('/ratchet:map'), 'PROMPTS.md references /ratchet:map');
});

ok('the living unknowns-map ships as templates and threads through build → handoff', () => {
  // The map is not a pre-build formality: it has a file shape, and it stays alive
  // through the build as deviation notes that surface again at handoff.
  assert.ok(exists('templates/unknowns-map.md'), 'templates/unknowns-map.md exists');
  assert.ok(exists('templates/deviation-note.md'), 'templates/deviation-note.md exists');
  assert.ok(/deviation/i.test(read('skills/build/SKILL.md')), 'build records map deviations');
  assert.ok(/deviation/i.test(read('skills/handoff/SKILL.md')), 'handoff surfaces map deviations');
});

ok('the probe primitive threads map → build → handoff with a disposal rule', () => {
  // A probe is a build whose proof-of-done is knowledge, not code: the map can
  // close an unknown by probe, build runs it as build-for-learn, handoff reports
  // whether its code died or was explicitly promoted.
  assert.ok(exists('templates/probe-card.md'), 'templates/probe-card.md exists');
  assert.ok(/disposal/i.test(read('templates/probe-card.md')), 'the probe card carries a disposal rule');
  const mapSkill = read('skills/map/SKILL.md');
  assert.ok(/\bprobe\b/i.test(mapSkill), 'map can close an unknown by probe');
  assert.ok(/park/i.test(mapSkill), 'map OPEN items can be parked with an owner');
  assert.ok(/build-for-learn/i.test(read('skills/build/SKILL.md')), 'build distinguishes build-for-learn from build-for-keep');
  assert.ok(/probe/i.test(read('skills/handoff/SKILL.md')), 'handoff surfaces probe outcomes');
  assert.ok(/probe/i.test(read('reference/PROMPTS.md')), 'the prompt source of truth knows the probe closure');
  assert.ok(/probe/i.test(read('templates/unknowns-map.md')), 'the map template offers probe as a closure');
});

// --- the closure gate reaches the prose too (0.8) ---------------------------
// Every one of these is prompt-level guidance. The CLI enforcement lives in
// src/lifecycle.js + the close verbs; these guards only stop the prose from
// drifting back to teaching the loop that a checkpoint is an ending.

ok('the canonical path forces verify, and the prompt catalog knows closure', () => {
  const prompts = read('reference/PROMPTS.md');
  const canonical = /\*\*The path every prompt forces:\*\*[^\r\n]*/.exec(prompts);
  assert.ok(canonical, 'PROMPTS.md states the canonical path');
  assert.ok(/verify/.test(canonical[0]), `the canonical path names verify: ${canonical[0]}`);
  assert.ok(/artifact close|no proof → no close/i.test(prompts), 'the prompt source of truth knows the closure gate');
});

ok('ignite carries a verify step and the current A0–A4 table', () => {
  const ignite = read('skills/ignite/SKILL.md');
  assert.ok(/verify/i.test(ignite), 'ignite runs a verify step');
  for (const level of ['A0', 'A1', 'A2', 'A3', 'A4']) {
    assert.ok(new RegExp(`\\b${level}\\b`).test(ignite), `ignite's aperture table lists ${level}`);
  }
  // the table must match the shipped sequences, not a remembered older set
  const scoring = require('../src/scoring');
  for (const band of scoring.APERTURE_LEVELS) {
    const row = new RegExp(`\\|\\s*${band.level}\\b[^\\r\\n]*`).exec(ignite);
    assert.ok(row, `ignite has a table row for ${band.level}`);
    for (const step of band.sequence) {
      assert.ok(row[0].includes(step), `${band.level} row names "${step}" (row: ${row[0].trim()})`);
    }
  }
});

ok('loop cycles through verify and cannot stop on a score alone', () => {
  const loop = read('skills/loop/SKILL.md');
  assert.ok(/build\s*→\s*attack\s*→\s*patch\s*→\s*verify\s*→\s*compile/.test(loop), 'the cycle runs verify before compile');
  assert.ok(/workflowClosed|workflow closure/i.test(loop), 'the stop condition reads workflow closure, not just loopClear');
  assert.ok(/loopClear/.test(loop), 'and still reads loopClear');
  assert.ok(
    !/declare convergence and stop/.test(loop),
    'the "converged" escape is gone: converging on an unclosed workflow is stopping early'
  );
});

ok('patch resolves the ORIGINAL defect instead of birthing a resolved one', () => {
  const patch = read('skills/patch/SKILL.md');
  assert.ok(/ratchet defect resolve [^\r\n]*--evidence/.test(patch), 'patch serializes with defect resolve --evidence');
  assert.ok(
    !/defect add[^\r\n]*"status"\s*:\s*"(resolved|closed|waived|superseded)"/.test(patch),
    'no born-resolved defect example — a defect cannot be born terminal'
  );
});

ok('attack and verify name the artifact they are about', () => {
  for (const rel of ['skills/attack/SKILL.md', 'skills/verify/SKILL.md']) {
    const text = read(rel);
    assert.ok(/"artifact"\s*:\s*"<id>"/.test(text), `${rel} payload names "artifact":"<id>"`);
  }
});

ok('verify binds its run and closes on green', () => {
  const verify = read('skills/verify/SKILL.md');
  assert.ok(/ratchet-evolve verify [^\r\n]*--artifact/.test(verify), 'verify runs bound to an artifact');
  // Not "the words appear somewhere": the log append EXAMPLE must carry both
  // fields, because a caller copies that block. The hash alone cannot see a
  // metadata-only revision, so the rev has to travel with it.
  const append = /ratchet-evolve log append[\s\S]*?```/.exec(verify);
  assert.ok(append, 'verify shows a log append example');
  assert.ok(/verifiedHash/.test(append[0]), 'the log append example carries verifiedHash');
  assert.ok(/verifiedRev/.test(append[0]), 'the log append example carries verifiedRev');
  assert.ok(/ratchet artifact close/.test(verify), 'a green bound run ends by closing the artifact');
});

ok('compile teaches CHECKPOINT, not CLOSED', () => {
  const compile = read('skills/compile/SKILL.md');
  assert.ok(/CHECKPOINT/.test(compile), 'compile calls itself a checkpoint');
  assert.ok(/not closure|NOT CLOSED/i.test(compile), 'and says out loud that it is not closure');
  assert.ok(/ratchet artifact close/.test(compile), 'and names the verb that does close');
  assert.ok(
    !/defect add[^\r\n]*"status"\s*:\s*"(resolved|closed|waived|superseded)"/.test(compile),
    'no terminal-status defect-add example'
  );
});

ok('handoff checkpoints through compile done, never the scalar bypass', () => {
  const handoff = read('skills/handoff/SKILL.md');
  assert.ok(/ratchet compile done/.test(handoff), 'handoff uses compile done');
  assert.ok(!/state set (dirty|lastCompileAt)/.test(handoff), 'and not the removed scalar bypass');
});

process.stdout.write(`\n${passed} passed\n`);
