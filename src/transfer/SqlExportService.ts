import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import type * as vscode from 'vscode';
import type { ConnectionManager } from '../connection/ConnectionManager.js';
import type { ConnectionStore } from '../connection/ConnectionStore.js';
import { redactSensitiveText } from '../security/redaction.js';
import { createCredentialFile } from './CredentialFile.js';
import type { MySqlToolResolver } from './MySqlToolResolver.js';
import { SafeFileWriter } from './SafeFileWriter.js';
import type {
  ExportProgress,
  ExportResult,
  MysqldumpTool,
  SqlExportScope,
  SqlObjectSummary,
  SqlPackageMetadata
} from './types.js';
import { ExportCancelledError, throwIfAborted } from './types.js';

export interface SqlExportOptions {
  connectionId: string;
  scope: SqlExportScope;
  targetPath: string;
  allowOverwrite: boolean;
  signal?: AbortSignal;
  onProgress?: (progress: ExportProgress) => void;
}

export class SqlExportService {
  public constructor(
    private readonly store: ConnectionStore,
    private readonly connections: ConnectionManager,
    private readonly toolResolver: MySqlToolResolver,
    private readonly output: vscode.OutputChannel,
    private readonly now: () => Date = () => new Date()
  ) {}

  public async export(options: SqlExportOptions): Promise<ExportResult> {
    const startedAt = performance.now();
    validateScope(options.scope);
    throwIfAborted(options.signal);
    const profile = this.store.getRequired(options.connectionId);
    const password = await this.store.getPassword(options.connectionId) ?? '';
    const [tool, source] = await Promise.all([
      this.toolResolver.resolve(options.signal),
      inspectSource(this.connections, options.connectionId, options.scope)
    ]);
    const warnings = buildCompatibilityWarnings(tool, source.serverVersion, source.nonTransactionalTables);
    const credential = await createCredentialFile(profile, password, tool.vendor);
    let writer: SafeFileWriter | undefined;
    try {
      writer = await SafeFileWriter.create(options.targetPath, options.allowOverwrite);
      const metadata: SqlPackageMetadata = {
        formatVersion: 2,
        contentPolicy: 'rinda-controlled-restore-v1',
        exportedAt: this.now().toISOString(),
        sourceServerVersion: source.serverVersion,
        scope: options.scope,
        characterSet: 'utf8mb4',
        objects: source.objects,
        restorePolicy: source.restorePolicy,
        tool: { vendor: tool.vendor, version: tool.version }
      };
      const header = buildSqlHeader(metadata);
      const hash = createHash('sha256');
      await writer.write(header);
      hash.update(header);
      options.onProgress?.({ message: '正在运行 mysqldump…', bytes: writer.bytesWritten });
      const lastByte = await writeDumpBody({
        tool,
        args: buildMysqldumpArgs(tool, credential.path, options.scope),
        writer,
        hash,
        password,
        signal: options.signal,
        onProgress: options.onProgress
      });
      if (lastByte !== 0x0a) {
        await writer.write('\n');
        hash.update('\n');
      }
      const sha256 = hash.digest('hex');
      await writer.write(`-- rinda-sha256: ${sha256}\n-- rinda-export-end\n`);
      throwIfAborted(options.signal);
      await writer.commit();
      const durationMs = Math.round(performance.now() - startedAt);
      this.output.appendLine(
        `[导出] SQL ${scopeLabel(options.scope)} 完成，${writer.bytesWritten} bytes，${durationMs} ms`
      );
      return {
        targetPath: options.targetPath,
        bytes: writer.bytesWritten,
        durationMs,
        sha256,
        warnings
      };
    } catch (error) {
      await writer?.abort();
      if ((error as Error).name === 'AbortError') {
        this.output.appendLine(`[导出] SQL ${scopeLabel(options.scope)} 已取消`);
        throw new ExportCancelledError();
      }
      this.output.appendLine(`[导出] SQL ${scopeLabel(options.scope)} 失败`);
      throw error;
    } finally {
      await credential.cleanup();
    }
  }
}

export function buildMysqldumpArgs(
  tool: MysqldumpTool,
  credentialPath: string,
  scope: SqlExportScope
): string[] {
  validateScope(scope);
  const args = [
    `--defaults-extra-file=${credentialPath}`,
    '--protocol=TCP',
    '--default-character-set=utf8mb4',
    '--single-transaction',
    '--quick',
    '--skip-lock-tables',
    '--skip-add-locks',
    '--skip-add-drop-table',
    '--no-create-db',
    '--hex-blob',
    '--no-tablespaces',
    '--comments'
  ];
  if (tool.vendor === 'mysql') args.push('--set-gtid-purged=OFF');
  if (tool.vendor === 'mysql' && tool.major >= 8) args.push('--column-statistics=0');
  if (scope.kind === 'database') {
    args.push('--routines', '--events', '--triggers', scope.database);
  } else {
    args.push('--triggers', scope.database, scope.table);
  }
  return args;
}

