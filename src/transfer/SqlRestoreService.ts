import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import type * as vscode from 'vscode';
import type { ConnectionManager } from '../connection/ConnectionManager.js';
import type { ConnectionStore } from '../connection/ConnectionStore.js';
import { escapeIdentifier } from '../query/sqlGuards.js';
import { redactSensitiveText } from '../security/redaction.js';
import { createCredentialFile } from './CredentialFile.js';
import type { MysqlClientResolver } from './MySqlToolResolver.js';
import { createDatabaseQualifierRewriteStream, prepareSqlPackage } from './SqlPackage.js';
import type { PreparedSqlPackage } from './SqlPackage.js';
import type { MysqlClientTool, SqlObjectSummary } from './types.js';
import { throwIfAborted } from './types.js';

export type RestoreTargetMode = 'create' | 'empty';
export type RestoreStage = 'validation' | 'preflight' | 'target' | 'apply' | 'verify';

export interface RestoreProgress {
  stage: RestoreStage;
  message: string;
}

export interface RestorePreflight {
  client: MysqlClientTool;
  targetServerVersion: string;
  targetExists: boolean;
  targetObjects: SqlObjectSummary;
  requiredPrivileges: string[];
  warnings: string[];
}

export interface RestoreResult {
  targetDatabase: string;
  targetCreated: boolean;
  durationMs: number;
  objects: SqlObjectSummary;
  warnings: string[];
}

export interface SqlRestoreOptions {
  connectionId: string;
  targetDatabase: string;
  targetMode: RestoreTargetMode;
  package: PreparedSqlPackage;
  signal?: AbortSignal;
  onProgress?: (progress: RestoreProgress) => void;
}

export class SqlRestoreError extends Error {
  public constructor(
    message: string,
    public readonly stage: RestoreStage,
    public readonly partialSuccess: boolean,
    public readonly targetDatabase: string,
    public readonly guidance: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = 'SqlRestoreError';
  }
}

export class SqlRestoreService {
  public constructor(
    private readonly store: ConnectionStore,
    private readonly connections: ConnectionManager,
    private readonly clientResolver: MysqlClientResolver,
    private readonly output: vscode.OutputChannel
  ) {}

  public preparePackage(path: string, signal?: AbortSignal): Promise<PreparedSqlPackage> {
    return prepareSqlPackage(path, signal);
  }

  public async preflight(
    packageFile: PreparedSqlPackage,
    connectionId: string,
    targetDatabase: string,
    targetMode: RestoreTargetMode,
    signal?: AbortSignal
  ): Promise<RestorePreflight> {
    validateTargetDatabase(targetDatabase);
    throwIfAborted(signal);
    if (!packageFile.metadata.restorePolicy.standalone) {
      throw new Error(
        `该 SQL 包不是可独立恢复的包（${packageFile.metadata.restorePolicy.reasons.join('；')}）。请改为导出包含依赖对象的完整数据库。`
      );
    }
    const [client, target] = await Promise.all([
      this.clientResolver.resolve(signal),
      inspectTarget(this.connections, connectionId, targetDatabase)
    ]);
    validateCompatibility(packageFile, client, target.serverVersion);
    validateTargetState(targetMode, targetDatabase, target.exists, target.objects);
    const requiredPrivileges = requiredRestorePrivileges(packageFile.metadata.objects, targetMode);
    const missingPrivileges = findMissingPrivileges(target.grants, requiredPrivileges, targetDatabase);
    if (missingPrivileges.length > 0) {
      throw new Error(`权限预检未通过，目标连接缺少：${missingPrivileges.join('、')}。未执行任何恢复语句。`);
    }
    if (!target.supportsUtf8mb4) {
      throw new Error('目标服务器不支持 SQL 包要求的 utf8mb4 字符集。未执行任何恢复语句。');
    }
    const warnings: string[] = [];
    if (client.major !== target.major) {
      warnings.push(`mysql 客户端 ${client.version} 与目标服务器 ${target.serverVersion} 主版本不同；已通过方向兼容检查。`);
    }
    return {
      client,
      targetServerVersion: target.serverVersion,
      targetExists: target.exists,
      targetObjects: target.objects,
      requiredPrivileges,
      warnings
    };
  }

