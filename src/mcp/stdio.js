'use strict';

// Newline-delimited JSON framing for the MCP stdio transport: one connection
// per attach, one message per line, answers on the output stream, diagnostics
// belong on stderr (the 2026-07-28 revision deprecated protocol logging).
// The adapter owns framing only — every protocol judgment lives in the kernel.

const { StringDecoder } = require('string_decoder');

function attach(kernel, { input, output, maxLineBytes }) {
  const conn = kernel.createConnection();
  const cap = maxLineBytes || 8 * 1024 * 1024; // an honest message fits; a lineless stream must not own our memory
  // A Buffer cut mid-codepoint would corrupt multi-byte characters under a
  // bare String(chunk); the decoder holds the partial bytes until they finish.
  const decoder = new StringDecoder('utf8');
  let buffer = '';
  let overflowing = false;

  function refuse(message) {
    output.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message } }) + '\n');
  }

  function answer(res) {
    let line;
    try {
      line = JSON.stringify(res);
    } catch (e) {
      // A result the kernel accepted but JSON cannot carry (BigInt, cycles)
      // answers on the wire instead of throwing the whole stream away.
      line = JSON.stringify({
        jsonrpc: '2.0', id: typeof res.id === 'object' ? null : res.id,
        error: { code: -32603, message: 'result was not JSON-serializable' },
      });
    }
    output.write(line + '\n');
  }

  input.on('data', (chunk) => {
    buffer += typeof chunk === 'string' ? chunk : decoder.write(chunk);
    let nl;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).replace(/\r$/, '');
      buffer = buffer.slice(nl + 1);
      if (overflowing) { overflowing = false; continue; } // this newline ends the already-refused line
      if (!line.length) continue;
      if (Buffer.byteLength(line) > cap) {
        // The cap is per LINE, not per stall: a complete oversized line is as
        // refused as one that never ends.
        refuse(`line exceeds ${cap} bytes`);
        continue;
      }
      const res = conn.handleMessage(line);
      if (res !== null) answer(res);
    }
    if (overflowing) {
      buffer = ''; // still inside the refused line — discard until its newline arrives
    } else if (Buffer.byteLength(buffer) > cap) {
      overflowing = true;
      refuse(`line exceeds ${cap} bytes without a newline`);
      buffer = '';
    }
  });

  return { connection: conn };
}

module.exports = { attach };
