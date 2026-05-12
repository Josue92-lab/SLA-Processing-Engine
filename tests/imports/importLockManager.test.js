import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { runLocked, _resetForTests } from '../../services/imports/importLockManager.js';

beforeEach(() => _resetForTests());

test('serializes concurrent tasks for the same type', async () => {
    const order = [];
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));

    const p1 = runLocked('external', async () => {
        order.push('A-start'); await sleep(20); order.push('A-end'); return 1;
    });
    const p2 = runLocked('external', async () => {
        order.push('B-start'); await sleep(5); order.push('B-end'); return 2;
    });

    const [r1, r2] = await Promise.all([p1, p2]);
    assert.equal(r1, 1);
    assert.equal(r2, 2);
    // A must fully complete before B starts.
    assert.deepEqual(order, ['A-start', 'A-end', 'B-start', 'B-end']);
});

test('different types do NOT serialize against each other', async () => {
    const order = [];
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));

    const pExt = runLocked('external', async () => {
        order.push('ext-start'); await sleep(20); order.push('ext-end');
    });
    const pInt = runLocked('internal', async () => {
        order.push('int-start'); await sleep(5); order.push('int-end');
    });

    await Promise.all([pExt, pInt]);
    // Internal finishes before external because its task is shorter AND
    // they run in parallel (ext-start before int-end).
    assert.ok(order.indexOf('int-end') < order.indexOf('ext-end'));
    assert.ok(order.indexOf('ext-start') < order.indexOf('int-end'));
});

test('error in one task does not break the chain for subsequent tasks', async () => {
    const results = [];
    const p1 = runLocked('external', async () => { throw new Error('boom'); });
    const p2 = runLocked('external', async () => { results.push('ok2'); return 'ok2'; });

    await assert.rejects(() => p1, /boom/);
    const r2 = await p2;
    assert.equal(r2, 'ok2');
    assert.deepEqual(results, ['ok2']);
});

test('validates inputs', async () => {
    await assert.rejects(() => runLocked('', async () => 1), /non-empty string/);
    await assert.rejects(() => runLocked('external', 'not-a-fn'), /must be a function/);
});
