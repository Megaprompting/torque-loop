---
name: handoff
description: Produce a compact handoff for another model, agent, teammate, or future session. Use when work must transfer without losing state. Returns a self-contained brief — objective, what's done, what's decided, what's open, the exact next action, and the context needed to act — compressed so the receiver can start immediately with zero re-derivation.
---

# /ratchet:handoff — transfer without loss

A handoff fails when the receiver has to reconstruct what you already knew. This command
produces a self-contained brief that lets another model, agent, teammate, or future you
start acting immediately — no re-reading the session, no re-deriving decisions.

## Step 0 — Load state

```
ratchet receipt
ratchet export markdown
ratchet score confidence
```

Start from `ratchet receipt` — its eight fixed sections (target · delta · proof · seam ·
verdict · authority · state · next) are already the handoff spine; the steps below expand
each one for the receiver. Delegate to the `ratchet-scribe` subagent for a long or
high-stakes session.

## Procedure

Compress the session to exactly what the receiver needs to act — and nothing they'd have
to skim past:

1. **Objective** — the locked target, one line.
2. **State of play** — what's done, what's in flight, current confidence.
3. **Decisions made** — commitments + their reversal tripwires (so the receiver doesn't
   relitigate settled calls).
4. **Artifacts** — what exists, where, and each one's known holes.
5. **Open defects / risks** — by severity.
6. **The single next action** — the exact first move, concrete enough to start on.
7. **Context to act** — the minimum files, commands, or facts the receiver needs. Point to
   locations; don't paste the world.
8. **Watch-outs** — the traps you already hit or foresee.
9. **Deviations from the map** — if `/ratchet:map` ran, where the build diverged from its
   plan (map said X → code revealed Y → call made) and which calls still need the user's
   judgment. This is what stops the receiver from re-litigating what you already discovered.
10. **Probe outcomes** — for each probe: the unknown it attacked, the finding, and whether
    its code was **disposed** or explicitly **promoted**. An undisposed probe is a
    watch-out, not an asset — the receiver must not mistake build-for-learn residue for
    kept work.

## Rules

- **Self-contained.** If the receiver needs to ask you a question to start, the handoff
  failed. Anticipate the first question and answer it.
- **Compressed, not lossy.** Cut commentary; keep every fact that changes a move.
- **One next action, not a menu.** Handoffs die in ambiguity — name the single move.

## Output contract

```
# Handoff: <working title>
OBJECTIVE: <one line>
STATE: <done / in-flight / confidence score>
DECISIONS: <commitment — tripwire> (each)
ARTIFACTS: <title — location — holes> (each)
OPEN RISKS: <[severity] summary> (each)
NEXT ACTION: <the single concrete first move>
CONTEXT TO ACT: <files / commands / facts, by location>
WATCH-OUTS: <traps>
DEVIATIONS: <map said X → code revealed Y → call made> (each, if a map ran)
PROBES: <unknown → finding → disposed | promoted> (each, if any ran)
NEXT COMMAND: /ratchet:<command>
```

## Serialize

```
ratchet artifact add '{"title":"handoff brief","kind":"decision-record","status":"v0"}'
ratchet compile done
```

`ratchet compile done` is the only checkpoint transition — `state set lastCompileAt`
is refused, because a checkpoint you can assert by hand records nothing. It prints
the next required transition; a handoff that ends on a checkpoint says CHECKPOINTED,
not CLOSED, and names what closing would still take.

A good handoff is measured by one thing: the receiver's first action is correct without
asking you anything.
