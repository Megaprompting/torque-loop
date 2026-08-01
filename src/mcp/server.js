'use strict';

// Torque MCP build-order step 2.4: the first public server surface.
//
// workspace.open is the ONLY method here that accepts a client pathname. It
// composes step 2.1 containment with step 2.3 Git discovery, initializes the
// Torque state record needed for its revision, and mints a step 2.2 capability
// over the canonical Git top-level. Every later read names that capability in
// a torque:// URI. A resource URI is therefore authority already established,
// never a second spelling of a path to interpret.
//
// resources/list deliberately stays empty and connection-invariant. Open
// workspaces are dynamic authority, not server-global resources: workspace.open
// returns standard resource_link blocks, while resources/templates/list
// advertises the three stable URI shapes. This keeps the 2026 list contract
// cacheable without pretending a connection's capabilities belong to everyone.
//
// Boundary named, not closed: the handle binds the name and authority facts,
// not an open filesystem descriptor. Step 2.5 owns the validation-to-read race
// and the adversarial stale-handle pass.
//
// Traced by: openai-codex-gpt-5
//
// Step 3b adds the derived read tools — workspace.scan, score.confidence,
// score.friction. They are DERIVED computations, never a second spelling of a
// canonical document: status, export and defect reads stay resources, because a
// tool that returned one would be the same record under two wire contracts.
// Every handle-bound read (resource or tool) crosses ONE authority check, and
// workspace.open is the only boundary allowed to write — it initializes both
// canonical records, so every read after it is provably byte-pure over the
// store it initialized (a record destroyed AFTER open meets the loaders'
// designed self-repair; that fail-closed-vs-repair choice is parked, see spec).
// Step 3b traced by: claude-opus-5
//
// Step 4 (safe core) adds the first write tools, registered ONLY when the
// server was launched with the write opt-in: an unflagged server does not
// advertise what the operator never granted. Every write names the revision
// AND generation it decided against (refused stale, never merged) and carries
// an operationId whose receipt — durable inside the state record itself —
// makes a crash-boundary retry return the recorded outcome instead of applying
// twice. See docs/superpowers/specs/2026-07-31-mcp-write-tools-design.md.
// Step 4 traced by: claude-fable-5

const crypto = require('crypto');
const fs = require('fs');

const handles = require('./handles');
const ledgerMod = require('../ledger');
const ops = require('./ops');
const prompts = require('./prompts');
const repository = require('./repository');
const rpc = require('./rpc');
const workspace = require('./workspace');
const artifacts = require('../artifacts');
const coldStart = require('../coldStart');
const journal = require('../evolve/journal');
const lifecycle = require('../lifecycle');
const receipt = require('../receipt');
const schemas = require('../schemas');
const scoring = require('../scoring');
const state = require('../state');
const verbs = require('../verbs');
const pkg = require('../../package.json');

const LIST_TTL_MS = 300000;
const RESOURCE_NAMES = ['state', 'ledger', 'receipt'];
const RESOURCE_MIME = 'application/json';
const RESOURCE_UNAVAILABLE = 'resource is not available on this connection';
const HANDLE_PATTERN = '[A-Za-z0-9_-]{43}';
const RESOURCE_PATTERN = new RegExp(
  `^torque://workspace/(${HANDLE_PATTERN})/(state|ledger|receipt)$`
);
const HANDLE_EXACT = new RegExp(`^${HANDLE_PATTERN}$`);
const FRICTION_ARGUMENTS =
  'score.friction takes one argument: obstacles, an array of ' +
  '{name, leverage, certainty, speed, risk, note}';
// The domain function's accepted spellings, and nothing else. A schema that says
// additionalProperties:false while the code accepts anything is a lie on the wire.
const FRICTION_FIELDS = new Set([
  'name', 'obstacle', 'leverage', 'certainty', 'speed', 'timeToUnblock', 'risk', 'riskOfIgnoring', 'note',
]);

const TOOL = Object.freeze({
  name: 'workspace.open',
  title: 'Open Torque workspace',
  description:
    'Open an allowed Git worktree and return an opaque workspace handle plus read-only Torque resource links.',
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Fully qualified path to a directory inside a configured workspace root.',
      },
    },
    required: ['path'],
    additionalProperties: false,
  },
  outputSchema: {
    type: 'object',
    properties: {
      workspaceHandle: { type: 'string' },
      repositoryId: { type: 'string' },
      worktreeId: { type: 'string' },
      stateRev: { type: 'integer' },
      // The store LINEAGE the revision counts within. A write names both: a
      // revision number alone can recur when a store is destroyed and
      // recreated out-of-band, and a generation the client did not observe is
      // a world it never decided against.
      stateGen: { type: 'string' },
      // The ledger's own lineage (4c) — persisted canonical bytes, both null
      // for a version-1 (pre-envelope) ledger: emptiness stated, not omitted.
      ledgerRev: { type: ['integer', 'null'] },
      ledgerGen: { type: ['string', 'null'] },
      // Present exactly when ledgerGen is null: the SHA-256 of the version-1
      // bytes just served, which an admission write echoes back as
      // expectedLedgerHash. Omitted (never null) on version-2 stores.
      ledgerBytesHash: { type: 'string' },
      // Derived, never persisted: whether a 4b write-ahead intent occupies the
      // slot. Open recovers under its lock first, so this is normally false.
      pendingIntent: { type: 'boolean' },
      resources: {
        type: 'object',
        properties: {
          state: { type: 'string' },
          ledger: { type: 'string' },
          receipt: { type: 'string' },
        },
        required: ['state', 'ledger', 'receipt'],
        additionalProperties: false,
      },
    },
    required: ['workspaceHandle', 'repositoryId', 'worktreeId', 'stateRev', 'stateGen', 'ledgerRev', 'ledgerGen', 'pendingIntent', 'resources'],
    additionalProperties: false,
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
});

// A derived read holds no authority of its own and moves nothing: the hints say
// so, and the tests prove the bytes agree with the hints.
const READ_ONLY = Object.freeze({
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
});

// One handle, nothing else. A tool that also accepted a path would be a second
// door into the workspace, and workspace.open is the only door there is.
const HANDLE_INPUT = Object.freeze({
  type: 'object',
  properties: {
    workspaceHandle: {
      type: 'string',
      description: 'The opaque handle workspace.open minted on this connection.',
    },
  },
  required: ['workspaceHandle'],
  additionalProperties: false,
});

const SCAN_TOOL = Object.freeze({
  name: 'workspace.scan',
  title: 'Scan an opened workspace for cold-start poison',
  description:
    'Run the Torque cold-start poison scan over an opened workspace: does the recorded state, or an opt-in project surface, steer the next session into the wrong world?',
  inputSchema: HANDLE_INPUT,
  outputSchema: {
    type: 'object',
    properties: {
      ok: { type: 'boolean' },
      configured: { type: 'boolean' },
      checks: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            level: { type: 'string', enum: ['ok', 'warn', 'fail'] },
            detail: { type: 'string' },
          },
          required: ['name', 'level', 'detail'],
          additionalProperties: false,
        },
      },
    },
    required: ['ok', 'configured', 'checks'],
    additionalProperties: false,
  },
  annotations: READ_ONLY,
});

const CONFIDENCE_TOOL = Object.freeze({
  name: 'score.confidence',
  title: 'Score confidence for an opened workspace',
  description:
    'Derive the three independently scoped confidence layers (artifact, session, ledger) and the workflow closure verdict for an opened workspace, with the state revision and journal health they were computed from.',
  inputSchema: HANDLE_INPUT,
  outputSchema: {
    type: 'object',
    properties: {
      // The layers are stable domain contracts that still grow fields, so the
      // schema pins that they are objects rather than freezing their insides.
      artifact: { type: 'object' },
      session: { type: 'object' },
      ledger: { type: 'object' },
      closure: { type: 'object' },
      stateRev: { type: 'integer' },
      journal: {
        type: 'object',
        properties: {
          counted: { type: 'integer' },
          malformed: { type: 'integer' },
        },
        required: ['counted', 'malformed'],
        additionalProperties: false,
      },
    },
    required: ['artifact', 'session', 'ledger', 'closure', 'stateRev', 'journal'],
    additionalProperties: false,
  },
  annotations: READ_ONLY,
});

const FRICTION_TOOL = Object.freeze({
  name: 'score.friction',
  title: 'Rank obstacles by friction priority',
  description:
    'Rank a supplied set of obstacles by Leverage x Certainty x Speed-to-unblock x Risk-of-ignoring and name the winner. Operates only on its payload: no workspace, no handle, no ambient read.',
  inputSchema: {
    type: 'object',
    properties: {
      obstacles: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            obstacle: { type: 'string', description: 'Alias for name.' },
            leverage: { type: 'number' },
            certainty: { type: 'number' },
            speed: { type: 'number' },
            timeToUnblock: { type: 'number', description: 'Alias for speed.' },
            risk: { type: 'number' },
            riskOfIgnoring: { type: 'number', description: 'Alias for risk.' },
            note: { type: 'string' },
          },
          additionalProperties: false,
        },
      },
    },
    required: ['obstacles'],
    additionalProperties: false,
  },
  outputSchema: {
    type: 'object',
    properties: {
      obstacles: { type: 'array', items: { type: 'object' } },
      winner: { type: ['object', 'null'] },
      runnerUp: { type: ['object', 'null'] },
      // number, not integer: factors are clamped, never rounded, so decimal
      // input makes priority — and the margin between two of them — fractional.
      margin: { type: ['number', 'null'] },
      scope: { type: 'string' },
    },
    required: ['obstacles', 'winner', 'runnerUp', 'margin', 'scope'],
    additionalProperties: false,
  },
  annotations: READ_ONLY,
});

// The shared write envelope: every write names the workspace by handle, the
// revision AND generation it decided against, and its own retry key. The
// operationId's floor of 22 chars fits a UUID's entropy in base64url; syntax
// cannot prove entropy, so the descriptor says MUST-NOT-reuse out loud.
const OPERATION_ID = /^[A-Za-z0-9_-]{22,128}$/;

const WRITE_ENVELOPE_PROPS = Object.freeze({
  workspaceHandle: {
    type: 'string',
    description: 'The opaque handle workspace.open minted on this connection.',
  },
  expectedStateRev: {
    type: 'integer',
    minimum: 0,
    // The advertised bound matches the runtime check: past 2^53 - 1 a revision
    // cannot be one a client honestly read, and the boundary refuses it.
    maximum: 9007199254740991,
    description: 'The state revision this write was decided against, from workspace.open or the state resource. A mismatch refuses; nothing is merged.',
  },
  expectedStateGen: {
    type: 'string',
    description: 'The store generation the revision was observed in, from workspace.open.stateGen. Pins the lineage a recreated store cannot fake.',
  },
  operationId: {
    type: 'string',
    pattern: OPERATION_ID.source,
    description: 'Client-generated retry key (UUIDv4 or >=128 bits of entropy). Retry the SAME operation with the same id; never reuse one for a different operation.',
  },
});
const WRITE_ENVELOPE_KEYS = Object.freeze(Object.keys(WRITE_ENVELOPE_PROPS));

