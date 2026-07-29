# Contributing to Torque Loop

Thanks for turning the wrench. This project is a Claude Code plugin plus a small,
zero-dependency state CLI. Contributions that keep it **small, tested, and falsifiable**
are welcome.

## Ground rules

Torque Loop's whole point is *evidence-gated progress*: **no proof → no keep.** The same
rule applies to contributions.

- Keep the CLI **dependency-free.** `package.json` has zero runtime dependencies and that is
  a feature. A PR that adds one needs a strong, stated reason.
- Every behavior change ships with a test.
- Match the surrounding voice: terse, concrete, no filler.

## Getting set up

Requires [Node.js](https://nodejs.org) ≥ 18.

```bash
git clone https://github.com/Megaprompting/torque-loop.git
cd torque-loop
npm test            # runs the full smoke suite (no install step needed — zero deps)
```

Useful during development:

```bash
node bin/ratchet --help          # run the state CLI in place
node bin/ratchet-evolve --help   # run the evolution-loop helper
npm link                         # symlink `ratchet` onto your PATH while you hack
```

## Making a change

1. **Open an issue first** for anything non-trivial, so the design gets discussed before the
   code exists.
2. Branch from `main`.
3. Make the change. Add or update a test in `test/` that would fail without it.
4. Run `npm test` — all suites must pass.
5. Keep the diff minimal: REMOVE / ADD / CHANGE only what the change requires.
6. Open a PR using the template. Describe *what failed before* and *what proves it works now*.

## Where things live

| Path | What it is |
| --- | --- |
| `skills/*/SKILL.md` | The Claude-facing slash commands (`/ratchet:*`). |
| `agents/*.md` | The three sub-agents: builder · auditor · scribe. |
| `hooks/hooks.json` | SessionStart / PostToolUse / Stop hooks (conservative by design). |
| `bin/ratchet`, `bin/ratchet-evolve` | CLI entrypoints. |
| `src/*.js` | State, scoring, ledger, snapshots, rendering. |
| `src/evolve/*.js` | The evolution-loop internals. |
| `templates/*` | Copy-paste record shapes. |
| `test/*.test.js` | The smoke suites. |
| `reference/PROMPTS.md` | The canonical source prompts each skill implements. |

## Style

- CommonJS, Node ≥ 18, no build step.
- No new runtime dependencies without discussion.
- Skills and docs: short lines, active voice, wrench energy — but never at the cost of being
  clear about what a command actually *does*.

## Reporting bugs & security issues

- **Bugs:** open a [bug report issue](../../issues/new/choose).
- **Security vulnerabilities:** do **not** open a public issue — see [SECURITY.md](SECURITY.md).

## Licensing

By contributing, you agree that your contributions are licensed under the
[MIT License](LICENSE) that covers this project.