  public async restore(options: SqlRestoreOptions): Promise<RestoreResult> {
    const startedAt = performance.now();
    let stage: RestoreStage = 'preflight';
    let partialSuccess = false;
    let targetCreated = false;
    const profile = this.store.getRequired(options.connectionId);
    const password = await this.store.getPassword(options.connectionId) ?? '';
    let credential: Awaited<ReturnType<typeof createCredentialFile>> | undefined;
    try {
      options.onProgress?.({ stage, message: '正在复检版本、字符集、权限与目标库状态…' });
      const preflight = await this.preflight(
        options.package,
        options.connectionId,
        options.targetDatabase,
        options.targetMode,
        options.signal
      );
      throwIfAborted(options.signal);
      credential = await createCredentialFile(profile, password, preflight.client.vendor);

      stage = 'target';
      if (options.targetMode === 'create') {
        options.onProgress?.({ stage, message: `正在创建目标数据库 ${options.targetDatabase}…` });
        await this.connections.withConnection(options.connectionId, async (connection) => {
          await connection.query(
            `CREATE DATABASE ${escapeIdentifier(options.targetDatabase)} CHARACTER SET utf8mb4`
          );
        });
        targetCreated = true;
        partialSuccess = true;
      } else {
        options.onProgress?.({ stage, message: `正在最终确认 ${options.targetDatabase} 仍为空…` });
        const current = await inspectTarget(this.connections, options.connectionId, options.targetDatabase);
        validateTargetState('empty', options.targetDatabase, current.exists, current.objects);
      }

      stage = 'apply';
      options.onProgress?.({ stage, message: '正在应用已验证 SQL；遇到首个错误即停止…' });
      partialSuccess = true;
      await runMysqlClient({
        tool: preflight.client,
        credentialPath: credential.path,
        targetDatabase: options.targetDatabase,
        sourceDatabase: options.package.metadata.scope.database,
        stagedPath: options.package.stagedPath,
        password,
        signal: options.signal
      });

      stage = 'verify';
      options.onProgress?.({ stage, message: '正在核对恢复后的对象清单…' });
      const verified = await inspectTarget(this.connections, options.connectionId, options.targetDatabase);
      verifyObjectSummary(options.package.metadata.objects, verified.objects, options.package.metadata.scope.kind);
      const durationMs = Math.round(performance.now() - startedAt);
      this.output.appendLine(
        `[恢复] ${options.targetDatabase} 完成，${durationMs} ms，包 SHA-256 ${options.package.sha256}`
      );
      return {
        targetDatabase: options.targetDatabase,
        targetCreated,
        durationMs,
        objects: verified.objects,
        warnings: preflight.warnings
      };
    } catch (error) {
      const aborted = (error as Error).name === 'AbortError';
      const detail = aborted
        ? '用户取消了恢复操作。'
        : redactSensitiveText(error, password ? [password] : []);
      this.output.appendLine(`[恢复] ${options.targetDatabase} 在${stageLabel(stage)}失败：${detail}`);
      if (error instanceof SqlRestoreError) throw error;
      const guidance = partialSuccess
        ? `目标数据库“${options.targetDatabase}”可能已包含部分对象或数据。扩展不会自动回滚、重试或删除该库；请停止业务写入，人工核对后决定保留或手动删除。`
        : '恢复尚未开始应用 SQL；目标数据未被恢复语句修改。修正预检问题后可重新操作。';
      throw new SqlRestoreError(
        `${aborted ? '恢复已取消' : `${stageLabel(stage)}失败`}：${detail}`,
        stage,
        partialSuccess,
        options.targetDatabase,
        guidance,
        { cause: error }
      );
    } finally {
      await credential?.cleanup();
    }
  }
}

export function buildMysqlRestoreArgs(credentialPath: string, targetDatabase: string): string[] {
  validateTargetDatabase(targetDatabase);
  return [
    `--defaults-extra-file=${credentialPath}`,
    '--protocol=TCP',
    '--default-character-set=utf8mb4',
    '--binary-mode',
    '--show-warnings',
    '--batch',
    `--database=${targetDatabase}`
  ];
}

