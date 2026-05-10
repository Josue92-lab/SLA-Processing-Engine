/**
 * Ticket — row-to-object mapping.
 *
 * Pure data shape. No logic, no regex, no time math. The engine expects
 * ticket objects to be plain indexed-by-header maps so every downstream
 * module (lifecycle, slaRules, aggregates) can read `ticket["Priority"]`,
 * `ticket["Additional comments"]`, etc. without knowing which column
 * they came from.
 *
 * Two helpers:
 *   mapColumnHeaders(sheet) -> { columnIndex: headerName }
 *   rowToTicket(row, columnHeaders) -> { [header]: cellValue }
 *
 * Together they reproduce the exact behaviour of Phase 1 of the original
 * single-pass pipeline, including:
 *   - trimming whitespace from header names (resilience to export variance)
 *   - skipping rows without values (hasValues check)
 *   - treating unknown columns as dropped (we only index known headers)
 *
 * Risk profile: zero. No business rules are expressed here.
 */

/**
 * Build the columnIndex -> headerName map from the worksheet's first row.
 *
 * Trim is deliberate and matches the original behaviour: ServiceNow exports
 * occasionally include trailing spaces in header cells.
 *
 * @param {import('exceljs').Worksheet} sheet
 * @returns {Object<number,string>}
 */
export function mapColumnHeaders(sheet) {
    const columnHeaders = {};
    sheet.getRow(1).eachCell((cell, colNumber) => {
        if (cell.value) {
            columnHeaders[colNumber] = cell.value.toString().trim();
        }
    });
    return columnHeaders;
}

/**
 * Convert a worksheet row into a ticket object keyed by header name.
 *
 * Cells whose column has no mapped header are ignored (intentional: exports
 * sometimes contain trailing columns with no header that still carry values).
 *
 * @param {import('exceljs').Row} row
 * @param {Object<number,string>} columnHeaders
 * @returns {Object<string, any>}
 */
export function rowToTicket(row, columnHeaders) {
    const ticket = {};
    row.eachCell((cell, colNumber) => {
        const headerName = columnHeaders[colNumber];
        if (headerName) ticket[headerName] = cell.value;
    });
    return ticket;
}
