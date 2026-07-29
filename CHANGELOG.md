# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased] — Closure Gate

0.7 gated the fog. It left the loop able to *stop* but not to *finish*: `compile done`
serialized the record and every surface treated that as an ending, so a session could
checkpoint forever and call it done. **Checkpoint is not closure — no proof → no close.**
An artifact closes only when a KEEP is bound to that exact revision, and revising it
invalidates the proof.

Every entry names whether it is CLI-enforced or prompt-level, and the falsifier that was
run red against v0.7 before it landed.

### Added

- **`src/lifecycle.js` — one pure derivation of what "closed" means** (CLI-enforced).
  `fingerprint` (rev + content hash + `hashScope`), `bindingEvent`, `closureBlockers`,
  `isClosed`, `workflowClosed`, `nextTransition`. Pure by construction: it never requires
  the journal (events are always passed in) and never writes, so four surfaces cannot
  drift into four different answers. *Falsifier: the module's seven contract cases; against
  v0.7 the suite dies at `Cannot find module '../src/lifecycle'`.*
- **`ratchet artifact close <id> [--waive-holes --owner --reason]`** (CLI-enforced) —
  under the existing `artifact` group, behind `assertMayWrite`. Refuses with ALL blockers
  in one fixed order (`terminal · probe · no-bound-proof · open-defects · holes`); on
  success stamps `status:'closed'`, `closedAt`, `closedBy` (the bound event id),
  `closedRev`, `closedHash`, optional `holesWaiver`, and records `artifact.closed`. A
  second close of a certified artifact is a **no-op, not an error** — re-running a
  serialize block must be free. A record-scope close additionally requires `--owner` and
  `--reason`: it certifies a claim about a record, not about shipped bytes. *Falsifier:
  proven red by disabling the verb — `usage: ratchet artifact add <json> | ratchet artifact
  close <id>`.*
- **`ratchet state close openLoops|assumptions <id>`** (CLI-enforced) — loops close with
  `--evidence` or park with `--owner` + `--revisit-trigger`; assumptions end
  `--outcome tested|killed` with evidence. **A parked loop still drains confidence**
  (pinned by a test): a parked question is an unanswered question with an owner. Other
  collections are refused and pointed at their own verb.
- **Proof binding on every event** (CLI-enforced). `newEvent` gains `artifactId`,
  `artifactRev`, `artifactHash`, `hashScope`, `source` — additive, always present, so
  every v0.7 event stays valid and permanently unbound. `appendEvent` on a bound event
  computes rev/hash itself and refuses caller-supplied `artifactRev`/`artifactHash`,
  refuses a caller-supplied event id, **derives `mode` from the bound artifact** and
  refuses caller disagreement (a code artifact bound through `mode:"docs"` skipped the
  seam gate entirely), and requires `opts.verifiedHash`, refusing when the bytes moved
  (`file changed after verification — re-verify.`). *Falsifiers: forged rev/hash accepted;
  `mode:"docs"` on a `.js` artifact accepted; edit-then-append accepted.*
- **`ratchet-evolve verify <target> --artifact <id>`** (CLI-enforced) — fingerprints
  before AND after the test command, refuses a target that moved under the harness
  (`target changed during verification`), and emits `{artifactId, verifiedHash,
  verifiedRev, hashScope}` for the append call. *Falsifier: verify emitted no fingerprint
  at all.*
- **A dormant `state.rev`** (CLI-enforced). `saveState` increments a monotonic integer;
  `newState` opens at 0 and a missing rev reads as 0, lazily. **Nothing reads it in 0.8** —
  it ships now because a lost-update check added later cannot retro-number files written
  before the counter existed. *Falsifier: `a fresh state opens at rev 0` → rev was
  undefined.*
- **A fourth confidence read: workflow closure** (CLI-enforced). `score confidence`
  renders CLOSED / NOT CLOSED with its named blockers beside the three scored layers.
  Deliberately not a score — closure is a fact, and a number can always read "high enough".

### Changed

- **The KEEP gate reads the commands, not the claim** (CLI-enforced). Any `commands[]`
  entry with `pass !== true` refuses regardless of the claimed `result`; a claimed result
  that contradicts green commands refuses; a bare-string command (no machine verdict)
  is no longer evidence; and unwaived code KEEP now requires
  `seam.independentFromBuilderMethod === true` **strictly** — omitted and `null`, the
  shape a self-verifying builder actually leaves behind, previously rode through.
  *Falsifiers: `{result:"pass",commands:[{pass:false}]}`, `{commands:["npm test"]}`, and a
  seam with no independence claim — all three accepted by v0.7.*
