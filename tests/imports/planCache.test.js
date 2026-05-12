import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createPlanCache } from '../../services/imports/planCache.js';

test('put + get round-trip', () => {
    const cache = createPlanCache({ sweepIntervalMs: 0 });
    const id = cache.put({ type: 'external', plan: { hello: 'world' } });
    assert.ok(id);
    const got = cache.get(id);
    assert.equal(got.type, 'external');
    assert.deepEqual(got.plan, { hello: 'world' });
    assert.equal(got.planId, id);
});

test('get returns undefined for unknown id', () => {
    const cache = createPlanCache({ sweepIntervalMs: 0 });
    assert.equal(cache.get('does-not-exist'), undefined);
});

test('entries expire after TTL and are removed on read', () => {
    let now = 1000;
    const cache = createPlanCache({ ttlMs: 100, sweepIntervalMs: 0, now: () => now });
    const id = cache.put({ type: 'external', plan: {} });
    now += 99;
    assert.ok(cache.get(id), 'entry still valid at t+99');
    now += 2;
    assert.equal(cache.get(id), undefined, 'entry expired at t+101');
    assert.equal(cache.size(), 0, 'expired entry purged on get');
});

test('size reports live count (reaps expired)', () => {
    let now = 1000;
    const cache = createPlanCache({ ttlMs: 100, sweepIntervalMs: 0, now: () => now });
    cache.put({ type: 'external', plan: {} });
    cache.put({ type: 'internal', plan: {} });
    assert.equal(cache.size(), 2);
    now += 200;
    assert.equal(cache.size(), 0);
});

test('delete removes entry', () => {
    const cache = createPlanCache({ sweepIntervalMs: 0 });
    const id = cache.put({ type: 'external', plan: {} });
    assert.equal(cache.delete(id), true);
    assert.equal(cache.get(id), undefined);
});

test('clear removes everything', () => {
    const cache = createPlanCache({ sweepIntervalMs: 0 });
    cache.put({ type: 'external', plan: {} });
    cache.put({ type: 'internal', plan: {} });
    cache.clear();
    assert.equal(cache.size(), 0);
});

test('planId values are unique across puts', () => {
    const cache = createPlanCache({ sweepIntervalMs: 0 });
    const ids = new Set();
    for (let i = 0; i < 50; i++) {
        ids.add(cache.put({ type: 'external', plan: { i } }));
    }
    assert.equal(ids.size, 50);
});

test('getOrThrow returns the entry when present', () => {
    const cache = createPlanCache({ sweepIntervalMs: 0 });
    const id = cache.put({ type: 'external', plan: { a: 1 } });
    const entry = cache.getOrThrow(id);
    assert.equal(entry.plan.a, 1);
});

test('getOrThrow throws ImportError(PLAN_STALE) when missing', () => {
    const cache = createPlanCache({ sweepIntervalMs: 0 });
    assert.throws(() => cache.getOrThrow('missing-id'), (err) => {
        assert.equal(err.name, 'ImportError');
        assert.equal(err.code, 'PLAN_STALE');
        assert.equal(err.details.planId, 'missing-id');
        return true;
    });
});

test('getOrThrow throws ImportError(PLAN_STALE) when expired', () => {
    let now = 1000;
    const cache = createPlanCache({ ttlMs: 50, sweepIntervalMs: 0, now: () => now });
    const id = cache.put({ type: 'external', plan: {} });
    now += 100;
    assert.throws(() => cache.getOrThrow(id), (err) => {
        assert.equal(err.code, 'PLAN_STALE');
        return true;
    });
});
