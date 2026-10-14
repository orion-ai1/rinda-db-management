import assert from 'node:assert/strict';
import test from 'node:test';
import type { ConnectionManager } from '../../src/connection/ConnectionManager.js';
import { TableMetadataRepository } from '../../src/editing/TableMetadataRepository.js';

test('reads editable column and unique-index metadata using parameters', async () => {
  const captured: Array<{ sql: string; values: unknown[] }> = [];
  const manager = {
    async withConnection<T>(_id: string, operation: (connection: unknown) => Promise<T>): Promise<T> {
      let call = 0;
      return operation({
        async execute(options: { sql: string; values: unknown[] }) {
          captured.push(options);
          call += 1;
          if (call === 1) return [[
            ['id', 1, 'int', 'int unsigned', 'NO', null, 10, 0, 'auto_increment', '', null],
            ['name', 2, 'varchar', 'varchar(64)', 'YES', 64, null, null, '', '', 'utf8mb4']
          ]];
          return [[
            ['PRIMARY', 1, 'id', '', null],
            ['name_unique', 1, 'name', 'YES', null]
          ]];
        }
      });
    }
  } as unknown as ConnectionManager;
  const metadata = await new TableMetadataRepository(manager).get('local', 'sales-db', 'order`items');
  assert.equal(captured.length, 2);
  assert.deepEqual(captured.map((item) => item.values), [
    ['sales-db', 'order`items'], ['sales-db', 'order`items']
  ]);
  assert.match(captured[0]?.sql ?? '', /table_schema = \? AND table_name = \?/);
  assert.equal(metadata.columns[1]?.nullable, true);
  assert.deepEqual(metadata.uniqueIndexes.map((index) => index.name), ['PRIMARY', 'name_unique']);
});
