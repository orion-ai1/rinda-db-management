import test from 'node:test';
import assert from 'node:assert/strict';
import { formatDataSize, MetadataRepository } from '../../src/explorer/metadataRepository.js';
import type { ConnectionManager } from '../../src/connection/ConnectionManager.js';

test('formatDataSize formats bytes cleanly', () => {
  assert.equal(formatDataSize(null), undefined);
  assert.equal(formatDataSize(0), undefined);
  assert.equal(formatDataSize(500), '500B');
  assert.equal(formatDataSize(15360), '15.0K');
  assert.equal(formatDataSize(2453621), '2.34M');
  assert.equal(formatDataSize(2147483648), '2.00G');
});

test('MetadataRepository queries users, functions, procedures and databases with sizes', async () => {
  const manager = {
    async withConnection<T>(_id: string, operation: (connection: unknown) => Promise<T>): Promise<T> {
      return operation({
        async query(options: { sql: string }) {
          if (options.sql.includes('mysql.user')) {
            return [[['root@localhost'], ['app@%']]];
          }
          if (options.sql.includes('information_schema.schemata')) {
            return [[['migration', 2453621], ['test_db', 15360]]];
          }
          return [[]];
        },
        async execute(options: { sql: string; values?: unknown[] }) {
          if (options.sql.includes("table_type = 'BASE TABLE'")) {
            return [[['users'], ['orders']]];
          }
          if (options.sql.includes("table_type = 'VIEW'")) {
            return [[['user_summary']]];
          }
          if (options.sql.includes("routine_type = 'FUNCTION'")) {
            return [[['calculate_tax']]];
          }
          if (options.sql.includes("routine_type = 'PROCEDURE'")) {
            return [[['sync_orders']]];
          }
          return [[]];
        }
      });
    }
  } as unknown as ConnectionManager;

  const repo = new MetadataRepository(manager);

  const dbs = await repo.listDatabasesWithSizes('conn1');
  assert.deepEqual(dbs, [
    { name: 'migration', size: '2.34M' },
    { name: 'test_db', size: '15.0K' }
  ]);

  const users = await repo.listUsers('conn1');
  assert.deepEqual(users, ['root@localhost', 'app@%']);

  const tables = await repo.listTables('conn1', 'migration');
  assert.deepEqual(tables, ['users', 'orders']);

  const views = await repo.listViews('conn1', 'migration');
  assert.deepEqual(views, ['user_summary']);

  const functions = await repo.listFunctions('conn1', 'migration');
  assert.deepEqual(functions, ['calculate_tax']);

  const procedures = await repo.listProcedures('conn1', 'migration');
  assert.deepEqual(procedures, ['sync_orders']);
});
