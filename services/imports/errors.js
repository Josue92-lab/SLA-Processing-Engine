/**
 * Import-layer error taxonomy.
 *
 * All failures inside services/imports/ throw an `ImportError` with a
 * well-known `code` from `ERR`. The HTTP layer maps codes to status codes
 * and to user-facing messages.
 *
 * Never throw strings. Never throw plain Error. Downstream consumers
 * (tests, the router) match on `code`, not on `message`.
 */

export class ImportError extends Error {
    /**
     * @param {string} code - one of the constants in `ERR`
     * @param {string} message - human-readable summary
     * @param {object} [details] - machine-readable payload (row numbers, etc.)
     */
    constructor(code, message, details = {}) {
        super(message);
        this.name = 'ImportError';
        this.code = code;
        this.details = details;
    }
}

export const ERR = Object.freeze({
    // Tier 1 - parser
    FILE_READ_FAILED:         'FILE_READ_FAILED',
    MULTIPLE_WORKSHEETS:      'MULTIPLE_WORKSHEETS',
    MISSING_HEADERS:          'MISSING_HEADERS',
    EMPTY_FILE:               'EMPTY_FILE',

    // Tier 1 - cross-file
    FILE_SWAP_DETECTED:           'FILE_SWAP_DETECTED',
    CROSS_FILE_USERTYPE_CONFLICT: 'CROSS_FILE_USERTYPE_CONFLICT',

    // Snapshot / sidecar
    SNAPSHOT_NOT_FOUND:       'SNAPSHOT_NOT_FOUND',
    SNAPSHOT_CORRUPT:         'SNAPSHOT_CORRUPT',

    // Planner / applier
    PLAN_STALE:               'PLAN_STALE',
    INVALID_MODE:             'INVALID_MODE'
});