- **Artifact identity and idempotent revision** (CLI-enforced). Terminal statuses and
  eight reserved fields (`rev`, `closedAt`, `closedBy`, `closedRev`, `closedHash`,
  `holesWaiver`, `retracted`, `supersededBy`) are refused on birth and update — a closure
  certificate must not be typeable in a payload. Re-adding an existing id **revises in
  place** (merge, `rev++`, one record); an identical retry is a **true no-op** — no rev
  bump, no `updatedAt` churn, no history line, byte-identical state, because a spurious
  bump silently invalidates bound proof. `kind` is immutable on update (a probe must not
  become closable in place); a duplicated id refuses every lifecycle verb repair-ably;
  `revises` is provenance only; a probe promotion must name an existing, non-probe
  replacement.
- **Defects attach honestly** (CLI-enforced). Exactly one live artifact auto-attaches
  (`attachedBy:'auto'`); zero leaves it unattached (`'none'`); **two or more refuses and
  names them**, because guessing blocks the innocent artifact and lets the guilty one
  close. A repeat report (same artifact + same trimmed, case-insensitive summary, while
  live) dedups and escalates severity in place. Birth into a terminal status is refused.
  Each record stamps the `artifactRev`/`artifactHash` it was found against.
  Evidence/owner/reason/`by` validation MOVED from `cmdDefect` into
  `artifacts.transitionDefect` — a gate with one polite caller is a convention.
- **The checkpoint is not settable by hand** (CLI-enforced). `dirty` and `lastCompileAt`
  are removed from `STATE_SCALARS`; `compile done` is the only checkpoint transition. It
  now prints `CHECKPOINTED, NOT CLOSED — state serialized` plus the next required
  transition, and `--json` emits `{checkpointed, closed, next}`.
- **`state reset --force` also requires `--owner` and `--reason`** (CLI-enforced), and the
  fresh state opens with a `state.reset` tombstone naming both — a wipe destroys the only
  record of why the wipe happened.
- **`state append` refuses `artifacts` and `defects` outright** (CLI-enforced) — both have
  gated constructors a raw append walks past — forces birth status for
  `assumptions`/`openLoops`, and dedups on trimmed text.
- **`ledger update defects` refuses a caller-supplied `status`** (CLI-enforced): the
  mirror is written only by a state defect transition. *Falsifier:
  `'{"id":"x","status":"resolved"}'` accepted by v0.7.*
- **One derivation, four surfaces** (CLI-enforced). `receipt.assemble` (`next.transition`),
  `md.stateSummary`, `compile done`, and the `stop-check` hook all call
  `lifecycle.nextTransition`. *Falsifier refuses string-matching theatre: the test injects
  a sentinel derivation and demands the sentinel itself appear on all four.*
- **The receipt binds its proof** (CLI-enforced). The PROOF card and `shipDecision` read
  the ACTIVE artifact's bound event instead of the last global KEEP. A path/title match
  still renders but is labelled `legacy unbound evidence — display only, cannot authorize
  closure`, and `proof.canAuthorizeClosure` states the fact separately from the seam
  judgment.
- **Aperture sequences end on compile and verify what they built** (CLI-enforced).
  A0 `build,verify,compile` · A1 `lock,build,verify,compile` · A2 unchanged ·
  A3 gains `verify` · A4 gains `compile`. Pinned by two invariants over every band rather
  than five literals. *This changed an existing assertion (`A0 === ['build','verify']`) —
  a deliberate contract change, not a weakened test.*
- **Windows: one path, one store** (CLI-enforced). On win32 `projectSlug` hashes the
  lowercased resolved path, with a legacy fallback that keeps reading an existing
  old-cased dir. Two casings of one project used to get two stores. *Falsifier: `one path,
  one slug` → two distinct slugs.*
- **A corrupt state file is never clobbered when its backup fails** (CLI-enforced) —
  `readJsonResilient` used to tell the caller to reinitialize anyway, deleting the only
  copy. The corrupt-backup filename is now allowlisted to `[0-9A-Za-z-]` (the stamp came
  from `RATCHET_NOW`, caller-controlled text landing in a path).
