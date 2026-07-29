'use strict';

// Zero-dependency smoke test. Run: node test/cli.test.js
// Uses an isolated temp data dir so it never touches real state.

const os = require('os');
const path = require('path');
const fs = require('fs');
const assert = require('assert');

const tmp = path.join(os.tmpdir(), 'ratchet-test-' + process.pid);
process.env.RATCHET_DATA_DIR = tmp;
// Isolate the evolve journal too, so receipt assembly never reads or writes the
// real repo's .ratchet/evolve-log.jsonl.
process.env.RATCHET_EVOLVE_LOG = path.join(tmp, 'evolve-log.jsonl');
fs.rmSync(tmp, { recursive: true, force: true });

const state = require('../src/state');
const scoring = require('../src/scoring');
const artifacts = require('../src/artifacts');
const ledger = require('../src/ledger');
const md = require('../src/markdown');
const repo = require('../src/repoSnapshot');
const gitRefs = require('../src/gitRefs');
const coldStart = require('../src/coldStart');
const receipt = require('../src/receipt');
const journal = require('../src/evolve/journal');
const cli = require('../src/cli');

let passed = 0;
function ok(name, fn) {
  fn();
  passed++;
  process.stdout.write(`  ok  ${name}\n`);
}

const cwd = process.cwd();

ok('init creates state + ledger', () => {
  const res = state.initProject(cwd, { force: true });
  assert.ok(fs.existsSync(res.statePath), 'state.json exists');
  assert.ok(fs.existsSync(res.ledgerPath), 'ledger.json exists');
});

ok('state set + get round-trips', () => {
  const s = state.loadState(cwd);
  s.objective = 'ship it';
  state.saveState(cwd, s);
  assert.strictEqual(state.loadState(cwd).objective, 'ship it');
});

ok('artifact add flips dirty and records', () => {
  const rec = artifacts.addArtifact(cwd, { title: 'core', kind: 'code', holes: ['no tests'] });
  assert.strictEqual(rec.title, 'core');
  assert.strictEqual(state.loadState(cwd).dirty, true);
});

ok('defect add hits both state and ledger', () => {
  const res = artifacts.addDefect(cwd, { severity: 'high', summary: 'boom' });
  assert.strictEqual(res.state.severity, 'high');
  assert.ok(res.ledger, 'ledger record created');
  assert.strictEqual(ledger.summary(state.loadLedger(cwd)).openDefects, 1);
});

// --- defect lifecycle (0.3 Seam Gate) ---------------------------------------

ok('defect resolve requires evidence (proof gate)', () => {
  const { state: d } = artifacts.addDefect(cwd, { severity: 'high', summary: 'needs proof' });
  assert.throws(() => cli.run(['node', 'ratchet', 'defect', 'resolve', d.id]), /evidence/);
  assert.strictEqual(state.loadState(cwd).defects.find((x) => x.id === d.id).status, 'open', 'stays open without proof');
});

ok('defect resolve with evidence clears the confidence drain', () => {
  const { state: d } = artifacts.addDefect(cwd, { severity: 'critical', summary: 'blocker' });
  const before = scoring.scoreConfidence(state.loadState(cwd)).score;
  cli.run(['node', 'ratchet', 'defect', 'resolve', d.id, '--evidence', 'ran the repro, now green']);
  const after = state.loadState(cwd).defects.find((x) => x.id === d.id);
  assert.strictEqual(after.status, 'resolved');
  assert.ok(/green/.test(after.evidence), 'resolution evidence is recorded');
  assert.ok(scoring.scoreConfidence(state.loadState(cwd)).score > before, 'resolving raises confidence');
});

ok('defect waive stops the drain (the case the 0.2 scorer was blind to)', () => {
  const { state: d } = artifacts.addDefect(cwd, { severity: 'critical', summary: 'accepted risk' });
  const before = scoring.scoreConfidence(state.loadState(cwd)).score;
  cli.run(['node', 'ratchet', 'defect', 'waive', d.id, '--owner', 'danny', '--reason', 'out of scope this release']);
  const after = state.loadState(cwd).defects.find((x) => x.id === d.id);
  assert.strictEqual(after.status, 'waived');
  assert.strictEqual(after.waivedBy, 'danny');
  assert.ok(scoring.scoreConfidence(state.loadState(cwd)).score > before, 'waiving stops the drain');
});

ok('defect waive requires both owner and reason', () => {
  const { state: d } = artifacts.addDefect(cwd, { severity: 'low', summary: 'nit' });
  assert.throws(() => cli.run(['node', 'ratchet', 'defect', 'waive', d.id, '--reason', 'x']), /owner/);
  assert.throws(() => cli.run(['node', 'ratchet', 'defect', 'waive', d.id, '--owner', 'danny']), /reason/);
});

ok('defect supersede stops the drain and records the replacement', () => {
  const { state: d } = artifacts.addDefect(cwd, { severity: 'high', summary: 'old premise' });
  const before = scoring.scoreConfidence(state.loadState(cwd)).score;
  cli.run(['node', 'ratchet', 'defect', 'supersede', d.id, '--by', 'art_live_seam_eval']);
  const after = state.loadState(cwd).defects.find((x) => x.id === d.id);
  assert.strictEqual(after.status, 'superseded');
  assert.strictEqual(after.supersededBy, 'art_live_seam_eval');
  assert.ok(scoring.scoreConfidence(state.loadState(cwd)).score > before);
});

ok('defect reopen re-drains a resolved defect', () => {
  const { state: d } = artifacts.addDefect(cwd, { severity: 'high', summary: 'flaky' });
  cli.run(['node', 'ratchet', 'defect', 'resolve', d.id, '--evidence', 'passed 100x']);
  const mid = scoring.scoreConfidence(state.loadState(cwd)).score;
  cli.run(['node', 'ratchet', 'defect', 'reopen', d.id, '--reason', 'regressed on CI']);
  assert.strictEqual(state.loadState(cwd).defects.find((x) => x.id === d.id).status, 'reopened');
  assert.ok(scoring.scoreConfidence(state.loadState(cwd)).score < mid, 'reopen re-drains confidence');
});

ok('resolving a defect syncs its ledger mirror', () => {
  const { state: d } = artifacts.addDefect(cwd, { severity: 'high', summary: 'mirror me', feature: 'router' });
  assert.ok(d.ledgerId, 'state defect links to its ledger mirror');
  cli.run(['node', 'ratchet', 'defect', 'resolve', d.id, '--evidence', 'fixed + verified live']);
  const mirror = state.loadLedger(cwd).defects.find((x) => x.id === d.ledgerId);
  assert.strictEqual(mirror.status, 'resolved', 'ledger mirror follows the state transition');
});

ok('defect list + get render without throwing', () => {
  const listOut = md.defectList(state.loadState(cwd).defects);
  assert.ok(/Defects/.test(listOut));
  const one = state.loadState(cwd).defects[0];
  assert.ok(md.defectOne(one).includes(one.id));
});

// --- artifact retraction (0.3 Seam Gate) ------------------------------------

ok('retract flips status, keeps provenance, and stops holes draining confidence', () => {
  const a = artifacts.addArtifact(cwd, { title: 'T2.3 re-scope', kind: 'docs', holes: ['premise unverified'] });
  const before = scoring.scoreConfidence(state.loadState(cwd)).score;
  cli.run([
    'node', 'ratchet', 'retract', a.id,
    '--reason', 'central premise false: endpoint exists and returns live vectors',
    '--superseded-by', 'art_live_seam_eval',
  ]);
  const after = state.loadState(cwd).artifacts.find((x) => x.id === a.id);
  assert.strictEqual(after.status, 'retracted');
  assert.strictEqual(after.retracted.keptForProvenance, true);
  assert.strictEqual(after.retracted.supersededBy, 'art_live_seam_eval');
  assert.ok(scoring.scoreConfidence(state.loadState(cwd)).score >= before, 'a retracted holey artifact stops draining');
});

ok('retract requires a reason (no silent retraction)', () => {
  const a = artifacts.addArtifact(cwd, { title: 'x', kind: 'docs' });
  assert.throws(() => cli.run(['node', 'ratchet', 'retract', a.id]), /reason/);
});

ok('friction uses 1-10 scale and ranks', () => {
  const r = scoring.scoreFriction([
    { name: 'a', leverage: 10, certainty: 10, speed: 10, risk: 10 },
    { name: 'b', leverage: 1, certainty: 1, speed: 1, risk: 1 },
  ]);
  assert.strictEqual(r.winner.name, 'a');
  assert.strictEqual(r.winner.priority, 10000);
  assert.strictEqual(r.obstacles[1].priority, 1);
});

ok('friction clamps out-of-range input', () => {
  const r = scoring.scoreFriction([{ name: 'x', leverage: 99, certainty: 0, speed: -5, risk: 7 }]);
  const x = r.obstacles[0];
  assert.strictEqual(x.leverage, 10);
  assert.strictEqual(x.certainty, 1);
  assert.strictEqual(x.speed, 1);
  assert.strictEqual(x.risk, 7);
});

ok('confidence drains on open high defect + holes + no next action', () => {
  const c = scoring.scoreConfidence(state.loadState(cwd));
  assert.ok(c.score < 100, 'score is penalized');
  assert.strictEqual(c.loopClear, false, 'loop not clear with open high defect');
  assert.ok(c.penalties.some((p) => /high defect/.test(p.reason)));
});

ok('confidence is loop-clear when clean', () => {
  const clean = {
    objective: 'done',
    nextAction: 'ship',
    defects: [{ severity: 'high', status: 'resolved' }],
    assumptions: [{ text: 'x', status: 'tested' }],
    artifacts: [{ title: 'a', holes: [] }],
    openLoops: [],
  };
  const c = scoring.scoreConfidence(clean);
  assert.strictEqual(c.loopClear, true);
  assert.ok(c.score >= 85, `expected ship-ready, got ${c.score}`);
});

