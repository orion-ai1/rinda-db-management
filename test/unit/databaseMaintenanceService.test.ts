import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type * as vscode from 'vscode';
import type { ConnectionManager } from '../../src/connection/ConnectionManager.js';
import type { ConnectionStore } from '../../src/connection/ConnectionStore.js';
import {
  buildDropDatabaseSql,
  DatabaseMaintenanceError,
  DatabaseMaintenanceService
} from '../../src/maintenance/DatabaseMaintenanceService.js';
import { buildDatabaseImpactReport } from '../../src/maintenance/databaseImpactReport.js';
import { buildSqlHeader } from '../../src/transfer/SqlExportService.js';
import type { SqlPackageMetadata } from '../../src/transfer/types.js';

const output = { appendLine() {} } as unknown as vscode.OutputChannel;

test('builds exactly one qualified DROP DATABASE statement', () => {
  assert.equal(buildDropDatabaseSql('sales-db'), 'DROP DATABASE `sales-db`');
  assert.doesNotMatch(buildDropDatabaseSql('sales'), /CASCADE|FOREIGN_KEY_CHECKS|DROP TABLE/i);
});

test('permanently blocks system, configured and connection-default databases', async () => {
  const defaultStore = createStore('default_db');
  const service = new DatabaseMaintenanceService(defaultStore, createManager(), output, ['production']);
  for (const [database, category] of [
    ['mysql', 'protected'],
    ['PrOdUcTiOn', 'protected'],
    ['default_db', 'protected']
  ] as const) {
    await assert.rejects(
      service.analyze('id', database),
      (error: unknown) => error instanceof DatabaseMaintenanceError && error.category === category
    );
  }
});

test('blocks when the full inventory cannot be proved complete', async () => {
  const incomplete = new DatabaseMaintenanceService(
    createStore(), createManager({ shownTables: [] }), output
  );
  await assert.rejects(
    incomplete.analyze('id', 'sales'),
    (error: unknown) => error instanceof DatabaseMaintenanceError
      && error.category === 'impact-incomplete'
      && /交叉核对不一致/.test(error.message)
  );

  const restricted = new DatabaseMaintenanceService(
    createStore(),
    createManager({ grants: ['GRANT DROP, SELECT ON `sales`.* TO `operator`@`%`'] }),
    output
  );
  await assert.rejects(
    restricted.analyze('id', 'sales'),
    (error: unknown) => error instanceof DatabaseMaintenanceError
      && error.category === 'impact-incomplete'
      && /SHOW VIEW/.test(error.message)
  );

  const databaseOnlyAdmin = new DatabaseMaintenanceService(
    createStore(),
    createManager({ grants: ['GRANT ALL PRIVILEGES ON `sales`.* TO `operator`@`%`'] }),
    output
  );
  await assert.rejects(
    databaseOnlyAdmin.analyze('id', 'sales'),
    (error: unknown) => error instanceof DatabaseMaintenanceError
      && error.category === 'impact-incomplete'
      && /GLOBAL SELECT.*GLOBAL SHOW VIEW/.test(error.message)
  );
});

test('produces a full impact report and blocks external inbound dependencies', async () => {
  const service = new DatabaseMaintenanceService(createStore(), createManager(), output);
  const snapshot = await service.analyze('id', 'sales');
  assert.equal(snapshot.summary.tables, 1);
  assert.equal(snapshot.estimatedRows, 2);
  assert.equal(snapshot.dataBytes, 16_384);
  assert.match(buildDatabaseImpactReport(snapshot), /全部对象[\s\S]*TABLE[\s\S]*items/);

  const dependent = new DatabaseMaintenanceService(createStore(), createManager({
    inboundForeignKeys: [['other_db', 'orders', 'fk_sales']]
  }), output);
  await assert.rejects(
    dependent.analyze('id', 'sales'),
    (error: unknown) => error instanceof DatabaseMaintenanceError
      && error.category === 'dependency'
      && /不会使用 CASCADE/.test(error.message)
  );
});

