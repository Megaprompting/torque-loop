'use strict';

// MCP prompt generator — DERIVES the registry, so it can never silently lie.
//
// reference/PROMPTS.md is the canonical prompt source, while the installed MCP runtime
// cannot depend on that document being present. This generator turns each declared prompt
// section into deterministic JSON at build time. plugin-shape byte-matches the committed
// artifact against a fresh build, so source edits either regenerate the wire surface or fail.
//
// Scope of truth: section order, command identity, prompt bodies, and arguments all come
// from reference/PROMPTS.md. A bodiless section is navigation; a body without a command is
// malformed source and throws instead of disappearing from the catalogue.
//
// Traced by: openai-codex-gpt-5

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const OUT_REL = path.join('src', 'mcp', 'prompts.generated.json');

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// --- reader --------------------------------------------------------------------------

function promptArguments(body) {
  const found = new Map();
  for (const match of body.matchAll(/\[([A-Z][A-Z ]*)\]/g)) {
    const placeholder = match[0];
    if (found.has(placeholder)) continue;
    const name = match[1]
      .replace(/^PASTE /, '')
      .toLowerCase()
      .replace(/ +/g, '_');
    found.set(placeholder, { name, placeholder, required: true });
  }
  return Array.from(found.values());
}

function sectionHeadings(text) {
  const headings = [];
  const lines = text.split('\n');
  let offset = 0;
  let fence = null;

  lines.forEach((line, index) => {
    if (fence) {
      const close = /^(`{3,}|~{3,})[ \t]*$/.exec(line);
      if (close && close[1][0] === fence.marker && close[1].length >= fence.length) {
        fence = null;
      }
    } else {
      const open = /^[ \t]*(`{3,}|~{3,})/.exec(line);
      if (open) {
        fence = { marker: open[1][0], length: open[1].length };
      } else {
        const heading = /^##[ \t]+(.*)$/.exec(line);
        if (heading) {
          headings.push({
            heading: heading[1].trim(),
            index: offset,
            end: offset + line.length + (index < lines.length - 1 ? 1 : 0),
          });
        }
      }
    }
    offset += line.length + (index < lines.length - 1 ? 1 : 0);
  });

  return headings;
}

function parsePrompts(source) {
  const text = source.replace(/\r\n/g, '\n');
  // Prompt bodies are fenced text and may themselves contain heading-shaped lines.
  // Only document headings outside fences can divide canonical sections.
  const headings = sectionHeadings(text);
  const prompts = [];

  headings.forEach((headingMatch, index) => {
    const heading = headingMatch.heading;
    const start = headingMatch.end;
    const end = index + 1 < headings.length ? headings[index + 1].index : text.length;
    const section = text.slice(start, end);
    const textFenceCount = Array.from(section.matchAll(/^```text[ \t]*$/gm)).length;
    const fences = Array.from(
      section.matchAll(/^```text[ \t]*\n([\s\S]*?)^```[ \t]*(?:\n|$)/gm)
    );

    // A heading with no prompt body is structural navigation, not a prompt to serve.
    if (textFenceCount === 0) return;
    if (textFenceCount > 1) {
      throw new Error(
        `PROMPTS.md section "${heading}" has ${textFenceCount} text fences; expected one prompt body`
      );
    }
    if (fences.length !== 1) {
      throw new Error(`PROMPTS.md section "${heading}" has an unclosed text prompt body`);
    }

    const arrow = heading.indexOf('→');
    const commandPart = arrow === -1 ? '' : heading.slice(arrow + 1);
    const commands = Array.from(
      commandPart.matchAll(/`\/ratchet:([a-z-]+)`/g),
      (match) => match[1]
    );
    if (commands.length === 0) {
      throw new Error(`PROMPTS.md section "${heading}" has a text body but no command arrow`);
    }

    const title = heading.slice(0, arrow).trim();
    const aliases = commands.slice(1).map((name) => `/ratchet:${name}`);
    const description = aliases.length
      ? `${title}. Aliases: ${aliases.join(', ')}.`
      : title;
    const body = fences[0][1];
    prompts.push({
      name: commands[0],
      title,
      description,
      arguments: promptArguments(body),
      body,
    });
  });

  return prompts;
}

// --- builder -------------------------------------------------------------------------

function buildPrompts() {
  const prompts = parsePrompts(read(path.join('reference', 'PROMPTS.md')));
  return JSON.stringify({
    _trace: 'Traced by: openai-codex-gpt-5',
    prompts,
  }, null, 2) + '\n';
}

module.exports = { buildPrompts, OUT_REL, parsePrompts };

// CLI: default writes the artifact; --check fails (exit 1) if the committed file is stale,
// so the regenerate step can be verified outside the test runner too.
if (require.main === module) {
  const generated = buildPrompts();
  const outPath = path.join(ROOT, OUT_REL);
  if (process.argv.includes('--check')) {
    // Normalize CRLF so autocrlf checks content rather than checkout line endings.
    const current = fs.existsSync(outPath)
      ? fs.readFileSync(outPath, 'utf8').replace(/\r\n/g, '\n')
      : null;
    if (current !== generated) {
      process.stderr.write(`DRIFT: ${OUT_REL} is stale. Run: node scripts/prompts-gen.js\n`);
      process.exit(1);
    }
    process.stdout.write(`ok  ${OUT_REL} is in sync\n`);
  } else {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, generated);
    process.stdout.write(`wrote ${OUT_REL}\n`);
  }
}
