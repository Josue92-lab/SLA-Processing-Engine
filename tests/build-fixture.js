/**
 * Build fixtures/input.xlsx from the declarative fixtures/tickets.json.
 *
 * Why this exists:
 *   - Binary .xlsx files are un-reviewable in PRs. Encoding the fixture as JSON
 *     makes the test corpus both diffable and commentable.
 *   - Regenerating the input from source keeps the fixture deterministic.
 *
 * Usage (typically auto-invoked by regression.js when input.xlsx is missing):
 *   node tests/build-fixture.js
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import exceljs from 'exceljs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const TICKETS_JSON = path.resolve(__dirname, 'fixtures/tickets.json');
const OUTPUT_XLSX  = path.resolve(__dirname, 'fixtures/input.xlsx');

async function main() {
    const raw = await fs.readFile(TICKETS_JSON, 'utf8');
    const spec = JSON.parse(raw);

    const { columns, tickets } = spec;
    if (!Array.isArray(columns) || !Array.isArray(tickets)) {
        throw new Error('tickets.json must declare "columns" and "tickets" arrays.');
    }

    const wb = new exceljs.Workbook();
    const ws = wb.addWorksheet('Incidents');

    // Header row - exact column names the engine maps against.
    ws.getRow(1).values = columns;

    // Data rows. Values written as strings; engine parses with moment(fmt).
    tickets.forEach((t, i) => {
        const row = columns.map(col => t[col] !== undefined ? t[col] : '');
        ws.getRow(i + 2).values = row;
    });

    await wb.xlsx.writeFile(OUTPUT_XLSX);
    console.log(`[build-fixture] Wrote ${tickets.length} tickets -> ${path.relative(process.cwd(), OUTPUT_XLSX)}`);
}

main().catch(err => {
    console.error('[build-fixture] FAILED:', err);
    process.exit(1);
});
