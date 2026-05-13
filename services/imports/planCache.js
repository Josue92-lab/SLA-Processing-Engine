/**
 * In-memory plan cache for the two-stage preview -> apply flow.
 *
 * Semantics (v1):
 *   - Plans are stored in a per-process Map. Server restart invalidates
 *     every plan. This is intentional (decision 16): persistence would
 *     trade away a safety property (stale state never applied) for a
 *     convenience we do not need.
 *   - TTL: 15 minutes (decision 16). After expiry, `get()` returns
 *     `undefined` and the entry is eagerly removed so the Map does not
 *     leak memory during long server uptime.
 *   - Keys are UUID v4 strings produced by the caller and returned to
 *     the client as `planId`.
 *
 * The apply step reads the cached plan AND the cached rows (analystRecords
 * / vipRecords) to support the silent-rebuild staleness guard without
 * forcing the operator to re-upload; both are stored here for that reason.
 *
 * The cache holds NO file contents - only already-parsed + normalized
 * in-memory structures. Uploaded .xlsx bytes never survive the preview
 * request (they are unlinked in the route's `finally` block).
 */

import { randomUUID } from 'crypto';

import { ImportError, ERR } from './errors.js';

const DEFAULT_TTL_MS = 15 * 60 * 1000;
// Sweep every minute. This is a bound on "how long an expired entry can
// linger after the TTL elapsed" - never a correctness concern, because
// `get()` checks expiry synchronously. Reaping keeps the Map small.
const SWEEP_INTERVAL_MS = 60 * 1000;

/**
 * @typedef {object} CachedPlanEntry
 * @property {string}  planId
 * @property {'external'|'internal'} type
 * @property {object}  plan                - the ImportPlan produced by importPlanner
 * @property {Array<object>} analystRecords - normalized rows (used by the apply silent-rebuild path)
 * @property {Array<object>} vipRecords     - normalized rows (used by the apply silent-rebuild path)
 * @property {string}  currentSettingsHash - sha256 hex of the settings at preview time
 * @property {number}  createdAtMs
 * @property {number}  expiresAtMs
 */

/**
 * Build a fresh cache instance. Exported as a factory so tests can get a
 * clean instance per test without mutating a process-level singleton.
 *
 * @param {object} [opts]
 * @param {number} [opts.ttlMs]             default 15 min
 * @param {number} [opts.sweepIntervalMs]   default 60s
 * @param {() => number} [opts.now]         test-injectable clock
 */
export const createPlanCache = (opts = {}) => {
    const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    const sweepIntervalMs = opts.sweepIntervalMs ?? SWEEP_INTERVAL_MS;
    const now = opts.now || Date.now;

    /** @type {Map<string, CachedPlanEntry>} */
    const store = new Map();

    let sweepTimer = null;
    const startSweep = () => {
        if (sweepTimer || sweepIntervalMs <= 0) return;
        sweepTimer = setInterval(() => sweepExpired(), sweepIntervalMs);
        // Do not let the sweeper keep the Node process alive on its own -
        // it should piggy-back on real work.
        if (typeof sweepTimer.unref === 'function') sweepTimer.unref();
    };

    const stopSweep = () => {
        if (sweepTimer) { clearInterval(sweepTimer); sweepTimer = null; }
    };

    const sweepExpired = () => {
        const t = now();
        let reaped = 0;
        for (const [k, entry] of store) {
            if (entry.expiresAtMs <= t) {
                store.delete(k);
                reaped++;
            }
        }
        if (reaped > 0) {
            console.log(`[planCache] swept ${reaped} expired plan(s)`);
        }
    };

    /**
     * Insert a plan. Returns the generated planId.
     *
     * @param {object} entry - without planId / timestamps; see CachedPlanEntry
     * @returns {string} planId
     */
    const put = (entry) => {
        const planId = randomUUID();
        const createdAtMs = now();
        store.set(planId, {
            ...entry,
            planId,
            createdAtMs,
            expiresAtMs: createdAtMs + ttlMs
        });
        startSweep();
        return planId;
    };

    /**
     * Retrieve a cached plan by id. Returns undefined if missing or expired.
     * Expired entries are removed eagerly.
     */
    const get = (planId) => {
        const entry = store.get(planId);
        if (!entry) return undefined;
        if (entry.expiresAtMs <= now()) {
            store.delete(planId);
            console.log(`[planCache] plan ${planId} expired on read`);
            return undefined;
        }
        return entry;
    };

    const del = (planId) => store.delete(planId);

    /**
     * Variant of `get` that throws a structured `ImportError(ERR.PLAN_STALE)`
     * when the plan is missing or expired. Intended for the apply path so the
     * router can respond with a consistent 409 without branching in-line.
     *
     * @param {string} planId
     * @returns {CachedPlanEntry}
     */
    const getOrThrow = (planId) => {
        const entry = get(planId);
        if (!entry) {
            throw new ImportError(
                ERR.PLAN_STALE,
                `Plan ${planId} not found or expired. Please re-run preview.`,
                { planId }
            );
        }
        return entry;
    };

    const size = () => {
        // Proactively reap before reporting for a consistent view.
        sweepExpired();
        return store.size;
    };

    const clear = () => store.clear();

    return { put, get, getOrThrow, delete: del, size, clear, _stopSweep: stopSweep };
};

// Process-wide singleton used by the HTTP route. Tests inject their own.
export const defaultPlanCache = createPlanCache();