export function buildSqlHeader(metadata: object): string {
  const encoded = Buffer.from(JSON.stringify(metadata), 'utf8').toString('base64url');
  return [
    '-- Rinda MySQL SQL Export',
    '-- rinda-format-version: 2',
    `-- rinda-metadata-base64url: ${encoded}`,
    '-- SHA-256 covers this header and the mysqldump body through the byte before rinda-sha256.',
    ''
  ].join('\n');
}

function validateScope(scope: SqlExportScope): void {
  if (['information_schema', 'mysql', 'performance_schema', 'sys'].includes(scope.database.toLowerCase())) {
    throw new Error('受控 SQL 包不允许导出系统数据库。');
  }
  for (const [label, value] of [
    ['数据库', scope.database],
    ['表', scope.kind === 'table' ? scope.table : undefined]
  ] as Array<[string, string | undefined]>) {
    if (value === undefined) continue;
    if (!value || value.includes('\0') || /[\r\n]/.test(value) || value.startsWith('-')) {
      throw new Error(`${label}名称不能安全地传给 mysqldump。`);
    }
  }
}

async function inspectSource(
  connections: ConnectionManager,
  connectionId: string,
  scope: SqlExportScope
): Promise<{
  serverVersion: string;
  nonTransactionalTables: string[];
  objects: SqlObjectSummary;
  restorePolicy: { standalone: boolean; reasons: string[] };
}> {
  return connections.withConnection(connectionId, async (connection) => {
    const [versionRows] = await connection.query({ sql: 'SELECT VERSION()', rowsAsArray: true });
    const serverVersion = String((versionRows as unknown[][])[0]?.[0] ?? 'unknown');
    const values = scope.kind === 'table' ? [scope.database, scope.table] : [scope.database];
    const tablePredicate = scope.kind === 'table' ? ' AND table_name = ?' : '';
    const [rows] = await connection.execute({
      sql: `SELECT table_name, engine, table_type
            FROM information_schema.tables
            WHERE table_schema = ?${tablePredicate}`,
      values,
      rowsAsArray: true
    });
    const databaseObjects = rows as unknown[][];
    if (scope.kind === 'table') {
      const object = databaseObjects[0];
      if (!object) throw new Error('要导出的表不存在。');
      if (String(object[2]).toUpperCase() !== 'BASE TABLE') throw new Error('CSV/单表 SQL 导出仅支持基础表，不支持视图。');
    }
    const nonTransactionalTables = databaseObjects
      .filter((row) => String(row[2]).toUpperCase() === 'BASE TABLE' && String(row[1] ?? '').toUpperCase() !== 'INNODB')
      .map((row) => String(row[0]));
    const [routineRows, eventRows, triggerRows] = scope.kind === 'database'
      ? await Promise.all([
        connection.execute({
          sql: 'SELECT COUNT(*) FROM information_schema.routines WHERE routine_schema = ?',
          values: [scope.database],
          rowsAsArray: true
        }),
        connection.execute({
          sql: 'SELECT COUNT(*) FROM information_schema.events WHERE event_schema = ?',
          values: [scope.database],
          rowsAsArray: true
        }),
        connection.execute({
          sql: 'SELECT COUNT(*) FROM information_schema.triggers WHERE trigger_schema = ?',
          values: [scope.database],
          rowsAsArray: true
        })
      ])
      : [undefined, undefined, await connection.execute({
        sql: 'SELECT COUNT(*) FROM information_schema.triggers WHERE trigger_schema = ? AND event_object_table = ?',
        values: [scope.database, scope.table],
        rowsAsArray: true
      })];
    const objects: SqlObjectSummary = {
      tables: scope.kind === 'table'
        ? 1
        : databaseObjects.filter((row) => String(row[2]).toUpperCase() === 'BASE TABLE').length,
      views: scope.kind === 'table'
        ? 0
        : databaseObjects.filter((row) => String(row[2]).toUpperCase() === 'VIEW').length,
      routines: countResult(routineRows),
      events: countResult(eventRows),
      triggers: countResult(triggerRows)
    };
    const dependencyValues = scope.kind === 'table'
      ? [scope.database, scope.table, scope.database, scope.table]
      : [scope.database, scope.database];
    const dependencyPredicate = scope.kind === 'table'
      ? `table_schema = ? AND table_name = ? AND
         NOT (referenced_table_schema = ? AND referenced_table_name = ?)`
      : 'table_schema = ? AND referenced_table_schema <> ?';
    const [dependencyRows] = await connection.execute({
      sql: `SELECT DISTINCT referenced_table_schema, referenced_table_name
            FROM information_schema.key_column_usage
            WHERE ${dependencyPredicate} AND referenced_table_name IS NOT NULL`,
      values: dependencyValues,
      rowsAsArray: true
    });
    const dependencyReasons = (dependencyRows as unknown[][]).map(
      (row) => `外键依赖 ${String(row[0])}.${String(row[1])}`
    );
    return {
      serverVersion,
      nonTransactionalTables,
      objects,
      restorePolicy: {
        standalone: dependencyReasons.length === 0,
        reasons: dependencyReasons
      }
    };
  });
}

