import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type * as vscode from 'vscode';
import type { ConnectionManager } from '../../src/connection/ConnectionManager.js';
import {
  buildMaintenanceSql,
  confirmationPhrase,
  TableMaintenanceError,
  TableMaintenanceService
} from '../../src/maintenance/TableMaintenanceService.js';
import { buildSqlHeader } from '../../src/transfer/SqlExportService.js';
import type { SqlPackageMetadata } from '../../src/transfer/types.js';

const output = { appendLine() {} } as unknown as vscode.OutputChannel;

test('builds only one qualified TRUNCATE or DROP statement', () => {
  assert.equal(buildMaintenanceSql('truncate', 'sales-db', 'order`items'), 'TRUNCATE TABLE `sales-db`.`order``items`');
  assert.equal(buildMaintenanceSql('drop', 'sales-db', 'order`items'), 'DROP TABLE `sales-db`.`order``items`');
  assert.doesNotMatch(buildMaintenanceSql('truncate', 'db', 'items'), /DELETE|CASCADE|FOREIGN_KEY_CHECKS/i);
});

test('analyzes impact and refuses external foreign keys, views and missing DROP privilege', async () => {
  const inbound = createManager({
    inbound: [['sales', 'child', 'fk_parent']]
  });
  await assert.rejects(
    new TableMaintenanceService(inbound, output).analyze('id', 'sales', 'parent', 'truncate'),
    (error: unknown) => error instanceof TableMaintenanceError
      && error.category === 'dependency'
      && /不会关闭外键检查.*DELETE/.test(error.message)
  );

  const view = createManager({ views: [['sales', 'active_items']] });
  await assert.rejects(
    new TableMaintenanceService(view, output).analyze('id', 'sales', 'items', 'drop'),
    (error: unknown) => error instanceof TableMaintenanceError
      && error.category === 'dependency'
      && /失效视图/.test(error.message)
  );

  const readOnly = createManager({ grants: ['GRANT SELECT ON `sales`.* TO `reader`@`%`'] });
  await assert.rejects(
    new TableMaintenanceService(readOnly, output).analyze('id', 'sales', 'items', 'truncate'),
    (error: unknown) => error instanceof TableMaintenanceError && error.category === 'permission'
  );
});

