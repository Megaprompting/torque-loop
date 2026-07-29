'use strict';

// Zero-dependency torque-loop preflight — the mechanical half of /preflight.
// Run: node scripts/preflight.js [base-ref]   (or: npm run preflight)
// Exits non-zero only for MECHANICAL check failures; HYBRID/weak checks print
// evidence for a human to rule on. Lives outside package.json "files" so it never
// ships to plugin users.
// Traced by: claude-opus-4-8[1m] (fix + land) · codex gpt-5 (draft) · 2026-07-07

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

function findRoot(start) {
  let dir = start;
  while (dir && dir !== path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    dir = path.dirname(dir);
  }
  return process.cwd();
}

const root = findRoot(__dirname);
const base = process.argv[2] || 'main';

function run(cmd, args, options) {
  // npm on Windows is npm.cmd — spawnSync can't launch a .cmd without a shell
  // (EINVAL). Opt into shell only for callers that need it; git/node spawn direct.
  const r = spawnSync(cmd, args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
    shell: Boolean(options && options.shell),
    timeout: options && options.timeout
  });
  return {
    status: typeof r.status === 'number' ? r.status : 1,
    stdout: r.stdout || '',
    stderr: r.stderr || '',
    error: r.error ? String(r.error.message || r.error) : ''
  };
}

function git(args) {
  return run('git', args);
}

function gitText(args) {
  const r = git(args);
  return r.status === 0 ? r.stdout : '';
}

function gitLines(args) {
  return lines(gitText(args)).map(normalizePath);
}

function lines(text) {
  return String(text || '').split(/\r?\n/).filter(Boolean);
}

function normalizePath(p) {
  return String(p || '').replace(/\\/g, '/').replace(/^\.\//, '');
}

function uniq(items) {
  return Array.from(new Set(items.filter(Boolean)));
}

function readMaybe(rel) {
  try {
    return fs.readFileSync(path.join(root, rel), 'utf8');
  } catch (_) {
    return '';
  }
}

function readJsonMaybe(rel) {
  const text = readMaybe(rel);
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (_) {
    return null;
  }
}

function gitShowJson(ref, rel) {
  const r = git(['show', `${ref}:${rel}`]);
  if (r.status !== 0) return null;
  try {
    return JSON.parse(r.stdout);
  } catch (_) {
    return null;
  }
}

function exists(rel) {
  return fs.existsSync(path.join(root, rel));
}

function shorten(s, n) {
  s = String(s || '').replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 3) + '...' : s;
}

function formatList(items, max) {
  if (!items.length) return 'none';
  const shown = items.slice(0, max || 8);
  return shown.join(', ') + (items.length > shown.length ? `, +${items.length - shown.length} more` : '');
}

function result(n, name, type, status, summary, details, fix) {
  return { n, name, type, status, summary, details: details || [], fix };
}

function commandTail(r) {
  return lines([r.error, r.stdout, r.stderr].filter(Boolean).join('\n')).slice(-12).map((l) => shorten(l, 180));
}

function parseHunks(diffText) {
  const out = [];
  let file = null;
  let hunk = null;
  for (const line of String(diffText || '').split(/\r?\n/)) {
    let m = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
    if (m) {
      file = normalizePath(m[2]);
      hunk = null;
      continue;
    }
    m = /^\+\+\+ b\/(.+)$/.exec(line);
    if (m) {
      file = normalizePath(m[1]);
      continue;
    }
    if (line.startsWith('@@')) {
      hunk = { file, header: line, added: [], removed: [] };
      out.push(hunk);
      continue;
    }
    if (!hunk) continue;
    if (line.startsWith('+') && !line.startsWith('+++')) hunk.added.push(line.slice(1));
    if (line.startsWith('-') && !line.startsWith('---')) hunk.removed.push(line.slice(1));
  }
  return out;
}

function pathsFromNameStatus(text) {
  const out = [];
  for (const line of lines(text)) {
    const parts = line.split(/\t+/);
    if (!parts.length) continue;
    const status = parts[0];
    if (/^[RC]/.test(status) && parts[2]) out.push(normalizePath(parts[2]));
    else if (parts[1]) out.push(normalizePath(parts[1]));
  }
  return out;
}

function pathsFromStatus(text) {
  return lines(text).map((line) => {
    let p = line.slice(3);
    if (p.includes(' -> ')) p = p.split(' -> ').pop();
    return normalizePath(p.replace(/^"|"$/g, ''));
  });
}