// One error branch for every write refusal that crosses as a tool result.
// isError does not exempt structuredContent from the declared schema, so the
// refusals conform too.
const WRITE_ERROR_BRANCH = Object.freeze({
  type: 'object',
  properties: {
    ok: { const: false },
    error: {
      enum: [
        'StateNotInitialized',
        'StaleGeneration',
        'StaleStateRev',
        'OperationIdConflict',
        'DeterministicIdConflict',
        'UnknownRecordId',
        'ArtifactClosed',
        'ClosureBlocked',
        'HumanAuthorityRequired',
        'RetractRefused',
        'AttachmentAmbiguous',
        'MirrorUnrecoverable',
        'WriteFailed',
      ],
    },
    message: { type: 'string' },
    expectedStateRev: { type: ['integer', 'null'] },
    actualStateRev: { type: ['integer', 'null'] },
    expectedStateGen: { type: ['string', 'null'] },
    actualStateGen: { type: ['string', 'null'] },
  },
  required: ['ok', 'error', 'message'],
  additionalProperties: false,
});

function writeSuccessBranch(verbProps) {
  return {
    type: 'object',
    properties: Object.assign({
      ok: { const: true },
      committed: { type: 'boolean' },
      stateRev: { type: 'integer' },
      replayed: { type: 'boolean' },
    }, verbProps),
    required: ['ok', 'committed', 'stateRev', 'replayed', ...Object.keys(verbProps)],
    additionalProperties: false,
  };
}

const STATE_SET_USAGE =
  'state.set requires exactly: workspaceHandle, expectedStateRev, expectedStateGen, operationId, key, value';