ok('friction rejects non-array', () => {
  assert.throws(() => scoring.scoreFriction({ not: 'an array' }), /array/);
});

// --- aperture dial (0.4) ----------------------------------------------------

ok('aperture meters loop depth from uncertainty', () => {
  const snap = scoring.scoreAperture({ ambiguity: 0, terrain: 0, taste: 0, blastRadius: 0, reversibility: 0 });
  assert.strictEqual(snap.score, 0);
  assert.strictEqual(snap.level, 'A0');
  assert.strictEqual(snap.implement, true);
  assert.deepStrictEqual(snap.sequence, ['build', 'verify']);

  const mid = scoring.scoreAperture({ ambiguity: 1, terrain: 1, taste: 1, blastRadius: 1, reversibility: 1 });
  assert.strictEqual(mid.score, 5);
  assert.strictEqual(mid.level, 'A2');

  const max = scoring.scoreAperture({ ambiguity: 2, terrain: 2, taste: 2, blastRadius: 2, reversibility: 2 });
  assert.strictEqual(max.score, 10);
  assert.strictEqual(max.level, 'A4');
  assert.strictEqual(max.implement, false, 'A4 must not build before constraints are locked');
  assert.ok(!max.sequence.includes('build'), 'A4 produces options, not code');
});

ok('aperture defaults a missing dimension to neutral, not certain', () => {
  // 4 missing dims default to 1 each (=4) + blastRadius 2 = 6 → A2, not A0
  const a = scoring.scoreAperture({ blastRadius: 2 });
  assert.strictEqual(a.score, 6);
  assert.strictEqual(a.level, 'A2');
});

ok('aperture clamps out-of-range dimensions and rejects non-objects', () => {
  const a = scoring.scoreAperture({ ambiguity: 9, terrain: -3, taste: 2, blastRadius: 0, reversibility: 0 });
  assert.strictEqual(a.dimensions.ambiguity, 2);
  assert.strictEqual(a.dimensions.terrain, 0);
  assert.throws(() => scoring.scoreAperture([1, 2, 3]), /object/);
  assert.throws(() => scoring.scoreAperture('nope'), /object/);
});

ok('aperture renders with its metered ratchet loop', () => {
  const out = md.aperture(scoring.scoreAperture({ ambiguity: 2, terrain: 1, taste: 2, blastRadius: 1, reversibility: 1 }));
  assert.ok(/Aperture: A3 Wide/.test(out));
  assert.ok(/Metered loop/.test(out));
  assert.ok(/ratchet:build/.test(out));
});

ok('aperture routes high-uncertainty work through /ratchet:map', () => {
  // A3/A4 route through the pre-build fog gate, before build.
  const wide = scoring.scoreAperture({ ambiguity: 2, terrain: 2, taste: 1, blastRadius: 1, reversibility: 1 }); // 7 → A3
  assert.strictEqual(wide.level, 'A3');
  assert.ok(wide.sequence.includes('map'), 'A3 sequence routes through map');
  assert.ok(wide.sequence.indexOf('map') < wide.sequence.indexOf('build'), 'map comes before build');
  assert.ok(wide.mapRequired, 'A3 requires a pre-build map');

  const max = scoring.scoreAperture({ ambiguity: 2, terrain: 2, taste: 2, blastRadius: 2, reversibility: 2 }); // 10 → A4
  assert.ok(max.sequence.includes('map'), 'A4 routes through map');
  assert.ok(!max.sequence.includes('build'), 'A4 still produces options, not code');
  assert.ok(max.mapRequired);

  // The single-dimension override: "know it when I see it" taste warrants a map
  // even when the summed score sits at A0.
  const taste = scoring.scoreAperture({ ambiguity: 0, terrain: 0, taste: 2, blastRadius: 0, reversibility: 0 }); // 2 → A0
  assert.strictEqual(taste.level, 'A0');
  assert.ok(taste.mapRequired, 'high taste requires a map even at a low score');

  // Unfamiliar terrain + any goal ambiguity, below the A3 band, still earns it.
  const fog = scoring.scoreAperture({ ambiguity: 1, terrain: 2, taste: 0, blastRadius: 0, reversibility: 0 }); // 3 → A1
  assert.ok(fog.mapRequired, 'unfamiliar terrain with ambiguity earns a map');

  // Plain low-uncertainty work does not — the flag must not fire on everything.
  const narrow = scoring.scoreAperture({ ambiguity: 1, terrain: 0, taste: 0, blastRadius: 1, reversibility: 1 }); // 3 → A1
  assert.ok(!narrow.mapRequired, 'low-uncertainty work skips the map');

  // The render surfaces the requirement, and stays quiet when it does not apply.
  assert.ok(/Pre-build map:.*required/.test(md.aperture(wide)), 'render names the map requirement');
  assert.ok(!/Pre-build map/.test(md.aperture(narrow)), 'render stays quiet when a map is not required');
});

ok('markdown render does not throw on populated state', () => {
  const out = md.stateSummary(state.loadState(cwd));
  assert.ok(out.includes('Ratchet state'));
  const exp = md.fullExport(state.loadState(cwd), state.loadLedger(cwd));
  assert.ok(exp.includes('Ratchet compile'));
});

ok('compile done clears dirty, stamps lastCompileAt, records history', () => {
  cli.run(['node', 'ratchet', 'touch', 'README.md']);
  assert.strictEqual(state.loadState(cwd).dirty, true, 'touch dirties state');
  cli.run(['node', 'ratchet', 'compile', 'done']);
  const s = state.loadState(cwd);
  assert.strictEqual(s.dirty, false, 'compile done clears dirty (Stop hook stays quiet)');
  assert.ok(s.lastCompileAt, 'lastCompileAt is stamped');
  assert.ok(s.history.some((h) => h.event === 'compile.done'), 'compile.done recorded in history');
});

ok('corrupt state.json is backed up, not silently lost', () => {
  const sp = state.statePath(cwd);
  state.initProject(cwd, { force: true });
  fs.writeFileSync(sp, '{ this is not valid json', 'utf8');
  const loaded = state.loadState(cwd); // triggers backup + fresh
  assert.ok(loaded && loaded.version, 'a fresh state is created');
  const dir = path.dirname(sp);
  const backups = fs.readdirSync(dir).filter((f) => f.startsWith('state.json.corrupt.'));
  assert.ok(backups.length >= 1, 'a corrupt backup exists');
  const raw = fs.readFileSync(path.join(dir, backups[0]), 'utf8');
  assert.ok(raw.includes('this is not valid json'), 'backup preserves the original bad bytes');
});

// --- store integrity (0.8 Closure Gate) -------------------------------------

ok('state carries a monotonic rev that increments on every write and survives load', () => {
  // Dormant in 0.8: nothing reads it. It exists so a later version can detect a
  // lost update without a migration — which is only possible if it starts now.
  state.initProject(cwd, { force: true });
  const fresh = state.loadState(cwd);
  assert.strictEqual(fresh.rev, 0, 'a fresh state opens at rev 0');
  state.saveState(cwd, fresh);
  assert.strictEqual(state.loadState(cwd).rev, 1, 'the first write is rev 1');
  const second = state.loadState(cwd);
  state.saveState(cwd, second);
  assert.strictEqual(state.loadState(cwd).rev, 2, 'rev increments across writes and survives a reload');
  // a legacy (pre-0.8) state file has no rev — it is read as 0, lazily, never migrated
  const legacy = state.loadState(cwd);
  delete legacy.rev;
  state.writeJson(state.statePath(cwd), legacy);
  assert.strictEqual(state.loadState(cwd).rev, undefined, 'load does not rewrite a legacy file');
  state.saveState(cwd, state.loadState(cwd));
  assert.strictEqual(state.loadState(cwd).rev, 1, 'a missing rev counts as 0, so the next write is 1');
});

ok('a corrupt state file is never clobbered when its backup fails', () => {
  // The only copy of the record is the corrupt one. If we cannot preserve it,
  // reinitializing destroys it — so refuse instead.
  const proj = path.join(tmp, 'corrupt-unbackupable');
  state.initProject(proj, { force: true });
  const sp = state.statePath(proj);
  fs.writeFileSync(sp, '{ broken', 'utf8');
  const origWrite = fs.writeFileSync;
  fs.writeFileSync = (file, ...rest) => {
    if (String(file).includes('.corrupt.')) throw new Error('disk full');
    return origWrite(file, ...rest);
  };
  try {
    assert.throws(() => state.loadState(proj), /could not be backed up|refusing/i);
  } finally {
    fs.writeFileSync = origWrite;
  }
  assert.strictEqual(fs.readFileSync(sp, 'utf8'), '{ broken', 'the only copy is still on disk, untouched');
});

ok('the corrupt-backup filename is sanitized, not taken from the clock verbatim', () => {
  const proj = path.join(tmp, 'corrupt-stamp');
  state.initProject(proj, { force: true });
  fs.writeFileSync(state.statePath(proj), 'nope{', 'utf8');
  const prevNow = process.env.RATCHET_NOW;
  process.env.RATCHET_NOW = '../../escape/2026-07-29T00:00:00.000Z';
  try {
    state.loadState(proj);
  } finally {
    if (prevNow == null) delete process.env.RATCHET_NOW;
    else process.env.RATCHET_NOW = prevNow;
  }
  const backups = fs.readdirSync(path.dirname(state.statePath(proj))).filter((f) => f.includes('.corrupt.'));
  assert.ok(backups.length >= 1, 'the backup landed');
  for (const b of backups) {
    assert.ok(!/[\\/]/.test(b), `backup name has no path separators: ${b}`);
    assert.ok(/^state\.json\.corrupt\.[0-9A-Za-z-]+\.json$/.test(b), `backup name is allowlisted: ${b}`);
  }
});

