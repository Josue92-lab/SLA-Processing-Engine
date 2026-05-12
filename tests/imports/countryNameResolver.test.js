import { test } from 'node:test';
import assert from 'node:assert/strict';

import { normalizeCountry, _knownAliasCount } from '../../services/imports/countryNameResolver.js';

test('ISO-2 passthrough', () => {
    assert.equal(normalizeCountry('BR'), 'BR');
    assert.equal(normalizeCountry('cl'), 'CL');
    assert.equal(normalizeCountry(' MX '), 'MX');
});

test('English names', () => {
    assert.equal(normalizeCountry('Brazil'), 'BR');
    assert.equal(normalizeCountry('chile'), 'CL');
    assert.equal(normalizeCountry('Peru'), 'PE');
    assert.equal(normalizeCountry('Mexico'), 'MX');
    assert.equal(normalizeCountry('Panama'), 'PA');
});

test('Spanish variants', () => {
    assert.equal(normalizeCountry('México'), 'MX');
    assert.equal(normalizeCountry('Perú'), 'PE');
    assert.equal(normalizeCountry('Panamá'), 'PA');
});

test('Portuguese variants', () => {
    assert.equal(normalizeCountry('Brasil'), 'BR');
    assert.equal(normalizeCountry('brasil'), 'BR');
});

test('multi-word countries', () => {
    assert.equal(normalizeCountry('Costa Rica'), 'CR');
    assert.equal(normalizeCountry('costa  rica'), 'CR');
    assert.equal(normalizeCountry('El Salvador'), 'SV');
    assert.equal(normalizeCountry('República Dominicana'), 'DO');
    assert.equal(normalizeCountry('Estados Unidos'), 'US');
});

test('unknown input returns null', () => {
    assert.equal(normalizeCountry('Peruu'), null);
    assert.equal(normalizeCountry('Narnia'), null);
    assert.equal(normalizeCountry('123'), null);
});

test('empty / nullish input returns null', () => {
    assert.equal(normalizeCountry(null), null);
    assert.equal(normalizeCountry(undefined), null);
    assert.equal(normalizeCountry(''), null);
    assert.equal(normalizeCountry('   '), null);
});

test('alias table has the documented coverage', () => {
    // Just a regression guard: detect accidental table deletions.
    assert.ok(_knownAliasCount() >= 25, `expected >= 25 aliases, got ${_knownAliasCount()}`);
});
