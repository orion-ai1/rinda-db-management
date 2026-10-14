import { createHash, randomBytes } from 'node:crypto';
import type { PoolConnection } from 'mysql2/promise';
import type * as vscode from 'vscode';
import type { ConnectionManager } from '../connection/ConnectionManager.js';
import { escapeIdentifier } from '../query/sqlGuards.js';
import { prepareSqlPackage } from '../transfer/SqlPackage.js';

const SYSTEM_SCHEMAS = new Set(['information_schema', 'mysql', 'performance_schema', 'sys']);
const DEFAULT_TOKEN_TTL_MS = 90_000;

export type TableMaintenanceOperation = 'truncate' | 'drop';

export interface TableDependency {
  schema: string;
  table: string;
  name: string;
}

export interface TableMaintenanceSnapshot {
  connectionId: string;
  database: string;
  table: string;
  operation: TableMaintenanceOperation;
  analyzedAt: string;
  engine?: string;
  estimatedRows?: number;
  dataBytes?: number;
  indexBytes?: number;
  inboundForeignKeys: TableDependency[];
  outboundForeignKeys: TableDependency[];
  referencingViews: TableDependency[];
  triggers: string[];
  definitionSha256: string;
  objectFingerprint: string;
}

export interface VerifiedMaintenanceBackup {
  path: string;
  sha256: string;
  bytes: number;
  exportedAt: string;
  standalone: boolean;
  restoreReasons: string[];
}

export interface MaintenanceAuthorization {
  token: string;
  expiresAt: string;
  finalPhrase: string;
}

export interface TableMaintenanceResult {
  operation: TableMaintenanceOperation;
  database: string;
  table: string;
  durationMs: number;
}

interface AuthorizationRecord {
  snapshot: TableMaintenanceSnapshot;
  backup: VerifiedMaintenanceBackup;
  expiresAtMs: number;
  finalPhrase: string;
}

export class TableMaintenanceError extends Error {
  public constructor(
    message: string,
    public readonly category: 'validation' | 'dependency' | 'permission' | 'conflict' | 'expired' | 'foreign-key' | 'unknown-result' | 'execution',
    public readonly resultUnknown = false,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = 'TableMaintenanceError';
  }
}

export class TableMaintenanceService {
  private readonly authorizations = new Map<string, AuthorizationRecord>();

  public constructor(
    private readonly connections: Pick<ConnectionManager, 'withConnection'>,
    private readonly output: vscode.OutputChannel,
    private readonly now: () => Date = () => new Date(),
    private readonly tokenTtlMs = DEFAULT_TOKEN_TTL_MS
  ) {}

  public async analyze(
    connectionId: string,
    database: string,
    table: string,
    operation: TableMaintenanceOperation
  ): Promise<TableMaintenanceSnapshot> {
    validateTarget(database, table);
    return this.connections.withConnection(connectionId, async (connection) => {
      const inspected = await inspectTable(connection, database, table);
      const missingPrivilege = findMissingDropPrivilege(inspected.grants, database, table);
      if (missingPrivilege) {
        throw new TableMaintenanceError(
          `${operationLabel(operation)}需要目标表的 DROP 权限；当前连接的权限预检未通过。`,
          'permission'
        );
      }
      if (inspected.inboundForeignKeys.length > 0) {
        throw new TableMaintenanceError(
          `目标表被 ${inspected.inboundForeignKeys.map(formatDependency).join('、')} 的外键引用；不会关闭外键检查、级联或降级为 DELETE。`,
          'dependency'
        );
      }
      if (operation === 'drop' && inspected.referencingViews.length > 0) {
        throw new TableMaintenanceError(
          `目标表被视图 ${inspected.referencingViews.map(formatDependency).join('、')} 引用；为避免留下失效视图，已拒绝 DROP TABLE。`,
          'dependency'
        );
      }
      const analyzedAt = this.now().toISOString();
      const definitionSha256 = sha256(inspected.createSql);
      const objectFingerprint = buildObjectFingerprint({
        engine: inspected.engine,
        createSql: inspected.createSql,
        inboundForeignKeys: inspected.inboundForeignKeys,
        outboundForeignKeys: inspected.outboundForeignKeys,
        referencingViews: inspected.referencingViews,
        triggers: inspected.triggers
      });
      return {
        connectionId,
        database,
        table,
        operation,
        analyzedAt,
        engine: inspected.engine,
        estimatedRows: inspected.estimatedRows,
        dataBytes: inspected.dataBytes,
        indexBytes: inspected.indexBytes,
        inboundForeignKeys: inspected.inboundForeignKeys,
        outboundForeignKeys: inspected.outboundForeignKeys,
        referencingViews: inspected.referencingViews,
        triggers: inspected.triggers,
        definitionSha256,
        objectFingerprint
      };
    });
  }

