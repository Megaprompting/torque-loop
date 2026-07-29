---
name: compile
description: Serialize the current session into durable state — the breadcrumb the next session resumes from. Use at the end of a work session or after any real advance. Returns working title, objective, decisions, artifacts, defects/risks, open loops, next action, next command, retrieval tags, and a one-sentence memory. Only keeps information that changes future behavior.
---

# /ratchet:compile — the state compiler

A session that isn't compiled evaporates. This command writes the breadcrumb: the compact
record that lets the next agent — or you after a context reset — resume without
re-deriving anything. Persistence has compression discipline: only what changes future
behavior survives.

## Step 0 — Load current state

```
ratchet status --json
```

Extend the existing record; do not overwrite it. For a heavy session, delegate to the
`ratchet-scribe` subagent.

## What to serialize (and nothing else)

Save only: **decisions, artifacts, defects, open loops, next action, next prompt.** Delete
interesting-but-nonoperative commentary. If it won't change a future move, it doesn't go in.

1. **Working title** — a handle you'd recognize in a list of sessions.
2. **Current objective** — the locked target, one line.
3. **Decisions made** — actual commitments, with the rejected tempting option and tripwire.
4. **Artifacts created** — title, kind, status, path, known holes.
5. **Defects / risks found** — severity + summary + status.
6. **Open loops** — what's unfinished and what would close it.
7. **Next action** — the single immediate move.
8. **Next prompt/command** — the exact `/ratchet:...` to run next.
9. **Retrieval tags** — comma-separated handles for future search.
10. **One-sentence memory** — the single line worth saving. Make it load-bearing.

## Serialize (write it all through the CLI)

```
ratchet state set title "<working title>"
ratchet state set nextAction "<single next move>"
ratchet state set nextCommand "/ratchet:<command>"
ratchet state append decisions '{"choice":"...","rejected":"...","tripwire":"..."}'   # if any new
ratchet artifact add '{"title":"...","kind":"...","status":"...","holes":["..."]}'    # if any new
ratchet defect add '{"severity":"...","summary":"...","artifact":"<id>"}'              # if any new
ratchet state append openLoops '{"text":"..."}'                                        # if any
ratchet state set phase compile
ratchet compile done
```

A defect is born open — the CLI refuses a terminal birth status. Clearing one is a
transition with proof: `ratchet defect resolve <id> --evidence "..."`.

`ratchet compile done` clears the dirty flag, stamps `lastCompileAt`, and records a
`compile.done` history event in one atomic move — which silences the Stop-hook nag. (Run it
last: a `state set` after it would re-dirty the session.)

**CHECKPOINT is not CLOSED.** `compile done` prints `CHECKPOINTED, NOT CLOSED` and the next
required transition, because serializing says the record is current — never that the work
is finished. An artifact is finished only when a KEEP is bound to its exact revision and
you run:

```
ratchet artifact close <id>
```

Report the checkpoint as a checkpoint. If the run also closed the artifact, say CLOSED and
name the proof id; otherwise say what closing still needs. Then emit the record:

```
ratchet export markdown
```

## Output contract

Return the exported markdown, followed by:

```
ONE-SENTENCE MEMORY: <the single priming line>
RETRIEVAL TAGS: <comma,separated,handles>
NEXT: <action> → /ratchet:<command>
```

The ratchet only advances if state advances. Compile is how the turn becomes permanent.
