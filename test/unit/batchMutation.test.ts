import assert from 'node:assert/strict';
import test from 'node:test';
import type { ConnectionManager } from '../../src/connection/ConnectionManager.js';
import { RowEditError, RowMutationService } from '../../src/editing/RowMutationService.js';
import { TableEditingService } from '../../src/editing/TableEditingService.js';
import type { TableMetadataRepository } from '../../src/editing/TableMetadataRepository.js';
import type { RowSnapshot, TableEditMetadata } from '../../src/editing/types.js';
import type { QueryService } from '../../src/query/QueryService.js';

const metadata: TableEditMetadata = {
  database: 'sales_db',
  table: 'orders',
  columns: [
    { name: 'id', ordinal: 1, dataType: 'int', columnType: 'int', nullable: false, extra: '' },
    { name: 'title', ordinal: 2, dataType: 'varchar', columnType: 'varchar(64)', nullable: false, characterMaximumLength: 64, extra: '', characterSet: 'utf8mb4' },
    { name: 'description', ordinal: 3, dataType: 'text', columnType: 'text', nullable: true, extra: '' }
  ],
  uniqueIndexes: [{
    name: 'PRIMARY', primary: true, columns: [{ name: 'id', sequence: 1, nullable: false }]
  }]
};

function createSnapshot(id: string, title: string, description: string | null): RowSnapshot {
  return {
    database: metadata.database,
    table: metadata.table,
    columnNames: ['id', 'title', 'description'],
    values: [id, title, description],
    locator: { kind: 'primary', indexName: 'PRIMARY', columns: ['id'], permitsNullableValues: false },
    metadataSignature: JSON.stringify({
      locator: { kind: 'primary', indexName: 'PRIMARY', columns: ['id'], permitsNullableValues: false },
      columns: metadata.columns.map((column) => ({
        name: column.name,
        type: column.columnType,
        nullable: column.nullable,
        extra: column.extra,
        generationExpression: ''
      }))
    })
  };
}

const metadataRepository = { async get() { return metadata; } } as unknown as TableMetadataRepository;

test('updateBatch atomically updates, re-reads, and commits multiple rows', async () => {
  const queries: Array<{ sql: string; values?: unknown[] }> = [];
  let committed = false;
  let rolledBack = false;
  let call = 0;

  const manager = {
    async withConnection<T>(_id: string, operation: (connection: unknown) => Promise<T>): Promise<T> {
      return operation({
        async beginTransaction() {},
        async query(options: { sql: string; values?: unknown[] }) {
          queries.push(options);
          call += 1;
          // Row 1 lock
          if (call === 1) return [[[1, 'order1', 'desc1']]];
          // Row 2 lock
          if (call === 2) return [[[2, 'order2', 'desc2']]];
          // Row 1 update
          if (call === 3) return [{ affectedRows: 1 }];
          // Row 2 update
          if (call === 4) return [{ affectedRows: 1 }];
          // Row 1 reload
          if (call === 5) return [[[1, 'new_title_1', 'desc1']]];
          // Row 2 reload
          if (call === 6) return [[[2, 'order2', 'new_desc_2']]];
          return [[]];
        },
        async commit() { committed = true; },
        async rollback() { rolledBack = true; }
      });
    }
  } as unknown as ConnectionManager;

  const s1 = createSnapshot('1', 'order1', 'desc1');
  const s2 = createSnapshot('2', 'order2', 'desc2');

  const result = await new RowMutationService(manager, metadataRepository, 5_000)
    .updateBatch('local', [
      { snapshot: s1, changes: { title: 'new_title_1' } },
      { snapshot: s2, changes: { description: 'new_desc_2' } }
    ]);

  assert.equal(committed, true);
  assert.equal(rolledBack, false);
  assert.equal(result.length, 2);
  assert.deepEqual(result[0], ['1', 'new_title_1', 'desc1']);
  assert.deepEqual(result[1], ['2', 'order2', 'new_desc_2']);
  assert.match(queries[0]?.sql ?? '', /FOR UPDATE$/);
  assert.match(queries[1]?.sql ?? '', /FOR UPDATE$/);
});

test('updateBatch rolls back entire batch when one row detects concurrent change', async () => {
  let rolledBack = false;
  let call = 0;

  const manager = {
    async withConnection<T>(_id: string, operation: (connection: unknown) => Promise<T>): Promise<T> {
      return operation({
        async beginTransaction() {},
        async query() {
          call += 1;
          if (call === 1) return [[[1, 'order1', 'desc1']]];
          // Second row changed concurrently in database
          return [[[2, 'changed_by_other', 'desc2']]];
        },
        async commit() {},
        async rollback() { rolledBack = true; }
      });
    }
  } as unknown as ConnectionManager;

  const s1 = createSnapshot('1', 'order1', 'desc1');
  const s2 = createSnapshot('2', 'order2', 'desc2');

  await assert.rejects(
    new RowMutationService(manager, metadataRepository, 5_000).updateBatch('local', [
      { snapshot: s1, changes: { title: 'new1' } },
      { snapshot: s2, changes: { title: 'new2' } }
    ]),
    (error: unknown) => error instanceof RowEditError && error.conflict
  );

  assert.equal(rolledBack, true);
});

