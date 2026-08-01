# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- **4b.3 review round (independent Codex verification, verdict "NO" on six contract
  gaps — all six accepted, fixed red-first; three claim-wording findings ruled
  not-defects).** All CLI-enforced, each with a falsifier (W1–W6) seen red against
  `main @ b029c81` before its fix:
  - **Strict slots decode strictly (W1):** `parseIntent` now uses a fatal UTF-8 decode;
    a slot with invalid bytes refuses as unrecoverable instead of being lossily
    normalized into an operationId nobody published — and then cleared.
  - **The receipt must carry the intent's tool (W2):** `validateMirrorReceipt` compares
    `receipt.tool` to `intent.tool`; a post-state slot whose tool contradicts the
    receipt it names is ambiguous, never completed.
  - **Mirror validity means agreement, not linkage (W3):** the spec projection carries
    status, severity, AND summary. The transition mirror op now writes all three
    (summary was dropped), and the exact-repeat validity check compares all three
    instead of counting linked rows — a stale-but-unique mirror is now trued by one
    committed repeat, then repeats no-op again.
  - **Doctor observes without recovering (W4, W4b):** the WAL diagnosis runs first, and
    the writability probe no longer travels the write door at all — an existing store
    is probed with a scratch file instead of `initProject`, whose lock acquisition ran
    recovery. Previously doctor consumed the slot and reported "no pending intent"
    about the store it had just changed; round 2 showed even a reordered probe loses a
    slot that lands after the diagnosis sample, so the probe is now lock-free by
    construction (W4b races a slot in after the sample and proves it survives).
  - **Resource reads are byte-pure, enforced (W5):** the MCP read paths (state/ledger
    resources, the receipt resource, `score.confidence`) now use pure peeks that never
    create, back up, or reinitialize a record; an unprovable record answers the one
    allowlisted MirrorUnrecoverable sentence. Previously a resource read over a
    malformed ledger wrote a `.corrupt` backup file — a write on a read path.
  - **CLEAR re-checks identity (W6):** the slot delete (spec CLEAR step) re-reads the
    slot and refuses if the bytes are not the bytes this pass proved — on both the
    transaction's own clear and recovery's fenced clear.
  - **Round 2 of the same review added three more, fixed the same way:** the peeks
    decode fatally like the slot parser — a record with invalid UTF-8 answers the
    allowlisted sentence instead of serving a U+FFFD-normalized projection (W7); the
    stale-mirror truing commit moves ONLY the mirror — no duplicate log/history line,
    no restamped proof timestamp; "commits once solely to admit it" now means exactly
    that (W3 extended); and the doctor probe race above (W4b).
  - **Round 3 of the same review added two more, fixed the same way:** the strict
    mirrored-write reads and recovery's two record parses decode fatally like
    everything else (W8, W9) — previously a lawful write over a record carrying one
    invalid byte would commit a U+FFFD-normalized serialization and settle state and
    ledger in permanent disagreement with no pending intent left behind; and doctor's
    missing-store branch no longer reaches `initProject` at all (W4c) — a missing
    store probes its nearest existing ancestor, so no first store appearing in the
    sample-to-probe window can be recovered by the diagnosis tool. Doctor no longer
    creates the store as a side effect; the first write does.
  - **Round 4 of the same review added two more, fixed the same way:** the ordinary
    loaders joined the fatal-decode rule (W10, W11) — `readJson`'s fast-path peek
    answers null on undecodable bytes, and `readJsonResilient` routes invalid UTF-8
    through the same loud backup-then-reinitialize path it has always used for invalid
    JSON, with the backup now preserving the exact original bytes; previously a lawful
    ordinary write would silently serialize a U+FFFD-normalized record and settle the
    two canonical files in disagreement with no backup and no intent. And the doctor
    writability probe now proves directory creation as well as file creation (W13) —
    Windows ACLs grant the two separately, the lock is a mkdir, and a file-only probe
    answered "writable" where the first real write then failed. W12 additionally pins
    recovery's own fatal decode against an adversarially consistent slot whose hash
    certifies undecodable bytes.
  - **Round 5 returned the review's YES** ("one operation, two files, one crash story —
    the mirror guarantee holds"): both round-4 fixes verified, the decode sweep found
    no remaining permissive parse on any canonical byte path, and the probe matrix
    passed all four ACL shapes. Its one LOW — a half-failed doctor probe left its
    scratch directory behind — is fixed (cleanup in a best-effort finally, W14).
  - **Known limitation (parked, review round 2): the identity-checked clear is two
    syscalls.** The CLEAR step re-reads and compares before deleting, exactly as the
    spec words it — but compare and unlink cannot be one atomic operation through a
    pathname API (no compare-and-unlink exists; same class as the 2.5 check→read gap).
    A substitution landing in that window is deleted. Reaching it requires a writer
    that bypasses the workspace lock — every lawful writer publishes and clears slots
    under it — so this is recorded as a named limit, not repaired with machinery the
    contract cannot honor.
  - Ruled NOT defects, on the record: pre-commit `.tmp-` residue (documented inert by
    design in 4b.1), CLI/MCP byte-equality (ids and receipts differ by ratified
    design), and the MCP retry wording (the spec deliberately gives MCP the generic
    `WriteFailed`; the CLI carries the "re-run" sentence). S20's loader count was
    updated to the new peek — the one-snapshot contract it pins is unchanged and it
    now additionally pins that reads never touch the creating loader.

<!-- Traced by: claude-fable-5 -->

### Added

- **Known limitation (parked, owner: Danny): a host-environment hold can stall the
  mirror publish.** On the development host, replacing a freshly written `ledger.json`
  intermittently refuses `EPERM` for longer than any bounded retry we ship (measured:
  the source tmp stays movable, the destination opens `r+`, the replace alone refuses —
  a holder sharing read/write but not delete; ~1–3% of operations, only under sustained
  machine load, never reproduced by isolated probes). The canonical publish now waits
  against a deadline (`RATCHET_PUBLISH_TIMEOUT_MS`, default 10s, the same shape git
  ships for Windows renames), recovery's own mirror publish wears the same retryable
  `ERATCHETMIRRORPENDING` code instead of leaking raw `EPERM`, and both doors answer
  "re-run the command" — which provably converges (the WAL suite's M4, and its settled
  harness). What is NOT claimed: that a single call always succeeds on such a host.
  Diagnosing the holder needs OS-level tooling (handle enumeration), which is an
  operator investigation, not a code path.

<!-- Traced by: claude-fable-5 -->

- **The defect transitions ride the slot — the mirror stops being best-effort.** Step
  4b.2: `defect.resolve`, `defect.reopen`, `defect.supersede` join the wire (18-tool
  `--write` roster), and every transition on BOTH doors — the CLI-only `defect waive`
  included — commits its state change and its ledger-mirror status behind the same
  write-ahead intent. The old best-effort mirror sync is gone: a ledger failure now
  surfaces instead of being swallowed, and recovery completes the mirror the dying
  process proved. **Named behavior change:** an exact-repeat transition (same target
  status, same proof fields, mirror valid) is now a no-op — no log line, no history, no
  revision — where it used to grow the log on every rerun; a repeat with DIFFERENT
  proof refuses rather than silently replacing the original, and an exact repeat over a
  missing or ambiguous mirror commits once solely to perform the D2b admission.
  `defect.waive` remains absent from `tools/list` and the dispatcher, permanently. Five
  new falsifiers (both-door equivalence, exact-repeat and conflicting-repeat semantics,
  per-transition D2b admission, a real process dying between a transition and its
  mirror, wire replay); the repeat no-op and the mirror-status propagation each seen
  red against a deliberately broken variant.

<!-- Traced by: claude-fable-5 -->

- **The write-ahead intent slot — one operation, two canonical files, one crash story.**
  Step 4b.1 of the ratified WAL design
  (docs/superpowers/specs/2026-07-31-mcp-4b-wal-design.md): `defect.add` is the first
  cross-file verb, on both doors — the state record, its QA-ledger mirror, and the
  back-link commit behind one create-exclusive, size-capped, version-1 `intent.json`
  carrying MATERIALIZED post-images and four exact pre/post byte hashes. The state
  commit is the decision; recovery — living at the shared post-acquire path of BOTH
  workspace-lock APIs, so every supported writer inherits it (**CLI-enforced**) — lands
  every process death on one of three legal hash pairs and finishes or discards the
  work byte-exactly, proven against the hashes the dying process recorded. Anything
  strict recovery cannot prove preserves every byte and refuses `MirrorUnrecoverable`
  on every write door and on `workspace.open`; `AttachmentAmbiguous` names the
  several-live-artifacts refusal; both sentences are spec-pinned literals in the one
  funnel. Dedup stays a no-op decided before any intent; escalation reaches the mirror
  in the same operation; a legacy defect with no valid mirror is admitted on its first
  committed escalation (D2b — one new mirror, old rows untouched). Every read states
  `pendingIntent` out loud (race-safe revision+token sampling, derived, never
  persisted); `ratchet doctor` gains read-only WAL diagnosis that names the condition
  and never repairs. The guarantee covers process/server death, NOT sudden power loss
  — file fsync is best-effort and the directory is never fsynced, stated in spec and
  code. The canonical publish also gained a brief fenced retry for transient Windows
  rename refusals (surfaced by the crash matrix; persistent refusals still throw). 22
  falsifiers in `test/mcp-wal.test.js` including a real-process crash matrix dying at
  the intent link, the state rename, the mirror rename, the clear unlink, and twice
  INSIDE recovery itself; four mechanisms each seen red against a deliberately broken
  variant (choke point disabled → 9 red, hash machine loosened, receipt validation
  skipped, publish retry removed). `workspace.open` now snapshots under the workspace
  lock so recovery precedes every handle.

