/**
 * Shared test helpers that have NO dependency on external packages.
 *
 * Kept small on purpose so unit tests of pure modules do not pull in
 * exceljs or moment-timezone. xlsx-writing helpers live in
 * `_xlsxHelpers.js` and are imported only by tests that actually need them.
 */

import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { randomBytes } from 'crypto';

/**
 * Create a disposable temp directory under os.tmpdir().
 *
 * @returns {Promise<{ dir: string, cleanup: () => Promise<void> }>}
 */
export const tmpDir = async () => {
    const suffix = randomBytes(6).toString('hex');
    const dir = path.join(os.tmpdir(), `sla-imports-test-${suffix}`);
    await fs.mkdir(dir, { recursive: true });
    const cleanup = async () => {
        await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    };
    return { dir, cleanup };
};

/**
 * Minimal row factory mirroring the real export schema. Override fields per
 * test via `partial`. Used by tests that construct row OBJECTS for the
 * normalizer directly (not xlsx files).
 */
export const row = (partial = {}) => ({
    'Country code':      'BR',
    'GID':               'Z000TEST',
    'Name':              'Test User (SHS AM LAM)',
    'First name':        'Test',
    'Last name':         'User',
    'Email':             'test.user@example.com',
    'Time zone':         'America/Buenos_Aires',
    'Gama User Status':  'Enabled',
    'User type':         'EXE',
    'Active':            '1',
    'Status':            'ENABLED',
    ...partial
});
