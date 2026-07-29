'use strict';

const scoring = require('./scoring');
const ledgerMod = require('./ledger');
const lifecycle = require('./lifecycle');

// The journal read lives here, not in lifecycle: lifecycle stays pure (events
// are always passed in) so it can be exercised without a filesystem.
function safeEvents(cwd) {
  try {
    return require('./evolve/journal').readEvents(cwd);
  } catch (_e) {
    return [];
  }
}

// All human/agent-facing rendering lives here so the CLI stays a thin router.
// Output is Markdown because it is injected straight into skill prompts.

function dash(v, fallback) {
  return v == null || v === '' ? fallback || '—' : v;
}

function bullets(items, fmt) {
  if (!items || !items.length) return '_none_';
  return items.map((x) => `- ${fmt(x)}`).join('\n');
}

function stateSummary(state, { events = null, cwd = process.cwd() } = {}) {
  const conf = scoring.scoreConfidence(state);
  const openDefects = (state.defects || []).filter(scoring.isDefectOpen);
  const openLoops = (state.openLoops || []).filter((l) => l.status !== 'closed');
  const untested = (state.assumptions || []).filter((a) => a.status !== 'tested' && a.status !== 'killed');
  const lastArtifact = (state.artifacts || [])[state.artifacts.length - 1];
  const lastDecision = (state.decisions || [])[state.decisions.length - 1];

  const stale = state.dirty && (!state.lastCompileAt || state.lastCompileAt < state.updatedAt);

  const lines = [];
  lines.push(`### Ratchet state`);
  lines.push(`- **Title:** ${dash(state.title)}`);
  lines.push(`- **Objective:** ${dash(state.objective)}`);
  lines.push(`- **Bottleneck:** ${dash(state.bottleneck)}`);
  lines.push(`- **Phase:** ${dash(state.phase, 'idle')}`);
  lines.push(`- **Confidence:** ${conf.score}/100 (${conf.band})${conf.loopClear ? ' — loop-clear' : ''}`);
  lines.push(
    `- **Open defects:** ${openDefects.length}` +
      (openDefects.length ? ` — ${openDefects.map((d) => `[${d.severity}] ${d.summary}`).slice(0, 5).join('; ')}` : '')
  );
  lines.push(`- **Untested assumptions:** ${untested.length}`);
  lines.push(`- **Open loops:** ${openLoops.length}`);
  lines.push(`- **Last artifact:** ${lastArtifact ? `${lastArtifact.title} (${lastArtifact.status})` : '—'}`);
  lines.push(`- **Last decision:** ${lastDecision ? lastDecision.choice : '—'}`);
  lines.push(`- **Next action:** ${dash(state.nextAction)}`);
  lines.push(`- **Next command:** ${dash(state.nextCommand)}`);
  // The recorded next command is what someone typed; the required transition is
  // what the record actually owes. Both are shown, because when they disagree
  // the disagreement IS the finding.
  const t = lifecycle.nextTransition(state, events || safeEvents(cwd), cwd);
  lines.push(`- **Next required transition:** ${t.label} → \`${t.command}\``);
  if (stale) lines.push(`- ⚠️ **Stale:** work changed since last compile — run \`/ratchet:compile\`.`);
  // The confidence figure above is scoped to recorded state, not code
  // correctness — say so, so the summary never reads as a ship-readiness claim.
  if (conf.scope) lines.push(`- _Confidence scope: ${conf.scope}._`);
  return lines.join('\n');
}

function friction(result) {
  const rows = result.obstacles
    .map(
      (o) =>
        `| ${o.rank} | ${o.name} | ${o.leverage} | ${o.certainty} | ${o.speed} | ${o.risk} | **${o.priority}** |`
    )
    .join('\n');
  const out = [];
  out.push(`### Friction auction`);
  out.push(`Priority = Leverage × Certainty × Time-to-unblock × Risk (each 1–10).`);
  out.push('');
  out.push(`| # | Obstacle | Lev | Cer | Spd | Risk | Priority |`);
  out.push(`| - | -------- | --- | --- | --- | ---- | -------- |`);
  out.push(rows);
  out.push('');
  if (result.winner) {
    out.push(`**Winning bottleneck:** ${result.winner.name} (priority ${result.winner.priority}).`);
    if (result.runnerUp) {
      out.push(`Beats runner-up "${result.runnerUp.name}" (${result.runnerUp.priority}) by ${result.margin}.`);
    }
  }
  if (result.scope) {
    out.push('');
    out.push(`_Scope: ${result.scope}._`);
  }
  return out.join('\n');
}