- **Prompt re-sync** (prompt-level, guarded by eight new `plugin-shape` assertions).
  PROMPTS.md's canonical path gains verify and states the ending rule; `ignite` gains a
  verify step and an A0–A4 table checked against `scoring.APERTURE_LEVELS` itself; `loop`
  cycles `build → attack → patch → verify → compile`, reads `loopClear` AND
  `workflowClosed.closed`, and **loses the "converged" escape** (two idle iterations on an
  unclosed workflow is *blocked*, not converged); `patch` resolves the ORIGINAL defect id
  with `--evidence` and drops the born-resolved example; `attack`/`verify` payloads name
  `"artifact":"<id>"`; `verify` runs bound and closes on green; `compile` teaches
  CHECKPOINT vs CLOSED; `handoff` checkpoints via `compile done`.

### Migration

Additive and lazy. `STATE_VERSION` stays **1** and there is no migration script. A fixture
test mirrors the shapes the live store actually carries — free-text artifact statuses, a
bare `status:'closed'` (read as **uncertified**: it runs the full close gate, not the
no-op), duplicate ids (refused repair-ably), an unattached open defect (blocks
`workflowClosed`, not another artifact's close), a fragment-bearing path
`CHANGELOG.md#unreleased` (downgrades to record scope with the reason stated), events with
no `artifactId` (permanently unbound), and no `rev` fields — and asserts the store loads,
scores, renders, and accepts every new verb without corruption.

### Hardened after adversarial review

A second model reviewed the gate by full source + diff inspection. Every finding below was
proven red before its fix; all are CLI-enforced unless marked.

- **Scope is part of the binding.** Record scope hashes `record:<kind>\n<title>\n<holes>`,
  so a FILE containing exactly those bytes collides — and rev does not move when a path
  goes from "not a file" to "a file". An old record/manual KEEP could therefore close a new
  code file, skipping both the seam gate and the record-owner gate. `bindingEvent` now
  requires the event's `hashScope` to match.
- **The fingerprint hashes bytes, not a text decode.** `readFileSync(…, 'utf8')` maps every
  invalid byte to U+FFFD, so `0x80` and `0x81` hashed identically. Valid UTF-8 is
  unaffected, so no existing text binding moves.
- **Proof must name the revision it ran against.** A metadata-only revision leaves the file
  untouched, so `verifiedHash` still matched while the artifact had moved on — rev-1
  evidence could be stamped onto rev 2. `verifiedRev` is now required and matched
  (`ratchet-evolve verify` already emitted it; nothing consumed it). The verify skill
  carries both fields (prompt-level).
- **A bound event cannot claim its own provenance** — `source` is stamped, not supplied.
- **A workflow with live work left is not closed.** `workflowClosed` keyed off the most
  recent record, so closing B and then building A read CLOSED while `nextTransition`
  demanded A's verification. It now prefers any remaining live artifact, and once none
  remain an open defect attached to the certified artifact still blocks: a certificate
  covers the revision it was granted against, not work raised since.
- **`closed` is a read-only legacy alias.** Transitioning into it cleared the drain with no
  evidence while `resolved` next door required `--evidence`. Legacy records still score as
  terminal; only the write path closed.
- **`init --force` is gated like `state reset --force`** — same `--owner` + `--reason`, same
  tombstone, one shared code path, so neither is the cheap way past the other.
- **Unreadable is not missing.** Only `ENOENT` means "no record yet"; any other read error
  (ACL, lock, EIO) now throws instead of reinitializing over a record that exists and
  cannot be seen.
- **A legacy-cased Windows store is migrated, not borrowed.** The fallback returned the old
  dir per call and never moved it, so a differently-cased cwd stranded the real store and
  opened an empty one beside it. It is now renamed once to the normalized slug; if BOTH
  exist the CLI refuses and names both paths rather than guessing.
- **One normalization for birth and revision.** The two paths coerced differently, so a
  legacy record acquiring a missing `holes: []` counted as a change and bumped rev —
  invalidating bound proof for a write that changed nothing.
- **A defect whose artifact cannot be fingerprinted is recorded, not half-attached.** The
  stamp used to fail silently, leaving an attachment that blocked closure while carrying no
  evidence of which revision it attacked. It is now kept and detached loudly
  (`attachedBy:'error'` + `attachError`).

A second review pass closed four residuals in the fixes themselves:

- **Path casing comes from the filesystem, not the caller.** Deriving the legacy Windows
  slug from the caller's spelling meant a caller who typed the path in lowercase produced
  `normalized === legacy`, the migration check short-circuited, and the mixed-case store
  stranded *permanently* — no later call could recover a casing nobody supplied. Casing is
  now recovered by walking the path segment by segment and adopting each parent
  directory's actual entry name, which makes the caller's spelling irrelevant and the
  short-circuit case vanish.
  **This deliberately does not use `realpath`:** realpath dereferences aliases
  (`C:\Users\All Users` → `C:\ProgramData`), so a session run through a junction would
  adopt the target's store, and the alias-keyed store it had been writing would never be
  migrated or conflict-detected — nothing would ever compute its slug again. `readdir`
  reports a junction under its own name, so aliases keep their identity and only the
  casing is corrected. The walk is memoized per path: the Stop hook runs it every
  invocation.
  **Stated limit:** a pre-0.8 store created under an on-disk casing the directory no
  longer has is unrecoverable. The filesystem no longer holds the evidence of how it used
  to be spelled, and the both-exist refusal can only compare candidates it can still
  compute. The same applies to UNC paths: the root canonicalization uppercases the server
  and share names, which `readdir` cannot report the casing of either, so a mixed-case
  pre-0.8 UNC store can be orphaned the same way. Such a store is orphaned, not lost — it
  remains on disk under its old slug.
- **`source` is refused if mentioned at all** on a bound event. Refusing only a *different*
  value let the forgery that matters — the right-looking `source:"evolve"` — through.
- **A present `holes` value is a real hole, whatever its shape.** Canonicalization made
  `holes:"TODO"` compare equal to `["TODO"]`, so the repair no-opped and the scalar survived
  in the store, where every `Array.isArray` guard read it as ZERO holes and the artifact
  closed over an invisible hole. Only *absence* is equivalent to `[]` — tested with
  `hasOwnProperty`, not falsiness, so `holes:""` and `holes:null` each count as one
  unexplained hole rather than none. Anything present that is not already a flat array of
  strings (a scalar, a nested `[["TODO"]]`) is the wrong shape, and repairing it is a real
  revision that persists the flat form.
- **Clearing a lineage link is a revision.** An explicit `revises:""` was dropped from the
  canonical patch and the old link survived. Absent (leave alone) and explicitly-empty
  (retract the claim) are now distinct intents.

### Trust boundary

The proof binding is **machine-authored but forgeable by filesystem writers**. It stops in-band laundering by
the model — the path the loop itself runs through — by refusing caller-supplied identity,
caller-chosen mode, and stale verification. It is **not** filesystem tampering protection:
the journal is plaintext at a caller-selectable path (`RATCHET_EVOLVE_LOG`), so anyone who
can write files can write lines. No signing is built, and none is implied.

### Parked (named, not silently deferred)

- **Ledger TEST rows remain an ungated write.** `ledger update tests` can still assert a
  status by hand. Only the defect mirror was gated in 0.8; the test rows are a known
  laundering surface, parked with the gate deliberately scoped to one collection.
- **Closed-artifact rot detection → v0.9 Entropy Gate.** A closure certifies a revision;
  nothing yet notices when the file behind a closed artifact changes afterwards, and
  same-path lineage is not validated. Out of scope here on purpose.

## [0.7.0] - 2026-07-06 — Probe Gate

0.6 gated the fog: *no map → no confident build*. It left two holes: fog the dial named
could live only on stdout (skipped maps leave no trace, so unrecorded uncertainty never
drains confidence), and some fog cannot be mapped by reading or asking at all — it only
appears by touching. The probe closes both: **a probe is a build whose proof-of-done is
knowledge, not code.**

### Added

- **The probe — build-for-learn as a first-class map closure.** Known unknowns now close
  by `user | territory | probe | parked | OPEN`, and `/ratchet:map` commissions a probe
  (`templates/probe-card.md`: unknown · hypothesis · smallest reversible touch · allowed
  surfaces · proof of learning · disposal rule · durable output · promotion rule · stop
  condition) when only touching the repo can answer. No new schema: a probe is an
  artifact (`kind:"probe"`, hole `disposal: pending`) whose hole drains confidence until
  the code is disposed via the existing gated verb (`ratchet retract --reason`) or
  explicitly promoted through a fresh `/ratchet:build` under the full proof/seam gates.
  Both invariants are CLI-enforced, not conventions: `artifact add` injects the
  `disposal: pending` hole on any probe that omits it, and a probe retraction must state
  its outcome (`--reason` starting `disposed:` or `promoted:`; a promotion requires
  `--superseded-by <the keep-build>`).
  **Probe code dies; probe findings live** — as a decision, assumption, open loop,
  defect, or map delta. `/ratchet:build` gained the build-for-learn mode (probe code is
  never implementation progress); `/ratchet:handoff` surfaces probe outcomes so a
  receiver cannot mistake residue for kept work.
- **The undrained-fog fix: scored fog can no longer live only on stdout.**
  `ratchet score aperture` with `mapRequired` now serializes the fog as an open loop
  (`fog: pre-build map required …`) for writer callers on **both output modes** — text
  and `--json` alike, so programmatic consumers cannot bypass the write (the JSON result
  carries `recordedFog`); propose-only agents still get a footprint-free read — and
  `artifact add kind:"unknown-map"` closes that loop when the map lands. Both ends live
  at the CLI boundary, so fog the dial named drains confidence, warns cold starts, and
  survives handoff even if the session never runs the map.
- **Cold-start fog checks.** The control-plane scan now warns on live probe artifacts
  (residue the next session could mistake for kept work) and FAILs when steering says
  build while a `fog:` loop is open. A retracted probe is a *completed* probe, not dead
  steering — the live-steering check exempts `kind:"probe"`.
- **Receipt fog card.** STATE now carries `fog` (live unknown-maps with OPEN item counts,
  unmapped fog loops, probes live/disposed) and renders it — emptiness stated
  (`Fog: none recorded`), never omitted.
- **Map convergence rule.** Every OPEN item leaving handover names its route out
  (ask-user · probe · park owner+reason · assumption+killTest · defect). An OPEN item
  with no route is a stall with a receipt, not mapped fog.
- **Surprise tripwires for fog the dial never saw.** `/ratchet:attack` flags
  wrong-premise findings as fog to serialize (not merely defects) and recommends
  re-entering `/ratchet:map` at two or more; `/ratchet:build` re-runs the aperture after
  two deviations (or one that reshapes the locked target) and stops when it says map.
  These are **prompt-level** guidance, unlike the CLI-enforced pieces above (fog-loop
  write/close, probe invariants, cold-start checks) — a session that skips the skills
  skips the tripwires; only the dial's own reads are boundary-recorded.

### Changed

- Session confidence names its epistemics out loud: the scope now reads **recorded loop
  pressure, not correctness** — unrecorded fog is invisible to it.

## [0.6.0] - 2026-07-06 — Fog Gate

0.2 gated proof (*no proof → no keep*); 0.3 gated the *seam* of that proof
(*wrong proof → no ship*); 0.4 metered the loop's *depth*; 0.5 gave it a *cockpit*.
0.6 gates the **fog**: high-uncertainty work maps its unknowns before it builds —
**no map → no confident build.** `/ratchet:map` walks the four unknown-quadrants
(known knowns · known unknowns · unknown knowns · unknown unknowns), the aperture dial
routes A3–A4 into it, and the map stays live through the build as deviation notes.

### Added

- **`/ratchet:map` — the pre-build fog gate.** The loop had no pre-build ambiguity pass:
  `/ratchet:cut` attacks assumptions, but nothing walked the codebase's tacit knowledge
  before building. `/ratchet:map` walks high-uncertainty work (aperture A3–A4, unfamiliar
  terrain, "I'll know it when I see it" taste, reference ports) through the four
  unknown-quadrants — known knowns (settled ground with `file:line` evidence), known
  unknowns (one blast-radius-ordered question at a time), unknown knowns (tacit taste
  surfaced by putting concrete options in front of the user), unknown unknowns (a swept
  landmine field) — and hands over one durable four-quadrant map, a build plan, and a
  copy-paste implementation prompt before any code is written. CLI-backed
  (`artifact kind:"unknown-map"`, decisions, assumptions, open loops), so its open items
  drain `ratchet score confidence` until closed; no schema change. Method grafted from
  dzhng/skills `explore-unknowns`, expressed in ratchet's own vocabulary.
- **Aperture routes through the map.** `ratchet score aperture` now folds `/ratchet:map`
  into the A3–A4 metered sequences (before `build`) and returns a `mapRequired` flag —
  true at A3+, or when a single dimension the summed score under-weights demands it
  (`taste = 2`, or `terrain = 2` with any `ambiguity`). `md.aperture()` renders
  **`Pre-build map: required`** so `/ratchet:ignite` routes high-uncertainty work through
  the fog gate instead of relying on the operator to remember. A4 still builds nothing.
- **The map lives through the build.** New `templates/unknowns-map.md` (the four-quadrant
  map's file shape, with a *Deviations during build* section) and `templates/deviation-note.md`
  (map said X → code revealed Y → call made). `/ratchet:build` now builds *against* an existing
  `unknown-map` artifact and records deviations as decisions/open-loops/defects instead of
  silently absorbing them; `/ratchet:handoff` surfaces those deviations so the receiver never
  re-litigates what the build already discovered.

## [0.5.0] - 2026-07-04 — Receipt

0.2 gated proof; 0.3 gated the *seam* of that proof; 0.4 metered the *depth* of the loop.
0.5 gives the loop a single cockpit: **one read — `ratchet receipt` — that says what is
true, what changed, what was proven, what is at risk, whether it is safe to ship, and
whether the receipt's own steering can be trusted.**

### Added

- **The receipt (`ratchet receipt`)** — one stable, always-same-shape read with eight fixed
  sections (TARGET · DELTA · PROOF · VERDICT · RISK · AUTHORITY · STATE · NEXT), joining session
  state, the evolve journal, the QA ledger, and git. Emptiness is stated, never omitted, so the
  shape never shifts between commands or sessions. `--json` emits the same structure for
  consumers; `--save` writes `.ratchet/current.json` + `current.md` as a gitignored
  source-of-truth index.
- **Three-layer confidence** — `ratchet score confidence` scores artifact · session · ledger
  independently, each naming its scope. A verified artifact stays ship-ready even when unrelated
  debt tanks session confidence — killing the "verified green but reported blocked" gaslight.
- **Cold-start control-plane scan** — the receipt runs the cold-start poison scan inline and
  renders `Control-plane scan: FAIL|WARN|clean` under STATE (also exposed as a top-level
  `controlPlane` field in `--json`), surfacing stale steering (retracted work still being pointed
  at) and misleading configured operator surfaces (e.g. unqualified git counts) in the one cold
  read — no separate doctor run. Project surfaces are an opt-in adapter declared in
  `.ratchet/cold-start.json`; no workspace path is hardcoded.

### Changed

- **`state reset` now requires `--force`** — an ungated canonical wipe is refused; the receipt
  AUTHORITY card renders the gates in force.
- **Agents are propose-only** — only the scribe writes canonical state; the builder and auditor
  are refused mutating verbs at the CLI boundary via `RATCHET_AGENT` (they read and propose).

## [0.4.0] - 2026-07-03 — Aperture

0.2 gated proof; 0.3 gated the *seam* of that proof. 0.4 adds the dial that decides how
much of the loop to run at all: **spend the full ratchet only when uncertainty earns it,
and snap when it doesn't.**

### Added

- **Aperture dial** — `ratchet score aperture <json>` scores five uncertainty dimensions
  (`ambiguity`, `terrain`, `taste`, `blastRadius`, `reversibility`, each 0–2), maps the
  total to a level A0–A4, and returns the exact ratchet skill sequence to run at that
  depth — from `build → verify` (A0 Snap) up to `lock → cut → decide` with **no build**
  until constraints are locked (A4 Max). A missing dimension defaults to neutral (1),
  never certain (0), so unknown uncertainty opens the aperture rather than closing it.
- **Aperture Read in `/ratchet:ignite`** — the master loop now meters itself: it scores
  the task first and runs only the depth uncertainty earns, instead of always running all
  seven steps. `/ratchet:lock` gained a matching "meter what follows" note.

### Changed

- `/ratchet:ignite` reframed from "run all seven; do not skip" to "run the aperture's
  metered sequence" — the seven-step pipeline is now the A2 default, not the floor.
- Bumped package, both plugin manifests, and the marketplace manifest to `0.4.0`.

## [0.3.0] - 2026-07-03 — Seam Gate

Where 0.2 made the loop **require proof**, 0.3 asks whether the proof is about the
thing you are actually shipping. A proxy evaluation can produce the right-looking
number and still point at the wrong decision, so a production `KEEP` now needs
evidence from the exact ship seam — and remediated defects can finally be cleared,
waived, or superseded through the CLI instead of blocking confidence forever.

**No proof → no keep** (0.2). **Wrong proof → no ship** (0.3).

### Added

- **Defect lifecycle** — `ratchet defect resolve | reopen | waive | supersede`,
  plus `list` and `get`. `resolve` requires `--evidence`; `waive` requires
  `--owner` and `--reason`; `supersede` links the replacement with `--by`. Each
  transition is logged per-defect and mirrored into the QA ledger. This is the
  mutation 0.2 lacked: a defect could be born but never cleared, so remediated
  work stayed confidence-blocking forever.
- **Seam-fidelity metadata on evolution events** — a verification can now record
  `evidenceType`, `method`, `independentFromBuilderMethod`, `testedSeam`,
  `shipSeam`, `seamMatch`, and `proxyWarning`.
- **Seam gate** — a production-code (`mode: code`) `KEEP` is rejected unless the
  evidence seam is an exact match for the ship seam, or a named human waiver is
  supplied. Verification that repeats the builder's own method is rejected as not
  independent.
- **`ratchet retract <id>`** — retract an artifact whose claim became false or
  obsolete (`--reason`, `--superseded-by`). Provenance is preserved
  (`keptForProvenance`), and a retracted artifact's holes stop draining confidence.
- **`ratchet git status-refs`** — base-qualified git status: every ahead/behind
  count names the ref it was measured against — never a bare "ahead of main".
- **`ratchet doctor cold-start`** — scans for stale steering that would start the
  next session in the wrong world. Generic ratchet-state checks always run;
  project operator surfaces (goal files, decision sheets) are an opt-in adapter
  via `.ratchet/cold-start.json`. No workspace path is hardcoded, and a
  declared-but-unimplemented check warns rather than silently passing. See
  `templates/cold-start.example.json`.
- **`REVERTED_AND_LEARNED`** — a first-class successful evolve outcome for a
  mutation reverted after verification that still left a reusable lesson. Evolve
  status counts it distinctly: corrected knowledge, no bad code kept.
- Codex install metadata: `.codex-plugin/plugin.json` plus a repo-local
  `.agents/plugins/marketplace.json`, so the plugin can be registered and installed by
  Codex CLI and surfaced in the Codex app.

### Changed

- Confidence scoring now treats `waived` and `superseded` defects as terminal
  (like `resolved` / `closed`) — a change proven necessary by a failing test
  before it was made. `resolved` handling was already correct and was left
  untouched.
- The terminal-defect predicate is centralized in `scoring.isDefectOpen` and
  consumed by the scorer, the state summary, and the QA ledger, so a cleared
  defect can never read as open on one surface while draining on another.
- The `ratchet` CLI gained a real `--key value` flag parser for subcommands that
  carry values (the router previously treated every `--flag` as boolean).
- Package metadata, `ratchet doctor`, and plugin-shape tests now cover both Claude Code
  and Codex manifests.
- npm packaging includes the Codex marketplace file explicitly as
  `.agents/plugins/marketplace.json`, without packaging the whole `.agents` tree.
- Repo snapshots now surface `.agents` and `.codex-plugin` alongside the existing
  plugin-critical dot directories.
- Bumped package, both plugin manifests, and the marketplace manifest to `0.3.0`.

### Fixed

- Remediated defects could never be cleared through the CLI, so they blocked
  confidence permanently. They can now be resolved, waived, or superseded.
- A production `KEEP` could be justified by a proxy evaluation that measured a
  different seam than the one it ships on. The seam gate now blocks that.

## [0.2.0] - 2026-07-03 — Proof Gate

Hardening, not expansion. This release makes the loop's philosophy mechanically true:
a cleaner command surface, an enforced proof gate, trustworthy state, and a verified
plugin shape. **No proof → no keep** is now enforced by code, not just by convention.

### Added

- **Proof gate.** `ratchet-evolve log append` now rejects a `KEEP` verdict that lacks
  verification evidence: a failed result, or no command/manual checks, or a `manual`
  result with no explicit checks, all throw before anything is written. `REVERT` and
  `ASK` are exempt by design.
- **`ratchet compile done`** — atomically stamps `lastCompileAt`, clears the dirty flag,
  and records a `compile.done` history event, so the Stop hook stops nagging after a
  compile.
- **`ratchet doctor`** — a plugin health check: Node version, manifest parsing, version
  alignment, required directories, every `SKILL.md` frontmatter/description, `hooks.json`,
  bin targets, state-dir writability, and a live repo-snapshot probe. Exits non-zero on
  any failure.
- **`ratchet-evolve next`** — reads the last recorded next edge (`--json` supported).
- **Manual-evidence templates** — `templates/evolve-event.json`,
  `templates/evolve-manual-checks.md`, and `templates/evolve-report.md`.
- **Plugin-shape test suite** (`test/plugin-shape.test.js`) — asserts manifests parse and
  align, CLI version constants match `package.json`, every skill has a valid `SKILL.md`,
  agents have frontmatter, bin targets exist, and the README command list matches the
  skill folders (and mentions no removed command names). Wired into `npm test` and CI.

### Changed

- **Renamed the evolution command** from `/ratchet:ratchet-evolve` to `/ratchet:evolve`
  (skill folder `skills/ratchet-evolve/` → `skills/evolve/`). The helper CLI binary stays
  `ratchet-evolve`. No compatibility alias is kept.
- `ratchet-evolve status` now reports kept / reverted / **asks** / active targets / last
  verdict / next edge.
- CLI version strings are now derived from `package.json`, making it the single source of
  truth for the plugin, both CLIs, and the marketplace manifest.
- The compile flow (`/ratchet:compile`, `ratchet-scribe`) now calls `ratchet compile done`
  instead of setting `lastCompileAt` by hand.
- Bumped package, plugin, and marketplace manifests to `0.2.0`.
- CI smoke-checks now include `ratchet doctor` and `ratchet-evolve status`.

### Fixed

- `--version` printed the full help text instead of the version, on both CLIs.
- The dirty-state Stop-hook reminder persisted after a compile; `ratchet compile done`
  now clears it.
- The evolution journal accepted `KEEP` events with no verification evidence.
- Repo snapshots hid plugin-critical dot directories (`.claude-plugin`, `.github`,
  `.claude`, `.ratchet`) via a blanket dot-dir skip; an allowlist now surfaces them while
  still ignoring `.git`, `node_modules`, and caches.
- Malformed `state.json` / `ledger.json` were silently discarded; they are now backed up
  to `<file>.corrupt.<timestamp>.json` before a fresh file is created.

### Removed

- `/ratchet:ratchet-evolve` (renamed to `/ratchet:evolve`).

## [0.1.0] - 2026-07-03

Initial public release.

### Added

- **Ratchet command family** (`/ratchet:*`) — the consequence-engine loop:
  `ignite`, `lock`, `auction`, `cut`, `mechanism`, `build`, `attack`, `verify`, `patch`,
  `decide`, `burn`, `push`, `compile`, `status`, `loop`.
- **Specialized commands** — `repo-audit`, `qa-ledger`, `prompt-audit`, `handoff`.
- **`/ratchet:ratchet-evolve`** — a bounded, evidence-gated mutation loop over a single
  artifact: LOCK → SNAPSHOT → PRESSURE → MUTATE → JUDGE → APPLY → VERIFY → KEEP/REVERT/ASK →
  RECORD → NEXT EDGE.
- **`ratchet` CLI** — the state engine (status, snapshot, scoring, artifact/defect records,
  markdown export) with per-project state under `$CLAUDE_PLUGIN_DATA` / `$RATCHET_DATA_DIR` /
  `~/.ratchet`.
- **`ratchet-evolve` CLI** — deterministic, evidence-gated evolution helpers (snapshot,
  score, verify, journal to `.ratchet/evolve-log.jsonl`).
- **Three agents** — `ratchet-builder`, `ratchet-auditor`, `ratchet-scribe`.
- **Conservative hooks** — SessionStart (ensure data dir), PostToolUse (track touched
  files), Stop (compile reminder). Never runs tests or edits on its own.
- Single-plugin marketplace manifest so the repo installs directly as a Claude Code plugin.
- Zero-dependency smoke test suites for the state engine and the evolution helpers.

[Unreleased]: https://github.com/TheLucidTech/torque-loop/compare/v0.7.0...HEAD
[0.7.0]: https://github.com/TheLucidTech/torque-loop/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/TheLucidTech/torque-loop/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/TheLucidTech/torque-loop/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/TheLucidTech/torque-loop/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/TheLucidTech/torque-loop/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/TheLucidTech/torque-loop/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/TheLucidTech/torque-loop/releases/tag/v0.1.0