const STATE_SET_TOOL = Object.freeze({
  name: 'state.set',
  title: 'Set one Torque session-state scalar',
  description:
    'Set one settable session-state scalar (title, objective, bottleneck, phase, nextAction, nextCommand, confidence) on an opened workspace. CAS-bound: refuses unless expectedStateRev and expectedStateGen match the record, and replays the recorded outcome when the same operationId retries the same operation.',
  inputSchema: {
    type: 'object',
    properties: Object.assign({}, WRITE_ENVELOPE_PROPS, {
      key: { type: 'string', enum: [...schemas.STATE_SCALARS] },
      value: { type: 'string', description: 'The value to record; confidence coerces to a number, everything else stays text.' },
    }),
    required: [...WRITE_ENVELOPE_KEYS, 'key', 'value'],
    additionalProperties: false,
  },
  outputSchema: {
    oneOf: [
      writeSuccessBranch({ key: { type: 'string', enum: [...schemas.STATE_SCALARS] } }),
      WRITE_ERROR_BRANCH,
    ],
  },
  annotations: {
    readOnlyHint: false,
    // Setting a scalar overwrites the previous value; provenance in history
    // does not make an overwrite additive.
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
});

// A status transition or an overwrite is destructive; only genuinely additive
// writes get destructiveHint:false. Provenance surviving in history does not
// make an overwrite additive.
const WRITE_DESTRUCTIVE = Object.freeze({
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: false,
});

// The appendable collections: STATE_COLLECTIONS minus the two whose gated
// constructors a raw append would bypass — that is how a "closed" artifact or
// a "resolved" defect gets minted with no transition behind it.
const APPENDABLE = Object.freeze(
  Object.keys(schemas.STATE_COLLECTIONS).filter((name) => name !== 'artifacts' && name !== 'defects')
);

const STATE_APPEND_USAGE =
  'state.append requires exactly: workspaceHandle, expectedStateRev, expectedStateGen, operationId, collection, item (an object)';

const STATE_APPEND_TOOL = Object.freeze({
  name: 'state.append',
  title: 'Append one record to a Torque session collection',
  description:
    'Append one record to a session-state collection (decisions, assumptions, openLoops, touchedFiles, history) on an opened workspace. Assumptions and open loops are born in their birth status — never closed, tested, or killed — and dedup by text against the live record. Artifacts and defects are not appendable: their constructors are gated (artifact.add, the CLI defect verbs). CAS-bound like every write.',
  inputSchema: {
    type: 'object',
    properties: Object.assign({}, WRITE_ENVELOPE_PROPS, {
      collection: { type: 'string', enum: [...APPENDABLE] },
      item: {
        type: 'object',
        description: 'The record to append. A status field on assumptions/openLoops may only claim the birth status; ids are minted deterministically when absent.',
      },
    }),
    required: [...WRITE_ENVELOPE_KEYS, 'collection', 'item'],
    additionalProperties: false,
  },
  outputSchema: {
    oneOf: [
      writeSuccessBranch({
        collection: { type: 'string', enum: [...APPENDABLE] },
        recordId: { type: 'string' },
        deduped: { type: 'boolean' },
      }),
      WRITE_ERROR_BRANCH,
    ],
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
});

const OPEN_LOOP_CLOSE_USAGE =
  'open_loop.close requires exactly: workspaceHandle, expectedStateRev, expectedStateGen, operationId, id, evidence (non-empty strings)';

const OPEN_LOOP_CLOSE_TOOL = Object.freeze({
  name: 'open_loop.close',
  title: 'Close an open loop with evidence',
  description:
    'Close one open loop on an opened workspace with the evidence that actually closed it — no proof, no close. CAS-bound like every write.',
  inputSchema: {
    type: 'object',
    properties: Object.assign({}, WRITE_ENVELOPE_PROPS, {
      id: { type: 'string', minLength: 1 },
      evidence: { type: 'string', minLength: 1, description: 'What actually closed the loop.' },
    }),
    required: [...WRITE_ENVELOPE_KEYS, 'id', 'evidence'],
    additionalProperties: false,
  },
  outputSchema: {
    oneOf: [
      writeSuccessBranch({ openLoopId: { type: 'string' }, status: { const: 'closed' } }),
      WRITE_ERROR_BRANCH,
    ],
  },
  annotations: WRITE_DESTRUCTIVE,
});

const OPEN_LOOP_PARK_USAGE =
  'open_loop.park requires exactly: workspaceHandle, expectedStateRev, expectedStateGen, operationId, id, owner, revisitTrigger (non-empty strings)';

const OPEN_LOOP_PARK_TOOL = Object.freeze({
  name: 'open_loop.park',
  title: 'Park an open loop with an owner and a revisit trigger',
  description:
    'Park one open loop on an opened workspace. Parking stops the nagging but the loop still drains confidence: the owner is attribution for an unanswered question, never a waiver or an approval token. CAS-bound like every write.',
  inputSchema: {
    type: 'object',
    properties: Object.assign({}, WRITE_ENVELOPE_PROPS, {
      id: { type: 'string', minLength: 1 },
      owner: { type: 'string', minLength: 1, description: 'Who carries the parked loop. Attribution, not authorization.' },
      revisitTrigger: { type: 'string', minLength: 1, description: 'What brings the loop back — a park with no trigger is a drop.' },
    }),
    required: [...WRITE_ENVELOPE_KEYS, 'id', 'owner', 'revisitTrigger'],
    additionalProperties: false,
  },
  outputSchema: {
    oneOf: [
      writeSuccessBranch({ openLoopId: { type: 'string' }, status: { const: 'parked' } }),
      WRITE_ERROR_BRANCH,
    ],
  },
  annotations: WRITE_DESTRUCTIVE,
});

const ASSUMPTION_CLOSE_USAGE =
  'assumption.close requires exactly: workspaceHandle, expectedStateRev, expectedStateGen, operationId, id, outcome (tested|killed), evidence (non-empty)';

const ASSUMPTION_CLOSE_TOOL = Object.freeze({
  name: 'assumption.close',
  title: 'Close an assumption as tested or killed',
  description:
    'Close one assumption on an opened workspace with the result that settled it — an assumption ends proven or dead, never merely dropped. CAS-bound like every write.',
  inputSchema: {
    type: 'object',
    properties: Object.assign({}, WRITE_ENVELOPE_PROPS, {
      id: { type: 'string', minLength: 1 },
      outcome: { type: 'string', enum: ['tested', 'killed'] },
      evidence: { type: 'string', minLength: 1, description: 'The result that settled it.' },
    }),
    required: [...WRITE_ENVELOPE_KEYS, 'id', 'outcome', 'evidence'],
    additionalProperties: false,
  },
  outputSchema: {
    oneOf: [
      writeSuccessBranch({ assumptionId: { type: 'string' }, status: { enum: ['tested', 'killed'] } }),
      WRITE_ERROR_BRANCH,
    ],
  },
  annotations: WRITE_DESTRUCTIVE,
});

const COMPILE_DONE_USAGE =
  'compile.done requires exactly: workspaceHandle, expectedStateRev, expectedStateGen, operationId';

const COMPILE_DONE_TOOL = Object.freeze({
  name: 'compile.done',
  title: 'Checkpoint the Torque session state',
  description:
    'Mark the session state CHECKPOINTED on an opened workspace: clear dirty and stamp lastCompileAt in one move. A checkpoint says the record is current, never that the work is finished. CAS-bound like every write.',
  inputSchema: {
    type: 'object',
    properties: Object.assign({}, WRITE_ENVELOPE_PROPS),
    required: [...WRITE_ENVELOPE_KEYS],
    additionalProperties: false,
  },
  outputSchema: {
    oneOf: [
      writeSuccessBranch({ checkpointed: { const: true }, lastCompileAt: { type: 'string' } }),
      WRITE_ERROR_BRANCH,
    ],
  },
  annotations: WRITE_DESTRUCTIVE,
});

const ARTIFACT_ADD_USAGE =
  'artifact.add requires exactly: workspaceHandle, expectedStateRev, expectedStateGen, operationId, item (an object)';

const ARTIFACT_ADD_TOOL = Object.freeze({
  name: 'artifact.add',
  title: 'Record or revise a Torque artifact',
  description:
    'Record an artifact ({title, kind, path, holes, revises}) on an opened workspace, or revise the one an existing id names. Terminal statuses and lifecycle fields are never accepted as input — they are earned by gated verbs (artifact.close, artifact.retract). An identical revision is a no-op: no revision bump, no proof invalidated. CAS-bound like every write.',
  inputSchema: {
    type: 'object',
    properties: Object.assign({}, WRITE_ENVELOPE_PROPS, {
      item: {
        type: 'object',
        description: 'The artifact payload. An existing id revises that artifact; kind is immutable; a probe is born with its disposal hole.',
      },
    }),
    required: [...WRITE_ENVELOPE_KEYS, 'item'],
    additionalProperties: false,
  },
  outputSchema: {
    oneOf: [
      writeSuccessBranch({
        artifactId: { type: 'string' },
        artifactRev: { type: 'integer' },
        action: { type: 'string', enum: ['created', 'revised', 'unchanged'] },
      }),
      WRITE_ERROR_BRANCH,
    ],
  },
  // A revision overwrites the mutable fields and invalidates proof bound to
  // the previous revision — not additive.
  annotations: WRITE_DESTRUCTIVE,
});

const ARTIFACT_CLOSE_USAGE =
  'artifact.close requires exactly: workspaceHandle, expectedStateRev, expectedStateGen, operationId, id (non-empty)';

const ARTIFACT_CLOSE_TOOL = Object.freeze({
  name: 'artifact.close',
  title: 'Close an artifact against its bound proof',
  description:
    'Close one artifact on an opened workspace — only when a KEEP proof is bound to this exact revision and hash, no open defects are attached, and no holes remain. There are no waiver arguments on this wire: record-scope proof and holes-waived closure require named human authorization and stay CLI acts. A second close of a certified artifact is a no-op. CAS-bound like every write.',
  inputSchema: {
    type: 'object',
    properties: Object.assign({}, WRITE_ENVELOPE_PROPS, {
      id: { type: 'string', minLength: 1 },
    }),
    required: [...WRITE_ENVELOPE_KEYS, 'id'],
    additionalProperties: false,
  },
  outputSchema: {
    oneOf: [
      writeSuccessBranch({
        artifactId: { type: 'string' },
        artifactRev: { type: 'integer' },
        status: { const: 'closed' },
      }),
      WRITE_ERROR_BRANCH,
    ],
  },
  annotations: WRITE_DESTRUCTIVE,
});

const ARTIFACT_RETRACT_USAGE =
  'artifact.retract requires exactly: workspaceHandle, expectedStateRev, expectedStateGen, operationId, id, reason (non-empty), optionally supersededBy (non-empty)';

const ARTIFACT_RETRACT_TOOL = Object.freeze({
  name: 'artifact.retract',
  title: 'Retract an artifact whose claim is false or obsolete',
  description:
    'Retract one artifact on an opened workspace, keeping the record for provenance. Never silent: a reason is required, and a probe exit must state its outcome — reason starts "disposed:" (code reverted, finding recorded) or "promoted:" with supersededBy naming the recorded build-for-keep that replaced it. CAS-bound like every write.',
  inputSchema: {
    type: 'object',
    properties: Object.assign({}, WRITE_ENVELOPE_PROPS, {
      id: { type: 'string', minLength: 1 },
      reason: { type: 'string', minLength: 1, description: 'Why the claim is false or obsolete. Probe exits start with "disposed:" or "promoted:".' },
      supersededBy: { type: 'string', minLength: 1, description: 'The artifact that replaced this one. Required when a probe is promoted.' },
    }),
    required: [...WRITE_ENVELOPE_KEYS, 'id', 'reason'],
    additionalProperties: false,
  },
  outputSchema: {
    oneOf: [
      writeSuccessBranch({
        artifactId: { type: 'string' },
        status: { const: 'retracted' },
        supersededBy: { type: ['string', 'null'] },
      }),
      WRITE_ERROR_BRANCH,
    ],
  },
  annotations: WRITE_DESTRUCTIVE,
});

const APERTURE_DIMENSION_KEYS = Object.freeze(['ambiguity', 'terrain', 'taste', 'blastRadius', 'reversibility']);

const SCORE_APERTURE_USAGE =
  'score.aperture requires exactly: workspaceHandle, expectedStateRev, expectedStateGen, operationId, ambiguity, terrain, taste, blastRadius, reversibility (each an integer 0-2)';

function apertureDimensionProps() {
  const props = {};
  for (const key of APERTURE_DIMENSION_KEYS) {
    props[key] = { type: 'integer', minimum: 0, maximum: 2 };
  }
  return props;
}

const SCORE_APERTURE_TOOL = Object.freeze({
  name: 'score.aperture',
  title: 'Meter loop depth from uncertainty',
  description:
    'Score the five uncertainty dimensions (each 0-2) into an aperture level A0-A4 with the ratchet sequence to run at that depth. The read that writes: when mapRequired fires and no fog is on the record yet, the fog is serialized as an open loop in the same transaction — so this names the revision and generation it decided against like every write. A stale refusal means the world moved; re-read and re-score.',
  inputSchema: {
    type: 'object',
    properties: Object.assign({}, WRITE_ENVELOPE_PROPS, apertureDimensionProps()),
    required: [...WRITE_ENVELOPE_KEYS, ...APERTURE_DIMENSION_KEYS],
    additionalProperties: false,
  },
  outputSchema: {
    oneOf: [
      writeSuccessBranch({
        score: { type: 'integer', minimum: 0, maximum: 10 },
        level: { type: 'string', enum: ['A0', 'A1', 'A2', 'A3', 'A4'] },
        name: { type: 'string' },
        implement: { type: 'boolean' },
        sequence: { type: 'array', items: { type: 'string' } },
        mapRequired: { type: 'boolean' },
        dimensions: {
          type: 'object',
          properties: apertureDimensionProps(),
          required: [...APERTURE_DIMENSION_KEYS],
          additionalProperties: false,
        },
        scope: { type: 'string' },
        recordedFog: { type: 'boolean' },
      }),
      WRITE_ERROR_BRANCH,
    ],
  },
  annotations: {
    readOnlyHint: false,
    // The only write it performs is additive: one fog loop, first racer wins.
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
});

const DEFECT_ADD_USAGE =
  'defect.add requires exactly: workspaceHandle, expectedStateRev, expectedStateGen, operationId, item (an object)';

const DEFECT_ADD_TOOL = Object.freeze({
  name: 'defect.add',
  title: 'Record a defect with its ledger mirror',
  description:
    'Record one defect on an opened workspace — the first cross-file verb: the state record and its QA-ledger mirror commit behind one write-ahead intent, so a server death between the two files is a recoverable lag, never a permanent disagreement. A repeat of an open finding dedups as a no-op; a worse repeat escalates the severity in place. Terminal birth statuses refuse at the boundary; waivers stay CLI acts. With several live artifacts, item.artifact must name the one this defect attacks. CAS-bound like every write.',
  inputSchema: {
    type: 'object',
    properties: Object.assign({}, WRITE_ENVELOPE_PROPS, {
      item: {
        type: 'object',
        description: 'The defect payload ({severity, summary, artifact, feature}). Severity defaults to medium; unknown severities coerce to medium.',
      },
    }),
    required: [...WRITE_ENVELOPE_KEYS, 'item'],
    additionalProperties: false,
  },
  outputSchema: {
    oneOf: [
      writeSuccessBranch({
        defectId: { type: 'string' },
        severity: { type: 'string', enum: [...schemas.SEVERITIES] },
        action: { type: 'string', enum: ['created', 'escalated', 'deduped'] },
        artifact: { type: ['string', 'null'] },
        attachedBy: { type: 'string' },
        ledgerId: { type: ['string', 'null'] },
      }),
      WRITE_ERROR_BRANCH,
    ],
  },
  // An escalation overwrites the recorded severity in place — not additive.
  annotations: WRITE_DESTRUCTIVE,
});

// The three wire transitions share one descriptor factory: same envelope, same
// success projection (defectId, status, ledgerId — the mirror the operation
// kept truthful), same destructive annotation. defect.waive is deliberately
// NOT built here: waivers are human risk acceptance with no MCP spelling.
function defectTransitionTool(name, title, description, semanticProps, required, statusConst) {
  return Object.freeze({
    name,
    title,
    description,
    inputSchema: {
      type: 'object',
      properties: Object.assign({}, WRITE_ENVELOPE_PROPS, semanticProps),
      required: [...WRITE_ENVELOPE_KEYS, ...required],
      additionalProperties: false,
    },
    outputSchema: {
      oneOf: [
        writeSuccessBranch({
          defectId: { type: 'string' },
          status: { const: statusConst },
          ledgerId: { type: ['string', 'null'] },
        }),
        WRITE_ERROR_BRANCH,
      ],
    },
    annotations: WRITE_DESTRUCTIVE,
  });
}

const DEFECT_RESOLVE_USAGE =
  'defect.resolve requires exactly: workspaceHandle, expectedStateRev, expectedStateGen, operationId, id, evidence (non-empty)';
const DEFECT_RESOLVE_TOOL = defectTransitionTool(
  'defect.resolve',
  'Resolve a defect with proof',
  'Mark one defect resolved on an opened workspace — no proof, no resolve. The state transition and its ledger mirror commit behind one write-ahead intent; an exact repeat is a no-op, and a repeat with different proof refuses rather than silently replacing the original. CAS-bound like every write.',
  {
    id: { type: 'string', minLength: 1 },
    evidence: { type: 'string', minLength: 1, description: 'Proof it is actually fixed.' },
  },
  ['id', 'evidence'],
  'resolved'
);

const DEFECT_REOPEN_USAGE =
  'defect.reopen requires exactly: workspaceHandle, expectedStateRev, expectedStateGen, operationId, id, reason (non-empty)';
const DEFECT_REOPEN_TOOL = defectTransitionTool(
  'defect.reopen',
  'Reopen a defect that is not actually fixed',
  'Reopen one defect on an opened workspace with the reason it is not actually fixed. Mirrored behind one write-ahead intent; exact repeats are no-ops. CAS-bound like every write.',
  {
    id: { type: 'string', minLength: 1 },
    reason: { type: 'string', minLength: 1, description: 'Why it is not actually fixed.' },
  },
  ['id', 'reason'],
  'reopened'
);

const DEFECT_SUPERSEDE_USAGE =
  'defect.supersede requires exactly: workspaceHandle, expectedStateRev, expectedStateGen, operationId, id, by (non-empty), optionally reason (non-empty)';
const DEFECT_SUPERSEDE_TOOL = defectTransitionTool(
  'defect.supersede',
  'Supersede a defect with its replacement',
  'Mark one defect superseded on an opened workspace, naming the artifact or defect that replaced it. Mirrored behind one write-ahead intent; exact repeats are no-ops. CAS-bound like every write.',
  {
    id: { type: 'string', minLength: 1 },
    by: { type: 'string', minLength: 1, description: 'The artifact or defect that replaced it.' },
    reason: { type: 'string', minLength: 1, description: 'Optional context for the supersession.' },
  },
  ['id', 'by'],
  'superseded'
);

// ---------------------------------------------------------------------------
// 4c: ledger.update — the second single-file safe core. Its envelope names
// the LEDGER lineage (state's expectedStateRev/Gen do not appear: this tool
// touches no state bytes, moves no state revision, writes no state receipt),
// and its receipts live in the ledger's own ring.
// ---------------------------------------------------------------------------

const LEDGER_ITEM_CAP_BYTES = 16384;

const LEDGER_UPDATE_USAGE =
  'ledger.update requires exactly: workspaceHandle, expectedLedgerRev (integer or null), ' +
  'expectedLedgerGen (string or null), operationId, collection, item — either both expectations ' +
  'non-null with no expectedLedgerHash, or both null with expectedLedgerHash naming the observed version-1 bytes';

// One error branch for every ledger.update refusal. StaleLedgerRev's fields
// are INTEGER-ONLY (a null expectation never reaches the revision check with
// a mismatch); actualLedgerGen is null exactly when the store is version 1,
// and actualLedgerHash then names what is actually on disk so the client can
// re-read and re-decide. LedgerRevisionExhausted and ReceiptTooLarge are
// NON-RETRYABLE by declaration: an identical retry fails identically.
const LEDGER_ERROR_BRANCH = Object.freeze({
  type: 'object',
  properties: {
    ok: { const: false },
    error: {
      enum: [
        'StaleLedgerRev',
        'StaleLedgerGen',
        'LedgerDamaged',
        'LedgerRevisionExhausted',
        'ReceiptTooLarge',
        'OperationIdConflict',
        'DeterministicIdConflict',
        'MirrorUnrecoverable',
        'WriteFailed',
      ],
    },
    message: { type: 'string' },
    expectedLedgerRev: { type: 'integer' },
    actualLedgerRev: { type: 'integer' },
    expectedLedgerGen: { type: ['string', 'null'] },
    actualLedgerGen: { type: ['string', 'null'] },
    actualLedgerHash: { type: 'string' },
  },
  required: ['ok', 'error', 'message'],
  additionalProperties: false,
});

const LEDGER_UPDATE_TOOL = Object.freeze({
  name: 'ledger.update',
  title: 'Upsert one QA-ledger record',
  description:
    'Upsert one record into the QA ledger of an opened workspace, against the ledger\'s OWN revision line ' +
    '(state revisions never move). CAS-bound: refuses unless expectedLedgerRev and expectedLedgerGen match the ' +
    'record — or, for a pre-envelope (version-1) ledger, unless the null pair plus expectedLedgerHash names the ' +
    'exact observed bytes, in which case the first committed write admits the ledger to version 2. Replays the ' +
    'recorded outcome when the same operationId retries the same operation. The defects collection is not ' +
    'addressable here on any door: defect records enter and change only through the defect verbs.',
  inputSchema: {
    type: 'object',
    properties: {
      workspaceHandle: {
        type: 'string',
        description: 'The opaque handle workspace.open minted on this connection.',
      },
      expectedLedgerRev: {
        type: ['integer', 'null'],
        minimum: 0,
        maximum: 9007199254740991,
        description: 'The ledgerRev this write was decided against, from workspace.open or the ledger resource — or null, with expectedLedgerGen, for a version-1 ledger.',
      },
      expectedLedgerGen: {
        type: ['string', 'null'],
        description: 'The ledger generation the revision was observed in — or null, with expectedLedgerRev, for a version-1 ledger.',
      },
      expectedLedgerHash: {
        type: 'string',
        pattern: '^sha256:[0-9a-f]{64}$',
        description: 'Required exactly when the expected pair is null: the ledgerBytesHash workspace.open served for the version-1 bytes this write decided against.',
      },
      operationId: {
        type: 'string',
        pattern: OPERATION_ID.source,
        description: 'Client-generated retry key (UUIDv4 or >=128 bits of entropy). Retry the SAME operation with the same id; never reuse one for a different operation.',
      },
      collection: { type: 'string', enum: ['features'] },
      item: {
        type: 'object',
        description: 'The record to upsert (canonical serialization at most 16 KiB). An existing string id merges over that record; item.id, when present, must be a non-empty string.',
      },
    },
    required: ['workspaceHandle', 'expectedLedgerRev', 'expectedLedgerGen', 'operationId', 'collection', 'item'],
    additionalProperties: false,
  },
  outputSchema: {
    oneOf: [
      {
        type: 'object',
        properties: {
          ok: { const: true },
          committed: { type: 'boolean' },
          // null in exactly one case: an uncommitted no-op against a
          // still-version-1 ledger — no revision exists to report.
          ledgerRev: { type: ['integer', 'null'] },
          replayed: { type: 'boolean' },
          collection: { type: 'string', enum: ['features'] },
          recordId: { type: 'string' },
          action: { type: 'string', enum: ['created', 'updated'] },
        },
        required: ['ok', 'committed', 'ledgerRev', 'replayed', 'collection', 'recordId', 'action'],
        additionalProperties: false,
      },
      LEDGER_ERROR_BRANCH,
    ],
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: true, // merge overwrites fields
    idempotentHint: true,
    openWorldHint: false,
  },
});

// The one sentence each refusal speaks. A table, so the funnel test can assert
// every wire sentence against this allowlist — no verb-specific catch can leak
// a path, an errno, or a store location.
const WRITE_REFUSALS = Object.freeze({
  StateNotInitialized: 'workspace state record does not exist — re-open the workspace once it is reinitialized',
  StaleGeneration: 'workspace record generation changed since it was read — re-open the workspace and re-decide',
  StaleStateRev: 'workspace record moved since it was read — re-read the state and re-decide against the current revision',
  OperationIdConflict: 'operationId was already used for a different operation — mint a fresh operationId',
  DeterministicIdConflict: 'derived record id already names an existing record — the operation refuses to address it',
  UnknownRecordId: 'no record with that id exists in the target collection — re-read the state and re-decide',
  ArtifactClosed: 'artifact is closed — closure is a historical fact; record a new artifact naming it in "revises", or retract it',
  ClosureBlocked: 'artifact closure is blocked — bound proof, open defects, holes, or a damaged proof record stand in the way; the confidence read names each blocker',
  HumanAuthorityRequired: 'this closure needs named human authorization (record-scope proof or waived holes) — it has no wire spelling; run it from the CLI',
  RetractRefused: 'retraction refused — a probe exit states its outcome (reason starts "disposed:" or "promoted:"), and a promotion names a recorded non-probe replacement',
  // The 4b literals are pinned by the ratified spec, word for word.
  AttachmentAmbiguous: 'Several live artifacts could own this defect; provide item.artifact explicitly.',
  MirrorUnrecoverable: 'The defect mirror cannot be read or recovered safely; run ratchet doctor and repair the reported condition before retrying.',
  WriteFailed: 'workspace write could not be completed',
  // The 4c ledger-line refusals. The first two mirror their state spellings;
  // the last three are pinned by the ratified spec, word for word.
  StaleLedgerRev: 'ledger record moved since it was read — re-read the ledger and re-decide against the current revision',
  StaleLedgerGen: 'ledger lineage changed since it was read — re-open the workspace and re-decide',
  LedgerDamaged: 'The ledger record cannot be read safely; run ratchet doctor and repair the reported condition before retrying.',
  LedgerRevisionExhausted: 'The ledger revision line cannot advance further; run ratchet doctor and archive or reset the ledger before writing.',
  ReceiptTooLarge: "The operation's receipt exceeds the persisted cap; this request cannot succeed as sent — see ratchet doctor if the store's own fields are oversized.",
});

function writeRefusal(error, fields) {
  const structured = Object.assign({ ok: false, error, message: WRITE_REFUSALS[error] }, fields || {});
  return {
    content: [{ type: 'text', text: JSON.stringify(structured) }],
    structuredContent: structured,
    isError: true,
  };
}

// THE funnel: every throwable a write path produces that is not already a
// boundary refusal becomes one allowlisted sentence. The raw error carries
// store pathnames and filesystem codes; neither belongs on this wire.
function safeWriteError(_error) {
  return writeRefusal('WriteFailed');
}

// Envelope shape is boundary business: exactly the envelope plus this verb's
// semantic fields, every one present, none extra, each envelope field typed.
// The message names the fields (that reveals no authority); the handle itself
// is still validated by resolveHandle's one non-enumerating answer.
// Free-form fields (item, value) nest arbitrarily, and the recursive
// canonicalizer downstream would blow the stack on pathological-but-valid
// depth and surface an internal error for what is malformed input. Measured
// iteratively for the same reason. 64 is generous: a real record is < 10.
const ARGUMENT_DEPTH_CAP = 64;
function argumentsTooDeep(value) {
  let stack = [{ v: value, d: 1 }];
  while (stack.length) {
    const { v, d } = stack.pop();
    if (!v || typeof v !== 'object') continue;
    if (d > ARGUMENT_DEPTH_CAP) return true;
    for (const key of Object.keys(v)) stack.push({ v: v[key], d: d + 1 });
  }
  return false;
}

function writeArguments(arguments_, semanticKeys, usage, optionalKeys) {
  const args = arguments_;
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw rpc.rpcError(-32602, usage);
  if (argumentsTooDeep(args)) throw rpc.rpcError(-32602, usage);
  const required = [...WRITE_ENVELOPE_KEYS, ...semanticKeys];
  const allowedSet = new Set([...required, ...(optionalKeys || [])]);
  for (const key of Object.keys(args)) {
    if (!allowedSet.has(key)) throw rpc.rpcError(-32602, usage);
  }
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(args, key)) throw rpc.rpcError(-32602, usage);
  }
  // Safe integer, not just integer: 2^53 passes isInteger but cannot be the
  // revision a client honestly read, and past it `+ 1` stops moving.
  if (!Number.isSafeInteger(args.expectedStateRev) || args.expectedStateRev < 0) {
    throw rpc.rpcError(-32602, usage);
  }
  if (typeof args.expectedStateGen !== 'string') throw rpc.rpcError(-32602, usage);
  if (typeof args.operationId !== 'string' || !OPERATION_ID.test(args.operationId)) {
    throw rpc.rpcError(-32602, usage);
  }
  return args;
}

// A semantic string the schema calls non-empty: whitespace does not count as
// evidence, an owner, or a trigger.
function nonEmpty(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

// ONE outcome mapping for every write tool. The verb supplies its meaning
// (`apply`) and its semantic arguments; everything past the boundary happens
// inside ops.executeWrite's single locked transaction, and every outcome —
// success, replay, or refusal — leaves as a conforming structured result.
function runWrite(record, tool, args, semanticArgs, apply, alsoLockFile) {
  let outcome;
  try {
    outcome = ops.executeWrite({
      state,
      root: record.root,
      tool,
      operationId: args.operationId,
      expectedStateRev: args.expectedStateRev,
      expectedStateGen: args.expectedStateGen,
      semanticArgs,
      apply,
      alsoLockFile,
    });
  } catch (error) {
    return safeWriteError(error);
  }
  return writeOutcome(outcome, args);
}

// The 4b variant: same boundary, same outcome mapping, but the execution runs
// the cross-file protocol. A post-decision mirror failure throws out of the
// executor and lands in safeWriteError — the retryable WriteFailed — because
// no success is emitted until the mirror and the clear have both landed.
function runMirroredWrite(record, tool, args, semanticArgs, prepare) {
  let outcome;
  try {
    outcome = ops.executeMirroredWrite({
      state,
      root: record.root,
      tool,
      operationId: args.operationId,
      expectedStateRev: args.expectedStateRev,
      expectedStateGen: args.expectedStateGen,
      semanticArgs,
      prepare,
    });
  } catch (error) {
    return safeWriteError(error);
  }
  return writeOutcome(outcome, args);
}

function writeOutcome(outcome, args) {
  switch (outcome.kind) {
    case 'replayed':
      return toolResult(Object.assign(outcome.result, { replayed: true }));
    case 'committed':
    case 'noop':
      return toolResult(outcome.result);
    case 'stateMissing':
      return writeRefusal('StateNotInitialized', { actualStateRev: null, actualStateGen: null });
    case 'staleGen':
      return writeRefusal('StaleGeneration', {
        expectedStateGen: args.expectedStateGen,
        actualStateGen: outcome.actualStateGen,
      });
    case 'staleRev':
      return writeRefusal('StaleStateRev', {
        expectedStateRev: args.expectedStateRev,
        actualStateRev: outcome.actualStateRev,
      });
    case 'conflict':
      return writeRefusal('OperationIdConflict');
    case 'idConflict':
      return writeRefusal('DeterministicIdConflict');
    case 'unknownId':
      return writeRefusal('UnknownRecordId');
    case 'artifactClosed':
      return writeRefusal('ArtifactClosed');
    case 'closureBlocked':
      return writeRefusal('ClosureBlocked');
    case 'humanAuthority':
      return writeRefusal('HumanAuthorityRequired');
    case 'retractRefused':
      return writeRefusal('RetractRefused');
    case 'attachAmbiguous':
      return writeRefusal('AttachmentAmbiguous');
    case 'mirror':
      return writeRefusal('MirrorUnrecoverable');
    default:
      return writeRefusal('WriteFailed');
  }
}

const RESOURCE_TEMPLATES = Object.freeze(RESOURCE_NAMES.map((name) => Object.freeze({
  uriTemplate: `torque://workspace/{workspaceHandle}/${name}`,
  name: `torque-${name}`,
  title: `Torque workspace ${name}`,
  description: resourceDescription(name),
  mimeType: RESOURCE_MIME,
})));

function resourceDescription(name) {
  if (name === 'state') return 'Canonical Torque session state for an opened workspace.';
  if (name === 'ledger') return 'Canonical Torque feature, test, and defect ledger for an opened workspace.';
  return 'Fixed-shape Torque cold-start receipt for an opened workspace.';
}

function withCache(result, era, ttlMs, cacheScope) {
  if (era !== 'modern') return result;
  return { ...result, ttlMs, cacheScope };
}

function listParams(params, method) {
  if (params.cursor !== undefined) {
    throw rpc.rpcError(-32602, `${method} has one fixed page; no cursor is valid`);
  }
}

function toolError(message) {
  return {
    content: [{ type: 'text', text: message }],
    isError: true,
  };
}

// The dual shape workspace.open already returns: structured content is the
// machine contract, the text block keeps clients that only render tool text.
function toolResult(value) {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value,
  };
}

function safeOpenError(error) {
  if (error && error.code === 'ERATCHETPATHESCAPE') {
    return 'workspace path is outside the configured roots';
  }
  if (error && error.code === 'ERATCHETSTORECONFLICT') {
    // Two store records for one project is an OPERATOR fix, and the generic
    // "could not be opened" sent a diagnosis round-trip hunting for a bug that
    // was never in the server. The sentence names the remedy and no path.
    return 'workspace store has conflicting project records — operator must merge or delete one';
  }
  if (error && error.code === 'ERATCHETGIT') {
    return 'workspace must be an accessible Git working tree directory';
  }
  if (error && error.code === 'ERATCHETMIRROR') {
    // Open recovers the 4b intent slot before issuing a handle; a slot strict
    // recovery cannot prove legal is an operator condition, same voice as the
    // write tools' allowlisted sentence.
    return 'The defect mirror cannot be read or recovered safely; run ratchet doctor and repair the reported condition before retrying.';
  }
  if (error && error.code === 'ERATCHETLEDGERDAMAGED') {
    // 4c D5: existing unhealthy ledger bytes refuse the open — no handle, no
    // backup, no fresh ledger. The local diagnosis stays local; the wire gets
    // the one allowlisted sentence.
    return WRITE_REFUSALS.LedgerDamaged;
  }
  if (error && error.code && String(error.code).startsWith('ERATCHETHANDLE')) {
    return 'workspace authority could not be issued';
  }
  return 'workspace state could not be opened';
}

// The 4b pendingIntent sample: the SHA-256 of readable raw intent bytes, an
// occupied-unreadable sentinel, or absent — never a bare existence bit, so two
// different slots never sample equal. Non-repairing by construction: one read,
// no lock, no store bytes created.
function intentToken(root) {
  try {
    return `sha256:${crypto.createHash('sha256').update(fs.readFileSync(state.intentPath(root))).digest('hex')}`;
  } catch (e) {
    return e && e.code === 'ENOENT' ? 'absent' : 'occupied-unreadable';
  }
}

// Non-repairing revision peek for the sampler pair. readJson swallows a parse
// failure into null; 'rev:unknown' keeps that observation distinct from rev 0.
function revToken(root) {
  const parsed = state.readJson(state.statePath(root));
  return parsed && Number.isInteger(parsed.rev) ? `rev:${parsed.rev}` : 'rev:unknown';
}

// Lock-free reads sample (state revision, intent token) around the assembly.
// A stable absent token plus a stable revision is a clean linearization point;
// anything unstable is conservatively reported as pendingIntent:true rather
// than letting a mixed WAL snapshot claim it saw a settled store.
function samplePendingIntent(root, assemble) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const tokenBefore = intentToken(root);
    const revBefore = revToken(root);
    const value = assemble();
    if (intentToken(root) === tokenBefore && revToken(root) === revBefore) {
      return { value, pendingIntent: tokenBefore !== 'absent' };
    }
  }
  return { value: assemble(), pendingIntent: true };
}