<!-- Traced by: claude-fable-5 -->


- **The artifact verbs and the read that writes — the safe core is complete.** Step 4.3
  of the ratified write-tools design: `artifact.add`, `artifact.close`,
  `artifact.retract` and `score.aperture` complete the ten-tool `--write` roster, each a
  thin boundary over the same domain mutation the CLI runs — `artifact add`/`retract`
  split into transaction-shaped cores (`src/artifacts.js`), the closure gate moved there
  from the CLI router, and the aperture fog write moved to `src/verbs.js`, all shared by
  both doors. The lifecycle gates the CLI earned hold unchanged on the wire
  (**MCP-boundary enforced** where the rule is static, domain-refused where it needs the
  record): terminal statuses and reserved lifecycle fields refuse at the boundary; an
  identical revision is a no-op that costs no revision and invalidates no proof; a close
  is earned only by a KEEP bound to the exact revision and hash, inside one transaction
  that spans the journal lock, commit included; and a probe exit must state
  `disposed:`/`promoted:` with a recorded non-probe replacement. **There are no waiver
  arguments on this wire, permanently**: record-scope proof and holes-waived closure
  refuse `HumanAuthorityRequired` — typed self-authorization is not a named human, so
  those closures stay CLI acts. Four new allowlisted refusals (`ArtifactClosed`,
  `ClosureBlocked`, `HumanAuthorityRequired`, `RetractRefused`) join the funnel; raw
  domain messages, which may name store files, never cross. `score.aperture` names
  `expectedStateRev`/`expectedStateGen` like every write — the fog write's
  first-racer-wins guard legitimately re-arms when a map lands, so CAS, not an
  idempotence claim, is what keeps a stale retry out; a score that owes no fog is
  byte-pure and commits nothing, and `recordedFog` is truthful on both outcomes. Six new
  falsifiers in `test/mcp-write.test.js` (contract pins, CLI-equivalence per verb,
  byte-pure refusals, verbatim replay of a closure certificate); the refusal mapping, the
  identical-revision no-op, and the one-fog-write guard were each seen red against a
  deliberately broken variant.

<!-- Traced by: claude-fable-5 -->

- **The five MCP session verbs — the roster rides the proven envelope.** Step 4.2 of the
  ratified write-tools design: `state.append`, `open_loop.close`, `open_loop.park`,
  `assumption.close` and `compile.done` join `state.set` on a `--write` server, each a
  thin boundary over the same domain mutation the CLI verb runs — the meanings of
  `state append`, `state close` and `compile done` moved to `src/verbs.js`, shared by
  both doors, so the two surfaces cannot drift into two meanings for one verb. Every
  tool carries the full 4.1 envelope (revision + generation CAS, operation receipts,
  deterministic ids, one error funnel) through one shared outcome mapping. CLI gates
  travel to the wire as schema (**MCP-boundary enforced**): evidence, owner,
  revisit-trigger and the tested|killed outcome are required non-empty fields; the
  `collection` enum excludes `artifacts` and `defects`, whose gated constructors a raw
  append would bypass; and a claimed non-birth status never crosses the boundary — loops
  are born `open`, assumptions `untested`, on both doors. Transitions on records that do
  not exist refuse the new allowlisted `UnknownRecordId` with zero bytes moved; a
  same-text loop or assumption dedups under the lock as a no-op naming the existing
  record. `state.append` is the one non-destructive hint in the roster — a status
  transition or checkpoint overwrite is not additive merely because provenance survives.
  Twelve new falsifiers in `test/mcp-write.test.js` (roster contracts, CLI-equivalence
  per verb, byte-pure refusals, a replayed checkpoint stamp), each seen red before the
  roster existed; the `UnknownRecordId` mapping and the birth-status boundary check were
  additionally each seen red against a deliberately broken variant. Cross-file verbs
  still wait for 4b.

<!-- Traced by: claude-fable-5 -->

- **The first MCP write tool — and the machinery that makes a retried write safe to
  retry.** `state.set` joins the registry ONLY when the server is launched with `--write`:
  an unflagged server registers no write tools at all, so `tools/list` never advertises
  capability the operator did not grant, and `--write` under a propose-only
  `RATCHET_AGENT` refuses at startup instead of failing every call (**CLI-enforced**,
  with `assertMayWrite` still the backstop underneath). Every write names
  `expectedStateRev` AND `expectedStateGen` — the revision and store lineage it decided
  against — and is refused stale, never merged; a recreated store that reuses a numeric
  revision still refuses on the generation. Every write carries an `operationId` whose
  receipt is durable **inside the state record** (`state.operations`, ring of 32,
  committed in the same atomic rename as the revision it describes), so a verbatim retry
  — same connection or a fresh one after a server crash, new handle and all — returns the
  persisted result marked `replayed` instead of applying twice; the same id with a
  different meaning refuses `OperationIdConflict`. The binding hashes tool + semantic
  arguments + revision + generation, never the handle: transports die, decisions don't.
  Ids minted by an MCP write derive from that binding, so a crash-boundary re-application
  converges on the same record — and a derived id that already names a record refuses
  `DeterministicIdConflict` rather than letting entropy impersonate an address. A no-op
  commits nothing and records no receipt (the 0.9 property, kept on purpose; its
  observability limit is stated in the spec). All refusals cross one funnel with an
  allowlisted sentence each — no path, errno, or store location rides the wire — and
  every structured result, success and refusal alike, conforms to the declared
  `oneOf` output schema (**MCP-boundary enforced**). Five crash-boundary replay tests,
  each seen red against a deliberately broken variant, include a real child process dying
  at the commit rename and a real reconnect over `bin/ratchet-mcp --write`. The verb's
  meaning moved to `src/verbs.js`, shared by the CLI and the MCP boundary — one
  implementation, two doors. `workspace.open` now reports `stateGen` beside `stateRev`,
  from the same snapshot. Safe core per the ratified step-4 design
  (docs/superpowers/specs/2026-07-31-mcp-write-tools-design.md): cross-file verbs
  (`defect.*`, `ledger.update`) wait for 4b's WAL design; waivers stay CLI acts, never
  wire arguments.

<!-- Traced by: claude-fable-5 -->

- **The 16 canonical ratchet prompts are now an MCP prompt surface.** `prompts/list`
  advertises each prompt and its body-derived required arguments; `prompts/get` substitutes
  those arguments into a fresh copy of the canonical body for both supported protocol eras.
  The registry is generated from `reference/PROMPTS.md` at build time and byte-matched in
  `plugin-shape`, so a stale committed artifact fails CI instead of drifting at runtime.
  Unknown prompts and missing or non-string required arguments are **MCP-boundary enforced**;
  the instructions inside each returned prompt remain **prompt-level guidance**, not CLI
  enforcement.

<!-- Traced by: openai-codex-gpt-5 -->

