import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import fs from 'fs/promises';

import {
    parseWorkbook,
    parseBuffer,
    REQUIRED_HEADERS
} from '../../services/imports/excelImportParser.js';
import { ERR } from '../../services/imports/errors.js';
import { tmpDir, row } from './_helpers.js';
import { writeXlsx, writeXlsxTwoSheets } from './_xlsxHelpers.js';

test('parses a well-formed xlsx into row objects', async (t) => {
    const { dir, cleanup } = await tmpDir();
    t.after(cleanup);

    const file = path.join(dir, 'good.xlsx');
    await writeXlsx(file, REQUIRED_HEADERS, [
        row({ Email: 'a@x.com', Name: 'A', 'User type': 'EXE' }),
        row({ Email: 'b@x.com', Name: 'B', 'User type': 'OSE' })
    ]);

    const rows = await parseWorkbook(file);
    assert.equal(rows.length, 2);
    assert.equal(rows[0]['Email'], 'a@x.com');
    assert.equal(rows[0]['User type'], 'EXE');
    assert.equal(rows[1]['User type'], 'OSE');
});

test('rejects multiple worksheets with MULTIPLE_WORKSHEETS', async (t) => {
    const { dir, cleanup } = await tmpDir();
    t.after(cleanup);

    const file = path.join(dir, 'two.xlsx');
    await writeXlsxTwoSheets(file, REQUIRED_HEADERS, [row()]);

    await assert.rejects(() => parseWorkbook(file), (err) => {
        assert.equal(err.code, ERR.MULTIPLE_WORKSHEETS);
        return true;
    });
});

test('rejects missing required headers with MISSING_HEADERS and reports which', async (t) => {
    const { dir, cleanup } = await tmpDir();
    t.after(cleanup);

    const file = path.join(dir, 'nohdr.xlsx');
    // Drop "Time zone" and "Gama User Status".
    const partial = REQUIRED_HEADERS.filter(h => h !== 'Time zone' && h !== 'Gama User Status');
    await writeXlsx(file, partial, [row()]);

    await assert.rejects(() => parseWorkbook(file), (err) => {
        assert.equal(err.code, ERR.MISSING_HEADERS);
        assert.deepEqual([...err.details.missing].sort(), ['Gama User Status', 'Time zone']);
        return true;
    });
});

test('rejects empty worksheet (header only, no data)', async (t) => {
    const { dir, cleanup } = await tmpDir();
    t.after(cleanup);

    const file = path.join(dir, 'empty.xlsx');
    await writeXlsx(file, REQUIRED_HEADERS, []);

    await assert.rejects(() => parseWorkbook(file), (err) => {
        assert.equal(err.code, ERR.EMPTY_FILE);
        return true;
    });
});

test('trims cell values and preserves empty cells as ""', async (t) => {
    const { dir, cleanup } = await tmpDir();
    t.after(cleanup);

    const file = path.join(dir, 'pad.xlsx');
    await writeXlsx(file, REQUIRED_HEADERS, [
        row({ Email: '  padded@x.com  ', 'Time zone': '', 'Country code': '   ' })
    ]);

    const rows = await parseWorkbook(file);
    assert.equal(rows[0]['Email'], 'padded@x.com');
    assert.equal(rows[0]['Time zone'], '');
    assert.equal(rows[0]['Country code'], '');
});

test('rejects unreadable file with FILE_READ_FAILED', async (t) => {
    await assert.rejects(() => parseWorkbook('/nonexistent/path/file.xlsx'), (err) => {
        assert.equal(err.code, ERR.FILE_READ_FAILED);
        return true;
    });
});

test('parseBuffer works identically for small inputs', async (t) => {
    const { dir, cleanup } = await tmpDir();
    t.after(cleanup);
    const file = path.join(dir, 'buf.xlsx');
    await writeXlsx(file, REQUIRED_HEADERS, [row({ Email: 'x@y.com' })]);
    const buf = await fs.readFile(file);
    const rows = await parseBuffer(buf);
    assert.equal(rows[0]['Email'], 'x@y.com');
});

test('ignores columns beyond REQUIRED_HEADERS but keeps them accessible', async (t) => {
    const { dir, cleanup } = await tmpDir();
    t.after(cleanup);

    const file = path.join(dir, 'extra.xlsx');
    const headers = [...REQUIRED_HEADERS, 'Extra'];
    await writeXlsx(file, headers, [
        { ...row({ Email: 'ex@x.com' }), Extra: 'whatever' }
    ]);
    const rows = await parseWorkbook(file);
    assert.equal(rows[0]['Email'], 'ex@x.com');
    assert.equal(rows[0]['Extra'], 'whatever');
});
