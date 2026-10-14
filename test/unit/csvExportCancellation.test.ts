import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { access, mkdtemp, readdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import type { ConnectionManager } from '../../src/connection/ConnectionManager.js';
import { CsvExportService } from '../../src/transfer/CsvExportService.js';

test('cancels a streaming CSV export and removes the partial file', async () => {
  let destroyed = false;
  const manager = {
    async withConnection<T>(_id: string, operation: (connection: unknown) => Promise<T>): Promise<T> {
      return operation({
        async execute() { return [[['BASE TABLE']]]; }
      });
    },
    async withStreamingConnection<T>(_id: string, operation: (connection: unknown) => Promise<T>): Promise<T> {
      const connection = {
        query() {
          const query = new EventEmitter() as EventEmitter & { stream: () => Readable };
          query.stream = () => {
            queueMicrotask(() => query.emit('fields', [{ name: 'value', columnType: 253 }]));
            return Readable.from(Array.from({ length: 2_000 }, (_, index) => [`row-${index}`]));
          };
          return query;
        },
        destroy() { destroyed = true; }
      };
      return operation(connection);
    }
  } as unknown as ConnectionManager;
  const output = { appendLine() {} } as never;
  const service = new CsvExportService(manager, output);
  const root = await mkdtemp(join(await realpath(tmpdir()), 'rinda-csv-cancel-'));
  const target = join(root, 'cancelled.csv');
  const controller = new AbortController();
  try {
    await assert.rejects(service.export({
      connectionId: 'local',
      database: 'db',
      table: 'items',
      targetPath: target,
      allowOverwrite: false,
      signal: controller.signal,
      onProgress: ({ rows }) => {
        if (rows === 1_000) controller.abort();
      }
    }), (error: unknown) => (error as Error).name === 'AbortError');
    await assert.rejects(access(target));
    assert.deepEqual(await readdir(root), []);
    assert.equal(destroyed, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
