# SLA Engine Regression Harness

Purpose: freeze the current behaviour of `processExcelFile` as a contract, so
the Phase 1b split of the engine (domain / application / infrastructure) can
be validated cell-by-cell against the known-good output on `main`.

## Files

```
tests/
  fixtures/
    tickets.json        Declarative fixture. Each ticket exercises one SLA code path.
    settings.json       Frozen VIPs / excluded emails / TZ mappings used by the harness.
                        Intentionally decoupled from config/projectSettings_*.json.
    input.xlsx          GENERATED from tickets.json. Not committed.
  golden/
    golden.json         Frozen value-level snapshot of the engine's 4-sheet output.
                        Committed. This is the contract.
  build-fixture.js      tickets.json -> input.xlsx
  regression.js         Run the engine, snapshot its output, diff vs golden.
  README.md             This file.
```

## First-time setup (post-merge of PR #1 and this PR)

On a clean working tree at the commit you trust as the baseline:

```bash
npm install
npm run test:regression:update
```

This regenerates `input.xlsx` from `tickets.json`, runs the engine, snapshots
the output, and writes `tests/golden/golden.json`. Commit that file.

From that point on, every change to the SLA engine must keep

```bash
npm run test:regression
```

passing. If a PR intentionally changes SLA semantics, the PR must:

1. Explain the change and its operational impact.
2. Run `npm run test:regression:update` and commit the new golden.
3. Include the golden diff in the PR description for reviewer approval.

## What the harness does and does NOT check

**Checks:** every cell VALUE in every sheet of the produced workbook.
That covers SLA verdicts, minute deltas, normalized country buckets, VIP
classification, warranty verdicts, caller counts, keyword counts, and all
dashboard percentages.

**Does NOT check:** cell styles, column widths, merge ranges, font names.
These are cosmetic and can drift with exceljs version bumps without carrying
SLA information. If cosmetic output becomes important, extend
`workbookToSnapshot` in `regression.js`.

## Fixture coverage

`tickets.json` covers the following branches of `excelProcessor.js`:

- P3/P4 response fulfilled, unfulfilled, "Revisar manualmente"
- P3/P4 resolution fulfilled, unfulfilled
- Non-P3/P4 priority (must not touch P3/P4 counters)
- VIP elevation, VIP response/resolution fulfilled and unfulfilled, VIP "Revisar manualmente"
- Warranty claim fulfilled, unfulfilled, both `A garantia` and `Garantia`
- Excluded email path (ticket dropped before counting)
- Country normalization: allowed country direct, fallback via email, unmapped ghost bucket `#`
- No HTML team-assignment (`ticketMovedDate` falls back to `Created`)
- Word match in `Description` only (the `hasAnyWordInShort` gate)
- Multi-TZ: analysts in US/Central, America/Buenos_Aires, Europe/Berlin
- Punctuation-tolerance regex: `;` separator in "En proceso"

If Phase 1b surfaces a code path not covered here, extend `tickets.json` in the
SAME PR as the split, and regenerate the golden together.

## Running against a PR

```bash
npm install
npm run test:regression
```

Exit codes:
- 0: snapshot matches golden, no regressions.
- 1: snapshot differs (prints up to 40 diffs, then a summary count).
- 2: golden missing (first-time setup not done).
