---
inclusion: manual
---

# Import-Assisted Settings Sync — V1 Blueprint (APPROVED)

Status: approved for implementation, staged rollout.
Owner of this doc: any engineer touching `services/imports/` or `routes/settingsImport.js`.

This is the binding reference for the V1 of import-based synchronization of
`projectSettings_<type>.json` from the operational source-system Excel exports.
The SLA engine itself (`domain/*`, `routes/excelProcessor.js`, the regression
harness) must remain unaware that this feature exists.

---

## 1. Architectural principles (non-negotiable)

1. **Additive, not invasive.** No refactor of existing modules. New code lives
   under `services/imports/` and `routes/settingsImport.js`. Minimum delta
   everywhere else (`app.js` router wiring, `views/settings.ejs` include,
   `.gitignore`, two tiny helpers on `settingsService.js`).
2. **Engine unawareness.** `domain/*` and the regression harness do not read
   from `services/imports/`, `config/imports/`, or any import-specific state.
3. **Settings schema unchanged.** `config/projectSettings_<type>.json` keeps
   the exact shape it has today. No inline `_provenance`, no schema version
   bump, no new top-level fields.
4. **Sidecar state, not schema state.** Distinguishing "previously imported"
   from "manually edited" is solved by a sidecar file
   `config/imports/<type>.lastImport.json` that the engine never reads.
5. **Atomic via existing primitives.** All writes to
   `projectSettings_<type>.json` go through `settingsService.updateSettings()`.
   No bypassing its queue, atomic rename, or cache refresh.
6. **Dual-file atomic upload.** Analyst and VIP exports are uploaded together
   in a single form submission. Validation, merge, preview, and rollback
   consistency all depend on having both files simultaneously.
7. **Regression invariance.** `tests/fixtures/settings.json` and
   `tests/golden/golden.json` remain the contract. The CI `TZ=US/Central`
   pin stays.

---

## 2. Approved decisions (locked)

| # | Decision | Value |
|---|----------|-------|
| 1 | Country normalization location | `services/imports/countryNameResolver.js` (NOT `domain/`). EN + ES + PT variants, case-insensitive, unknown = warning. |
| 2 | Cross-file collision precedence | VIP file wins for `emailTimeZoneMappings` and `emailCountries`. Warning emitted. |
| 3 | Tombstones | Not implemented in v1. Manual deletion of an imported entry may reappear on next import. Documented trade-off. |
| 4 | Snapshot retention | Last 10 snapshots per type. |
| 5 | Import workflow | Paired upload, single form submission, atomic unit. |
| 6 | Dashboard timezone | NOT moved to settings in v1. Hardcoded default in `domain/slaPolicy.js` stays. CI `TZ=US/Central` pin stays. |
| 7 | Scope | parsing, validation, dry-run preview, apply, snapshot rollback. Nothing else. |
| 8 | Settings schema | Unchanged. Sidecar only. |
| 9 | Engine isolation | `domain/*` strictly unaware. |
| 10 | Snapshot behavior | Snapshot before apply; rollback itself snapshots; keep 10; rollback restores settings only, NOT sidecar. |
| 11 | Write path | Always through `settingsService.updateSettings`. |
| 12 | UI | Single form inside settings page: analystFile + vipFile + Preview + Apply + Snapshot list. No badges. |
| 13 | Testing | Unit + integration + regression invariance. Existing regression stays byte-identical. |
| 14 | This document | Persisted at `.kiro/steering/import-based-settings-v1-blueprint.md`. |
| 15 | Refactor posture | No broad refactors. Additive only. |
| 16 | Plan TTL | 15 minutes, in-memory, invalidated on restart. |
| 17 | Staleness guard | Silent rebuild if outcome unchanged, else 409. |

---

## 3. File map

```
services/imports/
  errors.js               ImportError + error code constants
  countryNameResolver.js  EN/ES/PT name -> ISO-2, case-insensitive
  excelImportParser.js    .xlsx -> raw row objects, header/sheet validation
  userNormalizer.js       raw row -> typed user record + warnings + skip reasons
  importValidator.js      cross-file checks (file swap, EXE+OSE collision)
  importPlanner.js        (current, lastImport, analyst, vip, mode) -> ImportPlan
  importApplier.js        pure merge: manual-preserving union, import-wins
  snapshotManager.js      snapshot create/list/read/prune, sidecar r/w
  importLockManager.js    per-type Promise chain

routes/
  settingsImport.js       (Merge 2+) preview / apply / rollback / snapshots

views/partials/
  importPanel.ejs         (Merge 4) import UI mounted inside settings page

config/imports/           .gitignored, operator-specific state
  external.lastImport.json
  internal.lastImport.json
  snapshots/
    <type>__<isoSafeTs>__<reason>.json

tests/imports/
  _helpers.js             xlsx fixture builder, tmp-dir helpers
  countryNameResolver.test.js
  excelImportParser.test.js
  userNormalizer.test.js
  importValidator.test.js
  importApplier.test.js
  importPlanner.test.js
  snapshotManager.test.js
  importLockManager.test.js
  regression-invariance.test.js    (added in Merge 3)
```

