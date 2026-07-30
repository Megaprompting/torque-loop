'use strict';

// Canonical MCP prompts are generated from reference/PROMPTS.md before they reach runtime.
// Traced by: openai-codex-gpt-5

const registry = require('./prompts.generated.json');
const rpc = require('./rpc');

function list() {
  return {
    prompts: registry.prompts.map((entry) => {
      // The generated JSON is cached by require(); deep-copy before crossing the boundary.
      const prompt = structuredClone(entry);
      delete prompt.body;
      for (const argument of prompt.arguments) delete argument.placeholder;
      return prompt;
    }),
  };
}

function get(name, args_) {
  if (typeof name !== 'string') {
    throw rpc.rpcError(-32602, 'prompts/get requires a prompt name');
  }
  const found = registry.prompts.find((entry) => entry.name === name);
  if (!found) throw rpc.rpcError(-32602, `unknown prompt: ${name}`);
  const prompt = structuredClone(found);

  const args = args_ && typeof args_ === 'object' && !Array.isArray(args_) ? args_ : {};
  let body = prompt.body;
  for (const argument of prompt.arguments) {
    const value = args[argument.name];
    if (value === undefined) {
      throw rpc.rpcError(-32602, `missing required prompt argument: ${argument.name}`);
    }
    if (typeof value !== 'string') {
      throw rpc.rpcError(-32602, `prompt argument ${argument.name} must be a string`);
    }
    // split/join inserts client text literally; replacement syntax such as $& stays data.
    body = body.split(argument.placeholder).join(value);
  }

  return {
    description: prompt.description,
    messages: [{
      role: 'user',
      content: { type: 'text', text: body },
    }],
  };
}

module.exports = { get, list };