function resourceUri(handle, name) {
  return `torque://workspace/${handle}/${name}`;
}

function resourceLink(uri, name) {
  return {
    type: 'resource_link',
    uri,
    name: `torque-${name}`,
    title: `Torque workspace ${name}`,
    description: resourceDescription(name),
    mimeType: RESOURCE_MIME,
  };
}

function serialize(value) {
  return JSON.stringify(value, null, 2) + '\n';
}

// score.friction is the one derived read that takes no handle, so its whole
// authority is its payload — which makes the payload the thing to validate.
// Shape is refused at the boundary; how an individual factor is normalized
// (clamped to 1..10, aliases resolved) stays the domain function's business.
function frictionObstacles(arguments_) {
  const args = arguments_;
  const shaped = args && typeof args === 'object' && !Array.isArray(args) &&
    Object.keys(args).length === 1 && Array.isArray(args.obstacles);
  if (!shaped) throw rpc.rpcError(-32602, FRICTION_ARGUMENTS);
  for (const obstacle of args.obstacles) {
    if (!obstacle || typeof obstacle !== 'object' || Array.isArray(obstacle)) {
      throw rpc.rpcError(-32602, FRICTION_ARGUMENTS);
    }
    for (const key of Object.keys(obstacle)) {
      if (!FRICTION_FIELDS.has(key)) throw rpc.rpcError(-32602, FRICTION_ARGUMENTS);
    }
  }
  return args.obstacles;
}