  public async verifyBackup(
    snapshot: TableMaintenanceSnapshot,
    path: string,
    expectedSha256?: string
  ): Promise<VerifiedMaintenanceBackup> {
    const packageFile = await prepareSqlPackage(path);
    try {
      const scope = packageFile.metadata.scope;
      if (scope.kind !== 'table' || scope.database !== snapshot.database || scope.table !== snapshot.table) {
        throw new TableMaintenanceError('备份包范围与当前维护目标不完全一致。', 'validation');
      }
      if (packageFile.metadata.objects.tables !== 1 || packageFile.metadata.objects.views !== 0
        || packageFile.metadata.objects.routines !== 0 || packageFile.metadata.objects.events !== 0) {
        throw new TableMaintenanceError('备份包不是单个基础表的受控 SQL 包。', 'validation');
      }
      if (Date.parse(packageFile.metadata.exportedAt) < Date.parse(snapshot.analyzedAt)) {
        throw new TableMaintenanceError('备份早于本次影响分析；请重新生成备份。', 'validation');
      }
      if (expectedSha256 && packageFile.sha256 !== expectedSha256) {
        throw new TableMaintenanceError('备份摘要与刚完成的导出结果不一致。', 'validation');
      }
      return {
        path: packageFile.sourcePath,
        sha256: packageFile.sha256,
        bytes: packageFile.bytes,
        exportedAt: packageFile.metadata.exportedAt,
        standalone: packageFile.metadata.restorePolicy.standalone,
        restoreReasons: [...packageFile.metadata.restorePolicy.reasons]
      };
    } finally {
      await packageFile.cleanup();
    }
  }

  public authorize(
    snapshot: TableMaintenanceSnapshot,
    backup: VerifiedMaintenanceBackup,
    firstConfirmation: string
  ): MaintenanceAuthorization {
    const targetPhrase = confirmationPhrase(snapshot.operation, snapshot.database, snapshot.table);
    if (firstConfirmation !== targetPhrase) {
      throw new TableMaintenanceError(`第一层确认必须完整输入：${targetPhrase}`, 'validation');
    }
    this.pruneExpiredAuthorizations();
    const token = randomBytes(4).toString('hex').toUpperCase();
    const expiresAtMs = this.now().getTime() + this.tokenTtlMs;
    const finalPhrase = `TOKEN ${token} ${targetPhrase}`;
    this.authorizations.set(token, { snapshot, backup, expiresAtMs, finalPhrase });
    return { token, expiresAt: new Date(expiresAtMs).toISOString(), finalPhrase };
  }