// A base ref that doesn't resolve turns every base-relative git call into a
// swallowed error that masquerades as a check FAILURE (misleading "cannot parse
// package.json", leaked git errors — defect def-mrb00eo201). Validate once and fail
// fast with exit 2 (distinct from 1 = a check failed) instead of pretending the
// content is broken when it is the ref that is missing.
if (git(['rev-parse', '--verify', '--quiet', `${base}^{commit}`]).status !== 0) {
  process.stderr.write(`preflight: base ref '${base}' does not resolve — fetch it or pass a valid ref (e.g. origin/main).\n`);
  process.exit(2);
}

const committedDiff = gitText(['diff', '--no-ext-diff', '--unified=0', `${base}...HEAD`]);
const cachedDiff = gitText(['diff', '--cached', '--no-ext-diff', '--unified=0']);
const worktreeDiff = gitText(['diff', '--no-ext-diff', '--unified=0']);
const combinedDiff = [committedDiff, cachedDiff, worktreeDiff].filter(Boolean).join('\n');
const hunks = parseHunks(combinedDiff);

const nameStatusText = [
  gitText(['diff', '--name-status', '-M', `${base}...HEAD`]),
  gitText(['diff', '--cached', '--name-status', '-M']),
  gitText(['diff', '--name-status', '-M'])
].filter(Boolean).join('\n');

const statusText = gitText(['status', '--porcelain', '--untracked-files=all']);
const changedPaths = uniq(pathsFromNameStatus(nameStatusText).concat(pathsFromStatus(statusText)));
const shortStat = gitText(['diff', '--shortstat', `${base}...HEAD`]).trim() || '0 committed file changes';

function checkGreenWorld() {
  const test = run('npm', ['test'], { timeout: 120000, shell: true });
  const doctor = run('node', ['bin/ratchet', 'doctor'], { timeout: 60000 });
  const pass = test.status === 0 && doctor.status === 0;
  const counts = (test.stdout + '\n' + test.stderr).match(/\d+\s+passed/g) || [];
  return result(
    1,
    'green world',
    'MECHANICAL',
    pass ? 'PASS' : 'FAIL',
    pass ? `test counts ${formatList(counts, 6)}; doctor exit 0` : `npm test exit ${test.status}; doctor exit ${doctor.status}`,
    pass ? [] : commandTail(test).concat(commandTail(doctor)),
    'make npm test and node bin/ratchet doctor pass'
  );
}

function versionFieldsFromCurrent() {
  const pkg = readJsonMaybe('package.json') || {};
  const claudePlugin = readJsonMaybe('.claude-plugin/plugin.json') || {};
  const claudeMarket = readJsonMaybe('.claude-plugin/marketplace.json') || {};
  const codexPlugin = readJsonMaybe('.codex-plugin/plugin.json') || {};
  return [
    ['package.json', pkg.version],
    ['.claude-plugin/plugin.json', claudePlugin.version],
    ['.claude-plugin/marketplace.json metadata.version', claudeMarket.metadata && claudeMarket.metadata.version],
    ['.claude-plugin/marketplace.json plugins[0].version', claudeMarket.plugins && claudeMarket.plugins[0] && claudeMarket.plugins[0].version],
    ['.codex-plugin/plugin.json', codexPlugin.version]
  ];
}

function versionFieldsAtBase() {
  const pkg = gitShowJson(base, 'package.json') || {};
  const claudePlugin = gitShowJson(base, '.claude-plugin/plugin.json') || {};
  const claudeMarket = gitShowJson(base, '.claude-plugin/marketplace.json') || {};
  const codexPlugin = gitShowJson(base, '.codex-plugin/plugin.json') || {};
  return [
    ['package.json', pkg.version],
    ['.claude-plugin/plugin.json', claudePlugin.version],
    ['.claude-plugin/marketplace.json metadata.version', claudeMarket.metadata && claudeMarket.metadata.version],
    ['.claude-plugin/marketplace.json plugins[0].version', claudeMarket.plugins && claudeMarket.plugins[0] && claudeMarket.plugins[0].version],
    ['.codex-plugin/plugin.json', codexPlugin.version]
  ];
}