function rankFriction(arguments_) {
  return toolResult(scoring.scoreFriction(frictionObstacles(arguments_)));
}

function createServer(options) {
  const opts = options || {};
  // Write capability is declared at spawn, never inferred: without the opt-in
  // the write tools are not registered at all, so tools/list stays truthful
  // instead of advertising capability the operator never granted.
  const writeEnabled = opts.write === true;
  const roots = workspace.createRoots(opts.roots);
  const discoverer = repository.createDiscovery({ roots });
  const registry = handles.createRegistry({ roots });
  const info = Object.freeze({
    name: (opts.serverInfo && opts.serverInfo.name) || 'torque-mcp',
    version: (opts.serverInfo && opts.serverInfo.version) || pkg.version,
  });
  const capabilities = Object.freeze({
    tools: Object.freeze({}),
    resources: Object.freeze({}),
    prompts: Object.freeze({}),
  });

  function createConnection(options_) {
    const connectionOptions = options_ || {};
    const authority = registry.open({ client: connectionOptions.client });
    // The canonical root is the authority fact. A digest is useful as an
    // opaque identity on the wire, but it must never become the equality check
    // that decides whether two filesystem capabilities are one grant.
    const byRoot = new Map();
    const byHandle = new Map();
    let closed = false;

    function stillCurrent(record) {
      try {
        return authority.use(record.handle, 'read').path === record.root;
      } catch (_error) {
        return false;
      }
    }

    function openWorkspace(arguments_) {
      const args = arguments_;
      const shaped = args && typeof args === 'object' && !Array.isArray(args) &&
        typeof args.path === 'string' &&
        Object.keys(args).length === 1;
      if (!shaped) {
        return toolError('workspace.open requires exactly one string argument: path');
      }
      if (closed) return toolError('workspace authority could not be issued');

      let found;
      let snapshot;
      let ledgerInfo;
      try {
        found = discoverer.discover(args.path);
        // Opening is the explicit initialization boundary. The revision only
        // means something once the canonical state record it counts exists.
        //
        // 4b: the snapshot is taken INSIDE the workspace lock, because the
        // lock's post-acquire path is where pending-intent recovery lives — a
        // healthy store used to be read lock-free here, which would have
        // issued a handle over a mirror still owed its recovery.
        //
        // 4c: the open boundary stopped repairing the ledger (D5). The
        // prescribed order inside the lock: recover (the lock did) →
        // strict-PROBE the ledger and refuse NOW if existing bytes are
        // unprovable, before anything initializes → initialize/load state →
        // create the ledger create-exclusive iff the probe found genuine
        // absence (proving the winner's bytes if the create loses that race)
        // → snapshot both. A LedgerDamaged refusal issues no handle, makes no
        // backup, invents no fresh ledger, and moves zero canonical bytes
        // measured from the post-recovery baseline.
        state.withWorkspaceLock(found.root, 'workspace open', () => {
          const probe = state.readLedgerStrict(found.root);
          snapshot = state.loadState(found.root);
          ledgerInfo = probe.absent ? state.createLedgerStrict(found.root) : probe;
        });
      } catch (error) {
        // Either record failing means no handle: authority over a workspace
        // whose canonical records could not be opened is authority to read
        // something that is not there.
        return toolError(safeOpenError(error));
      }

      let record = byRoot.get(found.root);
      // The cache is keyed by pathname, so a directory that was replaced since
      // the first open would otherwise be served authority minted over the
      // object that used to be there. Re-proving the grant is what makes the
      // key honest; a dead one is dropped and reissued, not repaired.
      if (record && !stillCurrent(record)) {
        authority.revoke(record.handle);
        byRoot.delete(found.root);
        byHandle.delete(record.handle);
        record = undefined;
      }
      if (!record) {
        let token;
        try {
          token = authority.grant({
            path: found.root,
            kind: 'directory',
            // The grant carries what the LAUNCH granted: write authority
            // exists on a handle only when the server was started with it.
            operations: writeEnabled ? ['read', 'write', 'list'] : ['read', 'list'],
          });
        } catch (error) {
          return toolError(safeOpenError(error));
        }
        record = Object.freeze({
          handle: token,
          root: found.root,
          repositoryId: found.repositoryId,
          worktreeId: found.worktreeId,
        });
        byRoot.set(found.root, record);
        byHandle.set(token, record);
      }

      const uris = {
        state: resourceUri(record.handle, 'state'),
        ledger: resourceUri(record.handle, 'ledger'),
        receipt: resourceUri(record.handle, 'receipt'),
      };
      // The ledger lineage from the same locked read as everything else. For
      // a version-1 ledger both fields are null and ledgerBytesHash names the
      // exact bytes an admission write must echo back.
      const lineage = state.ledgerLineage(ledgerInfo.ledger, ledgerInfo.bytes);
      const result = Object.assign({
        workspaceHandle: record.handle,
        repositoryId: record.repositoryId,
        worktreeId: record.worktreeId,
        stateRev: snapshot && Number.isInteger(snapshot.rev) ? snapshot.rev : 0,
        // The same loaded snapshot as stateRev: a revision and a generation
        // read separately could describe two different records.
        stateGen: snapshot ? String(snapshot.gen || '') : '',
      }, lineage, {
        // Sampled after the locked recovery above — normally 'absent'; a later
        // writer's slot is the state CAS contract's problem, not this field's.
        pendingIntent: intentToken(record.root) !== 'absent',
        resources: uris,
      });
      return {
        // Structured content is the machine contract. The text block keeps
        // compatibility with clients that only surface unstructured tool text.
        content: [
          { type: 'text', text: JSON.stringify(result) },
          ...RESOURCE_NAMES.map((name) => resourceLink(uris[name], name)),
        ],
        structuredContent: result,
      };
    }

    // THE authority check for every handle-bound read on this connection, so a
    // resource URI and a tool argument can never drift into two answers about
    // who may read. Malformed, unknown, stale, revoked, closed and
    // foreign-connection handles all leave here as one refusal: a reply that
    // varied would let the registry be enumerated one guess at a time.
    function resolveHandle(handle, operation) {
      if (typeof handle !== 'string' || !HANDLE_EXACT.test(handle)) {
        throw rpc.rpcError(-32602, RESOURCE_UNAVAILABLE);
      }
      const record = byHandle.get(handle);
      if (!record) throw rpc.rpcError(-32602, RESOURCE_UNAVAILABLE);
      try {
        const granted = authority.use(handle, operation || 'read');
        if (granted.kind !== 'directory' || granted.path !== record.root) {
          throw rpc.rpcError(-32602, RESOURCE_UNAVAILABLE);
        }
      } catch (_error) {
        throw rpc.rpcError(-32602, RESOURCE_UNAVAILABLE);
      }
      return record;
    }

    // A handle tool's argument object is part of the same non-enumerating
    // answer: a missing, extra, or wrongly typed field tells the caller no more
    // than a fabricated handle does.
    function handleArgument(arguments_) {
      const args = arguments_;
      const shaped = args && typeof args === 'object' && !Array.isArray(args) &&
        Object.keys(args).length === 1 &&
        Object.prototype.hasOwnProperty.call(args, 'workspaceHandle');
      if (!shaped) throw rpc.rpcError(-32602, RESOURCE_UNAVAILABLE);
      return args.workspaceHandle;
    }

    function scanWorkspace(arguments_) {
      const record = resolveHandle(handleArgument(arguments_));
      try {
        return toolResult(coldStart.scan(record.root));
      } catch (_error) {
        // The raw error carries store pathnames and filesystem codes; neither
        // belongs on a wire whose whole contract is that names do not cross it.
        return toolError('workspace cold-start scan could not be completed');
      }
    }

    function confidenceForWorkspace(arguments_) {
      const record = resolveHandle(handleArgument(arguments_));
      try {
        // ONE state snapshot. Re-reading state just to report `stateRev` would
        // let a write that landed in between make the revision describe a
        // record these layers never saw — a number that certifies the wrong
        // bytes is worse than no number.
        const snapshot = state.peekState(record.root);
        const ledger = state.peekLedger(record.root);
        // readEventsWithHealth, not readEvents: the malformed-line warning goes
        // to stderr, and no MCP client reads stderr. Damage that only appears
        // there is damage the wire silently certifies as clean.
        const read = journal.readEventsWithHealth(record.root);
        const layers = scoring.scoreConfidenceLayers(snapshot, ledger, read.events);
        // Closure is a fact with named blockers, not a score, and it travels
        // beside the layers so a high number can never read as "done".
        const closure = lifecycle.workflowClosed(snapshot, read.events, record.root);
        return toolResult({
          ...layers,
          closure,
          stateRev: Number.isInteger(snapshot.rev) ? snapshot.rev : 0,
          journal: { counted: read.events.length, malformed: read.malformed },
        });
      } catch (_error) {
        return toolError('workspace confidence could not be computed');
      }
    }

    // The write verbs. Envelope and semantics are refused at the boundary;
    // everything past resolveHandle happens inside ops.executeWrite's single
    // locked transaction (via runWrite's one outcome mapping), and each verb's
    // meaning lives in src/verbs.js, shared with the CLI — one implementation,
    // two boundaries.
    function stateSet(arguments_) {
      const args = writeArguments(arguments_, ['key', 'value'], STATE_SET_USAGE);
      if (typeof args.key !== 'string' || !schemas.STATE_SCALARS.has(args.key)) {
        throw rpc.rpcError(-32602, `state.set key must be one of: ${[...schemas.STATE_SCALARS].join(', ')}`);
      }
      if (typeof args.value !== 'string') throw rpc.rpcError(-32602, STATE_SET_USAGE);
      const record = resolveHandle(args.workspaceHandle, 'write');
      return runWrite(record, 'state.set', args, { key: args.key, value: args.value }, (s, mintId) => {
        verbs.setScalar(s, args.key, args.value, mintId);
        return { key: args.key };
      });
    }

    function stateAppend(arguments_) {
      const args = writeArguments(arguments_, ['collection', 'item'], STATE_APPEND_USAGE);
      if (typeof args.collection !== 'string' || !APPENDABLE.includes(args.collection)) {
        throw rpc.rpcError(-32602,
          `state.append collection must be one of: ${APPENDABLE.join(', ')} — ` +
          'artifacts and defects have gated constructors (artifact.add, the CLI defect verbs)');
      }
      const item = args.item;
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        throw rpc.rpcError(-32602, STATE_APPEND_USAGE);
      }
      if (item.id !== undefined && !nonEmpty(item.id)) throw rpc.rpcError(-32602, STATE_APPEND_USAGE);
      // Birth status is a fact of the collection, not a request field. The
      // shared verb re-checks; refusing here keeps a claimed status from ever
      // entering the transaction.
      const birth = verbs.BIRTH_STATUS[args.collection];
      if (birth && item.status != null && String(item.status) !== birth) {
        throw rpc.rpcError(-32602,
          `state.append ${args.collection} are born "${birth}" — reaching any other status is a transition verb, not a birth field`);
      }
      const record = resolveHandle(args.workspaceHandle, 'write');
      return runWrite(record, 'state.append', args, { collection: args.collection, item }, (s, mintId) => {
        const appended = verbs.appendItem(s, args.collection, item, mintId);
        if (appended.dup) return { collection: args.collection, recordId: String(appended.dup.id), deduped: true };
        return { collection: args.collection, recordId: String(appended.record.id), deduped: false };
      });
    }

    function openLoopClose(arguments_) {
      const args = writeArguments(arguments_, ['id', 'evidence'], OPEN_LOOP_CLOSE_USAGE);
      if (!nonEmpty(args.id) || !nonEmpty(args.evidence)) throw rpc.rpcError(-32602, OPEN_LOOP_CLOSE_USAGE);
      const record = resolveHandle(args.workspaceHandle, 'write');
      return runWrite(record, 'open_loop.close', args, { id: args.id, evidence: args.evidence }, (s, mintId) => {
        verbs.closeRecord(s, 'openLoops', args.id, { evidence: args.evidence }, mintId);
        return { openLoopId: args.id, status: 'closed' };
      });
    }

    function openLoopPark(arguments_) {
      const args = writeArguments(arguments_, ['id', 'owner', 'revisitTrigger'], OPEN_LOOP_PARK_USAGE);
      if (!nonEmpty(args.id) || !nonEmpty(args.owner) || !nonEmpty(args.revisitTrigger)) {
        throw rpc.rpcError(-32602, OPEN_LOOP_PARK_USAGE);
      }
      const record = resolveHandle(args.workspaceHandle, 'write');
      return runWrite(record, 'open_loop.park', args,
        { id: args.id, owner: args.owner, revisitTrigger: args.revisitTrigger }, (s, mintId) => {
          verbs.closeRecord(s, 'openLoops', args.id,
            { park: true, owner: args.owner, revisitTrigger: args.revisitTrigger }, mintId);
          return { openLoopId: args.id, status: 'parked' };
        });
    }

    function assumptionClose(arguments_) {
      const args = writeArguments(arguments_, ['id', 'outcome', 'evidence'], ASSUMPTION_CLOSE_USAGE);
      if (!nonEmpty(args.id) || !nonEmpty(args.evidence)) throw rpc.rpcError(-32602, ASSUMPTION_CLOSE_USAGE);
      if (args.outcome !== 'tested' && args.outcome !== 'killed') {
        throw rpc.rpcError(-32602, ASSUMPTION_CLOSE_USAGE);
      }
      const record = resolveHandle(args.workspaceHandle, 'write');
      return runWrite(record, 'assumption.close', args,
        { id: args.id, outcome: args.outcome, evidence: args.evidence }, (s, mintId) => {
          verbs.closeRecord(s, 'assumptions', args.id,
            { outcome: args.outcome, evidence: args.evidence }, mintId);
          return { assumptionId: args.id, status: args.outcome };
        });
    }

    function markCompileDone(arguments_) {
      const args = writeArguments(arguments_, [], COMPILE_DONE_USAGE);
      const record = resolveHandle(args.workspaceHandle, 'write');
      return runWrite(record, 'compile.done', args, {}, (s, mintId) => {
        const at = verbs.compileDone(s, mintId);
        return { checkpointed: true, lastCompileAt: at };
      });
    }

    function artifactAdd(arguments_) {
      const args = writeArguments(arguments_, ['item'], ARTIFACT_ADD_USAGE);
      const item = args.item;
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        throw rpc.rpcError(-32602, ARTIFACT_ADD_USAGE);
      }
      if (item.id !== undefined && !nonEmpty(item.id)) throw rpc.rpcError(-32602, ARTIFACT_ADD_USAGE);
      // Terminal statuses and reserved lifecycle fields are static shape rules,
      // so they refuse at the boundary; the shared verb re-checks underneath.
      // The messages echo only client-supplied values, never server state.
      try {
        artifacts.assertArtifactInput(item);
      } catch (error) {
        throw rpc.rpcError(-32602, error.message);
      }
      const record = resolveHandle(args.workspaceHandle, 'write');
      return runWrite(record, 'artifact.add', args, { item }, (s, mintId) => {
        const res = artifacts.applyAdd(s, item, mintId);
        return { artifactId: String(res.record.id), artifactRev: res.record.rev, action: res.action };
      });
    }

    function artifactClose(arguments_) {
      const args = writeArguments(arguments_, ['id'], ARTIFACT_CLOSE_USAGE);
      if (!nonEmpty(args.id)) throw rpc.rpcError(-32602, ARTIFACT_CLOSE_USAGE);
      const record = resolveHandle(args.workspaceHandle, 'write');
      // No waiver arguments cross this wire (opts stays {}), so record-scope
      // proof and open holes refuse in the shared gate. The journal lock spans
      // the whole transaction, commit included — same contract as the CLI.
      return runWrite(record, 'artifact.close', args, { id: args.id }, (s, mintId) => {
        const res = artifacts.applyClose(record.root, s, args.id, {}, mintId);
        const artifactRev = res.already ? res.artifact.closedRev : res.fp.rev;
        return { artifactId: args.id, artifactRev, status: 'closed' };
      }, journal.logPath(record.root));
    }

    function artifactRetract(arguments_) {
      const args = writeArguments(arguments_, ['id', 'reason'], ARTIFACT_RETRACT_USAGE, ['supersededBy']);
      if (!nonEmpty(args.id) || !nonEmpty(args.reason)) throw rpc.rpcError(-32602, ARTIFACT_RETRACT_USAGE);
      if (args.supersededBy !== undefined && !nonEmpty(args.supersededBy)) {
        throw rpc.rpcError(-32602, ARTIFACT_RETRACT_USAGE);
      }
      // Absent and present-but-null are one meaning; normalizing before the
      // binding hash keeps a verbatim retry hashing identically either way.
      const supersededBy = args.supersededBy === undefined ? null : args.supersededBy;
      const record = resolveHandle(args.workspaceHandle, 'write');
      return runWrite(record, 'artifact.retract', args,
        { id: args.id, reason: args.reason, supersededBy }, (s, mintId) => {
          artifacts.applyRetract(s, args.id,
            { reason: args.reason, supersededBy: supersededBy || '' }, mintId);
          return { artifactId: args.id, status: 'retracted', supersededBy };
        });
    }

    function defectAdd(arguments_) {
      const args = writeArguments(arguments_, ['item'], DEFECT_ADD_USAGE);
      const item = args.item;
      if (!item || typeof item !== 'object' || Array.isArray(item)) throw rpc.rpcError(-32602, DEFECT_ADD_USAGE);
      if (item.id !== undefined && !nonEmpty(item.id)) throw rpc.rpcError(-32602, DEFECT_ADD_USAGE);
      // Terminal birth statuses refuse at the boundary, same rule as
      // state.append; the shared core re-checks underneath.
      const claimed = item.status == null ? '' : String(item.status).toLowerCase();
      if (claimed && schemas.DEFECT_TERMINAL_STATUSES.includes(claimed)) {
        throw rpc.rpcError(-32602,
          'defect.add cannot birth a terminal status — resolve and supersede are transitions, and waivers stay CLI acts');
      }
      const record = resolveHandle(args.workspaceHandle, 'write');
      return runMirroredWrite(record, 'defect.add', args, { item }, (s, ledger, mintId) => {
        const prep = artifacts.prepareDefectAdd(record.root, s, ledger, item, mintId);
        const rec = prep.record;
        const verbFields = {
          defectId: String(rec.id),
          severity: rec.severity,
          action: prep.action,
          artifact: rec.artifact ? String(rec.artifact) : null,
          attachedBy: String(rec.attachedBy || ''),
          ledgerId: rec.ledgerId ? String(rec.ledgerId) : null,
        };
        if (prep.kind === 'noop') return { kind: 'noop', verbFields };
        return { kind: 'commit', ledgerOps: prep.ledgerOps, verbFields };
      });
    }

    // One handler shape for the three wire transitions: boundary gates travel
    // as schema, the shared core owns the meaning, and the mirror rides the
    // same intent. waive has no handler here, by rule.
    function runDefectTransition(args, toStatus, tool, meta, semanticArgs) {
      const record = resolveHandle(args.workspaceHandle, 'write');
      return runMirroredWrite(record, tool, args, semanticArgs, (s, ledger, mintId) => {
        const prep = artifacts.prepareDefectTransition(s, ledger, args.id, toStatus, meta, mintId);
        const verbFields = {
          defectId: String(prep.record.id),
          status: toStatus,
          ledgerId: prep.record.ledgerId ? String(prep.record.ledgerId) : null,
        };
        if (prep.kind === 'noop') return { kind: 'noop', verbFields };
        return { kind: 'commit', ledgerOps: prep.ledgerOps, verbFields };
      });
    }

    function defectResolve(arguments_) {
      const args = writeArguments(arguments_, ['id', 'evidence'], DEFECT_RESOLVE_USAGE);
      if (!nonEmpty(args.id) || !nonEmpty(args.evidence)) throw rpc.rpcError(-32602, DEFECT_RESOLVE_USAGE);
      return runDefectTransition(args, 'resolved', 'defect.resolve',
        { evidence: args.evidence, note: `resolved: ${args.evidence}` },
        { id: args.id, evidence: args.evidence });
    }

    function defectReopen(arguments_) {
      const args = writeArguments(arguments_, ['id', 'reason'], DEFECT_REOPEN_USAGE);
      if (!nonEmpty(args.id) || !nonEmpty(args.reason)) throw rpc.rpcError(-32602, DEFECT_REOPEN_USAGE);
      return runDefectTransition(args, 'reopened', 'defect.reopen',
        { reason: args.reason, note: `reopened: ${args.reason}` },
        { id: args.id, reason: args.reason });
    }

    function defectSupersede(arguments_) {
      const args = writeArguments(arguments_, ['id', 'by'], DEFECT_SUPERSEDE_USAGE, ['reason']);
      if (!nonEmpty(args.id) || !nonEmpty(args.by)) throw rpc.rpcError(-32602, DEFECT_SUPERSEDE_USAGE);
      if (args.reason !== undefined && !nonEmpty(args.reason)) throw rpc.rpcError(-32602, DEFECT_SUPERSEDE_USAGE);
      // Absent and null are one meaning in the binding, same as artifact.retract.
      const reason = args.reason === undefined ? null : args.reason;
      return runDefectTransition(args, 'superseded', 'defect.supersede',
        { by: args.by, reason: reason || '', note: `superseded by ${args.by}${reason ? `: ${reason}` : ''}` },
        { id: args.id, by: args.by, reason });
    }

    function scoreAperture(arguments_) {
      const args = writeArguments(arguments_, [...APERTURE_DIMENSION_KEYS], SCORE_APERTURE_USAGE);
      const dims = {};
      for (const key of APERTURE_DIMENSION_KEYS) {
        const v = args[key];
        if (!Number.isInteger(v) || v < 0 || v > 2) throw rpc.rpcError(-32602, SCORE_APERTURE_USAGE);
        dims[key] = v;
      }
      const record = resolveHandle(args.workspaceHandle, 'write');
      // The score itself is pure; the conditional fog write is the reason this
      // rides the write envelope. recordedFog is truthful on both outcomes: a
      // score that wrote nothing commits nothing (noop, committed:false).
      const result = scoring.scoreAperture(dims);
      return runWrite(record, 'score.aperture', args, dims, (s, mintId) => {
        const recorded = verbs.recordFog(s, result, mintId);
        return Object.assign({}, result, { recordedFog: recorded });
      });
    }

    // 4c: the ledger envelope. Not writeArguments — this tool names the
    // LEDGER lineage, whose contract is exhaustive at the boundary: EITHER a
    // non-null pair with NO expectedLedgerHash, OR the null pair WITH it. Any
    // other combination refuses -32602 before the store is touched.
    function ledgerUpdate(arguments_) {
      const args = arguments_;
      if (!args || typeof args !== 'object' || Array.isArray(args)) throw rpc.rpcError(-32602, LEDGER_UPDATE_USAGE);
      if (argumentsTooDeep(args)) throw rpc.rpcError(-32602, LEDGER_UPDATE_USAGE);
      const required = ['workspaceHandle', 'expectedLedgerRev', 'expectedLedgerGen', 'operationId', 'collection', 'item'];
      const allowed = new Set([...required, 'expectedLedgerHash']);
      for (const key of Object.keys(args)) {
        if (!allowed.has(key)) throw rpc.rpcError(-32602, LEDGER_UPDATE_USAGE);
      }
      for (const key of required) {
        if (!Object.prototype.hasOwnProperty.call(args, key)) throw rpc.rpcError(-32602, LEDGER_UPDATE_USAGE);
      }
      const rev = args.expectedLedgerRev;
      const gen = args.expectedLedgerGen;
      if (rev !== null && (!Number.isSafeInteger(rev) || rev < 0)) throw rpc.rpcError(-32602, LEDGER_UPDATE_USAGE);
      if (gen !== null && typeof gen !== 'string') throw rpc.rpcError(-32602, LEDGER_UPDATE_USAGE);
      // Mixed pairs, a null pair without the hash, and a non-null pair
      // carrying one are all refused: the envelope rule is exhaustive.
      if ((rev === null) !== (gen === null)) throw rpc.rpcError(-32602, LEDGER_UPDATE_USAGE);
      if (rev === null) {
        if (typeof args.expectedLedgerHash !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(args.expectedLedgerHash)) {
          throw rpc.rpcError(-32602, LEDGER_UPDATE_USAGE);
        }
      } else if (args.expectedLedgerHash !== undefined) {
        throw rpc.rpcError(-32602, LEDGER_UPDATE_USAGE);
      }
      if (typeof args.operationId !== 'string' || !OPERATION_ID.test(args.operationId)) {
        throw rpc.rpcError(-32602, LEDGER_UPDATE_USAGE);
      }
      if (args.collection !== 'features') throw rpc.rpcError(-32602, LEDGER_UPDATE_USAGE);
      const item = args.item;
      if (!item || typeof item !== 'object' || Array.isArray(item)) throw rpc.rpcError(-32602, LEDGER_UPDATE_USAGE);
      if (item.id !== undefined && (typeof item.id !== 'string' || !item.id)) {
        throw rpc.rpcError(-32602, LEDGER_UPDATE_USAGE);
      }
      // The item cap keeps the ledger a ledger rather than a blob store:
      // canonical serialization, measured in UTF-8 bytes, refused before any
      // load touches the store.
      if (Buffer.byteLength(ops.canonicalStringify(item), 'utf8') > LEDGER_ITEM_CAP_BYTES) {
        throw rpc.rpcError(-32602, LEDGER_UPDATE_USAGE);
      }
      const record = resolveHandle(args.workspaceHandle, 'write');
      let outcome;
      try {
        outcome = ops.executeLedgerWrite({
          state,
          ledger: ledgerMod,
          root: record.root,
          operationId: args.operationId,
          expectedLedgerRev: rev,
          expectedLedgerGen: gen,
          expectedLedgerHash: rev === null ? args.expectedLedgerHash : null,
          collection: args.collection,
          item,
        });
      } catch (error) {
        return safeWriteError(error);
      }
      switch (outcome.kind) {
        case 'replayed':
          return toolResult(Object.assign(outcome.result, { replayed: true }));
        case 'committed':
        case 'noop':
          return toolResult(outcome.result);
        case 'staleLedgerGen':
          return writeRefusal('StaleLedgerGen', Object.assign({
            expectedLedgerGen: gen,
            actualLedgerGen: outcome.actualLedgerGen,
          }, outcome.actualLedgerHash ? { actualLedgerHash: outcome.actualLedgerHash } : {}));
        case 'staleLedgerRev':
          return writeRefusal('StaleLedgerRev', {
            expectedLedgerRev: rev,
            actualLedgerRev: outcome.actualLedgerRev,
          });
        case 'conflict':
          return writeRefusal('OperationIdConflict');
        case 'idConflict':
          return writeRefusal('DeterministicIdConflict');
        case 'ledgerDamaged':
          return writeRefusal('LedgerDamaged');
        case 'ledgerExhausted':
          return writeRefusal('LedgerRevisionExhausted');
        case 'capOverflow':
          // For ledger.update the capOverflow outcome maps to the
          // NON-RETRYABLE ReceiptTooLarge, never to retryable WriteFailed —
          // the verdict is deterministic in the request's own composition.
          return writeRefusal('ReceiptTooLarge');
        case 'mirror':
          return writeRefusal('MirrorUnrecoverable');
        default:
          return writeRefusal('WriteFailed');
      }
    }

    // ONE registry. tools/list renders it and tools/call dispatches from it, so
    // a listed tool cannot silently lack an implementation and an implemented
    // tool cannot stay undiscoverable. The order is the advertised order; the
    // write roster exists only when the launch granted writes.
    const toolRegistry = [
      { descriptor: TOOL, run: openWorkspace },
      { descriptor: SCAN_TOOL, run: scanWorkspace },
      { descriptor: CONFIDENCE_TOOL, run: confidenceForWorkspace },
      { descriptor: FRICTION_TOOL, run: rankFriction },
      ...(writeEnabled ? [
        { descriptor: STATE_SET_TOOL, run: stateSet },
        { descriptor: STATE_APPEND_TOOL, run: stateAppend },
        { descriptor: OPEN_LOOP_CLOSE_TOOL, run: openLoopClose },
        { descriptor: OPEN_LOOP_PARK_TOOL, run: openLoopPark },
        { descriptor: ASSUMPTION_CLOSE_TOOL, run: assumptionClose },
        { descriptor: COMPILE_DONE_TOOL, run: markCompileDone },
        { descriptor: ARTIFACT_ADD_TOOL, run: artifactAdd },
        { descriptor: ARTIFACT_CLOSE_TOOL, run: artifactClose },
        { descriptor: ARTIFACT_RETRACT_TOOL, run: artifactRetract },
        { descriptor: SCORE_APERTURE_TOOL, run: scoreAperture },
        { descriptor: DEFECT_ADD_TOOL, run: defectAdd },
        { descriptor: DEFECT_RESOLVE_TOOL, run: defectResolve },
        { descriptor: DEFECT_REOPEN_TOOL, run: defectReopen },
        { descriptor: DEFECT_SUPERSEDE_TOOL, run: defectSupersede },
        { descriptor: LEDGER_UPDATE_TOOL, run: ledgerUpdate },
      ] : []),
    ];

    function parseResource(uri) {
      if (typeof uri !== 'string') return null;
      const match = RESOURCE_PATTERN.exec(uri);
      if (!match) return null;
      return { handle: match[1], name: match[2] };
    }

    function resourceRecord(uri) {
      const parsed = parseResource(uri);
      if (!parsed) throw rpc.rpcError(-32602, RESOURCE_UNAVAILABLE);
      return { parsed, record: resolveHandle(parsed.handle) };
    }

    function readResource(params, context) {
      const available = resourceRecord(params.uri);
      // 4b: every resource states the WAL observation out loud. The flag is
      // derived at read time and injected into the projection only — the disk
      // bytes never gain it. Reads stay byte-pure: peeks, not the resilient
      // loaders — a resource read must never create a record or back one up.
      let sampled;
      try {
        sampled = samplePendingIntent(available.record.root, () => {
          if (available.parsed.name === 'state') return state.peekState(available.record.root);
          if (available.parsed.name === 'ledger') {
            // 4c lineage projection: a version-2 ledger already carries its
            // lineage in the served bytes; a version-1 record gains explicit
            // nulls plus the hash of the exact bytes just read — injected
            // into the projection only, the disk bytes never gain it.
            const raw = state.peekLedgerRaw(available.record.root);
            const lineage = state.ledgerLineage(raw.parsed, raw.bytes);
            return lineage.ledgerBytesHash ? Object.assign({}, raw.parsed, lineage) : raw.parsed;
          }
          return receipt.assemble(available.record.root, { peek: true });
        });
      } catch (e) {
        if (e && e.code === 'ERATCHETMIRROR') {
          // The conservative refusal: the one allowlisted sentence, no store path.
          throw rpc.rpcError(-32603, WRITE_REFUSALS.MirrorUnrecoverable);
        }
        throw e;
      }
      const value = Object.assign({}, sampled.value, { pendingIntent: sampled.pendingIntent });

      return withCache({
        contents: [{
          uri: params.uri,
          mimeType: RESOURCE_MIME,
          text: serialize(value),
        }],
      }, context.era, 0, 'private');
    }

    const methods = {
      'tools/list': {
        eras: ['modern', 'legacy'],
        handler: (params, context) => {
          listParams(params, 'tools/list');
          return withCache(
            { tools: toolRegistry.map((entry) => entry.descriptor) },
            context.era, LIST_TTL_MS, 'public'
          );
        },
      },
      'tools/call': {
        eras: ['modern', 'legacy'],
        handler: (params) => {
          if (typeof params.name !== 'string') {
            throw rpc.rpcError(-32602, 'tools/call requires a tool name');
          }
          const entry = toolRegistry.find((candidate) => candidate.descriptor.name === params.name);
          if (!entry) {
            throw rpc.rpcError(-32602, `unknown tool: ${params.name}`);
          }
          return entry.run(params.arguments);
        },
      },
      'resources/list': {
        eras: ['modern', 'legacy'],
        handler: (params, context) => {
          listParams(params, 'resources/list');
          return withCache({ resources: [] }, context.era, LIST_TTL_MS, 'public');
        },
      },
      'resources/templates/list': {
        eras: ['modern', 'legacy'],
        handler: (params, context) => {
          listParams(params, 'resources/templates/list');
          return withCache({
            resourceTemplates: RESOURCE_TEMPLATES,
          }, context.era, LIST_TTL_MS, 'public');
        },
      },
      'resources/read': {
        eras: ['modern', 'legacy'],
        handler: readResource,
      },
      'prompts/list': {
        eras: ['modern', 'legacy'],
        handler: (params, context) => {
          listParams(params, 'prompts/list');
          return withCache(prompts.list(), context.era, LIST_TTL_MS, 'public');
        },
      },
      'prompts/get': {
        eras: ['modern', 'legacy'],
        handler: (params) => prompts.get(params.name, params.arguments),
      },
    };

    const protocol = rpc.createKernel({
      serverInfo: info,
      capabilities,
      methods,
    }).createConnection();

    function close() {
      if (closed) return;
      closed = true;
      byRoot.clear();
      byHandle.clear();
      authority.close();
    }

    return {
      handleMessage: protocol.handleMessage,
      era: protocol.era,
      dropped: protocol.dropped,
      close,
    };
  }

  return { createConnection };
}

// safeOpenError travels with the server: it is the only place a store failure
// becomes wire text, and a Windows-only slug collision cannot be provoked on
// every platform the tests run on. Exported so the refusal text is falsifiable
// everywhere, not just where the collision exists.
module.exports = { createServer, safeOpenError, WRITE_REFUSALS };