Files modified (minimum delta): `app.js` (one line, Merge 2), `views/settings.ejs`
(one include, Merge 4), `services/settingsService.js` (two helpers exported,
Merge 3), `.gitignore` (one line, Merge 1), `package.json` (test script,
Merge 1).

---

## 4. Data contracts

### 4.1 Normalized user record

```
NormalizedUser = {
  email:     string         // trimmed, lowercase-preserving
  name:      string         // trimmed, exact casing preserved
  tz:        string | null  // IANA zone validated via moment.tz.zone()
  country:   string | null  // ISO-2 normalized
  userType:  'EXE' | 'OSE'
  source:    'analyst' | 'vip'   // which file it came from (for precedence)
}
```

### 4.2 Sidecar `lastImport` file

```jsonc
{
  "importedAt": "2026-05-12T18:40:23.000Z",
  "mode": "external",
  "excludedEmails": ["..."],
  "vipUsers": [ { "name": "..." } ],
  "emailTimeZoneMappings": { "email": "tz" },
  "emailCountries": [ { "Email": "...", "Country": "XX" } ]
}
```

Engine never reads it. First-time read (file missing) returns an empty shape.

### 4.3 ImportPlan

```jsonc
{
  "planId": "uuid-v4",
  "generatedAt": "ISO",
  "mode": "external" | "internal",
  "currentSettingsHash": "sha256",   // staleness guard
  "counts": {
    "analyst": { "parsed": N, "kept": N, "dropped": { "inactive": N, "missingEmail": N, "invalidUserType": N } },
    "vip":     { "parsed": N, "kept": N, "dropped": { ... } }
  },
  "imported": {
    "excludedEmails":        ["..."],
    "vipUsers":              [ { "name": "..." } ],
    "emailTimeZoneMappings": { "...": "..." },
    "emailCountries":        [ { "Email": "...", "Country": "..." } ]
  },
  "diff": {
    "excludedEmails":        { "add": [], "remove": [], "unchanged": N },
    "vipUsers":              { "add": [], "remove": [], "unchanged": N },
    "emailTimeZoneMappings": { "add": {}, "changed": {}, "remove": [], "unchanged": N },
    "emailCountries":        { "add": [], "changed": [], "remove": [], "unchanged": N }
  },
  "warnings": [
    { "severity": "warn", "code": "...", "message": "...", "source": "analyst" | "vip" | "cross" }
  ],
  "sanityFlags": { "largeShrink": false, "largeChurn": false }
}
```

---

## 5. Merge semantics (formal)

Let `F` be any of the four importable fields.

```
currentF      = currentSettings[F]
previousImpF  = lastImport[F]  (empty if sidecar absent)
newImpF       = computed from this import

manualF = currentF entries whose key is NOT in keys(previousImpF)
nextF   = manualF ∪ newImpF        // import wins on shared keys
```

Key per field:

| Field | Shape | Key |
|---|---|---|
| `excludedEmails` | `string[]` | the string |
| `vipUsers` | `{name}[]` | `entry.name` (exact, case-sensitive) |
| `emailTimeZoneMappings` | `{email: tz}` | `email` |
| `emailCountries` | `{Email, Country}[]` | `entry.Email` |

Entries in `currentF` with a missing/undefined key (e.g. the historical `{}`
in `emailCountries`) are treated as "always manual": never in `previousImp`,
never in `newImp`, always preserved.

Field-specific derivation of `newImpF` from the two files:

```
EXE = (analyst ∪ vip).filter(r => r.userType === 'EXE')
OSE = (analyst ∪ vip).filter(r => r.userType === 'OSE')

newImp.excludedEmails =
    mode === 'external' ? emails(OSE) : emails(EXE)

newImp.vipUsers = unique(vip.map(r => ({ name: r.name })))

newImp.emailTimeZoneMappings =
    mergeByEmail(analyst, vip, precedence='vip')
      .filter(tz present && valid)
      .toObject(email -> tz)

newImp.emailCountries =
    mergeByEmail(analyst, vip, precedence='vip')
      .filter(country present && resolved)
      .map({ Email, Country })
```

`allowedCountries` is NEVER touched.

---

## 6. Validation rules

### 6.1 Tier 1 (hard fail, 400 response, no write)

