import { createHash, randomBytes } from 'node:crypto';
import type { PoolConnection } from 'mysql2/promise';
import type * as vscode from 'vscode';
import type { ConnectionManager } from '../connection/ConnectionManager.js';
import type { ConnectionStore } from '../connection/ConnectionStore.js';
import { escapeIdentifier } from '../query/sqlGuards.js';
import { prepareSqlPackage } from '../transfer/SqlPackage.js';
import type { SqlObjectSummary } from '../transfer/types.js';

const SYSTEM_SCHEMAS = new Set(['information_schema', 'mysql', 'performance_schema', 'sys']);
const TOKEN_TTL_MS = 90_000;
const REQUIRED_ANALYSIS_PRIVILEGES = ['DROP', 'SELECT', 'SHOW VIEW', 'TRIGGER', 'EVENT', 'EXECUTE'] as const;

export type DatabaseObjectType = 'TABLE' | 'VIEW' | 'PROCEDURE' | 'FUNCTION' | 'EVENT' | 'TRIGGER';

export interface DatabaseObjectImpact {
  name: string;
  type: DatabaseObjectType;
  engine?: string;
  estimatedRows?: number;
  dataBytes?: number;
  indexBytes?: number;
  detail?: string;
}

export interface ExternalDatabaseDependency {
  schema: string;
  object: string;
  kind: 'FOREIGN KEY' | 'VIEW';
  name: string;
}

export interface DatabaseMaintenanceSnapshot {
  connectionId: string;
  database: string;
  analyzedAt: string;
  characterSet: string;
  collation: string;
  objects: DatabaseObjectImpact[];
  summary: SqlObjectSummary;
  procedures: number;
  functions: number;
  estimatedRows: number;
  dataBytes: number;
  indexBytes: number;
  externalInboundDependencies: ExternalDatabaseDependency[];
  externalOutboundForeignKeys: ExternalDatabaseDependency[];
  objectFingerprint: string;
}

export interface VerifiedDatabaseBackup {
  path: string;
  sha256: string;
  bytes: number;
  exportedAt: string;
  standalone: boolean;
  restoreReasons: string[];
}

export interface DatabaseMaintenanceAuthorization {
  token: string;
  expiresAt: string;
  finalPhrase: string;
}

export interface DatabaseMaintenanceResult {
  database: string;
  durationMs: number;
}

interface AuthorizationRecord {
  snapshot: DatabaseMaintenanceSnapshot;
  backup: VerifiedDatabaseBackup;
  expiresAtMs: number;
  finalPhrase: string;
}

export class DatabaseMaintenanceError extends Error {
  public constructor(
    message: string,
    public readonly category: 'validation' | 'protected' | 'impact-incomplete' | 'dependency' | 'permission' | 'conflict' | 'expired' | 'unknown-result' | 'execution',
    public readonly resultUnknown = false,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = 'DatabaseMaintenanceError';
  }
}

export class DatabaseMaintenanceService {
  private readonly authorizations = new Map<string, AuthorizationRecord>();
  private readonly protectedDatabases: Set<string>;

  public constructor(
    private readonly store: Pick<ConnectionStore, 'getRequired'>,
    private readonly connections: Pick<ConnectionManager, 'withConnection'>,
    private readonly output: vscode.OutputChannel,
    protectedDatabases: readonly string[] = [],
    private readonly now: () => Date = () => new Date(),
    private readonly tokenTtlMs = TOKEN_TTL_MS
  ) {
    this.protectedDatabases = new Set(protectedDatabases.map((value) => value.trim().toLowerCase()).filter(Boolean));
  }

