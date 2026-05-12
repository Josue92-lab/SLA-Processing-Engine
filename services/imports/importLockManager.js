/**
 * Per-type serialization of import apply / rollback operations.
 *
 * Guarantees:
 *   - for a given `type` ('external' | 'internal'), only one locked block
 *     runs at a time
 *   - errors inside one task DO NOT break the chain for subsequent tasks
 *   - per-type chains are independent (external apply does not block internal)
 *
 * This is intentionally a tiny module. It does NOT interact with
 * settingsService's own `writeQueue` - that queue serializes writes INSIDE
 * updateSettings, while this lock coordinates the outer multi-step
 * transaction (snapshot + updateSettings + sidecar write).
 *
 * Process-local only. A future multi-process deployment would need a
 * database-backed lock; out of scope for v1.
 */

const chains = new Map();

/**
 * Run `fn` inside the serialization chain for `type`. Returns `fn`'s result.
 *
 * @template T
 * @param {string} type
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
export const runLocked = async (type, fn) => {
    if (typeof type !== 'string' || type === '') {
        throw new Error('runLocked: type must be a non-empty string');
    }
    if (typeof fn !== 'function') {
        throw new Error('runLocked: fn must be a function');
    }

    // `catch(() => {})` on the prior chain ensures a rejected task does not
    // poison subsequent tasks. We still surface the CURRENT task's error
    // to the current caller by awaiting `task` directly.
    const prior = chains.get(type) || Promise.resolve();
    let settleCurrent;
    const gate = new Promise(resolve => { settleCurrent = resolve; });

    // The chain advances on `gate`, which resolves (never rejects) once our
    // task completes one way or the other. This keeps the chain's promise
    // type uniform.
    chains.set(type, prior.then(() => gate));

    try {
        await prior.catch(() => {});
        return await fn();
    } finally {
        settleCurrent();
        // Clean up the map entry when the chain has caught up, so a
        // long-lived process does not hold an unbounded number of types.
        queueMicrotask(() => {
            const current = chains.get(type);
            if (current) {
                current.then(() => {
                    // Only delete if still pointing at the same tail.
                    if (chains.get(type) === current) chains.delete(type);
                });
            }
        });
    }
};

/**
 * Test-only: reset internal state. Not exported from the package's public
 * surface; used to isolate unit tests from each other.
 */
export const _resetForTests = () => {
    chains.clear();
};