function confidence(state) {
  const c = scoring.scoreConfidence(state);
  const out = [];
  out.push(`### Confidence: ${c.score}/100 — ${c.band}${c.loopClear ? ' (loop-clear)' : ''}`);
  if (c.penalties.length) {
    out.push('');
    out.push('Draining pressure:');
    out.push(bullets(c.penalties, (p) => `${p.reason} (−${p.cost})`));
  } else {
    out.push('No unresolved pressure detected.');
  }
  out.push('');
  out.push(
    c.loopClear
      ? '**Loop may stop:** no critical/high debt, no untested assumption, next action defined.'
      : '**Loop must continue:** unresolved critical/high debt, untested assumptions, or missing next action.'
  );
  if (c.scope) {
    out.push('');
    out.push(`_Scope: ${c.scope}._`);
  }
  return out.join('\n');
}

// Three-layer confidence. Rendered as three independently-scoped scores so a
// verified artifact never reads as "blocked" because of unrelated ledger debt —
// the exact gaslighting a single blunt score used to produce.
function confidenceLayers(layers, closure) {
  const o = [];
  o.push('### Confidence — three scored layers + the closure read');
  o.push('');
  const render = (title, c) => {
    if (!c) return;
    const scoreStr = c.score == null ? '—' : `${c.score}/100`;
    o.push(`**${title}: ${scoreStr} (${c.band})**`);
    if (c.scope) o.push(`_Scope: ${c.scope}._`);
    const reasons = c.reasons || (c.penalties ? c.penalties.map((p) => `${p.reason} (−${p.cost})`) : []);
    for (const r of reasons || []) o.push(`- ${r}`);
    if (c.layer === 'session' && typeof c.loopClear === 'boolean') {
      o.push(`- loop ${c.loopClear ? 'may stop' : 'must continue'}`);
    }
    o.push('');
  };
  render('Artifact confidence', layers.artifact);
  render('Session confidence', layers.session);
  render('Ledger health', layers.ledger);
  // The fourth layer is not a score, and that is the point: closure is a yes/no
  // fact with named blockers, never a number that can read "high enough".
  o.push(`**Workflow closure: ${closure ? (closure.closed ? 'CLOSED' : 'NOT CLOSED') : '— not evaluated in this read'}**`);
  if (closure) {
    if (closure.scope) o.push(`_Scope: ${closure.scope}._`);
    if (closure.blockers && closure.blockers.length) {
      for (const b of closure.blockers) o.push(`- [${b.code}] ${b.message}`);
    } else {
      o.push('- no blockers recorded');
    }
  }
  o.push('');
  o.push('_The layers are independent: a verified patch stays high on artifact confidence even when ledger health is low._');
  o.push('_A high score is not a closure. Checkpoint is not closure; no proof → no close._');
  return o.join('\n');
}

// `○` = still draining confidence, `●` = terminal (resolved/waived/superseded).
// The aperture dial: how much of the loop this task earns, and the metered
// sequence of ratchet skills to run at that depth.
function aperture(a) {
  const d = a.dimensions || {};
  const o = [];
  o.push(`### Aperture: ${a.level} ${a.name} — score ${a.score}/10`);
  o.push(
    `Uncertainty: ambiguity ${d.ambiguity} · terrain ${d.terrain} · taste ${d.taste} · blast ${d.blastRadius} · reversibility ${d.reversibility}`
  );
  o.push(
    a.implement
      ? '**Implement:** yes — run the loop at this depth.'
      : '**Implement:** NO — lock constraints and produce options first; do not build yet.'
  );
  o.push(`**Metered loop:** ${a.sequence.map((s) => `\`/ratchet:${s}\``).join(' → ')}`);
  if (a.mapRequired) {
    o.push('**Pre-build map:** required — run `/ratchet:map` before `/ratchet:build`; map the fog first.');
  }
  if (a.scope) o.push(`_Scope: ${a.scope}._`);
  return o.join('\n');
}

function defectList(defects) {
  if (!defects || !defects.length) return '_no defects recorded_';
  const lines = ['### Defects'];
  for (const d of defects) {
    const open = scoring.isDefectOpen(d);
    lines.push(`- ${open ? '○' : '●'} \`${d.id}\` [${d.severity}] ${d.summary} — **${d.status}**`);
  }
  const draining = defects.filter(scoring.isDefectOpen).length;
  lines.push('');
  lines.push(`_${draining} draining · ${defects.length - draining} terminal · ${defects.length} total_`);
  return lines.join('\n');
}