  public async execute(token: string, finalConfirmation: string): Promise<TableMaintenanceResult> {
    const authorization = this.authorizations.get(token);
    this.authorizations.delete(token);
    if (!authorization) {
      throw new TableMaintenanceError('维护授权 token 无效或已经使用。', 'expired');
    }
    if (this.now().getTime() > authorization.expiresAtMs) {
      throw new TableMaintenanceError('维护授权 token 已过期；请重新执行影响分析、备份和确认。', 'expired');
    }
    if (finalConfirmation !== authorization.finalPhrase) {
      throw new TableMaintenanceError(`第二层确认必须完整输入：${authorization.finalPhrase}`, 'validation');
    }

    const backup = await this.verifyBackup(
      authorization.snapshot,
      authorization.backup.path,
      authorization.backup.sha256
    );
    if (backup.exportedAt !== authorization.backup.exportedAt) {
      throw new TableMaintenanceError('备份包元数据在确认后发生变化。', 'conflict');
    }

    const current = await this.analyze(
      authorization.snapshot.connectionId,
      authorization.snapshot.database,
      authorization.snapshot.table,
      authorization.snapshot.operation
    );
    if (current.objectFingerprint !== authorization.snapshot.objectFingerprint) {
      throw new TableMaintenanceError('表定义或依赖关系在确认后发生变化；未执行维护操作，请重新分析和备份。', 'conflict');
    }

    const startedAt = performance.now();
    let statementStarted = false;
    try {
      await this.connections.withConnection(authorization.snapshot.connectionId, async (connection) => {
        statementStarted = true;
        await connection.query(buildMaintenanceSql(
          authorization.snapshot.operation,
          authorization.snapshot.database,
          authorization.snapshot.table
        ));
        await verifyOutcome(
          connection,
          authorization.snapshot.operation,
          authorization.snapshot.database,
          authorization.snapshot.table
        );
      });
    } catch (error) {
      const mapped = mapMaintenanceError(error, statementStarted, authorization.snapshot.operation);
      this.output.appendLine(
        `[维护] ${operationLabel(authorization.snapshot.operation)} ${authorization.snapshot.database}.${authorization.snapshot.table} 失败：${mapped.message}`
      );
      throw mapped;
    }
    const durationMs = Math.round(performance.now() - startedAt);
    this.output.appendLine(
      `[维护] ${operationLabel(authorization.snapshot.operation)} ${authorization.snapshot.database}.${authorization.snapshot.table} 完成，${durationMs} ms；备份 SHA-256 ${backup.sha256}`
    );
    return {
      operation: authorization.snapshot.operation,
      database: authorization.snapshot.database,
      table: authorization.snapshot.table,
      durationMs
    };
  }

  private pruneExpiredAuthorizations(): void {
    const now = this.now().getTime();
    for (const [token, authorization] of this.authorizations) {
      if (authorization.expiresAtMs < now) this.authorizations.delete(token);
    }
  }
}

export function confirmationPhrase(
  operation: TableMaintenanceOperation,
  database: string,
  table: string
): string {
  return operation === 'truncate'
    ? `TRUNCATE ${database}.${table}`
    : `DROP TABLE ${database}.${table}`;
}

export function buildMaintenanceSql(
  operation: TableMaintenanceOperation,
  database: string,
  table: string
): string {
  validateTarget(database, table);
  const target = `${escapeIdentifier(database)}.${escapeIdentifier(table)}`;
  return operation === 'truncate' ? `TRUNCATE TABLE ${target}` : `DROP TABLE ${target}`;
}

interface Inspection {
  engine?: string;
  estimatedRows?: number;
  dataBytes?: number;
  indexBytes?: number;
  createSql: string;
  inboundForeignKeys: TableDependency[];
  outboundForeignKeys: TableDependency[];
  referencingViews: TableDependency[];
  triggers: string[];
  grants: string[];
}

