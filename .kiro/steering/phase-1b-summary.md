# Phase 1b Summary — Domain Extraction

Durable reference for the SLA Processing Engine modernization work
completed across PRs #1 through #9. Captures what was extracted, which
reporting semantics were preserved exactly, which operational constraints
must not drift, and what future phases can safely build on.

This document is **read-first** for anyone touching the pipeline in
`routes/excelProcessor.js`, the modules in `domain/`, or the regression
harness in `tests/`.

---

## 1. Scope and outcome

Phase 1b took a single-file pipeline in `routes/excelProcessor.js` — a
large `processExcelFile` function that interleaved row parsing, timezone
inference, SLA rule evaluation, VIP elevation, country resolution, topic
counting, caller counting, aggregate rollups, and four output sheets —
and progressively lifted the business-domain concerns into focused
modules under `domain/`.

At the end of Phase 1b:

- `routes/excelProcessor.js` is pure orchestration + workbook I/O. No
  SLA thresholds, no verdict string literals, no timeline regexes, no
  counter shapes defined in the route.
- The inner pipeline loop reads as a flat sequence of delegated calls
  (ticket parse -> country resolve -> timeline build -> SLA classify ->
  VIP classify -> raw row write -> aggregates record -> caller record ->
  topic count).
- Every commit from PR #1 onwards ran the regression harness (`npm run
  test:regression`) to green before merging. The golden output matches
  byte-for-byte with `main` pre-Phase-1b.

---

## 2. Extracted modules

All modules live under `domain/`. They import only from each other or
from third-party libraries (`moment-timezone`), never from `routes/` or
`services/`.

| Module                  | Responsibility                                                                 | PR  |
|-------------------------|--------------------------------------------------------------------------------|-----|
| `ticket.js`             | Column-header discovery; row -> ticket object mapping                          | #1  |
| `slaPolicy.js`          | Constants: `PRIORITY`, `VERDICT`, `THRESHOLDS`, `TIMEZONE`, `KEYWORDS`, `REGEX`, `DATE_FORMAT` | #3  |
| `lifecycle.js`          | `extractInferredDates` + `buildTimeline` — timezone-aware date reconstruction  | #5  |
| `slaRules.js`           | `classifySla` — P3/P4 response + resolution + warranty verdicts                | #6  |
| `vip.js`                | `isVipCaller` (substring match), `classifyVip` (VIP response/resolution)       | #6  |
| `countryResolver.js`    | `buildEmailToCountryMap`, `resolveCountry` (mutates ticket.Country)            | #8  |
| `topics.js`             | `normalizeKeywords`, `initCountryTopicCounts`, `countTopics`                   | #8  |
| `aggregates.js`         | `createAggregates`, `hasCountryBuckets`, `ensureCountryBuckets`, `recordTicketAggregates` | #9  |
| `callers.js`            | `createCallerCount`, `recordCaller`                                            | #9  |

Each module's own header documents its non-obvious semantics. This
summary captures only the cross-module patterns and decisions that
would not be visible from reading any single module.

---

## 3. Preserved asymmetries

These were **intentionally preserved** during Phase 1b per explicit
guidance:

> "Preserve all current asymmetries intentionally unless explicitly
> discussed. Especially preserve the Response-only manual-review
> asymmetry in the country counters until we intentionally redesign
> reporting semantics later."

> "For Phase 1b, preserving reporting output stability is more important
> than normalization consistency."

Each asymmetry below is load-bearing for the DashboardSLAData output
columns and the operational dashboards built on top of them. **Do not
"normalize"** any of these without explicit product sign-off, a
coordinated golden update, and a review of downstream dashboard
consumers.

### 3.1 Global vs per-country manualReview shape

Lives in: `domain/aggregates.js`.

- `totals.Response.manualReview` is a **single scalar** (not
  priority-bucketed).
- `byCountry.manualReview[country].Response` is an object
  `{ p3, p4, vip }` (priority-bucketed).

They answer different product questions (overall review queue volume
vs. per-country review distribution) and render in different cells of
DashboardSLAData.

### 3.2 manualReview exists only for Response

Lives in: `domain/aggregates.js`.

- `byCountry.manualReview[country]` has **only** a `Response` sub-object.
- There is **no** `Resolution` and **no** `Warranty` manualReview store.

Rationale: `classifySla` only emits the `"Revisar manualmente"` verdict
for Response. Resolution and Warranty verdicts are binary
(`fulfilled` / `unfulfilled`). Adding stores for verdicts that can never
be set would be dead structure.

### 3.3 Resolution uses bare `else`, not `else if === "unfulfilled"`

Lives in: `domain/aggregates.js`.

In both the global totals and per-country rollup, the Resolution branch is:

```js
if (resolutionSLA === "fulfilled") { ... }
else { ... }
```

Anything that is not literally the string `"fulfilled"` counts as
unfulfilled. In practice `classifySla` only emits `"fulfilled"` or
`"unfulfilled"` for Resolution, so the bare `else` is equivalent in
current practice — but the historical engine uses the broader operator
and we preserve it exactly. This also means the non-P3/P4 seed of
`resolutionSLA = UNFULFILLED` flows through the `else` branch without
special casing.

### 3.4 Warranty has no VIP slice

Lives in: `domain/aggregates.js`.

`totals.Warranty` and `byCountry.*.Warranty` do **not** track VIP
separately, even when `isVip` is true. Response and Resolution both
do. This matches the DashboardSLAData column layout, which has no
VIP-Warranty column.

### 3.5 VIP counters are priority-independent and additive

Lives in: `domain/aggregates.js`, `domain/vip.js`.

VIP counters are incremented by an **independent** `if (isVip) ...`
statement, not as an `else` branch of the priority check. A P3 VIP
ticket that fulfils Response therefore increments **both**
`p3Fulfilled` AND `vipFulfilled`. VIP is a separate slice of the same
data, not a fifth priority bucket.

`domain/vip.js` thresholds are also priority-independent:
`THRESHOLDS.response.vip` and `THRESHOLDS.resolution.vip` are compared
regardless of whether the ticket is P3, P4, or something else.

### 3.6 Non-P3/P4 priority handling

Lives in: `domain/slaRules.js`, `domain/aggregates.js`.

A ticket with a priority outside `PRIORITY.P3` / `PRIORITY.P4` (e.g.
`"1 - Critical"`):

- `classifySla` seeds `responseSLA = VERDICT.MANUAL_REVIEW` and
  `resolutionSLA = VERDICT.UNFULFILLED`, and never overwrites them.
  Even if `date2` is present and `analystUpdateDate` is non-null,
  responseSLA **stays** MANUAL_REVIEW.
- `differenceFromUpdated` is still computed when `date2` is present
  (so the RawSLAData row has a real minute delta).
- `aggregates.recordTicketAggregates` increments **no priority bucket**
  for such a ticket, but **still** updates the VIP slice (if `isVip`)
  and the warranty counters (if `warrantySLAStatus` is set).

### 3.7 VIP detection is substring match, not equality

Lives in: `domain/vip.js`.

`isVipCaller(callerName, vipUsers)` iterates the VIP list in insertion
order, short-circuits on the first match, and uses
`callerName.includes(vip.name)` — **substring**, not equality. This
tolerates analysts entering `"Dr. Smith (External)"` when the VIP list
has `"Dr. Smith"`, which is the historical operational allowance.

Side-effect: `"Smith"` in the VIP list would match `"Blacksmith"`. That
latitude is intentional and is the rule the operational team has been
calibrating against for years. **Do not switch to exact match** without
product sign-off and a golden update.

### 3.8 Caller counting: `"Unknown"` fallback, first-country pinning, raw keys

Lives in: `domain/callers.js`.

- Falsy caller (`""`, `null`, `undefined`) -> bucket key `"Unknown"`.
- `country` is recorded on **first sighting** and never updated. If the
  same caller later appears under a different resolved country, the
  stored country stays the first one. Top 10 Callers is therefore a
  first-seen country attribution.
- Keys are raw caller strings — no trim, no casefold, no unicode
  normalization. Two callers differing only in trailing whitespace or
  casing will be counted as separate rows.

### 3.9 Topics: short-desc-wins rule

Lives in: `domain/topics.js`.

For each keyword:

1. If the keyword appears in `Short description` (lowercased),
   increment that keyword's bucket.
2. Otherwise, if **no** keyword appeared in `Short description` **and**
   the keyword appears in `Description`, increment that keyword's
   bucket.

The `hasAnyWordInShort` gate is evaluated **once per row**. If any
keyword was found in Short description, the full Description is
ignored entirely for that row — **even for other keywords that did not
appear in the short description**. This prevents rich descriptions
from swamping the topic distribution with signal that the short
description already captured.

A single row can contribute to multiple buckets via Short description
(that branch does not short-circuit across keywords).

### 3.10 Country resolution mutates `ticket.Country` in place

Lives in: `domain/countryResolver.js`.

`resolveCountry` mutates `ticket.Country` as a side effect when the
ticket's reported country is not in the allow-list. This is the
contract the downstream code relies on — the ticket object flows
through later pipeline steps. Immutability is **explicitly deferred**
to a later architecture phase per agreed scope.

The `'#'` sentinel (unmapped email) is preserved verbatim; it flows
into Top 10 Topics and DashboardSLAData as a real country key with
operational meaning ("country unknown").

---

## 4. Timezone operational constraints

Lives in: `domain/lifecycle.js`, with a small TIMEZONE constant in
`domain/slaPolicy.js`.

### 4.1 The invariant

ServiceNow exports are **timezone-relative to the analyst performing
the export**, not necessarily the operational timezone of the ticket
owner. The existing timezone inference and normalization behavior is
**intentional and operationally critical across the seven-country SLA
workflow**.

### 4.2 The constraint

> Do **not** simplify, normalize globally, or redesign timezone
> behavior during Phase 1b. Preserve the current operational semantics
> exactly unless explicitly requested otherwise.

This constraint was respected across every Phase 1b PR. `lifecycle.js`
was extracted in PR #5 with byte-for-byte preservation of regex,
moment-timezone offsets, and the email-keyed timezone map lookup. No
downstream extraction (SLA classification, VIP, country resolver,
aggregates) touched timeline semantics.

### 4.3 Indirect couplings to preserve

- `domain/countryResolver.js` indirectly affects timezone interpretation
  because `domain/lifecycle.js` looks up an email-keyed timezone map
  (`emailTimeZoneMappings`), and country resolution can change how
  downstream reporting segments that same ticket. Preserving the
  exact resolution semantics was explicit in PR #8.
- Any future layer (e.g. the confidence-adjustment layer, see §6) must
  **not** re-derive dates or reinterpret timezones. It consumes
  classification outputs only.

---

## 5. Regression-contract strategy

The single operational guarantee during Phase 1b was:

> `npm run test:regression` must continue to report:
> `[regression] PASS - 4 sheets, all cells match golden.`

Discipline applied on every PR:

1. **Atomic commit + single PR per extraction.** Each PR ships one
   cohesive extraction — never two unrelated changes.
2. **Pre-extraction read.** The full inline block is read and its
   behavior summarized in prose before any module is written. The
   extraction target must be reproducible from the summary.
3. **Preserved literals.** Priority strings (`'3 - Moderate'`,
   `'4 - Low'`), verdict strings (`"fulfilled"`, `"unfulfilled"`,
   `"Revisar manualmente"`), and the sentinel `'#'` are preserved
   byte-for-byte. Where it would be technically clean to replace them
   with `PRIORITY.*` / `VERDICT.*` imports, that refactor is explicitly
   deferred to avoid even theoretical equality drift. See §7.
4. **Same local variable names at the call site.** Extractions return
   the same names the downstream code was already consuming, so the
   diff stays focused on the extracted block. In PR #9 this was done
   via short alias definitions (`const slaTotals = aggregates.totals;`)
   rather than renaming the dashboard reader.
5. **Branch coverage via throwaway sanity scripts.** Because the
   development sandbox has no npm registry access (the `exceljs` /
   `moment-timezone` / `tempy` deps can't be installed), the regression
   harness cannot run in the author's environment. To compensate, each
   PR with non-trivial logic was accompanied by a short throwaway
   `tests/_sanity_*.mjs` script that imported the new module directly
   (domain modules have no heavy deps), exercised every branch with
   stub data, and asserted expected outputs. These scripts were
   **deleted before commit** — they were never part of the regression
   suite. They served only to catch obvious bugs before the user ran
   the real harness.
6. **User runs the real harness.** Every merge was gated on the user
   confirming `[regression] PASS` locally. No PR was merged without
   that confirmation.

### 5.1 Documented limitation

The author environment cannot execute the regression harness. Future
contributors with registry access should:

- Install deps once: `npm install`.
- Run `npm run test:regression` on every change to `domain/` or
  `routes/excelProcessor.js`, not just before merging.
- If a change is expected to alter output, update the golden (in
  `tests/golden/golden.json`) in the **same commit** as the behavior
  change, with a commit message explaining which cells changed and why.

---

## 6. reassignment_count confidence-layer direction

Full detail lives in `.kiro/steering/reassignment-confidence.md`. This
section is the short pointer for Phase 1b handoff.

### 6.1 The gap

ServiceNow exports do **not** include assignment-group transition
history or a timestamp for when a ticket entered the L1.5 operational
queue. The only exported signal related to reassignment is the
`Reassignment count` column.

### 6.2 The operational concern

SLA responsibility begins when the ticket reaches L1.5, **not** when
it was originally created in ServiceNow. A ticket with
`reassignment_count > 0` may have spent unknown time in another queue
before reaching L1.5, which can inflate breach magnitudes beyond what
the L1.5 team actually controlled.

The issue is **confidence, not reassignment itself.** Reassignment alone
does not imply a wrong verdict — most reassigned tickets have SLA
deltas that are still reliably attributable to L1.5.

### 6.3 Intended operational behavior

Three disjoint cases, expressed as the target spec for a future
implementation:

1. `reassignment_count == 0` → evaluate normally.
2. `reassignment_count > 0` with reasonable SLA deltas → still evaluate
   normally. Reassignment alone does not change the verdict.
3. `reassignment_count > 0` with abnormally large deltas → mark as
   `Revisar manualmente` (low confidence). The breach magnitude cannot
   be attributed reliably from the export.

Cases 1 and 2 are byte-for-byte identical to today's behavior. Case 3
is the only behavioral change this layer introduces. The "abnormally
large" threshold is a calibration parameter (settings-driven, tuned
against historical data with product sign-off), not a code constant.

### 6.4 Future architectural direction (not for implementation yet)

A **confidence-adjustment layer** applied after SLA classification,
consuming classification outputs only. Working module name:
`domain/slaConfidence.js`. This layer must:

- Live **outside** `domain/slaRules.js` and `domain/vip.js`, which
  remain pure rule evaluators.
- Trigger only when **both** conditions hold: `reassignment_count > 0`
  AND the `unfulfilled` verdict's delta exceeds the SLA threshold by a
  calibrated multiplier. Never upgrade verdicts. Never touch
  `fulfilled` tickets. Never touch the timeline directly.
- Overload the existing `Revisar manualmente` verdict rather than
  introduce a fourth string — the operational team already reviews
  that bucket, and adding low-confidence cases matches the workflow.
  If reporting needs to distinguish the two meanings later, record the
  reason code in the audit trail instead of a verdict change.
- Be configurable and auditable — every downgrade must be recorded
  (original verdict, reassignment count, delta, threshold, multiplier,
  reason) so operators can tune without code changes.
- Preserve the golden-output invariant for tickets in cases 1 and 2.
- Not touch timezone inference or normalization (see §4).

---

## 7. Current architectural boundaries

### 7.1 The line

- **`domain/`**: pure business rules. No Excel, no file I/O, no
  orchestration. Consumes settings data and typed inputs; returns
  classifications, counters, and stores. Modules import only each
  other or third-party libraries (`moment-timezone`).
- **`routes/excelProcessor.js`**: orchestration and presentation.
  Reads the source workbook, walks rows, delegates every domain
  decision, assembles four output sheets, writes a tempfile. Contains
  no business-rule literals.
- **`services/settingsService.js`**, **`config/*.json`**: configuration
  loading. Not touched during Phase 1b.
- **`tests/regression.js`**, **`tests/golden/golden.json`**,
  **`tests/fixtures/*`**: the regression contract. Not touched during
  Phase 1b.

### 7.2 What's left in `routes/excelProcessor.js`

After Phase 1b, `processExcelFile` is ~355 lines of:

- Workbook read + sheet discovery.
- Column-header mapping (delegated to `domain/ticket.js`).
- The single-pass pipeline loop: row -> delegations -> raw row write +
  three recorder calls (`recordTicketAggregates`, `recordCaller`,
  `countTopics`).
- Four sheet generators: RawSLAData (populated inside the loop),
  Top 10 Topics, Top 10 Callers, DashboardSLAData.
- Column auto-width, tempfile write.

None of this is business-rule logic. It is presentation, layout, and
orchestration.

### 7.3 Known minor deferrals

Explicitly deferred to avoid any equality-drift risk during Phase 1b.
These are safe one-line cleanups whenever someone wants a small PR:

- `domain/aggregates.js` uses raw priority string literals
  (`'3 - Moderate'`, `'4 - Low'`) instead of `PRIORITY.P3` / `PRIORITY.P4`
  imports. Byte-identical equality to pre-extraction code. A trivial
  follow-up PR can switch to the imports.
- `domain/countryResolver.js` mutates `ticket.Country` in place. A
  return-and-assign-at-call-site refactor would remove the side effect
  but changes contract; deferred until aggregates and orchestration are
  fully isolated (which is now true — but the change is a Phase 2
  scope call, not a Phase 1b cleanup).

---

## 8. Suggested future-phase candidates

None of these should start before an explicit scope conversation.
Phase 1b is the last phase that targeted byte-for-byte behavioral
equivalence as its primary goal; future phases can and should revisit
reporting semantics where appropriate.

### 8.1 Phase 2 — Presentation layer extraction

**Target:** the four sheet generators + column/merge styling in
`routes/excelProcessor.js`.

**Scope candidates:**

- `presentation/rawSlaDataSheet.js` — writes the per-row RawSLAData
  sheet. Currently interleaved with the single-pass loop; can be
  inverted so the loop emits structured row objects and the sheet
  generator consumes them separately.
- `presentation/topTopicsSheet.js`, `presentation/topCallersSheet.js`,
  `presentation/dashboardSheet.js` — each consumes a domain store
  (topics, callers, aggregates) and produces one sheet.
- `presentation/styles.js` — the Arial/Roboto/alignment/merge literals
  that are currently scattered through `excelProcessor.js`.

**Risk profile:** medium. Sheet generators contain magic column widths
and merge ranges (`B2:C2` etc.) that must be preserved exactly. The
DashboardSLAData sheet has the most layout-sensitive code (merged
header rows, alignment, three-style column overrides).

**Open questions before starting:**

- Does the presentation layer own the output filename convention
  (`SLA_YYYY-MM-DD HH-mm-ss.xlsx`) or does orchestration?
- Should the four sheets be addable independently (useful for testing)
  or must they ship as a single workbook (current behavior)?

### 8.2 Phase 3 — Application / orchestration extraction

**Target:** `processExcelFile` itself.

After Phase 2, `processExcelFile` becomes a thin sequence:
load settings -> open workbook -> build header map -> for each row
call domain -> hand stores to presentation -> write file. That
sequence belongs in `application/slaReportPipeline.js` (or similar),
with `routes/excelProcessor.js` becoming a thin HTTP adapter that
wires the pipeline to the route.

**Risk profile:** low, once Phase 2 has pulled presentation out.

### 8.3 Phase 4 — Confidence-adjustment layer

**Target:** the `domain/slaConfidence.js` module described in §6 and
in `.kiro/steering/reassignment-confidence.md`.

**Risk profile:** highest of the four future phases. This is the
first layer that will **intentionally** change reporting output for
some tickets — the golden will need an update, dashboards will need
to re-baseline, and the operational team will need to validate the
trigger thresholds against historical data.

**Preconditions:**

- Phase 2 complete (presentation extracted) so the downgrade layer
  has a clean point to insert between classification and presentation.
- Decision on the three triggers (`reassignment_count > 0`, breach
  magnitude multiplier, corroborating-evidence definition) made with
  product sign-off.
- Auditability sink defined (probably a new column in RawSLAData or a
  separate sheet) before any verdict is actually downgraded.

### 8.4 Phase 5 — Immutability and purity cleanups

**Target:** remove the remaining in-place mutations now that the
domain is isolated.

- `countryResolver.resolveCountry` returns the resolved country but
  also mutates `ticket.Country`. Switch to return-and-assign-at-caller.
- `aggregates.recordTicketAggregates` mutates the `aggregates` object.
  This one is probably fine to keep — immutable accumulators per row
  in a long-running pipeline have a real allocation cost — but worth
  revisiting if profiling shows no hot-path impact.

**Risk profile:** low. These are mechanical refactors with full test
coverage already in place.

---

## 9. Read-next

- Module-level details: the header comment of each file in `domain/`.
  Every preserved asymmetry and non-obvious semantic is documented
  inline, with a cross-reference number to §3 of this summary.
- Confidence-layer direction:
  `.kiro/steering/reassignment-confidence.md`.
- Regression fixture + golden shape: `tests/README.md`.
