import assert from 'node:assert/strict';
import test from 'node:test';
import type { ConnectionManager } from '../../src/connection/ConnectionManager.js';
import { QueryService } from '../../src/query/QueryService.js';

test('limits and normalizes SELECT results', async () => {
  let capturedSql = '';
  const manager = {
    async withConnection<T>(_id: string, operation: (connection: unknown) => Promise<T>): Promise<T> {
      const connection = {
        destroy() {},
        async query(options: { sql: string }) {
          capturedSql = options.sql;
          const longText = '长字段'.repeat(800);
          const longBuffer = Buffer.alloc(160, 0xab);
          return [
            [[1, longText, longBuffer], [2, '第二行', Buffer.from('x')], [3, 'hidden', Buffer.from('y')]],
            [{ name: 'id' }, { name: 'note' }, { name: 'payload' }]
          ];
        }
      };
      return operation(connection);
    }
  } as unknown as ConnectionManager;

  const service = new QueryService(manager, 30_000, 2);
  const result = await service.execute({ connectionId: 'local', sql: 'SELECT * FROM items;' });
  assert.equal(capturedSql, 'SELECT * FROM items LIMIT 3');
  assert.deepEqual(result.columns, ['id', 'note', 'payload']);
  assert.equal(result.rows[0]?.[1], '长字段'.repeat(800));
  assert.equal(result.rows[0]?.[2], `0x${'ab'.repeat(160)}`);
  assert.equal(result.rows.length, 2);
  assert.equal(result.truncated, true);
});

test('builds parameterized table preview pagination', async () => {
  let captured: { sql: string; values: unknown[] } | undefined;
  const manager = {
    async withConnection<T>(_id: string, operation: (connection: unknown) => Promise<T>): Promise<T> {
      return operation({
        destroy() {},
        async query(options: { sql: string; values: unknown[] }) {
          captured = { sql: options.sql, values: options.values };
          return [[['ok']], [{ name: 'status' }]];
        }
      });
    }
  } as unknown as ConnectionManager;

  const service = new QueryService(manager, 30_000, 500);
  const result = await service.previewTable('local', 'sales-db', 'order`items', 2, 100);
  assert.deepEqual(captured, {
    sql: 'SELECT * FROM `sales-db`.`order``items` LIMIT ? OFFSET ?',
    values: [101, 200]
  });
  assert.equal(result.rows[0]?.[0], 'ok');
});

test('executeTableQuery switches database and handles pagination for custom queries', async () => {
  const executed: string[] = [];
  const manager = {
    async withConnection<T>(_id: string, operation: (connection: unknown) => Promise<T>): Promise<T> {
      return operation({
        destroy() {},
        async query(arg: string | { sql: string }) {
          const sql = typeof arg === 'string' ? arg : arg.sql;
          executed.push(sql);
          return [[['1', 'Alice'], ['2', 'Bob']], [{ name: 'id' }, { name: 'name' }]];
        }
      });
    }
  } as unknown as ConnectionManager;

  const service = new QueryService(manager, 30_000, 100);
  // Custom query without limit
  await service.executeTableQuery('local', 'test_db', 'SELECT * FROM users WHERE status = 1', 1, 50);
  assert.equal(executed[0], 'USE `test_db`');
  assert.equal(executed[1], 'SELECT * FROM users WHERE status = 1 LIMIT 51 OFFSET 50');

  // Custom query with existing limit
  executed.length = 0;
  await service.executeTableQuery('local', 'test_db', 'SELECT * FROM users WHERE status = 1 LIMIT 10', 0, 50);
  assert.equal(executed[0], 'USE `test_db`');
  assert.equal(executed[1], 'SELECT * FROM users WHERE status = 1 LIMIT 10');
});

