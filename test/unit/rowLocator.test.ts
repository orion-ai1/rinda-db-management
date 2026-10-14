import assert from 'node:assert/strict';
import test from 'node:test';
import { columnReadOnlyReason, isColumnEditable, selectRowLocator } from '../../src/editing/RowLocatorService.js';
import type { ColumnMetadata, TableEditMetadata } from '../../src/editing/types.js';

const column = (name: string, overrides: Partial<ColumnMetadata> = {}): ColumnMetadata => ({
  name,
  ordinal: 1,
  dataType: 'varchar',
  columnType: 'varchar(64)',
  nullable: false,
  characterMaximumLength: 64,
  extra: '',
  characterSet: 'utf8mb4',
  ...overrides
});

test('prefers a visible primary key and falls back to the safest complete unique key', () => {
  const metadata: TableEditMetadata = {
    database: 'db',
    table: 'items',
    columns: [column('hidden_id'), column('nullable_code', { nullable: true }), column('code')],
    uniqueIndexes: [
      { name: 'PRIMARY', primary: true, columns: [{ name: 'hidden_id', sequence: 1, nullable: false }] },
      { name: 'nullable_code', primary: false, columns: [{ name: 'nullable_code', sequence: 1, nullable: true }] },
      { name: 'code', primary: false, columns: [{ name: 'code', sequence: 1, nullable: false }] }
    ]
  };
  assert.deepEqual(selectRowLocator(metadata), {
    kind: 'primary', indexName: 'PRIMARY', columns: ['hidden_id'], permitsNullableValues: false
  });
  assert.deepEqual(selectRowLocator(metadata, ['nullable_code', 'code']), {
    kind: 'unique', indexName: 'code', columns: ['code'], permitsNullableValues: false
  });
});

test('rejects prefix-only unique indexes', () => {
  const metadata: TableEditMetadata = {
    database: 'db',
    table: 'items',
    columns: [column('code')],
    uniqueIndexes: [{
      name: 'code_prefix',
      primary: false,
      columns: [{ name: 'code', sequence: 1, nullable: false, prefixLength: 12 }]
    }]
  };
  assert.equal(selectRowLocator(metadata), undefined);
});

test('only non-key, non-generated, non-binary and non-spatial columns are editable', () => {
  const locator = { kind: 'primary' as const, indexName: 'PRIMARY', columns: ['id'], permitsNullableValues: false };
  assert.equal(isColumnEditable(column('name'), locator), true);
  assert.equal(isColumnEditable(column('id'), locator), false);
  assert.equal(isColumnEditable(column('total', { extra: 'STORED GENERATED', generationExpression: '`a` + `b`' }), locator), false);
  assert.equal(isColumnEditable(column('payload', { dataType: 'blob', columnType: 'blob', characterSet: undefined }), locator), false);
  assert.equal(isColumnEditable(column('place', { dataType: 'geometry', columnType: 'geometry', characterSet: undefined }), locator), false);
  assert.match(columnReadOnlyReason(column('place', { dataType: 'geometry' }), locator) ?? '', /空间字段/);
});
