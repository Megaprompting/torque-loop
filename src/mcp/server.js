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

const handles = require('./handles');
const prompts = require('./prompts');
const repository = require('./repository');
const rpc = require('./rpc');
const workspace = require('./workspace');
const coldStart = require('../coldStart');
const journal = require('../evolve/journal');
const lifecycle = require('../lifecycle');
const receipt = require('../receipt');
const scoring = require('../scoring');
const state = require('../state');
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
    required: ['workspaceHandle', 'repositoryId', 'worktreeId', 'stateRev', 'resources'],
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
            operations: ['read', 'list'],
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
    function resolveHandle(handle) {
      if (typeof handle !== 'string' || !HANDLE_EXACT.test(handle)) {
        throw rpc.rpcError(-32602, RESOURCE_UNAVAILABLE);
      }
      const record = byHandle.get(handle);
      if (!record) throw rpc.rpcError(-32602, RESOURCE_UNAVAILABLE);
      try {
        const granted = authority.use(handle, 'read');
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

    // ONE registry. tools/list renders it and tools/call dispatches from it, so
    // a listed tool cannot silently lack an implementation and an implemented
    // tool cannot stay undiscoverable. The order is the advertised order.
    const toolRegistry = [
      { descriptor: TOOL, run: openWorkspace },
      { descriptor: SCAN_TOOL, run: scanWorkspace },
      { descriptor: CONFIDENCE_TOOL, run: confidenceForWorkspace },
      { descriptor: FRICTION_TOOL, run: rankFriction },
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
module.exports = { createServer, safeOpenError };