function defectOne(d) {
  const lines = [];
  lines.push(`### Defect \`${d.id}\``);
  lines.push(`- **Severity:** ${d.severity}`);
  lines.push(`- **Status:** ${d.status}${scoring.isDefectOpen(d) ? ' (draining confidence)' : ' (terminal — not draining)'}`);
  lines.push(`- **Summary:** ${d.summary}`);
  if (d.evidence) lines.push(`- **Resolution evidence:** ${d.evidence}`);
  if (d.waivedBy) lines.push(`- **Waived by:** ${d.waivedBy}${d.waiveReason ? ` — ${d.waiveReason}` : ''}`);
  if (d.supersededBy) lines.push(`- **Superseded by:** ${d.supersededBy}`);
  if (Array.isArray(d.log) && d.log.length) {
    lines.push(`- **History:**`);
    for (const e of d.log) lines.push(`  - ${dash(e.at)}: ${dash(e.from)} → ${e.to}${e.note ? ` — ${e.note}` : ''}`);
  }
  return lines.join('\n');
}

function gitStatusRefs(refs) {
  if (!refs || !refs.isRepo) return '### Git status\n_not a git repository_';
  const o = [];
  o.push('### Git status (base-qualified)');
  o.push(`- **Branch:** ${dash(refs.branch)} @ ${dash(refs.head)} — ${refs.dirty ? 'dirty' : 'clean'}`);
  o.push(`- **Upstream:** ${refs.upstream || '— none set'}`);
  if (refs.comparisons && refs.comparisons.length) {
    for (const c of refs.comparisons) {
      o.push(`- **vs \`${c.base}\`:** ${c.ahead} ahead, ${c.behind} behind`);
    }
  } else {
    o.push('- _no comparison bases found (main/origin-main/upstream all absent)_');
  }
  o.push(`- **Unpushed (vs upstream):** ${refs.unpushed == null ? '— no upstream set' : refs.unpushed}`);
  o.push(`- **A remote branch contains HEAD:** ${refs.remoteContainsHead ? 'yes' : 'no'}`);
  o.push('');
  o.push('_Every count names its base ref — never "ahead of main" without saying which main._');
  return o.join('\n');
}

function repoSnapshot(snap) {
  const out = [];
  out.push(`### Repo snapshot — ${snap.root}`);
  out.push(`- **Files:** ${snap.fileCount}${snap.truncated ? '+ (truncated)' : ''}`);
  out.push(`- **Top-level dirs:** ${snap.dirs.length ? snap.dirs.join(', ') : '—'}`);
  out.push(`- **Signal files:** ${snap.signals.length ? snap.signals.join(', ') : '—'}`);
  out.push(
    `- **File types:** ${snap.topExts.length ? snap.topExts.map(([e, n]) => `${e}×${n}`).join(', ') : '—'}`
  );
  if (snap.git) {
    out.push(`- **Git:** ${dash(snap.git.branch)} — ${snap.git.dirty ? 'dirty' : 'clean'} — last: ${dash(snap.git.lastCommit)}`);
    if (snap.git.changedFiles && snap.git.changedFiles.length) {
      out.push(`- **Changed:** ${snap.git.changedFiles.join(', ')}`);
    }
  } else {
    out.push(`- **Git:** not a repository`);
  }
  return out.join('\n');
}

