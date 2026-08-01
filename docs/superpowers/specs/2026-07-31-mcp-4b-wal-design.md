# MCP Step 4b: the cross-file defect verbs — write-ahead intent

Date: 2026-07-31 (rev 2)
Base: `feat/mcp-write-tools` at `aa97b28` (PR #33; this design assumes the safe core merges as-is)
Branch (proposed): `feat/mcp-4b-wal`
Status: RATIFIED — D1, D2a+D2b, D3, D4 approved and D5 (park `ledger.update`) approved
by Danny, 2026-07-31, on the recommended shape. Gate pass (rev 2 vs tree): no defects.
Build order: 4b.1 begins only after PR #33 merges (no stacking on an unmerged boundary).

## Objective

Expose the deferred cross-file defect family over MCP — `defect.add`,
`defect.resolve`, `defect.reopen`, `defect.supersede` — with the same guarantee the
safe core earned for one file: a retried write can never apply twice, never claim an
outcome it does not have, and survives a server restart. These verbs write TWO canonical
files (`state.json` and `ledger.json`) that cannot commit in one rename. Step 4 deferred
them because every ordering of two renames leaves a process-death window where the files
can disagree forever with nothing scheduled to reconcile them. This spec closes that
window with one write-ahead intent and mandatory recovery before any supported writer
proceeds.

`defect.waive` stays excluded from the WIRE permanently (wire self-authorization — the
same rule as the artifact waiver arguments). The existing CLI-only waiver still writes
the same two records, so it rides the WAL internally under D2. `ledger.update` is parked
under D5; it is not a 4b tool.

### Failure model — process death, not sudden power loss

The guarantee covers process death, server restart, lost responses, and any interleaving
of supported processes on the same store. `writeFileAtomic` attempts to fsync the
temporary file before rename, but that fsync is best-effort (the current helper swallows
any fsync failure), the containing directory is never fsynced, and intent deletion
does not make directory metadata durable. Therefore 4b does NOT claim sudden-power-loss
durability: a machine or storage-device power loss may lose or reorder rename/unlink
metadata. Extending the claim requires a separate, platform-specific directory-
durability design and tests; it is not smuggled into this step by calling the slot
"durable."

## Ground truth the design stands on (read from the tree, not remembered)

- `ledger.json` lives beside `state.json` in the same store directory and answers to the
  same workspace lock. It has NO revision counter and no generation: `saveLedger` is
  serialized last-writer-wins under the lock (`src/state.js`, named in the 0.9
  CHANGELOG). The write envelope's CAS therefore binds only the state half.
- The raw `artifacts.addDefect` helper performs state → ledger → state (three renames).
  Through today's CLI mutation wrapper, both state saves defer to the outer transaction,
  so the observed order is ledger → state (two renames). The same helper therefore has
  two crash stories depending on its caller.
- The raw `artifacts.transitionDefect` helper performs state → best-effort ledger.
  Through the CLI wrapper, the state save defers, so it attempts ledger → state and
  swallows a ledger failure. A hiccup can leave either surface stale depending on the
  caller. 4b must replace these nested public saves with one prepare/publish core; it
  cannot wrap the current ordering and call that atomic.
- `ledger.upsert` refuses a hand-written defect-mirror `status` unless `via:
  'transition'` — the mirror's status is owned by state transitions. This gate survives
  on the CLI and the wire.
- `ledger.upsert`/`saveLedger` stamp `updatedAt` at write time. Calling them during
  recovery would recompute bytes and violate exact idempotence; recovery needs its own
  strict, non-stamping publisher.
- `readJsonResilient` may back up a malformed record and allow its caller to
  reinitialize. `loadLedger` may therefore return a fresh ledger over damaged canonical
  bytes. Recovery must never call either repairing path.
- Receipts live in `state.operations` and are committed in the same rename as the state
  revision (4.1): an MCP receipt exists iff the state half landed. 4b preserves that
  invariant.

## The mechanism: one strict intent slot, state decides, the mirror follows

**The state commit remains the decision.** A cross-file operation has happened when its
final `state.json` bytes publish. For MCP those bytes carry the operation receipt; for
the CLI the exact state post-image is the evidence. The ledger half is a mirror
obligation created by that decision. The intent makes the obligation survive process
death, so "state committed, mirror missing" is a recoverable lag rather than a
permanent lie.

### The slot and its schema

One file, `<store>/intent.json`, is covered by the workspace-lock fence. It is published
CREATE-EXCLUSIVE: the same create-or-fail primitive used for a first canonical record,
not an ordinary replacing rename. If a slot appears, the writer recovers or refuses; it
never overwrites it. One slot is sufficient because every supported canonical writer
holds the workspace lock and recovery runs immediately after lock acquisition.

The UTF-8 encoding of the complete intent, including its trailing newline, is capped at
64 KiB. Overflow refuses before any file is published. Version 1 has this exact logical
shape (serialization remains ordinary two-space JSON):

```json
{
  "version": 1,
  "door": "mcp",
  "operationId": "...",
  "tool": "defect.resolve",
  "argsHash": "sha256:...",
  "stateGen": "gen-...",
  "baseStateRev": 12,
  "targetStateRev": 13,
  "stateBeforeHash": "sha256:...",
  "stateAfterHash": "sha256:...",
  "ledgerBeforeHash": "sha256:...",
  "ledgerAfterHash": "sha256:...",
  "ledgerUpdatedAt": "...",
  "ledgerOps": [
    {
      "collection": "defects",
      "id": "ldef-...",
      "mode": "replace",
      "after": {
        "id": "ldef-...",
        "at": "...",
        "feature": "",
        "severity": "high",
        "summary": "the observed failure",
        "status": "resolved",
        "foundAt": "...",
        "updatedAt": "..."
      }
    }
  ],
  "at": "..."
}
```

`door` is `mcp` or `cli`. MCP uses the client operation id and deterministic ids from
the safe-core binding; CLI uses an internal WAL id and its existing CSPRNG ids. The CLI
id is diagnostic only — a repeated CLI command is made safe by recovery plus domain
no-op semantics, not by pretending a newly invoked command has the old id.

The parser accepts exactly the named keys and types, a known version/door/tool, hashes
of the exact serialized canonical bytes, `targetStateRev === baseStateRev + 1`, and a
non-empty list of unique `(collection,id)` operations. In 4b every ledger operation is
against `defects`; unknown collections, duplicate ids, unknown modes, non-object
post-images, unknown versions, invalid UTF-8/JSON, or over-cap bytes are unrecoverable.
No path is stored in the intent.

### Materialized post-images, not instructions

All ids, timestamps, state/history fields, mirror records, receipt fields, and the
ledger's top-level `updatedAt` are final BEFORE the intent is published. Hashes cover
the exact `JSON.stringify(value, null, 2) + '\n'` bytes that the normal path will
publish. A ledger op carries the complete final record:

- `insert` requires that the id is absent in the before-image and appends the post-image;
- `replace` requires exactly one record with that id and replaces it in place;
- applying all ops and `ledgerUpdatedAt` to the verified ledger before-image MUST
  reproduce `ledgerAfterHash` before any publish is attempted.

Recovery never calls `ledger.upsert`, `saveLedger`, `loadLedger`, or any loader that can
repair, create, back up, merge, or restamp. It uses strict read/shape validation and a
low-level fenced publish of the already-proved bytes. Exact after-hash means the mirror
already landed and no rewrite occurs. Repeated recovery therefore converges to the exact
crash-free bytes — there is no `updatedAt` exception.

### Protocol order, all under the workspace lock

1. **RECOVER.** Immediately after acquiring the workspace lock, resolve an occupied
   slot before the caller callback or mutation body runs.
2. **REPLAY + CAS.** MCP receipt lookup → generation → revision, in the safe-core order.
3. **PREPARE IN MEMORY.** Strictly load healthy state and ledger; run all domain gates;
   determine the mutation and legacy admission result. If the operation is a no-op,
   return now: no intent, receipt, revision, timestamp, or mirror write.
4. **MATERIALIZE + INTENT.** Mint every id/time once, build exact state and ledger
   post-images, validate both, compute the four byte hashes, enforce the cap, and publish
   `intent.json` create-exclusive.
5. **COMMIT STATE.** Publish the exact prepared `state.json`: defect/history mutation,
   `ledgerId` back-link, and MCP receipt in one rename. This is the point of no return.
6. **MIRROR.** Publish the exact prepared `ledger.json` bytes in one rename.
7. **CLEAR.** Re-check lock ownership and expected intent identity, then delete the slot.
8. **ANSWER.** Emit success only after clear. If a filesystem error follows the state
   decision, leave the intent and return/print a retryable failure; the next supported
   writer recovers before doing anything else.

The lost-response window after CLEAR is safe: MCP replays its state receipt. An exact
CLI rerun recovers first if needed, then reaches the exact-repeat no-op defined below.

### Recovery is an exact three-state machine

Recovery uses non-repairing reads for the intent, state, and ledger. It computes the
current state/ledger byte hashes and accepts only these pairs:

| Current state | Current ledger | Meaning | Recovery action |
| --- | --- | --- | --- |
| exact `stateBeforeHash` | exact `ledgerBeforeHash` | state decision did not publish | fenced clear only |
| exact `stateAfterHash` | exact `ledgerBeforeHash` | state decided; mirror is owed | reconstruct and verify ledger after-image, publish it, then fenced clear |
| exact `stateAfterHash` | exact `ledgerAfterHash` | mirror landed; clear did not | fenced clear only |

For an MCP state after-image, recovery additionally requires exactly one retained
receipt whose `id`, `tool`, `argsHash`, generation, target revision, and persisted result
shape validate against the operation. The exact state hash already binds the persisted
result bytes. The before-image was prepared only after replay/conflict checks proved
that operation id absent.

Every other observation is ambiguous and MUST preserve every byte, including the
intent: absent/unreadable/malformed/wrong-shape state or ledger; missing, duplicate, or
conflicting MCP receipts; generation/revision mismatch; a before/after hash combination
not in the table; reconstruction that misses `ledgerAfterHash`; or a corrupt/unknown
intent. It yields `MirrorUnrecoverable`. "No matching receipt" alone is never treated as
proof that nothing happened.

A crash during recovery leaves one of the same three admissible pairs because state and
ledger publishes are atomic under the stated process-death model. Recovery can therefore
restart at its first read after every kill.

### Recovery belongs to the lock, not to each caller

The enforcement point is the shared post-acquire/pre-callback workspace-lock path used
by BOTH `withWorkspaceLock` and `withWorkspaceMutation`, with an internal re-entry guard
so recovery's strict reads/publishes do not recursively recover. This covers supported
canonical writers reached through CLI and MCP, including init/reset, `saveState`,
`saveLedger`, ledger create/update, direct defect helpers, safe-core write tools, and
`workspace.open`. A nested helper joins a scope that has already recovered; it cannot
start a second protocol.

Raw low-level file writes and manual edits are out-of-band corruption, not supported
writer doors. They cannot be made to honor a process lock. The pre/post hashes ensure
they turn recovery into a loud, non-mutating `MirrorUnrecoverable` instead of silently
discarding an obligation. Consequently receipt eviction cannot outrun recovery through
any supported writer; an out-of-band state rewrite cannot counterfeit the before/after
pair.

`workspace.open` takes this same scope, recovers, then snapshots state and ledger before
issuing a handle. It is already the explicit initialization write boundary, including
on a server without the write-tool roster.

### Reads stay byte-pure and report the observation

On healthy initialized stores, ordinary resources remain byte-pure and never run WAL
recovery. The sampler itself uses non-repairing reads and never acquires a lock or
creates store bytes; the existing 3b policy for a canonical record destroyed after open
is unchanged and outside this WAL claim. The state resource, ledger resource, receipt
resource, and `workspace.open` always expose a derived top-level `pendingIntent`
boolean; it is never omitted and is never persisted in either canonical record.

For lock-free resource reads, the server samples `(state revision, intent token)` before
and after reading/assembling the resource. The revision sample is non-repairing. The
token is the SHA-256 of readable raw intent bytes, an `occupied-unreadable` sentinel, or
`absent` — never a bare existence bit. If either sample changes, it retries; if
contention prevents a stable sample, the final response is conservatively marked
`pendingIntent: true`. A stable occupied token means the returned view may contain a
lagging mirror. A stable absent token plus stable state revision gives the read a clean
linearization point without performing repair. `workspace.open` reports the value from
its locked recovery/snapshot point (normally `false`); a later writer is handled by the
existing state CAS contract.

This flag is observability, not permission to consume two resource calls as one atomic
snapshot. The public projection reserves `pendingIntent`; disk bytes never gain it.

## Contract boundary — wire roster and internal roster

| MCP tool | CLI verb | Writes |
| --- | --- | --- |
| `defect.add` | `defect add <json>` | state + ledger mirror (WAL) |
| `defect.resolve` | `defect resolve <id> --evidence` | state + mirror status (WAL) |
| `defect.reopen` | `defect reopen <id> --reason` | state + mirror status (WAL) |
| `defect.supersede` | `defect supersede <id> --by [--reason]` | state + mirror status (WAL) |

The internal CLI roster also includes `defect waive <id> --owner --reason`. It uses the
same storage protocol and recovery rules but remains absent from MCP `tools/list`, the
dispatcher, and schemas.

Semantic arguments use the 4.1 envelope unchanged; static gates travel as schema:

| Tool | Semantic arguments |
| --- | --- |
| `defect.add` | `item` object (severity/summary/artifact/feature); a terminal birth `status` refuses at the boundary, same rule as `state.append` |
| `defect.resolve` | non-empty `id`, non-empty `evidence` |
| `defect.reopen` | non-empty `id`, non-empty `reason` |
| `defect.supersede` | non-empty `id`, non-empty `by`, optional non-empty `reason` |

Success fields (common envelope + verb projection; MCP receipts persist the full
envelope):

| Tool | Additional success fields |
| --- | --- |
| `defect.add` | `defectId`, `severity`, `action: "created" \| "escalated" \| "deduped"`, `artifact` (string \| null), `attachedBy`, `ledgerId` |
| `defect.resolve` / `defect.reopen` / `defect.supersede` | `defectId`, `status`, `ledgerId` |

Excluded, restated: `defect.waive` on the wire (human risk acceptance — permanent);
`ledger create` (`workspace.open` initializes); hand-written defect-mirror `status`;
and all of `ledger.update` in 4b (parked by D5, not silently dropped).

## D2b policy: admit legacy defects on their first committed lifecycle mutation

4b does not pretend every historical defect already has a truthful mirror. On the first
committed severity escalation, resolve/reopen/supersede, or CLI-only waive of a defect
whose `ledgerId` does not name exactly one ledger defect record, the operation:

1. materializes a complete mirror from the post-transition state defect;
2. mints a new collision-checked mirror id (`deriveId` for MCP, `makeId` for CLI);
3. places that id in the SAME state post-image as the transition; and
4. inserts the mirror in the ledger post-image under the same WAL intent.

Old missing/duplicate/unlinked ledger rows are preserved; admission does not guess which
one to overwrite. A transition whose status/proof is otherwise an exact repeat may
commit once solely to perform this admission. After a valid mirror exists, the exact
repeat is a no-op. An unhealthy ledger document or a derived-id collision still refuses
before intent (`MirrorUnrecoverable` or `DeterministicIdConflict` respectively).

The mirror projection is exact, not "whatever `upsert` happens to keep":

- a new `defect.add` mirror uses `{id, at, feature, severity, summary, status, foundAt}`;
  `feature` comes from the request and `at === foundAt === defect.at`;
- an admitted legacy mirror uses the same shape, with `feature: ""`, `foundAt` from the
  original defect's `at` when present (otherwise the operation time), and `at` equal to
  the admission time; the missing historical feature is not invented;
- a valid existing mirror preserves its other fields and ordering, overwrites
  `severity`, `summary`, and `status` from the post-mutation state defect, and sets the
  record `updatedAt` to the already-materialized operation time.

In all three cases the ledger document's top-level `updatedAt` is that same recorded
time. The complete resulting record is what lands in `ledgerOps.after`.

This is admission-on-touch, not a global migration. The coherence invariant applies to
every new 4b defect and every legacy defect touched by a committed 4b lifecycle
mutation; untouched legacy defects remain explicitly outside it.

## Error and post-decision surface

Two codes join the one safe error funnel with these literal path/errno-free messages:

- `AttachmentAmbiguous`: `Several live artifacts could own this defect; provide item.artifact explicitly.`
- `MirrorUnrecoverable`: `The defect mirror cannot be read or recovered safely; run ratchet doctor and repair the reported condition before retrying.`

`AttachmentAmbiguous` is a request refusal. `MirrorUnrecoverable` is a store condition:
strict recovery cannot prove one legal state, so the attempted NEW operation does not
begin and recovery moves zero bytes. Structural corruption/ambiguity maps here; an
ordinary I/O failure before the state decision remains `WriteFailed` and is retryable.
Write tools carry the code in their structured error branch. `workspace.open`, which
has no write envelope, returns its existing tool-error shape with the same literal safe
message; the CLI may give the local diagnosis and doctor route.

An I/O failure AFTER state commit is not called a byte-pure refusal: the state decision
and intent remain. MCP returns the allowlisted retryable `WriteFailed`; retrying the exact
envelope first completes recovery, then replays the persisted receipt. CLI exits nonzero
and says locally that the state change committed and mirror recovery is pending; the
exact command may be rerun. No success is emitted until MIRROR+CLEAR finish.

`ratchet doctor` gains read-only WAL diagnosis in 4b.1. It uses the strict parser, names
locally which validation/hash/receipt condition failed, and gives a repair action; it
never auto-clears, recreates, backs up, or overwrites an ambiguous intent/ledger. Wire
messages reveal neither the local path nor the underlying errno. Any future destructive
"abandon intent" operation requires its own explicit owner/reason authority and is not
invented in 4b.

Recovery happens before a valid request's CAS/domain decision, so a request that later
refuses may follow a successful repair of an older operation. Refusal byte-purity is
therefore measured from the post-recovery baseline. Boundary/authority/schema refusals
that occur before entering the store remain byte-pure in the original absolute sense.

## Determinism, no-ops, and retry

- All MCP ids in one operation derive from one binding (roles: `record`, `history`,
  `ledger`, …). A reconnect retry converges on the same state and mirror ids.
  `DeterministicIdConflict` covers the ledger collections too. CLI ids are random but
  materialized before intent and never recomputed by recovery.
- `defect.add` dedup/escalate is evaluated before intent. Dedup with no severity
  escalation is a no-op (`committed:false`, no intent, receipt, rev, or timestamp);
  escalation commits and mirrors. A legacy unmirrored dedup remains a no-op until an
  actual escalation or transition admits it under D2b.
- An exact-repeat CLI transition with the same target status and proof fields, once its
  mirror is valid, pushes no log/history, moves no revision, and writes no intent. A
  conflicting repeat does not silently replace the original proof. This deliberately
  extends the 0.9 no-op property and changes today's CLI behavior; the implementation
  commit MUST name it in the CHANGELOG.
- The fingerprint stamp (`artifactRev`/`artifactHash`) is computed inside the locked
  prepare step from the store re-read under that lock. MCP replay returns the receipt;
  recovery uses recorded bytes and never fingerprints again.

## Internal sequence (each lands reviewed before the next)

- **4b.1 — Slot + canary.** Central recovery choke point, strict loaders, versioned
  create-exclusive intent, exact hash state machine, fenced clear, race-safe
  `pendingIntent`, read-only doctor diagnosis, and `defect.add` as the canary. Real child
  processes die at every normal and recovery window.
- **4b.2 — Transitions.** Resolve/reopen/supersede plus internal CLI waive, D2b legacy
  admission, and exact-repeat no-op behavior. This is roster, not a second mechanism.
- **4b.3 — Adversarial pass.** Two-process races, central-boundary inventory, corrupt
  intent/state/ledger matrix, lost-response retries, receipt-ring pressure, mirror-
  coherence property sweep, refusal accounting, both MCP eras, and both OS families.

`ledger.update` has no implementation step here.

## Verification (acceptance, every box)

1. **Crash matrix.** Real processes die before/after intent publish, before/after state
   publish, before/after ledger publish, before/after clear, and after clear/before
   response; recovery is separately killed before publish, after publish, and before
   clear. Every restart lands on one legal hash pair and converges.
2. **Exact bytes.** Crash-free and N-times-killed recovery finish with byte-identical
   state and ledger files, including record and top-level `updatedAt`; an after-hash
   match performs no rewrite.
3. **Central choke point.** With a pending slot, every supported canonical writer — both
   lock APIs, init/reset, saveState/saveLedger, CLI ledger/defect paths, MCP safe-core
   writes, and `workspace.open` — recovers or refuses before its callback can publish.
   A pending slot cannot be driven past receipt retention through supported boundaries.
4. **Strict recovery.** Missing, empty, malformed JSON, valid wrong-shape, duplicate-id,
   unknown-version, over-cap, ACL-denied, and injected-I/O state/ledger/intent fixtures
   preserve every byte and yield `MirrorUnrecoverable`; no corrupt backup or fresh
   ledger is created. Doctor diagnoses each locally without repair.
5. **No-op and post-decision retry.** Dedup writes no slot. Lost MCP response replays the
   receipt. Post-state mirror failure leaves the slot; exact MCP retry recovers+replays,
   and exact CLI retry recovers+no-ops with no duplicate history/log/revision. A
   conflicting CLI repeat refuses.
6. **Legacy admission.** Missing link, link to no record, and duplicate-id mirror
   fixtures mint one new complete mirror and back-link it in the same WAL operation;
   stale-but-unique mirrors are replaced exactly. Fixtures cover severity escalation
   and every status transition. Untouched old rows survive.
7. **Mirror coherence.** After any committed 4b sequence, crash, and recovery, every new
   or admitted defect's `ledgerId` names exactly one mirror whose status/severity/summary
   equal state. Property sweep includes escalation and every transition, including
   CLI-only waive.
8. **Read races.** Barrier-controlled writers pause at intent, state, ledger, and clear;
   every resource read is byte-pure, returns a stable projection or conservative
   `pendingIntent:true`, and never reports false from a mixed WAL snapshot.
9. **Errors and accounting.** Literal messages/schema enums validate in both eras, no
   path/errno leaks, `MirrorUnrecoverable` recovery moves zero bytes, and ordinary
   refusals are byte-pure from the documented post-recovery baseline.
10. **Boundary proof.** Process-death tests run on Node 18/20/22, Ubuntu and Windows.
    They do not claim to simulate sudden power loss; the file-fsync/directory-fsync
    boundary is asserted in the spec and code comments.
11. **Regression.** `npm test`, `node bin/ratchet doctor`, and `npm run preflight` green;
    every new mechanism has been seen red against a deliberately broken variant.

## Decision points for ratification (owner: Danny)

A YES accepts the recommendation as written; a NO returns that point for redesign. No
4b code exists until all five calls are explicit.

- **D1 — Hardened single slot + failure boundary.** One versioned, 64-KiB,
  create-exclusive `intent.json`; exact state/ledger pre/post hashes; strict
  non-repairing recovery at the central lock choke point; state commit decides; process/
  server-death durability only. Alternative: add ledger rev/gen and design a larger
  two-phase protocol plus power-loss primitives. **Recommended: YES.**
- **D2 — One defect protocol on both doors, including legacy admission.**
  **D2a:** CLI defect add/transitions, including wire-excluded waive, adopt the WAL;
  post-decision failures surface, and exact repeats become no-ops (named CHANGELOG
  behavior change). **D2b:** a legacy defect without exactly one valid mirror is admitted
  by minting and back-linking a complete mirror on its first committed severity
  escalation or status transition.
  Alternative: keep best-effort CLI behavior or refuse every legacy transition, leaving
  two crash stories and a migration cliff. **Recommended: YES to D2a+D2b.**
- **D3 — Race-safe `pendingIntent`.** A derived, never-persisted boolean on state/ledger/
  receipt resources and `workspace.open`, sampled with state revision + intent token;
  reads never repair. Alternative: reads recover or lock, breaking the established
  byte-purity/file-set proof. **Recommended: YES.**
- **D4 — Two explicit error classes + read-only doctor diagnosis.** Add
  `AttachmentAmbiguous` and `MirrorUnrecoverable` with the literal messages and phase
  accounting above; doctor diagnoses but never auto-repairs ambiguous canonical data.
  Alternative: fold both into `WriteFailed`, hiding whether retry or operator repair is
  required. **Recommended: YES.**
- **D5 — Park `ledger.update`.** Exclude it from 4b. It mutates the canonical ledger,
  not a state mirror; making a state receipt its decision would newly advance state
  revisions and can certify an update whose canonical record is still absent. Its
  free-form feature/test/defect contract gets a separate design with an explicit
  decision point, concurrency rule, and CLI revision semantics (owner: Danny).
  **Recommended: YES — park it.**

---

Design rev 1 traced by: claude-fable-5
Independent five-voice attack: openai-codex-gpt-5 (do-not-ratify rev 1, 2026-07-31)
Rev 2 design rulings endorsed by: claude-fable-5
Rev 2 patch traced by: openai-codex-gpt-5
Rev 2 gate pass (verified against the tree, no defects) traced by: claude-fable-5
