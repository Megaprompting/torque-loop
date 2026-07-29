'use strict';

// Newline-delimited JSON framing for the MCP stdio transport: one connection
// per attach, one message per line, answers on the output stream, diagnostics
// belong on stderr (the 2026-07-28 revision deprecated protocol logging).
// The adapter owns framing only — every protocol judgment lives in the kernel.

function attach(kernel, { input, output, maxLineBytes }) {
  const conn = kernel.createConnection();
  const cap = maxLineBytes || 8 * 1024 * 1024; // an honest message fits; a lineless stream must not own our memory
  let buffer = '';
  let overflowing = false;

  input.on('data', (chunk) => {
    buffer += String(chunk);
    if (buffer.indexOf('\n') === -1 && buffer.length > cap) {
      // Refuse once per oversized line, then discard until its newline arrives.
      if (!overflowing) {
        overflowing = true;
        output.write(JSON.stringify({
          jsonrpc: '2.0', id: null,
          error: { code: -32700, message: `line exceeds ${cap} bytes without a newline` },
        }) + '\n');
      }
      buffer = '';
      return;
    }
    if (overflowing) {
      const end = buffer.indexOf('\n');
      if (end === -1) { buffer = ''; return; }
      buffer = buffer.slice(end + 1);
      overflowing = false;
    }
    let nl;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).replace(/\r$/, '');
      buffer = buffer.slice(nl + 1);
      if (!line.length) continue;
      const res = conn.handleMessage(line);
      if (res !== null) output.write(JSON.stringify(res) + '\n');
    }
  });

  return { connection: conn };
}

module.exports = { attach };