function checkVersionAlignment() {
  const fields = versionFieldsFromCurrent();
  const target = fields[0][1];
  const stale = fields.filter((f) => !f[1] || f[1] !== target).map((f) => `${f[0]}=${f[1] || '<missing>'}`);

  const readme = readMaybe('README.md');
  const hits = readme.match(/->\s*ratchet\s+\d+\.\d+\.\d+/g) || [];
  const readmeBad = hits.filter((hit) => {
    const m = /(\d+\.\d+\.\d+)/.exec(hit);
    return !m || m[1] !== target;
  });
  if (!hits.length) stale.push('README has no -> ratchet X.Y.Z example');
  for (const hit of readmeBad) stale.push(`README example ${hit.trim()}`);

  const baseFields = versionFieldsAtBase();
  const changed = fields.filter((f, i) => f[1] !== baseFields[i][1]).map((f) => f[0]);

  return result(
    4,
    'version alignment',
    'MECHANICAL',
    stale.length ? 'FAIL' : 'PASS',
    stale.length ? formatList(stale, 8) : `all ${target}; changed fields ${formatList(changed, 5)}`,
    [],
    'align package, plugin manifests, marketplace metadata, and README version examples'
  );
}

function unreleasedSection() {
  const text = readMaybe('CHANGELOG.md');
  const m = /^##\s*\[?Unreleased\]?[\s\S]*?(?=^##\s+)/mi.exec(text);
  return m ? m[0] : text;
}

function approvalLines(section) {
  return lines(section).filter((line) =>
    /Danny/i.test(line) &&
    /["“][^"”]*(yes|approved|approve|ok|okay)[^"”]*["”]/i.test(line)
  );
}

function checkDependencyGate() {
  const cur = readJsonMaybe('package.json');
  const old = gitShowJson(base, 'package.json');
  if (!cur || !old) {
    return result(7, 'dependency gate', 'MECHANICAL', 'FAIL', 'cannot parse current or base package.json', [], 'restore readable package.json at current and base ref');
  }

  const added = [];
  for (const section of ['dependencies', 'devDependencies']) {
    const curDeps = cur[section] || {};
    const oldDeps = old[section] || {};
    for (const name of Object.keys(curDeps)) {
      if (!Object.prototype.hasOwnProperty.call(oldDeps, name)) added.push(`${section}.${name}`);
    }
  }

  const depNames = added.map((x) => x.split('.').slice(1).join('.'));
  const approvals = approvalLines(unreleasedSection());
  const approval = added.length > 0 && approvals.some((line) =>
    (/dependenc/i.test(line) || depNames.every((name) => line.includes(name)))
  );

  return result(
    7,
    'dependency gate',
    'MECHANICAL',
    added.length === 0 || approval ? 'PASS' : 'FAIL',
    added.length === 0 ? 'no new dependencies/devDependencies' : `${formatList(added, 8)}; Danny quote ${approval ? 'found' : 'missing'}`,
    approvals.map((l) => `approval candidate: ${shorten(l, 180)}`),
    'remove the new dependency or add an explicit Danny approval quote in [Unreleased]'
  );
}

function isPrivatePath(p) {
  p = normalizePath(p);
  const baseName = path.posix.basename(p);
  return p.startsWith('reference/PROBLEM-STATEMENT-') ||
    p.startsWith('reference/private/') ||
    p.endsWith('.private.md') ||
    p === '.lucid' || p.startsWith('.lucid/') ||
    p === '.ratchet' || p.startsWith('.ratchet/') ||
    baseName.startsWith('.sandbox-') || p.startsWith('.sandbox-');
}

function walk(rel, out) {
  const abs = path.join(root, rel);
  if (!fs.existsSync(abs)) return;
  const st = fs.statSync(abs);
  if (st.isFile()) {
    out.push(normalizePath(rel));
    return;
  }
  if (!st.isDirectory()) return;
  for (const ent of fs.readdirSync(abs, { withFileTypes: true })) {
    if (ent.name === '.git' || ent.name === 'node_modules') continue;
    walk(path.join(rel, ent.name), out);
  }
}

function readSmallText(rel) {
  try {
    const abs = path.join(root, rel);
    const st = fs.statSync(abs);
    if (!st.isFile() || st.size > 1024 * 1024) return '';
    const buf = fs.readFileSync(abs);
    if (buf.includes(0)) return '';
    return buf.toString('utf8');
  } catch (_) {
    return '';
  }
}

function privateSourceFiles() {
  const all = [];
  walk('.', all);
  return uniq(all.concat(gitLines(['ls-files']), changedPaths)).filter(isPrivatePath);
}

function normalizedLeakLine(s) {
  return String(s || '').trim().replace(/\s+/g, ' ');
}

