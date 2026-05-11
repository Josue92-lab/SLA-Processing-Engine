# Reassignment count and SLA confidence

Operational guidance for future modernization phases.
**Do not implement during Phase 1b.** Architectural/domain guidance only.

## What ServiceNow exposes

ServiceNow exports to this engine do **not** include:

- assignment-group transition history
- the timestamp at which a ticket entered the L1.5 operational queue

The only currently-exported signal related to reassignment is:

- `Reassignment count` — a monotonic integer on the ticket

## What that means operationally

- `reassignment_count == 0` usually means the ticket entered directly into the
  L1.5 queue. The exported `Created` timestamp is a reasonable proxy for the
  start of our SLA responsibility.
- `reassignment_count > 0` usually means the ticket spent an unknown amount of
  time in another support queue before reaching L1.5. The exported `Created`
  timestamp may predate L1.5 ownership by an unknown margin.

Our SLA responsibility begins when the ticket reaches L1.5, **not** when it
was originally created in ServiceNow.

## Why this is *not* a simple manual-review trigger

`reassignment_count > 0` alone **must not** be treated as a manual-review
signal. Many reassigned tickets still have perfectly valid SLA calculations
and must remain classified as `fulfilled` / `unfulfilled` under the normal
rules. Blindly routing every reassigned ticket to manual review would flood
the analyst queue and erode the value of the `Revisar manualmente` verdict.

The issue is **confidence, not reassignment itself.** The two questions
product cares about are different:

- *Did the team meet the SLA?* — answered by the existing rule evaluation.
- *How confident are we in that answer, given what the export tells us about
  ownership timing?* — answered (or not) separately.

When `reassignment_count > 0`, the exported `Created` timestamp may predate
L1.5 ownership by an unknown margin, so SLA deltas that *just barely*
exceed the threshold still carry the same attribution confidence they
always did, but deltas that *massively* exceed the threshold become
impossible to distinguish from "looks huge because it includes pre-L1.5
queue time". Those are the ones that need the confidence verdict.

## Intended operational behavior

Expressed as three disjoint cases, which is the specification a future
implementation must match:

1. `reassignment_count == 0` → evaluate normally. The exported `Created`
   timestamp is a reasonable proxy for the start of L1.5 ownership.
2. `reassignment_count > 0` **with reasonable SLA deltas** → still evaluate
   normally. Reassignment alone does not change the verdict.
3. `reassignment_count > 0` **with abnormally large deltas** → mark as
   `Revisar manualmente` (low confidence). The breach magnitude cannot be
   attributed reliably because the ownership timestamp is not reconstructible
   from the export.

Case 3 is the only one that changes behavior relative to today. Cases 1 and
2 are byte-for-byte identical to the current engine.

The "abnormally large" threshold is a calibration parameter, not a constant
in code. It is to be tuned against historical data with product sign-off
before the first tuned value ships, and lives in settings / policy — not in
`domain/slaRules.js`.

## Future design direction (not for Phase 1b)

A confidence-adjustment layer applied **after** SLA classification — never
inside `domain/slaRules.js` or `domain/vip.js`, which must remain pure rule
evaluators.

### Shape of the layer

Working module name: `domain/slaConfidence.js`. It consumes the output of
`classifySla` + the ticket's `reassignment_count`, and may downgrade the
verdict from `unfulfilled` to `Revisar manualmente`. It never upgrades a
verdict, never touches `fulfilled` tickets, and never looks at the timeline
directly (see "Constraints" below).

### Verdict semantics after the layer runs

The existing `"Revisar manualmente"` verdict acquires a second meaning:

- Pre-existing: "we could not infer a response at all" (emitted by
  `classifySla` for non-P3/P4 priorities or when `date2` is empty — see
  `.kiro/steering/phase-1b-summary.md` §3.6).
- New: "we inferred an unfulfilled verdict, but attribution confidence is
  too low to stand behind it".

Both cases land in the same output bucket, which is a pragmatic overload —
the operational team already reviews that bucket manually, and adding the
low-confidence cases to it matches the existing workflow. If downstream
reporting ever needs to distinguish the two meanings, the confidence layer
should record them with an explicit reason code in the audit trail (see
"Auditability" below) rather than introducing a fourth verdict string and
reworking the dashboard layout.

### Trigger definition

A verdict is eligible for confidence downgrade when **both**:

1. `reassignment_count > 0`, AND
2. the classified verdict is `unfulfilled` AND the delta exceeds the
   threshold by at least a calibrated multiplier (the "abnormally large"
   check).

Ticket in case 1 or case 2 above never reaches the downgrade check.

### Auditability

Every downgrade must be recorded (original verdict, reassignment count,
measured delta, threshold, multiplier used, trigger reason) so the
operational team can tune the calibration without code changes and defend
the numbers when challenged. The audit sink is a deliberate choice for the
implementation PR — candidates include a new column in RawSLAData, a
dedicated audit sheet, or a side-channel log.

## Constraints

- Do not touch timezone inference or normalization behavior while building
  this layer. It is intentional and operationally critical across the
  seven-country workflow.
- Do not move reassignment logic into `slaRules.js`; the rule modules stay
  priority/threshold-only. `domain/slaConfidence.js` is the right home.
- The confidence layer consumes classification outputs only. It must not
  re-derive dates, reinterpret timezones, or read the raw ticket timeline.
- Any downgrade logic must preserve the golden-output invariant for tickets
  that fall in cases 1 and 2 — existing `fulfilled`/`unfulfilled` counts for
  non-downgraded tickets must not shift.
- The calibration multiplier must be configurable (settings file, not code
  constant) and have a documented default chosen against historical data.
