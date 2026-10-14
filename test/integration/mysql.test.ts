import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type * as vscode from 'vscode';
import { ConnectionManager } from '../../src/connection/ConnectionManager.js';
import { ConnectionStore } from '../../src/connection/ConnectionStore.js';
import { RowMutationService } from '../../src/editing/RowMutationService.js';
import { TableEditingService } from '../../src/editing/TableEditingService.js';
import { TableMetadataRepository } from '../../src/editing/TableMetadataRepository.js';
import { MetadataRepository } from '../../src/explorer/metadataRepository.js';
import {
  confirmationPhrase,
  TableMaintenanceError,
  TableMaintenanceService
} from '../../src/maintenance/TableMaintenanceService.js';
import {
  DatabaseMaintenanceError,
  DatabaseMaintenanceService
} from '../../src/maintenance/DatabaseMaintenanceService.js';
import { QueryService } from '../../src/query/QueryService.js';
import { CsvExportService } from '../../src/transfer/CsvExportService.js';
import { MysqlClientResolver, MySqlToolResolver } from '../../src/transfer/MySqlToolResolver.js';
import { SqlExportService } from '../../src/transfer/SqlExportService.js';
import { SqlRestoreError, SqlRestoreService } from '../../src/transfer/SqlRestoreService.js';

class MemoryMemento {
  private readonly values = new Map<string, unknown>();
  public keys(): readonly string[] { return [...this.values.keys()]; }
  public get<T>(key: string, fallback?: T): T | undefined { return (this.values.get(key) as T | undefined) ?? fallback; }
  public update(key: string, value: unknown): Thenable<void> { this.values.set(key, value); return Promise.resolve(); }
}

class MemorySecrets {
  private readonly values = new Map<string, string>();
  public get(key: string): Thenable<string | undefined> { return Promise.resolve(this.values.get(key)); }
  public store(key: string, value: string): Thenable<void> { this.values.set(key, value); return Promise.resolve(); }
  public delete(key: string): Thenable<void> { this.values.delete(key); return Promise.resolve(); }
  public onDidChange = (() => ({ dispose() {} })) as vscode.Event<vscode.SecretStorageChangeEvent>;
}

