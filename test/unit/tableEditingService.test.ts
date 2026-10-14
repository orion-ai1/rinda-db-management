import assert from 'node:assert/strict';
import test from 'node:test';
import type { RowMutationService } from '../../src/editing/RowMutationService.js';
import { TableEditingService } from '../../src/editing/TableEditingService.js';
import type { TableMetadataRepository } from '../../src/editing/TableMetadataRepository.js';
import type { TableEditMetadata } from '../../src/editing/types.js';
import type { QueryService } from '../../src/query/QueryService.js';

const primaryOnlyMetadata: TableEditMetadata = {
  database: 'db',
  table: 'keys_only',
  columns: [{ name: 'id', ordinal: 1, dataType: 'int', columnType: 'int', nullable: false, extra: '' }],
  uniqueIndexes: [{
    name: 'PRIMARY', primary: true, columns: [{ name: 'id', sequence: 1, nullable: false }]
  }]
};

test('allows confirmed single-row deletion even when no ordinary field is editable', async () => {
  let deleteCalls = 0;
  const query = {
    async previewTable() {
      return {
        columns: ['id'], rows: [['1']], rowCount: 1, affectedRows: 0,
        durationMs: 1, truncated: false, hasMore: false
      };
    }
  } as unknown as QueryService;
  const metadata = { async get() { return primaryOnlyMetadata; } } as unknown as TableMetadataRepository;
  const mutations = {
    async update() { return ['1']; },
    async delete() { deleteCalls += 1; }
  } as unknown as RowMutationService;
  const page = await new TableEditingService(query, metadata, mutations).loadPage('local', 'db', 'keys_only', 0, 10);
  assert.equal(page.editing.enabled, false);
  assert.equal(page.editing.deletionEnabled, true);
  assert.deepEqual(page.editing.rows[0]?.locatorValues, [{ name: 'id', value: '1' }]);
  const token = page.editing.rows[0]?.token;
  assert.ok(token);

  const rejected = await page.deleteRow({
    token, operationId: 'delete_operation_1', confirmation: 'delete'
  });
  assert.equal(rejected.ok, false);
  assert.equal(deleteCalls, 0);
  const deleted = await page.deleteRow({
    token, operationId: 'delete_operation_2', confirmation: 'DELETE'
  });
  assert.equal(deleted.ok, true);
  assert.equal(deleteCalls, 1);
});

test('never issues row tokens when a table lacks a reliable key', async () => {
  const query = {
    async previewTable() {
      return {
        columns: ['name'], rows: [['read only']], rowCount: 1, affectedRows: 0,
        durationMs: 1, truncated: false, hasMore: false
      };
    }
  } as unknown as QueryService;
  const metadata = {
    async get() {
      return {
        database: 'db', table: 'without_key',
        columns: [{ name: 'name', ordinal: 1, dataType: 'varchar', columnType: 'varchar(64)', nullable: false, extra: '' }],
        uniqueIndexes: []
      } satisfies TableEditMetadata;
    }
  } as unknown as TableMetadataRepository;
  const mutations = {} as RowMutationService;
  const page = await new TableEditingService(query, metadata, mutations).loadPage('local', 'db', 'without_key', 0, 10);
  assert.equal(page.editing.deletionEnabled, false);
  assert.equal(page.editing.rows[0]?.token, undefined);
});
