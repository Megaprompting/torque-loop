# MCP Step 4c: `ledger.update` — the second single-file safe core

Date: 2026-08-01 (rev 2)
Base: `main` at `41f7bf4` (all of step 4b merged and proven; PR #37 six-of-six CI)
Branch (proposed): `feat/mcp-4c-ledger-update`
Status: RATIFIED — D1, D2, D4 approved on the rev 1 review; D3 and D5 approved by
Danny AS REDESIGNED, 2026-08-01 ("the architecture now partitions ownership correctly
and closes the repairing-open hole"). Rev 1's HOLD verdict drove this rev: D3 returned
(defect edits now excluded on BOTH doors), D5 returned (the open boundary's repairing
ledger load was the unclosed wire hole), plus the two mandated coherence edits
(replay order: strict-load before ring inspection; operation-id conflict enforcement
is per receipt ring). One gate remains: the independent five-voice pass runs on this
rev before any 4c code exists.

## Objective

Ship `ledger.update` over MCP with the same two guarantees the safe core earned for the
state record: a write names the exact store lineage it decided against or it is refused,
not merged; and a retried write can never apply twice, never claim an outcome it does
not have, and survives a server restart.

The premise correction that unlocks the design: **`ledger.update` writes ONE canonical
file.** Step 4 filed it with the cross-file family only because MCP receipts live in
`state.operations`, so certifying a ledger write demanded a second rename. The 4b D5
parking rationale named the disease exactly — making a state receipt the decision would
newly advance state revisions for an operation that changes no state, and could certify
an update whose canonical record is still absent. The cure is not the WAL. The cure is
giving the ledger its own revision line, its own generation, and its own receipt ring,
committed in the ledger's own single rename — the 4.1 mechanism, pointed at the second
file. No intent slot, no recovery table, no new crash windows between files.

What 4b built is inherited, not extended: recovery already runs at the workspace-lock
choke point before any supported writer's body, so `ledger.update` begins against a
recovered store by construction. The intent schema, the three-state machine, and the
mirror-coherence invariant are untouched by this step (D2 makes that a design rule, not
an accident).

### Failure model

Identical to 4.1/4b: process death, server restart, lost responses, and any
interleaving of supported processes on the same store. No sudden-power-loss claim —
`writeFileAtomic`'s fsync is best-effort and the directory is never fsynced. One
atomic rename is the entire commit, so the 4b three-state recovery table has no
analogue here: the ledger is either the before-bytes or the after-bytes.

## Ground truth the design stands on (read from the tree, not remembered)

- `ledger.json` has no revision counter and no generation: `saveLedger` is serialized
  last-writer-wins under the workspace lock (`src/state.js`, named in the 0.9
  CHANGELOG). The 4.1 write envelope's CAS binds only the state half.
- `ledger.upsert` (`src/ledger.js`) is a shallow merge-upsert: a matching `id` merges
  fields over the existing record and restamps `updatedAt`; a missing or absent `id`
  creates. It refuses a hand-written defect-mirror `status` unless `via: 'transition'`.
- The CLI verb (`cli.js` `ledger update`) runs load → upsert → save inside ONE
  `withWorkspaceLock` hold, so a single CLI invocation's read-modify-write is already
  atomic. Lost updates exist only ACROSS invocations, where no expectation is named.
- `loadLedger` reads via `readJsonResilient` and auto-creates when absent: damaged or
  missing canonical bytes can come back as a fresh ledger. 4b banned that repairing
  path from recovery; the same ban must cover a wire write's decision basis.
- `workspace.open` itself calls that repairing `loadLedger` inside its lock hold
  (`server.js:1153-1156`), and `readJsonResilient`'s malformed branch is
  backup-then-reinitialize (`state.js` `backupCorrupt`). So today the WIRE's own
  initialization boundary can silently replace damaged ledger bytes with a fresh
  record and then issue a handle over it — the rev 1 review's D5 finding, and the hole
  this rev closes (D5 below).
- `wal.js` reconstruction is exact: before-image + `ledgerOps` + top-level
  `ledgerUpdatedAt` must reproduce `ledgerAfterHash` (`applyLedgerOps`). Version-1
  intents accept ONLY the `defects` collection. Any field a non-WAL writer adds to the
  ledger survives reconstruction untouched (deep copy of the before-image), but any
  field a WAL publish were required to CHANGE would break version 1. D2 is decided by
  this line.
- Receipts, replay, `OperationIdConflict`, `DeterministicIdConflict`, canonical-JSON
  `argsHash`, deterministic ids, the 4-KiB result cap, and the ring-eviction theorem
  are all proven mechanisms from 4.1. This spec reuses them verbatim against a second
  revision line rather than re-deriving them.

## The mechanism: the ledger becomes a first-class record

`schemas.newLedger()` moves to `LEDGER_VERSION: 2` and gains three fields beside the
existing `version/createdAt/updatedAt/features/tests/defects`:

```json
{
  "ledgerRev": 0,
  "ledgerGen": "lgen-...",
  "operations": []
}
```

- `ledgerRev` — non-negative integer, advanced by exactly one on every committed
  update-family write (scope defined in D2). Monotonic across the file's lifetime;
  never restarted by any supported writer.
- `ledgerGen` — minted once at ledger creation (same `newGeneration` discipline as
  state, distinct prefix so a swapped file cannot alias). Names the lineage, so an
  out-of-band destroy-and-recreate cannot CAS-match an old expectation at a reused
  numeric revision.
- `operations` — the receipt ring, cap 32 entries, ≤ 4 KiB serialized per entry, the
  same shape as `state.operations` (`{id, tool, argsHash, gen, rev, at, result}` with
  `gen`/`rev` naming the LEDGER lineage). Appended in the same rename that commits the
  revision: a ledger receipt exists iff the ledger write landed. The state ring is
  never consulted for a ledger operation, and vice versa — two rings, two revision
  lines, no shared namespace beyond the client's global MUST-NOT-reuse rule.

The decision point is the ledger's own rename. There is no second file, so there is no
intent, no recovery verdict, and no `pendingIntent` semantics beyond what 4b already
serves — a pending DEFECT intent still surfaces on the ledger resource exactly as
shipped, and `ledger.update` never runs while one is unresolved because central
recovery precedes every supported writer.

### The write envelope

```json
{
  "workspaceHandle": "<opaque handle>",
  "expectedLedgerRev": 7,
  "expectedLedgerGen": "lgen-...",
  "operationId": "3f2a9c81-1463-4eef-b1b0-78efad6d2aa9",
  "collection": "features",
  "item": { "...free-form record fields..." }
}
```

- `workspaceHandle` — same `resolveHandle` + `authority.use(handle, 'write')` as every
  4.1 tool; registered only on a `--write` server; one non-enumerating refusal.
- `expectedLedgerRev` / `expectedLedgerGen` — required. Either BOTH carry the values
  read from `workspace.open`/the ledger resource, or BOTH are `null`, which is the
  explicit spelling of "I decided against a pre-envelope (version-1) ledger" (D4).
  A mixed pair refuses `-32602` at the boundary. State's `expectedStateRev`/`Gen` do
  not appear: this tool touches no state bytes, moves no state revision, and writes no
  state receipt.
- `operationId` — unchanged 4.1 contract (`[A-Za-z0-9_-]{22,128}`, never reused for a
  different operation).
- `argsHash` — SHA-256 over the 4.1 canonical encoding of
  `{tool, collection, item, expectedLedgerRev, expectedLedgerGen}`. Handle and
  operationId excluded, for the reconnect reason 4.1 proved the hard way.
- `item` — free-form object, same admission the CLI upsert gives it today; this spec
  deliberately does not invent record schemas for features/tests (their shapes remain
  the documented conventions in `schemas.js` comments). The canonical serialization of
  `item` is capped at 16 KiB, refused at the boundary before any load: receipts store
  verdicts and ids, item bodies land only in the canonical ledger, and the cap keeps
  the ledger a ledger rather than a blob store.

### Replay semantics, under the workspace lock, in order

1. Central 4b recovery has already run (lock choke point). An unresolvable intent is
   `MirrorUnrecoverable` and the new operation does not begin.
2. STRICT load of the ledger: non-repairing read, fatal UTF-8 decode, shape validation
   for version 1 or version 2. Unreadable, malformed, or wrong-shape bytes refuse
   `LedgerDamaged` (below) — the resilient auto-create path is banned from this door,
   because "your ledger was damaged so I invented a fresh one and updated it" is a lie
   with a receipt. ABSENT refuses `LedgerDamaged` too, on the wire only:
   `workspace.open` already initialized this store (D5), so a missing file behind a
   live handle is out-of-band destruction, not a fresh repo. The load comes FIRST by
   necessity, not preference: the receipt ring lives inside these bytes, and a ring
   cannot be inspected before the record holding it has been proven.
3. Look up `operationId` in the loaded `ledger.operations` (version 2 only — a
   version-1 ledger has no ring, and needs none: its original attempt either committed
   the admission, making the store version 2 with the receipt inside, or left it
   version 1 and the retry applies fresh). Found with matching `argsHash` → return the
   cloned persisted result marked `replayed: true`; zero bytes move. Found with a
   different `argsHash` → `OperationIdConflict`; zero bytes move. Replay precedes CAS
   (the 4.1 order, for the 4.1 reason), and BOTH follow the strict load.
4. Lineage check: `expectedLedgerGen` against the loaded value (`null` matches only a
   version-1 ledger). Mismatch → `StaleLedgerGen`, zero bytes.
5. Revision check: `expectedLedgerRev` against `ledgerRev` (`null` matches only a
   version-1 ledger). Mismatch → `StaleLedgerRev`, zero bytes.
6. Domain: the existing `ledger.upsert` merge semantics, one implementation behind
   both doors. If the merged record equals the existing record (ignoring the
   `updatedAt` restamp), the operation is a NO-OP: `committed: false`, no revision, no
   receipt, no `updatedAt` movement, zero bytes (D5 names this behavior change).
7. Commit: one rename carrying the record change, `ledgerRev + 1`, the receipt, the
   admission stamp when D4 applies, and both `updatedAt` stamps. Success is emitted
   only after the rename returns.

Conflict enforcement is PER RECEIPT RING. A `ledger.update` operationId is checked
against `ledger.operations` only; the state ring is never consulted, and vice versa.
The server therefore cannot detect one id reused across the two lines — global
non-reuse remains the client's MUST from 4.1, stated here so nobody later reads
per-ring lookup as a server guarantee it never was.

Deterministic ids for created records:
`<prefix>-<sha256(expectedLedgerGen | tool | argsHash | role)[0..31]>`, with the
literal string `null` standing in for a pre-envelope expectation, so an admission
write's retry converges on the same id. A derived id already naming any record in the
target collection refuses `DeterministicIdConflict` before changing bytes. CLI keeps
`makeId`; its boundary has no retry.

The eviction theorem transfers whole: a receipt evicts only after ≥ 32 later family
commits, so the evicted operation's `expectedLedgerRev` is deeply stale and its retry
refuses. `ledgerGen` covers the out-of-band recreation lineage case, exactly as
`stateGen` does for state.

## Contract boundary

| MCP tool | CLI verb | Writes |
| --- | --- | --- |
| `ledger.update` | `ledger update <coll> <json>` | ledger only (own revision line, own receipts) |

Semantic arguments and gates, boundary-enforced as schema:

| Field | Wire contract |
| --- | --- |
| `collection` | enum `"features" \| "tests"` — `defects` is NOT a member (D3): after 4b the state defect family owns the mirror's `status`, `severity`, AND `summary` end-to-end (the 4b mirror projection overwrites all three from state), so a generic edit to any of them makes the mirror disagree with the record it mirrors while wearing a receipt. Permanent exclusion, same class as `defect.waive`. |
| `item` | object, canonical serialization ≤ 16 KiB, refused `-32602` above cap |

D3 binds BOTH doors. Today's CLI gate blocks only a hand-written `status`
(`ledger.js:27`) while severity and summary remain editable — a gap the rev 1 review
named: you cannot claim family ownership of the mirror and keep a side door that
rewrites two of its three owned fields. So CLI `ledger update defects <json>` refuses
outright in 4c (named CHANGELOG behavior change); the `defects` collection is
reachable only through the defect verbs on either door. The narrower status-only gate
inside `ledger.upsert` is subsumed, not deleted — it stays as the backstop beneath the
collection refusal, the same layering as `assertMayWrite` under the startup guard.

Success fields (common envelope, ledger spelling):
`{ok: true, committed, ledgerRev, replayed}` plus `collection`, `recordId`,
`action: "created" | "updated"`. The envelope names the revision line it moved;
`stateRev` never appears on this tool.

Annotations: `readOnlyHint: false`, `destructiveHint: true` (merge overwrites fields),
`idempotentHint: true`, `openWorldHint: false`.

Excluded, restated: `ledger.create` (`workspace.open` initializes — 3b ruling stands);
`defects` through `ledger update` on BOTH doors (D3); hand-written mirror `status`
(existing gate, now backstop); no waiver spelling exists in this family.

## D4 policy: legacy ledgers admit on their first committed family write

Every ledger on disk today is version 1 — no `ledgerRev`, no `ledgerGen`, no ring. The
design refuses both silent-upgrade-on-read (a read that rewrites canonical bytes would
break byte-purity and the WAL's exact-hash recovery) and a migration cliff (refusing
every wire write until an operator runs a verb).

Admission-on-touch, the D2b pattern one file over:

1. `workspace.open` and the ledger resource report `ledgerRev: null, ledgerGen: null`
   for a version-1 ledger — emptiness stated, never omitted.
2. A client that observed the null pair sends `expectedLedgerRev: null,
   expectedLedgerGen: null`. The null pair IS the CAS: it matches only while the
   ledger is still version 1. Two racing admitters — the first commits, the second
   finds a non-null lineage and refuses `StaleLedgerGen`.
3. The admitting commit carries, in its one rename: version 2, a freshly minted
   `ledgerGen`, `ledgerRev: 1`, the ring containing this operation's receipt, and the
   domain change itself.
4. The first committed CLI family write admits identically (gen minted, rev 1, empty
   ring — CLI records no receipts). WAL mirror publishes NEVER admit: recovery
   republishes proved bytes and version-1 intents know nothing of envelope fields.

New ledgers are born version 2 (`newLedger` stamps `ledgerRev: 0`, a fresh `ledgerGen`,
`operations: []`), including the `init --force` replacement path — a wiped ledger is a
NEW lineage with a new gen, which is exactly what makes a pre-wipe expectation refuse.

## The concurrency rule (the one D5 demanded)

**`ledgerRev` advances on committed update-family writes only: wire `ledger.update`,
CLI `ledger update`, and nothing else.** WAL mirror publishes — defect add/transition
mirrors from either door, and recovery's re-publish — change defect records and the
top-level `updatedAt` but are rev-silent, ring-silent, and gen-silent.

Why this is sound rather than convenient:

- NO door can address `defects` through the update family (D3), so the family's
  revision line covers every record the family can touch, exactly. A mirror moving
  underneath changes only records the family is forbidden to reach, and the commit's
  post-image is materialized from a fresh read under the same lock the mirror writer
  needs — the mirror's bytes are preserved, not clobbered. Rev 1 needed a paragraph
  defending CLI defect edits as "family"; the D3 ruling deleted the case instead of
  defending it, and the partition is now clean: update family owns features/tests and
  the rev line, defect family owns the mirror and the WAL.
- The alternative — every ledger publish advances the rev — reads cleaner and is
  wrong to build now: version-1 WAL reconstruction is before-image + ops +
  `updatedAt`, so a rev the mirror must increment breaks `ledgerAfterHash` and forces
  intent version 2 plus a re-run of the 4b crash matrix, to protect records the wire
  cannot name. That cost buys no soundness. If a later step ever needs
  rev-covers-everything, it arrives as an explicit intent-v2 design, not a side effect
  here.

Both doors' family writes and all WAL activity remain serialized under the one
workspace lock; recovery precedes every writer. There is no interleaving in which a
family write observes a half-published mirror.

## Error and read surface

Three codes join the one safe funnel (`safeWriteError`), literal, path/errno-free:

- `StaleLedgerRev`: structured error with `expectedLedgerRev` and `actualLedgerRev`
  (integer or `null`), same contract as `StaleStateRev`.
- `StaleLedgerGen`: structured error with `expectedLedgerGen` and `actualLedgerGen`
  (string or `null`); wins before the revision comparison; also the refusal a stale
  null-pair admission race receives.
- `LedgerDamaged`: `The ledger record cannot be read safely; run ratchet doctor and
  repair the reported condition before retrying.` A store condition, not a request
  refusal: the strict load could not prove healthy bytes, zero bytes moved, and no
  fresh ledger was invented. The CLI may print the local diagnosis; the wire gets the
  sentence.

`OperationIdConflict`, `DeterministicIdConflict`, and retryable `WriteFailed` carry
their 4.1 meanings against the ledger line. `MirrorUnrecoverable` keeps its 4b meaning
and can precede this tool's CAS (central recovery), so refusal byte-purity is measured
from the post-recovery baseline, exactly as 4b documented.

**The open boundary stops repairing the ledger (D5, the rev 1 hole).** Today
`workspace.open` initializes via the repairing `loadLedger`: malformed bytes are backed
up and REINITIALIZED inside the open lock, so the wire's own initialization boundary
could silently replace a damaged ledger and issue a handle over the replacement —
which `ledger.update` would then certify with receipts. In 4c, `workspace.open`'s
ledger path splits by observation: genuine ABSENCE creates fresh version-2 bytes
create-exclusive (initialization is open's job — 3b ruling stands); EXISTING bytes get
the strict loader, and unhealthy ones refuse the open with the `LedgerDamaged`
sentence through open's existing tool-error shape — no handle, no backup, no fresh
ledger, zero bytes moved. The `.corrupt` backup-then-reinit contract remains a CLI
convenience on CLI read paths; it is banned from every wire door. The state record's
resilient load at open is NOT reopened here: state carries a generation, its
reinitialization mints a new visible lineage, and the destroyed-after-open policy is
the already-parked 3b decision (owner: Danny).

Reads: `workspace.open`, the ledger resource, and the receipt surface expose
`ledgerRev` and `ledgerGen` (both `null` for version 1) beside the existing fields —
these are persisted canonical bytes, not derived flags, so byte-pure reads simply
report them. `pendingIntent` semantics are unchanged from 4b. `ratchet doctor` learns
the version-2 shape read-only: it names a malformed ring, a non-integer rev, a missing
gen, or a version/field mismatch locally and repairs nothing.

## CLI revision semantics (the second thing D5 demanded)

- No CAS flags. A single CLI invocation's read-modify-write is already atomic under
  its one lock hold; cross-invocation last-writer-wins is inherent to a stateless
  door, and a human retyping a command is not the lost-response retry the envelope
  exists for. The CLI names no expectation and records no receipt.
- Every committed CLI family write advances `ledgerRev` (and admits per D4 on first
  touch). The rev is the store's property, not MCP's.
- The CLI update path adopts the STRICT loader for bytes that EXIST: a damaged ledger
  refuses with the doctor route instead of being resiliently reborn mid-upsert. An
  ABSENT ledger keeps today's locked auto-create — the two doors differ here by rule,
  not accident: the CLI invocation is its own initialization boundary (it always has
  been, via `loadLedger`), while the wire's initialization boundary is
  `workspace.open`, so absence behind a live handle is destruction (step 3 above) but
  absence under a fresh CLI command is a fresh repo.
- The identical-merge no-op applies on both doors: no rev, no `updatedAt` restamp, no
  bytes. Both CLI changes are behavior changes and MUST be named in the CHANGELOG
  entry that ships them (the 4b exact-repeat precedent).

## Determinism, no-ops, and retry

- One binding, one meaning: retry with the same envelope replays the receipt or
  applies once; a different meaning under a retained id is `OperationIdConflict`.
- A no-op stores no receipt and no binding — the 4.1 no-op observability exception,
  restated so it cannot silently expand: lost no-op response + unchanged ledger
  repeats the no-op; lost no-op response + intervening family commit refuses stale.
- Created-record ids converge across reconnects (derivation excludes transport);
  merge-updates address the client-supplied `id` and need no minting.

## Internal sequence (each lands reviewed before the next)

- **4c.1 — The ledger envelope.** Schema version 2, strict family loader, rev/gen/ring,
  CAS, replay/conflict/eviction, deterministic ids, D4 admission, `LedgerDamaged` +
  stale codes through the funnel, doctor read-only diagnosis, the `workspace.open`
  boundary fix (create-exclusive on absence, strict refusal on unhealthy bytes — it is
  the initialization boundary, so it hardens with the mechanism, not after), and the
  wire tool on the `features` collection as canary. The five crash-boundary replay
  tests, re-run against the ledger line with real process deaths.
- **4c.2 — Roster + CLI adoption.** `tests` collection, CLI rev-advance + strict load +
  no-op + the D3 `ledger update defects` refusal (all named CHANGELOG changes),
  `workspace.open`/resource projections.
- **4c.3 — Adversarial pass.** Family-vs-WAL interleavings under the lock, admission
  races, damaged-ledger matrix, eviction/recreation lineage cases, refusal
  byte-purity, error-text allowlist, both protocol eras, both OS families.

## Verification (acceptance, every box)

1. **Replay proofs.** The five 4.1 crash-boundary tests against the ledger line — lost
   response, crash before commit (real child-process failpoint at the rename), reconnect
   replay across a server replacement, binding conflict, eviction/reset/recreation —
   each seen red against a deliberately broken variant.
2. **One rename.** A committed write moves `ledgerRev` exactly once with its receipt in
   the same bytes; a kill at any point leaves exactly the before-bytes or the
   after-bytes; no third shape exists in any fixture.
3. **CAS.** Stale rev, stale gen, null-pair against version 2, non-null pair against
   version 1, and same-rev out-of-band recreation each refuse with byte-snapshot proof
   of zero movement.
4. **Admission.** Version-1 fixtures admit exactly once under race (two null-pair
   writers, one commit, one `StaleLedgerGen`); the admitting rename carries version,
   gen, rev 1, ring, and the domain change together; CLI first-touch admits
   identically; WAL recovery over a version-1 ledger never admits.
5. **WAL coexistence.** With version-2 ledgers, the full 4b crash matrix still
   converges byte-exact (mirror publishes preserve rev/gen/ring); a family commit and
   a defect verb interleaved under the lock never lose either write; version-1 intents
   remain the only intents.
6. **D3 exclusion, both doors.** `defects` refuses at the wire boundary in both
   protocol eras AND at the CLI (`ledger update defects` refuses outright, seen red
   against today's behavior); the status-only gate still refuses beneath it; no update
   path on either door reaches the mirror collection.
7. **No-op.** Identical merge on both doors: no rev, no receipt, no restamp, zero
   bytes; the two lost-no-op outcomes pinned.
8. **Strict load.** Absent/empty/malformed/invalid-UTF-8/wrong-shape/over-cap/
   ACL-denied ledger fixtures refuse `LedgerDamaged`, create no backup and no fresh
   ledger, on wire and CLI update paths; doctor names each condition locally. The
   OPEN boundary proves the same matrix: absence creates version-2 bytes
   create-exclusive under the lock; every unhealthy-existing fixture refuses the open
   with no handle issued, no `.corrupt` backup, and byte-identical store contents —
   the repairing path seen red against today's `workspace.open`.
9. **Error funnel.** Table-driven faults across every refusal cross `safeWriteError`;
   wire text matches the sentence allowlist; no path, errno, or store location leaks;
   both eras validate every structured branch against the served `outputSchema`.
10. **Regression.** `npm test`, `node bin/ratchet doctor`, `npm run preflight` green;
    `tools/list` whole-object assertions pin both rosters with `ledger.update` present
    only under `--write`.

## Decision points for ratification (owner: Danny)

Rev 1 review calls on the record: D1 YES, D2 YES, D4 YES (with the replay-after-
strict-load ordering now written into the protocol); D3 and D5 returned NO and stand
redesigned below. A YES on this rev accepts the redesigned text; the five-voice pass
runs on this rev before any code.

- **D1 — Second single-file safe core, not a WAL tool.** The ledger becomes a
  first-class record (version 2: `ledgerRev`, `ledgerGen`, `operations` ring) and
  `ledger.update` ships the proven 4.1 envelope against the ledger's own lineage — no
  intent, no recovery table. Alternative: run it through the 4b WAL with a state
  receipt as the decision — refuted in the parking rationale (advances state revisions
  for a non-state operation, certifies before the canonical record exists); or
  hash-CAS without a revision line — leaves receipts homeless and expectations
  opaque. **Called YES on rev 1 review.**
- **D2 — Rev scope: family-only; WAL mirrors stay rev-silent.** Preserves the shipped
  WAL hash contract (intent v1, crash matrix untouched); sound because NO door reaches
  `defects` through the family (D3). Alternative: every-publish-advances, which forces
  intent v2 and a 4b re-verification to protect records the family cannot name.
  **Called YES on rev 1 review.**
- **D3 (redesigned) — generic defect edits excluded on BOTH doors, permanently.** The
  4b mirror projection owns `status`, `severity`, AND `summary`; rev 1 excluded only
  the wire while the CLI gate blocks only `status` — family ownership with a side door
  is not ownership. CLI `ledger update defects` now refuses outright (named CHANGELOG
  behavior change); the status-only gate remains as backstop. Alternative: the rev 1
  wire-only exclusion — rejected on review. **Recommended: YES as redesigned.**
- **D4 — Legacy admission by null-lineage CAS on first committed family write.** The
  null pair is an explicit, race-safe expectation; no read ever upgrades bytes; no
  migration verb; WAL never admits; replay is inspected only after the strict load
  proves the bytes and always before CAS. Alternative: a doctor migration verb
  (operator cliff) or upgrade-on-open (turns a read boundary into a silent writer).
  **Called YES on rev 1 review, ordering condition honored.**
- **D5 (redesigned) — strict loading on every door that matters, INCLUDING the open
  boundary.** Rev 1 covered the CLI (no CAS flags; rev-advance; strict load for
  existing bytes; identical-merge no-op — all kept, all named CHANGELOG changes) but
  left `workspace.open` on the repairing `loadLedger`, so the wire could open over a
  silently reborn ledger and certify updates to it. Now: open creates on genuine
  absence (create-exclusive), strictly refuses existing unhealthy bytes with
  `LedgerDamaged` and issues no handle; backup-then-reinit survives only as a CLI
  read-path convenience. Alternative: the rev 1 framing — rejected on review as an
  unclosed wire hole. **Recommended: YES as redesigned.**

---

Design rev 1 traced by: claude-fable-5
Rev 1 review (verdict HOLD — D1/D2/D4 YES, D3/D5 NO, two coherence edits): independent,
2026-08-01; both cited code findings verified against the tree before this rev.
Rev 2 redesign traced by: claude-fable-5
Ratified by Danny 2026-08-01 (D1/D2/D4 per the rev 1 review; D3/D5 as redesigned).
Awaiting: independent five-voice pass on rev 2 before any 4c code.
