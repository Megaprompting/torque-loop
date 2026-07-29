'use strict';

// Torque MCP build-order step 1: the RPC kernel and nothing else. No tools, no
// resources, no state — those arrive in later steps through the `methods` table.
//
// Era pinning is the one invariant this module exists to enforce: a connection
// speaks exactly one protocol era. `server/discover` (protocol 2026-07-28,
// stateless, _meta-carried version) pins modern; `initialize` (2025-11-25
// handshake) pins legacy; after the pin, the other era's surface is a named
// refusal — never a silent downgrade, never a mixed connection. Mixing is how a
// stateless request inherits handshake state it never negotiated.

const JSONRPC = '2.0';
const META = 'io.modelcontextprotocol/';

// One modern version, one legacy version — the boundary is named, not open-ended.
// Widening either list is a deliberate compatibility decision, not a default.
const MODERN_VERSION = '2026-07-28';
const LEGACY_VERSION = '2025-11-25';

// JSON-RPC standard codes.
const ERR_PARSE = -32700;
const ERR_INVALID_REQUEST = -32600;
const ERR_METHOD_NOT_FOUND = -32601;
const ERR_INTERNAL = -32603;
// MCP-allocated range (-32020..-32099), per the 2026-07-28 allocation policy.
const ERR_UNSUPPORTED_PROTOCOL_VERSION = -32022;
// Implementation-defined range is -32000..-32019; -32000..-32002 are avoided
// because grandfathered SDK usage already squats there.
const ERR_ERA_PINNED = -32010;

function rpcError(code, message, data) {
  const err = new Error(message);
  err.rpc = { code, message };
  if (data !== undefined) err.rpc.data = data;
  return err;
}

function errorResponse(id, code, message, data) {
  const error = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: JSONRPC, id: id === undefined ? null : id, error };
}

function createKernel({ serverInfo, capabilities, methods }) {
  const table = Object.assign({}, methods || {});
  const caps = capabilities || {};
  const info = serverInfo || { name: 'torque-mcp', version: '0.0.0' };

  function methodEras(name) {
    if (name === 'server/discover') return ['modern'];
    if (name === 'initialize' || name === 'notifications/initialized') return ['legacy'];
    return table[name] ? table[name].eras : null;
  }

  function createConnection() {
    let era = null;

    function requireModernVersion(msg) {
      const meta = (msg.params && msg.params._meta) || {};
      const version = meta[META + 'protocolVersion'];
      if (version === MODERN_VERSION) return meta;
      const said = version === undefined ? 'no protocol version' : `protocol version ${version}`;
      throw rpcError(
        ERR_UNSUPPORTED_PROTOCOL_VERSION,
        `request carried ${said}; this server speaks ${MODERN_VERSION} ` +
          `(_meta ${META}protocolVersion on every request) or the legacy ${LEGACY_VERSION} initialize handshake`
      );
    }

    function eraRefusal(method) {
      return rpcError(
        ERR_ERA_PINNED,
        `this connection is pinned to the ${era} era and ${method} belongs to the other one — ` +
          'eras never mix on a connection; reconnect to switch'
      );
    }

    // Built-ins pin the era. Everything else routes through the method table.
    function dispatch(msg) {
      const method = msg.method;

      if (method === 'initialize') {
        if (era === 'modern') throw eraRefusal(method);
        if (era === 'legacy') throw rpcError(ERR_INVALID_REQUEST, 'initialize already ran on this connection');
        era = 'legacy';
        const requested = msg.params && msg.params.protocolVersion;
        return {
          protocolVersion: requested === LEGACY_VERSION ? requested : LEGACY_VERSION,
          capabilities: caps,
          serverInfo: info,
        };
      }

      if (method === 'server/discover') {
        if (era === 'legacy') throw eraRefusal(method);
        era = 'modern';
        return {
          protocolVersions: [MODERN_VERSION, LEGACY_VERSION],
          capabilities: caps,
          serverInfo: info,
        };
      }

      if (method === 'notifications/initialized') {
        if (era !== 'legacy') throw eraRefusal(method);
        return null;
      }

      const entry = table[method];
      if (!entry) throw rpcError(ERR_METHOD_NOT_FOUND, `method not found: ${method}`);

      if (era === null) {
        // No pin yet and not a handshake verb: only a modern stateless request
        // can stand on its own — it must prove its version, and doing so pins.
        requireModernVersion(msg);
        era = 'modern';
      } else if (era === 'modern') {
        // Stateless means every request re-proves its version; the pin only
        // guards the era boundary, it never carries negotiation state forward.
        requireModernVersion(msg);
      }

      if (!entry.eras.includes(era)) throw eraRefusal(method);

      return entry.handler(msg.params || {}, { era, serverInfo: info });
    }

    function handleMessage(raw) {
      let msg = raw;
      if (typeof raw === 'string') {
        try {
          msg = JSON.parse(raw);
        } catch (e) {
          return errorResponse(null, ERR_PARSE, 'unparseable JSON');
        }
      }

      if (Array.isArray(msg)) {
        return errorResponse(null, ERR_INVALID_REQUEST, 'batch requests were removed from MCP; send one message per line');
      }
      if (!msg || typeof msg !== 'object' || msg.jsonrpc !== JSONRPC || typeof msg.method !== 'string') {
        return errorResponse(msg && msg.id, ERR_INVALID_REQUEST, 'not a JSON-RPC 2.0 request');
      }

      const isNotification = msg.id === undefined;
      let result;
      try {
        result = dispatch(msg);
        // A JSON-RPC result is an object or it is nothing — validated inside
        // the try so a bad handler answers -32603 instead of crashing the
        // decoration below and taking the connection with it.
        if (!isNotification && (typeof result !== 'object' || result === null || Array.isArray(result))) {
          throw rpcError(ERR_INTERNAL, `handler for ${msg.method} returned a non-object result`);
        }
      } catch (e) {
        if (isNotification) return null; // no channel to answer on — drop, never crash
        const rpc = e && e.rpc ? e.rpc : { code: ERR_INTERNAL, message: 'internal error' };
        return errorResponse(msg.id, rpc.code, rpc.message, rpc.data);
      }
      if (isNotification) return null;

      if (era === 'modern') {
        // Modern results always name themselves: resultType is required by the
        // protocol, and serverInfo travels in _meta because there is no
        // handshake left to have said it once. Decoration works on a copy — the
        // handler's object may be frozen or shared across requests.
        result = Object.assign({}, result);
        if (result.resultType === undefined) result.resultType = 'complete';
        result._meta = Object.assign({}, result._meta, { [META + 'serverInfo']: info });
      }
      return { jsonrpc: JSONRPC, id: msg.id, result };
    }

    return { handleMessage, era: () => era };
  }

  return { createConnection };
}

module.exports = {
  createKernel,
  rpcError,
  MODERN_VERSION,
  LEGACY_VERSION,
  ERR_ERA_PINNED,
  ERR_UNSUPPORTED_PROTOCOL_VERSION,
};
