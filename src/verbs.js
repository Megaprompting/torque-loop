'use strict';

// Domain verbs shared by the CLI and the MCP write tools. One implementation,
// two boundaries: the CLI router and the MCP server both dispatch INTO these,
// so the two surfaces cannot drift into two meanings for one verb. Extracted
// verb-by-verb as MCP step 4 ships each tool (spec: 2026-07-31 write tools);
// verbs the MCP surface does not expose stay inline in cli.js.
//
// A verb takes the OPEN transaction's state object and mutates it. It never
// loads, saves, locks, or checks revisions — that is the boundary's job. The
// id minter is a parameter because the two boundaries mint differently: the
// CLI has no retry, so ids are random (state.makeId); an MCP write can be
// retried across a crash, so ids derive from the operation and re-application
// converges on the same record instead of duplicating it.
//
// Traced by: claude-fable-5

const schemas = require('./schemas');

function coerceScalar(key, value) {
  if (key === 'dirty') return value === 'true' || value === true;
  if (key === 'confidence') return value === '' ? null : Number(value);
  return value;
}

// `state set`: assign one settable scalar, mark the session dirty, and record
// the assignment in history. Key validation is the caller's (both boundaries
// refuse before entering the transaction); the mutation itself is the shared
// meaning.
function setScalar(s, key, value, mintId) {
  s[key] = coerceScalar(key, value);
  if (key !== 'dirty') s.dirty = true;
  s.history.push({ id: mintId('hist', 'history'), at: schemas.nowIso(), event: 'state.set', note: `${key} = ${value}` });
}

module.exports = { coerceScalar, setScalar };