function privateLineLeaks() {
  const owners = new Map();
  for (const file of privateSourceFiles()) {
    const text = readSmallText(file);
    for (const line of lines(text)) {
      const normalized = normalizedLeakLine(line);
      if (normalized.length >= 40) owners.set(normalized, file);
    }
  }

  const hits = [];
  for (const h of hunks) {
    if (!h.file || isPrivatePath(h.file)) continue;
    for (const added of h.added) {
      const normalized = normalizedLeakLine(added);
      if (owners.has(normalized)) hits.push(`${h.file} quotes ${owners.get(normalized)}: ${shorten(normalized, 120)}`);
    }
  }
  return hits;
}

function checkLeakScan() {
  const pathHits = changedPaths.filter(isPrivatePath);
  const quoteHits = privateLineLeaks();
  const failures = pathHits.map((p) => `private path ${p}`).concat(quoteHits);

  return result(
    9,
    'leak scan',
    'MECHANICAL',
    failures.length ? 'FAIL' : 'PASS',
    failures.length ? formatList(failures, 6) : 'no private paths or exact private-line quotes',
    failures.slice(0, 12),
    'remove private paths and exact private-doc quotes from public diff'
  );
}

function isDurableDoc(p) {
  // Authored durable docs carry a model tag (convention 12). templates/ is
  // file-shape scaffolding, not authored prose — exempt (Danny, 2026-07-07).
  return p === 'CLAUDE.md' ||
    p.startsWith('reference/') ||
    p.startsWith('handoffs/') ||
    p.startsWith('handoff/');
}

function commitsSinceBase() {
  const r = git(['log', '--format=%H%n%B%n---TORQUE-LOOP-COMMIT---', `${base}..HEAD`]);
  if (r.status !== 0) return { error: r.stderr || r.error || 'git log failed', commits: [] };
  return {
    error: '',
    commits: r.stdout.split('---TORQUE-LOOP-COMMIT---').map((b) => b.trim()).filter(Boolean).map((block) => {
      const ls = lines(block);
      return { hash: ls[0], body: ls.slice(1).join('\n') };
    })
  };
}

function checkTraceTags() {
  const durable = changedPaths.filter(isDurableDoc).filter(exists);
  const missingTags = durable.filter((p) => !/Traced by:\s*[^\r\n<]+/i.test(readMaybe(p)));

  const commitInfo = commitsSinceBase();
  const missingFooters = commitInfo.commits
    .filter((c) => !/^Co-authored-by:\s*.+<[^>]+>/mi.test(c.body))
    .map((c) => c.hash.slice(0, 12));

  const failures = missingTags.map((p) => `missing trace tag ${p}`)
    .concat(missingFooters.map((h) => `missing co-author footer ${h}`));
  if (commitInfo.error) failures.push(`git log failed: ${shorten(commitInfo.error, 120)}`);

  return result(
    10,
    'trace tags',
    'MECHANICAL',
    failures.length ? 'FAIL' : 'PASS',
    failures.length ? formatList(failures, 8) : `${durable.length} durable docs; ${commitInfo.commits.length} commits checked`,
    failures,
    'add Traced by tags to durable docs and Co-authored-by footers to commits'
  );
}

const testFiles = [];
walk('test', testFiles);
const testText = new Map(testFiles.map((f) => [f, readMaybe(f)]));

function extractTokens(linesIn) {
  const skip = new Set(['const', 'let', 'var', 'function', 'return', 'require', 'module', 'exports', 'string', 'number', 'object', 'true', 'false', 'null', 'undefined']);
  const out = new Set();
  for (const line of linesIn) {
    for (const m of line.match(/--[a-z0-9][a-z0-9-]*/gi) || []) out.add(m);
    for (const m of line.match(/\/ratchet:[a-z0-9-]+/gi) || []) out.add(m);
    for (const m of line.match(/\b[A-Za-z_][A-Za-z0-9_]{3,}\b/g) || []) {
      if (!skip.has(m)) out.add(m);
    }
  }
  return Array.from(out).slice(0, 12);
}

function findTestMatches(tokens) {
  const hits = [];
  for (const token of tokens) {
    const files = [];
    for (const [file, text] of testText.entries()) {
      if (text.includes(token)) files.push(file);
    }
    if (files.length) hits.push(`${token} -> ${formatList(files, 3)}`);
  }
  return hits.slice(0, 6);
}