- File not `.xlsx` (MIME and extension).
- Workbook has more than one worksheet.
- Row 1 missing any of: `Email`, `Name`, `Time zone`, `Country code`,
  `User type`, `Active`, `Status`, `Gama User Status`.
- Zero data rows after the header.
- Cross-file: same email is `EXE` in one file and `OSE` in the other.
- File swap heuristic: analyst file is 100% `OSE` OR vip file is 100% `EXE`
  (both must have at least one row for the heuristic to trigger).

### 6.2 Tier 2 (silent skip, counted)

- Row dropped if `Active != "1"` OR `Status != "ENABLED"` OR
  `Gama User Status != "Enabled"`.

### 6.3 Tier 3 (warn, row partially kept)

- Empty email → row dropped, `missingEmail` counter incremented.
- `User type` not in `{EXE, OSE}` → row dropped.
- Invalid timezone (`moment.tz.zone(tz) === null`) → row contributes to all
  fields except TZ mapping.
- Country code unresolvable → row contributes to all fields except country.
- Intra-file duplicate email with different TZ or country → first-write-wins,
  warning logged.
- Cross-file duplicate email with different TZ or country → VIP wins, warning
  logged.
- Net change flags (not blocking): `largeShrink` when any list shrinks by
  >20%, `largeChurn` when (adds + removes) / max(current, new) > 0.5.

---

## 7. Import transaction flow

```
POST /api/settings/:type/import/preview   [multipart]
  parse both xlsx
  normalize both files
  validate cross-file (tier 1)
  read currentSettings (via settingsService.getSettings)
  read lastImport sidecar (or empty)
  build ImportPlan (importPlanner)
  cache { planId, plan, analystRecords, vipRecords, currentSettingsHash }
  always delete uploaded temp files in finally
  return plan summary

POST /api/settings/:type/import/apply     [json: planId]
  retrieve cached plan
  importLockManager.run(type, async () => {
    re-read currentSettings + hash
    if hash differs from cached:
      recompute plan with fresh currentSettings
      if outcome (imported + diff) equivalent -> continue silently
      else -> return 409 "stale plan, please re-preview"
    snapshotManager.create(type, 'pre-import-apply')
    settingsService.updateSettings(type, settings => {
      { nextSettings, nextLastImport } = importApplier.apply(settings, plan, lastImport)
      Object.assign(settings, nextSettings)
    })
    snapshotManager.writeLastImport(type, nextLastImport)
    snapshotManager.pruneSnapshots(type, 10)
  })
  planCache.delete(planId)
```

Failure modes and side-effect safety: see §10.

---

## 8. Rollback flow

```
POST /api/settings/:type/import/rollback  [json: snapshotId]
  importLockManager.run(type, async () => {
    resolve snapshot path; 404 if absent
    snapshotManager.create(type, 'pre-rollback')
    settingsService.updateSettings(type, settings => {
      const restored = JSON.parse(readSnapshot())
      wipe settings; Object.assign(settings, restored)
    })
    // DO NOT restore the lastImport sidecar.
    // Rationale: the sidecar reflects the most recent successful import.
    // Rolling back only the settings means a subsequent preview will see
    // "items previously imported but now absent" and propose re-adding them
    // on the next import. This is the correct operator mental model:
    // "roll back first, then decide whether to re-import."
  })
```

---

## 9. UI flow (Merge 4)

Single panel at the top of `/settings`:

```
Import from system exports                    [Mode: <external|internal>]
--------------------------------------------------------------------------
Analyst export:   [Choose file] analist_export_*.xlsx
VIP export:       [Choose file] vip_export_*.xlsx
                                                [Preview import]

--- Preview (after click) --------------------------------------------
Parsed:  24 analysts (1 inactive), 55 VIPs.
Changes:
  Excluded emails:   +12  -3   unchanged 108
  VIP users:         +2   -1   unchanged 53
  Time-zone maps:    +8   ~3   -1   unchanged 180
  Email countries:   +9   ~4   -2   unchanged 175
Warnings (4):
  * Email foo@bar appears in both files with different TZ; VIP value kept.
  * Country "Peruu" unresolved, country skipped for that row.
  ...
[Cancel]                                         [Apply import]

Recent snapshots (last 10)
  2026-05-12 18:40   pre-import-apply   [Rollback]
  2026-05-11 09:12   pre-import-apply   [Rollback]
  ...

-- (below, unchanged) --
Existing CRUD sections remain fully editable.
```

No provenance badges. Preview diff is the sole visibility mechanism into
"which entries are imported vs manual".

---

## 10. Failure scenarios

