import assert from 'node:assert/strict';
import test from 'node:test';
import type { ConnectionManager } from '../../src/connection/ConnectionManager.js';
import { RowEditError, RowMutationService } from '../../src/editing/RowMutationService.js';
import type { TableMetadataRepository } from '../../src/editing/TableMetadataRepository.js';
import type { RowSnapshot, TableEditMetadata } from '../../src/editing/types.js';

const metadata: TableEditMetadata = {
  database: 'sales-db',
  table: 'order`items',
  columns: [
    { name: 'id', ordinal: 1, dataType: 'int', columnType: 'int', nullable: false, extra: '' },
    { name: 'name', ordinal: 2, dataType: 'varchar', columnType: 'varchar(64)', nullable: false, characterMaximumLength: 64, extra: '', characterSet: 'utf8mb4' }
  ],
  uniqueIndexes: [{
    name: 'PRIMARY', primary: true, columns: [{ name: 'id', sequence: 1, nullable: false }]
  }]
};

const snapshot: RowSnapshot = {
  database: metadata.database,
  table: metadata.table,
  columnNames: ['id', 'name'],
  values: ['1', 'old'],
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

const metadataRepository = { async get() { return metadata; } } as unknown as TableMetadataRepository;

test('locks, compares, parameterizes, updates, re-reads and commits one row', async () => {
  const queries: Array<{ sql: string; values: unknown[] }> = [];
  let committed = false;
  let rolledBack = false;
  let call = 0;
  const manager = {
    async withConnection<T>(_id: string, operation: (connection: unknown) => Promise<T>): Promise<T> {
      return operation({
        async beginTransaction() {},
        async query(options: { sql: string; values: unknown[] }) {
          queries.push(options);
          call += 1;
          if (call === 1) return [[[1, 'old']]];
          if (call === 2) return [{ affectedRows: 1 }];
          return [[[1, 'new']]];
        },
        async commit() { committed = true; },
        async rollback() { rolledBack = true; }
      });
    }
  } as unknown as ConnectionManager;
  const result = await new RowMutationService(manager, metadataRepository, 5_000)
    .update('local', snapshot, { name: 'new' });
  assert.deepEqual(result, ['1', 'new']);
  assert.equal(committed, true);
  assert.equal(rolledBack, false);
  assert.match(queries[0]?.sql ?? '', /FOR UPDATE$/);
  assert.match(queries[1]?.sql ?? '', /^UPDATE `sales-db`\.`order``items` SET `name` = \? WHERE `id` = \?$/);
  assert.deepEqual(queries[1]?.values, ['new', '1']);
});

test('detects concurrent changes before UPDATE and rolls back', async () => {
  const queries: string[] = [];
  let rolledBack = false;
  const manager = {
    async withConnection<T>(_id: string, operation: (connection: unknown) => Promise<T>): Promise<T> {
      return operation({
        async beginTransaction() {},
        async query(options: { sql: string }) {
          queries.push(options.sql);
          return [[[1, 'changed elsewhere']]];
        },
        async commit() {},
        async rollback() { rolledBack = true; }
      });
    }
  } as unknown as ConnectionManager;
  await assert.rejects(
    new RowMutationService(manager, metadataRepository, 5_000).update('local', snapshot, { name: 'mine' }),
    (error: unknown) => error instanceof RowEditError && error.conflict
  );
  assert.equal(rolledBack, true);
  assert.equal(queries.some((sql) => sql.startsWith('UPDATE')), false);
});

test('locks, compares and deletes exactly one row with locator parameters', async () => {
  const queries: Array<{ sql: string; values: unknown[] }> = [];
  let committed = false;
  let rolledBack = false;
  let call = 0;
  const manager = {
    async withConnection<T>(_id: string, operation: (connection: unknown) => Promise<T>): Promise<T> {
      return operation({
        async beginTransaction() {},
        async query(options: { sql: string; values: unknown[] }) {
          queries.push(options);
          call += 1;
          if (call === 1) return [[[1, 'old']]];
          return [{ affectedRows: 1 }];
        },
        async commit() { committed = true; },
        async rollback() { rolledBack = true; }
      });
    }
  } as unknown as ConnectionManager;
  await new RowMutationService(manager, metadataRepository, 5_000).delete('local', snapshot);
  assert.equal(committed, true);
  assert.equal(rolledBack, false);
  assert.match(queries[0]?.sql ?? '', /FOR UPDATE$/);
  assert.match(queries[1]?.sql ?? '', /^DELETE FROM `sales-db`\.`order``items` WHERE `id` = \?$/);
  assert.deepEqual(queries[1]?.values, ['1']);
});

test('rejects DELETE when the locked snapshot changed', async () => {
  const queries: string[] = [];
  let rolledBack = false;
  const manager = {
    async withConnection<T>(_id: string, operation: (connection: unknown) => Promise<T>): Promise<T> {
      return operation({
        async beginTransaction() {},
        async query(options: { sql: string }) {
          queries.push(options.sql);
          return [[[1, 'changed elsewhere']]];
        },
        async commit() {},
        async rollback() { rolledBack = true; }
      });
    }
  } as unknown as ConnectionManager;
  await assert.rejects(
    new RowMutationService(manager, metadataRepository, 5_000).delete('local', snapshot),
    (error: unknown) => error instanceof RowEditError && error.conflict
  );
  assert.equal(rolledBack, true);
  assert.equal(queries.some((sql) => sql.startsWith('DELETE')), false);
});

for (const errorCase of [
  {
    code: 'ER_ROW_IS_REFERENCED_2',
    expected: /child_items.*fk_parent/,
    message: 'Cannot delete a parent row: a foreign key constraint fails (`sales-db`.`child_items`, CONSTRAINT `fk_parent` FOREIGN KEY (`parent_id`) REFERENCES `parent` (`id`))'
  },
  { code: 'ER_TABLEACCESS_DENIED_ERROR', expected: /DELETE 权限/ }
]) {
  test(`maps ${errorCase.code} DELETE errors and rolls back`, async () => {
    let call = 0;
    let rolledBack = false;
    const manager = {
      async withConnection<T>(_id: string, operation: (connection: unknown) => Promise<T>): Promise<T> {
        return operation({
          async beginTransaction() {},
          async query() {
            call += 1;
            if (call === 1) return [[[1, 'old']]];
            throw Object.assign(new Error(errorCase.message ?? 'server detail'), { code: errorCase.code });
          },
          async commit() {},
          async rollback() { rolledBack = true; }
        });
      }
    } as unknown as ConnectionManager;
    await assert.rejects(
      new RowMutationService(manager, metadataRepository, 5_000).delete('local', snapshot),
      (error: unknown) => error instanceof RowEditError && errorCase.expected.test(error.message)
    );
    assert.equal(rolledBack, true);
  });
}

test('reports an unknown result when DELETE commit loses the connection', async () => {
  let call = 0;
  let rolledBack = false;
  const manager = {
    async withConnection<T>(_id: string, operation: (connection: unknown) => Promise<T>): Promise<T> {
      return operation({
        async beginTransaction() {},
        async query() {
          call += 1;
          return call === 1 ? [[[1, 'old']]] : [{ affectedRows: 1 }];
        },
        async commit() { throw new Error('connection lost'); },
        async rollback() { rolledBack = true; }
      });
    }
  } as unknown as ConnectionManager;
  await assert.rejects(
    new RowMutationService(manager, metadataRepository, 5_000).delete('local', snapshot),
    (error: unknown) => error instanceof RowEditError && /结果未知/.test(error.message)
  );
  assert.equal(rolledBack, false);
});
