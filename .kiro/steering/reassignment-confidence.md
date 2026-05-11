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

The real concern is narrower: **heavily exceeded SLA breaches where ownership
timing cannot be reconstructed reliably**. In those cases, the breach
magnitude may be an artefact of pre-L1.5 queue time rather than an L1.5
failure, and reporting them as unfulfilled misattributes accountability.

## Future design direction (not for Phase 1b)

A confidence-adjustment layer applied **after** SLA classification — never
inside `domain/slaRules.js` or `domain/vip.js`, which must remain pure
rule evaluators:

- Triggers to consider in combination (all three, not any one alone):
  1. `reassignment_count > 0`
  2. the SLA breach magnitude is significantly above the threshold
     (exact multiplier to be calibrated against historical data)
  3. insufficient corroborating evidence of when L1.5 ownership began
- When all three conditions are met, consider downgrading the verdict from
  `unfulfilled` to `Revisar manualmente` rather than leaving it as a
  definitive breach.
- This layer must be **configurable and auditable**: every downgrade should
  be recorded (original verdict, trigger values, reason) so the operational
  team can tune thresholds without code changes and can defend the numbers
  when challenged.

## Constraints

- Do not touch timezone inference or normalization behaviour while building
  this layer. It is intentional and operationally critical across the
  seven-country workflow.
- Do not move reassignment logic into `slaRules.js`; the rule modules stay
  priority/threshold-only. A new module (working name
  `domain/slaConfidence.js`) is the right home.
- Any downgrade logic must preserve the golden-output invariant for tickets
  that *don't* meet all three triggers — existing fulfilled/unfulfilled
  counts for normal tickets must not shift.