| Scenario | Detection | Response | Side-effect safety |
|---|---|---|---|
| File not .xlsx | multer fileFilter | 400 | Safe |
| Missing required header | excelImportParser | 400, header diff | Safe (temp files deleted in finally) |
| File swap heuristic | importValidator | 400, "files appear swapped" | Safe |
| Cross-file EXE+OSE same email | importValidator | 400 with offender list | Safe |
| planId expired / server restart | planCache miss | 409, operator re-previews | Safe |
| Snapshot write fails | fs.writeFile throws | 500, settings untouched | Safe |
| Settings write fails after snapshot | settingsService throws | 500, snapshot matches previous state | Safe |
| Sidecar write fails after settings write | fs.writeFile throws | Log error, respond 200 with `warning: 'sidecar-out-of-sync'` | Next preview re-proposes "imported" entries as new; first re-import heals. Recoverable without manual action. |
| Concurrent imports same type | importLockManager | Serialized | Safe |
| Concurrent import vs CRUD write | settingsService.writeQueue + plan hash | Silent rebuild or 409 | Safe |
| Rollback to missing snapshot | snapshotManager.resolve miss | 404 | Safe |
| Rollback snapshot corrupt | JSON.parse throws | 500, settings untouched | Safe |
| Unknown country | countryNameResolver returns null | Warning, country skipped for that row | Safe |
| Large shrink / churn | importPlanner.sanityFlags | Warning banner, apply not blocked | Operator judgment |

---

## 11. Test strategy

### Unit (`tests/imports/*.test.js`)
- `countryNameResolver.normalize`: ISO-2 passthrough, EN names, ES variants
  (Perú, México, Panamá, Brasil), PT variants (Brasil), case-insensitivity,
  unknown returns `null`.
- `userNormalizer.normalizeRow`: active/enabled gating (all three flags AND),
  email trimming, invalid TZ → `tz=null`, unresolvable country → `country=null`,
  invalid userType dropped.
- `importValidator`: cross-file EXE+OSE rejection, file-swap heuristic,
  intra-file duplicates with warnings.
- `importPlanner.build`: first-time (empty lastImport) → all entries in `add`,
  re-import no changes → all `unchanged`, removed export entry → `remove`,
  manual entry preserved across re-import → never in `remove`, VIP TZ wins
  over analyst TZ, mode toggle recomputes `excludedEmails`.
- `importApplier.apply`: exact merge algorithm output per field,
  `nextLastImport` correctness, manual entries preserved, `{}` sentinel
  preserved in `emailCountries`.
- `snapshotManager`: create + list + read + prune to 10, sidecar r/w with
  empty default on absent file.
- `importLockManager`: serialization semantics, per-type isolation, error
  propagation does not break the chain.

### Integration (`tests/imports/integration.test.js`, added in Merge 3)
- End-to-end preview → apply → rollback using the two real fixtures under
  `docs/temp/`. Asserts exact settings diff and sidecar state.
- Snapshot pruning keeps 10.
- Staleness guard: CRUD write between preview and apply triggers rebuild.

### Regression invariance (`tests/imports/regression-invariance.test.js`, Merge 3)
- Run `tests/regression.js` before and after a simulated import. Asserts the
  SLA output workbook is byte-identical when the fixture settings are used.
  This proves the engine is unaffected by import activity.

### Regression contract
`npm run test:regression` must pass unchanged at every commit. CI pin
`TZ=US/Central` stays.

---

## 12. Migration stages

| Merge | Scope | Reversibility |
|---|---|---|
| 1 | Pure modules under `services/imports/` + unit tests + `.gitignore` + test script | No production behavior; revert is no-op |
| 2 | `routes/settingsImport.js` wired; only `/preview` live, others return 501 | Revert removes the router line in `app.js` |
| 3 | `/apply`, `/rollback`, `/snapshots`; integration + regression-invariance tests; `settingsService` helpers | Revert removes router + helpers; settings file untouched |
| 4 | UI panel enabled; remove any feature gate | Revert removes the `<%- include %>` line in `settings.ejs` |

At no point does `domain/*` import from `services/imports/`. At no point does
`tests/regression.js` exercise import paths.

---

## 13. Coding conventions

- ES modules (`import`/`export`), matching the rest of the repo.
- Pure functions where possible; I/O confined to `snapshotManager` and the
  HTTP layer.
- No side effects on module import (no top-level `fs.mkdir` etc. in
  `services/imports/`).
- Explicit `ImportError` class with `code` + `details`. No thrown strings.
- Temp uploads always removed in a `finally` block.
- Atomic writes via `settingsService.updateSettings` (write-temp-then-rename).
- Log `console.warn` / `console.error` for recoverable inconsistencies,
  never for normal tier-2 filtering.
- JSDoc on exported functions.