ok('two casings of one Windows path resolve to a single store', () => {
  // Windows paths are case-insensitive; a slug that hashes the raw casing splits
  // one project into two stores depending on how the shell spelled the cwd.
  const upper = path.join(tmp, 'CaseFixture', 'Repo');
  const lower = path.join(tmp, 'casefixture', 'repo');
  if (process.platform === 'win32') {
    assert.strictEqual(state.projectSlug(upper), state.projectSlug(lower), 'one path, one slug');
  } else {
    assert.notStrictEqual(state.projectSlug(upper), state.projectSlug(lower), 'case-sensitive platforms keep both');
  }
});

ok('corrupt ledger.json is backed up, not silently lost', () => {
  const lp = state.ledgerPath(cwd);
  fs.writeFileSync(lp, 'garbage{', 'utf8');
  const loaded = state.loadLedger(cwd);
  assert.ok(loaded && loaded.version, 'a fresh ledger is created');
  const backups = fs.readdirSync(path.dirname(lp)).filter((f) => f.startsWith('ledger.json.corrupt.'));
  assert.ok(backups.length >= 1, 'a corrupt ledger backup exists');
});

ok('repo snapshot sees allowlisted dot dirs, skips .git / node_modules', () => {
  const proj = path.join(tmp, 'snap-fixture');
  for (const d of ['.agents', '.claude-plugin', '.codex-plugin', '.github', '.git', 'node_modules', 'src']) {
    fs.mkdirSync(path.join(proj, d), { recursive: true });
  }
  const snap = repo.snapshot(proj);
  assert.ok(snap.dirs.includes('.agents'), '.agents is visible');
  assert.ok(snap.dirs.includes('.claude-plugin'), '.claude-plugin is visible');
  assert.ok(snap.dirs.includes('.codex-plugin'), '.codex-plugin is visible');
  assert.ok(snap.dirs.includes('.github'), '.github is visible');
  assert.ok(!snap.dirs.includes('.git'), '.git is skipped');
  assert.ok(!snap.dirs.includes('node_modules'), 'node_modules is skipped');
});

ok('git status-refs is base-qualified and never emits a bare count', () => {
  const refs = gitRefs.statusRefs(process.cwd());
  assert.strictEqual(typeof refs.isRepo, 'boolean');
  if (refs.isRepo) {
    assert.ok(Array.isArray(refs.comparisons), 'comparisons is an array');
    for (const c of refs.comparisons) {
      assert.ok(c.base, 'every comparison names its base ref');
      assert.strictEqual(typeof c.ahead, 'number');
      assert.strictEqual(typeof c.behind, 'number');
    }
  }
  const rendered = md.gitStatusRefs(refs);
  assert.ok(/Git status/.test(rendered));
  // A non-repo path renders cleanly, not a crash.
  assert.ok(/not a git repository/.test(md.gitStatusRefs({ isRepo: false })));
});

ok('cold-start scanner flags retracted steering + unqualified git counts', () => {
  const proj = path.join(tmp, 'cold-fixture');
  fs.mkdirSync(path.join(proj, '.ratchet'), { recursive: true });
  state.initProject(proj, { force: true });
  const st = state.loadState(proj);
  st.objective = 'ship seam gate';
  st.nextAction = 'finish art-dead re-scope';
  st.artifacts = [
    { id: 'art-dead', title: 'T2.3 re-scope', status: 'retracted', path: 'reports/rescope.md', retracted: { supersededBy: 'art-eval', keptForProvenance: true } },
  ];
  state.saveState(proj, st);
  // a goal surface: unqualified git count, no valid-as-of stamp, repeats the retracted claim
  fs.writeFileSync(path.join(proj, 'goal.md'), '# Goal\nWe are 43 ahead of main.\nT2.3 re-scope is still the plan.\n');
  fs.writeFileSync(
    path.join(proj, '.ratchet', 'cold-start.json'),
    JSON.stringify({ surfaces: [{ path: 'goal.md', kind: 'goal', checks: ['base-qualified-git', 'valid-as-of', 'no-retracted-claims'] }] })
  );
  const r = coldStart.scan(proj);
  assert.strictEqual(r.ok, false, 'contradictions make the scan not-ok');
  const lvl = (frag) => (r.checks.find((c) => c.name.includes(frag)) || {}).level;
  assert.strictEqual(lvl('steering artifact is live'), 'fail');
  assert.strictEqual(lvl('next action avoids retracted'), 'fail');
  assert.strictEqual(lvl('base-qualified-git'), 'fail');
  assert.strictEqual(lvl('valid-as-of'), 'warn');
  assert.strictEqual(lvl('no-retracted-claims'), 'fail');
});

ok('cold-start scanner is clean on healthy state and flags unimplemented checks transparently', () => {
  const proj = path.join(tmp, 'cold-clean');
  fs.mkdirSync(path.join(proj, '.ratchet'), { recursive: true });
  state.initProject(proj, { force: true });
  const st = state.loadState(proj);
  st.objective = 'x';
  st.nextAction = 'do y';
  st.artifacts = [{ id: 'a1', title: 'live spec', status: 'v1', holes: [] }];
  state.saveState(proj, st);
  fs.writeFileSync(path.join(proj, 'sheet.md'), '# Sheet\nvalid-as-of 2026-07-03\n82 ahead of origin/main.\n');
  fs.writeFileSync(
    path.join(proj, '.ratchet', 'cold-start.json'),
    JSON.stringify({ surfaces: [{ path: 'sheet.md', kind: 'decision-sheet', checks: ['valid-as-of', 'base-qualified-git', 'no-closed-work-as-next'] }] })
  );
  const r = coldStart.scan(proj);
  assert.strictEqual(r.ok, true, 'healthy state + qualified counts pass');
  assert.strictEqual((r.checks.find((c) => c.name.includes('valid-as-of')) || {}).level, 'ok');
  assert.strictEqual((r.checks.find((c) => c.name.includes('base-qualified-git')) || {}).level, 'ok');
  // a declared-but-unimplemented check must warn, not silently pass
  assert.strictEqual((r.checks.find((c) => c.name.includes('no-closed-work-as-next')) || {}).level, 'warn');
});

// --- scores name their scope (no confidence gaslighting) --------------------

ok('every score names its scope', () => {
  const conf = scoring.scoreConfidence(state.loadState(cwd));
  assert.strictEqual(conf.layer, 'session', 'session confidence declares its layer');
  assert.ok(conf.scope && /loop/.test(conf.scope), 'session confidence names its scope');
  assert.ok(/Scope:/.test(md.confidence(state.loadState(cwd))), 'confidence render names its scope');

  const fr = scoring.scoreFriction([{ name: 'a', leverage: 5, certainty: 5, speed: 5, risk: 5 }]);
  assert.ok(fr.scope && /unlisted/.test(fr.scope), 'friction discloses it only sees supplied obstacles');
  assert.ok(/Scope:/.test(md.friction(fr)), 'friction render names its scope');

  const ap = scoring.scoreAperture({ ambiguity: 1, terrain: 1, taste: 1, blastRadius: 1, reversibility: 1 });
  assert.ok(ap.scope && /re-score/.test(ap.scope), 'aperture is scoped to the task as scored');
  assert.ok(/Scope:/.test(md.aperture(ap)), 'aperture render names its scope');
});

// --- authority gate on the one irreversible verb that lacked one ------------

ok('state reset requires explicit authority (--force)', () => {
  const s = state.loadState(cwd);
  s.objective = 'do not lose me';
  state.saveState(cwd, s);
  assert.throws(() => cli.run(['node', 'ratchet', 'state', 'reset']), /irreversible|--force/);
  assert.strictEqual(state.loadState(cwd).objective, 'do not lose me', 'a bare reset must not wipe state');
  cli.run(['node', 'ratchet', 'state', 'reset', '--force']);
  assert.strictEqual(state.loadState(cwd).objective, '', 'reset --force wipes state');
});

// --- the receipt: one stable shape, every section always present ------------

ok('receipt renders all eight sections even on empty state', () => {
  state.initProject(cwd, { force: true });
  const out = md.receipt(receipt.assemble(cwd));
  for (const section of ['TARGET', 'DELTA', 'PROOF', 'VERDICT', 'RISK', 'AUTHORITY', 'STATE', 'NEXT']) {
    assert.ok(out.includes(`**${section}**`), `receipt always shows ${section}`);
  }
  assert.ok(/valid as of/.test(out), 'receipt is stamped so a cold reader can tell if it is current');
  // Empty is stated, not omitted — no section silently disappears.
  assert.ok(/not locked/.test(out), 'an unlocked target says so');
  assert.ok(/no proven KEEP/.test(out), 'no-proof state is explicit, not blank');
  // AUTHORITY renders the standing gates — the "what is safe" policy is visible,
  // including the sole-writer rule that isolates agent memory.
  assert.ok(/Gates in force/.test(out), 'the receipt shows which irreversible actions are gated');
  assert.ok(/canonical writes/.test(out), 'the agent-write isolation gate is visible in the receipt');
});

ok('receipt surfaces target, next, defects, and authority from real state', () => {
  state.initProject(cwd, { force: true });
  const s = state.loadState(cwd);
  s.objective = 'ship the receipt';
  s.nextAction = 'run the harness';
  s.nextCommand = '/ratchet:verify';
  state.saveState(cwd, s);
  artifacts.addDefect(cwd, { severity: 'high', summary: 'unproven claim' });
  const { state: w } = artifacts.addDefect(cwd, { severity: 'medium', summary: 'accepted nit' });
  cli.run(['node', 'ratchet', 'defect', 'waive', w.id, '--owner', 'danny', '--reason', 'cosmetic, next release']);

  const r = receipt.assemble(cwd);
  assert.strictEqual(r.target.objective, 'ship the receipt');
  assert.strictEqual(r.next.action, 'run the harness');
  assert.ok(r.state.openDefects.some((d) => d.summary === 'unproven claim'), 'open defect shows in STATE');
  assert.ok(r.authority.waivedDefects.some((d) => d.by === 'danny'), 'waiver shows a named owner in AUTHORITY');

  const out = md.receipt(r);
  assert.ok(out.includes('ship the receipt'));
  assert.ok(/waived defect .* by danny/.test(out), 'the receipt names who authorized the waiver');
});

