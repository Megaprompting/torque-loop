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

const handles = require('./handles');
const ops = require('./ops');
const prompts = require('./prompts');
const repository = require('./repository');
const rpc = require('./rpc');
const workspace = require('./workspace');
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
    required: ['workspaceHandle', 'repositoryId', 'worktreeId', 'stateRev', 'stateGen', 'resources'],
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

// The one sentence each refusal speaks. A table, so the funnel test can assert
// every wire sentence against this allowlist — no verb-specific catch can leak
// a path, an errno, or a store location.
const WRITE_REFUSALS = Object.freeze({
  StateNotInitialized: 'workspace state record does not exist — re-open the workspace once it is reinitialized',
  StaleGeneration: 'workspace record generation changed since it was read — re-open the workspace and re-decide',
  StaleStateRev: 'workspace record moved since it was read — re-read the state and re-decide against the current revision',
  OperationIdConflict: 'operationId was already used for a different operation — mint a fresh operationId',
  DeterministicIdConflict: 'derived record id already names an existing record — the operation refuses to address it',
  WriteFailed: 'workspace write could not be completed',
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
function writeArguments(arguments_, semanticKeys, usage) {
  const args = arguments_;
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw rpc.rpcError(-32602, usage);
  const allowed = [...WRITE_ENVELOPE_KEYS, ...semanticKeys];
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(args)) {
    if (!allowedSet.has(key)) throw rpc.rpcError(-32602, usage);
  }
  for (const key of allowed) {
    if (!Object.prototype.hasOwnProperty.call(args, key)) throw rpc.rpcError(-32602, usage);
  }
  if (!Number.isInteger(args.expectedStateRev) || args.expectedStateRev < 0) {
    throw rpc.rpcError(-32602, usage);
  }
  if (typeof args.expectedStateGen !== 'string') throw rpc.rpcError(-32602, usage);
  if (typeof args.operationId !== 'string' || !OPERATION_ID.test(args.operationId)) {
    throw rpc.rpcError(-32602, usage);
  }
  return args;
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
  if (error && error.code && String(error.code).startsWith('ERATCHETHANDLE')) {
    return 'workspace authority could not be issued';
  }
  return 'workspace state could not be opened';
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
      try {
        found = discoverer.discover(args.path);
        // Opening is the explicit initialization boundary. The revision only
        // means something once the canonical state record it counts exists —
        // and the LEDGER is initialized in the same breath, because loadLedger
        // creates it when it is missing: without this, the first ledger
        // resource read of a fresh workspace wrote bytes, and "every read is
        // pure" was false on the one path a client hits first.
        snapshot = state.loadState(found.root);
        state.loadLedger(found.root);
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
      const result = {
        workspaceHandle: record.handle,
        repositoryId: record.repositoryId,
        worktreeId: record.worktreeId,
        stateRev: snapshot && Number.isInteger(snapshot.rev) ? snapshot.rev : 0,
        // The same loaded snapshot as stateRev: a revision and a generation
        // read separately could describe two different records.
        stateGen: snapshot ? String(snapshot.gen || '') : '',
        resources: uris,
      };
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
        const snapshot = state.loadState(record.root);
        const ledger = state.loadLedger(record.root);
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

    // The canary write verb. Envelope and semantics are refused at the
    // boundary; everything past resolveHandle happens inside ops.executeWrite's
    // single locked transaction, and every outcome maps to a conforming
    // structured result. The verb's meaning lives in src/verbs.js, shared with
    // the CLI — one implementation, two boundaries.
    function stateSet(arguments_) {
      const args = writeArguments(arguments_, ['key', 'value'], STATE_SET_USAGE);
      if (typeof args.key !== 'string' || !schemas.STATE_SCALARS.has(args.key)) {
        throw rpc.rpcError(-32602, `state.set key must be one of: ${[...schemas.STATE_SCALARS].join(', ')}`);
      }
      if (typeof args.value !== 'string') throw rpc.rpcError(-32602, STATE_SET_USAGE);
      const record = resolveHandle(args.workspaceHandle, 'write');
      let outcome;
      try {
        outcome = ops.executeWrite({
          state,
          root: record.root,
          tool: 'state.set',
          operationId: args.operationId,
          expectedStateRev: args.expectedStateRev,
          expectedStateGen: args.expectedStateGen,
          semanticArgs: { key: args.key, value: args.value },
          apply: (s, mintId) => {
            verbs.setScalar(s, args.key, args.value, mintId);
            return { key: args.key };
          },
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
      ...(writeEnabled ? [{ descriptor: STATE_SET_TOOL, run: stateSet }] : []),
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
      let value;
      if (available.parsed.name === 'state') value = state.loadState(available.record.root);
      else if (available.parsed.name === 'ledger') value = state.loadLedger(available.record.root);
      else value = receipt.assemble(available.record.root);

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