function fullExport(state, ledger) {
  const c = scoring.scoreConfidence(state);
  const out = [];
  out.push(`# Ratchet compile — ${dash(state.title, 'untitled session')}`);
  out.push('');
  out.push(`_Updated ${dash(state.updatedAt)} · confidence ${c.score}/100 (${c.band})_`);
  out.push('');
  out.push(`## Objective`);
  out.push(dash(state.objective, '_not locked — run /ratchet:lock_'));
  out.push('');
  out.push(`## Chosen bottleneck`);
  out.push(dash(state.bottleneck));
  out.push('');
  out.push(`## Decisions`);
  out.push(
    bullets(state.decisions, (d) => `**${d.choice}** — rejected: ${dash(d.rejected)} · tripwire: ${dash(d.tripwire)}`)
  );
  out.push('');
  out.push(`## Artifacts`);
  out.push(
    bullets(state.artifacts, (a) => `**${a.title}** (${a.kind}, ${a.status})${a.path ? ` → \`${a.path}\`` : ''}${a.holes && a.holes.length ? ` · holes: ${a.holes.join('; ')}` : ''}`)
  );
  out.push('');
  out.push(`## Defects / risks`);
  out.push(bullets(state.defects, (d) => `[${d.severity}] ${d.summary} — ${d.status}`));
  out.push('');
  out.push(`## Assumptions`);
  out.push(bullets(state.assumptions, (a) => `${a.text} — ${a.status}${a.killTest ? ` · kill-test: ${a.killTest}` : ''}`));
  out.push('');
  out.push(`## Open loops`);
  out.push(bullets(state.openLoops, (l) => `${l.text} — ${l.status}`));
  out.push('');
  out.push(`## Next`);
  out.push(`- **Action:** ${dash(state.nextAction)}`);
  out.push(`- **Command:** ${dash(state.nextCommand)}`);
  out.push(`- **Tags:** ${state.tags && state.tags.length ? state.tags.join(', ') : '—'}`);
  if (ledger) {
    const ls = ledgerMod.summary(ledger);
    out.push('');
    out.push(`## QA ledger`);
    out.push(`- Features: ${ls.features} · Tests: ${ls.tests} (${ls.failingTests} failing) · Defects: ${ls.defects} (${ls.openDefects} open)`);
  }
  return out.join('\n');
}

// The receipt — the ratchet cockpit. One stable shape, rendered the same way
// every time: eight fixed sections in a fixed order, each ALWAYS present.
// Emptiness is stated ("—"), never omitted — a section that sometimes disappears
// would force the reader to wonder whether it is empty or missing, which is the
// archaeology the receipt exists to end. SEAM lives inside PROOF (it is an
// evidence-quality fact); RISK and the authority ladder are first-class.
function receipt(r) {
  const em = (v) => (v == null || v === '' ? '—' : v);
  const conf = (c) => (c && c.score != null ? `${c.score}/100 (${c.band})` : c ? `— (${c.band})` : '—');
  const o = [];
  o.push('## Ratchet receipt');
  o.push(
    `_valid as of ${em(r.validAsOf)} · one read: target · delta · proof · verdict · risk · authority · state · next_`
  );
  o.push('');

  // 1 — TARGET: what we are steering toward.
  o.push('**TARGET**');
  if (r.target.locked) {
    o.push(`- Objective: ${em(r.target.objective)}`);
    o.push(`- Bottleneck: ${em(r.target.bottleneck)}`);
  } else {
    o.push('- — not locked (run `/ratchet:lock`)');
  }
  if (r.target.evolveTarget && (r.target.evolveTarget.target || r.target.evolveTarget.goal)) {
    o.push(`- Evolving: \`${em(r.target.evolveTarget.target)}\` — ${em(r.target.evolveTarget.goal)}`);
  }
  o.push('');

  // 2 — DELTA: what changed since the last serialization.
  o.push('**DELTA** _(changed since last compile)_');
  if (r.delta.touched.length) {
    o.push(`- Touched: ${r.delta.touched.map((f) => `\`${f}\``).join(', ')}`);
  } else {
    o.push('- — nothing touched since last compile');
  }
  if (r.delta.lastArtifact) {
    o.push(`- Last artifact: ${em(r.delta.lastArtifact.title)} (${em(r.delta.lastArtifact.kind)}, ${em(r.delta.lastArtifact.status)})`);
  }
  o.push(`- Uncompiled work: ${r.delta.stale ? 'yes — run `/ratchet:compile`' : 'no'}`);
  o.push('');

  // 3 — PROOF: evidence, not assertion — including whether the seam justifies a ship.
  o.push('**PROOF** _(evidence, not assertion)_');
  if (r.proof.keep) {
    const k = r.proof.keep;
    o.push(`- KEEP \`${em(k.id)}\`: ${em(k.mutation)}`);
    o.push(
      `  - evidence: ${em(k.evidenceType)} · result: ${em(k.result)}${k.independent === false ? ' · ⚠ not independent' : ''}`
    );
    if (k.commands && k.commands.length) {
      o.push(`  - commands: ${k.commands.map((c) => `\`${typeof c === 'string' ? c : c.command || 'unnamed'}\``).join(', ')}`);
    }
    if (k.manualChecks && k.manualChecks.length) o.push(`  - checks: ${k.manualChecks.join('; ')}`);
    if (k.binding === 'bound') {
      o.push(`  - bound to \`${em(k.artifactId)}\` rev ${em(k.artifactRev)} — this proof can authorize closing it`);
    } else {
      o.push('  - ⚠ legacy unbound evidence — display only, cannot authorize closure');
    }
  } else {
    o.push('- — no proven KEEP on record');
  }
  const seam = r.proof.seam || { present: false };
  if (seam.present) {
    o.push(`- Seam: tested \`${em(seam.testedSeam)}\` → ships \`${em(seam.shipSeam)}\``);
    o.push(
      `  - match: **${em(seam.seamMatch)}**${seam.independent === false ? ' · ⚠ not independent from builder method' : ''}${seam.proxyWarning ? ' · ⚠ proxy warning' : ''}`
    );
    if (seam.waiver && seam.waiver.by) o.push(`  - waived by ${em(seam.waiver.by)}: ${em(seam.waiver.reason)}`);
  } else {
    o.push('- Seam: — none declared (no evolve KEEP on a ship path yet)');
  }
  if (r.proof.shipDecision === 'cannot-justify') {
    o.push('- ⚠ **Cannot justify ship decision** — evidence is proxy-only (seam is not exact and not waived).');
  } else if (r.proof.shipDecision === 'justified') {
    o.push('- Ship decision: justified by the evidence above.');
  }
  if (r.proof.resolvedWithEvidence.length) {
    o.push(`- Defects cleared with proof: ${r.proof.resolvedWithEvidence.length}`);
  }
  o.push('');

  // 4 — VERDICT: the loop verdict + three independently-scoped confidences.
  o.push('**VERDICT**');
  o.push(`- Loop: ${em(r.verdict.loop)}`);
  o.push(`- Artifact confidence: ${conf(r.verdict.artifact)} — is this patch good?`);
  o.push(
    `- Session confidence: ${conf(r.verdict.session)} — ${r.verdict.session && r.verdict.session.loopClear ? 'loop may stop' : 'loop must continue'}`
  );
  o.push(`- Ledger health: ${conf(r.verdict.ledger)} — historical QA hygiene`);
  o.push('- _Each score is scoped; a verified artifact stays high even when ledger health is low._');
  o.push('');

  // 5 — RISK: what must not be trusted yet.
  o.push('**RISK** _(what must not be trusted yet)_');
  if (r.risk && r.risk.length) {
    for (const rk of r.risk.slice(0, 8)) o.push(`- ${em(rk.text)} _(${em(rk.from)})_`);
    if (r.risk.length > 8) o.push(`- … and ${r.risk.length - 8} more`);
  } else {
    o.push('- — none recorded');
  }
  o.push('');

  // 6 — AUTHORITY: how far this traveled + irreversible actions and their owners.
  o.push('**AUTHORITY** _(irreversible actions need a named owner)_');
  if (r.authority.authorityState) o.push(`- State: **${em(r.authority.authorityState.label)}**`);
  const anyAuth =
    r.authority.waivedDefects.length || r.authority.retractedArtifacts.length || r.authority.seamWaivers.length;
  if (anyAuth) {
    for (const w of r.authority.waivedDefects) o.push(`- waived defect \`${em(w.id)}\` by ${em(w.by)}: ${em(w.reason)}`);
    for (const a of r.authority.retractedArtifacts) {
      o.push(`- retracted \`${em(a.id)}\` (${em(a.title)}): ${em(a.reason)}${a.supersededBy ? ` → superseded by ${a.supersededBy}` : ''}`);
    }
    for (const sw of r.authority.seamWaivers) o.push(`- seam waiver \`${em(sw.id)}\` by ${em(sw.by)}: ${em(sw.reason)}`);
  } else {
    o.push('- No irreversible action taken; none pending.');
  }
  if (r.authority.enforced && r.authority.enforced.length) {
    o.push(`- _Gates in force: ${r.authority.enforced.map((e) => e.split(' — ')[0]).join(' · ')}._`);
  }
  o.push('');

  // 7 — STATE: what is true / safe / blocked right now.
  o.push('**STATE** _(true / safe / blocked)_');
  o.push(`- Phase: ${em(r.state.phase)}`);
  if (r.state.openDefects.length) {
    o.push(`- Open defects: ${r.state.openDefects.map((d) => `[${d.severity}] ${d.summary}`).slice(0, 5).join('; ')}`);
  } else {
    o.push('- Open defects: none');
  }
  o.push(`- Untested assumptions: ${r.state.untested} · open loops: ${r.state.openLoops}`);
  const fog = r.state.fog || { maps: [], fogLoops: 0, probes: { live: 0, disposed: 0 } };
  if (fog.maps.length || fog.fogLoops || fog.probes.live || fog.probes.disposed) {
    const mapBit = fog.maps.length
      ? `${fog.maps.length} unknown-map (${fog.maps.reduce((n, m) => n + m.openItems, 0)} OPEN item(s))`
      : 'no unknown-map';
    const probeBit = `probes: ${fog.probes.live} live / ${fog.probes.disposed} disposed`;
    const residue = fog.probes.live ? ' — ⚠ live probe code must be disposed or promoted before ship' : '';
    o.push(`- Fog: ${mapBit} · unmapped fog loops: ${fog.fogLoops} · ${probeBit}${residue}`);
  } else {
    o.push('- Fog: none recorded');
  }
  if (r.state.git) {
    const cmp = (r.state.git.comparisons || []).map((c) => `${c.base} +${c.ahead}/-${c.behind}`).join(', ') || '—';
    o.push(`- Git: ${em(r.state.git.branch)} @ ${em(r.state.git.head)} — ${r.state.git.dirty ? 'dirty' : 'clean'} · vs ${cmp}`);
  } else {
    o.push('- Git: not a repository');
  }
  const cp = r.controlPlane || { ok: true, configured: false, failures: 0, warnings: 0, checks: [] };
  const cpStatus = cp.failures ? 'FAIL' : cp.warnings ? 'WARN' : 'clean';
  const cpScope = cp.configured ? 'generic + configured surfaces' : 'generic checks only';
  o.push(`- Control-plane scan: ${cpStatus} (${cp.failures || 0} fail, ${cp.warnings || 0} warn · ${cpScope})`);
  const controlFindings = (cp.checks || []).filter((c) => c.level === 'fail' || c.level === 'warn').slice(0, 5);
  for (const c of controlFindings) {
    o.push(`  - ${String(c.level || 'warn').toUpperCase()} ${em(c.name)}${c.detail ? ` — ${c.detail}` : ''}`);
  }
  if ((cp.failures || 0) + (cp.warnings || 0) > controlFindings.length) {
    o.push(`  - … and ${(cp.failures || 0) + (cp.warnings || 0) - controlFindings.length} more control-plane finding(s)`);
  }
  o.push('');

  // 8 — NEXT: the single next move. The required transition is derived from the
  // record; the recorded action/command is what a human last typed. Both show,
  // because when they disagree the disagreement is the finding.
  o.push('**NEXT**');
  const closure = r.closure || { closed: false, blockers: [] };
  o.push(`- Workflow: ${closure.closed ? 'CLOSED' : 'NOT CLOSED'}`);
  if (!closure.closed) {
    const bl = (closure.blockers || []).slice(0, 3);
    for (const b of bl) o.push(`  - [${em(b.code)}] ${em(b.message)}`);
    if ((closure.blockers || []).length > bl.length) {
      o.push(`  - … and ${closure.blockers.length - bl.length} more blocker(s)`);
    }
  }
  const t = r.next.transition;
  if (t) o.push(`- Required transition: ${em(t.label)} → \`${em(t.command)}\``);
  if (r.next.action || r.next.command) {
    o.push(`- Action: ${em(r.next.action)}`);
    o.push(`- Command: ${em(r.next.command)}`);
  } else {
    o.push('- Recorded action/command: — none (a cold session has no first move)');
  }
  if (r.next.edge) o.push(`- Next edge: ${r.next.edge}`);

  if (r.gaps && r.gaps.length) {
    o.push('');
    o.push('**OPEN LOOPS**');
    for (const g of r.gaps) o.push(`- ${em(g.text)} — ${em(g.status)}`);
  }

  return o.join('\n');
}

module.exports = { stateSummary, friction, confidence, confidenceLayers, aperture, receipt, defectList, defectOne, gitStatusRefs, repoSnapshot, fullExport, dash, bullets };
