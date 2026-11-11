---
name: decide
description: Force a single defended choice instead of a menu of options. Use when analysis has produced alternatives but no commitment. Scores options on upside, reversibility, time-to-feedback, strategic compounding, cost-of-being-wrong, and unlock value; returns the chosen path, the most tempting rejected path and why it loses, the first action, and the reversal tripwire.
---

# /ratchet:decide — the anti-menu

A menu of options is not a decision; it is deferred work. This command ends the menu. It
returns one committed choice, defended, with a tripwire that says when to reverse it.

## Step 0 — Load state

```
ratchet status
```

## Procedure

1. **Lay out the live options** — only the ones genuinely on the table. Two to four. If
   there is only one, you don't need this command; if there are ten, cut first.

2. **Score each on six axes** (rate high/med/low, don't fake precision):
   - **Upside** — how good the best case is.
   - **Reversibility** — how cheaply you can undo it.
   - **Time-to-feedback** — how fast reality tells you if it's working.
   - **Strategic compounding** — whether it makes future moves easier.
   - **Cost of being wrong** — the damage if it fails.
   - **Unlock value** — what it makes possible that was blocked.

3. **Choose one.** State it as a decision, not a lean. Prefer reversible, fast-feedback
   options when scores are close — you learn faster and pay less for error.

4. **Name the most tempting rejected option and why it loses.** The one that was hardest
   to say no to. Give the single load-bearing reason it loses, not a list.

5. **Set the reversal tripwire.** The specific observable signal that means: this was
   wrong, reverse now. Without a tripwire, a bad decision runs forever.

## Absorbed moves (the former auction and burn commands live here)

- **When the menu is a set of blockers, rank before choosing.** Score each on leverage,
  certainty, speed-to-unblock and risk-of-ignoring with `ratchet score friction '[...]'`
  and let the highest product name the option; defend it against the most tempting rival.
- **Collect option debt.** Every option neither chosen nor rejected gets a KILL / PARK / KEEP
  verdict with the fear keeping it alive and what gets simpler if it dies. Serialize kills
  and parks as loops so they stop costing attention:
  `ratchet state append openLoops '{"text":"KILLED: <option>","status":"closed"}'` /
  `ratchet state append openLoops '{"text":"PARKED until <trigger>: <option>","status":"open"}'`.

## Output contract

```
CHOSEN: <the decision, stated as committed>
FIRST ACTION: <the immediate move that commits to it>
REJECTED (most tempting): <option> — loses because <load-bearing reason>
REVERSAL TRIPWIRE: <observable signal → reverse>
```

## Serialize

```
ratchet state append decisions '{"choice":"<chosen>","rejected":"<tempting rejected>","tripwire":"<reversal signal>"}'
ratchet state set phase build
```

Next: `/ratchet:build` the first action. A decision without a first action is still a menu.
