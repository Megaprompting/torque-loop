# MCP Step 4: Write Tools — safe core

Date: 2026-07-31 (rev 3 — rev 2 verified and tightened after the follow-up review;
rev 1's three premise-level failures are named inline where their fixes live)
Base: `main` at `8c7d3fa`
Branch (proposed): `feat/mcp-write-tools`
Status: RATIFIED — D1–D4 approved by Danny 2026-07-31. Build in progress:
4.1 (envelope on the state.set canary + five crash-boundary replay tests) landed on
`feat/mcp-write-tools`; 4.2–4.4 follow.

## Objective

Expose the single-file (state-record) write lifecycle over MCP with the two guarantees
the ratified build order names for step 4:

1. `expectedStateRev` and `expectedStateGen` are REQUIRED on every write — a write must
   name both the revision and the store generation it decided against or it is refused,
   not merged. No exemptions: `score.aperture` writes fog, so it names both.
2. `operationId` binds to method + semantic-argument hash, `OperationIdConflict` is a
   distinct refusal, and five crash-boundary replay tests prove a retried write can never
   apply twice, never claim an outcome it does not have, and survives a server restart.

**Cross-file verbs are OUT of step 4.** `defect.add/resolve/reopen/supersede` and
`ledger.update` write two canonical files that cannot commit atomically, and rev 1's
"secondary first, receipt last" ordering could strand the pair permanently: ledger
written, process dies, the retry never comes — or arrives after another writer moved the
revision and refuses stale — and the two files disagree forever with nothing scheduled to
reconcile them. That family waits for step 4b, whose named route is a write-ahead intent
record with mandatory recovery before any writer proceeds (review approach 2). Deferring
is honest; shipping a consistency claim the crash windows contradict is not.

## Why CAS alone is not enough — the operationId rationale

`withWorkspaceMutation` already gives at-most-once semantics for a named revision: a write
that committed rev N→N+1 makes any blind retry with `expectedStateRev: N` refuse stale. So
double-apply is already impossible. What CAS cannot answer is the question a client holds
after a lost response or a server crash: **did MY write land, or did someone else's?**
Both look identical from outside — a stale refusal. For a committed operation, the
receipt answers *which*: a retry either returns the recorded outcome (yours landed) or
applies cleanly (it never did). A no-op has no durable outcome and is the explicit
observability exception described below. `expectedStateRev` gives safety; `operationId`
gives committed-write crash-boundary observability. One mechanism, not two features.

## Contract boundary — the roster

Every tool is a thin MCP boundary over the same domain mutation the CLI verb runs. One
domain implementation, two boundaries; where cli.js holds verb logic inline, it is
extracted verb-by-verb (only the verbs step 4 ships), with cli.js delegating.

| Tool | CLI verb | Writes |
| --- | --- | --- |
| `state.set` | `state set <key> <value>` | state |
| `state.append` | `state append <coll> <json>` | state |
| `open_loop.close` | `state close openLoops <id> --evidence` | state |
| `open_loop.park` | `state close openLoops <id> --park --owner --revisit-trigger` | state |
| `assumption.close` | `state close assumptions <id> --outcome --evidence` | state |
| `compile.done` | `compile done` | state |
| `artifact.add` | `artifact add <json>` | state |
| `artifact.close` | `artifact close <id>` — file-scope proof only, **no waiver arguments** | state |
| `artifact.retract` | `retract <id> --reason [--superseded-by]` | state |
| `score.aperture` | `score aperture <json>` | state (conditional fog record) |

Outer input objects are closed (`additionalProperties:false`). After removing the shared
envelope, the semantic arguments are:

| Tool | Semantic arguments |
| --- | --- |
| `state.set` | `key` (the `STATE_SCALARS` enum), `value` string; the shared domain helper applies the CLI's existing coercion |
| `state.append` | `collection` (`decisions`, `assumptions`, `openLoops`, `touchedFiles`, or `history`), `item` object |
| `open_loop.close` | non-empty `id`, non-empty `evidence` |
| `open_loop.park` | non-empty `id`, `owner`, and `revisitTrigger` |
| `assumption.close` | non-empty `id`, `outcome: "tested" \| "killed"`, non-empty `evidence` |
| `compile.done` | none |
| `artifact.add` | `item` object accepted by the existing artifact constructor; reserved lifecycle fields remain refused there |
| `artifact.close` | non-empty `id` only |
| `artifact.retract` | non-empty `id`, non-empty `reason`, optional non-empty `supersededBy` |
| `score.aperture` | required integer `ambiguity`, `terrain`, `taste`, `blastRadius`, `reversibility`, each 0..2 |

`open_loop.park.owner` assigns who carries an unresolved loop; it does not authorize a
waiver and the parked loop continues to drain confidence. That attribution field is not
treated as a human-approval token.

Gates travel to the wire as schema: a verb whose CLI refuses without a flag has that flag
as a required schema field (**MCP-boundary enforced**). Domain gates (an artifact close
needs a KEEP bound to its revision) remain domain refusals.

**Excluded, by rule:**

- `defect.waive`, `artifact.close --waive-holes`, and record-scope artifact closure —
  waivers are *human risk acceptance*, and `"owner": "Danny"` typed into a JSON field by
  a wire client is self-authorization, the same reason `reset --force` has no MCP
  spelling. MCP `artifact.close` therefore closes only file-scope artifacts with bound
  proof and no holes; record-scope or holes-waived closure stays a CLI act. Permanent
  exclusion, not a deferral.
- `init --force`, `state reset --force` — irreversible operator verbs (convention 8).
- `defect.*` (remaining four), `ledger.update` — deferred to 4b (cross-file, above).
- `ledger.create` — `workspace.open` is the initialization boundary (3b).
- `doctor` — diagnoses the installation, not an opened workspace (3b ruling stands).
- `touch` — `state.append` on `touchedFiles` is the same record; two spellings is drift.

## The write envelope

Every write tool shares one envelope alongside its verb arguments:

```json
{
  "workspaceHandle": "<opaque handle>",
  "expectedStateRev": 12,
  "expectedStateGen": "gen-mk8f4s-6cbd97f6e5b47120",
  "operationId": "3f2a9c81-1463-4eef-b1b0-78efad6d2aa9",
  "...verb arguments..."
}
```

- `workspaceHandle` — resolves through the same `resolveHandle` as every read, with
  `authority.use(handle, "write")`. One authority check, one non-enumerating refusal.
- `expectedStateRev` — required non-negative integer on every tool in the roster.
  Missing, negative, or non-integer refuses `-32602` at the boundary; the domain layer
  never sees the call.
- `expectedStateGen` — required string copied from `workspace.open.stateGen` (and visible
  in the state resource). The mutation boundary compares it under the workspace lock,
  before the revision check. A mismatch is the new coded domain error
  `ERATCHETSTALEGEN`, mapped to `StaleGeneration`, with zero bytes moved; it is not
  overloaded onto revision code `ERATCHETSTALE`.
- `operationId` — required client-generated string, `[A-Za-z0-9_-]{22,128}`. Clients MUST
  never reuse one for a different operation and SHOULD use a UUIDv4 or at least 128 bits
  of random entropy; syntax validation cannot prove entropy.

**The binding hash names the operation's meaning, not its transport.** `argsHash` =
SHA-256 over a canonical (key-sorted, deterministic) JSON encoding of
`{tool, semantic verb arguments, expectedStateRev, expectedStateGen}`.
`workspaceHandle` and `operationId` are EXCLUDED. Rev 1 hashed the full request including
the handle — a premise-level failure: handles are connection-scoped, receipts are durable
in the store, so the exact crash the receipt exists to survive (server dies, client
reconnects, new handle) made the intended retry hash differently and refuse as
`OperationIdConflict`. Binding to tool + semantic args + the client-observed revision and
generation is what makes a retry mean "the same decision about the same store," whatever
connection carries it. The server's *current* generation is not substituted into the
hash: doing that would not protect a request decided against generation A when an
out-of-band repair recreated generation B at the same numeric revision. The client must
carry the generation it observed. `expectedStateRev` stays load-bearing for eviction
safety (below); `expectedStateGen` closes generation aliasing honestly.

Canonical encoding recursively sorts object keys by Unicode code point, preserves array
order, performs no Unicode normalization, and then applies `JSON.stringify`. Inputs have
already crossed JSON-RPC, so unsupported JavaScript-only values cannot enter the hash.
Golden vectors pin nested objects, arrays, empty values, and non-ASCII strings.

## Operation receipts — durable atomically with the commit, or not at all

The crash boundary is a two-file problem: a receipt written *after* the state commit can
be lost (crash between → retry double-applies); a receipt written *before* certifies a
write that never landed. Two files cannot rename atomically. So the receipt gets no file
of its own: **committed operations record their receipt inside the state record** —
`state.operations`, a bounded ring (cap 32, oldest evicted) of

```json
{
  "id": "3f2a9c81-1463-4eef-b1b0-78efad6d2aa9",
  "tool": "artifact.add",
  "argsHash": "sha256:...",
  "gen": "gen-mk8f4s-6cbd97f6e5b47120",
  "rev": 13,
  "at": "...",
  "result": {
    "ok": true,
    "committed": true,
    "stateRev": 13,
    "replayed": false,
    "artifactId": "art-..."
  }
}
```

appended by the mutation boundary in the same `writeJson` that commits the revision. One
atomic rename carries both, so a receipt exists **iff** the write landed. The entry's key
is `id` — the operationId — so `mergeArray`'s id-based identity applies to the ring as it
does to every other collection. Schema addition to `schemas.js newState()`.

**The persisted result is the replay's answer.** A replayed call must return a
structured result conforming to the tool's declared output schema — MCP requires
structured results to conform, and "I applied it earlier" is not a conforming shape — so
the receipt stores the full success envelope. Result envelopes are fixed-shape and small
by design (verdict fields + minted ids, never document bodies); the boundary enforces a
serialized cap per entry (4 KiB) before commit and refuses an oversized result with zero
bytes moved. Tests prove every designed result fits; runtime still fails closed instead
of truncating if a future tool violates the cap.

**No-op writes record no receipt.** The 0.9 boundary property — an idempotent re-run
costs no revision — survives untouched: the receipt is appended only after the boundary's
before/after comparison says the verb moved the record. Safe because a no-op is
self-idempotent: retrying re-runs it and it no-ops again. Receipts protect the writes
whose second application would *not* be a no-op.

That is a safety claim, not durable no-op observability. If a no-op response is lost and
the state is unchanged, retry returns the same no-op result. If another write moves the
revision first, retry refuses stale; it cannot replay the lost no-op result because none
was stored. A no-op operationId is likewise not retained or server-bound (although
clients still MUST NOT intentionally reuse operationIds). Tests pin both outcomes so the
committed-write guarantee cannot silently expand to no-ops later.

**Replay semantics, under the workspace lock, in order:**

1. Look up `operationId` in the ring. Found with matching `argsHash` → return a cloned
   persisted result marked `"replayed": true`. The stored `replayed:false` bytes do not
   change; zero bytes move.
2. Found with a DIFFERENT `argsHash` → `OperationIdConflict`. Zero bytes move. One id,
   two meanings is a client defect and the server refuses to guess.
3. Not found → normal path: state-existence check, `expectedStateGen` check,
   `expectedStateRev` check, mutate, validate the result envelope, commit with receipt.

The server can enforce one-id/one-meaning only while the receipt is retained. After
eviction, a client that violates the MUST-NOT-reuse rule can present the same operationId
with a fresh revision and a different binding; the server accepts it as new because the
old binding is deliberately gone. Deterministic record ids therefore include the full
binding hash rather than operationId alone, so misuse after eviction cannot address the
old record. This is bounded idempotency-key retention, not a claim of eternal uniqueness.

**Eviction and reset are safe by the same theorem.** A receipt evicts only after ≥32
later commits, so the evicted operation's `expectedStateRev` is deeply stale and its
retry refuses. A reset wipes the ring with the record it lives in — and the revision line
CONTINUES across a wipe (`state.js:886`, deliberate: restarting revisions is exactly what
would let a pre-reset snapshot CAS-match again), so a post-reset retry lands on "not
found" and refuses stale. Monotonic revisions + ring-inside-the-record close those two
windows. A state file destroyed and recreated out-of-band can reuse a numeric revision,
so `expectedStateGen` is still required for that separate lineage case. Rev 1 was wrong
to justify generation pinning with reset; rev 3 retains the mechanism only for the case
that actually needs it.

## Deterministic ids — replay must converge on the same record

`makeId` is CSPRNG-random, so a re-applied mutation would mint different record ids on
each attempt. Every id a write tool mints derives from the operation's meaning:
`<prefix>-<sha256(expectedStateGen | tool | argsHash | role)[0..31]>`, where `role`
distinguishes multiple ids minted by one verb (a defect verb in 4b mints a defect id and
a history id from one operation). Same decision, same ids — re-application converges
instead of duplicating, and the id is stable across connections because nothing
connection-scoped is in the derivation. Thirty-two hexadecimal digits retain 128 bits of
the digest; the earlier 12-digit truncation retained only 48. CLI verbs keep `makeId`;
their boundary has no retry.

Entropy is not permission to merge. On the normal not-found path, if a server-derived id
already names any record, the mutation refuses `DeterministicIdConflict` before changing
state; it never falls through to a domain path that interprets the collision as "revise
this artifact." A legitimate retained retry left through the receipt path earlier. An
injected-collision test pins the zero-byte refusal.

## score.aperture — the read that writes, inherited from 3b

Input: the five dimensions plus the full write envelope — `expectedStateRev` and
`expectedStateGen` required like every other write. Output: the common success envelope
plus the CLI `--json` projection (`score`, `level`, `name`,
`implement`, `sequence`, `mapRequired`, `dimensions`, `scope`, `recordedFog`) plus
`stateRev`.

Rev 1 exempted aperture from CAS on the grounds that its fog write is first-racer-wins
idempotent (`fogAlreadyOnRecord`). The review broke the premise: that guard's state
legitimately changes — a fog loop closes when the unknown-map artifact lands — so an old
retry surviving receipt eviction would find the guard re-armed and record fog a second
time, a stale write wearing an idempotence claim. With `expectedStateRev` and
`expectedStateGen` required, the stale retry refuses like any other write, and the
eviction theorem covers aperture with no special case. The cost is honest and stated:
over MCP, an aperture score can refuse
stale because an unrelated write moved the revision; the client re-reads and re-scores —
the score was computed against a world that changed, and re-scoring is the correct
response, not a queue to engineer around. The CLI's lock-free double-check is a CLI
behavior and does not change. Annotations: `readOnlyHint: false`,
`destructiveHint: false`, `idempotentHint: true`.

## Authority: the --write opt-in and the agent guard

- **Write capability is declared at spawn, never inferred.** `bin/ratchet-mcp` gains a
  `--write` flag (same discipline as roots: explicit or absent, flags beat env, no
  fallback). Without it the server is what it is today — read-only, and the write tools
  are simply NOT REGISTERED, so `tools/list` stays truthful rather than advertising
  tools that refuse. With it, `workspace.open` mints its directory grant with
  `operations: ['read', 'write', 'list']` and write tools cross `resolveHandle` with
  `use(handle, 'write')`; verify-on-use (2.5) applies unchanged.
- **Propose-only agents keep their reads.** `RATCHET_AGENT` naming a propose-only role
  is compatible with a read-only server and refused with `--write`: `main.js` exits 2 at
  startup with a stderr diagnostic naming the conflict — a visible misconfiguration
  beats a per-call mystery, and `assertMayWrite` remains the backstop underneath.
  **CLI-enforced + tests proving both the refusal and the propose-only read path.**

## Discovery and schemas

- Registered write tools append to the one descriptor/handler registry in its advertised
  order; the 3b invariant (listed ⇔ implemented) extends unchanged.
- `workspace.open` adds required `stateGen` beside `stateRev`, both taken from the same
  loaded snapshot. A reconnect therefore gets a new handle but the same generation for a
  surviving store, while a recreated store names its new lineage explicitly.
- **Every write tool declares an `outputSchema`, and every structured result conforms.**
  Each schema is a root object with `oneOf` success and error branches (JSON Schema
  2020-12). Tool execution errors still set `isError: true`, but that flag does not exempt
  a supplied `structuredContent` object from the tool's schema. Protocol-level `-32602`
  responses are outside the tool result and therefore outside `outputSchema`.

The common success branch is
`{ok:true, committed:boolean, stateRev:integer, replayed:boolean}` plus the fixed verb
projection below. It contains identifiers and verdicts, never caller document bodies.

| Tool | Additional success fields |
| --- | --- |
| `state.set` | `key` |
| `state.append` | `collection`, `recordId`, `deduped` |
| `open_loop.close` | `openLoopId`, `status: "closed"` |
| `open_loop.park` | `openLoopId`, `status: "parked"` |
| `assumption.close` | `assumptionId`, `status: "tested" \| "killed"` |
| `compile.done` | `checkpointed: true`, `lastCompileAt` |
| `artifact.add` | `artifactId`, `artifactRev`, `action: "created" \| "revised" \| "unchanged"` |
| `artifact.close` | `artifactId`, `artifactRev`, `status: "closed"` |
| `artifact.retract` | `artifactId`, `status: "retracted"`, optional `supersededBy` |
| `score.aperture` | CLI JSON projection: `score`, `level`, `name`, `implement`, `sequence`, `mapRequired`, `dimensions`, `scope`, `recordedFog` |

The shared error branch is
`{ok:false, error, message, expectedStateRev?, actualStateRev?, expectedStateGen?,
actualStateGen?}` with `additionalProperties:false`; both `actual` fields admit their
normal scalar type or `null`. Each known error code pins which optional fields are
required. If no state record exists, `StateNotInitialized` wins before generation or
revision comparison and returns both actual fields as `null`. Live success, replayed
success, and every structured error are validated in tests against the exact descriptor
served on the wire.

Annotations are explicit per tool. `openWorldHint:false` and `idempotentHint:true` apply
to all ten; receipt/CAS semantics make an exact retry safe. `destructiveHint:false` is
reserved for additive writes. A status transition or overwrite is not called
non-destructive merely because provenance survives or a later build can supersede it.

| Tools | `readOnlyHint` | `destructiveHint` |
| --- | --- | --- |
| `state.append`, `score.aperture` | `false` | `false` |
| `state.set`, `open_loop.close`, `open_loop.park`, `assumption.close`, `compile.done`, `artifact.add`, `artifact.close`, `artifact.retract` | `false` | `true` |

## Error surface — one funnel

All domain errors cross ONE mapping function (the `safeOpenError` pattern, extended:
`safeWriteError`), so no verb-specific catch can leak a filesystem path, an errno, or a
store location onto the wire. A test enumerates every write path and asserts the wire
text against an allowlist of sentences.

| Condition | Where | Wire shape |
| --- | --- | --- |
| Write tool named on a flagless server | boundary | `-32602`, unknown tool (the tool is neither listed nor dispatchable) |
| Handle missing/malformed/stale/foreign on a `--write` server | boundary | `-32602`, the one non-enumerating message |
| Envelope malformed (`expectedStateRev`, `expectedStateGen`, `operationId`, verb args) | boundary | `-32602`, verb-specific message (reveals no authority) |
| State record absent | domain outcome | `isError` + conforming `{ "ok": false, "error": "StateNotInitialized", "actualStateRev": null, "actualStateGen": null, "message": "..." }` |
| Stale generation | domain outcome | `isError` + conforming `{ "ok": false, "error": "StaleGeneration", "expectedStateGen": g, "actualStateGen": h, "message": "..." }` |
| Stale revision | domain outcome | `isError` + conforming `{ "ok": false, "error": "StaleStateRev", "expectedStateRev": n, "actualStateRev": m, "message": "..." }` |
| Same operationId, different retained binding | domain outcome | `isError` + conforming `{ "ok": false, "error": "OperationIdConflict", "message": "..." }` |
| Server-derived id already names a non-identical record | domain outcome | `isError` + conforming `{ "ok": false, "error": "DeterministicIdConflict", "message": "..." }` |
| Verb refusal (unknown id, closed artifact, missing proof) | domain outcome | `isError` + conforming error branch, one mapped sentence, no server paths |

Stale and conflict are domain outcomes, not protocol violations — they ride as tool
results so clients can read the structured refusal and re-read/re-decide; `-32602` stays
what it has been since 2.2: "your request never crossed the boundary." Refusals of every
kind move zero bytes — the 3b byte-purity proof extends over every refusal path.

## Internal sequence (each lands reviewed before the next)

- **4.1 Envelope on one canary verb.** The full mutation envelope — receipts ring with
  persisted results, revision + generation CAS, binding hash, replay/conflict/eviction,
  deterministic ids, `--write` opt-in, agent startup guard, grant widening, error funnel
  — proven on `state.set` alone, with the five crash-boundary replay tests. Everything
  load-bearing ships here; every later sub-step is roster, not mechanism.
- **4.2 Session verbs.** `state.append`, `open_loop.close/park`, `assumption.close`,
  `compile.done`.
- **4.3 Artifact verbs + aperture.** `artifact.add/close/retract`, `score.aperture`.
- **4.4 Adversarial pass.** Replay races, conflict fuzzing, reconnect storms,
  reset and out-of-band recreation mid-connection, authority (write-tool names against a
  flagless server, foreign handles on every registered write tool, propose-only +
  `--write`), refusal byte-purity, error-text allowlist, both protocol eras over the real
  wire.
- **4b (separate step, WAL design first).** The defect family and `ledger.update`, with
  durable pending intents and mandatory recovery before any writer proceeds. The
  cross-file crash test lives there, where the machinery it tests exists.

## The five crash-boundary replay tests (4.1, store failpoints + process/wire harness)

1. **Lost response.** Op committed, receipt durable → verbatim retry returns the
   persisted result (`replayed: true`); revision and bytes unchanged. Run through the
   tool handler/wire with the first response deliberately discarded, in both protocol
   eras, so replay decoration and schema conformance are exercised.
2. **Crash before commit.** A child-process failpoint terminates immediately before the
   canonical rename. No receipt and no state change survive → retry applies exactly once.
   A thrown in-process exception is not accepted as proof of a process-death boundary.
3. **Reconnect replay.** Server process replaced, client reopens the workspace and holds
   a DIFFERENT handle → same `operationId` + semantic args + `expectedStateRev` +
   `expectedStateGen` returns the receipt. Proves the binding excludes the transport
   (rev 1's failure, pinned red). This case runs through the real process/wire harness;
   it is not described as a store-level simulation.
4. **Binding conflict.** Same retained `operationId`, any semantic argument, revision, or
   generation different → `OperationIdConflict`, zero bytes moved, ring unchanged.
5. **Eviction, reset, and recreation.** Receipt evicted by ≥cap later commits → verbatim
   retry refuses stale. Separately, reset wipes the ring and continues the revision line;
   out-of-band recreation is driven back to the old numeric revision with a new
   generation. The old envelope refuses in both lineage cases and never re-applies; a
   fresh `operationId` naming the current revision and generation proceeds.

## Verification (acceptance, every box)

1. **Replay proofs:** the five tests above, each seen red against a deliberately broken
   variant at least once (convention 2; red against the specific commit under test).
   No-op coverage separately proves lost response + unchanged state repeats the no-op,
   while lost response + intervening revision refuses stale and stores no binding.
2. **CLI equivalence:** each tool's committed record deep-equals the CLI verb's record
   for the same fixture (ids compared structurally where deterministic-vs-random by
   design).
3. **CAS:** stale rev, stale generation (including same-revision recreation), and
   no-record-yet each refuse with zero byte movement (byte-snapshot proof, extending the
   3b harness over every refusal path).
4. **One rev per op:** any committed write moves the revision exactly once, receipt
   included; a no-op moves nothing and records nothing.
5. **Authority:** every write tool is absent from a read-only server's `tools/list` and
   unreachable through its dispatcher; on a `--write` server, foreign/stale/revoked/
   closed handles refuse with the one message; propose-only + `--write` refuses startup.
6. **Schema conformance:** every success result — live and replayed — and every structured
   tool error validates against its declared `outputSchema`. Tests keep every designed
   success under the entry cap; a runtime overflow refuses before commit and moves zero
   bytes.
7. **Aperture:** fog recorded once under race (two writers, one record), `recordedFog`
   truthful on both outcomes, byte-pure when `mapRequired` is false, stale refusal
   proven when the revision moved between read and score.
8. **Error funnel:** a table-driven fault suite covers boundary validation, missing state,
   generation/revision CAS, receipt corruption, operation and deterministic-id conflict,
   result-cap overflow, journal failures, and every domain refusal. Each crosses
   `safeWriteError`; wire text matches the sentence allowlist; no path, errno, or store
   location appears.
9. **Real wire:** both eras over `bin/ratchet-mcp --write`: open → write → re-read shows
   the committed record; kill the server, reconnect, retry shows the receipt.
10. **Regression:** `npm test`, `node bin/ratchet doctor`, `npm run preflight` green;
    `tools/list` whole-object assertions pin both rosters (read-only and `--write`) in
    advertised order.

## Decision points for ratification (owner: Danny)

- **D1 — Safe-core roster.** The 10-tool table = step 4; the defect family and
  `ledger.update` deferred to 4b behind a WAL design; `defect.waive` and waiver
  arguments, including record-scope artifact closure, excluded permanently (wire
  self-authorization). Recommended: as specified.
- **D2 — Receipts inside the state record.** Public-shape addition (`state.operations`,
  cap 32, ≤4 KiB per entry, persisted result envelopes) plus revision-and-generation
  CAS. The alternative — a sibling receipts file — reopens the two-file atomicity hole.
  Recommended: as specified.
- **D3 — `--write` opt-in.** A server without the flag registers no write tools; with
  it, propose-only agents are refused at startup. Alternative (always-writable server,
  per-call guard) advertises capability the operator never granted. Recommended: as
  specified.
- **D4 — 4b commitment.** Deferring the cross-file family is only honest if 4b is a
  named successor with the WAL route on record, not a quiet drop. This spec is that
  record; 4b gets its own design doc before any cross-file verb ships.

---

Design rev 1 traced by: claude-fable-5
Review: independent five-voice attack + graph analysis (do-not-ship, 2026-07-31);
rev 2 rulings and safe-core rewrite traced by: claude-fable-5
Rev 3 verification and contract tightening traced by: openai-codex-gpt-5
