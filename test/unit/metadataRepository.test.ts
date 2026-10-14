import assert from 'node:assert/strict';
import test from 'node:test';
import type { ConnectionManager } from '../../src/connection/ConnectionManager.js';
import { MetadataRepository } from '../../src/explorer/metadataRepository.js';

test('reads table overview from parameterized information_schema metadata', async () => {
  let captured: { sql: string; values: unknown[] } | undefined;
  const manager = {
    async withConnection<T>(_id: string, operation: (connection: unknown) => Promise<T>): Promise<T> {
      return operation({
        async execute(options: { sql: string; values: unknown[] }) {
          captured = { sql: options.sql, values: options.values };
          return [[[
            'BASE TABLE',
            'InnoDB',
            1234,
            2_097_152,
            1_048_576,
            100,
            'utf8mb4_unicode_ci',
            new Date('2026-10-13T01:00:00.000Z'),
            null
          ]]];
        }
      });
    }
  } as unknown as ConnectionManager;

  const repository = new MetadataRepository(manager);
  const overview = await repository.getTableOverview('local', 'sales-db', 'order`items');
  assert.deepEqual(captured?.values, ['sales-db', 'order`items']);
  assert.match(captured?.sql ?? '', /WHERE table_schema = \? AND table_name = \?/);
  assert.deepEqual(overview, {
    objectType: 'table',
    engine: 'InnoDB',
    estimatedRows: '1234',
    dataBytes: '2097152',
    indexBytes: '1048576',
    autoIncrement: '100',
    collation: 'utf8mb4_unicode_ci',
    createdAt: '2026-10-13T01:00:00.000Z',
    updatedAt: undefined
  });
});
