![Torque Loop](src/assets/banner.png)

# Torque Loop

[![CI](https://github.com/TheLucidTech/torque-loop/actions/workflows/ci.yml/badge.svg)](https://github.com/TheLucidTech/torque-loop/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-black.svg)](LICENSE)
[![Node.js ≥ 18](https://img.shields.io/badge/node-%E2%89%A518-black.svg)](package.json)

**Mutate. Test. Keep the delta.**

A Claude Code and Codex plugin for evolving one artifact through evidence-gated improvement
loops.

> Not affiliated with, endorsed by, or sponsored by Anthropic or OpenAI.

Torque Loop is **not a prompt library.** A prompt library gives Claude better words. Torque
Loop gives Claude a job:

> **frame → choose → build → attack → patch → serialize → advance**

It bundles two things:

- **The Ratchet command family** (`/ratchet:*`) — a consequence engine that turns ambiguity
  into shipped, falsifiable artifacts through adversarial execution loops.
- **`/ratchet:evolve`** — a narrower, bounded loop that mutates one artifact, tests it, and
  keeps only proven improvement.

Every command produces *pressure*, not just insight. Each one forces a choice, creates an
artifact, tests an artifact, patches a defect, serializes state, kills an option, or pushes
to a higher-yield move. Everything else is smoke.

The whole system is a one-way progress mechanism — it only turns forward, and it remembers
where it stopped. Session state persists to disk, so the next session resumes instead of
restarting. *Ambiguity in. Artifact out. Failure tested. State advanced.*

---

## Install

Torque Loop has two halves: the **agent plugin** (skills/commands, agents, and Claude-only
hooks) and the **`ratchet` CLI** (the state engine the skills call). Claude Code exposes the
skills as `/ratchet:*` slash commands. Codex installs the same skills under the
`torque-loop` plugin and can use them from Codex CLI or the Codex app.

### Requirements

- Claude Code or Codex CLI/app
- Node.js ≥ 18 (`node --version`)
- On Windows, the bundled hooks call the CLI via `node`, so no shell-specific setup is
  needed.

### A. Install as a Claude Code plugin — global

The repo doubles as a single-plugin marketplace, so you can install it directly.

```bash
# 1. get the repo
git clone https://github.com/TheLucidTech/torque-loop.git

# 2. in Claude Code, register it as a marketplace and install
/plugin marketplace add /absolute/path/to/torque-loop
/plugin install ratchet@torque-loop
```

Or point at the GitHub repo without cloning first:

```text
/plugin marketplace add TheLucidTech/torque-loop
/plugin install ratchet@torque-loop
```

Then reload when prompted. Verify with `/help` — you should see the `/ratchet:*` commands.
Manage or remove later from the interactive `/plugin` menu.

### B. Install for a single project only (local, checked into the repo)

Scope the plugin to one project so teammates get it automatically when they open that repo.
Add it to the project's `.claude/settings.json`:

```jsonc
// <your-project>/.claude/settings.json
{
  "plugins": {
    "marketplaces": {
      "torque-loop": { "source": "/absolute/path/to/torque-loop" }
    },
    "install": ["ratchet@torque-loop"]
  }
}
```

Or vendor it directly inside the project and reference the local path. Either way the
commands appear only when that project is open. (Prefer an absolute path, or a path relative
to the settings file, so it resolves on every machine.)

### C. Install as a Codex plugin — CLI

The repo also contains a Codex marketplace manifest at
`.agents/plugins/marketplace.json` and a Codex plugin manifest at
`.codex-plugin/plugin.json`.

```bash
# 1. get the repo
git clone https://github.com/TheLucidTech/torque-loop.git

# 2. register this repo as a Codex marketplace
codex plugin marketplace add /absolute/path/to/torque-loop

# 3. install the plugin from that marketplace
codex plugin add torque-loop@torque-loop

# 4. verify Codex can see it
codex plugin list --marketplace torque-loop
```

For local development, re-run `codex plugin add torque-loop@torque-loop` after manifest
changes, then start a new Codex thread so the refreshed skills are loaded.

### D. Install as a Codex plugin — app

Register the marketplace once with the Codex CLI:

```bash
codex plugin marketplace add /absolute/path/to/torque-loop
```

Then open the Codex app, go to **Plugins**, find **Torque Loop** under Developer Tools,
and install it. The app and CLI share the configured marketplace source.

### E. Install the `ratchet` CLI on its own (optional)

Claude Code puts the bundled CLI on `PATH` while the plugin is enabled. Codex skills can
use a globally installed `ratchet`, or you can run the bundled CLI from the plugin root.

```bash
cd torque-loop

# global — puts `ratchet` on your PATH everywhere
npm install -g .

# or local dev link — symlinks the CLI while you hack on it
npm link

# or no install at all — run it in place
node bin/ratchet --help
```

Verify:

```bash
ratchet --version      # -> ratchet 0.7.0
ratchet init
ratchet status
```

### State location

State survives plugin updates. It is written to, in order of preference:

1. `$CLAUDE_PLUGIN_DATA` — set by Claude Code for enabled plugins.
2. `$RATCHET_DATA_DIR` — override it yourself.
3. `~/.ratchet` — fallback.

State is scoped per project (by working-directory path), so multiple repos never collide in
one shared data directory.

---

## Commands

In Claude Code, run `/ratchet:ignite` when you don't know which command to run — it reads the
task's uncertainty with the **aperture dial** (`ratchet score aperture`) and runs only the loop
depth that earns it: snap to `build → verify` when the task is trivial, open to the full loop
when it isn't. In Codex, ask it to use the matching Torque Loop skill, for example
`torque-loop:ignite` or `torque-loop:evolve`.

> **Provenance — the aperture dial.** The aperture read was grafted from an external
> `auto-aperture` skill fork. Rather than import it wholesale, we examined it against the
> existing loop: most of it already existed under other names (`cut` / `lock` / `decide` /
> `build` / `verify` / `compile`), so we took only its one novel primitive — scoring
> uncertainty to meter how much loop to run — and dropped the rest to avoid a second
> dialect. General mechanism, ratchet's own vocabulary.

### Core loop

| Command | Purpose |
| --- | --- |
| `/ratchet:ignite` | Run the full consequence loop on any messy task. |
| `/ratchet:lock` | Convert vague input into a locked, executable target. |
| `/ratchet:map` | Map the fog before building — walk the four unknown-quadrants, hand over a durable map. |
| `/ratchet:auction` | Rank the real blockers by leverage; pick the one bottleneck. |
| `/ratchet:cut` | Attack the hidden assumptions before you invest. |
| `/ratchet:mechanism` | Name the one mechanism under a confusing situation. |
| `/ratchet:build` | Force artifact production — the smallest usable v0. |
| `/ratchet:attack` | Run the five-voice hostile board. |
| `/ratchet:verify` | Build a harness that could embarrass the artifact, then run it. |
| `/ratchet:patch` | Fix only what failed — minimal REMOVE / ADD / CHANGE delta. |
| `/ratchet:decide` | Force one defended choice with a reversal tripwire. |
| `/ratchet:burn` | Kill or park the options draining your energy. |
| `/ratchet:push` | Push the boundary once a safe version exists. |
| `/ratchet:compile` | Serialize the session into durable state. |
| `/ratchet:status` | Read the current ratchet state. |
| `/ratchet:loop` | Repeat build → attack → patch → compile until it holds. |

> **When to reach for `/ratchet:map`.** High-uncertainty work — aperture **A3–A4**,
> unfamiliar terrain, reference-implementation ports, or "I'll know it when I see it"
> taste. Walk the four unknown-quadrants (known knowns · known unknowns · unknown knowns ·
> unknown unknowns) and hand over the map *before* `/ratchet:build`; at **A4**, stop after
> the map until constraints are locked. The aperture read raises **`Pre-build map:
> required`** for exactly these cases — including a high-`taste` or unfamiliar-`terrain`
> task the summed score would under-rate — so `/ratchet:ignite` routes into the map on its
> own, and it records that fog as an open loop so it drains confidence until the map lands.
> What you deliver is the map, not a build — a wrong assumption caught on the map is a
> one-line fix; caught mid-build it is a rewrite. When an unknown can only be answered by
> touching the repo, the map commissions a **probe**: a time-boxed, reversible,
> build-for-learn spike whose code dies and whose finding lives as a map delta
> (`templates/probe-card.md`). Probe code never ships by inertia — keeping it requires an
> explicit promotion through the normal proof/seam gates.

### Specialized

| Command | Purpose |
| --- | --- |
| `/ratchet:repo-audit` | Discover user-facing features/routes/APIs by code evidence. |
| `/ratchet:qa-ledger` | Create/update the canonical feature/test/defect ledger. |
| `/ratchet:prompt-audit` | Audit a prompt library as an operating system. |
| `/ratchet:handoff` | Produce a compact handoff for another agent or session. |

Every command maps to a canonical prompt. The source prompts live in
[`reference/PROMPTS.md`](reference/PROMPTS.md) — the load-bearing intent each skill
implements.

### Evolution

One narrower, standalone command — a bounded, evidence-gated mutation loop over a **single**
artifact (code file, prompt, skill, README, spec, workflow):

| Command | Purpose |
| --- | --- |
| `/ratchet:evolve` | Mutate → test → keep only proven improvement → serialize the next edge. |

```
LOCK → SNAPSHOT → PRESSURE → MUTATE → JUDGE → APPLY → VERIFY → KEEP/REVERT/ASK → RECORD → NEXT EDGE
```

```bash
/ratchet:evolve src/auth/session.js --goal "reduce login-state race conditions" --test "npm test -- auth" --mode code
/ratchet:evolve README.md --goal "make install impossible to misunderstand" --mode docs
```

It defaults to `--iterations 2` and **proposes** patches without `--write`. Its rule is
absolute: **no proof → no keep; no keep → no progress claim.** It is never a general "make
this better" — it evolves along one chosen pressure vector and records every verdict to
`.ratchet/evolve-log.jsonl` via the `ratchet-evolve` helper CLI.

> Note: in Claude Code, the plugin command is invoked as `/ratchet:evolve` (renamed from
> the older `ratchet-evolve` skill in v0.2.0 — no alias is kept). In Codex, use the
> installed Torque Loop skill, typically surfaced as `torque-loop:evolve`.

#### One run, end to end

```text
Before:    README install path is ambiguous — global vs. project vs. CLI-only blur together.

Command:   /ratchet:evolve README.md --goal "make install impossible to misunderstand" --mode docs

Mutation:  Split install into three labelled paths (global plugin, project-local, CLI-only),
           each with its own verify step. No other section touched.

Verify:    Manual docs checks — first-use path unambiguous, no contradiction, no missing step
           between install and first success. All passed.

Verdict:   KEEP        ← allowed only because evidence exists; the proof gate rejects a bare KEEP

Next edge: Add a 60-second GIF of the plugin install.  (readable later via `ratchet-evolve next`)
```

Every verdict lands in `.ratchet/evolve-log.jsonl`. A `KEEP` without verification evidence is
refused at write time — the loop cannot record progress it did not prove.

---

## Why seam fidelity matters

Torque Loop does not only ask *"was this tested?"* It asks *"was this tested at the seam
you are about to ship?"* A proxy evaluation can produce the right-looking number and still
point at the wrong decision.

In one real session, a proposed replay-only recall-router gate looked like a **+21.4%**
improvement in a fixture-shortlist eval (`apply_strategy` over a force-included lexical
shortlist). A live-seam eval against the actual ship path (`rerank_candidates` over cosine
recall, with no forced gold) showed the opposite: the gate was a **regression**. The flag
was reverted, **no code shipped**, and the router stayed as-is.

That is a successful loop — the outcome Torque Loop now records as `REVERTED_AND_LEARNED`.

> **No proof → no keep.** (v0.2 — the proof gate)
> **Wrong proof → no ship.** (v0.3 — the seam gate)

The seam gate is why a production-code `KEEP` in `/ratchet:evolve` must declare an exact
ship-seam match (or a named human waiver), and why verification that merely repeats the
builder's own search method is rejected as not independent.

### v0.3 state & quality verbs (`ratchet` CLI)

| Command | Purpose |
| --- | --- |
| `ratchet defect resolve <id> --evidence "<proof>"` | Clear a defect — proof required. |
| `ratchet defect waive <id> --owner <name> --reason "<why>"` | Accept the risk; stop the confidence drain. |
| `ratchet defect supersede <id> --by <artifact-id>` | Replace a defect with newer work. |
| `ratchet defect reopen <id> --reason "<why>"` | A resolved defect regressed. |
| `ratchet retract <id> --reason "<why>" [--superseded-by <id>]` | Retract a false/obsolete artifact (provenance kept). |
| `ratchet git status-refs` | Ahead/behind vs every base ref — each one named. |
| `ratchet doctor cold-start` | Scan for stale steering (opt-in surfaces via `.ratchet/cold-start.json`). |

### The receipt — one control surface (`ratchet receipt`)

`ratchet receipt` is the cockpit: one stable read a cold human or agent can parse in under a
minute, so state never lives only in the transcript. Eight fixed sections, same order every
time, emptiness stated rather than omitted:

```text
TARGET · DELTA · PROOF · VERDICT · RISK · AUTHORITY · STATE · NEXT
```

- **PROOF** carries the KEEP evidence card and the seam (tested → ships). If the seam is a
  proxy and not waived, it says **"Cannot justify ship decision"** out loud — proxy proof
  never masquerades as ship proof.
- **VERDICT** splits confidence into three independently-scoped layers so a verified patch is
  never gaslit to *blocked* by unrelated debt:

  | Layer | Answers | Scope |
  | --- | --- | --- |
  | Artifact confidence | Is *this* patch good? | the current artifact's own holes, attached defects, and verification evidence |
  | Session confidence | Can the loop stop? | active open defects, untested assumptions, next action |
  | Ledger health | Is the record clean? | historical open/stale defects and failing tests |

- **AUTHORITY** names where the work sits on the ladder — `uncommitted → committed-local →
  pushed → released` — plus every irreversible action's owner and the gates in force.
- `ratchet receipt --save` writes `.ratchet/current.json` + `.ratchet/current.md` — the
  always-current source-of-truth index a new agent reads first.

---

## How it works

```
skills/*/SKILL.md   →  agent-facing operating discipline (Claude slash commands / Codex skills)
agents/*.md         →  ratchet-builder · ratchet-auditor · ratchet-scribe
hooks/hooks.json    →  Claude-only session-start init · post-edit tracking · stop reminder
bin/ratchet         →  the state CLI (PATH in Claude, global or plugin-root path in Codex)
bin/ratchet-evolve  →  the evolution-loop helper CLI (snapshot · score · verify · log)
src/*.js            →  state, scoring, ledger, artifact indexing, snapshots, rendering
src/evolve/*.js     →  snapshot · pressure · mutation scoring · verify runner · journal
templates/*         →  copy-paste shapes for decision / artifact / defect records
```

The skills carry the reasoning; the CLI carries the state. A skill loads context by calling
the CLI, does its work, and writes the result back:

```bash
ratchet receipt                    # one stable resume read: target·delta·proof·seam·verdict·authority·state·next
ratchet status                     # what the ratchet knows right now
ratchet snapshot repo              # cheap ground-truth read of the codebase
ratchet score friction '[...]'     # rank obstacles: Leverage × Certainty × Time × Risk (1–10)
ratchet score confidence           # three scoped layers: artifact · session · ledger health
ratchet artifact add '{...}'       # record an artifact
ratchet defect add '{...}'         # record a defect (also lands in the QA ledger)
ratchet export markdown            # the full compile / handoff
```

Run `ratchet --help` for the complete surface.

### The agents

- **`ratchet-builder`** — produces the smallest usable artifact; refuses to deliberate.
- **`ratchet-auditor`** — attacks artifacts, assumptions, and self-serving reasoning.
- **`ratchet-scribe`** — serializes state, decisions, defects, and next moves.

**Memory isolation by role.** The registered agents have isolated memory enforced at the CLI
boundary: only the scribe writes canonical state. Builder and auditor are *propose-only* —
run under `RATCHET_AGENT=<name>`, their mutating verbs are refused, so they emit the exact
`ratchet …` command for the caller (or the scribe) to run instead of clobbering the shared
record. Read verbs (`ratchet receipt`, `status`, `snapshot`, `score`) stay open to every
agent. One writer, many proposers — agents cannot overwrite each other's memory.

### The hooks (conservative by design)

Ratchet creates pressure, not surprise. The hooks never run tests or edits on their own:

- **SessionStart** — ensure the data directory exists.
- **PostToolUse** (Write / Edit) — record touched files and mark state dirty.
- **Stop** — if work changed but nothing was compiled, remind you to run `/ratchet:compile`.

---

## Development

```bash
npm test        # zero-dependency smoke test over the state engine
npm run ratchet -- status
```

## Contributing

Contributions that keep the tool small, tested, and falsifiable are welcome. Start with
[`CONTRIBUTING.md`](CONTRIBUTING.md), and note the project's own rule applies to PRs too:
**no proof → no keep.** Please also read the [Code of Conduct](CODE_OF_CONDUCT.md).

Found a security issue? Report it privately — see [`SECURITY.md`](SECURITY.md), not the
public issue tracker.

## License

MIT © 2026 Danny Gillespie

Not affiliated with, endorsed by, or sponsored by Anthropic or OpenAI. "Claude" and
"Claude Code" are trademarks of Anthropic. "Codex" is a trademark of OpenAI.

---

*Torque Loop — tiny claws, big torque.*