ok('receipt PROOF renders an evidence card for a KEEP, with its seam', () => {
  // A KEEP can only be written through the proof + seam gate, so the evidence
  // the card shows is guaranteed to exist — the receipt just surfaces it.
  fs.rmSync(process.env.RATCHET_EVOLVE_LOG, { force: true });
  journal.appendEvent(cwd, {
    target: 'src/receipt.js',
    goal: 'stable resume receipt',
    mode: 'code',
    chosenMutation: 'assemble eight fixed sections',
    verdict: 'KEEP',
    // {command, pass} — the shape `ratchet-evolve verify` emits. A bare string
    // carries no machine verdict, and 0.8's proof gate refuses one.
    verification: { commands: [{ command: 'node test/cli.test.js', pass: true }], result: 'pass' },
    seam: {
      evidenceType: 'test',
      testedSeam: 'ratchet receipt',
      shipSeam: 'ratchet receipt',
      seamMatch: 'exact',
      independentFromBuilderMethod: true,
    },
    nextEdge: 'wire remaining skills to end on a receipt',
  });
  const r = receipt.assemble(cwd);
  assert.ok(r.proof.keep, 'a KEEP produces an evidence card');
  assert.strictEqual(r.proof.keep.result, 'pass');
  assert.strictEqual(r.proof.seam.seamMatch, 'exact', 'the card carries the ship-seam match');
  assert.strictEqual(r.proof.shipDecision, 'justified', 'an exact seam justifies the ship decision');
  assert.strictEqual(r.verdict.loop, 'KEEP');
  const out = md.receipt(r);
  assert.ok(/KEEP `/.test(out), 'the evidence card renders with the KEEP id');
  assert.ok(/tested `ratchet receipt` → ships `ratchet receipt`/.test(out), 'seam is rendered tested→ships under PROOF');
});

ok('receipt JSON is stable-shaped (all top-level fields present)', () => {
  const r = receipt.assemble(cwd);
  for (const key of ['validAsOf', 'target', 'delta', 'proof', 'verdict', 'risk', 'controlPlane', 'authority', 'state', 'next', 'gaps']) {
    assert.ok(Object.prototype.hasOwnProperty.call(r, key), `receipt object always has ${key}`);
  }
  // seam is folded into proof; the three confidences live under verdict.
  assert.ok(r.proof.seam, 'seam is nested under proof');
  for (const layer of ['artifact', 'session', 'ledger']) {
    assert.ok(r.verdict[layer], `verdict carries the ${layer} confidence layer`);
  }
  assert.ok(r.authority.authorityState && r.authority.authorityState.level, 'authority names its state on the ladder');
});

// --- three-layer confidence (no gaslighting a verified patch) ---------------

ok('artifact confidence stays high even when ledger health is low', () => {
  state.initProject(cwd, { force: true });
  const s = state.loadState(cwd);
  // a clean, verified artifact...
  s.artifacts = [{ id: 'art-good', title: 'F4 fix', kind: 'code', path: 'src/fix.js', status: 'v1', holes: [] }];
  // ...while unrelated historical debt piles up in the ledger + session
  s.defects = [
    { id: 'd-old-1', severity: 'critical', summary: 'unrelated legacy blocker', status: 'open' },
    { id: 'd-old-2', severity: 'high', summary: 'another unrelated one', status: 'open' },
  ];
  state.saveState(cwd, s);
  const events = [
    {
      target: 'src/fix.js', mode: 'code', verdict: 'KEEP',
      verification: { commands: ['probe'], result: 'pass' },
      seam: { seamMatch: 'exact', independentFromBuilderMethod: true },
    },
  ];
  const layers = scoring.scoreConfidenceLayers(s, { defects: [], tests: [] }, events);
  assert.ok(layers.artifact.score >= 85, `verified artifact is ship-ready, got ${layers.artifact.score}`);
  assert.ok(layers.session.score < 40, 'session confidence is low because of unrelated open blockers');
  assert.strictEqual(layers.artifact.layer, 'artifact');
  // the whole point: the patch is not gaslit to "blocked" by unrelated debt
  assert.notStrictEqual(layers.artifact.band, 'blocked', 'a good patch never reads blocked due to unrelated debt');
});

ok('terminal defects do not drain artifact confidence', () => {
  const s = { artifacts: [{ id: 'a1', title: 'x', path: 'p', status: 'v1', holes: [] }],
    defects: [{ id: 'd', severity: 'critical', summary: 'was fixed', status: 'resolved', artifact: 'a1' }] };
  const layers = scoring.scoreConfidenceLayers(s, {}, []);
  // resolved defect attached to the artifact must not drain it
  assert.ok(layers.artifact.score >= 85, `resolved attached defect should not drain, got ${layers.artifact.score}`);
});

ok('ledger health is its own scoped score', () => {
  const health = scoring.scoreLedgerHealth({ defects: [{ severity: 'high', status: 'open' }], tests: [{ status: 'fail' }] });
  assert.strictEqual(health.layer, 'ledger');
  assert.ok(health.score < 100, 'open ledger defect + failing test lower ledger health');
  assert.ok(/hygiene/.test(health.scope), 'ledger health names its scope');
});

ok('score confidence --json returns three named layers', () => {
  state.initProject(cwd, { force: true });
  // capture stdout
  const chunks = [];
  const orig = process.stdout.write;
  process.stdout.write = (str) => { chunks.push(String(str)); return true; };
  try {
    cli.run(['node', 'ratchet', 'score', 'confidence', '--json']);
  } finally {
    process.stdout.write = orig;
  }
  const parsed = JSON.parse(chunks.join(''));
  for (const layer of ['artifact', 'session', 'ledger']) {
    assert.ok(parsed[layer], `layer ${layer} present`);
    assert.ok(parsed[layer].scope, `layer ${layer} names its scope`);
  }
});

// --- proxy-only proof cannot justify a ship ---------------------------------

ok('receipt control-plane scan exposes cold-start poison in the one cold read', () => {
  const proj = path.join(tmp, 'receipt-control-plane');
  fs.mkdirSync(path.join(proj, '.ratchet'), { recursive: true });
  state.initProject(proj, { force: true });
  const st = state.loadState(proj);
  st.objective = 'ship the control plane';
  st.nextAction = 'continue obsolete spec';
  st.artifacts = [
    { id: 'art-obsolete', title: 'obsolete spec', status: 'retracted', path: 'reports/obsolete.md', retracted: { keptForProvenance: true } },
  ];
  state.saveState(proj, st);
  fs.writeFileSync(path.join(proj, 'goal.md'), '# Goal\nWe are 12 ahead of main.\nobsolete spec is still safe.\n');
  fs.writeFileSync(
    path.join(proj, '.ratchet', 'cold-start.json'),
    JSON.stringify({ surfaces: [{ path: 'goal.md', kind: 'goal', checks: ['base-qualified-git', 'no-retracted-claims'] }] })
  );

  const r = receipt.assemble(proj);
  assert.strictEqual(r.controlPlane.ok, false, 'receipt carries the cold-start scan result');
  assert.ok(r.controlPlane.failures >= 2, 'misleading steering failures are counted');
  const out = md.receipt(r);
  assert.ok(/Control-plane scan: FAIL/.test(out), 'the one receipt command says the control plane is unsafe');
  assert.ok(/unqualified git count/.test(out), 'configured surface failures are visible without a separate doctor run');
  assert.ok(/repeats retracted claim/.test(out), 'stale steering is visible without operator notice');
});

ok('receipt --json exposes control-plane failures and warnings for consumers', () => {
  const proj = path.join(tmp, 'receipt-control-plane-json');
  fs.mkdirSync(path.join(proj, '.ratchet'), { recursive: true });
  state.initProject(proj, { force: true });
  const st = state.loadState(proj);
  st.objective = 'ship the control plane';
  st.nextAction = 'continue obsolete spec';
  st.artifacts = [
    { id: 'art-obsolete', title: 'obsolete spec', status: 'retracted', path: 'reports/obsolete.md', retracted: { keptForProvenance: true } },
  ];
  state.saveState(proj, st);
  fs.writeFileSync(path.join(proj, 'goal.md'), '# Goal\nWe are 12 ahead of main.\nobsolete spec is still safe.\n');
  fs.writeFileSync(
    path.join(proj, '.ratchet', 'cold-start.json'),
    JSON.stringify({ surfaces: [{ path: 'goal.md', kind: 'goal', checks: ['base-qualified-git', 'valid-as-of', 'no-retracted-claims'] }] })
  );

  const chunks = [];
  const origWrite = process.stdout.write;
  const prevCwd = process.cwd();
  process.stdout.write = (str) => { chunks.push(String(str)); return true; };
  process.chdir(proj);
  try {
    cli.run(['node', 'ratchet', 'receipt', '--json']);
  } finally {
    process.chdir(prevCwd);
    process.stdout.write = origWrite;
  }

  const parsed = JSON.parse(chunks.join(''));
  assert.strictEqual(parsed.controlPlane.ok, false, 'JSON receipt says the control plane is unsafe');
  assert.strictEqual(parsed.controlPlane.configured, true, 'JSON receipt preserves configured-surface scope');
  assert.ok(parsed.controlPlane.failures >= 2, 'JSON receipt carries failure count');
  assert.ok(parsed.controlPlane.warnings >= 1, 'JSON receipt carries warning count');
  assert.ok(
    parsed.controlPlane.checks.some((c) => c.level === 'fail' && /unqualified git count/.test(c.detail)),
    'JSON receipt carries configured surface failure detail'
  );
  assert.ok(
    parsed.controlPlane.checks.some((c) => c.level === 'warn' && /valid-as-of/.test(c.detail)),
    'JSON receipt carries configured surface warning detail'
  );
});

ok('a proxy-only seam is flagged: cannot justify ship decision', () => {
  fs.rmSync(process.env.RATCHET_EVOLVE_LOG, { force: true });
  journal.appendEvent(cwd, {
    target: 'src/router.js', goal: 'gate', mode: 'docs', chosenMutation: 'proxy-evaluated gate',
    verdict: 'ASK', verification: { manualChecks: ['ran fixture-shortlist eval'], result: 'manual' },
    seam: { evidenceType: 'eval', testedSeam: 'fixture-shortlist', shipSeam: 'rerank_candidates', seamMatch: 'weak-proxy' },
  });
  const r = receipt.assemble(cwd);
  assert.strictEqual(r.proof.shipDecision, 'cannot-justify', 'proxy seam cannot justify shipping');
  assert.ok(/Cannot justify ship decision/.test(md.receipt(r)), 'the receipt says so out loud');
});

// --- source-of-truth index (ratchet receipt --save) -------------------------

ok('receipt --save writes .ratchet/current.json + current.md', () => {
  const proj = path.join(tmp, 'save-fixture');
  fs.mkdirSync(proj, { recursive: true });
  const prevCwd = process.cwd();
  process.chdir(proj);
  try {
    cli.run(['node', 'ratchet', 'receipt', '--save']);
    const jsonPath = path.join(proj, '.ratchet', 'current.json');
    const mdPath = path.join(proj, '.ratchet', 'current.md');
    assert.ok(fs.existsSync(jsonPath), 'current.json written');
    assert.ok(fs.existsSync(mdPath), 'current.md written');
    const saved = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    assert.ok(saved.validAsOf !== undefined, 'saved index is a real receipt object');
    assert.ok(/Ratchet receipt/.test(fs.readFileSync(mdPath, 'utf8')), 'current.md is the rendered receipt');
  } finally {
    process.chdir(prevCwd);
  }
});

// --- agent memory isolation (propose-only, enforced by role) ----------------

ok('a propose-only agent cannot mutate canonical state, but can still read', () => {
  state.initProject(cwd, { force: true });
  const s = state.loadState(cwd);
  s.objective = 'guard me';
  state.saveState(cwd, s);
  process.env.RATCHET_AGENT = 'ratchet-builder';
  try {
    assert.throws(() => cli.run(['node', 'ratchet', 'state', 'set', 'objective', 'hijacked']), /propose-only/);
    assert.throws(() => cli.run(['node', 'ratchet', 'artifact', 'add', '{"title":"x"}']), /propose-only/);
    assert.throws(() => cli.run(['node', 'ratchet', 'defect', 'add', '{"summary":"x"}']), /propose-only/);
    assert.throws(() => cli.run(['node', 'ratchet', 'compile', 'done']), /propose-only/);
    assert.throws(() => cli.run(['node', 'ratchet', 'state', 'reset', '--force']), /propose-only/);
    // the shared record is untouched — no mutation leaked through
    assert.strictEqual(state.loadState(cwd).objective, 'guard me', 'a propose-only agent cannot clobber the record');
    // read verbs stay open so the agent can still orient
    assert.doesNotThrow(() => cli.run(['node', 'ratchet', 'receipt']));
    assert.doesNotThrow(() => cli.run(['node', 'ratchet', 'defect', 'list']));
  } finally {
    delete process.env.RATCHET_AGENT;
  }
});

ok('the scribe is the sole writer — it may mutate canonical state', () => {
  process.env.RATCHET_AGENT = 'scribe';
  try {
    cli.run(['node', 'ratchet', 'state', 'set', 'objective', 'written by scribe']);
    assert.strictEqual(state.loadState(cwd).objective, 'written by scribe', 'the scribe writes canonical state');
  } finally {
    delete process.env.RATCHET_AGENT;
  }
});

ok('score confidence leaves no write footprint for a propose-only agent', () => {
  state.initProject(cwd, { force: true });
  const s = state.loadState(cwd);
  s.confidence = null;
  state.saveState(cwd, s);
  process.env.RATCHET_AGENT = 'ratchet-auditor';
  try {
    assert.doesNotThrow(() => cli.run(['node', 'ratchet', 'score', 'confidence']));
    assert.strictEqual(state.loadState(cwd).confidence, null, 'a read leaves no cached write behind');
  } finally {
    delete process.env.RATCHET_AGENT;
  }
});

// --- probe + undrained fog (the fog gate's remaining holes) ------------------

ok('score aperture serializes mapRequired fog as an open loop (not just stdout)', () => {
  state.initProject(cwd, { force: true });
  cli.run(['node', 'ratchet', 'score', 'aperture', '{"ambiguity":2,"terrain":2,"taste":2,"blastRadius":1,"reversibility":1}']);
  const fogLoops = state.loadState(cwd).openLoops.filter((l) => /^fog: pre-build map required/.test(l.text));
  assert.strictEqual(fogLoops.length, 1, 'the dial leaves the fog on the record, not only on stdout');
  assert.strictEqual(fogLoops[0].status, 'open');
  // a re-score does not stack a second drain
  cli.run(['node', 'ratchet', 'score', 'aperture', '{"ambiguity":2,"terrain":2,"taste":2,"blastRadius":1,"reversibility":1}']);
  assert.strictEqual(
    state.loadState(cwd).openLoops.filter((l) => /^fog:/.test(l.text)).length, 1, 'fog loop is deduped'
  );
  // and recorded fog drains confidence like any open loop
  assert.ok(
    scoring.scoreConfidence(state.loadState(cwd)).penalties.some((p) => /open loop/.test(p.reason)),
    'recorded fog drains confidence'
  );
});

ok('a low-uncertainty aperture read leaves no fog footprint', () => {
  state.initProject(cwd, { force: true });
  cli.run(['node', 'ratchet', 'score', 'aperture', '{"ambiguity":0,"terrain":0,"taste":0,"blastRadius":1,"reversibility":0}']);
  assert.strictEqual(state.loadState(cwd).openLoops.length, 0, 'no mapRequired → no fog loop');
});

ok('score aperture leaves no fog footprint for a propose-only agent', () => {
  state.initProject(cwd, { force: true });
  process.env.RATCHET_AGENT = 'ratchet-auditor';
  try {
    cli.run(['node', 'ratchet', 'score', 'aperture', '{"ambiguity":2,"terrain":2,"taste":2,"blastRadius":2,"reversibility":2}']);
  } finally {
    delete process.env.RATCHET_AGENT;
  }
  assert.strictEqual(state.loadState(cwd).openLoops.length, 0, 'a propose-only read leaves no write behind');
});

ok('the unknown-map artifact landing closes the fog loop the dial opened', () => {
  state.initProject(cwd, { force: true });
  cli.run(['node', 'ratchet', 'score', 'aperture', '{"ambiguity":2,"terrain":2,"taste":2,"blastRadius":1,"reversibility":1}']);
  artifacts.addArtifact(cwd, {
    kind: 'unknown-map', title: 'unknowns map: fixture', path: '.ratchet/unknowns-map.md',
    status: 'handoff', holes: ['Q3 OPEN — route: probe'],
  });
  const fogLoops = state.loadState(cwd).openLoops.filter((l) => /^fog:/.test(l.text));
  assert.ok(fogLoops.length >= 1, 'the fog loop is still on the record for provenance');
  assert.ok(fogLoops.every((l) => l.status === 'closed'), 'the map landing closes the fog the dial recorded');
});

ok('probe lifecycle: the disposal hole drains until the gated retract clears it', () => {
  state.initProject(cwd, { force: true });
  const probe = artifacts.addArtifact(cwd, {
    kind: 'probe', title: 'probe: does the seam double-fire?', holes: ['disposal: pending'],
  });
  assert.ok(
    scoring.scoreConfidence(state.loadState(cwd)).penalties.some((p) => /holes/.test(p.reason)),
    'a live probe drains confidence via its disposal hole'
  );
  // disposal reuses the gated verb — no silent disposal
  assert.throws(() => cli.run(['node', 'ratchet', 'retract', probe.id]), /reason/);
  cli.run(['node', 'ratchet', 'retract', probe.id, '--reason', 'disposed: code reverted; finding recorded as decision']);
  const after = state.loadState(cwd);
  assert.strictEqual(after.artifacts.find((a) => a.id === probe.id).status, 'retracted');
  assert.ok(
    !scoring.scoreConfidence(after).penalties.some((p) => /holes/.test(p.reason)),
    'disposal stops the drain'
  );
});

ok('cold-start reads probes correctly: disposed is healthy, live is residue, fog+build steering fails', () => {
  const proj = path.join(tmp, 'fog-cold');
  fs.mkdirSync(proj, { recursive: true });
  state.initProject(proj, { force: true });
  let st = state.loadState(proj);
  st.objective = 'ship the probe gate';
  st.nextAction = 'verify the fog checks';
  st.nextCommand = '/ratchet:verify';
  // a disposed probe as the most recent artifact is a COMPLETED build-for-learn
  st.artifacts = [
    { id: 'p1', title: 'probe: seam', kind: 'probe', status: 'retracted', retracted: { reason: 'disposed: finding recorded' } },
  ];
  state.saveState(proj, st);
  let scan = coldStart.scan(proj);
  const lvl = (frag) => (scan.checks.find((c) => c.name.includes(frag)) || {}).level;
  assert.strictEqual(lvl('steering artifact is live'), 'ok', 'a disposed probe is not dead steering');
  assert.strictEqual(lvl('probe code is disposed'), 'ok');
  assert.strictEqual(lvl('build steering has no unmapped fog'), 'ok');
  assert.strictEqual(scan.ok, true, 'a completed probe leaves a healthy cold start');

  // "rebuild trust" is not build steering — fog + a non-build move stays ok
  st = state.loadState(proj);
  st.nextAction = 'rebuild the demo narrative';
  st.openLoops = [{ id: 'l0', text: 'fog: pre-build map required (aperture A3, score 7/10)', status: 'open' }];
  state.saveState(proj, st);
  scan = coldStart.scan(proj);
  assert.strictEqual(lvl('build steering has no unmapped fog'), 'ok', '"rebuild" must not read as build steering');

  // now: undisposed residue + recorded fog + steering that says build anyway
  st = state.loadState(proj);
  st.nextCommand = '/ratchet:build';
  st.artifacts.push({ id: 'p2', title: 'probe: taste', kind: 'probe', status: 'v0', holes: ['disposal: pending'] });
  st.openLoops = [{ id: 'l1', text: 'fog: pre-build map required (aperture A3, score 7/10)', status: 'open' }];
  state.saveState(proj, st);
  scan = coldStart.scan(proj);
  assert.strictEqual(lvl('probe code is disposed'), 'warn', 'live probe code is residue a cold session must not inherit');
  assert.strictEqual(lvl('build steering has no unmapped fog'), 'fail', 'steering says build while fog is open');
  assert.strictEqual(scan.ok, false);
});

ok('receipt carries the fog card — emptiness stated, residue warned', () => {
  state.initProject(cwd, { force: true });
  let r = receipt.assemble(cwd);
  assert.ok(r.state.fog, 'fog card is always present');
  assert.strictEqual(r.state.fog.probes.live, 0);
  assert.ok(/Fog: none recorded/.test(md.receipt(r)), 'empty fog is stated, not omitted');

  artifacts.addArtifact(cwd, { kind: 'unknown-map', title: 'unknowns map: fixture', holes: ['Q1 OPEN — route: user', 'Q2 OPEN — route: probe'] });
  artifacts.addArtifact(cwd, { kind: 'probe', title: 'probe: q2', holes: ['disposal: pending'] });
  r = receipt.assemble(cwd);
  assert.strictEqual(r.state.fog.maps.length, 1);
  assert.strictEqual(r.state.fog.maps[0].openItems, 2, 'map holes count as OPEN items');
  assert.strictEqual(r.state.fog.probes.live, 1);
  const rendered = md.receipt(r);
  assert.ok(/Fog: 1 unknown-map \(2 OPEN item\(s\)\)/.test(rendered), 'fog renders in STATE');
  assert.ok(/disposed or promoted/.test(rendered), 'a live probe carries its warning in the receipt');
});

ok('score aperture --json serializes fog too (no read-mode bypass) and reports it', () => {
  state.initProject(cwd, { force: true });
  const chunks = [];
  const orig = process.stdout.write;
  process.stdout.write = (str) => { chunks.push(String(str)); return true; };
  try {
    cli.run(['node', 'ratchet', 'score', 'aperture', '{"ambiguity":2,"terrain":2,"taste":2,"blastRadius":2,"reversibility":2}', '--json']);
  } finally {
    process.stdout.write = orig;
  }
  const parsed = JSON.parse(chunks.join(''));
  assert.strictEqual(parsed.recordedFog, true, 'the JSON result says the fog write happened');
  assert.strictEqual(
    state.loadState(cwd).openLoops.filter((l) => /^fog:/.test(l.text)).length, 1,
    'a --json consumer cannot bypass fog serialization'
  );
  // and the JSON path stays footprint-free for propose-only agents
  state.initProject(cwd, { force: true });
  process.env.RATCHET_AGENT = 'ratchet-auditor';
  try {
    const silent = [];
    process.stdout.write = (str) => { silent.push(String(str)); return true; };
    try {
      cli.run(['node', 'ratchet', 'score', 'aperture', '{"ambiguity":2,"terrain":2,"taste":2,"blastRadius":2,"reversibility":2}', '--json']);
    } finally {
      process.stdout.write = orig;
    }
    assert.strictEqual(JSON.parse(silent.join('')).recordedFog, false, 'a propose-only read reports no write');
  } finally {
    delete process.env.RATCHET_AGENT;
  }
  assert.strictEqual(state.loadState(cwd).openLoops.length, 0, 'propose-only --json leaves no footprint');
});

ok('probe artifacts always receive the disposal hole (invariant, not convention)', () => {
  state.initProject(cwd, { force: true });
  const probe = artifacts.addArtifact(cwd, { kind: 'probe', title: 'probe: forgot the hole' });
  assert.ok(probe.holes.some((h) => /disposal:\s*pending/i.test(h)), 'the boundary injects disposal: pending');
  assert.ok(
    scoring.scoreConfidence(state.loadState(cwd)).penalties.some((p) => /holes/.test(p.reason)),
    'a hole-less probe still drains confidence'
  );
});

ok('probe retraction must state its outcome: disposed or promoted (+ superseded-by)', () => {
  state.initProject(cwd, { force: true });
  const probe = artifacts.addArtifact(cwd, { kind: 'probe', title: 'probe: outcome gate' });
  assert.throws(() => cli.run(['node', 'ratchet', 'retract', probe.id, '--reason', 'done']), /disposed|promoted/);
  assert.strictEqual(
    state.loadState(cwd).artifacts.find((a) => a.id === probe.id).status, 'v0',
    'a vague reason does not dispose the probe'
  );
  assert.throws(
    () => cli.run(['node', 'ratchet', 'retract', probe.id, '--reason', 'promoted: kept the fixture']),
    /superseded-by/
  );
  // 0.8: a promotion must point at a REAL, non-probe replacement — "art-keep-1"
  // used to be an id nobody recorded, which is residue shipping under a label.
  const keep = artifacts.addArtifact(cwd, { id: 'art-keep-1', kind: 'code', title: 'build-for-keep' });
  cli.run(['node', 'ratchet', 'retract', probe.id, '--reason', 'promoted: rebuilt under proof gates', '--superseded-by', keep.id]);
  const after = state.loadState(cwd).artifacts.find((a) => a.id === probe.id);
  assert.strictEqual(after.status, 'retracted');
  assert.strictEqual(after.retracted.supersededBy, 'art-keep-1');
});

ok('session confidence names recorded pressure, not correctness', () => {
  const conf = scoring.scoreConfidence(state.loadState(cwd));
  assert.ok(/recorded loop pressure, not correctness/.test(conf.scope), 'the scope says what the number is not');
});

// --- artifact integrity + idempotency (0.8 Closure Gate) --------------------

ok('an artifact cannot be born or revised into a terminal status, or carry a reserved field', () => {
  state.initProject(cwd, { force: true });
  for (const status of ['closed', 'retracted', 'superseded']) {
    assert.throws(() => artifacts.addArtifact(cwd, { title: 'x', status }), /terminal statuses are earned/);
  }
  for (const field of ['rev', 'closedAt', 'closedBy', 'closedRev', 'closedHash', 'holesWaiver', 'retracted', 'supersededBy']) {
    assert.throws(() => artifacts.addArtifact(cwd, { title: 'x', [field]: 'forged' }), /written by the CLI/);
  }
  assert.strictEqual(state.loadState(cwd).artifacts.length, 0, 'nothing was written by a refused add');
});

ok('re-adding the same id revises in place; an identical retry is a true no-op', () => {
  state.initProject(cwd, { force: true });
  const first = artifacts.addArtifact(cwd, { id: 'art-fixed', title: 'spec', kind: 'spec', path: '', holes: [] });
  assert.strictEqual(first.rev, 1, 'birth is rev 1');

  const before = fs.readFileSync(state.statePath(cwd), 'utf8');
  const retry = artifacts.addArtifact(cwd, { id: 'art-fixed', title: 'spec', kind: 'spec', path: '', holes: [] });
  assert.strictEqual(retry.rev, 1, 'an identical retry does not bump rev — that would invalidate bound proof');
  assert.strictEqual(fs.readFileSync(state.statePath(cwd), 'utf8'), before, 'and writes nothing at all');

  const revised = artifacts.addArtifact(cwd, { id: 'art-fixed', title: 'spec v2', kind: 'spec' });
  assert.strictEqual(revised.rev, 2, 'a real change is a revision');
  const s = state.loadState(cwd);
  assert.strictEqual(s.artifacts.filter((a) => a.id === 'art-fixed').length, 1, 'one id, one record');
  assert.ok(s.history.some((h) => h.event === 'artifact.revised'));
});

ok('kind is immutable on an update in place', () => {
  state.initProject(cwd, { force: true });
  artifacts.addArtifact(cwd, { id: 'art-probe', kind: 'probe', title: 'probe: x' });
  assert.throws(() => artifacts.addArtifact(cwd, { id: 'art-probe', kind: 'code' }), /immutable/);
  assert.strictEqual(state.loadState(cwd).artifacts[0].kind, 'probe', 'a probe cannot become closable in place');
});

ok('an ambiguous id refuses every lifecycle verb, repair-ably', () => {
  state.initProject(cwd, { force: true });
  const s = state.loadState(cwd);
  s.artifacts = [
    { id: 'dup', kind: 'spec', title: 'one', status: 'v0', holes: [], rev: 1 },
    { id: 'dup', kind: 'spec', title: 'two', status: 'v0', holes: [], rev: 1 },
  ];
  state.saveState(cwd, s);
  assert.throws(() => artifacts.addArtifact(cwd, { id: 'dup', title: 'three' }), /share the id "dup"/);
  assert.throws(() => cli.run(['node', 'ratchet', 'retract', 'dup', '--reason', 'x']), /share the id "dup"/);
});

ok('"revises" is provenance only — the prior artifact stays live', () => {
  state.initProject(cwd, { force: true });
  const a = artifacts.addArtifact(cwd, { id: 'art-old', title: 'v1', kind: 'spec' });
  const b = artifacts.addArtifact(cwd, { id: 'art-new', title: 'v2', kind: 'spec', revises: 'art-old' });
  assert.strictEqual(b.revises, 'art-old', 'the link is recorded');
  assert.strictEqual(state.loadState(cwd).artifacts.find((x) => x.id === a.id).status, 'v0', 'no lifecycle side effect');
});

ok('a promoted probe must name an existing, non-probe replacement', () => {
  state.initProject(cwd, { force: true });
  const probe = artifacts.addArtifact(cwd, { kind: 'probe', title: 'probe: promotion gate' });
  assert.throws(
    () => cli.run(['node', 'ratchet', 'retract', probe.id, '--reason', 'promoted: x', '--superseded-by', 'art-does-not-exist']),
    /names no artifact/
  );
  const other = artifacts.addArtifact(cwd, { kind: 'probe', title: 'probe: not a replacement' });
  assert.throws(
    () => cli.run(['node', 'ratchet', 'retract', probe.id, '--reason', 'promoted: x', '--superseded-by', other.id]),
    /itself a probe/
  );
});

ok('defects attach to exactly one live artifact, or refuse and name the candidates', () => {
  state.initProject(cwd, { force: true });
  // ZERO live artifacts → unattached, stated
  const orphan = artifacts.addDefect(cwd, { severity: 'low', summary: 'no home' });
  assert.strictEqual(orphan.state.artifact, '');
  assert.strictEqual(orphan.state.attachedBy, 'none');

  // exactly ONE → auto-attach, stamped with the artifact identity it attacks
  state.initProject(cwd, { force: true });
  const only = artifacts.addArtifact(cwd, { title: 'only', kind: 'spec' });
  const auto = artifacts.addDefect(cwd, { severity: 'high', summary: 'boom' });
  assert.strictEqual(auto.state.artifact, only.id);
  assert.strictEqual(auto.state.attachedBy, 'auto');
  assert.strictEqual(auto.state.artifactRev, 1, 'the defect records which revision it attacks');
  assert.ok(auto.state.artifactHash, 'and that revision\'s hash');

  // TWO+ → refuse, naming them
  artifacts.addArtifact(cwd, { title: 'second', kind: 'spec' });
  assert.throws(() => artifacts.addDefect(cwd, { severity: 'high', summary: 'ambiguous' }), /2 live artifacts/);
});

ok('a repeat defect report dedups and escalates in place', () => {
  state.initProject(cwd, { force: true });
  artifacts.addArtifact(cwd, { title: 'only', kind: 'spec' });
  const first = artifacts.addDefect(cwd, { severity: 'low', summary: '  Flaky Under Load  ' });
  const again = artifacts.addDefect(cwd, { severity: 'critical', summary: 'flaky under load' });
  assert.strictEqual(again.state.id, first.state.id, 'same artifact + same summary = the same defect');
  assert.strictEqual(state.loadState(cwd).defects.length, 1, 'no duplicate record');
  assert.strictEqual(again.state.severity, 'critical', 'severity escalates in place');
  // de-escalation never happens silently
  artifacts.addDefect(cwd, { severity: 'info', summary: 'flaky under load' });
  assert.strictEqual(state.loadState(cwd).defects[0].severity, 'critical', 'a milder repeat cannot downgrade it');
  // a resolved defect is out of the dedup window — a regression is a new record
  cli.run(['node', 'ratchet', 'defect', 'resolve', first.state.id, '--evidence', 'fixed and verified']);
  const fresh = artifacts.addDefect(cwd, { severity: 'high', summary: 'flaky under load' });
  assert.notStrictEqual(fresh.state.id, first.state.id, 'a terminal defect does not absorb a fresh report');
});

ok('a defect cannot be born terminal', () => {
  state.initProject(cwd, { force: true });
  for (const status of ['resolved', 'waived', 'superseded', 'closed']) {
    assert.throws(() => artifacts.addDefect(cwd, { summary: 'x', status }), /cannot be born/);
  }
});

ok('the defect transition engine enforces its own proof, not just the CLI', () => {
  state.initProject(cwd, { force: true });
  artifacts.addArtifact(cwd, { title: 'only', kind: 'spec' });
  const { state: d } = artifacts.addDefect(cwd, { severity: 'high', summary: 'engine gate' });
  // Called directly — bypassing cmdDefect's own checks entirely.
  assert.throws(() => artifacts.transitionDefect(cwd, d.id, 'resolved', {}), /no proof/i);
  assert.throws(() => artifacts.transitionDefect(cwd, d.id, 'waived', { owner: 'danny' }), /reason/i);
  assert.throws(() => artifacts.transitionDefect(cwd, d.id, 'waived', { reason: 'x' }), /owner/i);
  assert.throws(() => artifacts.transitionDefect(cwd, d.id, 'reopened', {}), /reason/i);
  assert.throws(() => artifacts.transitionDefect(cwd, d.id, 'superseded', {}), /by/i);
  assert.strictEqual(state.loadState(cwd).defects.find((x) => x.id === d.id).status, 'open', 'nothing leaked through');
});

// --- proof binding (0.8 Closure Gate) ---------------------------------------

const lifecycle = require('../src/lifecycle');
const evolveVerify = require('../src/evolve/verify');

// A project with a real file on disk, an artifact pointing at it, and a helper
// that hands back the fingerprint the CLI would compute.
function boundFixture(name, { kind = 'code', file = 'src/thing.js', body = 'one' } = {}) {
  const proj = path.join(tmp, name);
  fs.rmSync(proj, { recursive: true, force: true });
  fs.mkdirSync(path.join(proj, path.dirname(file)), { recursive: true });
  fs.writeFileSync(path.join(proj, file), body, 'utf8');
  state.initProject(proj, { force: true });
  const art = artifacts.addArtifact(proj, { title: 'thing', kind, path: file });
  return { proj, art, fp: lifecycle.fingerprint(proj, art), file: path.join(proj, file) };
}

function keepFields(art, over) {
  return {
    target: 'src/thing.js',
    artifactId: art.id,
    verdict: 'KEEP',
    verification: { commands: [{ command: 'node -e 0', pass: true }], result: 'pass' },
    seam: { evidenceType: 'test', testedSeam: 'x', shipSeam: 'x', seamMatch: 'exact', independentFromBuilderMethod: true },
    ...over,
  };
}

ok('a bound append stamps the identity itself and refuses a caller-supplied one', () => {
  const { proj, art, fp } = boundFixture('bind-stamp');
  const e = journal.appendEvent(proj, keepFields(art), { verifiedHash: fp.hash });
  assert.strictEqual(e.artifactId, art.id);
  assert.strictEqual(e.artifactRev, fp.rev, 'the CLI computed the rev');
  assert.strictEqual(e.artifactHash, fp.hash, 'the CLI computed the hash');
  assert.strictEqual(e.hashScope, 'file');
  assert.strictEqual(e.source, 'evolve');

  for (const forged of [{ artifactRev: 99 }, { artifactHash: 'deadbeef' }]) {
    assert.throws(
      () => journal.appendEvent(proj, keepFields(art, forged), { verifiedHash: fp.hash }),
      /computed by the CLI, not supplied/
    );
  }
  // and a bound event cannot carry a hand-picked id
  assert.throws(
    () => journal.appendEvent(proj, keepFields(art, { id: 'evo_hand_written' }), { verifiedHash: fp.hash }),
    /machine/i
  );
});

ok('a code artifact cannot be bound through mode:"docs" to dodge the seam gate', () => {
  const { proj, art, fp } = boundFixture('bind-mode');
  // docs mode skips the seam gate entirely — so the mode must be derived, not claimed.
  assert.throws(
    () => journal.appendEvent(proj, keepFields(art, { mode: 'docs', seam: {} }), { verifiedHash: fp.hash }),
    /mode/i
  );
  // derived from the bound artifact, the seam gate bites
  assert.throws(
    () => journal.appendEvent(proj, keepFields(art, { seam: {} }), { verifiedHash: fp.hash }),
    /seam/i
  );
  const e = journal.appendEvent(proj, keepFields(art), { verifiedHash: fp.hash });
  assert.strictEqual(e.mode, 'code', 'mode is derived from the artifact it binds to');
});

ok('binding refuses a stale verification — edit the file, the proof is void', () => {
  const { proj, art, fp, file } = boundFixture('bind-stale');
  assert.throws(() => journal.appendEvent(proj, keepFields(art)), /verifiedHash/);
  fs.writeFileSync(file, 'edited after the harness ran', 'utf8');
  assert.throws(
    () => journal.appendEvent(proj, keepFields(art), { verifiedHash: fp.hash }),
    /file changed after verification/
  );
  // re-verify and it lands
  const fresh = lifecycle.fingerprint(proj, art);
  assert.ok(journal.appendEvent(proj, keepFields(art), { verifiedHash: fresh.hash }));
});

ok('binding refuses a missing or terminal artifact', () => {
  const { proj, art, fp } = boundFixture('bind-terminal');
  assert.throws(
    () => journal.appendEvent(proj, keepFields({ id: 'art-nope' }), { verifiedHash: fp.hash }),
    /no artifact/
  );
  artifacts.retractArtifact(proj, art.id, { reason: 'obsolete' });
  assert.throws(() => journal.appendEvent(proj, keepFields(art), { verifiedHash: fp.hash }), /retracted|left the lifecycle/);
});

ok('a v0.7 event stays valid and permanently unbound', () => {
  const { proj } = boundFixture('bind-legacy');
  const e = journal.appendEvent(proj, { target: 'legacy.md', verdict: 'ASK' });
  assert.strictEqual(e.artifactId, '', 'the binding fields exist and are empty, never omitted');
  assert.strictEqual(e.artifactRev, null);
  assert.strictEqual(e.hashScope, '');
});

ok('verify --artifact emits the fingerprint and refuses a target that moved under it', () => {
  const { proj, art, fp, file } = boundFixture('verify-bound');
  const v = evolveVerify.verify({ target: 'src/thing.js', testCommand: 'node -e 0', mode: 'code', cwd: proj, artifact: art });
  assert.strictEqual(v.result, 'pass');
  assert.strictEqual(v.artifactId, art.id);
  assert.strictEqual(v.verifiedHash, fp.hash, 'the caller gets exactly what log append will demand');
  assert.strictEqual(v.verifiedRev, fp.rev);
  assert.strictEqual(v.hashScope, 'file');

  // a harness that mutates its own target proves nothing about either version
  const mutator = path.join(proj, 'mutate.js');
  fs.writeFileSync(mutator, `require('fs').writeFileSync(${JSON.stringify(file)}, 'moved', 'utf8');`, 'utf8');
  assert.throws(
    () => evolveVerify.verify({ target: 'src/thing.js', testCommand: `node ${JSON.stringify(mutator)}`, mode: 'code', cwd: proj, artifact: art }),
    /changed during verification/
  );
});

ok('an unbound verify still returns the fixed shape, with the binding stated empty', () => {
  const v = evolveVerify.verify({ target: 't', mode: 'prompt' });
  assert.strictEqual(v.artifactId, '');
  assert.strictEqual(v.verifiedHash, '');
  assert.strictEqual(v.verifiedRev, null);
  assert.strictEqual(v.hashScope, '');
});

// --- closure derivation (0.8 Closure Gate) ----------------------------------

ok('fingerprint binds to file bytes, and says so when it cannot', () => {
  const proj = path.join(tmp, 'fp-fixture');
  fs.mkdirSync(path.join(proj, 'src'), { recursive: true });
  fs.writeFileSync(path.join(proj, 'src', 'a.js'), 'one', 'utf8');

  const file = lifecycle.fingerprint(proj, { id: 'a1', path: 'src/a.js', rev: 2 });
  assert.strictEqual(file.hashScope, 'file');
  assert.strictEqual(file.rev, 2);
  assert.strictEqual(file.downgradeReason, '', 'a real file needs no excuse');
  fs.writeFileSync(path.join(proj, 'src', 'a.js'), 'two', 'utf8');
  assert.notStrictEqual(lifecycle.fingerprint(proj, { id: 'a1', path: 'src/a.js', rev: 2 }).hash, file.hash,
    'editing the file changes the identity proof binds to');

  // no path at all → the record IS the artifact
  const rec = lifecycle.fingerprint(proj, { id: 'a2', kind: 'spec', title: 't', holes: [] });
  assert.strictEqual(rec.hashScope, 'record');
  assert.strictEqual(rec.rev, 1, 'a missing rev counts as 1, never 0');

  // the real dogfood value: a fragment-bearing path is not a file
  const frag = lifecycle.fingerprint(proj, { id: 'a3', path: 'CHANGELOG.md#unreleased', title: 't' });
  assert.strictEqual(frag.hashScope, 'record');
  assert.ok(/does not resolve to a file/.test(frag.downgradeReason), 'the downgrade states its reason');
});

ok('fingerprint refuses to bind outside the project, or to a directory', () => {
  const proj = path.join(tmp, 'fp-refuse');
  fs.mkdirSync(path.join(proj, 'sub'), { recursive: true });
  assert.throws(() => lifecycle.fingerprint(proj, { id: 'x', path: 'sub' }), /not a regular file/);
  assert.throws(() => lifecycle.fingerprint(proj, { id: 'x', path: '../escape.md' }), /outside the project/);
  assert.throws(() => lifecycle.fingerprint(proj, { id: 'x', path: path.join(tmp, 'elsewhere.md') }), /outside the project/);
});

ok('a REVERT on the same binding revokes an older KEEP', () => {
  const artifact = { id: 'art-1', title: 't', kind: 'spec', holes: [], rev: 1 };
  const fp = lifecycle.fingerprint(tmp, artifact);
  const bind = { artifactId: 'art-1', artifactRev: fp.rev, artifactHash: fp.hash };
  assert.ok(lifecycle.bindingEvent(artifact, [{ ...bind, verdict: 'KEEP' }], fp), 'a KEEP on the binding authorizes');
  assert.strictEqual(
    lifecycle.bindingEvent(artifact, [{ ...bind, verdict: 'KEEP' }, { ...bind, verdict: 'REVERT' }], fp),
    null,
    'the latest event on the binding wins — a later REVERT revokes the KEEP'
  );
  // and it never falls back to path/title matching
  assert.strictEqual(
    lifecycle.bindingEvent(artifact, [{ target: 't', verdict: 'KEEP' }], fp), null,
    'an unbound event is evidence about a file, never authority over a record'
  );
  // a stale hash (the artifact was revised after the proof) does not authorize
  assert.strictEqual(
    lifecycle.bindingEvent(artifact, [{ ...bind, artifactHash: 'stale', verdict: 'KEEP' }], fp), null
  );
});

ok('a bare legacy status:"closed" is uncertified — not closed', () => {
  assert.strictEqual(lifecycle.isClosed({ status: 'closed' }), false, 'status alone is a claim, not a certificate');
  assert.strictEqual(lifecycle.isClosed({ status: 'closed', closedBy: 'evo_1', closedRev: 1 }), false, 'no hash, no certificate');
  assert.strictEqual(
    lifecycle.isClosed({ status: 'closed', closedBy: 'evo_1', closedRev: 1, closedHash: 'abc' }), true
  );
});

ok('closureBlockers lists everything in one fixed order', () => {
  const artifact = { id: 'art-p', kind: 'probe', title: 'probe: x', holes: ['disposal: pending'], rev: 1 };
  const st = { artifacts: [artifact], defects: [{ id: 'd1', artifact: 'art-p', severity: 'high', status: 'open' }] };
  const codes = lifecycle.closureBlockers(st, [], artifact, tmp).map((b) => b.code);
  assert.deepStrictEqual(codes, ['probe', 'no-bound-proof', 'open-defects', 'holes'], 'fixed order, every blocker named');

  // clean + bound + no defects + no holes → closable
  const clean = { id: 'art-c', kind: 'spec', title: 't', holes: [], rev: 1 };
  const fp = lifecycle.fingerprint(tmp, clean);
  const bound = [{ artifactId: 'art-c', artifactRev: fp.rev, artifactHash: fp.hash, verdict: 'KEEP' }];
  assert.deepStrictEqual(lifecycle.closureBlockers({ artifacts: [clean], defects: [] }, bound, clean, tmp), []);
  // holes alone block, and the waiver in the request clears exactly that one
  const holey = { ...clean, holes: ['TODO'] };
  const fpH = lifecycle.fingerprint(tmp, holey);
  const boundH = [{ artifactId: 'art-c', artifactRev: fpH.rev, artifactHash: fpH.hash, verdict: 'KEEP' }];
  assert.deepStrictEqual(
    lifecycle.closureBlockers({ artifacts: [holey], defects: [] }, boundH, holey, tmp).map((b) => b.code), ['holes']
  );
  assert.deepStrictEqual(
    lifecycle.closureBlockers({ artifacts: [holey], defects: [] }, boundH, holey, tmp,
      { waiveHoles: true, owner: 'danny', reason: 'shipping without it' }), []
  );
});

ok('workflowClosed refuses to call it closed while an orphan defect is open', () => {
  const clean = { id: 'art-w', kind: 'spec', title: 't', holes: [], rev: 1, status: 'v1' };
  const fp = lifecycle.fingerprint(tmp, clean);
  const closed = { ...clean, status: 'closed', closedBy: 'evo_x', closedRev: fp.rev, closedHash: fp.hash };
  const events = [{ artifactId: 'art-w', artifactRev: fp.rev, artifactHash: fp.hash, verdict: 'KEEP' }];
  assert.strictEqual(lifecycle.workflowClosed({ artifacts: [closed], defects: [] }, events, tmp).closed, true);
  const withOrphan = lifecycle.workflowClosed(
    { artifacts: [closed], defects: [{ id: 'd-orphan', artifact: '', severity: 'low', status: 'open' }] }, events, tmp
  );
  assert.strictEqual(withOrphan.closed, false, 'a legacy orphan defect must not slip workflow closure');
  assert.ok(withOrphan.blockers.some((b) => b.code === 'unattached-defects'));
  assert.ok(withOrphan.scope, 'the closure read names its scope');
});

ok('nextTransition derives one move, in precedence order, with a fixed shape', () => {
  const shape = (t) => {
    for (const k of ['label', 'command', 'reason', 'scope']) assert.ok(t[k], `transition always carries ${k}`);
    return t;
  };
  // 1. no objective outranks everything
  assert.ok(/lock/i.test(shape(lifecycle.nextTransition({}, [], tmp)).command));
  // 2. an open critical/high defect outranks the artifact
  const withDefect = shape(lifecycle.nextTransition(
    { objective: 'o', defects: [{ id: 'd9', severity: 'critical', status: 'open' }] }, [], tmp
  ));
  assert.ok(/defect resolve d9/.test(withDefect.command));
  // 3. a live artifact's first blocker supplies the remedy
  const art = { id: 'art-n', kind: 'spec', title: 't', holes: [], rev: 1, status: 'v0' };
  const unproven = shape(lifecycle.nextTransition({ objective: 'o', artifacts: [art] }, [], tmp));
  assert.ok(/ratchet-evolve verify/.test(unproven.command), 'no bound proof → bind proof');
  // 4. a closable artifact names close
  const fp = lifecycle.fingerprint(tmp, art);
  const bound = [{ artifactId: 'art-n', artifactRev: fp.rev, artifactHash: fp.hash, verdict: 'KEEP' }];
  assert.strictEqual(
    shape(lifecycle.nextTransition({ objective: 'o', artifacts: [art] }, bound, tmp)).command,
    'ratchet artifact close art-n'
  );
  // 5. all closed + dirty → checkpoint
  const closed = { ...art, status: 'closed', closedBy: 'e', closedRev: fp.rev, closedHash: fp.hash };
  assert.strictEqual(
    shape(lifecycle.nextTransition({ objective: 'o', artifacts: [closed], dirty: true }, bound, tmp)).command,
    'ratchet compile done'
  );
  // 6. nothing pending is stated, never omitted
  assert.strictEqual(
    shape(lifecycle.nextTransition({ objective: 'o', artifacts: [closed], dirty: false }, bound, tmp)).command,
    'nothing pending'
  );
});

fs.rmSync(tmp, { recursive: true, force: true });
process.stdout.write(`\n${passed} passed\n`);