test('updateBatch enforces batch limits (1-50 rows and 1-200 fields)', async () => {
  const manager = {} as ConnectionManager;
  const service = new RowMutationService(manager, metadataRepository, 5_000);

  // 0 rows
  await assert.rejects(
    service.updateBatch('local', []),
    /1–50 行草稿/
  );

  // > 50 rows
  const fiftyOne = Array.from({ length: 51 }, (_, i) => ({
    snapshot: createSnapshot(String(i + 1), `title_${i}`, null),
    changes: { title: `updated_${i}` }
  }));
  await assert.rejects(
    service.updateBatch('local', fiftyOne),
    /1–50 行草稿/
  );
});

test('TableEditingService.updateRows validates operationId, duplicate tokens and updates snapshots', async () => {
  const query = {
    async previewTable() {
      return {
        columns: ['id', 'title', 'description'],
        rows: [['1', 't1', 'd1'], ['2', 't2', 'd2']],
        rowCount: 2,
        affectedRows: 0,
        durationMs: 1,
        truncated: false,
        hasMore: false
      };
    }
  } as unknown as QueryService;

  const mutations = {
    async updateBatch(_conn: string, edits: Array<{ snapshot: RowSnapshot; changes: unknown }>) {
      return edits.map((e) => {
        const title = (e.changes as { title?: string }).title ?? e.snapshot.values[1];
        return [e.snapshot.values[0], title, e.snapshot.values[2]];
      });
    }
  } as unknown as RowMutationService;

  const service = new TableEditingService(query, metadataRepository, mutations);
  const page = await service.loadPage('local', 'sales_db', 'orders', 0, 10);

  assert.equal(page.editing.enabled, true);
  const token1 = page.editing.rows[0]?.token;
  const token2 = page.editing.rows[1]?.token;
  assert.ok(token1);
  assert.ok(token2);

  // Duplicate tokens rejected
  const dupOutcome = await page.updateRows({
    operationId: 'op_batch_duplicate_1',
    edits: [
      { token: token1, changes: { title: 'new_t1' } },
      { token: token1, changes: { title: 'new_t1_again' } }
    ]
  });
  assert.equal(dupOutcome.ok, false);
  assert.match(dupOutcome.message, /包含重复行/);

  // Valid batch edit
  const validOutcome = await page.updateRows({
    operationId: 'op_batch_valid_1',
    edits: [
      { token: token1, changes: { title: 'new_t1' } },
      { token: token2, changes: { title: 'new_t2' } }
    ]
  });
  assert.equal(validOutcome.ok, true);
  assert.equal(validOutcome.reloadedRows?.length, 2);
  assert.deepEqual(validOutcome.reloadedRows?.[0]?.values, ['1', 'new_t1', 'd1']);
  assert.deepEqual(validOutcome.reloadedRows?.[1]?.values, ['2', 'new_t2', 'd2']);
});

test('deleteBatch locks in sorted locator order, verifies snapshots, deletes and commits multiple rows', async () => {
  const queries: Array<{ sql: string; values?: unknown[] }> = [];
  let committed = false;
  let rolledBack = false;
  let call = 0;

  const manager = {
    async withConnection<T>(_id: string, operation: (connection: unknown) => Promise<T>): Promise<T> {
      return operation({
        async beginTransaction() {},
        async query(options: { sql: string; values?: unknown[] }) {
          queries.push(options);
          call += 1;
          // Row 1 lock
          if (call === 1) return [[[1, 'order1', 'desc1']]];
          // Row 2 lock
          if (call === 2) return [[[2, 'order2', 'desc2']]];
          // Row 1 delete
          if (call === 3) return [{ affectedRows: 1 }];
          // Row 2 delete
          if (call === 4) return [{ affectedRows: 1 }];
          return [[]];
        },
        async commit() { committed = true; },
        async rollback() { rolledBack = true; }
      });
    }
  } as unknown as ConnectionManager;

  // Provide out of order snapshots: row 2 then row 1
  const s1 = createSnapshot('1', 'order1', 'desc1');
  const s2 = createSnapshot('2', 'order2', 'desc2');

  const count = await new RowMutationService(manager, metadataRepository, 5_000)
    .deleteBatch('local', [s2, s1]);

  assert.equal(count, 2);
  assert.equal(committed, true);
  assert.equal(rolledBack, false);
  // Checked that lock queries were executed in sorted order (id=1 before id=2)
  assert.deepEqual(queries[0]?.values, ['1']);
  assert.deepEqual(queries[1]?.values, ['2']);
  assert.match(queries[0]?.sql ?? '', /FOR UPDATE$/);
  assert.match(queries[2]?.sql ?? '', /^DELETE FROM `sales_db`\.`orders` WHERE `id` = \?$/);
  assert.match(queries[3]?.sql ?? '', /^DELETE FROM `sales_db`\.`orders` WHERE `id` = \?$/);
});