- **Three derived MCP read tools — and the proof that a read is a read.** `workspace.scan`,
  `score.confidence` and `score.friction` join `workspace.open` in `tools/list`, in one
  deterministic order produced by the same descriptor/handler registry the dispatcher selects
  from — so a listed tool cannot lack an implementation and an implemented tool cannot stay
  undiscoverable (**MCP-boundary enforced**, pinned by whole-descriptor assertions). They are
  derived computations, never a second spelling of a canonical document: `status`, `export`
  and defect reads stay resources, and `score.aperture` is excluded because a map-required
  result records fog, which is a write.
  - `workspace.open` now initializes the **ledger** alongside state before it issues a handle,
    and issues none if either record fails to open. This repaired a live defect: `loadLedger`
    creates the ledger under lock when it is missing, so the shipped first `resources/read` of
    `ledger` on a fresh workspace *wrote bytes*. Every read path is now provably pure over the
    store that open initialized, proved by a byte-snapshot over the store, the workspace
    `.ratchet` directory, the evolution log and a configured cold-start surface across all
    three resources and all three tools. Scope, named: a canonical record deleted or corrupted
    *after* open — server-local damage no client authority can cause — still meets the
    loaders' designed locked self-repair; fail-closed-vs-repair for that case is a parked
    public-shape decision (owner: Danny, see the Step 3b spec's named limit).
  - Every handle-bound read — resources and tools alike — crosses **one** connection-local
    authority check. Missing, non-string, malformed, fabricated, stale, revoked, closed and
    foreign-connection handles all return `-32602` with one non-enumerating message on both
    doors (**MCP-boundary enforced**).
  - `score.confidence` loads state **once**: the reported `stateRev` is the revision of the
    snapshot the layers were computed from, never a re-read. Journal damage rides the wire as
    `journal: { counted, malformed }` instead of a stderr warning no MCP client can see; an
    absent log is stated as zero, not omitted.
  - `score.friction` takes no handle and reads no ambient workspace. Malformed arguments —
    including an unknown field on an obstacle — are refused at the MCP boundary; clamping and
    the `obstacle` / `timeToUnblock` / `riskOfIgnoring` aliases remain domain behavior.

### Changed

- **The cold-start scanner refuses a surface that resolves outside the workspace root.**
  `.ratchet/cold-start.json` surfaces were resolved with `path.resolve`, so an absolute or
  `..` path was opened and its matching lines were quoted into a check detail — over MCP, a
  checked-in config file could widen authority past the handle it was read through. An
  escaping surface is now never opened and is reported as a named check
  ("surface escapes workspace root — not read"), so the refusal is stated rather than silent.
  **CLI-enforced in the cold-start domain**, so `ratchet doctor cold-start` and the receipt
  inherit it; it warns rather than fails, because nothing outside was read.
- **A store conflict is distinguishable.** `projectSlug`'s legacy/normalized collision now
  throws with code `ERATCHETSTORECONFLICT`, and the MCP boundary maps it to one actionable
  sentence ("workspace store has conflicting project records — operator must merge or delete
  one") instead of collapsing it into the generic "workspace state could not be opened", which
  had already cost one diagnosis round-trip. No server path crosses the wire.

<!-- Traced by: claude-opus-5 -->

## [1.0.0] - 2026-07-30 — Boundary Gate

0.2 gated proof; 0.3 the seam; 0.6 the fog; 0.7 the probe; 0.8 closure; 0.9 the write.
Every one of those governed what the loop may *keep* — and every one quietly assumed the
record was only ever read from inside the process that held it. 1.0 opens the record to
anything that speaks MCP, and that changes the question from *what may be kept* to *who may
reach in*. A pathname cannot answer it: the filesystem decides what a path means, a symlink
re-points a component, `..` means the parent of where you actually arrived, and the object a
name referred to can be exchanged between the check and the read. So nothing crosses as a
name. A client names a path exactly once, to `workspace.open`, and gets back a capability
bound to one connection and one filesystem object — re-verified on every use, refused the
moment something else answers to that name. 1.0 gates the boundary:
**no handle → no read.**

The surface it opens is deliberately narrow: one tool, three read-only resources, and two
real clients proven against it — Codex 0.142.5 on legacy `2025-06-18`, Claude Code on modern
`2026-07-28`. What it does not yet do is write. Four limits are named rather than implied:
verify-on-use narrows the validation-to-read race but does not close it (Node exposes no
`openat`, and inode reuse can alias a deleted object); Torque state is keyed by a slug of the
canonical root pathname, so two repositories occupying one path over time share one record;
Codex registration stays explicit because a bundled config has nothing correct to put in it;
and `Connected` proves a handshake, not which era a given client negotiated.

### Changed

- **README restructured so value precedes setup, and the MCP server is no longer invisible.**
  The front door described `/ratchet:evolve` — one of twenty-one commands — while install had
  grown to 43% of the document and pushed the Commands section past the halfway mark. The
  headline now states the whole engine and the three things it bundles; the MCP server is a
  top-level section rather than install sub-section "F"; install collapses from six lettered
  paths (A–F) to the four real choices; and a table of contents is added.
  - The Development section was **wrong**, not merely thin: it called `npm test` a
    "zero-dependency smoke test over the state engine" when it is eleven suites, and it never
    mentioned `npm run preflight` at all. It now names every suite and what it guards, both
    gates, how to run one suite, and the two rules a contributor is held to.
  - Restored during review, after diffing the rewrite against the original: the MCP surface
    says out loud that it is **one tool and three read-only resources today** (the rewrite had
    thinned that into "the only call that accepts a pathname", which reads as though there are
    others), and Codex's lack of a documented per-session workspace substitution is back as
    the reason a bundled config has nothing correct to put in it.
  - Prose claims verified against the code rather than trusted: the evolve log path, the
    `receipt --save` targets, `doctor cold-start`, zero runtime *and* dev dependencies, the
    eleven-suite count, and every relative link.

### Added

- **`--project-root`: a host may NAME the workspace, which is not the same as this server
  guessing one** (CLI-enforced, six falsifiers). Claude Code sets `CLAUDE_PROJECT_DIR` in a
  spawned MCP server's environment to the project it opened. Reading it is not the cwd
  inference this server refuses — cwd is an accident of how we were spawned, while this is
  the host stating which workspace it means — but it takes an explicit flag to accept, so
  the authority stays visible in the config a human reads.
  - Refuses when the variable is unset, with a diagnostic that blames the host rather than
    the operator: they *did* configure a root, and a generic "nothing configured" would send
    them to fix the wrong file.
  - The named root must still be absolute. In a project `.mcp.json`, `CLAUDE_PROJECT_DIR` is
    set in the server's environment rather than substituted into `args`, so the documented
    `${CLAUDE_PROJECT_DIR:-.}` form can expand to `.` — which is rejected rather than
    resolved against a working directory the host does not document.
  - It adds to explicit `--root` values rather than replacing them, and a flag-configured
    launch still ignores `RATCHET_MCP_ROOTS`, which remains the no-flag fallback only.
- **Claude Code registration is documented, and verified against the real client.**
  `claude mcp add torque --scope local -- node .../bin/ratchet-mcp --root <repo>` reports
  `✔ Connected` — the first time a real third-party MCP client has completed a handshake with
  this server on the modern revision, closing the interop loop left open when the entry point
  landed. (Codex 0.142.5 closed the legacy half on `2025-06-18`.) The README also documents
  the portable project-`.mcp.json` shape that `--project-root` exists to serve.
- **This repo deliberately ships no root `.mcp.json`.** A project `.mcp.json` is the obvious
  way to wire the server into Claude Code, and it was written and then removed: this repo is
  itself a plugin, and Codex treats a plugin's root `.mcp.json` as a bundled server config
  resolved inside the plugin cache. Shipping one for Claude Code would hand Codex installs a
  server that cannot work, and would silently reverse the decision not to auto-declare a
  bundled Codex server. Registration stays explicit per host.
- **`bin/ratchet-mcp` + `src/mcp/main.js` — the MCP server is launchable, and registered
  with Claude Code** (Torque MCP: the public surface). Everything the protocol needed
  already existed; what was missing was a way to start it. Two decisions carry the weight,
  both CLI-enforced with tests proving the refusal path:
  - **stdout belongs to the protocol.** Usage, version, the startup banner, and every
    configuration refusal go to stderr. A diagnostic on stdout is not a log line, it is a
    corrupt frame. Falsifiers assert stdout is empty on every non-serving path and that
    every stdout line from the spawned binary parses as JSON.
  - **Roots are never inferred.** With no `--root` and no `RATCHET_MCP_ROOTS`, the server
    exits 2 instead of falling back to its working directory — which is whatever the client
    spawned it in, and would widen the 2.1–2.5 allowlist by accident on every launch. An
    unknown argument is refused for the same reason: a `--roots` typo must not quietly
    become an empty allowlist. `--root` is repeatable, and a dedicated parser exists
    because the one in `src/cli.js` stores flags in an object where a second `--root` would
    silently *narrow* the allowlist. Flags win outright over the environment rather than
    merging, so an inherited variable cannot add authority to an explicit launch.
  - Root validation fails at configuration time, not on first call: a missing, relative, or
    non-directory root is reported with its reason and exits 2.
- **`.claude-plugin/plugin.json` declares the server**, launched as
  `node ${CLAUDE_PLUGIN_ROOT}/bin/ratchet-mcp --root ${CLAUDE_PROJECT_DIR}`, so installing
  the plugin registers it with the opened project as its single root. Tools appear under
  `torque`, matching the `torque://` resource scheme and the `torque-mcp` server identity.
  `node` is the command and the script is an argument on purpose — `bin/ratchet-mcp` has no
  extension and no exec bit on Windows, so naming it as the command would install cleanly
  and fail to launch on half the platforms.
- **`test/mcp-entry.test.js` — 20 cases**, wired into `npm test`. Twelve cover the
  configuration surface in-process; eight **spawn the real binary and talk to it over real
  OS pipes**, which is the first thing in this repo to exercise node startup, argv, the
  shebang wrapper, and process exit together. One of those runs a real *client process*
  driving the real server process, because a handle is connection-scoped and open-then-read
  cannot be expressed as a fixed input script; another locks the legacy revision proposed by
  Codex 0.142.5 to the real executable boundary.
- **`test/plugin-shape.test.js` — two new drift guards.** `ratchet-mcp`'s version joins the
  aligned-version assertion, and the declared MCP server is now checked to launch through
  `node`, locate its script from `${CLAUDE_PLUGIN_ROOT}`, point at a file that exists, be a
  declared `bin` target so packaging keeps it, and pass a `--root`. A plugin manifest is
  read by the host at install time, so a renamed binary would otherwise fail in the user's
  install and nowhere in CI. Verified by breaking the manifest and watching it fail.
- **Codex registration is verified and remains explicit by design.** Codex does support
  plugin-bundled MCP servers through `mcpServers: "./.mcp.json"`, but resolves a bundled
  server's working directory inside the installed plugin and exposes no documented
  per-session workspace substitution for its arguments. Declaring
  `node ./bin/ratchet-mcp --root .` would therefore authorize the plugin cache, not the
  opened project. The README now gives the exact `codex mcp add` command with absolute
  launcher and root paths; `.codex-plugin/plugin.json` stays free of a misleading automatic
  grant.
- **A real Codex client found and closed the legacy negotiation gap.** Codex 0.142.5
  proposes MCP `2025-06-18`; Torque previously answered every non-`2025-11-25` initialize
  with `2025-11-25`, which that client rejected before tool discovery. The legacy
  compatibility set is now closed over exactly those two named revisions, echoes either
  supported proposal, and still falls back to the newest legacy revision for an unknown
  proposal. Era pinning is unchanged: both revisions are one request/response era and can
  never mix with the stateless `2026-07-28` surface.

- **`src/mcp/handles.js` — verify-on-use: a handle names the object it was granted
  over, not whatever later answers to that name** (Torque MCP build-order step 2.5,
  CLI-enforced at the registry boundary). Steps 2.1–2.4 established authority at grant
  time and then handed back a canonical pathname to re-resolve on every use, so anything
  that took over that name inherited the grant. A grant now records WHICH OBJECT it was
  issued over — containing device plus inode, taken from the same `stat` that validated
  the kind, never a second one — and every `use` re-checks that the recorded pathname
  still reaches that same object. Replacement is refused, not inherited.
  - Identity is read in the **wide** form (`{ bigint: true }`). NTFS file ids and large
    inodes exceed 2^53, where adjacent values collide as JS Numbers
    (`10696049115337591` rounds to `...592`), so a Number-based check would call two
    different objects one. A falsifier asserts every identity read passes `bigint`.
  - Object type changes come free: an inode cannot change what kind of object it is, so
    a file replaced by a directory fails as a different object without its own rule.
    Content changes are *not* staleness — a rewritten file keeps the same object, and
    invalidating there would break every capability on every ordinary write.
  - A create grant records its **parent** directory's identity too. Absence at the
    target says nothing about *where* the create would land: the name is still free
    inside a directory that was swapped underneath it.
  - Staleness answers `ERATCHETHANDLESTALE`, distinct from the uniform
    `ERATCHETHANDLE` refusal, and safe to distinguish because the holder already proved
    the handle exists by presenting it. Revocation is checked **first**, so a revoked
    token never earns the stale reply and stays indistinguishable from one that never
    existed — the enumeration guarantee is unchanged.
- **`src/mcp/server.js` — a replaced workspace root no longer reissues dead authority.**
  The open-workspace cache keys on the canonical pathname, so a directory replaced
  between two opens would otherwise be served the handle minted over the object that
  used to be there. The cached grant is now re-proved on every open; a dead one is
  revoked and reissued, never repaired.
- **`test/mcp-toctou.test.js` — 17-case replacement suite**, written red first (11 of
  the first 16 failed against the unpatched tree) and wired into `npm test`. Directory
  and file replacement, mid-path parent swaps, deletion, file-becomes-directory, create
  targets that become occupied, create parents that get swapped, hard-linked second
  names, cross-connection independence, revocation precedence, wide-inode comparison,
  every granted operation, and two end-to-end server cases driving replacement through
  `workspace.open` and `resources/read`.
  - **What this does not claim.** It does not make use atomic: Node exposes no `openat`,
    so a gap remains between the identity check and whatever the caller then does with
    the path, and an attacker who wins that gap on every attempt is not stopped by this.
    Nor does it survive inode reuse — a filesystem may hand a deleted object's id to a
    new one. What it converts is *silent substitution* into a *named refusal*, which is
    the class where the attacker wins by leaving the substitute in place. Closing the
    remaining gap means binding reads to an opened descriptor (open loop, owner Danny).
  - **Scope of the resource guarantee, stated exactly:** Torque state and ledger do not
    live in the repository — they resolve under the ratchet base dir keyed by a slug of
    the canonical root pathname. The refusal after replacement therefore protects
    *authority freshness*, and for the receipt read also byte provenance; it is not a
    claim that the state record itself was inode-verified. Two different repositories
    that occupy one pathname over time still share one Torque state record — a scoped
    product decision, **parked** rather than silently changed (owner Danny).
- **`src/mcp/server.js` — `workspace.open` and handle-bound `torque://` resources**
  (Torque MCP build-order step 2.4). This is the first composed server surface:
  `workspace.open` is the only call that accepts a pathname, and it passes that path
  through canonical containment and Git-root discovery before minting an opaque,
  connection-scoped capability over the canonical worktree root. The result carries
  `workspaceHandle`, stable repository/worktree identities, the current `stateRev`,
  and standard resource links for the workspace state, ledger, and cold-start receipt.
  - Root and subdirectory opens converge on one handle within a connection; another
    connection gets a different handle even for the same repository. The cache keys on
    the canonical root itself, never on an identity digest: opaque identities label a
    workspace on the wire but do not decide filesystem authority.
  - `resources/list` is deliberately empty and connection-invariant. Dynamic opened
    workspaces are returned as `resource_link` blocks by the tool, while three static
    templates advertise `torque://workspace/{workspaceHandle}/{state|ledger|receipt}`.
    Modern list results are public-cacheable for five minutes; resource reads are
    explicitly private with zero TTL. Legacy responses omit the modern cache and
    `resultType` fields.
  - Malformed, fabricated, raw-path, closed, and cross-connection resource URIs all
    receive one refusal. A resource read re-proves that its handle is a live directory
    grant for the recorded canonical root; Git metadata paths and canonical workspace
    paths never cross the MCP boundary.
  - Opening is the explicit Torque-state initialization boundary, so `stateRev` always
    names a real canonical record. The tool is idempotent and non-destructive, but is
    not advertised as read-only because first open may create that external state
    record.
  - **Boundary named, not closed:** a capability binds authority and the canonical name,
    not an open filesystem descriptor. Step 2.5 owns stale-handle, replacement, and
    validation-to-read race attacks. The executable stdio entry point and Codex
    registration remain later public-surface work.
- **`test/mcp-server.test.js` — 15-case composition suite**, written red first and
  wired into `npm test`. It covers both protocol eras, deterministic tool/template
  lists, closed input schemas, canonical-root handle convergence, revision refresh,
  cross-connection isolation, private resource caching, fixed-shape state/ledger/receipt
  reads, uniform URI refusal, path-error redaction, immediate death on close, and an
  independent end-to-end read through the newline-delimited stdio adapter.
  - Traced by: `openai-codex-gpt-5`
- **`src/mcp/repository.js` — Git-root discovery and local repository identity**
  (Torque MCP build-order step 2.3). Discovery begins only after the step 2.1 root
  authority accepts the client-supplied directory, resolves the innermost Git
  top-level, and then sends that top-level back through the same authority. An
  allowlisted subdirectory therefore cannot smuggle in a repository root outside
  the configured boundary.
  - Repository identity is the SHA-256 digest of the canonical Git common directory;
    worktree identity separately digests the canonical Git top-level. Linked worktrees
    consequently share one opaque `repo_…` identity while retaining distinct opaque
    `worktree_…` identities. Branch, commit, and remote changes do not redefine either.
  - Git is invoked without a shell and with ambient `GIT_*` variables removed, so
    inherited `GIT_DIR`, `GIT_WORK_TREE`, or config overrides cannot redirect
    discovery away from the directory that passed containment.
  - Non-Git directories, files, inaccessible metadata, sibling repositories, and
    nested repositories have explicit, tested behavior. The canonical common Git
    directory may live outside the workspace allowlist for a linked worktree; it is
    used only as hashed identity material and is not granted as workspace authority.
  - **Boundary named, not closed:** discovery still observes mutable pathnames and Git
    metadata over time. Step 2.5 owns the adversarial TOCTOU pass; step 2.4 owns the
    public `workspace.open` and `torque://` surface that consumes this internal record.
- **`test/mcp-repository.test.js` — 12-case Git discovery suite**, written red first
  and wired into `npm test`. It covers subdirectories, spaces, non-repositories,
  files, both allowlist checks, internal links, nested and sibling repositories,
  linked worktrees, ambient Git overrides, and identity stability across branch and
  HEAD changes.
  - Traced by: `openai-codex-gpt-5`
- **`src/mcp/handles.js` — opaque, connection-scoped workspace handles** (Torque MCP
  build-order step 2.2). A handle is a **capability, not a shorter spelling of a
  pathname**. It is minted only by the server, only from a path step 2.1 already judged
  contained, and the registry entry keeps the facts established at that moment rather
  than a string to re-interpret later: the connection it was issued to, the workspace
  root it belongs to, its canonical name within that workspace, its kind, the exact
  operations granted, and an issuance nonce distinguishing it from any other grant over
  the same target.
  - 256 CSPRNG bits per handle. The client cannot choose one (a supplied `handle`/`id`
    is ignored, not honored), cannot predict one, and cannot derive one — two grants of
    the same file are two different capabilities.
  - Scoped to exactly one live connection: useless on another connection *even from the
    same client*, dead the instant its connection closes, and never minted by a closed
    one. Retired values are remembered for the registry's lifetime, not just by the
    issuing connection, so an RNG collision cannot make a dead capability become someone
    else's live one.
  - **The registry is not an existence oracle.** Unknown, malformed, wrong-typed,
    revoked, closed, and belonging-to-another-connection all raise one identical
    refusal. Presenting a handle you *do* hold and asking for an operation it lacks is a
    different, specific refusal — naming the missing authority reveals nothing you had
    not already proven.
  - Kinds are `file`, `directory`, `create-file`, `create-directory`, checked against
    what is actually there at issue time; `file` means a regular file, not a socket, pipe,
    or device. This is also where the trailing-separator limitation from step 2.1 is
    answered: a nonexistent name ending in a separator may mint `create-directory`, but
    is refused as `create-file`, so the directory assertion is not silently discarded.
    Unknown kinds and unknown or empty operation sets are refused at grant.
  - Requested operations are snapshotted once before validation, and connection metadata
    is copied both when the connection opens and when a grant is returned, so getters or
    caller mutation cannot edit a stored record into more authority.
  - When configured roots are nested, a target binds to the most-specific containing
    root, so workspace identity does not depend on allowlist order.
  - Filesystem examination errors distinguish absence from an object that could not be
    examined. Both fail closed, but the refusal no longer sends the reader to the wrong
    cause.
  - **Boundaries named, not closed:** a handle does not eliminate the race between
    validation and use — the filesystem underneath can still change; what it removes is
    client-controlled path substitution and repeated authority interpretation at the
    protocol boundary. Lookup is a `Map` get and therefore not constant-time, which is
    not claimed as a timing-attack defence. And "handles are the *only* accepted
    workspace authority" is enforced by the tool surface that does not exist yet
    (step 2.4); what this step proves is that a raw path is not accepted *as a handle*.
- **`test/mcp-handles.test.js` — 25-case capability suite**, with the initial 16 written
  red against an absent module, eight combined-boundary review falsifiers written red
  against the interrupted `196c9e3` draft, and an explicit containment/handle seam case
  covering both internal and escaping symlinks. Wired into `npm test`.
- **`src/mcp/workspace.js` — the root allowlist and canonical path containment**
  (Torque MCP build-order step 2.1). The invariant, **with its boundary named**: no
  client-controlled path is accepted unless the components this module observed, as it
  observed them, placed it inside a configured root — directly or indirectly. A string
  check cannot establish that, because the filesystem decides what a path means — so
  containment is judged on a canonical path, every component resolved through the
  filesystem in order, never on the text the client sent.
  - **Not provided: safety across time** — not after the call, and *not even at the
    instant it returns*. Each component is observed at its own moment and the filesystem
    can be rearranged between any two of them, so the result describes what was true
    during the walk and may already be stale on the way back. A pathname API cannot do
    better: Node exposes no `openat`-style primitive to bind a resolution to an opened
    directory without a dependency. Closing that window means never handing back a name
    at all — operating through a bound handle instead — which is the next sub-step's
    job. Named here rather than implied away.
  - Resolution walks component by component rather than calling `realpath` once: a
    single call fails with `ENOENT` on a path that does not exist yet, and says nothing
    about a link already traversed. `..` is applied to where the path has *actually*
    arrived, after any link — `path.resolve` would collapse it lexically first, turning
    `<root>/link-to-elsewhere/..` into `<root>`, a different directory than the client
    named. Climbing past a component that does not exist is refused outright, since the
    filesystem would give that no answer either.
  - Refused directly: relative and drive-relative paths (Node calls Windows `\work`
    absolute, but it means a different place depending on the process's current drive —
    and `\\name\` is the same trap in UNC costume, since a real UNC path needs a server
    *and* a share), `..` escapes, unrelated absolute paths, and a sibling that merely
    shares a root's name prefix (`/srv/work` does not contain `/srv/work-evil`).
  - **A backslash is a separator only where the platform says so.** On POSIX it is an
    ordinary character in a filename, so splitting on it would turn `/srv/work\evil` — a
    *sibling* of the root — into a path inside it. Extended UNC (`\\?\UNC\...`) is
    refused rather than half-handled, because its root is not what `path.parse` reports.
  - Refused indirectly: a symlink leaving the root, a symlinked directory partway along,
    a **dangling** link whose destination nothing can confirm, a component that is a file
    rather than a directory (including a *link to* a file, and a trailing separator on
    one — a file has no contents to descend into, and `..` may not climb out of it as if
    it had), and any component that could not be examined at all — unreadable is not
    absent, so `EACCES` fails closed rather than being treated as a path that does not
    exist yet.
  - Name comparison is **exact, never case-folded**: both sides come from
    `realpath.native`, which answers with the name the filesystem actually stores, so
    equivalent spellings have already converged. Lowercasing would be worse than useless
    — JavaScript's case mapping is not the filesystem's, and `"İ".toLowerCase()` is two
    code points, so distinct directories could be judged the same one.
  - **Known limitation, named not fixed:** a trailing separator on a target that does
    not exist yet (`<root>/new-dir/`) asserts "this is a directory", and the returned
    name does not carry that assertion — a caller could create a file there instead.
    Refusing it outright would break the legitimate case of naming a directory you are
    about to create, and carrying it would change the return contract, so the fix belongs
    with the typed handles in the next sub-step rather than here. Containment is not
    affected. (Open loop, owner Danny.)
  - Zero roots is a **closed** allowlist: every path is refused. Roots must be fully
    qualified, existing directories, and are canonicalized at construction. Links that
    stay *inside* a root are followed normally — containment is not achieved by refusing
    the feature. Refusals name the boundary without echoing the resolved target, which
    would answer the question the traversal was asking.
- **`test/mcp-workspace.test.js` — 28-case containment suite**, written red against an
  absent module and wired into `npm test` (the plugin-shape unwired-suite guard was
  verified red against it first). Three independent Codex review rounds — "do not ship",
  "do not ship", then **containment holds** — with every accepted finding reproduced
  before its fix.
  **Ten of the twenty-five findings were defects in the tests themselves**, which is the
  point of running the review at all: falsifiers whose escape landed outside the root, so
  they passed against a broken implementation for a reason unrelated to the rule under
  test; cases that built their `..` paths with `path.join`, which
  normalizes the dot segments away before the module ever sees them; a case-comparison
  test the reviewer defeated by loading the *old* implementation and watching it pass; an
  assertion that could not fail; a UNC fixture that refused because the path did not
  exist rather than because it was malformed; and a rationale comment that was wrong
  about how Node handles a NUL. Every falsifier is now verified red against the
  implementation it targets, checked out from git rather than assumed. The suite keeps
  the positive controls that stop it passing for the wrong reason: an implementation that
  refused every symlink, or every `..`, would block all the escapes and still be broken.

- **`src/mcp/rpc.js` — the Torque MCP RPC kernel with era pinning** (CLI-enforced at the
  kernel boundary; Torque MCP 1.0 build-order step 1 of the ratified spec). A connection
  speaks exactly one protocol era: `server/discover` pins **modern** (MCP `2026-07-28` —
  stateless, version and capabilities in `_meta` on **every** request, required
  `resultType`, `serverInfo` answered in result `_meta`), `initialize` pins **legacy**
  (`2025-11-25` handshake, answered in its own shape with no modern fields leaked), and
  after the pin the other era's surface is a named `-32010` refusal carrying the remedy
  (reconnect) — never a silent downgrade, never a mixed connection. A missing or
  unsupported protocol version is `-32022` (`UnsupportedProtocolVersion`, MCP-allocated
  range) naming both supported doors, checked **before** method resolution so a wrong
  version never learns method names; missing `clientCapabilities` is `-32602` naming the
  key; a method that exists only in the other era — or a modern-marked request arriving
  on a legacy connection — refuses by era rather than lying with `-32601`. Handshakes
  must be requests: a notification-shaped `initialize`/`server/discover` is dropped and
  pins nothing, a shapeless `initialize` refuses `-32602` unpinned, and a non-JSON-RPC id
  type refuses `-32600` undispatched. The method table is null-prototype (a method named
  `constructor` misses, never dispatches `Object.prototype`). Handlers register per-era
  in a declarative table; a throwing handler — or a result whose own getter throws under
  decoration — answers `-32603` and the connection survives. Named ruling:
  `server/discover` is **version-exempt by design** — it is the door a client knocks to
  learn what versions exist, and demanding proof of a version before answering that
  question is circular. Scope: the kernel judges envelopes and eras only — no tools,
  resources, state access, or transport policy live here (those are later build-order
  steps).
- **`src/mcp/stdio.js` — newline-delimited JSON framing for local stdio** (Phase 1
  transport). Framing only, and framing happens in **bytes**: lines are split on the
  wire and each complete line is decoded on its own, so a multi-byte character cut across
  chunks survives intact and invalid UTF-8 is a named `-32700` rather than silent
  replacement-character rewriting (a legitimate U+FFFD still round-trips). A garbage line
  answers `-32700` instead of killing the stream; any line past `maxLineBytes` (default
  8 MiB) is refused whether or not it ever ends, with a trailing `\r` counted as framing
  rather than content; the refused line's allocation is released rather than retained by
  the tail that follows it (`retainedBytes()` exposes what is actually held); and a
  result the kernel accepted but JSON cannot carry answers `-32603` on the wire. Every
  protocol judgment defers to the kernel. No `bin/` entry point yet — exposing
  `ratchet-mcp` is a public-surface decision parked for Danny (open loop).
- **`test/mcp-rpc.test.js` — 54-case contract suite**, wired into `npm test` (the
  plugin-shape unwired-suite guard was verified red against it first). Three independent
  Codex review rounds drove the kernel from "one era does NOT hold" to **"one connection,
  one era: YES"**; every accepted finding was reproduced red before its fix, and the
  defect trajectory was 15 → 13 → 6.
  - Round 1 (15 findings, verdict NO): 12 fixed, one ruled design (the discover
    exemption above), one an unfalsifiable test, one — remedies on standard JSON-RPC
    refusals — applied where a remedy exists (`reconnect`) and declined for wire-level
    errors whose reason is the remedy.
  - Round 2 (verdict still NO on one pin break): an `initialize` wearing the modern
    `_meta` marker proves both eras and now refuses unpinned; incomplete handshakes pin
    nothing; own `__proto__` keys in a result neither pollute nor suppress `resultType`;
    `clientCapabilities` must be a map, not an array; no refusal echoes an unusable id;
    dropped notifications became countable (`dropped()`) so a test can tell acceptance
    from silent rejection; the unpinned refusal says "no era yet", not "the null era".
  - Round 3 (verdict YES, patch-then-ship): results are **normalized to inert data
    before decoration** — inspecting a result for a `toJSON` loses to a getter that
    answers differently on the second read or a `toJSON` one level down in `_meta`, and
    either way `JSON.stringify` would run it after the kernel decorated, erasing
    `resultType` and `serverInfo` on the wire; `clientInfo` must carry `name` and
    `version`; ids are read **once** and must round-trip unchanged (an unsafe integer
    echoes as a different number, so it is refused); and a refused oversized line no
    longer keeps its allocation alive through the tail that follows it. Two of the
    round-3 falsifiers were green against the unpatched kernel on first write — they
    asserted the kernel's return value where the defect lives in serialization — and
    were rewritten to assert the wire bytes before the fix went in.

## [0.9.0] - 2026-07-29 — Concurrency Gate

0.2 gated proof; 0.3 the seam; 0.6 the fog; 0.7 the probe; 0.8 closure — and every one
of those gates assumed, without ever saying it, that a single writer held the pen. Two
agents on one store could each read rev N and both land rev N+1, and the record kept
whichever truth wrote last. 0.9 gates the write itself — three attack rounds drove
fourteen findings to three, and the three that remain are named in this entry rather
than wished away: **no lock → no write. Two writers. One ordered truth.**

### Added

#### Concurrency Gate — no lock → no write. Two writers. One ordered truth.

0.8 shipped a monotonic `rev` that nothing read. It was placed there so a later version
could detect a lost update without a migration; this is that version. Nine falsifiers
(`test/concurrency.test.js`) were written RED first against 0.8 — eight of them real
multi-process races, run on `process.execPath` with sentinel-file barriers so the
interleavings are the operating system's, not a simulation. Traced by: claude-opus-5.

- **One shared mutation primitive.** `state.withWorkspaceMutation(cwd, { expectedStateRev,
  action }, mutate)` is the only door onto a state REVISION — the wipe and the corrupt-record
  repair publish outside it, deliberately (they replace a record rather than revising one), and
  both hold the workspace lock and pass the same publish-time ownership fence. "Only door" is
  scoped to revisions, not to every byte that reaches the store: resolve the store →
  acquire the cross-process lock → **reload the state under the lock** → compare
  `expectedStateRev` when supplied → apply → commit **exactly one revision** → release in
  a `finally` on every path. CLI-enforced. `expectedStateRev` is optional (the CLI does not
  yet expose a `--expected-rev` flag) and mismatch is a **refusal**, never a silent rebase:
  a caller that names a revision is claiming it read that exact record, and rebasing its
  conclusion onto a record it never saw writes a stale decision as if it were fresh. A
  refusal moves zero bytes, zero revisions, zero history (`err.code = 'ERATCHETSTALE'`).
- **One public command is one transaction.** The boundary covers the whole verb, not each
  save: `defect add` writes state, mirrors to the ledger, and links the mirror back inside a
  single lock and commits once. Low-level helpers (`artifacts.js`, `ledger.js`) never lock
  and never save independently — inside a transaction `loadState` returns the transaction's
  live state and `saveState` defers to its commit. Threading a CAS through every save
  instead would have produced multi-rev noise, self-staleness, and nested-lock deadlock.
- **A real semantic change is one revision; an idempotent re-run is zero.** The commit fires
  only when the serialized record actually moved, so re-running a serialize block costs no
  revision, no timestamp churn, no write — a structural property of the boundary rather
  than a rule each verb has to remember.
- **The lock.** A directory (`<store>/.lock`) created with `mkdir`, the one create-or-fail
  primitive every supported filesystem agrees is atomic; an owner card inside it names pid,
  host, action, and real wall-clock time. Bounded retry with exponential backoff
  (`RATCHET_LOCK_TIMEOUT_MS`, default 15s) then a **refusal that names the owner**, never a
  hang.

  **A lock whose owner is provably alive on this host is never broken — not at soft-stale,
  not at hard-stale, not ever.** Breaking a live writer's lock does not unwedge it; it just
  adds a second writer to the record it still has open, so a wedged live holder produces a
  perpetual named refusal instead. An honest refusal beats a stolen lock.
  `RATCHET_LOCK_HARD_STALE_MS` (120s) therefore applies **only where liveness cannot be
  established at all**: a dead pid, a foreign host, an unreadable owner card, or a card whose
  timestamp is in the future (an unbelievable clock makes the holding unprovable, not sacred —
  age used to clamp to 0 there, which turned one bad timestamp into a permanently unbreakable
  lock). Under `RATCHET_LOCK_STALE_MS` (5s) nothing is broken regardless.

  Liveness is established by `process.kill(pid, 0)` plus host match, and that is a **deliberate
  trade with a named cost**: the OS can recycle a pid, so a dead holding whose pid number has
  been reused by an unrelated live process is protected indefinitely — a **pid-reuse wedge**.
  The alternative is stealing locks from live writers, which is worse. The operator is the
  recovery path, so every `ERATCHETLOCK` refusal names the lock directory, the owner pid, host
  and action, the age, and the remedy (delete the `.lock` directory once you have confirmed the
  process is not a ratchet writer).

  **Release removes our holding or nothing, and it verifies by MOVING.** The card carries a
  per-acquisition random **token**; a blind `rmdir` is how a process whose lock was broken as
  stale deletes its *successor's* live lock on the way out. Checking the card and *then* deleting
  the directory was still two steps, so a successor that acquired in between was deleted by a
  process that had already "checked" — release now renames the directory aside first (atomic:
  after it, what we hold is ours alone to inspect and nobody else can be inside it), verifies the
  moved card is ours, and only then deletes. A mismatch is restored if the slot is free and named
  as an incident otherwise. Where the rename cannot be done at all (Windows refuses to move a
  directory another process has open; the retries are bounded) it falls back to the older
  verify-in-place delete rather than wedge every future writer — that fallback carries the
  original TOCTOU and is named here rather than hidden.
  **The break verifies what it moved, whatever shape the card is.** The decision reads one owner
  and the rename moves whatever occupies `.lock` at that instant, which may already be a new
  live generation (ABA). After the rename the moved card is compared against the owner that was
  judged stale — by token where there is one, and **by whole-card bytes where there is not**,
  because a verification that only runs for tokenized cards is not a verification: a tokenless
  judgment used to skip it entirely and could carry off a live successor. An **unreadable** card
  now matches nothing at all, including another unreadable one: mapping every read failure to an
  empty string made two unrelated invisible holdings compare equal. (A provably ABSENT card is a
  different fact and two absences do compare equal — otherwise a lock whose owner died between
  `mkdir` and the card write would be permanently unbreakable. That narrowing is deliberate and
  the residual window is covered by the publish-time fence.) On a mismatch the holding is put back
  if the slot is still free, and if it cannot be put back the acquisition **fails stop**: the call
  that stranded a holding it could not verify does not go on to take the lock it freed
  (`ERATCHETLOCKINCIDENT`). A later command may retry; that one is over.

  **And every publish re-verifies ownership in the instant before it lands.** The residual
  windows above — a break that stranded a live holding, an ABA steal — all end in the same state:
  two processes each believing they hold one lock. The check sits inside the atomic writer,
  between "the new bytes are on disk" and "the new bytes ARE the record", because a check any
  earlier leaves the whole write-flush-close window unguarded and the rename publishes anyway. It
  applies to **every** canonical publish under a lock — the state commit, the wipe, the
  corrupt-record repair, the ledger, and the create-or-fail link — by living in `writeJson`
  rather than at each call site, since three of those five had already forgotten it. A holding
  that is no longer ours turns the publish into a **loser-side refusal that writes nothing**
  (`ERATCHETLOCKLOST`). That is what shrinks the remaining protocol races from data-loss hazards
  to logged incidents. One window survives and is claimed as a **known defect, not covered**: the
  verification and the rename are two instructions, so a steal landing in the instant between
  them still publishes. No user-space check can fuse them — closing it needs an OS-level
  verify-and-rename primitive that does not exist — and reaching it at all requires a lock steal
  the rest of this section already makes fail-stop or verified. Shrunk, named, not eliminated.
- **Reentrancy is decided, not discovered.** A nested `withWorkspaceMutation` is refused
  loudly (never a silent self-deadlock); a nested lock scope on the *same* workspace joins
  the open one; a second *different* workspace is refused.
- **The lock order is declared AND enforced: workspace → file, never the reverse.** Two lock
  families exist (the workspace store, and per-file locks such as the evolution journal), and
  a process holding one while waiting for the other in the opposite order to a second process
  is the textbook ABBA wedge — here it would surface as a pair of timeouts, which is still two
  failed commands and no diagnosis. Taking the workspace lock while holding a file lock now
  throws by name. CLI-enforced, with the permitted direction covered by the same test.
- **First-time creation is locked and never clobbers.** Creating `state.json` / `ledger.json`
  is a WRITE, and it used to happen outside the lock: a paused first read on an empty store
  could publish its fresh rev-0 record over a revision a locked writer had already committed —
  a read erasing a write. Creation now runs under the workspace lock, re-reads there (if the
  store appeared while we queued, that record wins), and publishes with a **create-or-fail**
  primitive — the record is written to a temp file and **hard-linked** into place, so it both
  refuses an existing destination and lands whole. Where hard links are unavailable the fallback
  is a temp file plus rename (atomic, existence-checked under the lock): the earlier `wx` open
  wrote the canonical path **in place**, so an interrupted creation left a permanently malformed
  `state.json` that creation then refused to repair while every reader minted another `.corrupt`
  backup. Atomicity beats exclusivity here — the exclusivity given up is only against writers
  that bypass the lock, which no advisory lock can stop anyway.
- **A malformed record is repaired, once, under the lock.** The corrupt-bytes backup is a WRITE
  and used to happen before the lock, in a read. Backup and repair now both run inside the
  workspace lock, and the unusable file is REPLACED (its bytes are already preserved — including
  FALSEY documents that parse but are not records: `null`, `false`, `0`, `""` were replaced with
  no backup at all, because the repair tested truthiness rather than shape; a TRUTHY non-record
  such as `[]` or a bare scalar still slips past the shape check — a **known defect**: `[]` is
  returned as-is and a scalar throws instead of repairing) instead of
  being refused as "already exists" — which had left the bad file in place forever, so every
  future read backed it up again and the store could never be opened.
- **A CAS refusal on an absent store leaves the store absent.** Naming `expectedStateRev`
  against a workspace with no record used to auto-create `state.json` on the way to throwing.
  The revision check now happens before the read that would create anything: nothing can match
  a named revision on a store that does not exist, and a zero-byte refusal means zero bytes.
- **`artifact close` holds the journal lock across its own commit.** The closure gate's evidence
  lives in the journal, and the read was unlocked while the workspace lock was held — so a
  `REVERT` appended between the read and the commit was invisible and the artifact closed on a
  KEEP the record had already revoked. Locking only the *read* moved that window instead of
  closing it, so the boundary now takes the second lock (`alsoLockFile`) and holds it until the
  state revision has landed: a verb whose decision depends on another file cannot release that
  file before it publishes. Acquired inside the workspace lock, so the declared order holds.
- **The evolution journal validates under BOTH locks for a bound event.** Binding an event to an
  artifact's revision and hash was checked before any lock, then (cycle 1) under the journal
  lock — which excluded the wrong processes: the writers that can move an artifact from rev 1 to
  rev 2 take the *workspace* lock and never touch the journal. A bound append now holds the
  workspace lock and then the journal lock, and validates inside both — and the state read that
  materializes the store happens INSIDE the workspace lock, where it simply joins the open scope.
  **Unbound events take the journal lock ALONE**, which is now true rather than merely claimed:
  the state read was unconditional, and on a fresh store that read IS the locked init transition,
  so an unbound append queued behind (and on a busy store died on) a workspace lock it never
  needed. An unbound event reads nothing from state, so it no longer touches it.
- **A half-written journal line no longer eats the next event, and a damaged log cannot certify
  a closure.** An append that died mid-line left the file not ending in a newline, and the
  following append concatenated itself onto the fragment — one unreadable line where there
  should have been a damaged one and a good one, so the *new* event was lost too. The fragment is
  now terminated first and stays on the log as its own unreadable line. And the damage is part of
  the reader's **result** (`readEventsWithHealth` → `{ events, malformed, file }`), not merely a
  stderr warning: a dropped `REVERT` reads exactly like no `REVERT`, so `artifact close` now
  **fails CLOSED** on any unreadable line and names the log. The stderr warning remains, and is
  explicitly *not* the mechanism any decision rests on — it dedupes per file and count, so an
  earlier read could otherwise silence the one a gate needed.
- **One identity, one event.** A caller-supplied event id that is already on the log is
  refused rather than silently regenerated — a caller that supplies an id is naming a specific
  event, and quietly renaming it leaves the caller holding an id that means something else.
- **Atomic persistence.** Every JSON write is serialize → same-directory temp file → fsync →
  atomic rename over the canonical path → temp cleaned. A death anywhere before the rename
  leaves the previous record byte-for-byte intact. Verified by SIGKILLing a lock-holding
  writer mid-transaction on Windows: `state.json` unchanged by sha1, still parseable, and
  the next writer recovered the abandoned lock by itself.
- **Cross-process identifiers.** `makeId` was a timestamp plus a **process-local** counter,
  so three processes sharing one clock handed out the same ids. It is now
  `<prefix>-<time36>-<48 bits of CSPRNG>` — scannable and roughly ordered, unique because
  of the entropy, not the clock. Zero new dependencies (`node:crypto`).
- **The evolution journal names and appends as one step.** Event identity was
  count-of-today's-events + 1, which every racing process computes identically before any of
  them writes. It is now the highest sequence already on the log plus one, computed under a
  dedicated lock beside the log file (the log's path is caller-selectable, so the workspace
  lock would be the wrong scope in both directions). The `evo_YYYY_MM_DD_NNN` format is
  unchanged.
- **Cold start names interrupted-write residue.** An unrenamed scratch file or a held lock is
  reported as a **warning, not a failure** — it is not a contradiction in the steering, but a
  cold session opening on somebody's dead commit should be told rather than left to wonder.
- **Every test suite must participate in `npm test`.** The concurrency falsifiers spent a
  release deliberately outside the authoritative command, which is exactly how a suite gets
  left there; `plugin-shape` now fails if any `test/*.test.js` is unwired. CI-enforced,
  proven red against the unwired script before landing.

### Changed

- **A `state reset --force` continues the revision line; it does not restart at 0.** *(Deliberate
  semantics change — ratified by Danny, 2026-07-29: a store's revision line never restarts while
  the store exists.)* Reusing rev 0 meant a writer that had loaded the
  previous generation at rev 0 came back, found rev 0 again, matched, took the fast path and wrote
  its pre-reset record straight over the fresh one — erasing an authorized wipe with a stale
  snapshot. A reset now commits as one more revision of the same store; a genuinely new store
  still opens at rev 0. Paired with a second rule, because rev arithmetic alone was not enough:
  **a rebase is only valid within one generation of the record.** A delta computed against a
  previous generation is refused (`ERATCHETSTALE`) rather than merged — otherwise the merge
  cheerfully replayed the pre-reset objective onto the new record, which is the same resurrection
  by a different route. The 0.8 assertion "a fresh state opens at rev 0" after a force reset was
  moved to its own store, where rev 0 still means what it says.

  The generation is a new state field, `gen`, minted from **CSPRNG entropy** at every
  `newState`-backed creation and every wipe — deliberately *not* a timestamp. (Scoped: the
  exported raw `saveState` can still create an absent store from a caller-supplied legacy object
  without `gen`; no shipped caller does.) It was `createdAt` for one cycle and that was a
  hole: `createdAt` comes from `nowIso`, which honours `RATCHET_NOW`, so under a frozen clock — a
  supported mode, used by hooks and by deterministic tests — both generations stamped identically,
  the check compared equal, and the wiped objective came back. Generation identity follows the
  lock owner card's precedent: identity that a supported configuration can make collide is not
  identity. A record written before `gen` existed has none, and two such records compare equal —
  the pre-0.9 boundary, named rather than papered over. *(The `gen` field completes the ratified
  reset ruling and ships under the same authority grant.)*
- **Every branch of `score confidence` is a pure derived read** *(on an initialized store)*. The
  markdown branch used to
  cache the session score back into state, so the *same* read moved bytes on one output mode
  and not the other. A read that revises the record it reports on can lose a concurrent
  write and can never be trusted as a read; the cache is removed (nothing consumed the
  stored value — confidence is derived on every call). The deliberate mutation in the score
  family is now exactly one: the fog-recording branch of `score aperture`, which is
  double-checked (cheap unlocked pre-check, authoritative re-check under the lock) so two
  concurrent scores record one fog loop, one history entry, one revision.

  The qualifier is load-bearing: `status`, `receipt`, `score confidence` and the inspection verbs
  move zero bytes **on a store that exists**. A first read of a store that does not exist yet
  performs the init transition — which is a locked, no-clobber write, deliberately, so that a
  read can never publish an empty record over a committed one. "Pure read" means "adds no
  revision to an existing record", not "never touches the filesystem".
- **A `saveState` that names no expected revision now performs an ADDITIVE rebase instead of
  an overwrite.** It takes the lock, re-reads what is actually on disk, and replays the
  caller's delta onto it. Scoped honestly, because "both keep their work" was an overclaim:
  **appends survive, and scalar edits survive where only one side moved them**; concurrent
  edits to one scalar are last-writer-wins; **concurrent deletes and reorders follow committed
  order** (the schema has no delete verb, so a removal cannot be told from a stale copy); and a
  collection carrying **duplicate ids** follows committed order wholesale for that id — never a
  field-level merge, because matching records by "the Nth row with this id" pairs unrelated
  rows the moment the committed order moves, and merging those fabricates a record that never
  existed (this record's title, that record's status). Delete/reorder preservation is parked,
  not built (see below).
- **The rebase no longer depends on object identity.** Base snapshots were remembered in a
  `WeakMap` keyed by the loaded object, so anything that copied a snapshot — a JSON round trip,
  `structuredClone`, an IPC hop — dropped the base and fell through to a blind overwrite: the
  v0.8 lost update wearing a 0.9 lock. Snapshots are now also remembered by
  `<statePath>@<rev>` in a **process-local, bounded (64-entry) cache**, and a snapshot at a
  revision nothing remembers is **refused** (`ERATCHETSTALE`) rather than written blind. Revision
  identity is safe across generations because a reset no longer reuses revision numbers and
  `gen` is checked besides; the cache is a convenience for rebasing, never the thing that
  decides whether a write is allowed.
- **`saveState` and `saveLedger` are the same door as the boundary, not softer ones.** Both now
  enforce the propose-only write guard (a propose-only agent could write canonical state through
  `saveState`), `saveLedger` takes the workspace lock (it wrote directly, so two stale ledger
  snapshots simply lost one save — note the ledger has no revision counter, so this serializes
  writes rather than rebasing them: the last writer under the lock still wins), and `saveState`
  detects a no-op: a save that would not move the record costs zero revisions, because burning a
  revision invalidates every proof bound to the current one for nothing. **This tightened what
  `rev` counts**, and the 0.8 test that asserted "increments on every write" by resaving
  unmodified snapshots was updated to earn each revision with a real change — its sequence is
  unchanged and the new no-op law is asserted beside it.
- **`initProject({ force: true })` is guarded like the CLI verb it backs.** The library entry
  point performed the irreversible wipe with no authority check, so a propose-only agent could
  reset the store by calling it directly — the CLI's guard only ever covered the CLI. A plain
  `initProject` stays open: it creates nothing that exists and wipes nothing, and a propose-only
  agent must still be able to orient.
- **`hook post-edit` writes through the boundary** like every other mutation, and is
  therefore now refused for a propose-only agent (which by contract leaves no footprint) — and
  the refusal now says *that*, instead of the generic "closure state unreadable" the hook
  catch-all used to print, which sent readers looking for corruption that was not there.
  **Whether propose-only agents' post-edit telemetry should be captured some other way is
  PARKED** (v0.8 tracked builder edits as closure evidence; v0.9 drops them) — owner Danny.
- **The propose-only write guard moved from the CLI router to the mutation boundary**
  (`src/state.js`), so it guards the door every public write comes through instead of one
  caller. Same rule, same message; the router still asks first so the error names the verb.

### What this gate does NOT claim

Named because an over-claimed guardrail is worse than none. Within **one workspace, on the
tested platform (Windows/NTFS, Node 24, local filesystem)**, v0.9 guarantees ordered mutation
and lost-update prevention for writes that go through the boundary — less the named
verify-to-rename instant in the publish fence, which is a known defect, reachable only through
an already-failed lock protocol, and stated where the fence is described. It does **not** claim:
multi-file crash atomicity (`state.json` and `ledger.json` commit separately — a crash
between them can leave an orphan ledger mirror); durability against power loss (the file is
fsynced, the containing directory is not); correctness on network filesystems, where `mkdir`
atomicity and pid liveness both stop meaning what they mean locally; protection against a
writer that bypasses the boundary (the lock is advisory — anyone who can write the store can
write the store, and a lock-bypassing writer is exactly what commit-time ownership
re-verification cannot see); authenticated human approval; or distributed transactions of any
kind.

The boundaries the reviews of this gate named explicitly:

- **Hard-linked journal aliases are not covered.** A file lock is keyed by path, and the path is
  resolved with `realpath` — which now resolves the FILE, so a symlinked log and its target share
  one lock (they did not in the first cut). A **dangling** symlink is resolved by following the
  link by hand, because `realpath` fails on one and falling back to the link's own name changed
  the lock identity the moment the target appeared — one file, two keys, both held. The hand
  resolution is bounded at **32 hops**; a longer (or cyclic) dangling chain gets a partial path
  as its key — split-lock identity past that bound is a **known defect**, kept because refusing
  outright would make a pathological chain unlockable rather than merely unshared. Two hard links
  to one inode are still two paths, so they are still two locks: keying a lock by inode is not
  buildable dependency-free. Parked, owner Danny.
- **Windows path casing is not normalized by the file lock.** `realpath` returns the spelling it
  was given on Windows, so `LOG.jsonl` and `log.jsonl` are two lock keys for one file. (The
  workspace store is unaffected — its slug is case-normalized by a `readdir` walk, which is why
  that code deliberately does not use `realpath`.) Parked, owner Danny.
- **The pid-reuse wedge.** A dead holding whose pid the OS has reused by an unrelated live process
  is never auto-broken, by policy. Operator-resolvable, and every refusal says how.
- **Merge delete/reorder preservation is parked, not built.** Committed order wins for both, as
  scoped in the rebase entry above. Building delete tracking means a delete verb and a tombstone
  in the schema — a product decision, not a defect fix. Owner Danny.
- **The ledger has no revision counter.** Its writes are serialized by the workspace lock but not
  rebased, so two concurrent ledger edits are last-writer-wins. Owner Danny.

- **Hook drift guard.** `cmdHook`'s default case returns silently by design (a hook
  must never break the session), which means a renamed or misspelled subcommand in
  `hooks/hooks.json` would no-op forever in every installed copy with no error
  anywhere. `plugin-shape` now asserts every hooks.json command is a
  `ratchet hook <sub>` invocation whose subcommand `cmdHook` actually handles, and
  that at least the three known hooks stay wired. CI-enforced (drift guard in the
  test suite); proven red against a simulated rename before landing.

- **README product thesis — verified guardrails lift cognitive load.** The README now
  states the payoff the execution framing only implied: externalized state lets the agent
  run on a smaller working set and spend its scarce attention on judgment, not bookkeeping.
  It names the precondition out loud — *a guardrail only lifts load in proportion to how
  far you can trust it without re-checking it; an unverified guardrail is a liability
  wearing the costume of relief* — and reframes the existing **no proof → no keep** /
  **wrong proof → no ship** gates as the price of being allowed to stop re-checking, not
  ceremony. Guarded against silent drift by a `plugin-shape` assertion (the thesis is
  load-bearing, so its removal fails CI like a stale version) — docs + drift guard, no
  runtime change.

- **Skill graph, derived not remembered.** The first knowledge-graph pass at this plugin's
  skills was hand-authored — a one-night snapshot with nothing tying it back to source, the
  exact liability the README names (a guardrail you trust without re-checking). Replaced with
  a generator (`scripts/graph-gen.js`, zero-dep, does not ship): it reads `skills/*/SKILL.md`
  frontmatter + `reference/PROMPTS.md` and emits deterministic Cypher to
  `reference/graph/torque-loop.cypher` (21 skill nodes, the canonical phase sequence,
  skill→prompt IMPLEMENTS edges). The load script opens with a namespace-scoped
  `DETACH DELETE` — a **delete-and-rebuild**, so a shrunk or reordered graph can never leave a
  stale node or STEP edge behind (the earlier MERGE-only reload was additive-idempotent only).
  `plugin-shape` byte-matches the committed file against a fresh generation, so a drifted graph
  fails CI like a stale version — CI-enforced (drift guard in the test suite), proven red
  against a mutated skill description before landing. The aperture mechanism cross-links from
  the first pass are **deliberately parked, not shipped**: their far endpoint is a separate
  repo and the pairings were never adversarially attacked — documented with an owner and route
  in `reference/graph/README.md` (convention 15), not smuggled in as if derived.

## [0.8.0] - 2026-07-29 — Closure Gate

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

[Unreleased]: https://github.com/Megaprompting/torque-loop/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/Megaprompting/torque-loop/compare/v0.9.0...v1.0.0
[0.9.0]: https://github.com/Megaprompting/torque-loop/compare/v0.8.0...v0.9.0
[0.8.0]: https://github.com/Megaprompting/torque-loop/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/Megaprompting/torque-loop/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/Megaprompting/torque-loop/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/Megaprompting/torque-loop/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/Megaprompting/torque-loop/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/Megaprompting/torque-loop/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/Megaprompting/torque-loop/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/Megaprompting/torque-loop/releases/tag/v0.1.0
