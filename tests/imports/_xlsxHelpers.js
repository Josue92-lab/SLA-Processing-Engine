/**
 * xlsx-writing helpers. Imported ONLY by tests that actually need to
 * construct a real .xlsx on disk (parser tests, integration tests).
 *
 * Requires `exceljs`. Do not import this from lightweight unit tests of
 * pure modules.
 */

import exceljs from 'exceljs';

export const REQUIRED_HEADERS = [
    'Country code', 'GID', 'Name', 'First name', 'Last name',
    'Email', 'Time zone', 'Gama User Status', 'User type',
    'Active', 'Status'
];

/**
 * Build an .xlsx file on disk with the given header row and data rows.
 *
 * @param {string} filePath - destination path (must end in .xlsx)
 * @param {string[]} headers
 * @param {Array<Record<string, string>>} rows
 */
export const writeXlsx = async (filePath, headers, rows) => {
    const wb = new exceljs.Workbook();
    const ws = wb.addWorksheet('Page 1');
    ws.getRow(1).values = headers;
    rows.forEach((row, i) => {
        const values = headers.map(h => row[h] !== undefined ? row[h] : '');
        ws.getRow(i + 2).values = values;
    });
    await wb.xlsx.writeFile(filePath);
};

/**
 * Write an xlsx with TWO worksheets (tier-1 failure fixture).
 */
export const writeXlsxTwoSheets = async (filePath, headers, rows) => {
    const wb = new exceljs.Workbook();
    const ws1 = wb.addWorksheet('Page 1');
    ws1.getRow(1).values = headers;
    rows.forEach((row, i) => {
        const values = headers.map(h => row[h] !== undefined ? row[h] : '');
        ws1.getRow(i + 2).values = values;
    });
    wb.addWorksheet('Page 2');
    await wb.xlsx.writeFile(filePath);
};