function checkTestlessBehaviorEvidence() {
  const behaviorHunks = hunks.filter((h) => h.file && (h.file.startsWith('src/') || h.file.startsWith('bin/')));
  let withHits = 0;
  const details = behaviorHunks.slice(0, 12).map((h) => {
    const tokens = extractTokens(h.added.concat(h.removed));
    const matches = findTestMatches(tokens);
    if (matches.length) withHits++;
    return `${h.file} ${h.header}: tokens ${formatList(tokens, 6)}; test hits ${formatList(matches, 4)}`;
  });

  return result(
    2,
    'testless change',
    'HYBRID',
    'HUMAN',
    `${behaviorHunks.length} src/bin hunks; ${withHits} have token hits. HUMAN: name the falsifier per hunk.`,
    details
  );
}

function checkWeakenedFalsifierEvidence() {
  const assertRe = /\b(assert|strictEqual|deepStrictEqual|throws|doesNotThrow|rejects|match|ok|fail)\b/;
  const looseRe = /(\.\*|\[\\s\\S\]\*|\bincludes\s*\(|>=|<=|\|\||optional|maybe)/i;
  const candidates = [];
  for (const h of hunks.filter((x) => x.file && x.file.startsWith('test/'))) {
    const removed = h.removed.filter((l) => assertRe.test(l));
    const added = h.added.filter((l) => looseRe.test(l));
    if (removed.length || added.length) {
      candidates.push(`${h.file} ${h.header}: removed ${removed.length} assertion-ish; added ${added.length} loose-ish`);
    }
  }
  const just = lines(gitText(['log', '--format=%B', `${base}..HEAD`]))
    .filter((l) => /(weaken|loosen|falsifier|assert)/i.test(l));

  return result(
    3,
    'weakened falsifier',
    'HYBRID',
    'HUMAN',
    `${candidates.length} candidates; ${just.length} commit-body justification lines. HUMAN: decide whether any assertion was weakened.`,
    candidates.slice(0, 12).concat(just.slice(0, 6).map((l) => `justification candidate: ${shorten(l, 160)}`))
  );
}

function checkProseEnforcementEvidence() {
  const normRe = /\b(must|never|requires|required|shall)\b/i;
  const candidates = [];
  for (const h of hunks.filter((x) => x.file === 'README.md' || /(^|\/)SKILL\.md$/.test(x.file || ''))) {
    for (const added of h.added) {
      if (normRe.test(added)) candidates.push(`${h.file}: ${shorten(added, 160)}`);
    }
  }
  const cliTouched = changedPaths.some((p) => p.startsWith('bin/') || p.startsWith('src/'));
  const testTouched = changedPaths.some((p) => p.startsWith('test/'));
  const labels = /(CLI[- ]enforced|prompt[- ]level)/i.test(unreleasedSection());

  return result(
    5,
    'prose enforcement',
    'HYBRID',
    'HUMAN',
    `${candidates.length} normative additions; cli/src touched ${cliTouched}; tests touched ${testTouched}; changelog label ${labels}. HUMAN: map each claim to enforcement or prompt-level label.`,
    candidates.slice(0, 12)
  );
}

function diffNameOnly(ignoreWhitespace) {
  const opt = ignoreWhitespace ? ['-w'] : [];
  return uniq(
    gitLines(['diff'].concat(opt, ['--name-only', `${base}...HEAD`]))
      .concat(gitLines(['diff', '--cached'].concat(opt, ['--name-only'])))
      .concat(gitLines(['diff'].concat(opt, ['--name-only'])))
  );
}

function checkDiffMinimalityEvidence() {
  const all = diffNameOnly(false);
  const semantic = new Set(diffNameOnly(true));
  const whitespaceOnly = all.filter((p) => !semantic.has(p));
  const renames = lines(nameStatusText).filter((l) => /^R\d+/.test(l));

  return result(
    6,
    'diff minimality',
    'HYBRID',
    'HUMAN',
    `${hunks.length} hunks; ${renames.length} renames; ${whitespaceOnly.length} whitespace-only files. HUMAN: map every hunk to the locked target.`,
    renames.slice(0, 8).concat(whitespaceOnly.slice(0, 8).map((p) => `whitespace-only candidate: ${p}`))
  );
}

function collectParked(value, out) {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) collectParked(item, out);
    return;
  }
  const stateText = Object.keys(value).map((k) => `${k}:${String(value[k])}`).join(' ');
  if (/\bparked\b/i.test(stateText)) {
    const id = value.id || value.loopId || value.loop_id || value.key || value.name;
    if (id) out.add(String(id));
  }
  for (const v of Object.values(value)) collectParked(v, out);
}