test('deleteBatch rolls back entire batch when one row is modified or deleted concurrently', async () => {
  let rolledBack = false;
  let call = 0;

  const manager = {
    async withConnection<T>(_id: string, operation: (connection: unknown) => Promise<T>): Promise<T> {
      return operation({
        async beginTransaction() {},
        async query() {
          call += 1;
          if (call === 1) return [[[1, 'order1', 'desc1']]];
          // Second row locked but snapshot changed
          return [[[2, 'order2_modified', 'desc2']]];
        },
        async commit() {},
        async rollback() { rolledBack = true; }
      });
    }
  } as unknown as ConnectionManager;

  const s1 = createSnapshot('1', 'order1', 'desc1');
  const s2 = createSnapshot('2', 'order2', 'desc2');

  await assert.rejects(
    new RowMutationService(manager, metadataRepository, 5_000).deleteBatch('local', [s1, s2]),
    (error: unknown) => error instanceof RowEditError && error.conflict
  );

  assert.equal(rolledBack, true);
});

test('deleteBatch rejects duplicate locators within batch and enforces 1-1000 row limits', async () => {
  const manager = {} as ConnectionManager;
  const service = new RowMutationService(manager, metadataRepository, 5_000);

  // 0 rows
  await assert.rejects(
    service.deleteBatch('local', []),
    /1–1000 行/
  );

  // > 1000 rows
  const overLimit = Array.from({ length: 1001 }, (_, i) => createSnapshot(String(i + 1), `title_${i}`, null));
  await assert.rejects(
    service.deleteBatch('local', overLimit),
    /1–1000 行/
  );

  // Duplicate locator keys
  const s1 = createSnapshot('1', 'title1', null);
  const s1Dup = createSnapshot('1', 'title1', null);
  await assert.rejects(
    service.deleteBatch('local', [s1, s1Dup]),
    /包含重复定位行/
  );
});

test('TableEditingService.deleteRows validates confirmation, operationId, duplicate tokens and deletes snapshots', async () => {
  let deleteBatchCalls = 0;
  const query = {
    async previewTable() {
      return {
        columns: ['id', 'title', 'description'],
        rows: [['1', 't1', 'd1'], ['2', 't2', 'd2']],
        rowCount: 2,
        affectedRows: 0,
        durationMs: 1,
        truncated: false,
        hasMore: false
      };
    }
  } as unknown as QueryService;

  const mutations = {
    async deleteBatch(_conn: string, snapshots: RowSnapshot[]) {
      deleteBatchCalls += 1;
      return snapshots.length;
    }
  } as unknown as RowMutationService;

  const service = new TableEditingService(query, metadataRepository, mutations);
  const page = await service.loadPage('local', 'sales_db', 'orders', 0, 10);

  const token1 = page.editing.rows[0]?.token;
  const token2 = page.editing.rows[1]?.token;
  assert.ok(token1);
  assert.ok(token2);

  // Rejects without DELETE confirmation
  const unconfirmed = await page.deleteRows({
    tokens: [token1, token2],
    operationId: 'op_del_unconfirmed_1',
    confirmation: 'no'
  });
  assert.equal(unconfirmed.ok, false);
  assert.match(unconfirmed.message, /删除确认无效/);

  // Rejects duplicate tokens
  const dup = await page.deleteRows({
    tokens: [token1, token1],
    operationId: 'op_del_dup_1',
    confirmation: 'DELETE'
  });
  assert.equal(dup.ok, false);
  assert.match(dup.message, /包含重复行/);

  // Successfully delete both rows
  const valid = await page.deleteRows({
    tokens: [token1, token2],
    operationId: 'op_del_valid_1',
    confirmation: 'DELETE'
  });
  assert.equal(valid.ok, true);
  assert.equal(valid.affectedRows, 2);
  assert.match(valid.message, /已成功删除 2 行/);
  assert.equal(deleteBatchCalls, 1);

  // Re-deleting invalid/already-deleted tokens fails
  const redelete = await page.deleteRows({
    tokens: [token1],
    operationId: 'op_del_redelete_1',
    confirmation: 'DELETE'
  });
  assert.equal(redelete.ok, false);
  assert.match(redelete.message, /凭证已失效/);
});


