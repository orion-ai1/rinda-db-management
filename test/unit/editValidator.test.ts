import assert from 'node:assert/strict';
import test from 'node:test';
import { validateRowChanges, validateInsertRow } from '../../src/editing/EditValidator.js';
import type { ColumnMetadata, RowLocator, TableEditMetadata } from '../../src/editing/types.js';

const column = (name: string, overrides: Partial<ColumnMetadata> = {}): ColumnMetadata => ({
  name,
  ordinal: 1,
  dataType: 'varchar',
  columnType: 'varchar(8)',
  nullable: false,
  characterMaximumLength: 8,
  extra: '',
  characterSet: 'utf8mb4',
  ...overrides
});
const locator: RowLocator = {
  kind: 'primary', indexName: 'PRIMARY', columns: ['id'], permitsNullableValues: false
};
const metadata: TableEditMetadata = {
  database: 'db',
  table: 'items',
  columns: [
    column('id', { dataType: 'int', columnType: 'int unsigned', characterMaximumLength: undefined }),
    column('name'),
    column('note', { nullable: true }),
    column('quantity', { dataType: 'tinyint', columnType: 'tinyint unsigned', characterMaximumLength: undefined }),
    column('price', { dataType: 'decimal', columnType: 'decimal(5,2)', numericPrecision: 5, numericScale: 2, characterMaximumLength: undefined }),
    column('settings', { dataType: 'json', columnType: 'json', characterMaximumLength: undefined }),
    column('payload', { dataType: 'blob', columnType: 'blob', characterMaximumLength: 65535, characterSet: undefined })
  ],
  uniqueIndexes: []
};

test('normalizes valid typed edits and preserves ordinary text', () => {
  assert.deepEqual(validateRowChanges({
    name: '  name  ',
    note: null,
    quantity: ' 255 ',
    price: '12.30',
    settings: '{"ok":true}'
  }, metadata, locator), {
    values: {
      name: '  name  ',
      note: null,
      quantity: '255',
      price: '12.30',
      settings: '{"ok":true}'
    },
    errors: {}
  });
});

test('rejects keys, BLOB values, invalid NULL, overflow, precision, JSON and length', () => {
  const result = validateRowChanges({
    id: '2',
    payload: 'text',
    name: '这段文字已经超过八个字符',
    quantity: '256',
    price: '1234.56',
    settings: '{bad',
    extra: null
  }, metadata, locator);
  assert.equal(result.values, undefined);
  assert.match(result.errors.id ?? '', /不可编辑/);
  assert.match(result.errors.payload ?? '', /不可编辑/);
  assert.match(result.errors.name ?? '', /长度/);
  assert.match(result.errors.quantity ?? '', /范围/);
  assert.match(result.errors.price ?? '', /总位数/);
  assert.match(result.errors.settings ?? '', /JSON/);
  assert.match(result.errors.extra ?? '', /不可编辑/);
});

test('requires at least one change and rejects NULL for required fields', () => {
  assert.match(validateRowChanges({}, metadata, locator).errors.form ?? '', /没有/);
  assert.match(validateRowChanges({ name: null }, metadata, locator).errors.name ?? '', /NULL/);
});

test('validateInsertRow normalizes valid insert values and skips auto_increment/unsupported columns', () => {
  const insertMeta: TableEditMetadata = {
    database: 'db',
    table: 'users',
    columns: [
      column('id', { dataType: 'int', extra: 'auto_increment' }),
      column('username', { nullable: false }),
      column('bio', { nullable: true }),
      column('age', { dataType: 'int', columnType: 'int', nullable: true })
    ],
    uniqueIndexes: []
  };

  const outcome = validateInsertRow({
    id: '123', // auto_increment column, should be skipped
    username: 'alice',
    bio: null,
    age: ' 28 '
  }, insertMeta);

  assert.deepEqual(outcome.values, {
    username: 'alice',
    bio: null,
    age: '28'
  });
  assert.deepEqual(outcome.errors, {});

  // Rejects NULL for required field
  const invalid = validateInsertRow({
    username: null
  }, insertMeta);
  assert.ok(invalid.errors?.username?.includes('不允许 NULL'));
});