function checkParkedDecisionEvidence() {
  const r = run('node', ['bin/ratchet', 'status', '--json'], { timeout: 60000 });
  const parked = new Set();
  if (r.status === 0) {
    try {
      collectParked(JSON.parse(r.stdout), parked);
    } catch (_) {}
  }
  const ids = Array.from(parked);
  const mentions = ids.filter((id) => combinedDiff.includes(id));

  return result(
    8,
    'parked-decision creep',
    'HYBRID',
    'HUMAN',
    r.status === 0
      ? `${ids.length} parked ids; ${mentions.length} mentioned in diff. HUMAN: decide if a parked loop was implemented.`
      : `ratchet status --json failed. HUMAN: inspect open/parked loops manually.`,
    mentions.map((id) => `diff mentions parked id ${id}`).concat(r.status === 0 ? [] : commandTail(r))
  );
}

function checkScopeEmptinessEvidence() {
  const codeHunks = hunks.filter((h) => h.file && (h.file.startsWith('src/') || h.file.startsWith('bin/')));
  const scoreRead = [];
  const rendered = [];
  let scopeMentions = 0;
  let emptyMentions = 0;

  for (const h of codeHunks) {
    for (const added of h.added) {
      if (/\bscope\s*:/.test(added)) scopeMentions++;
      if (/\b(score|read)\b/i.test(added)) scoreRead.push(`${h.file}: ${shorten(added, 140)}`);
      if (/\b(render|section|heading|append|push|write)\b/i.test(added)) rendered.push(`${h.file}: ${shorten(added, 140)}`);
      if (/\b(empty|none|nothing|no\s+[a-z])/i.test(added)) emptyMentions++;
    }
  }

  return result(
    11,
    'scope + emptiness',
    'HYBRID',
    'HUMAN',
    `${scoreRead.length} score/read candidates; ${scopeMentions} scope mentions; ${rendered.length} render candidates; ${emptyMentions} emptiness mentions. HUMAN: verify required fields/rendering.`,
    scoreRead.slice(0, 6).concat(rendered.slice(0, 6))
  );
}

function isBehaviorPath(p) {
  return p.startsWith('src/') ||
    p.startsWith('bin/') ||
    p.startsWith('skills/') ||
    p.startsWith('hooks/') ||
    p.startsWith('templates/') ||
    p === 'README.md' ||
    p === 'package.json';
}

function checkChangelogEvidence() {
  const behaviorPaths = changedPaths.filter(isBehaviorPath);
  const changelogTouched = changedPaths.includes('CHANGELOG.md');
  const labels = /(CLI[- ]enforced|prompt[- ]level)/i.test(unreleasedSection());

  return result(
    12,
    'changelog',
    'HYBRID',
    'HUMAN',
    `${behaviorPaths.length} behavior-path candidates; CHANGELOG touched ${changelogTouched}; label present ${labels}. HUMAN: decide behavior change and label adequacy.`,
    behaviorPaths.slice(0, 12)
  );
}

const checks = [
  checkGreenWorld(),
  checkTestlessBehaviorEvidence(),
  checkWeakenedFalsifierEvidence(),
  checkVersionAlignment(),
  checkProseEnforcementEvidence(),
  checkDiffMinimalityEvidence(),
  checkDependencyGate(),
  checkParkedDecisionEvidence(),
  checkLeakScan(),
  checkTraceTags(),
  checkScopeEmptinessEvidence(),
  checkChangelogEvidence()
];

process.stdout.write(`PREFLIGHT vs ${base} - ${changedPaths.length} paths, ${shortStat}; ${lines(statusText).length} worktree status entries\n`);
for (const c of checks) {
  const left = `${String(c.n).padStart(2, ' ')} ${c.name}`.padEnd(31, '.');
  process.stdout.write(`${left} ${c.status} ${c.summary}\n`);
  for (const d of c.details.slice(0, 16)) process.stdout.write(`    ${d}\n`);
}

const failures = checks.filter((c) => c.type === 'MECHANICAL' && c.status === 'FAIL');
process.stdout.write(`VERDICT: ${failures.length ? `BLOCKED - ${failures.length} mechanical failures` : 'CLEAR ON MECHANICAL CHECKS - resolve HUMAN lines before PR'}\n`);
process.stdout.write('SMALLEST PATCHES:\n');
if (!failures.length) {
  process.stdout.write('  none from mechanical checks\n');
} else {
  for (const f of failures) process.stdout.write(`  ${f.n}. ${f.fix}\n`);
}

process.exitCode = failures.length ? 1 : 0;