  public async analyze(connectionId: string, database: string): Promise<DatabaseMaintenanceSnapshot> {
    this.validateTarget(connectionId, database);
    try {
      return await this.connections.withConnection(connectionId, async (connection) => {
        const inspection = await inspectDatabase(connection, database);
        const missingPrivileges = findMissingAnalysisPrivileges(inspection.grants, database);
        if (missingPrivileges.length > 0) {
          throw new DatabaseMaintenanceError(
            `无法证明影响分析完整；当前连接在 ${database}.* 缺少：${missingPrivileges.join('、')}。未执行备份或 DROP DATABASE。`,
            'impact-incomplete'
          );
        }
        assertCompleteInventory(inspection);
        if (inspection.externalInboundDependencies.length > 0) {
          throw new DatabaseMaintenanceError(
            `目标库被外部对象引用：${inspection.externalInboundDependencies.map(formatDependency).join('、')}。不会使用 CASCADE、关闭外键检查或留下失效对象。`,
            'dependency'
          );
        }
        const objects = buildObjectImpacts(inspection);
        const summary = summarizeObjects(objects);
        return {
          connectionId,
          database,
          analyzedAt: this.now().toISOString(),
          characterSet: inspection.schemaRow[0] ?? '',
          collation: inspection.schemaRow[1] ?? '',
          objects,
          summary,
          procedures: objects.filter((item) => item.type === 'PROCEDURE').length,
          functions: objects.filter((item) => item.type === 'FUNCTION').length,
          estimatedRows: sum(objects, 'estimatedRows'),
          dataBytes: sum(objects, 'dataBytes'),
          indexBytes: sum(objects, 'indexBytes'),
          externalInboundDependencies: inspection.externalInboundDependencies,
          externalOutboundForeignKeys: inspection.externalOutboundForeignKeys,
          objectFingerprint: fingerprintInspection(inspection)
        };
      });
    } catch (error) {
      if (error instanceof DatabaseMaintenanceError) throw error;
      throw new DatabaseMaintenanceError(
        `全库影响分析未能完整完成：${error instanceof Error ? error.message : String(error)}。未执行备份或 DROP DATABASE。`,
        'impact-incomplete',
        false,
        { cause: error }
      );
    }
  }

