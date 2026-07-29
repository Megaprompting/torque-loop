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
const lifecycle = require('../src/lifecycle');
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
  // 0.8 contract change (deliberate, not a weakened assertion): every metered
  // sequence ends on compile, including A0. A snap that never serializes leaves
  // the work unrecorded, which is the one outcome the loop exists to prevent.
  assert.deepStrictEqual(snap.sequence, ['build', 'verify', 'compile']);

  const mid = scoring.scoreAperture({ ambiguity: 1, terrain: 1, taste: 1, blastRadius: 1, reversibility: 1 });
  assert.strictEqual(mid.score, 5);
  assert.strictEqual(mid.level, 'A2');

  const max = scoring.scoreAperture({ ambiguity: 2, terrain: 2, taste: 2, blastRadius: 2, reversibility: 2 });
  assert.strictEqual(max.score, 10);
  assert.strictEqual(max.level, 'A4');
  assert.strictEqual(max.implement, false, 'A4 must not build before constraints are locked');
  assert.ok(!max.sequence.includes('build'), 'A4 produces options, not code');
});

ok('every metered sequence ends on compile, and verify follows the last build', () => {
  // Two invariants, not five hardcoded lists: a sequence that stops before
  // compile loses the work, and a sequence that builds after its last verify
  // ships something nothing ever ran.
  for (const band of scoring.APERTURE_LEVELS) {
    const seq = band.sequence;
    assert.strictEqual(seq[seq.length - 1], 'compile', `${band.level} ends on compile (got ${seq.join(' → ')})`);
    if (seq.includes('build')) {
      const lastWrite = Math.max(seq.lastIndexOf('build'), seq.lastIndexOf('patch'));
      const verifyAt = seq.lastIndexOf('verify');
      assert.ok(verifyAt > lastWrite, `${band.level} verifies after its last build/patch (got ${seq.join(' → ')})`);
    }
  }
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

ok('an unreadable state file is never mistaken for a missing one', () => {
  // ENOENT means "no state yet" and a fresh one is right. Any OTHER read error —
  // an ACL that denies read but permits write, a locked file, EIO — means the
  // record EXISTS and we cannot see it, and reinitializing over it is a silent
  // wipe of the one thing this tool promises to keep.
  const proj = path.join(tmp, 'unreadable');
  state.initProject(proj, { force: true });
  const sp = state.statePath(proj);
  const marker = JSON.stringify({ version: 1, objective: 'still here' });
  fs.writeFileSync(sp, marker, 'utf8');

  const origRead = fs.readFileSync;
  fs.readFileSync = (file, ...rest) => {
    if (String(file) === sp) {
      const e = new Error('permission denied');
      e.code = 'EACCES';
      throw e;
    }
    return origRead(file, ...rest);
  };
  try {
    assert.throws(() => state.loadState(proj), /EACCES|could not be read|refusing/i);
  } finally {
    fs.readFileSync = origRead;
  }
  assert.strictEqual(fs.readFileSync(sp, 'utf8'), marker, 'the record survived the failed read');
  // ENOENT still means a clean start
  fs.rmSync(sp, { force: true });
  assert.ok(state.loadState(proj).version, 'a missing file still auto-initializes');
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

ok('a legacy-cased store migrates even when the FIRST call spells the cwd lowercase', () => {
  if (process.platform !== 'win32') return; // the fallback only exists on win32
  // The residual stranding: deriving the legacy slug from the CALLER's spelling
  // means a caller who happens to type the path in lowercase produces
  // normalized === legacy, the discovery is skipped entirely, and the real
  // mixed-case store is stranded forever behind a fresh empty one. The casing
  // has to come from the filesystem, which knows it, not from the caller, who
  // may not. Ordering matters here: lowercase FIRST is the whole test.
  const onDisk = path.join(tmp, 'SlugLower', 'Repo'); // created with mixed casing
  fs.mkdirSync(onDisk, { recursive: true });
  const spelledLower = onDisk.toLowerCase(); // what the caller supplies

  const projects = path.join(state.baseDir(), 'projects');
  const legacySlug = state.legacySlugFor(spelledLower);
  const normalizedSlug = state.normalizedSlugFor(spelledLower);
  assert.notStrictEqual(
    legacySlug, normalizedSlug,
    'the slugs are derived from the on-disk casing, so a lowercase spelling still finds the legacy one'
  );

  fs.rmSync(path.join(projects, legacySlug), { recursive: true, force: true });
  fs.rmSync(path.join(projects, normalizedSlug), { recursive: true, force: true });
  fs.mkdirSync(path.join(projects, legacySlug), { recursive: true });
  fs.writeFileSync(
    path.join(projects, legacySlug, 'state.json'),
    JSON.stringify({ version: 1, objective: 'written under the old casing', artifacts: [], defects: [], history: [] }),
    'utf8'
  );

  // the FIRST post-upgrade call uses the lowercase spelling
  assert.strictEqual(state.projectSlug(spelledLower), normalizedSlug, 'it migrates rather than stranding');
  assert.ok(!fs.existsSync(path.join(projects, legacySlug)), 'the legacy dir is gone, not left as a decoy');
  assert.strictEqual(
    state.loadState(spelledLower).objective, 'written under the old casing', 'and the record came with it'
  );
  // and the mixed-case spelling of the same path resolves to that same store
  assert.strictEqual(state.loadState(onDisk).objective, 'written under the old casing');
});

ok('two stores for one path is a conflict to name, never a guess to make', () => {
  if (process.platform !== 'win32') return;
  const proj = path.join(tmp, 'SlugConflict', 'Repo');
  const projects = path.join(state.baseDir(), 'projects');
  const legacySlug = state.legacySlugFor(proj);
  const normalizedSlug = state.normalizedSlugFor(proj);
  for (const slug of [legacySlug, normalizedSlug]) {
    fs.mkdirSync(path.join(projects, slug), { recursive: true });
    fs.writeFileSync(path.join(projects, slug, 'state.json'), JSON.stringify({ version: 1, objective: slug }), 'utf8');
  }
  // Merging is not ours to invent and picking one silently loses the other.
  assert.throws(() => state.projectSlug(proj), /both|conflict/i);
  const e = (() => { try { state.projectSlug(proj); } catch (err) { return err; } })();
  assert.ok(e.message.includes(legacySlug) && e.message.includes(normalizedSlug), 'the refusal names both paths');
  fs.rmSync(path.join(projects, legacySlug), { recursive: true, force: true });
  fs.rmSync(path.join(projects, normalizedSlug), { recursive: true, force: true });
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
  // 0.8: --force says "I mean it"; --owner/--reason say who meant it and why.
  cli.run(['node', 'ratchet', 'state', 'reset', '--force', '--owner', 'danny', '--reason', 'fixture reset']);
  assert.strictEqual(state.loadState(cwd).objective, '', 'an authorized reset --force wipes state');
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

ok('a legacy or falsey-shaped retry is still a no-op', () => {
  // Birth coerced with falsey defaults (`item.title || 'untitled'`) while the
  // revision path coerced with String(), so the two disagreed about what the
  // "same" payload means — and a legacy record with no holes array normalized on
  // first touch, bumping rev and silently invalidating any proof bound to it.
  state.initProject(cwd, { force: true });
  const s = state.loadState(cwd);
  s.artifacts = [{ id: 'art-legacy', at: '2026-07-01T00:00:00.000Z', kind: 'docs', title: 'old', status: 'v1' }];
  state.saveState(cwd, s);

  const before = fs.readFileSync(state.statePath(cwd), 'utf8');
  const same = artifacts.addArtifact(cwd, { id: 'art-legacy', kind: 'docs', title: 'old', status: 'v1' });
  assert.strictEqual(fs.readFileSync(state.statePath(cwd), 'utf8'), before, 'normalizing a missing legacy holes array writes nothing');
  assert.strictEqual(same.rev, undefined, 'the legacy record is left exactly as it was');
  assert.strictEqual(lifecycle.fingerprint(cwd, same).rev, 1, 'and a missing rev still reads as 1, so proof stays bound');

  // falsey-shaped payloads round-trip identically through both paths
  state.initProject(cwd, { force: true });
  const born = artifacts.addArtifact(cwd, { id: 'art-falsey', kind: 'spec', title: '', path: '', holes: [] });
  const mid = fs.readFileSync(state.statePath(cwd), 'utf8');
  const retried = artifacts.addArtifact(cwd, { id: 'art-falsey', kind: 'spec', title: '', path: '', holes: [] });
  assert.strictEqual(retried.rev, born.rev, 'an identical falsey-shaped retry does not bump rev');
  assert.strictEqual(fs.readFileSync(state.statePath(cwd), 'utf8'), mid, 'byte-identical state');
});

ok('a scalar holes value is a real hole, and repairing it is a real revision', () => {
  // Canonicalization made holes:"TODO" and holes:["TODO"] compare equal, so the
  // repair no-opped and the SCALAR survived in the store — where every
  // Array.isArray guard reads it as ZERO holes. The artifact then closes with an
  // open hole nobody can see.
  state.initProject(cwd, { force: true });
  const s = state.loadState(cwd);
  s.artifacts = [{ id: 'art-scalar', at: '2026-07-01T00:00:00.000Z', kind: 'spec', title: 'legacy', status: 'v1', holes: 'TODO', rev: 1 }];
  state.saveState(cwd, s);

  // the closure gate must not be fooled by the shape
  const scalar = state.loadState(cwd).artifacts[0];
  const codes = lifecycle.closureBlockers(state.loadState(cwd), [], scalar, cwd).map((b) => b.code);
  assert.ok(codes.includes('holes'), `a scalar hole still blocks closure, got: ${codes.join(',')}`);

  // and repairing the shape is a REVISION, not a silent no-op
  const repaired = artifacts.addArtifact(cwd, { id: 'art-scalar', holes: ['TODO'] });
  assert.strictEqual(repaired.rev, 2, 'normalizing a present non-array holes value is a real revision');
  assert.deepStrictEqual(repaired.holes, ['TODO'], 'and the array shape is what persists');
  // once repaired, an identical retry is a no-op again
  const before = fs.readFileSync(state.statePath(cwd), 'utf8');
  assert.strictEqual(artifacts.addArtifact(cwd, { id: 'art-scalar', holes: ['TODO'] }).rev, 2);
  assert.strictEqual(fs.readFileSync(state.statePath(cwd), 'utf8'), before, 'byte-identical after the repair');
});

ok('clearing a lineage link is a revision; only an ABSENT one is idempotent', () => {
  state.initProject(cwd, { force: true });
  artifacts.addArtifact(cwd, { id: 'art-lineage', kind: 'spec', title: 'v2', revises: 'art-old' });
  assert.strictEqual(state.loadState(cwd).artifacts[0].revises, 'art-old');

  // absent → leave it alone (idempotent)
  const untouched = artifacts.addArtifact(cwd, { id: 'art-lineage', title: 'v2' });
  assert.strictEqual(untouched.rev, 1, 'omitting revises does not clear it');
  assert.strictEqual(untouched.revises, 'art-old');

  // explicitly empty → CLEAR it, and that is a real revision
  const cleared = artifacts.addArtifact(cwd, { id: 'art-lineage', revises: '' });
  assert.strictEqual(cleared.rev, 2, 'clearing a lineage claim is a revision');
  assert.ok(!('revises' in cleared), 'the field is gone, not left as an empty string');

  // and the same clear again is a no-op
  const before = fs.readFileSync(state.statePath(cwd), 'utf8');
  assert.strictEqual(artifacts.addArtifact(cwd, { id: 'art-lineage', revises: '' }).rev, 2);
  assert.strictEqual(fs.readFileSync(state.statePath(cwd), 'utf8'), before, 'byte-identical on the repeated clear');
});

ok('a defect whose artifact cannot be fingerprinted is recorded, never half-attached', () => {
  // The stamp used to fail silently, leaving the defect attached with
  // artifactRev:null and artifactHash:'' — an attachment that blocks the
  // artifact's closure while carrying no evidence of which revision it attacks.
  const proj = path.join(tmp, 'defect-stamp-fail');
  fs.rmSync(proj, { recursive: true, force: true });
  fs.mkdirSync(proj, { recursive: true });
  state.initProject(proj, { force: true });
  const s = state.loadState(proj);
  // a path that refuses to bind at all (escapes the project)
  s.artifacts = [{ id: 'art-escape', at: '2026-07-01T00:00:00.000Z', kind: 'code', title: 'escapes', status: 'v0', path: '../outside.js', holes: [], rev: 1 }];
  state.saveState(proj, s);

  const { state: d } = artifacts.addDefect(proj, { severity: 'high', summary: 'found it anyway' }, { alsoLedger: false });
  assert.strictEqual(d.artifact, '', 'no half-stamped attachment');
  assert.strictEqual(d.attachedBy, 'error', 'the failure is named, not swallowed');
  assert.ok(/outside the project/.test(d.attachError), `the reason travels: ${d.attachError}`);
  assert.strictEqual(state.loadState(proj).defects.length, 1, 'the finding is still recorded — that matters more');
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
  // 'closed' is the pre-0.3 alias for resolved and is TERMINAL to the scorer, so
  // transitioning into it with no evidence cleared the drain with no proof at
  // all — the one unguarded door in an otherwise gated set.
  assert.throws(() => artifacts.transitionDefect(cwd, d.id, 'closed', {}), /resolve|waive|supersede/i);
  assert.throws(() => artifacts.transitionDefect(cwd, d.id, 'closed', { evidence: 'even with proof' }), /resolve|waive|supersede/i);
  assert.throws(() => cli.run(['node', 'ratchet', 'defect', 'closed', d.id]), /usage|resolve/i);
  assert.strictEqual(state.loadState(cwd).defects.find((x) => x.id === d.id).status, 'open', 'nothing leaked through');
});

ok('a legacy "closed" defect still reads as terminal, it just cannot be written', () => {
  // Read-only alias: stores written before 0.3 carry status:'closed' and must
  // keep scoring as terminal. Only the WRITE path is closed.
  const legacy = { id: 'd-legacy', severity: 'critical', summary: 'old', status: 'closed' };
  assert.strictEqual(scoring.isDefectOpen(legacy), false, 'a legacy closed defect does not drain');
});

ok('init --force is the same irreversible wipe as state reset, and gated the same', () => {
  state.initProject(cwd, { force: true });
  const s = state.loadState(cwd);
  s.objective = 'do not lose me through the other door';
  state.saveState(cwd, s);

  assert.throws(() => cli.run(['node', 'ratchet', 'init', '--force']), /owner/);
  assert.throws(() => cli.run(['node', 'ratchet', 'init', '--force', '--owner', 'danny']), /reason/);
  assert.strictEqual(
    state.loadState(cwd).objective, 'do not lose me through the other door',
    'an unauthorized init --force must not wipe what state reset --force refuses to wipe'
  );

  cli.run(['node', 'ratchet', 'init', '--force', '--owner', 'danny', '--reason', 'fresh run']);
  const after = state.loadState(cwd);
  assert.strictEqual(after.objective, '');
  const tomb = (after.history || []).find((h) => h.event === 'state.reset');
  assert.ok(tomb && /danny/.test(tomb.note) && /fresh run/.test(tomb.note), 'the same tombstone, through either door');
  // plain init still just ensures the dir exists
  assert.doesNotThrow(() => cli.run(['node', 'ratchet', 'init']));
});

// --- write-boundary gates (0.8 Closure Gate) --------------------------------

ok('the checkpoint scalars cannot be set by hand — compile done is the only transition', () => {
  state.initProject(cwd, { force: true });
  assert.throws(() => cli.run(['node', 'ratchet', 'state', 'set', 'dirty', 'false']), /not a settable scalar/);
  assert.throws(() => cli.run(['node', 'ratchet', 'state', 'set', 'lastCompileAt', '2026-01-01']), /not a settable scalar/);
  cli.run(['node', 'ratchet', 'touch', 'README.md']);
  assert.strictEqual(state.loadState(cwd).dirty, true, 'a bypass would have cleared this silently');
});

ok('state reset --force names who reset and why, and leaves a tombstone', () => {
  state.initProject(cwd, { force: true });
  const s = state.loadState(cwd);
  s.objective = 'do not lose me quietly';
  state.saveState(cwd, s);
  assert.throws(() => cli.run(['node', 'ratchet', 'state', 'reset', '--force']), /owner/);
  assert.throws(() => cli.run(['node', 'ratchet', 'state', 'reset', '--force', '--owner', 'danny']), /reason/);
  assert.strictEqual(state.loadState(cwd).objective, 'do not lose me quietly', 'an unauthorized reset changes nothing');

  cli.run(['node', 'ratchet', 'state', 'reset', '--force', '--owner', 'danny', '--reason', 'starting a new run']);
  const after = state.loadState(cwd);
  assert.strictEqual(after.objective, '', 'the authorized reset wiped state');
  const tomb = (after.history || []).find((h) => h.event === 'state.reset');
  assert.ok(tomb, 'the fresh state opens with a tombstone, not a blank slate');
  assert.ok(/danny/.test(tomb.note) && /new run/.test(tomb.note), 'the tombstone names who and why');
});

ok('state append forces birth status and dedups on text', () => {
  state.initProject(cwd, { force: true });
  cli.run(['node', 'ratchet', 'state', 'append', 'assumptions', '{"text":"the seam is stable"}']);
  assert.strictEqual(state.loadState(cwd).assumptions[0].status, 'untested');
  // an assumption born "tested" is an untested assumption wearing a badge
  assert.throws(
    () => cli.run(['node', 'ratchet', 'state', 'append', 'assumptions', '{"text":"x","status":"tested"}']),
    /born/
  );
  // dedup on trimmed text
  cli.run(['node', 'ratchet', 'state', 'append', 'assumptions', '{"text":"  the seam is stable  "}']);
  assert.strictEqual(state.loadState(cwd).assumptions.length, 1, 'the same assumption is one drain, not two');

  cli.run(['node', 'ratchet', 'state', 'append', 'openLoops', '{"text":"decide the store shape"}']);
  assert.strictEqual(state.loadState(cwd).openLoops[0].status, 'open');
  assert.throws(
    () => cli.run(['node', 'ratchet', 'state', 'append', 'openLoops', '{"text":"y","status":"closed"}']),
    /born/
  );
  cli.run(['node', 'ratchet', 'state', 'append', 'openLoops', '{"text":"decide the store shape"}']);
  assert.strictEqual(state.loadState(cwd).openLoops.length, 1);
});

ok('state append cannot mint artifacts or defects behind their gates', () => {
  state.initProject(cwd, { force: true });
  assert.throws(
    () => cli.run(['node', 'ratchet', 'state', 'append', 'artifacts', '{"title":"forged","status":"closed"}']),
    /ratchet artifact add/
  );
  assert.throws(
    () => cli.run(['node', 'ratchet', 'state', 'append', 'defects', '{"summary":"forged","status":"resolved"}']),
    /ratchet defect add/
  );
  const s = state.loadState(cwd);
  assert.strictEqual(s.artifacts.length, 0);
  assert.strictEqual(s.defects.length, 0);
});

ok('the ledger defect mirror is written by transitions, not by hand', () => {
  state.initProject(cwd, { force: true });
  artifacts.addArtifact(cwd, { title: 'only', kind: 'spec' });
  const { state: d } = artifacts.addDefect(cwd, { severity: 'high', summary: 'mirror gate' });
  assert.throws(
    () => cli.run(['node', 'ratchet', 'ledger', 'update', 'defects', `{"id":"${d.ledgerId}","status":"resolved"}`]),
    /status/
  );
  assert.strictEqual(state.loadLedger(cwd).defects.find((x) => x.id === d.ledgerId).status, 'open', 'the mirror held');
  // the internal transition sync path still works
  cli.run(['node', 'ratchet', 'defect', 'resolve', d.id, '--evidence', 'fixed and re-run']);
  assert.strictEqual(state.loadLedger(cwd).defects.find((x) => x.id === d.ledgerId).status, 'resolved');
  // non-status ledger writes are untouched
  assert.doesNotThrow(() => cli.run(['node', 'ratchet', 'ledger', 'update', 'features', '{"name":"router"}']));
});

// --- proof binding (0.8 Closure Gate) ---------------------------------------


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
  const e = journal.appendEvent(proj, keepFields(art), { verifiedHash: fp.hash, verifiedRev: fp.rev });
  assert.strictEqual(e.artifactId, art.id);
  assert.strictEqual(e.artifactRev, fp.rev, 'the CLI computed the rev');
  assert.strictEqual(e.artifactHash, fp.hash, 'the CLI computed the hash');
  assert.strictEqual(e.hashScope, 'file');
  assert.strictEqual(e.source, 'evolve');

  for (const forged of [{ artifactRev: 99 }, { artifactHash: 'deadbeef' }]) {
    assert.throws(
      () => journal.appendEvent(proj, keepFields(art, forged), { verifiedHash: fp.hash, verifiedRev: fp.rev }),
      /computed by the CLI, not supplied/
    );
  }
  // and a bound event cannot carry a hand-picked id
  assert.throws(
    () => journal.appendEvent(proj, keepFields(art, { id: 'evo_hand_written' }), { verifiedHash: fp.hash, verifiedRev: fp.rev }),
    /machine/i
  );
});

ok('a code artifact cannot be bound through mode:"docs" to dodge the seam gate', () => {
  const { proj, art, fp } = boundFixture('bind-mode');
  // docs mode skips the seam gate entirely — so the mode must be derived, not claimed.
  assert.throws(
    () => journal.appendEvent(proj, keepFields(art, { mode: 'docs', seam: {} }), { verifiedHash: fp.hash, verifiedRev: fp.rev }),
    /mode/i
  );
  // derived from the bound artifact, the seam gate bites
  assert.throws(
    () => journal.appendEvent(proj, keepFields(art, { seam: {} }), { verifiedHash: fp.hash, verifiedRev: fp.rev }),
    /seam/i
  );
  const e = journal.appendEvent(proj, keepFields(art), { verifiedHash: fp.hash, verifiedRev: fp.rev });
  assert.strictEqual(e.mode, 'code', 'mode is derived from the artifact it binds to');
});

ok('binding refuses a stale verification — edit the file, the proof is void', () => {
  const { proj, art, fp, file } = boundFixture('bind-stale');
  assert.throws(() => journal.appendEvent(proj, keepFields(art)), /verifiedHash/);
  fs.writeFileSync(file, 'edited after the harness ran', 'utf8');
  assert.throws(
    () => journal.appendEvent(proj, keepFields(art), { verifiedHash: fp.hash, verifiedRev: fp.rev }),
    /file changed after verification/
  );
  // re-verify and it lands
  const fresh = lifecycle.fingerprint(proj, art);
  assert.ok(journal.appendEvent(proj, keepFields(art), { verifiedHash: fresh.hash, verifiedRev: fresh.rev }));
});

ok('binding refuses evidence gathered against an older revision', () => {
  // The metadata-only revision: the FILE never changes, so verifiedHash still
  // matches — but the artifact moved to rev 2 and the rev-1 evidence would be
  // stamped onto it. The hash alone cannot see this; the rev has to be checked.
  const { proj, art, fp } = boundFixture('bind-stale-rev');
  artifacts.addArtifact(proj, { id: art.id, title: 'thing, retitled' });
  const revised = state.loadState(proj).artifacts.find((a) => a.id === art.id);
  assert.strictEqual(revised.rev, 2, 'a metadata-only revision still bumps rev');
  assert.strictEqual(lifecycle.fingerprint(proj, revised).hash, fp.hash, 'and the file hash is unchanged');

  assert.throws(
    () => journal.appendEvent(proj, keepFields(revised), { verifiedHash: fp.hash, verifiedRev: 1 }),
    /rev|re-verify/i
  );
  // a bound append must state the rev it verified at all
  assert.throws(
    () => journal.appendEvent(proj, keepFields(revised), { verifiedHash: fp.hash }),
    /verifiedRev/
  );
  // re-verify against the current revision and it lands
  const fresh = lifecycle.fingerprint(proj, revised);
  const e = journal.appendEvent(proj, keepFields(revised), { verifiedHash: fresh.hash, verifiedRev: fresh.rev });
  assert.strictEqual(e.artifactRev, 2);
});

ok('a bound event cannot claim its own provenance', () => {
  const { proj, art, fp } = boundFixture('bind-source');
  // Refusing only a DIFFERENT value is the weaker gate: the forgery that matters
  // supplies the RIGHT-looking value, so the field must be refused if present at
  // all. The CLI always stamps it.
  for (const forged of ['forged', 'evolve', '', null, 0]) {
    assert.throws(
      () => journal.appendEvent(proj, keepFields(art, { source: forged }), { verifiedHash: fp.hash, verifiedRev: fp.rev }),
      /source/i,
      `source: ${JSON.stringify(forged)} must be refused`
    );
  }
  const e = journal.appendEvent(proj, keepFields(art), { verifiedHash: fp.hash, verifiedRev: fp.rev });
  assert.strictEqual(e.source, 'evolve', 'the CLI stamps provenance on a bound event');
});

ok('binding refuses a missing or terminal artifact', () => {
  const { proj, art, fp } = boundFixture('bind-terminal');
  assert.throws(
    () => journal.appendEvent(proj, keepFields({ id: 'art-nope' }), { verifiedHash: fp.hash, verifiedRev: fp.rev }),
    /no artifact/
  );
  artifacts.retractArtifact(proj, art.id, { reason: 'obsolete' });
  assert.throws(() => journal.appendEvent(proj, keepFields(art), { verifiedHash: fp.hash, verifiedRev: fp.rev }), /retracted|left the lifecycle/);
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

// --- artifact close + loop/assumption transitions (0.8 Closure Gate) --------

// Run a body with the process rooted in `proj` and the evolve journal scoped to
// it, so `cli.run` (which always reads process.cwd()) works on the fixture.
function inProject(proj, body) {
  const prevCwd = process.cwd();
  const prevLog = process.env.RATCHET_EVOLVE_LOG;
  process.env.RATCHET_EVOLVE_LOG = path.join(proj, 'evolve-log.jsonl');
  process.chdir(proj);
  try {
    return body();
  } finally {
    process.chdir(prevCwd);
    process.env.RATCHET_EVOLVE_LOG = prevLog;
  }
}

function say(fn) {
  const chunks = [];
  const orig = process.stdout.write;
  process.stdout.write = (str) => { chunks.push(String(str)); return true; };
  try {
    fn();
  } finally {
    process.stdout.write = orig;
  }
  return chunks.join('');
}

ok('artifact close refuses every blocker at once, in one fixed order', () => {
  const { proj, art } = boundFixture('close-blockers', { kind: 'probe', file: 'src/p.js' });
  inProject(proj, () => {
    artifacts.addArtifact(proj, { id: art.id, holes: ['unanswered: does it double-fire?'] });
    artifacts.addDefect(proj, { severity: 'high', summary: 'still red', artifact: art.id });
    try {
      cli.run(['node', 'ratchet', 'artifact', 'close', art.id]);
      assert.fail('a probe with defects, holes and no proof must not close');
    } catch (e) {
      const codes = (e.message.match(/\[([a-z-]+)\]/g) || []).map((m) => m.slice(1, -1));
      assert.deepStrictEqual(codes, ['probe', 'no-bound-proof', 'open-defects', 'holes'], e.message);
      assert.ok(/a probe never closes/.test(e.message), 'the probe refusal keeps its house voice');
      assert.ok(/Checkpoint is not closure/.test(e.message), 'the no-proof refusal names the slogan');
    }
  });
});

ok('artifact close is earned by bound proof, then idempotent', () => {
  const { proj, art } = boundFixture('close-happy', { kind: 'code', file: 'src/thing.js' });
  inProject(proj, () => {
    // no proof yet
    assert.throws(() => cli.run(['node', 'ratchet', 'artifact', 'close', art.id]), /no KEEP proof bound/);
    const v = evolveVerify.verify({ target: 'src/thing.js', testCommand: 'node -e 0', mode: 'code', cwd: proj, artifact: art });
    journal.appendEvent(proj, keepFields(art), { verifiedHash: v.verifiedHash, verifiedRev: v.verifiedRev });

    const first = say(() => cli.run(['node', 'ratchet', 'artifact', 'close', art.id]));
    assert.ok(/closed — rev 1/.test(first), first);
    const closed = state.loadState(proj).artifacts.find((a) => a.id === art.id);
    assert.strictEqual(closed.status, 'closed');
    assert.strictEqual(closed.closedRev, v.verifiedRev);
    assert.strictEqual(closed.closedHash, v.verifiedHash);
    assert.ok(closed.closedBy, 'the certificate names the proof that authorized it');
    assert.ok(closed.closedAt);
    assert.strictEqual(state.loadState(proj).dirty, true);
    assert.ok(state.loadState(proj).history.some((h) => h.event === 'artifact.closed'));

    // a second close is a no-op, not an error — re-running a serialize block is free
    const again = say(() => cli.run(['node', 'ratchet', 'artifact', 'close', art.id]));
    assert.ok(/already closed/.test(again), again);
    // and the closed record cannot be edited away
    assert.throws(() => artifacts.addArtifact(proj, { id: art.id, title: 'rewrite history' }), /historical fact/);
  });
});

ok('revising an artifact invalidates the proof bound to its old revision', () => {
  const { proj, art } = boundFixture('close-revised', { kind: 'code', file: 'src/thing.js' });
  inProject(proj, () => {
    const v = evolveVerify.verify({ target: 'src/thing.js', testCommand: 'node -e 0', mode: 'code', cwd: proj, artifact: art });
    journal.appendEvent(proj, keepFields(art), { verifiedHash: v.verifiedHash, verifiedRev: v.verifiedRev });
    // rev 1 is closable...
    assert.deepStrictEqual(
      lifecycle.closureBlockers(state.loadState(proj), journal.readEvents(proj),
        state.loadState(proj).artifacts.find((a) => a.id === art.id), proj), []
    );
    // ...and revising it is not
    artifacts.addArtifact(proj, { id: art.id, title: 'thing, revised' });
    assert.throws(() => cli.run(['node', 'ratchet', 'artifact', 'close', art.id]), /rev 2/);
  });
});

ok('a record-scope close must be authorized by name', () => {
  const proj = path.join(tmp, 'close-record');
  fs.rmSync(proj, { recursive: true, force: true });
  fs.mkdirSync(proj, { recursive: true });
  state.initProject(proj, { force: true });
  // the real dogfood shape: a path that is not a file
  const art = artifacts.addArtifact(proj, { title: 'release note', kind: 'docs', path: 'CHANGELOG.md#unreleased' });
  inProject(proj, () => {
    const fp = lifecycle.fingerprint(proj, art);
    assert.strictEqual(fp.hashScope, 'record');
    journal.appendEvent(proj, {
      target: 'CHANGELOG.md', artifactId: art.id, verdict: 'KEEP',
      verification: { manualChecks: ['read end to end against the diff'], result: 'manual' },
    }, { verifiedHash: fp.hash, verifiedRev: fp.rev });
    assert.throws(() => cli.run(['node', 'ratchet', 'artifact', 'close', art.id]), /record-scope/);
    cli.run(['node', 'ratchet', 'artifact', 'close', art.id, '--owner', 'danny', '--reason', 'no file ships; the record is the artifact']);
    assert.strictEqual(state.loadState(proj).artifacts.find((a) => a.id === art.id).status, 'closed');
  });
});

ok('holes block a close until they are filled or waived by a named owner', () => {
  const { proj, art } = boundFixture('close-holes', { kind: 'code', file: 'src/thing.js' });
  inProject(proj, () => {
    artifacts.addArtifact(proj, { id: art.id, holes: ['no rollback path'] });
    const live = state.loadState(proj).artifacts.find((a) => a.id === art.id);
    const v = evolveVerify.verify({ target: 'src/thing.js', testCommand: 'node -e 0', mode: 'code', cwd: proj, artifact: live });
    journal.appendEvent(proj, keepFields(live), { verifiedHash: v.verifiedHash, verifiedRev: v.verifiedRev });
    assert.throws(() => cli.run(['node', 'ratchet', 'artifact', 'close', art.id]), /open hole/);
    assert.throws(() => cli.run(['node', 'ratchet', 'artifact', 'close', art.id, '--waive-holes']), /open hole/);
    cli.run(['node', 'ratchet', 'artifact', 'close', art.id, '--waive-holes', '--owner', 'danny', '--reason', 'rollback lands next release']);
    const closed = state.loadState(proj).artifacts.find((a) => a.id === art.id);
    assert.strictEqual(closed.status, 'closed');
    assert.deepStrictEqual(closed.holesWaiver, { by: 'danny', reason: 'rollback lands next release' });
  });
});

ok('loops close with evidence; parking stops the nagging but keeps the drain', () => {
  state.initProject(cwd, { force: true });
  cli.run(['node', 'ratchet', 'state', 'append', 'openLoops', '{"text":"pick the store shape"}']);
  const loopId = state.loadState(cwd).openLoops[0].id;
  assert.throws(() => cli.run(['node', 'ratchet', 'state', 'close', 'openLoops', loopId]), /evidence/);
  const drained = scoring.scoreConfidence(state.loadState(cwd)).penalties.some((p) => /open loop/.test(p.reason));
  assert.ok(drained, 'an open loop drains');

  // park: named owner + a trigger that brings it back, and it STILL drains
  cli.run(['node', 'ratchet', 'state', 'append', 'openLoops', '{"text":"decide the v0.9 rot check"}']);
  const parkId = state.loadState(cwd).openLoops[1].id;
  assert.throws(() => cli.run(['node', 'ratchet', 'state', 'close', 'openLoops', parkId, '--park']), /owner/);
  assert.throws(
    () => cli.run(['node', 'ratchet', 'state', 'close', 'openLoops', parkId, '--park', '--owner', 'danny']),
    /revisit-trigger/
  );
  cli.run(['node', 'ratchet', 'state', 'close', 'openLoops', parkId, '--park', '--owner', 'danny', '--revisit-trigger', 'first rot report']);
  const parked = state.loadState(cwd).openLoops.find((l) => l.id === parkId);
  assert.strictEqual(parked.status, 'parked');
  assert.strictEqual(parked.owner, 'danny');
  assert.strictEqual(parked.revisitTrigger, 'first rot report');
  assert.ok(
    scoring.scoreConfidence(state.loadState(cwd)).penalties.some((p) => /2 open loop/.test(p.reason)),
    'a parked question is an unanswered question with an owner — it still drains'
  );

  cli.run(['node', 'ratchet', 'state', 'close', 'openLoops', loopId, '--evidence', 'chose one store; decision recorded']);
  const closedLoop = state.loadState(cwd).openLoops.find((l) => l.id === loopId);
  assert.strictEqual(closedLoop.status, 'closed');
  assert.ok(/chose one store/.test(closedLoop.evidence));
  assert.ok(
    scoring.scoreConfidence(state.loadState(cwd)).penalties.some((p) => /1 open loop/.test(p.reason)),
    'a closed loop stops draining'
  );
});

ok('assumptions end proven or dead, never just "done"', () => {
  state.initProject(cwd, { force: true });
  cli.run(['node', 'ratchet', 'state', 'append', 'assumptions', '{"text":"the seam is stable","killTest":"call it 100x"}']);
  const id = state.loadState(cwd).assumptions[0].id;
  assert.throws(() => cli.run(['node', 'ratchet', 'state', 'close', 'assumptions', id]), /tested\|killed/);
  assert.throws(
    () => cli.run(['node', 'ratchet', 'state', 'close', 'assumptions', id, '--outcome', 'tested']),
    /evidence/
  );
  cli.run(['node', 'ratchet', 'state', 'close', 'assumptions', id, '--outcome', 'killed', '--evidence', 'failed on call 12']);
  assert.strictEqual(state.loadState(cwd).assumptions[0].status, 'killed');
  // other collections are refused, and pointed at their own verb
  assert.throws(() => cli.run(['node', 'ratchet', 'state', 'close', 'defects', 'x', '--evidence', 'y']), /ratchet defect resolve/);
  assert.throws(() => cli.run(['node', 'ratchet', 'state', 'close', 'artifacts', 'x', '--evidence', 'y']), /ratchet artifact close/);
});

ok('the fog auto-close names its authority and its evidence', () => {
  state.initProject(cwd, { force: true });
  cli.run(['node', 'ratchet', 'score', 'aperture', '{"ambiguity":2,"terrain":2,"taste":2,"blastRadius":1,"reversibility":1}']);
  const map = artifacts.addArtifact(cwd, { kind: 'unknown-map', title: 'unknowns map: closure', holes: ['Q1 OPEN'] });
  const fog = state.loadState(cwd).openLoops.filter((l) => /^fog:/.test(l.text));
  assert.ok(fog.length >= 1);
  for (const l of fog) {
    assert.strictEqual(l.status, 'closed');
    assert.strictEqual(l.closedBy, map.id, 'the close names which map answered it');
    assert.ok(/unknown-map/.test(l.evidence), 'and states the evidence, not just the flag flip');
  }
});

ok('end to end through the real binaries: build → bound verify → close → compile', () => {
  // The in-process version below shares module state with the test. This one
  // spawns bin/ratchet and bin/ratchet-evolve as the user does, carrying
  // verifiedHash AND verifiedRev between two separate processes — the seam where
  // a JSON contract between the two CLIs would actually break.
  const { spawnSync } = require('child_process');
  const root = path.resolve(__dirname, '..');
  const proj = path.join(tmp, 'e2e-spawned');
  fs.rmSync(proj, { recursive: true, force: true });
  fs.mkdirSync(path.join(proj, 'src'), { recursive: true });
  fs.writeFileSync(path.join(proj, 'src', 'shipped.js'), 'module.exports = 1;\n', 'utf8');

  const env = {
    ...process.env,
    RATCHET_DATA_DIR: path.join(proj, '.data'),
    RATCHET_EVOLVE_LOG: path.join(proj, '.ratchet', 'evolve-log.jsonl'),
  };
  delete env.RATCHET_AGENT;
  const run = (bin, ...argv) => {
    const r = spawnSync(process.execPath, [path.join(root, 'bin', bin), ...argv], {
      cwd: proj, env, encoding: 'utf8',
    });
    return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
  };

  assert.strictEqual(run('ratchet', 'state', 'set', 'objective', 'ship it').code, 0);
  assert.strictEqual(
    run('ratchet', 'artifact', 'add', '{"id":"art-e2e","title":"shipped","kind":"code","path":"src/shipped.js"}').code, 0
  );

  // close is refused before proof exists
  const early = run('ratchet', 'artifact', 'close', 'art-e2e');
  assert.strictEqual(early.code, 1, early.out);
  assert.ok(/no proof → no close/.test(early.out), early.out);

  // bound verify, across the process boundary
  const v = run('ratchet-evolve', 'verify', 'src/shipped.js', '--artifact', 'art-e2e', '--test', 'node -e 0', '--json');
  assert.strictEqual(v.code, 0, v.out);
  const verified = JSON.parse(v.out);
  assert.strictEqual(verified.hashScope, 'file');
  assert.strictEqual(verified.verifiedRev, 1);

  const appended = run('ratchet-evolve', 'log', 'append', JSON.stringify({
    target: 'src/shipped.js', artifactId: 'art-e2e', verdict: 'KEEP', chosenMutation: 'ship it',
    verifiedHash: verified.verifiedHash, verifiedRev: verified.verifiedRev,
    verification: { commands: verified.commands, result: verified.result },
    seam: { evidenceType: 'test', testedSeam: 'node -e 0', shipSeam: 'node -e 0', seamMatch: 'exact', independentFromBuilderMethod: true },
  }));
  assert.strictEqual(appended.code, 0, appended.out);

  const closed = run('ratchet', 'artifact', 'close', 'art-e2e');
  assert.strictEqual(closed.code, 0, closed.out);
  assert.ok(/closed — rev 1/.test(closed.out), closed.out);
  // idempotent through the binary too
  assert.strictEqual(run('ratchet', 'artifact', 'close', 'art-e2e').code, 0);

  const compiled = run('ratchet', 'compile', 'done', '--json');
  assert.strictEqual(compiled.code, 0, compiled.out);
  const summary = JSON.parse(compiled.out);
  assert.strictEqual(summary.checkpointed, true);
  assert.strictEqual(summary.closed, true, `the workflow is CLOSED through the real CLI: ${compiled.out}`);
});

ok('end to end: build → bound verify → close → compile actually reaches CLOSED', () => {
  const proj = path.join(tmp, 'e2e-closed');
  fs.rmSync(proj, { recursive: true, force: true });
  fs.mkdirSync(path.join(proj, 'src'), { recursive: true });
  fs.writeFileSync(path.join(proj, 'src', 'shipped.js'), 'module.exports = 1;\n', 'utf8');
  state.initProject(proj, { force: true });

  inProject(proj, () => {
    cli.run(['node', 'ratchet', 'state', 'set', 'objective', 'ship the closure gate']);
    // BUILD
    cli.run(['node', 'ratchet', 'artifact', 'add', '{"title":"shipped","kind":"code","path":"src/shipped.js"}']);
    const art = state.loadState(proj).artifacts[0];
    const events = () => journal.readEvents(proj);
    assert.strictEqual(lifecycle.workflowClosed(state.loadState(proj), events(), proj).closed, false, 'a fresh build is not closed');
    assert.ok(/ratchet-evolve verify/.test(lifecycle.nextTransition(state.loadState(proj), events(), proj).command));

    // VERIFY, bound
    const v = evolveVerify.verify({ target: 'src/shipped.js', testCommand: 'node -e 0', mode: 'code', cwd: proj, artifact: art });
    journal.appendEvent(proj, {
      target: 'src/shipped.js', artifactId: art.id, verdict: 'KEEP',
      chosenMutation: 'ship it', verification: v,
      seam: { evidenceType: 'test', testedSeam: 'node -e 0', shipSeam: 'node -e 0', seamMatch: 'exact', independentFromBuilderMethod: true },
    }, { verifiedHash: v.verifiedHash, verifiedRev: v.verifiedRev });

    // the loop now names close, not compile
    assert.strictEqual(
      lifecycle.nextTransition(state.loadState(proj), events(), proj).command, `ratchet artifact close ${art.id}`
    );
    // and a checkpoint here does NOT make it closed
    cli.run(['node', 'ratchet', 'compile', 'done']);
    assert.strictEqual(lifecycle.workflowClosed(state.loadState(proj), events(), proj).closed, false,
      'checkpoint is not closure');

    // CLOSE
    cli.run(['node', 'ratchet', 'artifact', 'close', art.id]);
    const closure = lifecycle.workflowClosed(state.loadState(proj), events(), proj);
    assert.strictEqual(closure.closed, true, `expected CLOSED, blocked by: ${closure.blockers.map((b) => b.code).join(', ')}`);
    assert.deepStrictEqual(closure.blockers, []);

    // COMPILE — the last checkpoint after a real closure
    assert.strictEqual(lifecycle.nextTransition(state.loadState(proj), events(), proj).command, 'ratchet compile done');
    cli.run(['node', 'ratchet', 'compile', 'done']);
    assert.strictEqual(lifecycle.nextTransition(state.loadState(proj), events(), proj).command, 'nothing pending');
  });
});

// --- one derivation, four surfaces (0.8 Closure Gate) -----------------------

ok('all four surfaces read the SAME nextTransition, not four lookalike strings', () => {
  // No string-matching theatre: swap the derivation for a sentinel and demand
  // the sentinel itself appears everywhere. A surface that computed its own
  // answer would print its own answer instead.
  const proj = path.join(tmp, 'sentinel');
  fs.rmSync(proj, { recursive: true, force: true });
  fs.mkdirSync(proj, { recursive: true });
  state.initProject(proj, { force: true });

  const real = lifecycle.nextTransition;
  lifecycle.nextTransition = () => ({
    label: 'SENTINEL-LABEL-9f31', command: 'SENTINEL-COMMAND-9f31', reason: 'injected', scope: 'injected',
  });
  try {
    inProject(proj, () => {
      const r = receipt.assemble(proj);
      assert.strictEqual(r.next.transition.command, 'SENTINEL-COMMAND-9f31', 'receipt.assemble derives it');
      assert.ok(/SENTINEL-COMMAND-9f31/.test(md.receipt(r)), 'and renders it');
      assert.ok(/SENTINEL-COMMAND-9f31/.test(md.stateSummary(state.loadState(proj))), 'md.stateSummary derives it');

      const compiled = say(() => cli.run(['node', 'ratchet', 'compile', 'done']));
      assert.ok(/SENTINEL-COMMAND-9f31/.test(compiled), `compile done prints it — got: ${compiled}`);

      const errs = [];
      const origErr = process.stderr.write;
      process.stderr.write = (str) => { errs.push(String(str)); return true; };
      try {
        cli.run(['node', 'ratchet', 'touch', 'x.md']);
        cli.run(['node', 'ratchet', 'hook', 'stop-check']);
      } finally {
        process.stderr.write = origErr;
      }
      assert.ok(/SENTINEL-COMMAND-9f31/.test(errs.join('')), `stop-check prints it — got: ${errs.join('')}`);
    });
  } finally {
    lifecycle.nextTransition = real;
  }
});

ok('compile done says CHECKPOINTED, NOT CLOSED — and names what closing needs', () => {
  const proj = path.join(tmp, 'checkpoint-voice');
  fs.rmSync(proj, { recursive: true, force: true });
  fs.mkdirSync(proj, { recursive: true });
  state.initProject(proj, { force: true });
  inProject(proj, () => {
    const text = say(() => cli.run(['node', 'ratchet', 'compile', 'done']));
    assert.ok(/CHECKPOINTED, NOT CLOSED — state serialized/.test(text), text);
    assert.ok(/NEXT REQUIRED TRANSITION: .+ -> .+/.test(text), text);

    const json = JSON.parse(say(() => cli.run(['node', 'ratchet', 'compile', 'done', '--json'])));
    assert.strictEqual(json.checkpointed, true);
    assert.strictEqual(json.closed, false, 'a checkpoint on an unclosed workflow says so');
    for (const k of ['label', 'command', 'reason', 'scope']) assert.ok(json.next[k], `next.${k} present`);
  });
});

ok('stop-check refuses to imply closure when it cannot read the state', () => {
  const proj = path.join(tmp, 'stop-check-blind');
  fs.rmSync(proj, { recursive: true, force: true });
  fs.mkdirSync(proj, { recursive: true });
  state.initProject(proj, { force: true });
  const real = lifecycle.nextTransition;
  lifecycle.nextTransition = () => { throw new Error('unreadable'); };
  const errs = [];
  const origErr = process.stderr.write;
  process.stderr.write = (str) => { errs.push(String(str)); return true; };
  try {
    inProject(proj, () => {
      assert.doesNotThrow(() => cli.run(['node', 'ratchet', 'hook', 'stop-check']), 'a hook never breaks the session');
    });
  } finally {
    process.stderr.write = origErr;
    lifecycle.nextTransition = real;
  }
  assert.ok(/closure state unreadable — do not claim closed/.test(errs.join('')), errs.join(''));
});

ok('confidence renders a fourth layer: workflow closure and its blockers', () => {
  const proj = path.join(tmp, 'fourth-layer');
  fs.rmSync(proj, { recursive: true, force: true });
  fs.mkdirSync(proj, { recursive: true });
  state.initProject(proj, { force: true });
  inProject(proj, () => {
    const text = say(() => cli.run(['node', 'ratchet', 'score', 'confidence']));
    assert.ok(/Workflow closure/.test(text), text);
    assert.ok(/not closed|NOT CLOSED/i.test(text), 'an unclosed workflow says so, never omits it');
    assert.ok(/Scope:/.test(text.split('Workflow closure')[1] || ''), 'the fourth layer names its scope too');
  });
});

// --- the receipt binds its proof (0.8 Closure Gate) --------------------------

ok('receipt PROOF uses the ACTIVE artifact\'s bound event, and labels legacy evidence', () => {
  const { proj, art } = boundFixture('receipt-bound', { kind: 'code', file: 'src/thing.js' });
  inProject(proj, () => {
    // A KEEP that matches by path but is bound to nothing: display only.
    journal.appendEvent(proj, {
      target: 'src/thing.js', mode: 'code', verdict: 'KEEP', chosenMutation: 'legacy shaped',
      verification: { commands: [{ command: 'node -e 0', pass: true }], result: 'pass' },
      seam: { evidenceType: 'test', testedSeam: 'x', shipSeam: 'x', seamMatch: 'exact', independentFromBuilderMethod: true },
    });
    let r = receipt.assemble(proj);
    assert.ok(r.proof.keep, 'legacy evidence still renders');
    assert.strictEqual(r.proof.keep.binding, 'legacy-unbound');
    assert.strictEqual(r.proof.canAuthorizeClosure, false);
    assert.ok(/legacy unbound evidence — display only, cannot authorize closure/.test(md.receipt(r)), md.receipt(r));

    // now bind proof to the artifact itself
    const v = evolveVerify.verify({ target: 'src/thing.js', testCommand: 'node -e 0', mode: 'code', cwd: proj, artifact: art });
    journal.appendEvent(proj, keepFields(art, { chosenMutation: 'bound' }), { verifiedHash: v.verifiedHash, verifiedRev: v.verifiedRev });
    r = receipt.assemble(proj);
    assert.strictEqual(r.proof.keep.binding, 'bound');
    assert.strictEqual(r.proof.keep.mutation, 'bound', 'the bound event wins over the last global KEEP');
    assert.strictEqual(r.proof.canAuthorizeClosure, true);
    assert.strictEqual(r.proof.shipDecision, 'justified');
    assert.ok(!/legacy unbound evidence/.test(md.receipt(r)));
  });
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
  const bind = { artifactId: 'art-1', artifactRev: fp.rev, artifactHash: fp.hash, hashScope: fp.hashScope };
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
  // a proof gathered at a DIFFERENT scope does not authorize this one, even on an
  // identical hash — record-scope evidence is a claim about a record.
  assert.strictEqual(
    lifecycle.bindingEvent(artifact, [{ ...bind, hashScope: 'file', verdict: 'KEEP' }], fp), null,
    'the scope the proof was gathered at is part of the binding'
  );
});

ok('a file whose bytes equal the record preimage cannot inherit the record proof', () => {
  // The collision: record scope hashes `record:<kind>\n<title>\n<holes>`. A file
  // containing exactly those bytes hashes identically — so without a scope check
  // an old docs/manual KEEP would close a new .js file, skipping both the code
  // seam gate and the record-scope owner gate. rev never moves, because the path
  // resolving from "not a file" to "a file" is not a revision.
  const proj = path.join(tmp, 'scope-collision');
  fs.rmSync(proj, { recursive: true, force: true });
  fs.mkdirSync(proj, { recursive: true });
  const artifact = { id: 'art-collide', kind: 'docs', title: 'T', holes: [], rev: 1, path: 'anchor.md#frag' };

  const asRecord = lifecycle.fingerprint(proj, artifact);
  assert.strictEqual(asRecord.hashScope, 'record');
  const proof = [{ artifactId: 'art-collide', artifactRev: 1, artifactHash: asRecord.hash, hashScope: 'record', verdict: 'KEEP' }];
  assert.ok(lifecycle.bindingEvent(artifact, proof, asRecord), 'the record proof authorizes the record');

  // now the path becomes a real file whose bytes ARE the record preimage
  fs.writeFileSync(path.join(proj, 'anchor.md#frag'), 'record:docs\nT\n[]', 'utf8');
  const asFile = lifecycle.fingerprint(proj, artifact);
  assert.strictEqual(asFile.hashScope, 'file', 'the path now resolves to a file');
  assert.strictEqual(asFile.hash, asRecord.hash, 'the hashes collide — this is the whole point');
  assert.strictEqual(asFile.rev, asRecord.rev, 'and the revision never moved');
  assert.strictEqual(
    lifecycle.bindingEvent(artifact, proof, asFile), null,
    'record-scope proof must not authorize a file-scope identity on a colliding hash'
  );
});

ok('the fingerprint hashes bytes, not a lossy text decode', () => {
  const proj = path.join(tmp, 'fp-bytes');
  fs.rmSync(proj, { recursive: true, force: true });
  fs.mkdirSync(proj, { recursive: true });
  // Two files differing only in invalid-UTF8 bytes. Decoding to a string maps
  // both to U+FFFD, so a text hash calls two different files identical — and a
  // KEEP bound to one authorizes closing the other.
  fs.writeFileSync(path.join(proj, 'a.bin'), Buffer.from([0x80]));
  fs.writeFileSync(path.join(proj, 'b.bin'), Buffer.from([0x81]));
  const a = lifecycle.fingerprint(proj, { id: 'x', path: 'a.bin' });
  const b = lifecycle.fingerprint(proj, { id: 'x', path: 'b.bin' });
  assert.notStrictEqual(a.hash, b.hash, 'different bytes are a different identity');

  // and CRLF is byte-preserved and stable across reads, as it was before
  fs.writeFileSync(path.join(proj, 'crlf.txt'), Buffer.from('one\r\ntwo\r\n', 'utf8'));
  const c1 = lifecycle.fingerprint(proj, { id: 'x', path: 'crlf.txt' });
  const c2 = lifecycle.fingerprint(proj, { id: 'x', path: 'crlf.txt' });
  assert.strictEqual(c1.hash, c2.hash, 'a CRLF file hashes stably');
  // an ASCII file hashes the same under bytes as it did under utf8 — no existing
  // text binding is invalidated by the switch
  fs.writeFileSync(path.join(proj, 'ascii.txt'), 'plain\n', 'utf8');
  const ascii = lifecycle.fingerprint(proj, { id: 'x', path: 'ascii.txt' });
  assert.strictEqual(
    ascii.hash, require('crypto').createHash('sha256').update('plain\n').digest('hex'),
    'valid UTF-8 hashes identically either way'
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
  const bound = [{ artifactId: 'art-c', artifactRev: fp.rev, artifactHash: fp.hash, hashScope: fp.hashScope, verdict: 'KEEP' }];
  assert.deepStrictEqual(lifecycle.closureBlockers({ artifacts: [clean], defects: [] }, bound, clean, tmp), []);
  // holes alone block, and the waiver in the request clears exactly that one
  const holey = { ...clean, holes: ['TODO'] };
  const fpH = lifecycle.fingerprint(tmp, holey);
  const boundH = [{ artifactId: 'art-c', artifactRev: fpH.rev, artifactHash: fpH.hash, hashScope: fpH.hashScope, verdict: 'KEEP' }];
  assert.deepStrictEqual(
    lifecycle.closureBlockers({ artifacts: [holey], defects: [] }, boundH, holey, tmp).map((b) => b.code), ['holes']
  );
  assert.deepStrictEqual(
    lifecycle.closureBlockers({ artifacts: [holey], defects: [] }, boundH, holey, tmp,
      { waiveHoles: true, owner: 'danny', reason: 'shipping without it' }), []
  );
});

ok('workflowClosed will not close a workflow that still has live work', () => {
  // The false positive: close B, then build A. `activeArtifact` picked the most
  // recent record — which was still B — so the workflow read CLOSED while
  // nextTransition was simultaneously demanding A's verification. The two
  // surfaces contradicted each other, and the optimistic one is the dangerous one.
  const closedFp = lifecycle.fingerprint(tmp, { id: 'art-B', kind: 'spec', title: 'B', holes: [], rev: 1 });
  const B = {
    id: 'art-B', kind: 'spec', title: 'B', holes: [], rev: 1,
    status: 'closed', closedBy: 'evo_b', closedRev: closedFp.rev, closedHash: closedFp.hash,
  };
  const A = { id: 'art-A', kind: 'spec', title: 'A', holes: [], rev: 1, status: 'v0' };
  const events = [{ artifactId: 'art-B', artifactRev: closedFp.rev, artifactHash: closedFp.hash, hashScope: closedFp.hashScope, verdict: 'KEEP' }];

  // B closed first, A built after it — and also the reverse order, since "most
  // recent record" must not be what decides.
  for (const artifactsList of [[B, A], [A, B]]) {
    const r = lifecycle.workflowClosed({ artifacts: artifactsList, defects: [] }, events, tmp);
    assert.strictEqual(r.closed, false, `live work remains (order ${artifactsList.map((x) => x.id).join(',')})`);
    assert.strictEqual(r.artifact.id, 'art-A', 'the closure read names the artifact that is still live');
    assert.ok(r.blockers.some((b) => b.code === 'no-bound-proof'));
  }

  // and it agrees with nextTransition rather than contradicting it
  const t = lifecycle.nextTransition({ objective: 'o', artifacts: [B, A] }, events, tmp);
  assert.ok(/--artifact art-A/.test(t.command), `both surfaces name art-A, got: ${t.command}`);
});

ok('a defect attached to the certified artifact still blocks closure', () => {
  // Once nothing live remains, the certified artifact is the workflow — and an
  // open defect explicitly attached to it was being ignored, because the
  // certified branch stopped looking at defects entirely.
  const fp = lifecycle.fingerprint(tmp, { id: 'art-C', kind: 'spec', title: 'C', holes: [], rev: 1 });
  const C = {
    id: 'art-C', kind: 'spec', title: 'C', holes: [], rev: 1,
    status: 'closed', closedBy: 'evo_c', closedRev: fp.rev, closedHash: fp.hash,
  };
  const events = [{ artifactId: 'art-C', artifactRev: fp.rev, artifactHash: fp.hash, hashScope: fp.hashScope, verdict: 'KEEP' }];
  assert.strictEqual(lifecycle.workflowClosed({ artifacts: [C], defects: [] }, events, tmp).closed, true);

  const withDefect = lifecycle.workflowClosed(
    { artifacts: [C], defects: [{ id: 'd-on-closed', artifact: 'art-C', severity: 'high', status: 'open' }] }, events, tmp
  );
  assert.strictEqual(withDefect.closed, false, 'an open defect on the closed artifact is still open work');
  assert.ok(withDefect.blockers.some((b) => b.code === 'open-defects'), withDefect.blockers.map((b) => b.code).join(','));
});

ok('workflowClosed refuses to call it closed while an orphan defect is open', () => {
  const clean = { id: 'art-w', kind: 'spec', title: 't', holes: [], rev: 1, status: 'v1' };
  const fp = lifecycle.fingerprint(tmp, clean);
  const closed = { ...clean, status: 'closed', closedBy: 'evo_x', closedRev: fp.rev, closedHash: fp.hash };
  const events = [{ artifactId: 'art-w', artifactRev: fp.rev, artifactHash: fp.hash, hashScope: fp.hashScope, verdict: 'KEEP' }];
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
  const bound = [{ artifactId: 'art-n', artifactRev: fp.rev, artifactHash: fp.hash, hashScope: fp.hashScope, verdict: 'KEEP' }];
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

// --- migration: a real v0.7 store, untouched (0.8 Closure Gate) -------------

ok('a v0.7 store loads, scores, renders, and accepts every new verb without corruption', () => {
  // Mirrors the shapes the live dogfood store actually carries: free-text
  // statuses, a bare status:"closed", duplicate ids, an unattached open defect,
  // a fragment-bearing path, unbound events, and no rev fields anywhere.
  // Migration is additive and lazy: STATE_VERSION stays 1, no script runs.
  const proj = path.join(tmp, 'v07-store');
  fs.rmSync(proj, { recursive: true, force: true });
  fs.mkdirSync(path.join(proj, '.ratchet'), { recursive: true });
  state.initProject(proj, { force: true });

  const legacy = state.loadState(proj);
  delete legacy.rev;
  legacy.objective = 'finish the 0.7 run';
  legacy.nextAction = 'write the release memory';
  legacy.nextCommand = '/ratchet:compile';
  legacy.artifacts = [
    { id: 'art-dup', at: '2026-07-01T00:00:00.000Z', kind: 'docs', title: 'first', status: 'v1', holes: [] },
    { id: 'art-dup', at: '2026-07-01T00:00:01.000Z', kind: 'docs', title: 'second', status: 'v1', holes: [] },
    { id: 'art-bare-closed', at: '2026-07-02T00:00:00.000Z', kind: 'code', title: 'done thing', status: 'closed', holes: [] },
    { id: 'art-frag', at: '2026-07-03T00:00:00.000Z', kind: 'docs', title: 'release note', status: 'shipped v3', path: 'CHANGELOG.md#unreleased' },
  ];
  legacy.defects = [
    { id: 'def-orphan', at: '2026-07-02T00:00:00.000Z', severity: 'medium', summary: 'nobody attached me', status: 'open', artifact: '' },
  ];
  legacy.assumptions = [{ id: 'asm-1', text: 'the seam holds', status: 'untested' }];
  legacy.openLoops = [{ id: 'loop-1', text: 'decide the release name', status: 'open' }];
  state.writeJson(state.statePath(proj), legacy);

  const evolveLog = path.join(proj, 'evolve-log.jsonl');
  fs.writeFileSync(evolveLog, JSON.stringify({
    id: 'evo_2026_07_03_001', target: 'CHANGELOG.md', mode: 'docs', verdict: 'KEEP',
    verification: { commands: [], manualChecks: ['read end to end'], result: 'manual' },
    seam: { seamMatch: 'exact' },
  }) + '\n', 'utf8');

  inProject(proj, () => {
    const s = state.loadState(proj);
    assert.strictEqual(s.rev, undefined, 'load does not migrate the file');
    const events = journal.readEvents(proj);
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].artifactId, undefined, 'a v0.7 event has no binding and never gains one');

    // it SCORES
    const layers = scoring.scoreConfidenceLayers(s, state.loadLedger(proj), events);
    for (const l of ['artifact', 'session', 'ledger']) assert.ok(layers[l].scope, `${l} layer still scoped`);
    // it RENDERS — every surface, no throw
    assert.ok(/Ratchet state/.test(md.stateSummary(s)));
    const r = receipt.assemble(proj);
    assert.ok(/Ratchet receipt/.test(md.receipt(r)));
    assert.ok(/Confidence/.test(md.confidenceLayers(layers, lifecycle.workflowClosed(s, events, proj))));
    assert.doesNotThrow(() => md.fullExport(s, state.loadLedger(proj)));

    // the fragment path downgrades to record scope, with the reason stated
    const frag = lifecycle.fingerprint(proj, s.artifacts.find((a) => a.id === 'art-frag'));
    assert.strictEqual(frag.hashScope, 'record');
    assert.ok(/does not resolve to a file/.test(frag.downgradeReason));

    // the bare "closed" is UNCERTIFIED: it runs the full gate, not the no-op
    const bare = s.artifacts.find((a) => a.id === 'art-bare-closed');
    assert.strictEqual(lifecycle.isClosed(bare), false);
    assert.throws(() => cli.run(['node', 'ratchet', 'artifact', 'close', 'art-bare-closed']), /no KEEP proof bound/);

    // the duplicate id refuses every lifecycle verb, repair-ably
    assert.throws(() => cli.run(['node', 'ratchet', 'artifact', 'close', 'art-dup']), /share the id/);
    assert.throws(() => cli.run(['node', 'ratchet', 'retract', 'art-dup', '--reason', 'x']), /share the id/);

    // the unattached defect blocks WORKFLOW closure but not this artifact's close
    const closure = lifecycle.workflowClosed(s, events, proj);
    assert.strictEqual(closure.closed, false);
    assert.ok(closure.blockers.some((b) => b.code === 'unattached-defects'));
    const fragBlockers = lifecycle.closureBlockers(s, events, s.artifacts.find((a) => a.id === 'art-frag'), proj);
    assert.ok(!fragBlockers.some((b) => b.code === 'unattached-defects'), 'an orphan defect is not this artifact\'s blocker');

    // and a migrated artifact can actually be PROVEN and CLOSED — "accepts every
    // new verb" is only true if the whole closure path runs on a v0.7 record.
    fs.mkdirSync(path.join(proj, 'src'), { recursive: true });
    fs.writeFileSync(path.join(proj, 'src', 'migrated.js'), 'module.exports = 7;\n', 'utf8');
    cli.run(['node', 'ratchet', 'artifact', 'add', '{"id":"art-frag","path":"src/migrated.js"}']);
    const migrated = state.loadState(proj).artifacts.find((a) => a.id === 'art-frag');
    assert.strictEqual(migrated.rev, 2, 'a legacy record with no rev revises to 2');
    const mv = evolveVerify.verify({ target: 'src/migrated.js', testCommand: 'node -e 0', mode: 'auto', cwd: proj, artifact: migrated });
    assert.strictEqual(mv.hashScope, 'file', 'the fragment path was replaced by a real file');
    journal.appendEvent(proj, {
      target: 'src/migrated.js', artifactId: 'art-frag', verdict: 'KEEP', chosenMutation: 'proved a migrated record',
      verification: { commands: mv.commands, result: mv.result },
      seam: { evidenceType: 'test', testedSeam: 'node -e 0', shipSeam: 'node -e 0', seamMatch: 'exact', independentFromBuilderMethod: true },
    }, { verifiedHash: mv.verifiedHash, verifiedRev: mv.verifiedRev });
    cli.run(['node', 'ratchet', 'artifact', 'close', 'art-frag']);
    const nowClosed = state.loadState(proj).artifacts.find((a) => a.id === 'art-frag');
    assert.strictEqual(lifecycle.isClosed(nowClosed), true, 'a v0.7 record earns a real closure certificate');
    assert.strictEqual(nowClosed.closedRev, 2);

    // and every OTHER new verb works on the old store
    cli.run(['node', 'ratchet', 'state', 'close', 'openLoops', 'loop-1', '--evidence', 'named it Closure Gate']);
    cli.run(['node', 'ratchet', 'state', 'close', 'assumptions', 'asm-1', '--outcome', 'tested', '--evidence', 'held for 0.7']);
    cli.run(['node', 'ratchet', 'defect', 'resolve', 'def-orphan', '--evidence', 'attached and fixed']);
    say(() => cli.run(['node', 'ratchet', 'compile', 'done']));

    const after = state.loadState(proj);
    assert.strictEqual(after.openLoops[0].status, 'closed');
    assert.strictEqual(after.assumptions[0].status, 'tested');
    assert.strictEqual(after.defects[0].status, 'resolved');
    assert.strictEqual(after.artifacts.length, 4, 'no artifact was lost or duplicated');
    assert.ok(Number.isInteger(after.rev) && after.rev >= 1, 'rev started counting on the first write, lazily');
    assert.strictEqual(after.version, 1, 'STATE_VERSION did not move');
  });
});

fs.rmSync(tmp, { recursive: true, force: true });
process.stdout.write(`\n${passed} passed\n`);
