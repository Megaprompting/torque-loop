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

const handles = require('./handles');
const repository = require('./repository');
const rpc = require('./rpc');
const workspace = require('./workspace');
const receipt = require('../receipt');
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

function safeOpenError(error) {
  if (error && error.code === 'ERATCHETPATHESCAPE') {
    return 'workspace path is outside the configured roots';
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

function createServer(options) {
  const opts = options || {};
  const roots = workspace.createRoots(opts.roots);
  const discoverer = repository.createDiscovery({ roots });
  const registry = handles.createRegistry({ roots });
  const info = Object.freeze({
    name: (opts.serverInfo && opts.serverInfo.name) || 'torque-mcp',
    version: (opts.serverInfo && opts.serverInfo.version) || pkg.version,
  });
  const capabilities = Object.freeze({ tools: Object.freeze({}), resources: Object.freeze({}) });

  function createConnection(options_) {
    const connectionOptions = options_ || {};
    const authority = registry.open({ client: connectionOptions.client });
    // The canonical root is the authority fact. A digest is useful as an
    // opaque identity on the wire, but it must never become the equality check
    // that decides whether two filesystem capabilities are one grant.
    const byRoot = new Map();
    const byHandle = new Map();
    let closed = false;

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
        // means something once the canonical state record it counts exists.
        snapshot = state.loadState(found.root);
      } catch (error) {
        return toolError(safeOpenError(error));
      }

      let record = byRoot.get(found.root);
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

    function parseResource(uri) {
      if (typeof uri !== 'string') return null;
      const match = RESOURCE_PATTERN.exec(uri);
      if (!match) return null;
      return { handle: match[1], name: match[2] };
    }

    function resourceRecord(uri) {
      const parsed = parseResource(uri);
      if (!parsed) throw rpc.rpcError(-32602, RESOURCE_UNAVAILABLE);
      const record = byHandle.get(parsed.handle);
      if (!record) throw rpc.rpcError(-32602, RESOURCE_UNAVAILABLE);
      try {
        const granted = authority.use(parsed.handle, 'read');
        if (granted.kind !== 'directory' || granted.path !== record.root) {
          throw rpc.rpcError(-32602, RESOURCE_UNAVAILABLE);
        }
      } catch (_error) {
        throw rpc.rpcError(-32602, RESOURCE_UNAVAILABLE);
      }
      return { parsed, record };
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
          return withCache({ tools: [TOOL] }, context.era, LIST_TTL_MS, 'public');
        },
      },
      'tools/call': {
        eras: ['modern', 'legacy'],
        handler: (params) => {
          if (typeof params.name !== 'string') {
            throw rpc.rpcError(-32602, 'tools/call requires a tool name');
          }
          if (params.name !== TOOL.name) {
            throw rpc.rpcError(-32602, `unknown tool: ${params.name}`);
          }
          return openWorkspace(params.arguments);
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

module.exports = { createServer };