interface TargetInspection {
  serverVersion: string;
  vendor: 'mysql' | 'mariadb';
  major: number;
  supportsUtf8mb4: boolean;
  exists: boolean;
  objects: SqlObjectSummary;
  grants: string[];
}

async function inspectTarget(
  connections: ConnectionManager,
  connectionId: string,
  targetDatabase: string
): Promise<TargetInspection> {
  return connections.withConnection(connectionId, async (connection) => {
    const [versionRows] = await connection.query({
      sql: 'SELECT VERSION()',
      rowsAsArray: true
    });
    const serverVersion = String((versionRows as unknown[][])[0]?.[0] ?? '');
    const version = parseServerVersion(serverVersion);
    const [charsetRows] = await connection.execute({
      sql: 'SELECT COUNT(*) FROM information_schema.character_sets WHERE character_set_name = ?',
      values: ['utf8mb4'],
      rowsAsArray: true
    });
    const [schemaRows] = await connection.execute({
      sql: 'SELECT COUNT(*) FROM information_schema.schemata WHERE schema_name = ?',
      values: [targetDatabase],
      rowsAsArray: true
    });
    const exists = Number((schemaRows as unknown[][])[0]?.[0] ?? 0) === 1;
    const objects = exists
      ? await readObjectSummary(connection, targetDatabase)
      : emptyObjectSummary();
    const [grantRows] = await connection.query({ sql: 'SHOW GRANTS', rowsAsArray: true });
    const grants = (grantRows as unknown[][]).map((row) => String(row[0] ?? ''));
    return {
      serverVersion,
      ...version,
      supportsUtf8mb4: Number((charsetRows as unknown[][])[0]?.[0] ?? 0) > 0,
      exists,
      objects,
      grants
    };
  });
}

async function readObjectSummary(
  connection: { execute(options: object): Promise<[unknown, unknown]> },
  database: string
): Promise<SqlObjectSummary> {
  const [tableResult, routineResult, eventResult, triggerResult] = await Promise.all([
    connection.execute({
      sql: `SELECT
              SUM(table_type = 'BASE TABLE'),
              SUM(table_type = 'VIEW')
            FROM information_schema.tables WHERE table_schema = ?`,
      values: [database],
      rowsAsArray: true
    }),
    connection.execute({
      sql: 'SELECT COUNT(*) FROM information_schema.routines WHERE routine_schema = ?',
      values: [database],
      rowsAsArray: true
    }),
    connection.execute({
      sql: 'SELECT COUNT(*) FROM information_schema.events WHERE event_schema = ?',
      values: [database],
      rowsAsArray: true
    }),
    connection.execute({
      sql: 'SELECT COUNT(*) FROM information_schema.triggers WHERE trigger_schema = ?',
      values: [database],
      rowsAsArray: true
    })
  ]);
  const tableRow = (tableResult[0] as unknown[][])[0] ?? [];
  return {
    tables: Number(tableRow[0] ?? 0),
    views: Number(tableRow[1] ?? 0),
    routines: firstCount(routineResult[0]),
    events: firstCount(eventResult[0]),
    triggers: firstCount(triggerResult[0])
  };
}

function firstCount(rows: unknown): number {
  return Number((rows as unknown[][])[0]?.[0] ?? 0);
}

function emptyObjectSummary(): SqlObjectSummary {
  return { tables: 0, views: 0, routines: 0, events: 0, triggers: 0 };
}

function validateTargetState(
  mode: RestoreTargetMode,
  database: string,
  exists: boolean,
  objects: SqlObjectSummary
): void {
  if (mode === 'create' && exists) {
    throw new Error(`目标数据库“${database}”已存在；受控恢复禁止覆盖已有数据库。`);
  }
  if (mode === 'empty' && !exists) {
    throw new Error(`目标数据库“${database}”不存在；请选择“新建目标数据库”。`);
  }
  const objectCount = Object.values(objects).reduce((sum, count) => sum + count, 0);
  if (mode === 'empty' && objectCount > 0) {
    throw new Error(
      `目标数据库“${database}”不是空库（表 ${objects.tables}、视图 ${objects.views}、例程 ${objects.routines}、事件 ${objects.events}、触发器 ${objects.triggers}）；禁止覆盖恢复。`
    );
  }
}

