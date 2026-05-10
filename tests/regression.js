/**
 * SLA engine regression harness.
 *
 * Contract:
 *   Re-run processExcelFile against the frozen fixture and compare every cell
 *   VALUE in every sheet of the output workbook against tests/golden/golden.json.
 *
 * Why only values (not styles / widths / merge positions):
 *   - Styles, column widths, and merge ranges are cosmetic. They do NOT carry
 *     SLA information and occasionally drift with exceljs version bumps.
 *   - Values are the audit surface. A drift there is always a real regression.
 *
 * Modes:
 *   node tests/regression.js             -> compare vs golden, exit 1 on diff
 *   node tests/regression.js --update    -> regenerate golden (manual only)
 *
 * First-run ergonomics:
 *   - If fixtures/input.xlsx is missing, run build-fixture.js first.
 *   - If golden/golden.json is missing, print a helpful message asking the
 *     operator to run --update once against today's engine.
 */

import fs from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';

import exceljs from 'exceljs';

import processExcelFile from '../routes/excelProcessor.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const FIXTURE_XLSX   = path.resolve(__dirname, 'fixtures/input.xlsx');
const FIXTURE_JSON   = path.resolve(__dirname, 'fixtures/tickets.json');
const SETTINGS_JSON  = path.resolve(__dirname, 'fixtures/settings.json');
const GOLDEN_JSON    = path.resolve(__dirname, 'golden/golden.json');
const GOLDEN_DIR     = path.resolve(__dirname, 'golden');
const BUILD_SCRIPT   = path.resolve(__dirname, 'build-fixture.js');

const isUpdate = process.argv.includes('--update');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Reduce an exceljs workbook to a value-only, deterministic JSON shape.
 * Each sheet -> array of rows -> array of cells. Cells are the cell's .value
 * (already a primitive for our engine's output). Empty trailing cells are
 * preserved because they carry positional meaning in the dashboard.
 */
async function workbookToSnapshot(filePath) {
    const wb = new exceljs.Workbook();
    await wb.xlsx.readFile(filePath);

    const snapshot = { sheets: [] };
    wb.eachSheet(ws => {
        const rows = [];
        const rowCount = ws.rowCount;
        const colCount = ws.columnCount;

        for (let r = 1; r <= rowCount; r++) {
            const row = ws.getRow(r);
            const cells = [];
            for (let c = 1; c <= colCount; c++) {
                const v = row.getCell(c).value;
                // Normalize undefined -> null so JSON.stringify emits a stable shape.
                cells.push(v === undefined ? null : v);
            }
            rows.push(cells);
        }

        snapshot.sheets.push({ name: ws.name, rows });
    });

    return snapshot;
}

/**
 * Structural diff between two value snapshots. Returns an array of human-readable
 * strings describing each mismatch. Empty array means identical.
 */
function diffSnapshots(expected, actual) {
    const diffs = [];

    if (expected.sheets.length !== actual.sheets.length) {
        diffs.push(`sheet count: expected ${expected.sheets.length}, got ${actual.sheets.length}`);
    }

    const maxSheets = Math.max(expected.sheets.length, actual.sheets.length);
    for (let s = 0; s < maxSheets; s++) {
        const eSheet = expected.sheets[s];
        const aSheet = actual.sheets[s];
        if (!eSheet) { diffs.push(`extra sheet #${s}: "${aSheet.name}"`); continue; }
        if (!aSheet) { diffs.push(`missing sheet #${s}: "${eSheet.name}"`); continue; }
        if (eSheet.name !== aSheet.name) {
            diffs.push(`sheet #${s} name: expected "${eSheet.name}", got "${aSheet.name}"`);
        }

        const eRows = eSheet.rows;
        const aRows = aSheet.rows;
        const maxRows = Math.max(eRows.length, aRows.length);

        for (let r = 0; r < maxRows; r++) {
            const eRow = eRows[r] || [];
            const aRow = aRows[r] || [];
            const maxCols = Math.max(eRow.length, aRow.length);

            for (let c = 0; c < maxCols; c++) {
                const eVal = eRow[c] === undefined ? null : eRow[c];
                const aVal = aRow[c] === undefined ? null : aRow[c];
                if (JSON.stringify(eVal) !== JSON.stringify(aVal)) {
                    diffs.push(
                        `  [sheet "${eSheet.name}" row ${r + 1} col ${c + 1}] ` +
                        `expected ${JSON.stringify(eVal)}, got ${JSON.stringify(aVal)}`
                    );
                }
            }
        }
    }

    return diffs;
}

async function ensureFixtureXlsx() {
    if (existsSync(FIXTURE_XLSX)) return;
    console.log('[regression] input.xlsx not found. Generating from tickets.json ...');
    const res = spawnSync(process.execPath, [BUILD_SCRIPT], { stdio: 'inherit' });
    if (res.status !== 0) {
        throw new Error('build-fixture.js failed; cannot run regression.');
    }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
    await ensureFixtureXlsx();

    const settings = JSON.parse(await fs.readFile(SETTINGS_JSON, 'utf8'));

    // Run the engine. processExcelFile writes to tempy, returns the path.
    const producedPath = await processExcelFile(
        FIXTURE_XLSX,
        settings.vipUsers,
        settings.emailTimeZoneMappings,
        settings.excludedEmails,
        settings.emailCountries,
        settings.allowedCountries
    );

    const actualSnapshot = await workbookToSnapshot(producedPath);

    // Clean up the engine's temp output.
    await fs.unlink(producedPath).catch(() => {});

    if (isUpdate) {
        await fs.mkdir(GOLDEN_DIR, { recursive: true });
        await fs.writeFile(GOLDEN_JSON, JSON.stringify(actualSnapshot, null, 2) + '\n', 'utf8');
        console.log(`[regression] Golden updated: ${path.relative(process.cwd(), GOLDEN_JSON)}`);
        console.log(`[regression] Sheets: ${actualSnapshot.sheets.map(s => s.name).join(', ')}`);
        return;
    }

    if (!existsSync(GOLDEN_JSON)) {
        console.error('');
        console.error('[regression] No golden snapshot found at:');
        console.error(`             ${path.relative(process.cwd(), GOLDEN_JSON)}`);
        console.error('');
        console.error('This is expected on first setup. Run ONCE against the known-good engine:');
        console.error('  npm run test:regression:update');
        console.error('');
        console.error('Then commit the generated golden.json. From that point on,');
        console.error('  npm run test:regression');
        console.error('must pass on every subsequent change to the SLA engine.');
        process.exit(2);
    }

    const expectedSnapshot = JSON.parse(await fs.readFile(GOLDEN_JSON, 'utf8'));
    const diffs = diffSnapshots(expectedSnapshot, actualSnapshot);

    if (diffs.length === 0) {
        console.log(`[regression] PASS - ${actualSnapshot.sheets.length} sheets, all cells match golden.`);
        return;
    }

    console.error(`[regression] FAIL - ${diffs.length} cell(s) differ from golden:`);
    const MAX_PRINT = 40;
    diffs.slice(0, MAX_PRINT).forEach(d => console.error(d));
    if (diffs.length > MAX_PRINT) {
        console.error(`  ... and ${diffs.length - MAX_PRINT} more`);
    }
    console.error('');
    console.error('If the difference is INTENTIONAL (you deliberately changed SLA semantics),');
    console.error('update the golden with: npm run test:regression:update');
    console.error('and justify the change in the PR description.');
    process.exit(1);
}

main().catch(err => {
    console.error('[regression] CRASHED:', err);
    process.exit(1);
});