function countResult(result: [unknown, unknown] | undefined): number {
  const rows = result?.[0] as unknown[][] | undefined;
  return Number(rows?.[0]?.[0] ?? 0);
}

function buildCompatibilityWarnings(
  tool: MysqldumpTool,
  serverVersion: string,
  nonTransactionalTables: string[]
): string[] {
  const warnings: string[] = [];
  const serverVendor = /mariadb/i.test(serverVersion) ? 'mariadb' : 'mysql';
  const serverMajor = Number(/\d+/.exec(serverVersion)?.[0] ?? 0);
  if (serverVendor !== tool.vendor) {
    warnings.push(`导出工具为 ${tool.vendor} ${tool.version}，服务器为 ${serverVersion}；请在恢复前验证兼容性。`);
  } else if (serverMajor > 0 && serverMajor !== tool.major) {
    warnings.push(`mysqldump ${tool.version} 与服务器 ${serverVersion} 主版本不同；请在恢复前验证兼容性。`);
  }
  if (nonTransactionalTables.length > 0) {
    const sample = nonTransactionalTables.slice(0, 5).join('、');
    warnings.push(`检测到非 InnoDB 表（${sample}${nonTransactionalTables.length > 5 ? ' 等' : ''}），--single-transaction 无法保证跨表一致快照。`);
  }
  return warnings;
}

async function writeDumpBody(options: {
  tool: MysqldumpTool;
  args: readonly string[];
  writer: SafeFileWriter;
  hash: ReturnType<typeof createHash>;
  password: string;
  signal?: AbortSignal;
  onProgress?: (progress: ExportProgress) => void;
}): Promise<number | undefined> {
  throwIfAborted(options.signal);
  const child = spawn(options.tool.path, [...options.args], {
    shell: false,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const stderr: Buffer[] = [];
  let stderrBytes = 0;
  let lastByte: number | undefined;
  let forceKill: NodeJS.Timeout | undefined;
  const abort = (): void => {
    child.kill('SIGTERM');
    forceKill = setTimeout(() => child.kill('SIGKILL'), 2_000);
    forceKill.unref();
  };
  options.signal?.addEventListener('abort', abort, { once: true });
  child.stderr.on('data', (chunk: Buffer) => {
    if (stderrBytes >= 65_536) return;
    const remaining = 65_536 - stderrBytes;
    stderr.push(chunk.subarray(0, remaining));
    stderrBytes += Math.min(chunk.length, remaining);
  });
  const exit = new Promise<{ code: number | null; error?: Error }>((resolve) => {
    child.once('error', (error) => resolve({ code: null, error }));
    child.once('close', (code) => resolve({ code }));
  });
  try {
    for await (const value of child.stdout) {
      throwIfAborted(options.signal);
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      await options.writer.write(chunk);
      options.hash.update(chunk);
      lastByte = chunk.at(-1);
      options.onProgress?.({ message: '正在写入 SQL 导出…', bytes: options.writer.bytesWritten });
    }
    const result = await exit;
    throwIfAborted(options.signal);
    if (result.error) throw result.error;
    if (result.code !== 0) {
      const detail = redactSensitiveText(Buffer.concat(stderr).toString('utf8').trim(), [options.password]);
      throw new Error(`mysqldump 失败（退出码 ${String(result.code)}）：${detail || '未提供错误详情。'}`);
    }
    return lastByte;
  } finally {
    options.signal?.removeEventListener('abort', abort);
    if (forceKill) clearTimeout(forceKill);
  }
}

function scopeLabel(scope: SqlExportScope): string {
  return scope.kind === 'database' ? scope.database : `${scope.database}.${scope.table}`;
}