function validateCompatibility(
  packageFile: PreparedSqlPackage,
  client: MysqlClientTool,
  targetServerVersion: string
): void {
  const source = parseServerVersion(packageFile.metadata.sourceServerVersion);
  const target = parseServerVersion(targetServerVersion);
  if (packageFile.metadata.tool.vendor !== source.vendor) {
    throw new Error(
      `版本预检失败：导出工具为 ${packageFile.metadata.tool.vendor} ${packageFile.metadata.tool.version}，来源服务器为 ${packageFile.metadata.sourceServerVersion}。`
    );
  }
  if (source.vendor !== target.vendor) {
    throw new Error(`版本预检失败：SQL 包来自 ${source.vendor}，目标服务器为 ${target.vendor}；禁止跨产品恢复。`);
  }
  if (client.vendor !== target.vendor) {
    throw new Error(`版本预检失败：mysql 客户端为 ${client.vendor} ${client.version}，目标服务器为 ${target.vendor} ${targetServerVersion}。`);
  }
  if (target.major < source.major) {
    throw new Error(`版本预检失败：目标服务器 ${targetServerVersion} 早于来源 ${packageFile.metadata.sourceServerVersion}。`);
  }
  if (client.major < target.major) {
    throw new Error(`版本预检失败：mysql 客户端 ${client.version} 早于目标服务器 ${targetServerVersion}。`);
  }
}

function parseServerVersion(value: string): { vendor: 'mysql' | 'mariadb'; major: number } {
  const vendor = /mariadb/i.test(value) ? 'mariadb' : 'mysql';
  const major = Number(/\d+/.exec(value)?.[0] ?? 0);
  if (!major) throw new Error(`无法识别服务器版本“${value}”。`);
  return { vendor, major };
}

export function requiredRestorePrivileges(
  objects: SqlObjectSummary,
  targetMode: RestoreTargetMode
): string[] {
  const required = new Set<string>();
  if (targetMode === 'create') required.add('CREATE');
  if (objects.tables > 0 || objects.views > 0) {
    required.add('CREATE');
    required.add('INSERT');
    required.add('ALTER');
  }
  if (objects.views > 0) {
    required.add('CREATE VIEW');
    required.add('SHOW VIEW');
    required.add('DROP');
  }
  if (objects.triggers > 0) required.add('TRIGGER');
  if (objects.routines > 0) {
    required.add('CREATE ROUTINE');
    required.add('ALTER ROUTINE');
  }
  if (objects.events > 0) required.add('EVENT');
  return [...required].sort();
}

export function findMissingPrivileges(
  grants: readonly string[],
  required: readonly string[],
  targetDatabase: string
): string[] {
  const available = new Set<string>();
  for (const grant of grants) {
    const match = /^GRANT\s+(.+?)\s+ON\s+(.+?)\s+TO\s+/i.exec(grant);
    if (!match?.[1] || !match[2] || !grantScopeMatches(match[2], targetDatabase)) continue;
    for (const privilege of match[1].split(',').map((item) => item.trim().toUpperCase())) {
      available.add(privilege);
    }
  }
  if (available.has('ALL') || available.has('ALL PRIVILEGES')) return [];
  return required.filter((privilege) => !available.has(privilege));
}

function grantScopeMatches(scope: string, targetDatabase: string): boolean {
  const normalized = scope.trim();
  if (normalized === '*.*') return true;
  const separator = normalized.lastIndexOf('.');
  if (separator < 0 || normalized.slice(separator + 1).replaceAll('`', '') !== '*') return false;
  let databasePattern = normalized.slice(0, separator).trim();
  if (databasePattern.startsWith('`') && databasePattern.endsWith('`')) {
    databasePattern = databasePattern.slice(1, -1).replaceAll('``', '`');
  }
  const escaped = databasePattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(`^${escaped.replace(/(?<!\\)%/g, '.*').replace(/(?<!\\)_/g, '.')}$`, 'i');
  return regex.test(targetDatabase);
}

