# MCP Step 4c: `ledger.update` — the second single-file safe core

Date: 2026-08-01 (rev 7)
Base: `main` at `41f7bf4` (all of step 4b merged and proven; PR #37 six-of-six CI)
Branch: `feat/mcp-4c-ledger-update`
Status: RATIFIED AS AMENDED — awaiting the five-voice re-run on this rev. History:
rev 1 HOLD (D1/D2/D4 YES, D3/D5 returned) → rev 2 redesigned D3 (defect edits excluded
on BOTH doors) and D5 (open stops repairing the ledger), ratified by Danny 2026-08-01
→ five-voice pass on rev 2: DO-NOT-RATIFY, seven findings, all accepted; six patched
in rev 3 (publisher split making D2 CLI-enforceable, strict validation matrix,
open-lock ordering, `item.id` typing, cross-ring wording, landing checklist); the
seventh reopened D4 → Danny re-ruled D4 as OPTION A, hash-bound admission, folded in
as rev 4 → five-voice round 2 on rev 4: DO-NOT-RATIFY again — hash-bound admission
graded HOLDS (closed), seven new findings, ALL ACCEPTED, none touching a ratified
decision point, all patched in this rev: safe-integer revisions (2^53 + 1 stops
advancing — CAS could match forever), publisher invariant scoped to the enumerated
supported publishers within a lineage (raw exported primitives are 4b out-of-band),
complete receipt-row typing, the open zero-byte claim scoped to the post-recovery
baseline, the packaged-surface checklist gaps (CLI help, qa-ledger skill, README,
fixture truth), `ledgerRev: integer | null` typing for the v1 no-op, and
integer-only `StaleLedgerRev` → five-voice round 3 on rev 5: DO-NOT-RATIFY, nine
findings, all accepted, all patched in this rev — headline: THREE ARE LIVE IN THE
SHIPPED SAFE CORE (prototype-unsafe canonicalizer permitting false replay; UTF-16
receipt-cap predicate; unsafe-integer state revisions), recorded in the defects
section below with routing owed to Danny. Spec-side: prototype-safe + iterative
canonicalization mandated, byte-measured caps on both rings, enumerated persisted
result, matrix bound strictly below MAX_SAFE_INTEGER (exhaustion cannot exist),
box-8 baseline = post-recovery snapshot, out-of-band residual stated honestly,
fixture/CHANGELOG inventory corrected. Danny routed the shipped defects
hardening-first (PR #38 @ 8b137e4) → five-voice round 4 on rev 6: DO-NOT-RATIFY,
seven findings, all accepted — the critical one against PR #38 itself (guard on one
publisher only), completed as PR #39 (main @ 141133e: shared nextRev successor on
every publisher, safe-integer WAL parsing, one shared cap predicate, schema
maximum); spec-side this rev fixes the self-invalidating revision ceiling (bound now
≤ MAX with non-retryable LedgerRevisionExhausted on mutating commits at the
ceiling), adds non-retryable ReceiptTooLarge for deterministic receipt overflow,
qualifies every recreation claim to the gen-minting case (the same-gen raw-copy
residual is stated once and referenced, never contradicted), decides saveLedger
(PRIVATIZED; both upsert callers route through commitLedgerFamily; the publisher set
is closed), and completes the checklist dispositions (wal.js untouched-by-4c,
templates/ledger.json regenerated in 4c.2, README suite count fixed in #39). Gate
remaining: five-voice round 5 on this rev, then 4c.1.

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

- `ledgerRev` — non-negative SAFE integer (`Number.isSafeInteger`; the round-2 pass
  caught that an ordinary integer check admits 2^53, where `+ 1` silently stops
  advancing and CAS matches forever). Advanced by exactly one on every committed
  update-family write (scope defined in D2). Monotonic WITHIN a lineage: it never
  restarts while `ledgerGen` is unchanged. A wipe (`init --force`) is a lineage
  replacement — new gen, `ledgerRev: 0` — not a restart of this line. The matrix
  bound is `0 ≤ ledgerRev ≤ Number.MAX_SAFE_INTEGER` (round-4 correction: rev 6's
  strictly-below bound was SELF-INVALIDATING — it pinned `MAX - 1` as valid and
  advancing, whose successor the same matrix then rejected). The coherent semantics
  are the ones the state line ships today: a record may REACH the ceiling; at the
  ceiling, reads, replay, CAS comparison, and no-ops all still work, and a genuinely
  MUTATING commit refuses with the new non-retryable `LedgerRevisionExhausted`
  (below) — zero bytes, doctor names the condition. Fixtures pin the
  `MAX - 1 → MAX` commit succeeding and the mutation-at-`MAX` refusal. The state
  side's shared `nextRev` successor (PR #39) is the same rule, one file over.
- `ledgerGen` — minted once at ledger creation (same `newGeneration` discipline as
  state, distinct prefix so a swapped file cannot alias). Names the lineage, so a
  recreation that MINTS OR CHANGES the generation — every supported wipe and
  creation path — cannot CAS-match an old expectation at a reused numeric revision.
  Qualified deliberately (round-4 correction): a raw out-of-band write that copies
  the old gen and rev into different bytes is NOT detected by any CAS — that
  residual is stated in full in the publisher-invariant section, and no sentence in
  this spec claims otherwise.
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
  explicit spelling of "I decided against a pre-envelope (version-1) ledger" (D4) and
  then REQUIRES `expectedLedgerHash` naming the exact observed bytes. A mixed pair, a
  null pair without the hash, or a non-null pair carrying one refuses `-32602` at the
  boundary. State's `expectedStateRev`/`Gen` do not appear: this tool touches no
  state bytes, moves no state revision, and writes no state receipt.
- `operationId` — unchanged 4.1 contract (`[A-Za-z0-9_-]{22,128}`, never reused for a
  different operation).
- `argsHash` — SHA-256 over the 4.1 canonical encoding of
  `{tool, collection, item, expectedLedgerRev, expectedLedgerGen,
  expectedLedgerHash}` (the hash field normalized to `null` on version-2 writes, the
  `supersededBy` precedent). Handle and operationId excluded, for the reconnect
  reason 4.1 proved the hard way. TWO REPAIRS TO THE INHERITED ENCODER are
  prerequisites, both round-3 findings and both LIVE in the shipped 4.1 path:
  (1) the canonicalizer must be prototype-safe (`Object.create(null)` or
  equivalent) — today's `out[key] =` assignment invokes the `__proto__` setter and
  DROPS that own key, so two different JSON-parsed items hash identically and a
  retained retry falsely replays instead of refusing `OperationIdConflict`; the same
  drop bypasses the item cap. Injectivity, conflict, and cap vectors with `__proto__`
  keys join the 4.1 golden tests. (2) Canonicalization must be iterative or enforce a
  stated nesting limit at the boundary as `-32602` — a valid below-cap item of a few
  thousand nested arrays currently throws `RangeError` out of the recursive encoder
  and surfaces as `-32603`, an internal error for a malformed-input condition. A
  below-cap depth fixture pins the refusal.
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
   version-1 ledger, and then `expectedLedgerHash` must equal the hash of the exact
   loaded bytes — D4 as re-ruled). Gen mismatch, or hash mismatch on an admission
   write, → `StaleLedgerGen`, zero bytes.
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
Stated precisely (the five-voice pass corrected rev 2's "cannot detect"): the server
DOES NOT CONSULT the other retained ring — it could, under the same lock, but doing so
would couple two otherwise independent write lines for no safety gain — and no server
can police uniqueness after eviction on either line. Conflict detection is therefore
limited to retained entries in the operation's own ring; cross-ring and post-eviction
non-reuse remain the client's MUST from 4.1.

### The strict validation matrix (five-voice high finding: "strict shape" needs a schema)

"Shape validation for version 1 or version 2" is not left to the implementer's taste.
The strict family loader accepts EXACTLY one of two shapes and refuses everything
else as unprovable:

- **Version 1:** top-level keys exactly `{version, createdAt, updatedAt, features,
  tests, defects}`; `version === 1`; timestamps non-empty strings; the three
  collections arrays of plain objects. A v1 record carrying ANY lineage field —
  `ledgerRev`, `ledgerGen`, or `operations`, including a user-invented `operations`
  key — is a HYBRID and refuses: admission must never adopt fields it did not mint.
- **Version 2:** the v1 keys plus exactly `{ledgerRev, ledgerGen, operations}`;
  `version === 2`; `ledgerRev` a non-negative safe integer (a record AT
  `Number.MAX_SAFE_INTEGER` is matrix-VALID and read-servable; only a mutating
  commit atop it refuses, as `LedgerRevisionExhausted`); `ledgerGen` a non-empty
  string with the ledger prefix; `operations` an array of ≤ 32 entries, each with
  exactly the receipt keys `{id, tool, argsHash, gen, rev, at, result}`, where every
  field has ONE admissible shape (the round-2 pass caught that exact-keys without
  types lets `id: 7, tool: {}` through): `id` matching the 4.1 operationId pattern
  `[A-Za-z0-9_-]{22,128}`; `tool` the literal `"ledger.update"` (the family's only
  wire tool — a state-tool name inside the ledger ring is unprovable); `argsHash`
  matching the `sha256:` pattern; `gen` equal to the record's own `ledgerGen`; `rev`
  a positive safe integer ≤ the record's `ledgerRev`, with ring revisions UNIQUE and
  STRICTLY INCREASING in ring order; `at` a non-empty string; `result` the exact
  persisted success shape, enumerated so no two implementers disagree (round-3
  finding): `{ok: true, committed: true, replayed: false, ledgerRev, collection,
  recordId, action}` with NO additional properties — `ledgerRev` a safe integer
  equal to the entry's `rev`, `collection` in the wire enum, `action` in
  `created|updated`, `recordId` a non-empty string (a stored `replayed: true` or
  `committed: false` is unprovable: receipts persist only committed live results);
  ids UNIQUE across the ring (a duplicate refuses — replay must never depend on
  which `find` wins); each entry's size within 4 KiB measured in UTF-8 BYTES —
  `Buffer.byteLength(JSON.stringify(entry), 'utf8')`, and the SAME predicate replaces
  the two inherited writers, which today count UTF-16 code units (round-3 finding: a
  legal high-astral item id produced 2,697 code units but 5,097 bytes — the shipped
  predicate would commit a receipt this strict load must then reject, bricking the
  ledger against its own writer). Astral-character boundary fixtures on both rings.
- Missing/extra/wrong-typed keys at either level, an unknown `version`, or any
  receipt violating its row refuses `LedgerDamaged` on the write door and refuses the
  open at the open boundary; doctor names the exact failing row locally, read-only.

The matrix is the contract for the loader, the doctor, AND the fixtures: verification
box 8 enumerates one fixture per row.

Deterministic ids for created records:
`<prefix>-<sha256(expectedLedgerGen | tool | argsHash | role)[0..31]>`, with
`expectedLedgerHash` standing in for the absent gen on an admission write (D4) — the
observed bytes ARE the lineage there, so an admission retry converges on the same id
for the same observed ledger. A derived id already naming any record in the
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
| `item` | object, canonical serialization ≤ 16 KiB, refused `-32602` above cap. `item.id`, when present, MUST be a non-empty string — on BOTH doors. Today's CLI accepts any truthy id and compares with strict equality, so a numeric or object id creates a record no later string lookup can address; the tightening is a named CHANGELOG change. `recordId` in the success envelope is always a string. |

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
`action: "created" | "updated"`. `ledgerRev` is `integer | null`, and `null` is legal
in exactly one case: an uncommitted no-op against a still-version-1 ledger (a no-op
admits nothing, so there is no revision to report — emptiness stated, not omitted);
both output-schema eras pin that live result. The envelope names the revision line it
moved; `stateRev` never appears on this tool.

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

**The null pair alone names a schema state, not a lineage — so admission binds the
bytes (D4 as re-ruled by Danny, Option A).** `null/null` would match "some version-1
ledger", not THE version-1 ledger the client decided against: with the admission
receipt gone, a DIFFERENT valid v1 backup restored out-of-band would satisfy a held
null expectation — the gen-minting recreation case generations exist to refuse, on
the one record that physically has no generation. Therefore an admission write carries a third
required field:

- `expectedLedgerHash` — the SHA-256 (`sha256:` form) of the exact v1 canonical bytes
  the client observed. `workspace.open` and the ledger resource expose that hash as
  `ledgerBytesHash` whenever `ledgerGen` is null (and omit it, never null it, on
  version-2 stores — emptiness stated by the null gen itself).
- The admission CAS is "still version 1 AND still exactly these bytes". A hash
  mismatch refuses `StaleLedgerGen` with `actualLedgerGen: null` and the actual bytes
  hash (`actualLedgerHash`) so the client can re-read and re-decide.
- The envelope rule is exhaustive at the boundary: EITHER non-null rev + non-null gen
  with NO `expectedLedgerHash`, OR the null pair WITH it. Any other combination
  refuses `-32602` before the store is touched.
- `expectedLedgerHash` joins the binding hash (normalized to `null` for version-2
  writes, the `supersededBy` precedent), and the deterministic-id derivation for an
  admission write uses it in place of the absent gen — so an admission retry
  converges on the same ids for the same observed bytes.
- Honest residual, stated: a byte-identical v1 restore remains indistinguishable.
  That is acceptable by construction — the decision basis is byte-identical, which is
  the same claim every CAS makes about the record it certifies.

Verification obligations: box 3 gains "null pair + wrong hash against a different v1
fixture refuses with zero bytes"; box 4 gains "admission receipt evicted, different
valid v1 backup restored, the old admission envelope refuses; the byte-identical
restore case is pinned as accepted-by-design."

## The concurrency rule (the one D5 demanded)

**`ledgerRev` advances on committed update-family writes only: wire `ledger.update`,
CLI `ledger update`, and nothing else.** WAL mirror publishes — defect add/transition
mirrors from either door, and recovery's re-publish — change defect records and the
top-level `updatedAt` but are rev-silent, ring-silent, and gen-silent.

**"Nothing else" must be CLI-enforced, not asserted (five-voice critical finding).**
Today `state.saveLedger` is EXPORTED and publishes any supplied ledger object under
the supported lock — tests use it as a writer door and to edit `features` directly.
Left as-is, a library caller could move revision-covered records while `ledgerRev`
stays N, and a wire expectation at N would then certify a decision made against bytes
that changed unseen. Rev 3 therefore splits the publishers, convention-7 style:

- `commitLedgerFamily` — the ONLY rev-advancing door: strict load, D4 admission,
  no-op detection, `ledgerRev + 1`, optional MCP receipt; features/tests only.
- the WAL mirror publisher — private to recovery and the defect family: defects +
  top-level `updatedAt` only, rev/gen/ring-silent, exact prepared bytes.
- `saveLedger` is PRIVATIZED — decided (round-4 finding: "delegates or is
  privatized" left the publisher set unenumerated, and an invariant over an
  undecided set is not an invariant). The two production callers (both
  `ledger.upsert` branches) route through `commitLedgerFamily`; no exported
  `saveLedger` remains. Existing test call sites migrate to the classified doors;
  that churn is named in the landing checklist. The enumerated supported publisher
  set is therefore CLOSED: `commitLedgerFamily`, the private WAL mirror publisher,
  and the creation/wipe paths — nothing else.

The invariant is scoped honestly (round-2 critical finding: "no exported path" is
falsifiable — `state.js` also exports raw primitives like `writeJson`,
`writeFileAtomic`, and `ledgerPath`, and `writeJson(ledgerPath(root), obj)` publishes
anything). The rule and its test cover the ENUMERATED supported canonical publisher
APIs — the family commit, the mirror publisher, creation/wipe, and whatever
the now-privatized `saveLedger` routes into — within an unchanged `ledgerGen`. The
raw exported primitives
are out-of-band by the 4b doctrine (a raw low-level write is corruption tooling, not
a supported writer door); they cannot be made revision-aware without becoming the
thing they exist beneath. The residual is stated honestly (round-3 correction — rev 5
overclaimed here): the WAL's pre/post hashes make out-of-band interference loud ONLY
around an occupied intent. A raw write that edits a valid v2 ledger's features while
preserving gen and rev, with no intent pending, is NOT detected — the next family CAS
matches. That is the same trust boundary every canonical record in this system
already lives with; the enumerated-publisher invariant is a claim about supported
doors, not about an author with filesystem access. `initProject --force` is
classified above: lineage replacement, not a rev-silent edit. The test therefore proves: through every enumerated supported
publisher, features/tests cannot change without `ledgerRev` advancing under the same
gen — not a claim over arbitrary exported plumbing.

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

Five codes join the one safe funnel (`safeWriteError`), literal, path/errno-free.
Two are NON-RETRYABLE by declaration (round-4 finding: the inherited funnel folded
deterministic refusals into the retryable `WriteFailed`, and "retry" is a lie when an
identical retry must fail identically):

- `LedgerRevisionExhausted`: `The ledger revision line cannot advance further; run
  ratchet doctor and archive or reset the ledger before writing.` A mutating commit
  atop a record at `Number.MAX_SAFE_INTEGER`. Non-retryable; replay, no-ops, and
  reads remain available.
- `ReceiptTooLarge`: `The operation's receipt exceeds the persisted cap; shorten the
  record id or oversized fields and retry as a new operation.` Deterministic — the
  receipt echoes `recordId` (client-supplied `item.id`) and lineage fields, and a
  ~5,000-byte id stays under the 16-KiB item cap while blowing the 4-KiB receipt
  cap. Non-retryable as sent; a NEW operation with shorter fields proceeds. Both
  output-schema branches, fixtures, and CHANGELOG bullets are owed with the tool.

- `StaleLedgerRev`: structured error with `expectedLedgerRev` and `actualLedgerRev`,
  both INTEGER-ONLY (round-2 finding: the nullable branch was unreachable — a
  non-null expectation against version 1 exits as `StaleLedgerGen` first, and a null
  pair never reaches the revision check with a mismatch, so advertising `null` here
  was a branch no input could produce).
- `StaleLedgerGen`: structured error with `expectedLedgerGen` and `actualLedgerGen`
  (string or `null`); wins before the revision comparison; also the refusal a stale
  admission receives — a lost race (actual gen non-null) or a bytes mismatch
  (actual gen `null` plus `actualLedgerHash` naming what is actually on disk).
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

Ordering inside the open lock is prescribed, not implied (five-voice medium finding:
today's open loads state FIRST, so a naive strict-ledger swap would create
`state.json` and then refuse the open — a partial initialization wearing a "zero
bytes" claim). The locked sequence: recover (4b choke point, already there) →
strict-PROBE the ledger (one read distinguishing genuine absence from existing bytes;
validate existing bytes against the matrix) → REFUSE the open now if existing bytes
are unprovable, before anything initializes → initialize/load state → create the
ledger create-exclusive iff the original probe found genuine absence (and if the
create LOSES that race, strictly re-read and validate the winner's bytes before
proceeding — round-4 detail: absence observed once is not absence still) → snapshot
both records → issue the handle. The zero-byte claim is scoped precisely (round-2 finding:
recovery may legitimately COMPLETE owed work — clearing a proven intent — before the
probe runs, and that is committed 4b recovery, not this refusal's bytes): a
`LedgerDamaged` refusal produced by the strict probe moves zero canonical bytes
measured from the POST-RECOVERY baseline — the same baseline every 4b refusal is
measured from. Failures after the probe passes (state initialization I/O, authority
issuance) are ordinary open failures under their existing contracts, not covered by
this claim. Box 8 proves the scoped version.

Reads: `workspace.open`, the ledger resource, and the receipt surface expose
`ledgerRev` and `ledgerGen` (both `null` for version 1) beside the existing fields —
these are persisted canonical bytes, not derived flags, so byte-pure reads simply
report them. On a version-1 store the same surfaces additionally expose
`ledgerBytesHash` (derived from the bytes just read — a hash of what was served, not
a new persisted field), which is what an admission write echoes back as
`expectedLedgerHash`; version-2 responses omit it. `pendingIntent` semantics are unchanged from 4b. `ratchet doctor` learns
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

### Landing checklist (five-voice finding: name every surface before building)

Source: `schemas.js` (LEDGER_VERSION 2, `newLedger`, the validation matrix),
`state.js` (publisher split, strict probe, open-ordering hooks), `ledger.js` (upsert
becomes the family-commit core; defects refusal; string-id rule), `mcp/ops.js` (the
ledger envelope executor beside `executeWrite`), `mcp/server.js` (tool #19 appended in
advertised order — the roster today is exactly 18: four base + fourteen writes — plus
open changes and resource projections), `receipt.js` (ledger lineage on the one cold
read), `cli.js` (delegation + refusals + HELP TEXT — the `ledger update` line still
advertises `features|tests|defects` and must drop `defects`). `wal.js` is untouched
BY 4C and the 4c diff proves it — its safe-integer revision parsing landed in the
pre-4c hardening (PR #39), so "untouched" is a claim about this step, not about
history. `templates/ledger.json` (packaged v1 template) is REGENERATED to the
version-2 shape in 4c.2 — a template that mints the shape admission exists to
retire would be drift by packaging. Beyond src (round-2 finding — the packaged surfaces):
`skills/qa-ledger/SKILL.md` instructs the exact command D3 now refuses and must be
rewritten (which drags `reference/PROMPTS.md` and the plugin-shape sync rules with
it); README documents only the four read tools — the conditional write roster,
`ledger.update`, and the v1 `ledgerBytesHash` read surface need rows.
Tests: `cli`, `mcp-server`, `mcp-write`, `mcp-wal` (call sites migrating off raw
`saveLedger`), entry/concurrency suites, plugin-shape (skill/README sync). Fixture
truth (round-2 correction, tightened by round 3): the checked-in whole-object fixture
covers the FOUR-tool read-only roster; the 18-tool write roster is asserted as a name
array only. The read-only ROSTER stays four tools, but its fixture is NOT unchanged —
it deep-pins `workspace.open`'s complete descriptor, and 4c changes that descriptor
(`ledgerRev`, `ledgerGen`, conditional `ledgerBytesHash`), so the fixture is
REGENERATED deliberately, its diff reviewed as the read-surface contract change it
is. Separately, a full 19-tool write-roster whole-object fixture is ADDED, both
protocol eras. `src/mcp/prompts.generated.json` is regenerated too — it is derived
from `PROMPTS.md` and byte-pinned by plugin-shape.
CHANGELOG bullets owed: ledger schema v2 + lineage fields, including the safe-integer
revision bounds; the new tool and 19-tool roster; open's repair→refuse change and its
descriptor additions; CLI `ledger update defects` refusal (and the qa-ledger skill
rewrite); CLI strict load on existing bytes; identical-merge no-op (with
`ledgerRev: null` on the v1 no-op); `item.id` string tightening; `saveLedger`
classification; hash-bound admission and the public `ledgerBytesHash` /
`expectedLedgerHash` / `actualLedgerHash` contract; the complete public
success/error schema for the tool (`StaleLedgerRev` / `StaleLedgerGen` /
`LedgerDamaged` / `LedgerRevisionExhausted` / `ReceiptTooLarge` shapes, the two new
codes declared non-retryable); revision ceiling semantics; the `saveLedger`
privatization.

Notably absent from 4c, restated: no intent-schema change, no new WAL tooling, no
version bump (the release that ships 4c bumps all five fields then, not now).

### Defects surfaced in the SHIPPED safe core (rounds 3–4; RESOLVED)

Three round-3 findings are live in main today, independent of 4c — recorded here so
they cannot be silently inherited:

1. **False replay via `__proto__` (critical).** The shipped canonicalizer
   (`ops.js:46`) assigns sorted keys into a plain object, so a JSON-parsed own
   `__proto__` key invokes the setter and vanishes from the hash. Probe-confirmed:
   two different items hash identically; a retained retry on the STATE ring replays
   instead of refusing `OperationIdConflict`, and the drop also bypasses size caps.
2. **Receipt cap counts UTF-16 code units, not bytes.** Both shipped receipt writers
   use `JSON.stringify(entry).length` (`ops.js:215/293`); a legal astral-heavy
   payload passes the writer at ~2.7k units while being ~5.1k bytes.
3. **State revisions have the same unsafe-integer hole 4c closes for the ledger**
   (`state.js:1126/1163`, `ops.js:205`): `Number.isInteger` admits 2^53, where `+ 1`
   stops advancing and stale CAS matches.

RESOLVED in two rounds (Danny ruled hardening-first, 2026-08-01): PR #38 (merged @
8b137e4) shipped the prototype-safe canonicalizer, byte caps, boundary + commit
guards, and the depth cap; round 4 then proved #38's revision guard covered ONE
publisher while the mirrored WAL path, `init --force`, and WAL intent parsing still
computed `+ 1` bare — PR #39 (merged @ 141133e) completed it with the shared
`nextRev` checked successor on every publisher, safe-integer WAL parsing on both
revision fields, ONE shared byte-measured cap predicate, and the advertised schema
`maximum`. Falsifiers H1–H5 and H3b/H3c/H3d/H4b/H4c all seen red first (pre-fix tree
or mutated variant); `test/mcp-hardening.test.js` is the standing regression. The
tree 4c.1 builds on carries every repair this spec's envelope section mandates.

## Verification (acceptance, every box)

1. **Replay proofs.** The five 4.1 crash-boundary tests against the ledger line — lost
   response, crash before commit (real child-process failpoint at the rename), reconnect
   replay across a server replacement, binding conflict, eviction/reset/recreation —
   each seen red against a deliberately broken variant.
2. **One rename.** A committed write moves `ledgerRev` exactly once with its receipt in
   the same bytes; a kill at any point leaves exactly the before-bytes or the
   after-bytes; no third shape exists in any fixture.
3. **CAS.** Stale rev, stale gen, null-pair against version 2, non-null pair against
   version 1, admission hash against a DIFFERENT v1 fixture, and same-rev
   DIFFERENT-GEN recreation (round-4 rename: the gen-minting case is what CAS
   refuses; the same-gen raw-copy residual is out-of-band by the stated doctrine and
   is pinned as accepted, not refused) each refuse — or pin — with byte-snapshot
   proof of zero movement. Plus the ceiling pair: `MAX - 1 → MAX` commits;
   mutation-at-`MAX` refuses `LedgerRevisionExhausted`; an oversized deterministic
   receipt refuses `ReceiptTooLarge`; all three zero-byte.
4. **Admission.** Version-1 fixtures admit exactly once under race (two hash-bearing
   admitters, one commit, one `StaleLedgerGen`); the admitting rename carries version,
   gen, rev 1, ring, and the domain change together; CLI first-touch admits
   identically; WAL recovery over a version-1 ledger never admits. Lineage fixtures:
   admission receipt evicted then a different valid v1 backup restored → the old
   admission envelope refuses on hash; the byte-identical restore case is pinned as
   accepted-by-design with the residual named in the assertion message.
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
   with no handle issued, no `.corrupt` backup, and store contents byte-identical to
   the snapshot taken IMMEDIATELY AFTER recovery and before the probe (round-3
   correction: a pending 4b intent may legitimately publish-and-clear before the
   probe refuses — comparing against pre-open bytes would fail while the scoped
   guarantee holds; a recover-then-refuse fixture pins exactly that sequence). The
   repairing path is seen red against today's `workspace.open`.
9. **Error funnel.** Table-driven faults across every refusal cross `safeWriteError`;
   wire text matches the sentence allowlist; no path, errno, or store location leaks;
   both eras validate every structured branch against the served `outputSchema`.
10. **Regression.** `npm test`, `node bin/ratchet doctor`, `npm run preflight` green;
    `tools/list` whole-object assertions pin both rosters with `ledger.update` present
    only under `--write`.

## Decision points for ratification (owner: Danny)

On the record: rev 1 review called D1/D2/D4 YES, D3/D5 NO; Danny ratified rev 2's
redesigned D3/D5 on 2026-08-01. The five-voice pass on rev 2 returned DO-NOT-RATIFY;
its findings left D1, D3, and D5 standing, amended D2 with the publisher split (an
enforcement mechanism for the ratified rule, not a reversal), and reopened D4. Danny
re-ruled D4 as Option A (hash-bound admission) on 2026-08-01. All five calls are now
explicit again; the five-voice re-run on THIS rev is the last gate before 4c.1.

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
- **D4 — RE-RULED: Option A, hash-bound admission (Danny, 2026-08-01).** The five-
  voice pass proved the rev 2 null pair named a schema state, not a lineage (a
  different valid v1 backup restored after receipt loss would satisfy an old
  expectation). Admission now additionally binds the exact observed v1 bytes with a
  required `expectedLedgerHash`; mismatch refuses `StaleLedgerGen` with the actual
  hash. Preserves "no read ever upgrades bytes"; the byte-identical-restore residual
  is stated and accepted by construction. The rejected alternative on the record:
  open migrates healthy v1 → v2 pre-handle (reviewer-preferred ergonomics, but it
  crosses the upgrade-on-open line this design was ratified for drawing). Race-
  safety, no-migration-verb, WAL-never-admits, and replay ordering all carry over
  from the rev 2 call.
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
Rev 2 ratified by Danny 2026-08-01 (D1/D2/D4 per the rev 1 review; D3/D5 as redesigned).
Five-voice pass on rev 2: openai-codex (gpt-5.6-sol), 2026-08-01 — DO-NOT-RATIFY;
claims 1/3/5/6-core graded HOLDS; 7 findings, all accepted at the gate; the critical
finding's citations (exported `saveLedger`, test usage as a writer door) verified
against the tree before this rev.
Rev 3 patches (6 findings) traced by: claude-fable-5
D4 re-ruled by Danny 2026-08-01: Option A, hash-bound admission.
Rev 4 (D4 folded in as settled design) traced by: claude-fable-5
Five-voice round 2 on rev 4: openai-codex (gpt-5.6-sol), 2026-08-01 — DO-NOT-RATIFY;
admission fix graded HOLDS; seven findings, all accepted at the gate, none touching a
ratified decision point.
Rev 5 patches (all seven) traced by: claude-fable-5
Five-voice round 3 on rev 5: openai-codex (gpt-5.6-sol), 2026-08-01 — DO-NOT-RATIFY;
nine findings, all accepted; three are live shipped-core defects (canonicalizer
verified against ops.js:46 before this rev).
Rev 6 patches (all nine) traced by: claude-fable-5
Shipped-core routing: Danny ruled hardening-first; PR #38 landed, round 4 proved it
incomplete, PR #39 completed it (both merged, CI 6/6, falsifiers red-first).
Five-voice round 4 on rev 6: openai-codex (gpt-5.6-sol), 2026-08-01 — DO-NOT-RATIFY;
seven findings, all accepted (one critical against the shipped fix itself).
Rev 7 patches (spec-side five) traced by: claude-fable-5
Awaiting: five-voice round 5 on rev 7 → then 4c.1.