test('runs safe row editing/deletion, read-only fallback, constraints, permissions and conflicts', {
  skip: process.env.RINDA_MYSQL_INTEGRATION !== '1'
}, async () => {
  const store = new ConnectionStore(new MemoryMemento() as vscode.Memento, new MemorySecrets() as vscode.SecretStorage);
  const profile = await store.create({
    name: 'Integration',
    host: process.env.RINDA_MYSQL_HOST ?? '127.0.0.1',
    port: Number(process.env.RINDA_MYSQL_PORT ?? 3306),
    user: process.env.RINDA_MYSQL_USER ?? 'root',
    password: process.env.RINDA_MYSQL_PASSWORD ?? '',
    ssl: false
  });
  const lines: string[] = [];
  const output = { appendLine(line: string) { lines.push(line); } } as vscode.OutputChannel;
  const manager = new ConnectionManager(store, output);
  const metadata = new MetadataRepository(manager);
  const queries = new QueryService(manager, 10_000, 500);
  const editMetadata = new TableMetadataRepository(manager);
  const mutations = new RowMutationService(manager, editMetadata, 10_000);
  const editing = new TableEditingService(queries, editMetadata, mutations);
  const sqlExport = new SqlExportService(
    store,
    manager,
    new MySqlToolResolver(process.env.RINDA_MYSQLDUMP_PATH),
    output
  );
  const csvExport = new CsvExportService(manager, output);
  const sqlRestore = new SqlRestoreService(
    store,
    manager,
    new MysqlClientResolver(process.env.RINDA_MYSQL_PATH),
    output
  );
  const maintenance = new TableMaintenanceService(manager, output);
  const databaseMaintenance = new DatabaseMaintenanceService(store, manager, output);
  let restrictedProfileId: string | undefined;
  let exportDirectory: string | undefined;

  try {
    await manager.connect(profile.id);
    await manager.withConnection(profile.id, async (connection) => {
      await connection.query('CREATE DATABASE IF NOT EXISTS rinda_mysql_smoke CHARACTER SET utf8mb4');
      await connection.query('DROP TABLE IF EXISTS rinda_mysql_smoke.items');
      await connection.query('DROP TABLE IF EXISTS rinda_mysql_smoke.without_key');
      await connection.query('DROP TABLE IF EXISTS rinda_mysql_smoke.unique_items');
      await connection.query('CREATE TABLE rinda_mysql_smoke.items (id INT PRIMARY KEY AUTO_INCREMENT, name VARCHAR(64), note VARCHAR(64) NULL, payload BLOB, details TEXT, name_length INT AS (CHAR_LENGTH(name)) STORED)');
      await connection.execute(
        'INSERT INTO rinda_mysql_smoke.items (name, note, payload, details) VALUES (?, ?, ?, ?), (?, ?, ?, ?)',
        ['东京', null, Buffer.from([0xde, 0xad]), '长字段'.repeat(800), '第二行', 'ready', Buffer.from('ok'), 'short']
      );
      await connection.query('CREATE TABLE rinda_mysql_smoke.without_key (name VARCHAR(64), note TEXT)');
      await connection.query("INSERT INTO rinda_mysql_smoke.without_key VALUES ('read-only', 'no key')");
      await connection.query('CREATE TABLE rinda_mysql_smoke.unique_items (code VARCHAR(64) NULL UNIQUE, note VARCHAR(64))');
      await connection.query("INSERT INTO rinda_mysql_smoke.unique_items VALUES (NULL, 'nullable'), ('safe', 'editable')");
      await connection.query('CREATE TABLE rinda_mysql_smoke.export_items (id BIGINT PRIMARY KEY, text_value VARCHAR(128), amount DECIMAL(30,2), nullable_value VARCHAR(20) NULL, payload BLOB)');
      await connection.execute(
        'INSERT INTO rinda_mysql_smoke.export_items VALUES (?, ?, ?, ?, ?)',
        ['9007199254740993', '=SUM(1,2)', '-12345678901234567890.50', null, Buffer.from([0xde, 0xad])]
      );
      await connection.query('CREATE VIEW rinda_mysql_smoke.export_view AS SELECT id, text_value FROM rinda_mysql_smoke.export_items');
      await connection.query("CREATE TRIGGER rinda_mysql_smoke.export_items_before_insert BEFORE INSERT ON rinda_mysql_smoke.export_items FOR EACH ROW SET NEW.text_value = COALESCE(NEW.text_value, 'triggered')");
      await connection.query('CREATE PROCEDURE rinda_mysql_smoke.export_count() SELECT COUNT(*) FROM rinda_mysql_smoke.export_items');
      await connection.query("CREATE EVENT rinda_mysql_smoke.export_event ON SCHEDULE EVERY 1 DAY STARTS CURRENT_TIMESTAMP + INTERVAL 1 DAY DO INSERT INTO rinda_mysql_smoke.export_items VALUES (999999, 'event', 0, NULL, NULL)");
    });

    exportDirectory = await mkdtemp(join(await realpath(tmpdir()), 'rinda-transfer-integration-'));
    const databaseSqlPath = join(exportDirectory, 'database.sql');
    const databaseExport = await sqlExport.export({
      connectionId: profile.id,
      scope: { kind: 'database', database: 'rinda_mysql_smoke' },
      targetPath: databaseSqlPath,
      allowOverwrite: false
    });
    const databaseSql = await readFile(databaseSqlPath, 'utf8');
    assert.doesNotMatch(databaseSql, /CREATE DATABASE/);
    assert.doesNotMatch(databaseSql, /^USE\s/m);
    assert.match(databaseSql, /CREATE TABLE `export_items`/);
    assert.match(databaseSql, /TRIGGER `export_items_before_insert`/);
    assert.match(databaseSql, /PROCEDURE `export_count`/);
    assert.match(databaseSql, /EVENT `export_event`/);
    assertSqlChecksum(databaseSql, databaseExport.sha256);

    const tableSqlPath = join(exportDirectory, 'table.sql');
    const tableExport = await sqlExport.export({
      connectionId: profile.id,
      scope: { kind: 'table', database: 'rinda_mysql_smoke', table: 'export_items' },
      targetPath: tableSqlPath,
      allowOverwrite: false
    });
    const tableSql = await readFile(tableSqlPath, 'utf8');
    assert.match(tableSql, /CREATE TABLE `export_items`/);
    assert.match(tableSql, /9007199254740993/);
    assertSqlChecksum(tableSql, tableExport.sha256);

    const csvPath = join(exportDirectory, 'table.csv');
    const csvResult = await csvExport.export({
      connectionId: profile.id,
      database: 'rinda_mysql_smoke',
      table: 'export_items',
      targetPath: csvPath,
      allowOverwrite: false
    });
    const csv = await readFile(csvPath, 'utf8');
    assert.equal(csvResult.rows, 1);
    assert.match(csv, /^id,text_value,amount,nullable_value,payload\r?\n/);
    assert.match(csv, /9007199254740993,"'\=SUM\(1,2\)",-12345678901234567890\.50,NULL,base64:3q0=/);

    const databasePackage = await sqlRestore.preparePackage(databaseSqlPath);
    try {
      const preflight = await sqlRestore.preflight(
        databasePackage,
        profile.id,
        'rinda_mysql_restored',
        'create'
      );
      assert.equal(preflight.targetExists, false);
      assert.equal(preflight.requiredPrivileges.includes('CREATE ROUTINE'), true);
      const restored = await sqlRestore.restore({
        connectionId: profile.id,
        targetDatabase: 'rinda_mysql_restored',
        targetMode: 'create',
        package: databasePackage
      });
      assert.equal(restored.targetCreated, true);
      assert.equal(restored.objects.tables, 4);
      assert.equal(restored.objects.views, 1);
      assert.equal(restored.objects.routines, 1);
      assert.equal(restored.objects.events, 1);
      assert.equal(restored.objects.triggers, 1);
      const restoredData = await queries.execute({
        connectionId: profile.id,
        sql: 'SELECT id, text_value, amount FROM rinda_mysql_restored.export_items'
      });
      assert.deepEqual(restoredData.rows[0], [
        '9007199254740993', '=SUM(1,2)', '-12345678901234567890.50'
      ]);
      await manager.withConnection(profile.id, async (connection) => {
        const [definitionRows] = await connection.execute({
          sql: `SELECT event_definition FROM information_schema.events
                WHERE event_schema = ? AND event_name = ?
                UNION ALL
                SELECT view_definition FROM information_schema.views
                WHERE table_schema = ? AND table_name = ?
                UNION ALL
                SELECT routine_definition FROM information_schema.routines
                WHERE routine_schema = ? AND routine_name = ?`,
          values: [
            'rinda_mysql_restored', 'export_event',
            'rinda_mysql_restored', 'export_view',
            'rinda_mysql_restored', 'export_count'
          ],
          rowsAsArray: true
        });
        const definitions = (definitionRows as unknown[][]).map((row) => String(row[0])).join('\n');
        assert.match(definitions, /rinda_mysql_restored/);
        assert.doesNotMatch(definitions, /rinda_mysql_smoke/);
      });
      await assert.rejects(
        sqlRestore.preflight(databasePackage, profile.id, 'rinda_mysql_restored', 'empty'),
        /不是空库/
      );
    } finally {
      await databasePackage.cleanup();
    }

    await manager.withConnection(profile.id, async (connection) => {
      await connection.query('CREATE DATABASE rinda_mysql_table_restored CHARACTER SET utf8mb4');
    });
    const tablePackage = await sqlRestore.preparePackage(tableSqlPath);
    try {
      const restored = await sqlRestore.restore({
        connectionId: profile.id,
        targetDatabase: 'rinda_mysql_table_restored',
        targetMode: 'empty',
        package: tablePackage
      });
      assert.equal(restored.targetCreated, false);
      assert.equal(restored.objects.tables, 1);
      assert.equal(restored.objects.triggers, 1);
      const restoredTableData = await queries.execute({
        connectionId: profile.id,
        sql: 'SELECT id, text_value FROM rinda_mysql_table_restored.export_items'
      });
      assert.deepEqual(restoredTableData.rows[0], ['9007199254740993', '=SUM(1,2)']);
    } finally {
      await tablePackage.cleanup();
    }

    assert.equal((await metadata.listDatabases(profile.id)).includes('rinda_mysql_smoke'), true);
    assert.deepEqual(
      (await metadata.listObjects(profile.id, 'rinda_mysql_smoke')).map((item) => item.name).sort(),
      ['export_items', 'export_view', 'items', 'unique_items', 'without_key']
    );
    const overview = await metadata.getTableOverview(profile.id, 'rinda_mysql_smoke', 'items');
    assert.equal(overview?.objectType, 'table');
    assert.equal(overview?.engine?.toUpperCase(), 'INNODB');
    assert.equal(overview?.estimatedRows === undefined, false);
    const preview = await queries.previewTable(profile.id, 'rinda_mysql_smoke', 'items', 0, 1);
    assert.equal(preview.rows[0]?.[1], '东京');
    assert.equal(preview.rows[0]?.[2], null);
    assert.equal(preview.rows[0]?.[3], '0xdead');
    assert.equal(preview.rows[0]?.[4], '长字段'.repeat(800));
    assert.equal(preview.hasMore, true);
    assert.equal(preview.rows[0]?.[5], '2');

    const editablePage = await editing.loadPage(profile.id, 'rinda_mysql_smoke', 'items', 0, 1);
    assert.equal(editablePage.editing.enabled, true);
    assert.equal(editablePage.editing.locatorLabel, 'PRIMARY KEY (id)');
    assert.equal(editablePage.editing.columns.find((column) => column.name === 'id')?.editable, false);
    assert.equal(editablePage.editing.columns.find((column) => column.name === 'payload')?.editable, false);
    assert.equal(editablePage.editing.columns.find((column) => column.name === 'name_length')?.editable, false);
    assert.equal(editablePage.editing.columns.find((column) => column.name === 'name')?.editable, true);
    const rowToken = editablePage.editing.rows[0]?.token;
    assert.ok(rowToken);
    const update = await editablePage.updateRow({
      token: rowToken,
      operationId: 'integration_edit_001',
      changes: { name: '大阪', note: 'updated', details: 'saved details' }
    });
    assert.equal(update.ok, true);
    const saved = await queries.execute({
      connectionId: profile.id,
      sql: 'SELECT name, note, details, name_length FROM rinda_mysql_smoke.items WHERE id = 1'
    });
    assert.deepEqual(saved.rows[0], ['大阪', 'updated', 'saved details', '2']);

    const conflictPage = await editing.loadPage(profile.id, 'rinda_mysql_smoke', 'items', 0, 1);
    await manager.withConnection(profile.id, async (connection) => {
      await connection.execute('UPDATE rinda_mysql_smoke.items SET note = ? WHERE id = ?', ['other session', 1]);
    });
    const conflictToken = conflictPage.editing.rows[0]?.token;
    assert.ok(conflictToken);
    const conflict = await conflictPage.updateRow({
      token: conflictToken,
      operationId: 'integration_edit_002',
      changes: { note: 'my draft' }
    });
    assert.equal(conflict.ok, false);
    assert.equal(conflict.conflict, true);
    const afterConflict = await queries.execute({
      connectionId: profile.id,
      sql: 'SELECT note FROM rinda_mysql_smoke.items WHERE id = 1'
    });
    assert.deepEqual(afterConflict.rows[0], ['other session']);

    const deletePage = await editing.loadPage(profile.id, 'rinda_mysql_smoke', 'items', 0, 10);
    const idIndex = deletePage.result.columns.indexOf('id');
    const secondRowIndex = deletePage.result.rows.findIndex((row) => row[idIndex] === '2');
    const deleteToken = deletePage.editing.rows[secondRowIndex]?.token;
    assert.ok(deleteToken);
    const deleted = await deletePage.deleteRow({
      token: deleteToken,
      operationId: 'integration_delete_001',
      confirmation: 'DELETE'
    });
    assert.equal(deleted.ok, true);
    const afterDelete = await queries.execute({
      connectionId: profile.id,
      sql: 'SELECT COUNT(*) FROM rinda_mysql_smoke.items WHERE id = 2'
    });
    assert.deepEqual(afterDelete.rows[0], ['0']);

    const deleteConflictPage = await editing.loadPage(profile.id, 'rinda_mysql_smoke', 'items', 0, 10);
    await manager.withConnection(profile.id, async (connection) => {
      await connection.execute('UPDATE rinda_mysql_smoke.items SET details = ? WHERE id = ?', ['changed before delete', 1]);
    });
    const deleteConflictToken = deleteConflictPage.editing.rows[0]?.token;
    assert.ok(deleteConflictToken);
    const deleteConflict = await deleteConflictPage.deleteRow({
      token: deleteConflictToken,
      operationId: 'integration_delete_002',
      confirmation: 'DELETE'
    });
    assert.equal(deleteConflict.ok, false);
    assert.equal(deleteConflict.conflict, true);
    const rowStillExists = await queries.execute({
      connectionId: profile.id,
      sql: 'SELECT COUNT(*) FROM rinda_mysql_smoke.items WHERE id = 1'
    });
    assert.deepEqual(rowStillExists.rows[0], ['1']);

    await manager.withConnection(profile.id, async (connection) => {
      await connection.query('CREATE TABLE rinda_mysql_smoke.maintenance_truncate (id INT PRIMARY KEY, note VARCHAR(64))');
      await connection.query("INSERT INTO rinda_mysql_smoke.maintenance_truncate VALUES (1, 'one'), (2, 'two')");
      await connection.query('CREATE TABLE rinda_mysql_smoke.maintenance_drop (id INT PRIMARY KEY, note VARCHAR(64))');
      await connection.query("INSERT INTO rinda_mysql_smoke.maintenance_drop VALUES (1, 'drop me')");
      await connection.query('CREATE TABLE rinda_mysql_smoke.maintenance_stale (id INT PRIMARY KEY)');
      await connection.query('INSERT INTO rinda_mysql_smoke.maintenance_stale VALUES (1)');
    });

    const truncateSnapshot = await maintenance.analyze(
      profile.id, 'rinda_mysql_smoke', 'maintenance_truncate', 'truncate'
    );
    assert.equal(truncateSnapshot.inboundForeignKeys.length, 0);
    assert.equal(truncateSnapshot.engine?.toUpperCase(), 'INNODB');
    const truncateBackupPath = join(exportDirectory, 'maintenance-truncate.sql');
    const truncateExport = await sqlExport.export({
      connectionId: profile.id,
      scope: { kind: 'table', database: 'rinda_mysql_smoke', table: 'maintenance_truncate' },
      targetPath: truncateBackupPath,
      allowOverwrite: false
    });
    const truncateBackup = await maintenance.verifyBackup(
      truncateSnapshot, truncateBackupPath, truncateExport.sha256
    );
    const truncatePhrase = confirmationPhrase('truncate', 'rinda_mysql_smoke', 'maintenance_truncate');
    const truncateAuthorization = maintenance.authorize(truncateSnapshot, truncateBackup, truncatePhrase);
    await maintenance.execute(truncateAuthorization.token, truncateAuthorization.finalPhrase);
    const truncated = await queries.execute({
      connectionId: profile.id,
      sql: 'SELECT COUNT(*) FROM rinda_mysql_smoke.maintenance_truncate'
    });
    assert.deepEqual(truncated.rows[0], ['0']);

    const dropSnapshot = await maintenance.analyze(
      profile.id, 'rinda_mysql_smoke', 'maintenance_drop', 'drop'
    );
    const dropBackupPath = join(exportDirectory, 'maintenance-drop.sql');
    const dropExport = await sqlExport.export({
      connectionId: profile.id,
      scope: { kind: 'table', database: 'rinda_mysql_smoke', table: 'maintenance_drop' },
      targetPath: dropBackupPath,
      allowOverwrite: false
    });
    const dropBackup = await maintenance.verifyBackup(dropSnapshot, dropBackupPath, dropExport.sha256);
    const dropPhrase = confirmationPhrase('drop', 'rinda_mysql_smoke', 'maintenance_drop');
    const dropAuthorization = maintenance.authorize(dropSnapshot, dropBackup, dropPhrase);
    await maintenance.execute(dropAuthorization.token, dropAuthorization.finalPhrase);
    assert.equal(
      (await metadata.listObjects(profile.id, 'rinda_mysql_smoke')).some((item) => item.name === 'maintenance_drop'),
      false
    );

    const staleSnapshot = await maintenance.analyze(
      profile.id, 'rinda_mysql_smoke', 'maintenance_stale', 'drop'
    );
    const staleBackupPath = join(exportDirectory, 'maintenance-stale.sql');
    const staleExport = await sqlExport.export({
      connectionId: profile.id,
      scope: { kind: 'table', database: 'rinda_mysql_smoke', table: 'maintenance_stale' },
      targetPath: staleBackupPath,
      allowOverwrite: false
    });
    const staleBackup = await maintenance.verifyBackup(staleSnapshot, staleBackupPath, staleExport.sha256);
    const stalePhrase = confirmationPhrase('drop', 'rinda_mysql_smoke', 'maintenance_stale');
    const staleAuthorization = maintenance.authorize(staleSnapshot, staleBackup, stalePhrase);
    await manager.withConnection(profile.id, async (connection) => {
      await connection.query('ALTER TABLE rinda_mysql_smoke.maintenance_stale ADD COLUMN changed_after_confirmation INT NULL');
    });
    await assert.rejects(
      maintenance.execute(staleAuthorization.token, staleAuthorization.finalPhrase),
      (error: unknown) => error instanceof TableMaintenanceError && error.category === 'conflict'
    );
    assert.equal(
      (await metadata.listObjects(profile.id, 'rinda_mysql_smoke')).some((item) => item.name === 'maintenance_stale'),
      true
    );

    await manager.withConnection(profile.id, async (connection) => {
      await connection.query('CREATE DATABASE rinda_mysql_drop_target CHARACTER SET utf8mb4');
      await connection.query('CREATE TABLE rinda_mysql_drop_target.items (id INT PRIMARY KEY, note VARCHAR(64))');
      await connection.query("INSERT INTO rinda_mysql_drop_target.items VALUES (1, 'one'), (2, 'two')");
      await connection.query('CREATE VIEW rinda_mysql_drop_target.item_view AS SELECT id, note FROM rinda_mysql_drop_target.items');
      await connection.query("CREATE TRIGGER rinda_mysql_drop_target.items_before_insert BEFORE INSERT ON rinda_mysql_drop_target.items FOR EACH ROW SET NEW.note = COALESCE(NEW.note, 'triggered')");
      await connection.query('CREATE PROCEDURE rinda_mysql_drop_target.item_count() SELECT COUNT(*) FROM rinda_mysql_drop_target.items');
      await connection.query('CREATE FUNCTION rinda_mysql_drop_target.answer() RETURNS INT DETERMINISTIC RETURN 42');
      await connection.query("CREATE EVENT rinda_mysql_drop_target.daily_event ON SCHEDULE EVERY 1 DAY STARTS CURRENT_TIMESTAMP + INTERVAL 1 DAY DO INSERT INTO rinda_mysql_drop_target.items VALUES (999999, 'event')");
    });
    const databaseSnapshot = await databaseMaintenance.analyze(profile.id, 'rinda_mysql_drop_target');
    assert.deepEqual(databaseSnapshot.summary, {
      tables: 1, views: 1, routines: 2, events: 1, triggers: 1
    });
    assert.equal(databaseSnapshot.procedures, 1);
    assert.equal(databaseSnapshot.functions, 1);
    assert.equal(databaseSnapshot.dataBytes > 0, true);
    const databaseDropBackupPath = join(exportDirectory, 'database-before-drop.sql');
    const databaseDropExport = await sqlExport.export({
      connectionId: profile.id,
      scope: { kind: 'database', database: 'rinda_mysql_drop_target' },
      targetPath: databaseDropBackupPath,
      allowOverwrite: false
    });
    const databaseDropBackup = await databaseMaintenance.verifyBackup(
      databaseSnapshot, databaseDropBackupPath, databaseDropExport.sha256
    );
    const databaseDropAuthorization = databaseMaintenance.authorize(
      databaseSnapshot, databaseDropBackup, 'rinda_mysql_drop_target'
    );
    await databaseMaintenance.execute(
      databaseDropAuthorization.token,
      databaseDropAuthorization.finalPhrase
    );
    assert.equal((await metadata.listDatabases(profile.id)).includes('rinda_mysql_drop_target'), false);

    await manager.withConnection(profile.id, async (connection) => {
      await connection.query('CREATE DATABASE rinda_mysql_drop_stale CHARACTER SET utf8mb4');
      await connection.query('CREATE TABLE rinda_mysql_drop_stale.items (id INT PRIMARY KEY)');
      await connection.query('INSERT INTO rinda_mysql_drop_stale.items VALUES (1)');
    });
    const staleDatabaseSnapshot = await databaseMaintenance.analyze(profile.id, 'rinda_mysql_drop_stale');
    const staleDatabaseBackupPath = join(exportDirectory, 'database-stale.sql');
    const staleDatabaseExport = await sqlExport.export({
      connectionId: profile.id,
      scope: { kind: 'database', database: 'rinda_mysql_drop_stale' },
      targetPath: staleDatabaseBackupPath,
      allowOverwrite: false
    });
    const staleDatabaseBackup = await databaseMaintenance.verifyBackup(
      staleDatabaseSnapshot, staleDatabaseBackupPath, staleDatabaseExport.sha256
    );
    const staleDatabaseAuthorization = databaseMaintenance.authorize(
      staleDatabaseSnapshot, staleDatabaseBackup, 'rinda_mysql_drop_stale'
    );
    await manager.withConnection(profile.id, async (connection) => {
      await connection.query('ALTER TABLE rinda_mysql_drop_stale.items ADD COLUMN changed_after_confirmation INT NULL');
    });
    await assert.rejects(
      databaseMaintenance.execute(staleDatabaseAuthorization.token, staleDatabaseAuthorization.finalPhrase),
      (error: unknown) => error instanceof DatabaseMaintenanceError && error.category === 'conflict'
    );
    assert.equal((await metadata.listDatabases(profile.id)).includes('rinda_mysql_drop_stale'), true);

    await manager.withConnection(profile.id, async (connection) => {
      await connection.query('CREATE DATABASE rinda_mysql_drop_referenced CHARACTER SET utf8mb4');
      await connection.query('CREATE TABLE rinda_mysql_drop_referenced.parent (id INT PRIMARY KEY)');
      await connection.query('CREATE TABLE rinda_mysql_smoke.external_drop_child (id INT PRIMARY KEY, parent_id INT, CONSTRAINT fk_external_drop_parent FOREIGN KEY (parent_id) REFERENCES rinda_mysql_drop_referenced.parent(id))');
    });
    await assert.rejects(
      databaseMaintenance.analyze(profile.id, 'rinda_mysql_drop_referenced'),
      (error: unknown) => error instanceof DatabaseMaintenanceError && error.category === 'dependency'
    );

    await manager.withConnection(profile.id, async (connection) => {
      await connection.query('CREATE TABLE rinda_mysql_smoke.protected_parent (id INT PRIMARY KEY, label VARCHAR(64))');
      await connection.query('CREATE TABLE rinda_mysql_smoke.protected_child (id INT PRIMARY KEY, parent_id INT NOT NULL, CONSTRAINT fk_protected_parent FOREIGN KEY (parent_id) REFERENCES rinda_mysql_smoke.protected_parent(id))');
      await connection.query("INSERT INTO rinda_mysql_smoke.protected_parent VALUES (1, 'protected')");
      await connection.query('INSERT INTO rinda_mysql_smoke.protected_child VALUES (1, 1)');
    });
    await assert.rejects(
      maintenance.analyze(profile.id, 'rinda_mysql_smoke', 'protected_parent', 'truncate'),
      (error: unknown) => error instanceof TableMaintenanceError && error.category === 'dependency'
    );
    const partialPackage = await sqlRestore.preparePackage(tableSqlPath);
    try {
      const controller = new AbortController();
      await assert.rejects(
        sqlRestore.restore({
          connectionId: profile.id,
          targetDatabase: 'rinda_mysql_partial_restore',
          targetMode: 'create',
          package: partialPackage,
          signal: controller.signal,
          onProgress: ({ stage }) => {
            if (stage === 'apply') controller.abort();
          }
        }),
        (error: unknown) => {
          assert.equal(error instanceof SqlRestoreError, true);
          const restoreError = error as SqlRestoreError;
          assert.equal(restoreError.stage, 'apply');
          assert.equal(restoreError.partialSuccess, true);
          assert.match(restoreError.guidance, /不会自动回滚、重试或删除/);
          return true;
        }
      );
      assert.equal((await metadata.listDatabases(profile.id)).includes('rinda_mysql_partial_restore'), true);
      assert.deepEqual(await metadata.listObjects(profile.id, 'rinda_mysql_partial_restore'), []);
    } finally {
      await partialPackage.cleanup();
    }
    const protectedPage = await editing.loadPage(profile.id, 'rinda_mysql_smoke', 'protected_parent', 0, 10);
    const protectedToken = protectedPage.editing.rows[0]?.token;
    assert.ok(protectedToken);
    const protectedDelete = await protectedPage.deleteRow({
      token: protectedToken,
      operationId: 'integration_delete_003',
      confirmation: 'DELETE'
    });
    assert.equal(protectedDelete.ok, false);
    assert.match(protectedDelete.message, /外键.*引用/);

    await manager.withConnection(profile.id, async (connection) => {
      await connection.query("DROP USER IF EXISTS 'rinda_no_delete'@'%'");
      await connection.query("CREATE USER 'rinda_no_delete'@'%' IDENTIFIED BY 'rinda-test-password'");
      await connection.query("GRANT SELECT ON rinda_mysql_smoke.* TO 'rinda_no_delete'@'%'");
      await connection.query("GRANT SELECT ON rinda_mysql_drop_stale.* TO 'rinda_no_delete'@'%'");
    });
    const restrictedProfile = await store.create({
      name: 'Restricted integration',
      host: process.env.RINDA_MYSQL_HOST ?? '127.0.0.1',
      port: Number(process.env.RINDA_MYSQL_PORT ?? 3306),
      user: 'rinda_no_delete',
      password: 'rinda-test-password',
      ssl: false
    });
    restrictedProfileId = restrictedProfile.id;
    const restrictedPackage = await sqlRestore.preparePackage(tableSqlPath);
    try {
      await assert.rejects(
        sqlRestore.preflight(
          restrictedPackage,
          restrictedProfile.id,
          'rinda_mysql_restricted_restore',
          'create'
        ),
        /权限预检未通过/
      );
    } finally {
      await restrictedPackage.cleanup();
    }
    const restrictedPage = await editing.loadPage(restrictedProfile.id, 'rinda_mysql_smoke', 'items', 0, 10);
    const restrictedToken = restrictedPage.editing.rows[0]?.token;
    assert.ok(restrictedToken);
    const deniedDelete = await restrictedPage.deleteRow({
      token: restrictedToken,
      operationId: 'integration_delete_004',
      confirmation: 'DELETE'
    });
    assert.equal(deniedDelete.ok, false);
    assert.match(deniedDelete.message, /DELETE 权限/);
    await assert.rejects(
      maintenance.analyze(restrictedProfile.id, 'rinda_mysql_smoke', 'items', 'drop'),
      (error: unknown) => error instanceof TableMaintenanceError && error.category === 'permission'
    );
    await assert.rejects(
      databaseMaintenance.analyze(restrictedProfile.id, 'rinda_mysql_drop_stale'),
      (error: unknown) => error instanceof DatabaseMaintenanceError && error.category === 'impact-incomplete'
    );

    const readOnlyPage = await editing.loadPage(profile.id, 'rinda_mysql_smoke', 'without_key', 0, 10);
    assert.equal(readOnlyPage.editing.enabled, false);
    assert.match(readOnlyPage.editing.reason ?? '', /可靠定位/);
    const nullableUniquePage = await editing.loadPage(profile.id, 'rinda_mysql_smoke', 'unique_items', 0, 10);
    assert.equal(nullableUniquePage.editing.enabled, true);
    assert.equal(nullableUniquePage.editing.rows[0]?.token, undefined);
    assert.match(nullableUniquePage.editing.rows[0]?.readOnlyReason ?? '', /NULL/);
    assert.ok(nullableUniquePage.editing.rows[1]?.token);
    assert.equal(lines.some((line) => line.includes('Integration')), true);
  } finally {
    if (restrictedProfileId) await manager.disconnect(restrictedProfileId).catch(() => undefined);
    await manager.withConnection(profile.id, async (connection) => {
      await connection.query('DROP TABLE IF EXISTS rinda_mysql_smoke.external_drop_child');
      await connection.query('DROP DATABASE IF EXISTS rinda_mysql_smoke');
      await connection.query('DROP DATABASE IF EXISTS rinda_mysql_restored');
      await connection.query('DROP DATABASE IF EXISTS rinda_mysql_table_restored');
      await connection.query('DROP DATABASE IF EXISTS rinda_mysql_partial_restore');
      await connection.query('DROP DATABASE IF EXISTS rinda_mysql_drop_target');
      await connection.query('DROP DATABASE IF EXISTS rinda_mysql_drop_stale');
      await connection.query('DROP DATABASE IF EXISTS rinda_mysql_drop_referenced');
      await connection.query("DROP USER IF EXISTS 'rinda_no_delete'@'%'");
    }).catch(() => undefined);
    await manager.dispose();
    if (exportDirectory) await rm(exportDirectory, { recursive: true, force: true });
  }
});

function assertSqlChecksum(contents: string, expected?: string): void {
  const footer = /-- rinda-sha256: ([a-f0-9]{64})\n-- rinda-export-end\n$/.exec(contents);
  assert.ok(footer);
  assert.equal(footer[1], expected);
  const body = contents.slice(0, footer.index);
  assert.equal(createHash('sha256').update(body).digest('hex'), footer[1]);
}
