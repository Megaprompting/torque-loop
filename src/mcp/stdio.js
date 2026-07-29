'use strict';

// Newline-delimited JSON framing for the MCP stdio transport: one connection
// per attach, one message per line, answers on the output stream, diagnostics
// belong on stderr (the 2026-07-28 revision deprecated protocol logging).
// The adapter owns framing only — every protocol judgment lives in the kernel.
//
// Lines are split as BYTES and decoded per complete line: decoding the stream
// eagerly corrupts multi-byte characters cut at a chunk boundary, and hides
// invalid UTF-8 behind silent replacement characters. A decoded line is valid
// only if it re-encodes to the same bytes — which still admits a legitimate
// U+FFFD, because its honest bytes round-trip.

function attach(kernel, { input, output, maxLineBytes }) {
  const conn = kernel.createConnection();
  const cap = maxLineBytes || 8 * 1024 * 1024; // an honest message fits; a lineless stream must not own our memory
  let buffer = Buffer.alloc(0);
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
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
    buffer = buffer.length ? Buffer.concat([buffer, bytes]) : bytes;
    let nl;
    while ((nl = buffer.indexOf(0x0a)) !== -1) {
      let line = buffer.subarray(0, nl);
      buffer = buffer.subarray(nl + 1);
      if (overflowing) { overflowing = false; continue; } // this newline ends the already-refused line
      if (line.length && line[line.length - 1] === 0x0d) line = line.subarray(0, line.length - 1);
      if (!line.length) continue;
      if (line.length > cap) {
        // The cap is per LINE, not per stall: a complete oversized line is as
        // refused as one that never ends.
        refuse(`line exceeds ${cap} bytes`);
        continue;
      }
      const text = line.toString('utf8');
      if (!Buffer.from(text, 'utf8').equals(line)) {
        refuse('line is not valid UTF-8');
        continue;
      }
      const res = conn.handleMessage(text);
      if (res !== null) answer(res);
    }
    if (overflowing) {
      buffer = Buffer.alloc(0); // still inside the refused line — discard until its newline arrives
      return;
    }
    // A trailing \r may be half of a CRLF whose \n is in the next chunk — it is
    // framing, not content, so it does not count against the cap.
    const pending = buffer.length && buffer[buffer.length - 1] === 0x0d ? buffer.length - 1 : buffer.length;
    if (pending > cap) {
      overflowing = true;
      refuse(`line exceeds ${cap} bytes without a newline`);
      buffer = Buffer.alloc(0);
      return;
    }
    // subarray keeps its parent's allocation alive, so the tail of a huge line
    // would hold that whole line's memory for as long as the tail lives. Copy
    // the remainder off it: the cap must bound what we actually retain, not
    // just what we count.
    if (buffer.buffer.byteLength > cap && buffer.length < buffer.buffer.byteLength) {
      buffer = Buffer.from(buffer);
    }
  });

  // Diagnostic: bytes this adapter is actually holding, allocation included.
  // Exposed so the cap's real invariant is checkable from outside.
  return { connection: conn, retainedBytes: () => buffer.buffer.byteLength };
}

module.exports = { attach };
