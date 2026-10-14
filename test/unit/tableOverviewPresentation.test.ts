import assert from 'node:assert/strict';
import test from 'node:test';
import { buildTableOverviewItems, formatBytes } from '../../src/webview/tableOverviewPresentation.js';

test('formats safe table overview metadata without losing large integers', () => {
  assert.equal(formatBytes('0'), '0 B');
  assert.equal(formatBytes('1536'), '1.5 KB');
  assert.equal(formatBytes('1099511627776'), '1.0 TB');
  assert.equal(formatBytes('invalid'), '—');

  const items = buildTableOverviewItems({
    objectType: 'table',
    engine: 'InnoDB',
    estimatedRows: '9007199254740993',
    dataBytes: '2097152',
    indexBytes: '1048576',
    autoIncrement: '42',
    collation: 'utf8mb4_unicode_ci',
    updatedAt: '2026-10-13 09:30:00'
  });
  assert.equal(items.find((item) => item.label === '估算行数')?.value, '9,007,199,254,740,993');
  assert.equal(items.find((item) => item.label === '数据大小')?.value, '2.0 MB');
});
