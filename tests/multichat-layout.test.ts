import test from 'node:test';
import assert from 'node:assert/strict';
import { autoLayout, fitColumns, restoreLayout } from '../src/multichat-layout';

test('automatic grid prefers wide cards and grows with the running chats', () => {
  const shape = (count: number) => {
    const { columns, rows } = autoLayout(count, 4);
    return `${columns}×${rows}`;
  };
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 12, 13, 16, 20].map(shape), [
    '1×1',
    '1×1',
    '2×1',
    '3×1',
    '2×2',
    '3×2',
    '3×2',
    '4×2',
    '4×2',
    '3×3',
    '4×3',
    '4×4',
    '4×4',
    '4×4',
  ]);
});

test('automatic grid never squeezes cards below a readable width', () => {
  assert.equal(fitColumns(600), 1);
  assert.equal(fitColumns(620), 2);
  assert.equal(fitColumns(1400), 4);
  assert.deepEqual(autoLayout(8, fitColumns(700)), { columns: 2, rows: 4 });
  assert.deepEqual(autoLayout(3, fitColumns(0)), { columns: 1, rows: 3 });
});

test('saved layouts keep deliberate choices and adopt automatic for the old default', () => {
  assert.deepEqual(restoreLayout(undefined), { auto: true, rows: 2, columns: 2 });
  assert.deepEqual(restoreLayout({ rows: 2, columns: 2 }), { auto: true, rows: 2, columns: 2 });
  assert.deepEqual(restoreLayout({ rows: 1, columns: 4 }), { auto: false, rows: 1, columns: 4 });
  assert.deepEqual(restoreLayout({ auto: false, rows: 2, columns: 2 }), {
    auto: false,
    rows: 2,
    columns: 2,
  });
  assert.deepEqual(restoreLayout({ auto: true, rows: 9, columns: 'x' }), {
    auto: true,
    rows: 2,
    columns: 2,
  });
});
