# MCP Step 3b: Derived Read Tools

Date: 2026-07-30  
Base: `main` at `4c4c74f`  
Branch: `codex/mcp-read-tools`

## Objective

Add three MCP read tools that expose derived Torque computations without duplicating the
canonical `state`, `ledger`, or `receipt` resources:

1. `workspace.scan`
2. `score.confidence`
3. `score.friction`

The new tools must work on both supported MCP protocol eras, must not change workspace or
store bytes after `workspace.open`, and must return the same domain results as the
corresponding CLI JSON reads.

## Contract boundary

Resources remain the only MCP representation of canonical documents:

- `torque://workspace/{workspaceHandle}/state`
- `torque://workspace/{workspaceHandle}/ledger`
- `torque://workspace/{workspaceHandle}/receipt`

Step 3b does not add `status`, `export`, or `defect list/get` tools because each would be an
existing resource under another name. It also excludes:

- `score.aperture`, because a map-required result records fog and is therefore a write;
- `doctor`, because it diagnoses the Torque installation rather than an opened workspace.

`workspace.open` remains the only tool that accepts a path. Every workspace-bound read takes
the opaque handle minted by that connection.

`workspace.open` is also the explicit initialization boundary for both canonical store
records. It already initializes state; Step 3b makes it initialize the ledger in the same
open operation. This repairs a live defect, not just a future one: `loadLedger`
creates the ledger under lock when it is missing, so the shipped `resources/read` of
`ledger` on a fresh workspace already writes bytes on first read. After Step 3b, every
read path — the three resources and the new tools — is provably pure, and the no-write
proof covers all of them. This does not make a read tool writable: `workspace.open` is
already advertised with `readOnlyHint: false`.

## Considered approaches

### Chosen: three explicit tools

Each derived operation has a stable name and its own input/output schema. This gives clients
precise discovery, keeps authority visible, and lets tests pin each calculation independently.

### Rejected: one generic read dispatcher

A `torque.read` tool with an operation enum would reduce descriptor count but weaken schema
precision and make unrelated reads share one widening contract.

### Rejected: mirror every CLI read

Mirroring `status`, `export`, and defect reads would create two wire contracts for the same
canonical data. That is drift, not capability.

## Tool contracts

### `workspace.scan`

Purpose: run the workspace cold-start poison scan immediately after `workspace.open`.

Input:

```json
{
  "workspaceHandle": "<opaque handle>"
}
```

Output is exactly the JSON value returned by `coldStart.scan(root)` and by
`ratchet doctor cold-start --json`:

```json
{
  "ok": true,
  "configured": false,
  "checks": [
    {
      "name": "objective is set",
      "level": "ok",
      "detail": ""
    }
  ]
}
```

The scan reads opt-in files named by `.ratchet/cold-start.json`. Containment does not
exist today and must be built: `resolveSurface` calls `path.resolve(cwd, surface.path)`,
so an absolute or `..` surface resolves outside the root, is read, and its matching lines
are quoted into check details. Over MCP that turns a checked-in config file into an
authority wider than the handle. Step 3b adds containment in the cold-start domain itself
(the CLI inherits it — a behavior change that ships with its own test): a surface that
resolves outside the workspace root is never opened; the scan reports it as a named
check ("surface escapes workspace root — not read") so the refusal is stated, not
silent. The tool does not accept a path.

### `score.confidence`

Purpose: derive the three independently scoped confidence layers and workflow closure for an
opened workspace.

Input:

```json
{
  "workspaceHandle": "<opaque handle>"
}
```

Output:

```json
{
  "artifact": {},
  "session": {},
  "ledger": {},
  "closure": {},
  "stateRev": 12,
  "journal": { "counted": 41, "malformed": 0 }
}
```

`artifact`, `session`, `ledger`, and `closure` must deep-equal
`ratchet score confidence --json` for the same fixture. `stateRev` is the revision of the
single state snapshot used for the computation. The implementation loads that state once,
then derives all state-backed fields from that object; it must not re-load state merely to
obtain the revision.

Journal damage is part of the result, never a side channel. The CLI reads events via
`readEvents`, whose malformed-line warning goes to stderr — a stream no MCP client sees,
so copying that path would make corrupt journal lines silently vanish from a wire read.
The tool uses `readEventsWithHealth` and names the outcome in a `journal` field:
`counted` events scored, `malformed` lines excluded. A malformed count above zero means
every count-derived number in the result is suspect, and the field says so on the wire.
An absent log is `{ "counted": 0, "malformed": 0 }` — emptiness stated, not omitted.
Equivalence tests separate `stateRev` and `journal` before comparing, as both are
MCP-only scope fields.

### `score.friction`

Purpose: rank a supplied set of obstacles without opening or touching a workspace.

Input:

```json
{
  "obstacles": [
    {
      "name": "example",
      "leverage": 8,
      "certainty": 7,
      "speed": 6,
      "risk": 9,
      "note": ""
    }
  ]
}
```

The aliases already accepted by the domain function remain valid:

- `obstacle` for `name`
- `timeToUnblock` for `speed`
- `riskOfIgnoring` for `risk`

Output is exactly `scoring.scoreFriction(obstacles)` and deep-equals
`ratchet score friction '<payload>' --json`. This tool has no handle, reads no ambient
workspace, and writes nothing.

## Authority and data flow

`src/mcp/server.js` will factor one connection-local `resolveHandle(handle)` function.
It will:

1. validate the handle shape;
2. find the handle in the current connection's `byHandle` map;
3. call `authority.use(handle, "read")`;
4. verify that the grant is still a directory grant for the recorded canonical root;
5. return the immutable workspace record.

Resource reads will parse their URI and call `resolveHandle`. `workspace.scan` and
`score.confidence` will call the same function directly. A stale, fabricated, revoked,
closed, or foreign-connection handle therefore crosses one authority check and receives the
same `-32602` refusal text. No refusal reveals whether a handle once existed.

`score.friction` bypasses handle resolution because it operates only on its explicit payload.

After resolving the Git workspace and before issuing its handle, `workspace.open` loads both
state and ledger. Its returned `stateRev` comes from that state snapshot. If either canonical
record cannot be opened or initialized, no handle is issued.

## Discovery and schemas

`tools/list` will advertise four tools in deterministic order:

1. `workspace.open`
2. `workspace.scan`
3. `score.confidence`
4. `score.friction`

The three new descriptors use:

- `readOnlyHint: true`
- `destructiveHint: false`
- `idempotentHint: true`
- `openWorldHint: false`

Every input schema rejects additional properties. Output schemas pin the public top-level
shape and the nested shapes that are stable domain contracts. The tool dispatcher selects
from the same descriptor/handler registry used to produce `tools/list`, so a listed tool
cannot silently lack an implementation and an implemented tool cannot remain undiscoverable.

Modern responses keep the existing public list cache metadata. Derived call results are not
cached by the server. Legacy responses retain their existing wire shape.

## Error handling

- Missing, non-string, malformed, stale, fabricated, revoked, closed, and
  foreign-connection handles fail with `-32602` and one non-enumerating message.
- Unknown tools continue to fail with `-32602`.
- Malformed `score.friction` arguments fail at the MCP boundary with `-32602`; domain
  normalization of individual numeric factors remains unchanged.
- A scan or confidence computation that cannot read its workspace returns a tool failure
  without exposing server paths or raw filesystem errors.
- The store-conflict refusal becomes distinguishable. Today `projectSlug` throws a plain
  `Error` on a legacy/normalized store collision, so `safeOpenError` collapses it into
  the generic "workspace state could not be opened" — the 2026-07-30 probe burned a
  diagnosis round-trip on exactly that. The throw gains a code
  (`ERATCHETSTORECONFLICT`) and `safeOpenError` maps it to one actionable sentence
  ("workspace store has conflicting project records — operator must merge or delete one")
  with no server paths. Scoped addition; strike it if it should wait.

## Verification

The implementation is acceptable only if all of these hold:

1. **No-write proof:** after `workspace.open`, byte-snapshot the state store, ledger,
   evolution log, and configured cold-start surfaces before and after every new tool AND
   every `resources/read` of state, ledger, and receipt; no byte, file set, or state
   revision changes. A fresh-workspace test separately proves that `workspace.open`
   creates both canonical records and that the first read creates nothing — run it once
   against the unpatched tree to see the ledger resource read fail it (the live defect
   this boundary repairs).
2. **CLI equivalence:** for shared fixtures, MCP structured output deep-equals the
   corresponding CLI `--json` value, with only the MCP-only scope fields
   (`score.confidence.stateRev`, `score.confidence.journal`) separated before comparison.
3. **Containment:** a fixture `.ratchet/cold-start.json` naming an escaping surface
   (absolute path and `..` form, each holding a line the scan's patterns would match)
   produces the named refusal check; the outside file's content appears nowhere in the
   result, and the scan never opens it.
4. **Journal health:** a fixture journal with planted malformed lines yields the correct
   `malformed` count on the wire; an absent journal yields `{counted: 0, malformed: 0}`.
5. **Authority refusal:** stale, fabricated, revoked, closed, and foreign-connection handles
   all return the same code and message for both resources and tools.
6. **Real wire:** drive `bin/ratchet-mcp` over stdio, open a workspace, run
   `workspace.scan`, `score.confidence`, and `score.friction`, and verify their structured
   results on both protocol eras.
7. **Regression:** `npm test`, `node bin/ratchet doctor`, and `npm run preflight` remain
   green; `tools/list` whole-object assertions pin all four advertised tools.

Mutation tests must also prove that removing the handle check, reloading state for
`stateRev`, wiring a resource-shaped duplicate, or omitting one tool from discovery causes a
failure.

## Named limit — parked, owner Danny (convention 15)

The purity proof covers the store `workspace.open` initialized. If a canonical record is
deleted or corrupted AFTER open — the server's own data directory, reachable only by an
actor with local access equal to owning the server, never through any client-supplied
authority — a later read reaches `loadState`/`loadLedger`, whose designed CLI behavior is
locked self-repair. Verification review (Codex, 2026-07-30) rated this high; the gate
ruled it a scoped decision, not a Step 3b defect: making MCP reads fail closed where the
CLI repairs would split the two surfaces' semantics over the same store, which is a
public-shape choice. Options when picked up: strict non-creating loaders for every MCP
read path (refuse with a coded error), or shared repair semantics with the repair
reported on the wire. Until then the limit is named here and in the CHANGELOG.

## Operational prerequisite outside Step 3b

Installed Torque plugins at v0.7.0 can recreate a legacy store record during session start
and trigger the known conflict refusal. Updating or removing those Claude and Codex installs
is operator work outside this repository patch. Step 3b must not weaken the store conflict
guard to accommodate stale clients.

---

Draft: Codex · Enhancement pass traced by: claude-fable-5