  public async verifyBackup(
    snapshot: DatabaseMaintenanceSnapshot,
    path: string,
    expectedSha256?: string
  ): Promise<VerifiedDatabaseBackup> {
    const packageFile = await prepareSqlPackage(path);
    try {
      const scope = packageFile.metadata.scope;
      if (scope.kind !== 'database' || scope.database !== snapshot.database) {
        throw new DatabaseMaintenanceError('备份包范围与当前待删除数据库不完全一致。', 'validation');
      }
      if (!sameObjectSummary(packageFile.metadata.objects, snapshot.summary)) {
        throw new DatabaseMaintenanceError(
          `备份对象清单与影响分析不一致（分析：${formatSummary(snapshot.summary)}；备份：${formatSummary(packageFile.metadata.objects)}）。`,
          'conflict'
        );
      }
      if (Date.parse(packageFile.metadata.exportedAt) < Date.parse(snapshot.analyzedAt)) {
        throw new DatabaseMaintenanceError('全库备份早于本次影响分析；请重新生成备份。', 'validation');
      }
      if (expectedSha256 && packageFile.sha256 !== expectedSha256) {
        throw new DatabaseMaintenanceError('全库备份摘要与刚完成的导出结果不一致。', 'validation');
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
    snapshot: DatabaseMaintenanceSnapshot,
    backup: VerifiedDatabaseBackup,
    exactDatabaseName: string
  ): DatabaseMaintenanceAuthorization {
    this.validateTarget(snapshot.connectionId, snapshot.database);
    if (exactDatabaseName !== snapshot.database) {
      throw new DatabaseMaintenanceError(`第一层确认必须完整输入数据库名：${snapshot.database}`, 'validation');
    }
    this.pruneExpiredAuthorizations();
    const token = randomBytes(4).toString('hex').toUpperCase();
    const expiresAtMs = this.now().getTime() + this.tokenTtlMs;
    const finalPhrase = `TOKEN ${token} DROP DATABASE ${snapshot.database}`;
    this.authorizations.set(token, { snapshot, backup, expiresAtMs, finalPhrase });
    return { token, expiresAt: new Date(expiresAtMs).toISOString(), finalPhrase };
  }

  public async execute(token: string, finalConfirmation: string): Promise<DatabaseMaintenanceResult> {
    const authorization = this.authorizations.get(token);
    this.authorizations.delete(token);
    if (!authorization) {
      throw new DatabaseMaintenanceError('数据库维护授权 token 无效或已经使用。', 'expired');
    }
    if (this.now().getTime() > authorization.expiresAtMs) {
      throw new DatabaseMaintenanceError('数据库维护授权 token 已过期；请重新分析、备份和确认。', 'expired');
    }
    if (finalConfirmation !== authorization.finalPhrase) {
      throw new DatabaseMaintenanceError(`第二层确认必须完整输入：${authorization.finalPhrase}`, 'validation');
    }
    this.validateTarget(authorization.snapshot.connectionId, authorization.snapshot.database);

    const backup = await this.verifyBackup(
      authorization.snapshot,
      authorization.backup.path,
      authorization.backup.sha256
    );
    if (backup.exportedAt !== authorization.backup.exportedAt) {
      throw new DatabaseMaintenanceError('全库备份元数据在确认后发生变化。', 'conflict');
    }
    const current = await this.analyze(authorization.snapshot.connectionId, authorization.snapshot.database);
    if (current.objectFingerprint !== authorization.snapshot.objectFingerprint) {
      throw new DatabaseMaintenanceError('数据库对象、结构或依赖在确认后发生变化；未执行 DROP DATABASE。', 'conflict');
    }

    const startedAt = performance.now();
    let statementStarted = false;
    try {
      await this.connections.withConnection(authorization.snapshot.connectionId, async (connection) => {
        statementStarted = true;
        await connection.query(buildDropDatabaseSql(authorization.snapshot.database));
        const [rows] = await connection.execute({
          sql: 'SELECT COUNT(*) FROM information_schema.schemata WHERE schema_name = ?',
          values: [authorization.snapshot.database],
          rowsAsArray: true
        });
        if (Number((rows as unknown[][])[0]?.[0] ?? 1) !== 0) {
          throw new Error('DROP DATABASE 返回成功，但目标数据库仍然存在。');
        }
      });
    } catch (error) {
      const mapped = mapDropDatabaseError(error, statementStarted, authorization.snapshot.database);
      this.output.appendLine(`[维护] DROP DATABASE ${authorization.snapshot.database} 失败：${mapped.message}`);
      throw mapped;
    }
    const durationMs = Math.round(performance.now() - startedAt);
    this.output.appendLine(
      `[维护] DROP DATABASE ${authorization.snapshot.database} 完成，${durationMs} ms；备份 SHA-256 ${backup.sha256}`
    );
    return { database: authorization.snapshot.database, durationMs };
  }

  private validateTarget(connectionId: string, database: string): void {
    validateDatabaseName(database);
    const normalized = database.toLowerCase();
    if (SYSTEM_SCHEMAS.has(normalized)) {
      throw new DatabaseMaintenanceError('系统数据库永久禁止删除。', 'protected');
    }
    if (this.protectedDatabases.has(normalized)) {
      throw new DatabaseMaintenanceError(`数据库“${database}”已列入 rindaMysql.protectedDatabases，禁止删除。`, 'protected');
    }
    const profile = this.store.getRequired(connectionId);
    if (profile.database?.toLowerCase() === normalized) {
      throw new DatabaseMaintenanceError(
        `数据库“${database}”是连接“${profile.name}”的默认数据库，作为保护目标禁止删除；请使用不绑定该默认库的独立管理连接。`,
        'protected'
      );
    }
  }

  private pruneExpiredAuthorizations(): void {
    const now = this.now().getTime();
    for (const [token, authorization] of this.authorizations) {
      if (authorization.expiresAtMs < now) this.authorizations.delete(token);
    }
  }
}

export function buildDropDatabaseSql(database: string): string {
  validateDatabaseName(database);
  return `DROP DATABASE ${escapeIdentifier(database)}`;
}

interface DatabaseInspection {
  schemaRow: string[];
  createDatabase: string;
  tableRows: unknown[][];
  routineRows: unknown[][];
  eventRows: unknown[][];
  triggerRows: unknown[][];
  structureRows: Array<{ source: string; rows: unknown[][] }>;
  shownTables: Array<{ name: string; type: string }>;
  shownProcedures: string[];
  shownFunctions: string[];
  shownEvents: string[];
  shownTriggers: string[];
  grants: string[];
  externalInboundDependencies: ExternalDatabaseDependency[];
  externalOutboundForeignKeys: ExternalDatabaseDependency[];
}

async function inspectDatabase(connection: PoolConnection, database: string): Promise<DatabaseInspection> {
  const [schemaRows] = await connection.execute({
    sql: `SELECT default_character_set_name, default_collation_name
          FROM information_schema.schemata WHERE schema_name = ?`,
    values: [database],
    rowsAsArray: true
  });
  const schemaRow = (schemaRows as unknown[][])[0];
  if (!schemaRow) throw new DatabaseMaintenanceError('目标数据库不存在。', 'conflict');
  const [createRows] = await connection.query({
    sql: `SHOW CREATE DATABASE ${escapeIdentifier(database)}`,
    rowsAsArray: true
  });
  const createDatabase = String((createRows as unknown[][])[0]?.[1] ?? '');
  if (!createDatabase) throw new Error('无法读取数据库定义。');

  const results = await Promise.all([
    connection.execute({
      sql: `SELECT table_name, table_type, engine, table_rows, data_length, index_length,
                   data_free, table_collation, create_options
            FROM information_schema.tables WHERE table_schema = ? ORDER BY table_name`,
      values: [database], rowsAsArray: true
    }),
    connection.execute({
      sql: `SELECT routine_name, routine_type, data_type, routine_definition, is_deterministic,
                   sql_data_access, security_type, dtd_identifier
            FROM information_schema.routines WHERE routine_schema = ? ORDER BY routine_type, routine_name`,
      values: [database], rowsAsArray: true
    }),
    connection.execute({
      sql: `SELECT event_name, event_definition, event_type, execute_at, interval_value,
                   interval_field, status, on_completion
            FROM information_schema.events WHERE event_schema = ? ORDER BY event_name`,
      values: [database], rowsAsArray: true
    }),
    connection.execute({
      sql: `SELECT trigger_name, event_manipulation, event_object_table, action_order,
                   action_condition, action_statement, action_timing
            FROM information_schema.triggers WHERE trigger_schema = ? ORDER BY trigger_name`,
      values: [database], rowsAsArray: true
    }),
    structuralQuery(connection, 'columns', `SELECT table_name, column_name, ordinal_position, column_default,
                   is_nullable, column_type, collation_name, extra, generation_expression
            FROM information_schema.columns WHERE table_schema = ? ORDER BY table_name, ordinal_position`, database),
    structuralQuery(connection, 'statistics', `SELECT table_name, index_name, non_unique, seq_in_index, column_name,
                   collation, sub_part, nullable, index_type
            FROM information_schema.statistics WHERE table_schema = ? ORDER BY table_name, index_name, seq_in_index`, database),
    structuralQuery(connection, 'constraints', `SELECT table_name, constraint_name, constraint_type
            FROM information_schema.table_constraints WHERE table_schema = ? ORDER BY table_name, constraint_name`, database),
    structuralQuery(connection, 'keys', `SELECT table_name, constraint_name, column_name, ordinal_position,
                   referenced_table_schema, referenced_table_name, referenced_column_name
            FROM information_schema.key_column_usage WHERE table_schema = ?
            ORDER BY table_name, constraint_name, ordinal_position`, database),
    structuralQuery(connection, 'views', `SELECT table_name, view_definition, check_option, is_updatable, security_type
            FROM information_schema.views WHERE table_schema = ? ORDER BY table_name`, database),
    structuralQuery(connection, 'parameters', `SELECT specific_name, routine_type, ordinal_position, parameter_mode,
                   parameter_name, dtd_identifier
            FROM information_schema.parameters WHERE specific_schema = ? ORDER BY specific_name, ordinal_position`, database),
    showRows(connection, `SHOW FULL TABLES FROM ${escapeIdentifier(database)}`),
    showRows(connection, 'SHOW PROCEDURE STATUS WHERE Db = ?', [database]),
    showRows(connection, 'SHOW FUNCTION STATUS WHERE Db = ?', [database]),
    showRows(connection, `SHOW EVENTS FROM ${escapeIdentifier(database)}`),
    showRows(connection, `SHOW TRIGGERS FROM ${escapeIdentifier(database)}`),
    connection.query({ sql: 'SHOW GRANTS', rowsAsArray: true }),
    connection.execute({
      sql: `SELECT table_schema, table_name, constraint_name
            FROM information_schema.key_column_usage
            WHERE referenced_table_schema = ? AND table_schema <> ?
            GROUP BY table_schema, table_name, constraint_name
            ORDER BY table_schema, table_name, constraint_name`,
      values: [database, database], rowsAsArray: true
    }),
    connection.execute({
      sql: `SELECT view_schema, view_name
            FROM information_schema.view_table_usage
            WHERE table_schema = ? AND view_schema <> ? ORDER BY view_schema, view_name`,
      values: [database, database], rowsAsArray: true
    }),
    connection.execute({
      sql: `SELECT referenced_table_schema, referenced_table_name, constraint_name
            FROM information_schema.key_column_usage
            WHERE table_schema = ? AND referenced_table_schema IS NOT NULL AND referenced_table_schema <> ?
            GROUP BY referenced_table_schema, referenced_table_name, constraint_name
            ORDER BY referenced_table_schema, referenced_table_name, constraint_name`,
      values: [database, database], rowsAsArray: true
    })
  ]);

  const tableRows = queryRows(results[0]);
  const routineRows = queryRows(results[1]);
  const eventRows = queryRows(results[2]);
  const triggerRows = queryRows(results[3]);
  const createObjectRows = await readObjectDefinitions(connection, database, tableRows);
  const shownTableRows = results[10] as unknown[][];
  const shownProcedureRows = results[11] as unknown[][];
  const shownFunctionRows = results[12] as unknown[][];
  const shownEventRows = results[13] as unknown[][];
  const shownTriggerRows = results[14] as unknown[][];
  const grantRows = queryRows(results[15]);
  const inboundForeignKeys = queryRows(results[16]).map((row) => ({
    schema: String(row[0]), object: String(row[1]), kind: 'FOREIGN KEY' as const, name: String(row[2])
  }));
  const inboundViews = queryRows(results[17]).map((row) => ({
    schema: String(row[0]), object: String(row[1]), kind: 'VIEW' as const, name: String(row[1])
  }));
  const outbound = queryRows(results[18]).map((row) => ({
    schema: String(row[0]), object: String(row[1]), kind: 'FOREIGN KEY' as const, name: String(row[2])
  }));
  return {
    schemaRow: schemaRow.map(String),
    createDatabase,
    tableRows,
    routineRows,
    eventRows,
    triggerRows,
    structureRows: [
      ...(results.slice(4, 10) as Array<{ source: string; rows: unknown[][] }>),
      { source: 'createObjects', rows: createObjectRows }
    ],
    shownTables: shownTableRows.map((row) => ({ name: String(row[0]), type: normalizeShownTableType(row[1]) })),
    shownProcedures: shownProcedureRows.map((row) => String(row[1])),
    shownFunctions: shownFunctionRows.map((row) => String(row[1])),
    shownEvents: shownEventRows.map((row) => String(row[1])),
    shownTriggers: shownTriggerRows.map((row) => String(row[0])),
    grants: grantRows.map((row) => String(row[0])),
    externalInboundDependencies: [...inboundForeignKeys, ...inboundViews],
    externalOutboundForeignKeys: outbound
  };
}

async function readObjectDefinitions(
  connection: PoolConnection,
  database: string,
  tableRows: unknown[][]
): Promise<unknown[][]> {
  const definitions: unknown[][] = [];
  for (const row of tableRows) {
    const name = String(row[0]);
    const [createRows] = await connection.query({
      sql: `SHOW CREATE TABLE ${escapeIdentifier(database)}.${escapeIdentifier(name)}`,
      rowsAsArray: true
    });
    const createSql = String((createRows as unknown[][])[0]?.[1] ?? '');
    if (!createSql) throw new Error(`无法读取对象 ${database}.${name} 的完整定义。`);
    definitions.push([name, String(row[1]), createSql]);
  }
  return definitions;
}

async function structuralQuery(
  connection: PoolConnection,
  source: string,
  sql: string,
  database: string
): Promise<{ source: string; rows: unknown[][] }> {
  const [rows] = await connection.execute({ sql, values: [database], rowsAsArray: true });
  return { source, rows: rows as unknown[][] };
}

async function showRows(connection: PoolConnection, sql: string, values?: unknown[]): Promise<unknown[][]> {
  const [rows] = await connection.query({ sql, values, rowsAsArray: true });
  return rows as unknown[][];
}

function queryRows(value: unknown): unknown[][] {
  return (value as [unknown[][]])[0];
}

function assertCompleteInventory(inspection: DatabaseInspection): void {
  const expectedTables = inspection.tableRows.map((row) => ({
    name: String(row[0]), type: String(row[1]).toUpperCase() === 'VIEW' ? 'VIEW' : 'TABLE'
  }));
  assertSameSet('表/视图', expectedTables.map((item) => `${item.type}:${item.name}`), inspection.shownTables.map((item) => `${item.type}:${item.name}`));
  const expectedProcedures = inspection.routineRows.filter((row) => String(row[1]).toUpperCase() === 'PROCEDURE').map((row) => String(row[0]));
  const expectedFunctions = inspection.routineRows.filter((row) => String(row[1]).toUpperCase() === 'FUNCTION').map((row) => String(row[0]));
  assertSameSet('存储过程', expectedProcedures, inspection.shownProcedures);
  assertSameSet('函数', expectedFunctions, inspection.shownFunctions);
  assertSameSet('事件', inspection.eventRows.map((row) => String(row[0])), inspection.shownEvents);
  assertSameSet('触发器', inspection.triggerRows.map((row) => String(row[0])), inspection.shownTriggers);
  const hiddenRoutine = inspection.routineRows.find((row) => row[3] === null || row[3] === undefined);
  if (hiddenRoutine) {
    throw new DatabaseMaintenanceError(`无法读取例程 ${String(hiddenRoutine[0])} 的定义，影响分析不完整。`, 'impact-incomplete');
  }
  const views = inspection.structureRows.find((item) => item.source === 'views')?.rows ?? [];
  const hiddenView = views.find((row) => row[1] === null || row[1] === undefined);
  if (hiddenView) {
    throw new DatabaseMaintenanceError(`无法读取视图 ${String(hiddenView[0])} 的定义，影响分析不完整。`, 'impact-incomplete');
  }
}

function assertSameSet(label: string, expected: string[], actual: string[]): void {
  const left = [...new Set(expected)].sort();
  const right = [...new Set(actual)].sort();
  if (JSON.stringify(left) !== JSON.stringify(right)) {
    throw new DatabaseMaintenanceError(
      `${label}清单交叉核对不一致（information_schema=${left.length}，SHOW=${right.length}）。`,
      'impact-incomplete'
    );
  }
}

function buildObjectImpacts(inspection: DatabaseInspection): DatabaseObjectImpact[] {
  const objects: DatabaseObjectImpact[] = inspection.tableRows.map((row) => ({
    name: String(row[0]),
    type: String(row[1]).toUpperCase() === 'VIEW' ? 'VIEW' : 'TABLE',
    engine: optionalString(row[2]),
    estimatedRows: optionalNumber(row[3]),
    dataBytes: optionalNumber(row[4]),
    indexBytes: optionalNumber(row[5]),
    detail: optionalString(row[7])
  }));
  for (const row of inspection.routineRows) {
    objects.push({ name: String(row[0]), type: String(row[1]).toUpperCase() === 'FUNCTION' ? 'FUNCTION' : 'PROCEDURE', detail: optionalString(row[2]) });
  }
  for (const row of inspection.eventRows) objects.push({ name: String(row[0]), type: 'EVENT', detail: optionalString(row[6]) });
  for (const row of inspection.triggerRows) objects.push({ name: String(row[0]), type: 'TRIGGER', detail: `${String(row[6])} ${String(row[1])} ON ${String(row[2])}` });
  return objects.sort((left, right) => left.type.localeCompare(right.type) || left.name.localeCompare(right.name));
}

function summarizeObjects(objects: DatabaseObjectImpact[]): SqlObjectSummary {
  return {
    tables: objects.filter((item) => item.type === 'TABLE').length,
    views: objects.filter((item) => item.type === 'VIEW').length,
    routines: objects.filter((item) => item.type === 'PROCEDURE' || item.type === 'FUNCTION').length,
    events: objects.filter((item) => item.type === 'EVENT').length,
    triggers: objects.filter((item) => item.type === 'TRIGGER').length
  };
}

function fingerprintInspection(inspection: DatabaseInspection): string {
  return sha256(JSON.stringify({
    schema: inspection.schemaRow,
    createDatabase: inspection.createDatabase,
    tables: normalizeRows(inspection.tableRows.map((row) => [row[0], row[1], row[2], row[7], row[8]])),
    routines: normalizeRows(inspection.routineRows),
    events: normalizeRows(inspection.eventRows),
    triggers: normalizeRows(inspection.triggerRows),
    structures: inspection.structureRows.map((item) => ({ source: item.source, rows: normalizeRows(item.rows) })),
    inbound: inspection.externalInboundDependencies,
    outbound: inspection.externalOutboundForeignKeys
  }));
}

function normalizeRows(rows: unknown[][]): Array<Array<string | null>> {
  return rows.map((row) => row.map((value) => value === null || value === undefined
    ? null
    : value instanceof Date ? value.toISOString() : Buffer.isBuffer(value) ? value.toString('hex') : String(value)));
}

function findMissingAnalysisPrivileges(grants: readonly string[], database: string): string[] {
  const targetAvailable = new Set<string>();
  const globalAvailable = new Set<string>();
  for (const grant of grants) {
    const match = /^GRANT\s+(.+?)\s+ON\s+(.+?)\s+TO\s+/i.exec(grant);
    if (!match?.[1] || !match[2]) continue;
    const privileges = match[1].split(',').map((item) => item.trim().toUpperCase());
    if (match[2].trim() === '*.*') {
      for (const privilege of privileges) {
        globalAvailable.add(privilege);
        targetAvailable.add(privilege);
      }
    } else if (databaseWildcardScopeMatches(match[2], database)) {
      for (const privilege of privileges) targetAvailable.add(privilege);
    }
  }
  const targetAll = targetAvailable.has('ALL') || targetAvailable.has('ALL PRIVILEGES');
  const globalAll = globalAvailable.has('ALL') || globalAvailable.has('ALL PRIVILEGES');
  const missing: string[] = targetAll
    ? []
    : REQUIRED_ANALYSIS_PRIVILEGES.filter((privilege) => !targetAvailable.has(privilege));
  if (!globalAll && !globalAvailable.has('SELECT')) missing.push('GLOBAL SELECT');
  if (!globalAll && !globalAvailable.has('SHOW VIEW')) missing.push('GLOBAL SHOW VIEW');
  return missing;
}

function databaseWildcardScopeMatches(scope: string, database: string): boolean {
  const normalized = scope.trim();
  if (normalized === '*.*') return true;
  const separator = normalized.lastIndexOf('.');
  if (separator < 0 || unquoteGrantIdentifier(normalized.slice(separator + 1)) !== '*') return false;
  return grantPatternMatches(unquoteGrantIdentifier(normalized.slice(0, separator)), database);
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

function mapDropDatabaseError(error: unknown, statementStarted: boolean, database: string): DatabaseMaintenanceError {
  if (error instanceof DatabaseMaintenanceError) return error;
  const mysqlError = error as NodeJS.ErrnoException;
  const code = mysqlError.code ?? '';
  if (['ER_DBACCESS_DENIED_ERROR', 'ER_ACCESS_DENIED_ERROR', 'ER_SPECIFIC_ACCESS_DENIED_ERROR'].includes(code)) {
    return new DatabaseMaintenanceError(`DROP DATABASE ${database} 权限不足；未绕过权限限制。`, 'permission', false, { cause: error });
  }
  if (['ER_BAD_DB_ERROR', 'ER_DB_DROP_EXISTS'].includes(code)) {
    return new DatabaseMaintenanceError(`数据库 ${database} 在执行前已不存在。`, 'conflict', false, { cause: error });
  }
  if (statementStarted && isConnectionOutcomeUnknown(code)) {
    return new DatabaseMaintenanceError(
      `DROP DATABASE ${database} 期间连接中断，结果未知。请刷新对象树并直接检查数据库；不要自动重试。`,
      'unknown-result', true, { cause: error }
    );
  }
  if (statementStarted) {
    return new DatabaseMaintenanceError(
      `DROP DATABASE ${database} 已开始后服务器返回失败，数据库可能只删除了部分对象，结果未知。请刷新并直接核对目标库；不要自动重试或自动恢复。`,
      'unknown-result', true, { cause: error }
    );
  }
  return new DatabaseMaintenanceError(
    `DROP DATABASE ${database} 失败：${error instanceof Error ? error.message : String(error)}`,
    'execution', false, { cause: error }
  );
}

function isConnectionOutcomeUnknown(code: string): boolean {
  return ['PROTOCOL_CONNECTION_LOST', 'ECONNRESET', 'ETIMEDOUT', 'PROTOCOL_SEQUENCE_TIMEOUT', 'EPIPE', 'ECONNABORTED'].includes(code);
}

function validateDatabaseName(database: string): void {
  if (!database || database.length > 64 || database.includes('\0') || /[\r\n]/.test(database)) {
    throw new DatabaseMaintenanceError('数据库名称无效。', 'validation');
  }
}

function sameObjectSummary(left: SqlObjectSummary, right: SqlObjectSummary): boolean {
  return (Object.keys(left) as Array<keyof SqlObjectSummary>).every((key) => left[key] === right[key]);
}

function formatSummary(value: SqlObjectSummary): string {
  return `表 ${value.tables}、视图 ${value.views}、例程 ${value.routines}、事件 ${value.events}、触发器 ${value.triggers}`;
}

function normalizeShownTableType(value: unknown): string {
  return String(value).toUpperCase() === 'VIEW' ? 'VIEW' : 'TABLE';
}

function formatDependency(value: ExternalDatabaseDependency): string {
  return `${value.kind} ${value.schema}.${value.object}（${value.name}）`;
}

function optionalString(value: unknown): string | undefined {
  return value === null || value === undefined ? undefined : String(value);
}

function optionalNumber(value: unknown): number | undefined {
  if (value === null || value === undefined) return undefined;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : undefined;
}

function sum(objects: DatabaseObjectImpact[], key: 'estimatedRows' | 'dataBytes' | 'indexBytes'): number {
  return objects.reduce((total, item) => total + (item[key] ?? 0), 0);
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