test('requires a fresh exact Rinda backup, two exact confirmations and consumes the token once', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rinda-maintenance-test-'));
  const backupPath = join(root, 'items.sql');
  const state = { exists: true, createSql: 'CREATE TABLE `items` (`id` int)', ddl: [] as string[] };
  const now = new Date('2026-10-14T00:00:00.000Z');
  const service = new TableMaintenanceService(createManager({ state }), output, () => now, 90_000);
  try {
    const snapshot = await service.analyze('id', 'sales', 'items', 'truncate');
    await writeFile(backupPath, buildPackage({
      exportedAt: '2026-10-14T00:00:01.000Z',
      scope: { kind: 'table', database: 'sales', table: 'items' }
    }));
    const backup = await service.verifyBackup(snapshot, backupPath);
    await assert.rejects(
      async () => service.authorize(snapshot, backup, 'TRUNCATE sales.other'),
      /第一层确认/
    );
    const phrase = confirmationPhrase('truncate', 'sales', 'items');
    const authorization = service.authorize(snapshot, backup, phrase);
    await assert.rejects(service.execute(authorization.token, 'wrong'), /第二层确认/);
    await assert.rejects(service.execute(authorization.token, authorization.finalPhrase), /无效或已经使用/);

    const second = service.authorize(snapshot, backup, phrase);
    const result = await service.execute(second.token, second.finalPhrase);
    assert.equal(result.operation, 'truncate');
    assert.deepEqual(state.ddl, ['TRUNCATE TABLE `sales`.`items`']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects changed definitions and expired tokens before issuing DDL', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rinda-maintenance-conflict-'));
  const backupPath = join(root, 'items.sql');
  const state = { exists: true, createSql: 'CREATE TABLE `items` (`id` int)', ddl: [] as string[] };
  let now = new Date('2026-10-14T00:00:00.000Z');
  const service = new TableMaintenanceService(createManager({ state }), output, () => now, 100);
  try {
    const snapshot = await service.analyze('id', 'sales', 'items', 'drop');
    await writeFile(backupPath, buildPackage({
      exportedAt: '2026-10-14T00:00:01.000Z',
      scope: { kind: 'table', database: 'sales', table: 'items' }
    }));
    const backup = await service.verifyBackup(snapshot, backupPath);
    const phrase = confirmationPhrase('drop', 'sales', 'items');
    const expired = service.authorize(snapshot, backup, phrase);
    now = new Date('2026-10-14T00:00:00.101Z');
    await assert.rejects(
      service.execute(expired.token, expired.finalPhrase),
      (error: unknown) => error instanceof TableMaintenanceError && error.category === 'expired'
    );

    now = new Date('2026-10-14T00:00:00.000Z');
    const changed = service.authorize(snapshot, backup, phrase);
    state.createSql = 'CREATE TABLE `items` (`id` int, `note` text)';
    await assert.rejects(
      service.execute(changed.token, changed.finalPhrase),
      (error: unknown) => error instanceof TableMaintenanceError && error.category === 'conflict'
    );
    assert.deepEqual(state.ddl, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('reports connection loss after DDL starts as unknown and never retries', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rinda-maintenance-unknown-'));
  const backupPath = join(root, 'items.sql');
  const state = {
    exists: true,
    createSql: 'CREATE TABLE `items` (`id` int)',
    ddl: [] as string[],
    ddlError: Object.assign(new Error('socket closed'), { code: 'PROTOCOL_CONNECTION_LOST' })
  };
  const now = new Date('2026-10-14T00:00:00.000Z');
  const service = new TableMaintenanceService(createManager({ state }), output, () => now);
  try {
    const snapshot = await service.analyze('id', 'sales', 'items', 'drop');
    await writeFile(backupPath, buildPackage({
      exportedAt: '2026-10-14T00:00:01.000Z',
      scope: { kind: 'table', database: 'sales', table: 'items' }
    }));
    const backup = await service.verifyBackup(snapshot, backupPath);
    const phrase = confirmationPhrase('drop', 'sales', 'items');
    const authorization = service.authorize(snapshot, backup, phrase);
    await assert.rejects(
      service.execute(authorization.token, authorization.finalPhrase),
      (error: unknown) => error instanceof TableMaintenanceError
        && error.resultUnknown
        && /不要自动重试/.test(error.message)
    );
    assert.equal(state.ddl.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

interface FakeOptions {
  inbound?: unknown[][];
  outbound?: unknown[][];
  views?: unknown[][];
  triggers?: unknown[][];
  grants?: string[];
  state?: {
    exists: boolean;
    createSql: string;
    ddl: string[];
    ddlError?: Error;
  };
}

function createManager(options: FakeOptions = {}): Pick<ConnectionManager, 'withConnection'> {
  const state = options.state ?? { exists: true, createSql: 'CREATE TABLE `items` (`id` int)', ddl: [] };
  return {
    async withConnection<T>(_id: string, operation: (connection: never) => Promise<T>): Promise<T> {
      const connection = {
        async execute(query: { sql: string }) {
          if (query.sql.includes('FROM information_schema.tables') && query.sql.includes('engine')) {
            return [state.exists ? [['InnoDB', 2, 16_384, 0, 'BASE TABLE']] : []];
          }
          if (query.sql.includes('referenced_table_schema = ?')) return [options.inbound ?? []];
          if (query.sql.includes('table_schema = ? AND table_name = ? AND referenced_table_name')) return [options.outbound ?? []];
          if (query.sql.includes('view_table_usage')) return [options.views ?? []];
          if (query.sql.includes('information_schema.triggers')) return [options.triggers ?? []];
          if (query.sql.includes('SELECT COUNT(*) FROM information_schema.tables')) return [[[state.exists ? 1 : 0]]];
          throw new Error(`Unexpected execute: ${query.sql}`);
        },
        async query(query: string | { sql: string }) {
          const sql = typeof query === 'string' ? query : query.sql;
          if (sql.startsWith('SHOW CREATE TABLE')) return [[[state.exists ? 'items' : '', state.createSql]]];
          if (sql === 'SHOW GRANTS') {
            return [[...(options.grants ?? ['GRANT ALL PRIVILEGES ON *.* TO `root`@`%`']).map((grant) => [grant])]];
          }
          if (sql.startsWith('TRUNCATE TABLE') || sql.startsWith('DROP TABLE')) {
            state.ddl.push(sql);
            if (state.ddlError) throw state.ddlError;
            if (sql.startsWith('DROP TABLE')) state.exists = false;
            return [{ affectedRows: 0 }];
          }
          if (sql.startsWith('SELECT EXISTS')) return [[[0]]];
          throw new Error(`Unexpected query: ${sql}`);
        }
      };
      return operation(connection as never);
    }
  };
}

function buildPackage(overrides: Pick<SqlPackageMetadata, 'exportedAt' | 'scope'>): string {
  const metadata: SqlPackageMetadata = {
    formatVersion: 2,
    contentPolicy: 'rinda-controlled-restore-v1',
    exportedAt: overrides.exportedAt,
    sourceServerVersion: '8.4.11',
    scope: overrides.scope,
    characterSet: 'utf8mb4',
    objects: { tables: 1, views: 0, routines: 0, events: 0, triggers: 0 },
    restorePolicy: { standalone: true, reasons: [] },
    tool: { vendor: 'mysql', version: '8.4.11' }
  };
  const body = `${buildSqlHeader(metadata)}CREATE TABLE \`items\` (\`id\` int);\n`;
  const sha256 = createHash('sha256').update(body).digest('hex');
  return `${body}-- rinda-sha256: ${sha256}\n-- rinda-export-end\n`;
}