async function inspectTable(connection: PoolConnection, database: string, table: string): Promise<Inspection> {
  const [tableRows] = await connection.execute({
    sql: `SELECT engine, table_rows, data_length, index_length, table_type
          FROM information_schema.tables
          WHERE table_schema = ? AND table_name = ?`,
    values: [database, table],
    rowsAsArray: true
  });
  const row = (tableRows as unknown[][])[0];
  if (!row) throw new TableMaintenanceError('目标表不存在。', 'conflict');
  if (String(row[4]).toUpperCase() !== 'BASE TABLE') {
    throw new TableMaintenanceError('高风险维护只允许作用于基础表，不支持视图。', 'validation');
  }

  const [createRows] = await connection.query({
    sql: `SHOW CREATE TABLE ${escapeIdentifier(database)}.${escapeIdentifier(table)}`,
    rowsAsArray: true
  });
  const createSql = String((createRows as unknown[][])[0]?.[1] ?? '');
  if (!createSql) throw new TableMaintenanceError('无法读取目标表定义。', 'validation');

  const [inboundRows, outboundRows, viewRows, triggerRows, grantRows] = await Promise.all([
    connection.execute({
      sql: `SELECT table_schema, table_name, constraint_name
            FROM information_schema.key_column_usage
            WHERE referenced_table_schema = ? AND referenced_table_name = ?
              AND NOT (table_schema = ? AND table_name = ?)
            GROUP BY table_schema, table_name, constraint_name
            ORDER BY table_schema, table_name, constraint_name`,
      values: [database, table, database, table],
      rowsAsArray: true
    }),
    connection.execute({
      sql: `SELECT referenced_table_schema, referenced_table_name, constraint_name
            FROM information_schema.key_column_usage
            WHERE table_schema = ? AND table_name = ? AND referenced_table_name IS NOT NULL
              AND NOT (referenced_table_schema = ? AND referenced_table_name = ?)
            GROUP BY referenced_table_schema, referenced_table_name, constraint_name
            ORDER BY referenced_table_schema, referenced_table_name, constraint_name`,
      values: [database, table, database, table],
      rowsAsArray: true
    }),
    connection.execute({
      sql: `SELECT view_schema, view_name
            FROM information_schema.view_table_usage
            WHERE table_schema = ? AND table_name = ?
            ORDER BY view_schema, view_name`,
      values: [database, table],
      rowsAsArray: true
    }),
    connection.execute({
      sql: `SELECT trigger_name
            FROM information_schema.triggers
            WHERE trigger_schema = ? AND event_object_table = ?
            ORDER BY trigger_name`,
      values: [database, table],
      rowsAsArray: true
    }),
    connection.query({ sql: 'SHOW GRANTS', rowsAsArray: true })
  ]);

  return {
    engine: optionalString(row[0]),
    estimatedRows: optionalNumber(row[1]),
    dataBytes: optionalNumber(row[2]),
    indexBytes: optionalNumber(row[3]),
    createSql,
    inboundForeignKeys: dependencyRows(inboundRows[0] as unknown[][]),
    outboundForeignKeys: dependencyRows(outboundRows[0] as unknown[][]),
    referencingViews: (viewRows[0] as unknown[][]).map((item) => ({
      schema: String(item[0]), table: String(item[1]), name: 'VIEW'
    })),
    triggers: (triggerRows[0] as unknown[][]).map((item) => String(item[0])),
    grants: (grantRows[0] as unknown[][]).map((item) => String(item[0]))
  };
}

function dependencyRows(rows: unknown[][]): TableDependency[] {
  return rows.map((item) => ({ schema: String(item[0]), table: String(item[1]), name: String(item[2]) }));
}

function buildObjectFingerprint(value: {
  engine?: string;
  createSql: string;
  inboundForeignKeys: TableDependency[];
  outboundForeignKeys: TableDependency[];
  referencingViews: TableDependency[];
  triggers: string[];
}): string {
  return sha256(JSON.stringify(value));
}

function findMissingDropPrivilege(grants: readonly string[], database: string, table: string): boolean {
  for (const grant of grants) {
    const match = /^GRANT\s+(.+?)\s+ON\s+(.+?)\s+TO\s+/i.exec(grant);
    if (!match?.[1] || !match[2]) continue;
    const privileges = match[1].split(',').map((value) => value.trim().toUpperCase());
    if (!privileges.includes('ALL') && !privileges.includes('ALL PRIVILEGES') && !privileges.includes('DROP')) continue;
    if (grantScopeCovers(match[2], database, table)) return false;
  }
  return true;
}

function grantScopeCovers(scope: string, database: string, table: string): boolean {
  const normalized = scope.trim();
  if (normalized === '*.*') return true;
  const separator = normalized.lastIndexOf('.');
  if (separator < 0) return false;
  const databasePattern = unquoteGrantIdentifier(normalized.slice(0, separator));
  const tablePattern = unquoteGrantIdentifier(normalized.slice(separator + 1));
  return grantPatternMatches(databasePattern, database) && grantPatternMatches(tablePattern, table);
}

function unquoteGrantIdentifier(value: string): string {
  const trimmed = value.trim();
  return trimmed.startsWith('`') && trimmed.endsWith('`')
    ? trimmed.slice(1, -1).replaceAll('``', '`')
    : trimmed;
}

function grantPatternMatches(pattern: string, value: string): boolean {
  if (pattern === '*') return true;
  let regex = '^';
  let escaped = false;
  for (const char of pattern) {
    if (!escaped && char === '\\') { escaped = true; continue; }
    if (!escaped && char === '%') regex += '.*';
    else if (!escaped && char === '_') regex += '.';
    else regex += char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    escaped = false;
  }
  if (escaped) regex += '\\\\';
  return new RegExp(`${regex}$`, 'i').test(value);
}