test('binds an exact full backup and two confirmations to a one-use token', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rinda-database-maintenance-'));
  const backupPath = join(root, 'sales.sql');
  const state = createState();
  const now = new Date('2026-10-14T00:00:00.000Z');
  const service = new DatabaseMaintenanceService(
    createStore(), createManager({ state }), output, [], () => now
  );
  try {
    const snapshot = await service.analyze('id', 'sales');
    await writeFile(backupPath, buildPackage('sales'));
    const backup = await service.verifyBackup(snapshot, backupPath);
    assert.equal(backup.sha256.length, 64);
    assert.throws(() => service.authorize(snapshot, backup, 'other'), /第一层确认/);
    const authorization = service.authorize(snapshot, backup, 'sales');
    await assert.rejects(service.execute(authorization.token, 'wrong'), /第二层确认/);
    await assert.rejects(service.execute(authorization.token, authorization.finalPhrase), /无效或已经使用/);

    const second = service.authorize(snapshot, backup, 'sales');
    const result = await service.execute(second.token, second.finalPhrase);
    assert.equal(result.database, 'sales');
    assert.deepEqual(state.ddl, ['DROP DATABASE `sales`']);
    assert.equal(state.exists, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('revalidates the database snapshot and reports post-DDL connection loss as unknown', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rinda-database-maintenance-conflict-'));
  const backupPath = join(root, 'sales.sql');
  const now = new Date('2026-10-14T00:00:00.000Z');
  try {
    const changedState = createState();
    const changedService = new DatabaseMaintenanceService(
      createStore(), createManager({ state: changedState }), output, [], () => now
    );
    const snapshot = await changedService.analyze('id', 'sales');
    await writeFile(backupPath, buildPackage('sales'));
    const backup = await changedService.verifyBackup(snapshot, backupPath);
    const authorization = changedService.authorize(snapshot, backup, 'sales');
    changedState.createOptions = 'stats_persistent=1';
    await assert.rejects(
      changedService.execute(authorization.token, authorization.finalPhrase),
      (error: unknown) => error instanceof DatabaseMaintenanceError && error.category === 'conflict'
    );
    assert.deepEqual(changedState.ddl, []);

    changedState.createOptions = '';
    changedState.ddlError = Object.assign(new Error('socket closed'), { code: 'PROTOCOL_CONNECTION_LOST' });
    const freshSnapshot = await changedService.analyze('id', 'sales');
    const freshBackup = await changedService.verifyBackup(freshSnapshot, backupPath);
    const unknown = changedService.authorize(freshSnapshot, freshBackup, 'sales');
    await assert.rejects(
      changedService.execute(unknown.token, unknown.finalPhrase),
      (error: unknown) => error instanceof DatabaseMaintenanceError
        && error.resultUnknown
        && /不要自动重试/.test(error.message)
    );
    assert.equal(changedState.ddl.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

interface FakeState {
  exists: boolean;
  createOptions: string;
  ddl: string[];
  ddlError?: Error;
}

interface FakeOptions {
  state?: FakeState;
  shownTables?: unknown[][];
  grants?: string[];
  inboundForeignKeys?: unknown[][];
}

function createState(): FakeState {
  return { exists: true, createOptions: '', ddl: [] };
}

function createStore(defaultDatabase?: string): Pick<ConnectionStore, 'getRequired'> {
  return {
    getRequired() {
      return {
        id: 'id', name: 'Integration', host: 'localhost', port: 3306, user: 'root',
        database: defaultDatabase, ssl: false, createdAt: '', updatedAt: ''
      };
    }
  };
}

function createManager(options: FakeOptions = {}): Pick<ConnectionManager, 'withConnection'> {
  const state = options.state ?? createState();
  return {
    async withConnection<T>(_id: string, operation: (connection: never) => Promise<T>): Promise<T> {
      const connection = {
        async execute(query: { sql: string }) {
          const sql = query.sql;
          if (sql.includes('default_character_set_name')) {
            return [state.exists ? [['utf8mb4', 'utf8mb4_0900_ai_ci']] : []];
          }
          if (sql.includes('COUNT(*) FROM information_schema.schemata')) return [[[state.exists ? 1 : 0]]];
          if (sql.includes('FROM information_schema.tables')) {
            return [[['items', 'BASE TABLE', 'InnoDB', 2, 16_384, 4_096, 0, 'utf8mb4_0900_ai_ci', state.createOptions]]];
          }
          if (sql.includes('FROM information_schema.routines')) return [[]];
          if (sql.includes('FROM information_schema.events')) return [[]];
          if (sql.includes('FROM information_schema.triggers')) return [[]];
          if (sql.includes('FROM information_schema.columns')) return [[['items', 'id', 1, null, 'NO', 'int', null, '', '']]];
          if (sql.includes('FROM information_schema.statistics')) return [[['items', 'PRIMARY', 0, 1, 'id', 'A', null, '', 'BTREE']]];
          if (sql.includes('FROM information_schema.table_constraints')) return [[['items', 'PRIMARY', 'PRIMARY KEY']]];
          if (sql.includes('FROM information_schema.key_column_usage') && sql.includes('WHERE table_schema = ?')) return [[['items', 'PRIMARY', 'id', 1, null, null, null]]];
          if (sql.includes('FROM information_schema.views')) return [[]];
          if (sql.includes('FROM information_schema.parameters')) return [[]];
          if (sql.includes('referenced_table_schema = ? AND table_schema <> ?')) return [options.inboundForeignKeys ?? []];
          if (sql.includes('view_table_usage')) return [[]];
          if (sql.includes('referenced_table_schema IS NOT NULL')) return [[]];
          throw new Error(`Unexpected execute: ${sql}`);
        },
        async query(query: string | { sql: string }) {
          const sql = typeof query === 'string' ? query : query.sql;
          if (sql.startsWith('SHOW CREATE DATABASE')) return [[['sales', 'CREATE DATABASE `sales` CHARACTER SET utf8mb4']]];
          if (sql.startsWith('SHOW CREATE TABLE')) return [[['items', `CREATE TABLE \`items\` (\`id\` int) ${state.createOptions}`]]];
          if (sql.startsWith('SHOW FULL TABLES')) return [options.shownTables ?? [['items', 'BASE TABLE']]];
          if (sql.startsWith('SHOW PROCEDURE STATUS') || sql.startsWith('SHOW FUNCTION STATUS')
            || sql.startsWith('SHOW EVENTS') || sql.startsWith('SHOW TRIGGERS')) return [[]];
          if (sql === 'SHOW GRANTS') {
            return [[...(options.grants ?? ['GRANT ALL PRIVILEGES ON *.* TO `root`@`%`']).map((grant) => [grant])]];
          }
          if (sql.startsWith('DROP DATABASE')) {
            state.ddl.push(sql);
            if (state.ddlError) throw state.ddlError;
            state.exists = false;
            return [{ affectedRows: 0 }];
          }
          throw new Error(`Unexpected query: ${sql}`);
        }
      };
      return operation(connection as never);
    }
  };
}

function buildPackage(database: string): string {
  const metadata: SqlPackageMetadata = {
    formatVersion: 2,
    contentPolicy: 'rinda-controlled-restore-v1',
    exportedAt: '2026-10-14T00:00:01.000Z',
    sourceServerVersion: '8.4.11',
    scope: { kind: 'database', database },
    characterSet: 'utf8mb4',
    objects: { tables: 1, views: 0, routines: 0, events: 0, triggers: 0 },
    restorePolicy: { standalone: true, reasons: [] },
    tool: { vendor: 'mysql', version: '8.4.11' }
  };
  const body = `${buildSqlHeader(metadata)}CREATE TABLE \`items\` (\`id\` int);\n`;
  const sha256 = createHash('sha256').update(body).digest('hex');
  return `${body}-- rinda-sha256: ${sha256}\n-- rinda-export-end\n`;
}
