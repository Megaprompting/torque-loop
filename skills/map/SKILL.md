---
name: map
description: Map the fog before you build. Use when uncertainty is high (aperture A3–A4), the terrain is unfamiliar, the taste is "I'll know it when I see it", or you are porting a reference implementation. Walks the task through four unknown-quadrants — known knowns (settled ground with file evidence), known unknowns (one blast-radius-ordered question at a time), unknown knowns (tacit taste surfaced by putting something concrete in front of the user), and unknown unknowns (a swept landmine field) — then hands over one durable four-quadrant map, a tweakable build plan, and a copy-paste implementation prompt. What you deliver is the map, not a build; you do not write code until it is handed over.
---

# /ratchet:map — the fog-of-war gate

When uncertainty is high, the expensive mistake is a confident build in the wrong
direction. `/ratchet:lock` says: infer the missing value, name the assumption, move. That
is correct for low-uncertainty work. This command is its counterweight for the
high-uncertainty case — it maps the terrain *before* the build, so a wrong assumption is a
one-line correction on paper instead of a rewrite three PRs deep. **What you deliver is the
map, not a build.** You do not write code until it is handed over.

> Method grafted from the `explore-unknowns` skill; expressed in ratchet's own vocabulary —
> general mechanism, own words, backed by ratchet state. (Same graft discipline as the
> aperture dial.)

Two moves make the walk work:

- **Show, don't ask.** Never make the user describe intent from a blank page. Put something
  concrete in front of them — a sample, a throwaway mock, a few competing directions — and
  let them point at it. Recognition is cheap; invention is expensive.
- **Pre-draft their reply.** Close each turn with lettered options answerable in a few
  characters, so the user reacts instead of composing.

## Step 0 — Load state, then scan the terrain

```
ratchet status
ratchet snapshot repo
```

Scan first. Gather what already exists, what is half-built, and what was tried and
reverted — *before* you open your mouth. Serial questions on unread terrain waste the
user's attention.

## Procedure

Walk the four quadrants **in order**, naming the current one. Disclose material findings
the moment you hit them; never close a quadrant off-screen.

1. **Known knowns — settle the ground.** State the facts, each cited to `file:line`. Mark
   every assumption *separately* and say you will treat it as true until corrected, so a
   wrong premise gets caught now instead of after the build.

2. **Known unknowns — one question at a time.** Ask the single highest-blast-radius
   question first (the answer that reshapes the most), not a wall of them. Give lettered
   options with a **recommended** answer. Close each question exactly one way, in front of
   the user: **user answer**, **territory** (you researched it, then show question +
   finding), **probe** (only touching the repo can answer it — commission a probe card,
   below), or **OPEN** (deferred, with what would unblock it *and the route that will close
   it*: ask-user, probe, park with owner+reason, promote to an assumption with a kill test,
   or a defect).

3. **Unknown knowns — extract the tacit.** The user cannot articulate what they don't know
   they know. Do not ask abstractly. Put something concrete in their hands — sample data, a
   throwaway mock, three or four incompatible renderings of the same thing — and let the
   reaction expose the taste. Probe the offhand context: the downstream consumer, the
   runtime it lands in, the acceptance bar of whoever owns it next. Record what each
   reaction changes.

4. **Unknown unknowns — sweep for landmines.** Hunt the silent failure modes a shallow read
   misses: wrong-by-default data, stale denormalizations, **unwritten conventions** the code
   enforces but no doc records, **prior attempts that were abandoned or rolled back — the
   reason they died is usually the trap you are about to re-hit**, and latent bugs this path
   inherits. Worst first. Each as a card:

   ```
   evidence: <file:line>   why it bites: <mechanism>   what it changes: <task impact>
   status: decided | OPEN | sharp-edge
   ```

5. **Hand over the map.** One page, all four quadrants — shape it like
   `templates/unknowns-map.md` and write it to `.ratchet/unknowns-map-<lane-slug>.md`. OPEN items live
   **on the map**, not buried in chat — and every OPEN item names its route out (ask-user,
   probe, park with owner+reason, assumption+killTest, or defect). An OPEN item with no
   route is a stall with a receipt, not mapped fog. Add a tweakable build plan ordered by
   *what might change* (judgment calls first, routine work compressed at the bottom) and a
   copy-paste implementation prompt. One map per lane: parallel lanes in one repo overwrote a shared `unknowns-map.md`, so the
   bare name is retired. Then stop — implementation is a separate engagement.
   The map stays live through the build: `/ratchet:build` records deviations back onto it.

## Probes — when the map must touch (build-for-learn)

Some fog only appears by touching: an unknown unknown no read can surface, a taste no
question can extract. For those, do not ask harder — commission a **probe**: a time-boxed,
reversible, throwaway build whose proof-of-done is knowledge, not code. Shape it like
`templates/probe-card.md`:

```
PROBE: <the unknown this closes>
- Hypothesis: <what touching should show>
- Smallest reversible touch: <mock | spike | failing test | fixture | instrumentation>
- Allowed surfaces: <files it may touch — nothing else>
- Proof of learning: <the observation that closes the unknown, either way>
- Stop condition: <time-box / attempt cap>
```

**Probe code dies; probe findings live.** Serialize the lifecycle:

```
ratchet artifact add '{"kind":"probe","title":"probe: <unknown>","status":"v0","holes":["disposal: pending"]}'
# run it via /ratchet:build in build-for-learn mode, then — findings first, then dispose:
ratchet state append decisions '{"choice":"<what it settled>","rejected":"<losing hypothesis>","tripwire":"<what reopens it>"}'
ratchet retract <probe-id> --reason "disposed: code reverted; finding recorded as <id>"
```

The `disposal: pending` hole drains confidence until the probe is retracted, and the
cold-start scan flags a live probe as residue — undisposed probe code cannot read clean.
If probe code turns out worth keeping, that is a **promotion**: a fresh `/ratchet:build`
under the full proof/seam gates, then `ratchet retract <probe-id> --reason "promoted: <the
keep-build>" --superseded-by <new-artifact-id>`. The CLI enforces both: a probe retraction
must start `disposed:` or `promoted:`, and a promotion must name its superseder. Nothing
ships because a probe happened to leave it behind. An unfinished probe (stop condition
hit) closes its item as OPEN with what it *did* learn.

## Output contract

```
QUADRANT WALK: current <quadrant> · coverage <n/4> · stopped for user reaction? <yes/no>

KNOWN KNOWNS:
- <settled fact> — evidence: <file:line>
- <assumption> — treated as true until challenged

KNOWN UNKNOWNS:
- Q: <question> | recommend: <lettered answer> | closed by: user | territory | probe | parked(owner) | OPEN + route | unblocks: <what>

PROBES (if any commissioned):
- probe: <unknown> | hypothesis: <expected> | touch: <smallest reversible> | stop: <time-box>

UNKNOWN KNOWNS:
- tacit constraint: <extracted> | reshaped the target: <how>

UNKNOWN UNKNOWNS:
- landmine: <name> | evidence: <file:line> | why it bites: <mechanism> | changes: <impact> | status: decided | OPEN | sharp-edge

HANDOVER MAP: path <.ratchet/unknowns-map-<lane-slug>.md> · OPEN items <n> · build plan <yes/no>
IMPLEMENTATION PROMPT: <copy-paste line that launches the build with the map's context>
```

## Serialize

The map is durable state, not scrollback. Record it so the next context resumes cold:

```
ratchet artifact add '{"kind":"unknown-map","title":"unknowns map: <target>","status":"handoff","path":".ratchet/unknowns-map-<lane-slug>.md","holes":["<each OPEN item>"]}'
ratchet state append decisions  '{"choice":"<closed known-unknown>","rejected":"<the option not taken>","tripwire":"<what would reopen it>"}'
ratchet state append assumptions '{"text":"<tacit/working assumption>","killTest":"<cheapest falsification>","status":"untested"}'
ratchet state append openLoops   '{"text":"OPEN: <question> — unblocks: <what>","status":"open"}'
ratchet state set phase cut
ratchet state set nextCommand "/ratchet:build"
```

Real landmines that are actual failures (not just sharp edges) are defects, not notes:

```
ratchet defect add '{"severity":"high","summary":"<landmine that will bite the build>"}'
```

The map's OPEN loops, untested assumptions, and artifact holes all drain
`ratchet score confidence` on purpose — an unclosed unknown is tracked pressure, not a
forgotten one. The score cannot read ship-ready while the fog is still on the board.

The CLI holds both ends of the fog loop itself: `ratchet score aperture` records
`fog: pre-build map required` as an open loop the moment `mapRequired` fires (writer
callers), and `ratchet artifact add` with `kind:"unknown-map"` closes it when the map
lands — scored fog can never live only on stdout.

## Meter — when to reach for this

Run `/ratchet:map` when the aperture earns it, not on a reversible one-liner:

```
ratchet score aperture '{"ambiguity":_,"terrain":_,"taste":_,"blastRadius":_,"reversibility":_}'
```

- **A0–A2** → don't. `/ratchet:lock` + infer-and-build is the right, anti-ceremony move.
- **A3** → map the fog, then build.
- **A4** → map the fog, hand over the plan/options, and **stop** — do not build until
  constraints are locked.

Also reach for it directly (whatever the score) on a reference-implementation port, an
"I'll know it when I see it" request, or a mid-build deviation that needs capturing.

Next: when the map is handed over and the user picks the build plan → `/ratchet:build`.
At A4, lock the open constraints first (`/ratchet:lock`) and stop before building.
