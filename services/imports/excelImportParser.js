/**
 * Excel import parser.
 *
 * Single responsibility: read an .xlsx file and return an array of raw row
 * objects keyed by the exact header names from row 1. No normalization,
 * no filtering, no business logic - those belong downstream in
 * `userNormalizer.js` and `importValidator.js`.
 *
 * The parser enforces three structural invariants that are tier-1 failures
 * (no write, operator must fix the file):
 *   1. exactly one worksheet
 *   2. row 1 contains all REQUIRED_HEADERS
 *   3. at least one data row after the header
 *
 * Everything else (row-level filtering, TZ validity, country resolution) is
 * deferred. The parser must stay trivial.
 */

import exceljs from 'exceljs';

import { ImportError, ERR } from './errors.js';

/**
 * The minimum header set the import layer consumes. Extra columns in the
 * export are ignored (the real files carry 91 columns; we only need these).
 */
export const REQUIRED_HEADERS = Object.freeze([
    'Email',
    'Name',
    'Time zone',
    'Country code',
    'User type',
    'Active',
    'Status',
    'Gama User Status'
]);

/**
 * Coerce an exceljs cell value to a plain string. exceljs returns:
 *   - primitives for plain cells
 *   - { text, hyperlink } for hyperlink cells
 *   - { richText: [{text}] } for rich-text cells
 *   - { formula, result } for formula cells
 *   - Date objects for date cells
 * We want a deterministic string, or '' for empty.
 */
const cellToString = (raw) => {
    if (raw === null || raw === undefined) return '';
    if (typeof raw === 'string') return raw;
    if (typeof raw === 'number' || typeof raw === 'boolean') return String(raw);
    if (raw instanceof Date) return raw.toISOString();

    // Rich text
    if (Array.isArray(raw.richText)) {
        return raw.richText.map(r => r.text || '').join('');
    }
    // Hyperlink
    if (typeof raw.text === 'string') return raw.text;
    // Formula with pre-computed result
    if (raw.result !== undefined) return cellToString(raw.result);
    // Fallback
    return String(raw);
};

/**
 * Parse an xlsx at the given path into raw row objects.
 *
 * @param {string} filePath - path to the .xlsx file
 * @returns {Promise<Array<object>>} rows where each object has every column
 *   header seen in row 1 as a key (even if empty). Cell values are strings.
 * @throws {ImportError} with codes MULTIPLE_WORKSHEETS | MISSING_HEADERS |
 *   EMPTY_FILE | FILE_READ_FAILED.
 */
export const parseWorkbook = async (filePath) => {
    const wb = new exceljs.Workbook();

    try {
        await wb.xlsx.readFile(filePath);
    } catch (err) {
        throw new ImportError(
            ERR.FILE_READ_FAILED,
            `Could not read xlsx file: ${err.message}`,
            { cause: err.message }
        );
    }

    return extractRows(wb);
};

/**
 * Parse from a Buffer. Convenient for tests and future upload streaming.
 *
 * @param {Buffer} buffer - xlsx bytes
 * @returns {Promise<Array<object>>}
 */
export const parseBuffer = async (buffer) => {
    const wb = new exceljs.Workbook();
    try {
        await wb.xlsx.load(buffer);
    } catch (err) {
        throw new ImportError(
            ERR.FILE_READ_FAILED,
            `Could not parse xlsx buffer: ${err.message}`,
            { cause: err.message }
        );
    }
    return extractRows(wb);
};

/**
 * Internal: workbook -> row objects + invariant checks.
 */
const extractRows = (wb) => {
    if (wb.worksheets.length === 0) {
        throw new ImportError(ERR.EMPTY_FILE, 'Workbook contains no worksheets.');
    }
    if (wb.worksheets.length > 1) {
        throw new ImportError(
            ERR.MULTIPLE_WORKSHEETS,
            `Expected exactly one worksheet, got ${wb.worksheets.length}.`,
            { sheetNames: wb.worksheets.map(s => s.name) }
        );
    }

    const sheet = wb.worksheets[0];
    const rowCount = sheet.rowCount;

    if (rowCount < 1) {
        throw new ImportError(ERR.EMPTY_FILE, 'Worksheet is empty.');
    }

    // --- Header row ---
    const headerRow = sheet.getRow(1);
    const headers = [];
    const columnCount = sheet.columnCount;
    for (let c = 1; c <= columnCount; c++) {
        const name = cellToString(headerRow.getCell(c).value).trim();
        headers.push(name);
    }

    // Missing-header check: look for every REQUIRED_HEADERS entry.
    const missing = REQUIRED_HEADERS.filter(h => !headers.includes(h));
    if (missing.length > 0) {
        throw new ImportError(
            ERR.MISSING_HEADERS,
            `Required header(s) missing: ${missing.join(', ')}`,
            { missing, seen: headers.filter(h => h !== '') }
        );
    }

    // --- Data rows ---
    const rows = [];
    for (let r = 2; r <= rowCount; r++) {
        const row = sheet.getRow(r);
        // Skip rows exceljs reports as fully empty (shape preservation only).
        if (!row.hasValues) continue;

        const obj = {};
        for (let c = 1; c <= columnCount; c++) {
            const header = headers[c - 1];
            if (!header) continue; // unnamed columns ignored
            obj[header] = cellToString(row.getCell(c).value).trim();
        }
        rows.push(obj);
    }

    if (rows.length === 0) {
        throw new ImportError(
            ERR.EMPTY_FILE,
            'Worksheet has a header but no data rows.'
        );
    }

    return rows;
};