async function verifyOutcome(
  connection: PoolConnection,
  operation: TableMaintenanceOperation,
  database: string,
  table: string
): Promise<void> {
  const [rows] = await connection.execute({
    sql: 'SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = ? AND table_name = ? AND table_type = ?',
    values: [database, table, 'BASE TABLE'],
    rowsAsArray: true
  });
  const exists = Number((rows as unknown[][])[0]?.[0] ?? 0) === 1;
  if (operation === 'drop') {
    if (exists) throw new Error('DROP TABLE 返回成功，但对象仍然存在。');
    return;
  }
  if (!exists) throw new Error('TRUNCATE 返回成功，但目标表不存在。');
  const [remaining] = await connection.query({
    sql: `SELECT EXISTS(SELECT 1 FROM ${escapeIdentifier(database)}.${escapeIdentifier(table)} LIMIT 1)`,
    rowsAsArray: true
  });
  if (Number((remaining as unknown[][])[0]?.[0] ?? 1) !== 0) {
    throw new Error('TRUNCATE 返回成功，但表中仍有数据。');
  }
}

function mapMaintenanceError(
  error: unknown,
  statementStarted: boolean,
  operation: TableMaintenanceOperation
): TableMaintenanceError {
  if (error instanceof TableMaintenanceError) return error;
  const mysqlError = error as NodeJS.ErrnoException & { errno?: number; sqlState?: string };
  const code = mysqlError.code ?? '';
  if (['ER_ROW_IS_REFERENCED', 'ER_ROW_IS_REFERENCED_2', 'ER_FK_CANNOT_DROP_PARENT', 'ER_TRUNCATE_ILLEGAL_FK'].includes(code)) {
    return new TableMaintenanceError(
      `${operationLabel(operation)}被外键约束阻止；不会关闭外键检查、级联或改用 DELETE。`,
      'foreign-key',
      false,
      { cause: error }
    );
  }
  if (['ER_TABLEACCESS_DENIED_ERROR', 'ER_DBACCESS_DENIED_ERROR', 'ER_SPECIFIC_ACCESS_DENIED_ERROR', 'ER_ACCESS_DENIED_ERROR'].includes(code)) {
    return new TableMaintenanceError(`${operationLabel(operation)}权限不足；未绕过权限限制。`, 'permission', false, { cause: error });
  }
  if (['ER_BAD_TABLE_ERROR', 'ER_NO_SUCH_TABLE'].includes(code)) {
    return new TableMaintenanceError('目标表在执行前已不存在。', 'conflict', false, { cause: error });
  }
  if (statementStarted && isConnectionOutcomeUnknown(code)) {
    return new TableMaintenanceError(
      `${operationLabel(operation)}期间连接中断，结果未知。请刷新对象树并直接检查目标表；不要自动重试。`,
      'unknown-result',
      true,
      { cause: error }
    );
  }
  return new TableMaintenanceError(
    `${operationLabel(operation)}失败：${error instanceof Error ? error.message : String(error)}`,
    'execution',
    false,
    { cause: error }
  );
}

function isConnectionOutcomeUnknown(code: string): boolean {
  return ['PROTOCOL_CONNECTION_LOST', 'ECONNRESET', 'ETIMEDOUT', 'PROTOCOL_SEQUENCE_TIMEOUT', 'EPIPE', 'ECONNABORTED'].includes(code);
}

function validateTarget(database: string, table: string): void {
  for (const [label, value] of [['数据库', database], ['表', table]] as const) {
    if (!value || value.length > 64 || value.includes('\0') || /[\r\n]/.test(value)) {
      throw new TableMaintenanceError(`${label}名称无效。`, 'validation');
    }
  }
  if (SYSTEM_SCHEMAS.has(database.toLowerCase())) {
    throw new TableMaintenanceError('禁止对系统数据库执行高风险维护。', 'validation');
  }
}

function operationLabel(operation: TableMaintenanceOperation): string {
  return operation === 'truncate' ? 'TRUNCATE' : 'DROP TABLE';
}

function formatDependency(dependency: TableDependency): string {
  return `${dependency.schema}.${dependency.table}（${dependency.name}）`;
}

function optionalString(value: unknown): string | undefined {
  return value === null || value === undefined ? undefined : String(value);
}

function optionalNumber(value: unknown): number | undefined {
  if (value === null || value === undefined) return undefined;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : undefined;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
