# Security Policy

## Supported versions

Torque Loop is pre-1.0. Security fixes are applied to the latest released version on `main`.

| Version | Supported |
| --- | --- |
| 0.1.x | ✅ |
| < 0.1 | ❌ |

## Reporting a vulnerability

**Please do not report security vulnerabilities through public GitHub issues.**

Report privately through GitHub's confidential channel:

1. Go to the repository's **Security** tab.
2. Click **Report a vulnerability** (or use
   [this link](https://github.com/Megaprompting/torque-loop/security/advisories/new)).
3. Describe the issue with enough detail to reproduce it.

You should get an acknowledgement within a few days. We'll confirm the issue, work on a fix,
and coordinate a disclosure timeline with you.

## Scope

Torque Loop is a Claude Code plugin and a **zero-dependency**, local Node.js CLI. It has no
network surface and no runtime dependencies. The most relevant areas for security review are:

- **Local file & state handling** — the CLI reads and writes state under the resolved data
  directory (`$CLAUDE_PLUGIN_DATA`, `$RATCHET_DATA_DIR`, or `~/.ratchet`).
- **Hooks** — the bundled hooks (`hooks/hooks.json`) run on session events. By design they
  never run tests or edits on their own; a hook that executes something unexpected is a bug
  worth reporting.
- **Command / shell construction** — anywhere user- or model-supplied input reaches a shell
  or file path.

## Out of scope

- Vulnerabilities in Claude Code, Node.js, or the operating system themselves.
- Social-engineering or issues requiring a compromised local machine or a maliciously
  modified checkout.

Thank you for helping keep the project and its users safe.