function verifyObjectSummary(
  expected: SqlObjectSummary,
  actual: SqlObjectSummary,
  scope: 'database' | 'table'
): void {
  const mismatches = (Object.keys(expected) as Array<keyof SqlObjectSummary>)
    .filter((key) => actual[key] < expected[key])
    .map((key) => `${key}: 期望至少 ${expected[key]}，实际 ${actual[key]}`);
  if (scope === 'table' && actual.tables !== 1) {
    mismatches.push(`单表包恢复后应有 1 个基础表，实际 ${actual.tables}`);
  }
  if (mismatches.length > 0) {
    throw new Error(`恢复后对象核对未通过（${mismatches.join('；')}）。`);
  }
}

async function runMysqlClient(options: {
  tool: MysqlClientTool;
  credentialPath: string;
  targetDatabase: string;
  sourceDatabase: string;
  stagedPath: string;
  password: string;
  signal?: AbortSignal;
}): Promise<void> {
  throwIfAborted(options.signal);
  const child = spawn(
    options.tool.path,
    buildMysqlRestoreArgs(options.credentialPath, options.targetDatabase),
    { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }
  );
  const stderr: Buffer[] = [];
  const stdout: Buffer[] = [];
  let stderrBytes = 0;
  let stdoutBytes = 0;
  let forceKill: NodeJS.Timeout | undefined;
  const abort = (): void => {
    child.kill('SIGTERM');
    forceKill = setTimeout(() => child.kill('SIGKILL'), 2_000);
    forceKill.unref();
  };
  options.signal?.addEventListener('abort', abort, { once: true });
  child.stderr.on('data', (chunk: Buffer) => {
    if (stderrBytes >= 65_536) return;
    const kept = chunk.subarray(0, 65_536 - stderrBytes);
    stderr.push(kept);
    stderrBytes += kept.length;
  });
  child.stdout.on('data', (chunk: Buffer) => {
    if (stdoutBytes >= 16_384) return;
    const kept = chunk.subarray(0, 16_384 - stdoutBytes);
    stdout.push(kept);
    stdoutBytes += kept.length;
  });
  const exit = new Promise<{ code: number | null; error?: Error }>((resolve) => {
    child.once('error', (error) => resolve({ code: null, error }));
    child.once('close', (code) => resolve({ code }));
  });
  const input = pipeline(
    createReadStream(options.stagedPath),
    createDatabaseQualifierRewriteStream(options.sourceDatabase, options.targetDatabase),
    child.stdin
  ).catch((error: unknown) => error as Error);
  try {
    const result = await exit;
    const inputError = await input;
    throwIfAborted(options.signal);
    if (result.error) throw result.error;
    if (result.code !== 0) {
      const detail = redactSensitiveText(
        Buffer.concat(stderr).toString('utf8').trim(),
        options.password ? [options.password] : []
      );
      throw new Error(`mysql 在首个错误处停止（退出码 ${String(result.code)}）：${detail || '未提供错误详情。'}`);
    }
    if (inputError instanceof Error) throw inputError;
  } finally {
    options.signal?.removeEventListener('abort', abort);
    if (forceKill) clearTimeout(forceKill);
  }
}

function validateTargetDatabase(database: string): void {
  if (!database || database.length > 64 || database.includes('\0')
    || /[\r\n]/.test(database) || database.startsWith('-')) {
    throw new Error('目标数据库名称无效。');
  }
  if (['information_schema', 'mysql', 'performance_schema', 'sys'].includes(database.toLowerCase())) {
    throw new Error('受控恢复禁止使用系统数据库作为目标。');
  }
}

function stageLabel(stage: RestoreStage): string {
  switch (stage) {
    case 'validation': return '包校验阶段';
    case 'preflight': return '预检阶段';
    case 'target': return '目标库准备阶段';
    case 'apply': return 'SQL 应用阶段';
    case 'verify': return '结果核对阶段';
  }
}
