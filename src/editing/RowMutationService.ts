import type { ResultSetHeader } from 'mysql2';
import type { ConnectionManager } from '../connection/ConnectionManager.js';
import { formatQueryCell } from '../query/QueryService.js';
import { escapeIdentifier } from '../query/sqlGuards.js';
import { validateInsertRow, validateRowChanges } from './EditValidator.js';
import { metadataSignature, selectRowLocator } from './RowLocatorService.js';
import type { ColumnMetadata, RowSnapshot } from './types.js';
import type { TableMetadataRepository } from './TableMetadataRepository.js';

export class RowEditError extends Error {
  public constructor(
    message: string,
    public readonly fieldErrors?: Record<string, string>,
    public readonly conflict = false
  ) {
    super(message);
    this.name = 'RowEditError';
  }
}

export class RowMutationService {
  public constructor(
    private readonly connections: ConnectionManager,
    private readonly metadata: TableMetadataRepository,
    private readonly timeoutMs: number
  ) {}

  public async update(
    connectionId: string,
    snapshot: RowSnapshot,
    changes: unknown
  ): Promise<Array<string | null>> {
    const [result] = await this.updateBatch(connectionId, [{ snapshot, changes }]);
    if (!result) throw new RowEditError('保存后未返回行数据，已拒绝保存。', undefined, true);
    return result;
  }

  public async updateBatch(
    connectionId: string,
    edits: Array<{ snapshot: RowSnapshot; changes: unknown }>
  ): Promise<Array<Array<string | null>>> {
    if (edits.length < 1 || edits.length > 50) {
      throw new RowEditError('一次只能提交 1–50 行草稿。');
    }
    const first = edits[0]?.snapshot;
    if (!first || edits.some(({ snapshot }) => snapshot.database !== first.database || snapshot.table !== first.table)) {
      throw new RowEditError('批量提交只能包含同一数据库、同一表的行。', undefined, true);
    }
    const fieldCount = edits.reduce((count, edit) => count
      + (isRecord(edit.changes) ? Object.keys(edit.changes).length : 0), 0);
    if (fieldCount < 1 || fieldCount > 200) {
      throw new RowEditError('一次只能提交 1–200 个字段草稿。');
    }

    const currentMetadata = await this.metadata.get(connectionId, first.database, first.table);
    const currentLocator = selectRowLocator(currentMetadata, first.columnNames);
    if (!currentLocator
      || metadataSignature(currentMetadata, currentLocator) !== first.metadataSignature
      || edits.some(({ snapshot }) => snapshot.metadataSignature !== first.metadataSignature
        || snapshot.columnNames.join('\u0000') !== first.columnNames.join('\u0000'))) {
      throw new RowEditError('表结构或可靠定位键已变化，请重新加载后再编辑。', undefined, true);
    }
    const prepared = edits.map(({ snapshot, changes }) => {
      const validation = validateRowChanges(changes, currentMetadata, currentLocator);
      if (!validation.values) {
        throw new RowEditError('请修正字段后重试。', validation.errors);
      }
      return { snapshot, values: validation.values };
    });
    const seenLocators = new Set<string>();
    const columnMap = new Map(currentMetadata.columns.map((column) => [column.name, column]));
    const ordered = prepared.map((item) => {
      const locatorValues = locatorDatabaseValues(item.snapshot, currentLocator.columns, columnMap);
      const sortKey = JSON.stringify(locatorValues.map((value) => Buffer.isBuffer(value)
        ? `buffer:${value.toString('hex')}`
        : value));
      if (seenLocators.has(sortKey)) throw new RowEditError('批量提交包含重复定位行，已拒绝执行。', undefined, true);
      seenLocators.add(sortKey);
      return { ...item, locatorValues, sortKey };
    }).sort((left, right) => left.sortKey.localeCompare(right.sortKey));

    return this.connections.withConnection(connectionId, async (connection) => {
      let transactionStarted = false;
      let committing = false;
      try {
        await connection.beginTransaction();
        transactionStarted = true;

        for (const item of ordered) {
          const [lockedRows] = await connection.query({
            sql: buildSelectForUpdateSql(item.snapshot),
            values: item.locatorValues,
            timeout: this.timeoutMs,
            rowsAsArray: true
          });
          const rows = lockedRows as unknown[][];
          if (rows.length !== 1) {
            throw new RowEditError(
              rows.length === 0 ? '批量提交中的一行已被删除，全部草稿已回滚。' : '定位键匹配到多行，全部草稿已回滚。',
              undefined,
              true
            );
          }
          const currentValues = (rows[0] ?? []).map(formatQueryCell);
          if (!sameRow(currentValues, item.snapshot.values)) {
            throw new RowEditError('批量提交中的数据已被其他会话修改，全部草稿已回滚。', undefined, true);
          }
        }

        for (const item of ordered) {
          const entries = Object.entries(item.values);
          const updateSql = `UPDATE ${qualifiedName(item.snapshot.database, item.snapshot.table)} SET ${entries
            .map(([name]) => `${escapeIdentifier(name)} = ?`).join(', ')} WHERE ${buildLocatorWhere(currentLocator.columns)}`;
          const updateValues = entries.map(([name, value]) => toDatabaseValue(value, columnMap.get(name)));
          const [header] = await connection.query({
            sql: updateSql,
            values: [...updateValues, ...item.locatorValues],
            timeout: this.timeoutMs
          });
          const affectedRows = (header as ResultSetHeader).affectedRows ?? 0;
          if (affectedRows > 1) {
            throw new RowEditError('更新影响超过一行，全部草稿已回滚。', undefined, true);
          }
        }

        const reloadedBySnapshot = new Map<RowSnapshot, Array<string | null>>();
        for (const item of ordered) {
          const [reloadedRows] = await connection.query({
            sql: buildReloadSql(item.snapshot),
            values: item.locatorValues,
            timeout: this.timeoutMs,
            rowsAsArray: true
          });
          const rows = reloadedRows as unknown[][];
          if (rows.length !== 1) {
            throw new RowEditError('保存后无法唯一重读批量提交中的行，全部草稿已回滚。', undefined, true);
          }
          reloadedBySnapshot.set(item.snapshot, (rows[0] ?? []).map(formatQueryCell));
        }
        committing = true;
        await connection.commit();
        transactionStarted = false;
        return edits.map(({ snapshot }) => reloadedBySnapshot.get(snapshot) ?? []);
      } catch (error) {
        if (transactionStarted && !committing) await connection.rollback().catch(() => undefined);
        if (error instanceof RowEditError) throw error;
        if (committing) {
          throw new RowEditError('批量提交期间连接中断，结果未知，请立即重新加载核对。', undefined, true);
        }
        throw mapMysqlError(error, 'save');
      }
    });
  }

  private async updateLegacy(
    connectionId: string,
    snapshot: RowSnapshot,
    changes: unknown
  ): Promise<Array<string | null>> {
    const currentMetadata = await this.metadata.get(connectionId, snapshot.database, snapshot.table);
    const currentLocator = selectRowLocator(currentMetadata, snapshot.columnNames);
    if (!currentLocator
      || metadataSignature(currentMetadata, currentLocator) !== snapshot.metadataSignature) {
      throw new RowEditError('表结构或可靠定位键已变化，请重新加载后再编辑。', undefined, true);
    }
    const validation = validateRowChanges(changes, currentMetadata, currentLocator);
    if (!validation.values) {
      throw new RowEditError('请修正字段后重试。', validation.errors);
    }
    const validatedValues = validation.values;

    const columnMap = new Map(currentMetadata.columns.map((column) => [column.name, column]));
    const locatorValues = currentLocator.columns.map((columnName) => {
      const index = snapshot.columnNames.indexOf(columnName);
      if (index < 0) throw new RowEditError('定位键不在当前结果中，请重新加载。', undefined, true);
      const value = snapshot.values[index];
      if (value === null || value === undefined) {
        throw new RowEditError('该行的唯一键包含 NULL，无法可靠定位。', undefined, true);
      }
      return toDatabaseValue(value, columnMap.get(columnName));
    });

    return this.connections.withConnection(connectionId, async (connection) => {
      let transactionStarted = false;
      let committing = false;
      try {
        await connection.beginTransaction();
        transactionStarted = true;
        const selectSql = buildSelectForUpdateSql(snapshot);
        const [lockedRows] = await connection.query({
          sql: selectSql,
          values: locatorValues,
          timeout: this.timeoutMs,
          rowsAsArray: true
        });
        const rows = lockedRows as unknown[][];
        if (rows.length !== 1) {
          throw new RowEditError(
            rows.length === 0 ? '该行已被删除，请重新加载。' : '定位键匹配到多行，已拒绝保存。',
            undefined,
            true
          );
        }
        const currentValues = (rows[0] ?? []).map(formatQueryCell);
        if (!sameRow(currentValues, snapshot.values)) {
          throw new RowEditError('数据已被其他会话修改，请重新加载后比较差异。', undefined, true);
        }

        const entries = Object.entries(validatedValues);
        const updateSql = `UPDATE ${qualifiedName(snapshot.database, snapshot.table)} SET ${entries
          .map(([name]) => `${escapeIdentifier(name)} = ?`).join(', ')} WHERE ${buildLocatorWhere(currentLocator.columns)}`;
        const updateValues = entries.map(([name, value]) => toDatabaseValue(value, columnMap.get(name)));
        const [header] = await connection.query({
          sql: updateSql,
          values: [...updateValues, ...locatorValues],
          timeout: this.timeoutMs
        });
        const affectedRows = (header as ResultSetHeader).affectedRows ?? 0;
        if (affectedRows > 1) {
          throw new RowEditError('更新影响超过一行，已回滚。', undefined, true);
        }

        const [reloadedRows] = await connection.query({
          sql: buildReloadSql(snapshot),
          values: locatorValues,
          timeout: this.timeoutMs,
          rowsAsArray: true
        });
        const reloaded = reloadedRows as unknown[][];
        if (reloaded.length !== 1) {
          throw new RowEditError('保存后无法唯一重读该行，已回滚。', undefined, true);
        }
        const result = (reloaded[0] ?? []).map(formatQueryCell);
        committing = true;
        await connection.commit();
        transactionStarted = false;
        return result;
      } catch (error) {
        if (transactionStarted && !committing) await connection.rollback().catch(() => undefined);
        if (error instanceof RowEditError) throw error;
        if (committing) {
          throw new RowEditError('提交期间连接中断，保存状态未知，请立即重新加载核对。', undefined, true);
        }
        throw mapMysqlError(error, 'save');
      }
    });
  }

  public async delete(connectionId: string, snapshot: RowSnapshot): Promise<void> {
    await this.deleteBatch(connectionId, [snapshot]);
  }

  public async deleteBatch(connectionId: string, snapshots: RowSnapshot[]): Promise<number> {
    if (snapshots.length < 1 || snapshots.length > 1000) {
      throw new RowEditError('一次只能删除 1–1000 行。');
    }
    const first = snapshots[0];
    if (!first || snapshots.some((s) => s.database !== first.database || s.table !== first.table)) {
      throw new RowEditError('批量删除只能包含同一数据库、同一表的行。', undefined, true);
    }
    const currentMetadata = await this.metadata.get(connectionId, first.database, first.table);
    const currentLocator = selectRowLocator(currentMetadata, first.columnNames);
    if (!currentLocator
      || metadataSignature(currentMetadata, currentLocator) !== first.metadataSignature
      || snapshots.some((s) => s.metadataSignature !== first.metadataSignature
        || s.columnNames.join('\u0000') !== first.columnNames.join('\u0000'))) {
      throw new RowEditError('表结构或可靠定位键已变化，请重新加载后再删除。', undefined, true);
    }
    const columnMap = new Map(currentMetadata.columns.map((column) => [column.name, column]));
    const seenLocators = new Set<string>();
    const ordered = snapshots.map((snapshot) => {
      const locatorValues = currentLocator.columns.map((columnName) => {
        const index = snapshot.columnNames.indexOf(columnName);
        if (index < 0) throw new RowEditError('定位键不在当前结果中，请重新加载。', undefined, true);
        const value = snapshot.values[index];
        if (value === null || value === undefined) {
          throw new RowEditError('该行的唯一键包含 NULL，无法可靠定位。', undefined, true);
        }
        return toDatabaseValue(value, columnMap.get(columnName));
      });
      const sortKey = JSON.stringify(locatorValues.map((v) => Buffer.isBuffer(v) ? `buffer:${v.toString('hex')}` : v));
      if (seenLocators.has(sortKey)) {
        throw new RowEditError('批量删除包含重复定位行，已拒绝执行。', undefined, true);
      }
      seenLocators.add(sortKey);
      return { snapshot, locatorValues, sortKey };
    }).sort((left, right) => left.sortKey.localeCompare(right.sortKey));

    return this.connections.withConnection(connectionId, async (connection) => {
      let transactionStarted = false;
      let committing = false;
      try {
        await connection.beginTransaction();
        transactionStarted = true;
        for (const item of ordered) {
          const [lockedRows] = await connection.query({
            sql: buildSelectForUpdateSql(item.snapshot),
            values: item.locatorValues,
            timeout: this.timeoutMs,
            rowsAsArray: true
          });
          const rows = lockedRows as unknown[][];
          if (rows.length !== 1) {
            throw new RowEditError(
              rows.length === 0 ? '该行已被删除，请重新加载。' : '定位键匹配到多行，已拒绝删除。',
              undefined,
              true
            );
          }
          const currentValues = (rows[0] ?? []).map(formatQueryCell);
          if (!sameRow(currentValues, item.snapshot.values)) {
            throw new RowEditError('数据已被其他会话修改，请重新加载后比较差异。', undefined, true);
          }
        }

        let totalDeleted = 0;
        for (const item of ordered) {
          const [header] = await connection.query({
            sql: `DELETE FROM ${qualifiedName(item.snapshot.database, item.snapshot.table)} WHERE ${buildLocatorWhere(currentLocator.columns)}`,
            values: item.locatorValues,
            timeout: this.timeoutMs
          });
          const affectedRows = (header as ResultSetHeader).affectedRows ?? 0;
          if (affectedRows !== 1) {
            throw new RowEditError('删除未精确影响一行，已回滚。', undefined, true);
          }
          totalDeleted += affectedRows;
        }
        committing = true;
        await connection.commit();
        transactionStarted = false;
        return totalDeleted;
      } catch (error) {
        if (transactionStarted && !committing) await connection.rollback().catch(() => undefined);
        if (error instanceof RowEditError) throw error;
        if (committing) {
          throw new RowEditError('删除提交期间连接中断，结果未知，请立即重新加载核对。', undefined, true);
        }
        throw mapMysqlError(error, 'delete');
      }
    });
  }

  public async insertRow(
    connectionId: string,
    database: string,
    table: string,
    changes: unknown
  ): Promise<number> {
    const currentMetadata = await this.metadata.get(connectionId, database, table);
    const validation = validateInsertRow(changes, currentMetadata.columns);
    if (!validation.values || Object.keys(validation.errors).length > 0) {
      throw new RowEditError(
        validation.errors.form || '插入字段校验失败。',
        validation.errors
      );
    }
    const entries = Object.entries(validation.values);
    if (entries.length === 0) {
      throw new RowEditError('未提供有效的字段值。');
    }

    const columnMap = new Map(currentMetadata.columns.map((column) => [column.name, column]));
    const colNames = entries.map(([name]) => escapeIdentifier(name)).join(', ');
    const placeholders = entries.map(() => '?').join(', ');
    const insertValues = entries.map(([name, value]) => toDatabaseValue(value, columnMap.get(name)));
    const insertSql = `INSERT INTO ${qualifiedName(database, table)} (${colNames}) VALUES (${placeholders});`;

    return this.connections.withConnection(connectionId, async (connection) => {
      let transactionStarted = false;
      let committing = false;
      try {
        await connection.beginTransaction();
        transactionStarted = true;
        const [header] = await connection.query({
          sql: insertSql,
          values: insertValues,
          timeout: this.timeoutMs
        });
        const affectedRows = (header as ResultSetHeader).affectedRows ?? 0;
        committing = true;
        await connection.commit();
        transactionStarted = false;
        return affectedRows;
      } catch (error) {
        if (transactionStarted && !committing) await connection.rollback().catch(() => undefined);
        if (error instanceof RowEditError) throw error;
        if (committing) {
          throw new RowEditError('插入提交期间连接中断，状态未知，请立即重新加载核对。', undefined, true);
        }
        throw mapMysqlError(error, 'save');
      }
    });
  }
}

function buildSelectForUpdateSql(snapshot: RowSnapshot): string {
  return `SELECT ${snapshot.columnNames.map(escapeIdentifier).join(', ')} FROM ${qualifiedName(snapshot.database, snapshot.table)} WHERE ${buildLocatorWhere(snapshot.locator.columns)} FOR UPDATE`;
}

function buildReloadSql(snapshot: RowSnapshot): string {
  return `SELECT ${snapshot.columnNames.map(escapeIdentifier).join(', ')} FROM ${qualifiedName(snapshot.database, snapshot.table)} WHERE ${buildLocatorWhere(snapshot.locator.columns)}`;
}

function buildLocatorWhere(columns: string[]): string {
  return columns.map((column) => `${escapeIdentifier(column)} = ?`).join(' AND ');
}

function qualifiedName(database: string, table: string): string {
  return `${escapeIdentifier(database)}.${escapeIdentifier(table)}`;
}

function sameRow(current: Array<string | null>, original: Array<string | null>): boolean {
  return current.length === original.length && current.every((value, index) => value === original[index]);
}

function locatorDatabaseValues(
  snapshot: RowSnapshot,
  locatorColumns: readonly string[],
  columnMap: ReadonlyMap<string, ColumnMetadata>
): Array<string | Buffer> {
  return locatorColumns.map((columnName) => {
    const index = snapshot.columnNames.indexOf(columnName);
    if (index < 0) throw new RowEditError('定位键不在当前结果中，请重新加载。', undefined, true);
    const value = snapshot.values[index];
    if (value === null || value === undefined) {
      throw new RowEditError('该行的唯一键包含 NULL，无法可靠定位。', undefined, true);
    }
    return toDatabaseValue(value, columnMap.get(columnName)) ?? '';
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toDatabaseValue(value: string | null, column?: ColumnMetadata): string | Buffer | null {
  if (value === null) return null;
  if (column && ['bit', 'binary', 'varbinary', 'tinyblob', 'blob', 'mediumblob', 'longblob'].includes(column.dataType)
    && /^0x[0-9a-f]*$/i.test(value)
    && value.length % 2 === 0) {
    return Buffer.from(value.slice(2), 'hex');
  }
  return value;
}

function mapMysqlError(error: unknown, operation: 'save' | 'delete'): RowEditError {
  const code = typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code)
    : '';
  const saveMessages: Record<string, string> = {
    ER_DUP_ENTRY: '保存失败：值与唯一约束冲突。',
    ER_BAD_NULL_ERROR: '保存失败：必填字段不能为 NULL。',
    ER_NO_DEFAULT_FOR_FIELD: '保存失败：缺少必填字段。',
    ER_DATA_TOO_LONG: '保存失败：字段内容超过数据库长度限制。',
    WARN_DATA_TRUNCATED: '保存失败：字段格式或长度不符合数据库约束。',
    ER_TRUNCATED_WRONG_VALUE: '保存失败：字段值格式不正确。',
    ER_CHECK_CONSTRAINT_VIOLATED: '保存失败：字段值不满足 CHECK 约束。',
    ER_ROW_IS_REFERENCED: '保存失败：该行被外键引用。',
    ER_ROW_IS_REFERENCED_2: '保存失败：该行被外键引用。',
    ER_NO_REFERENCED_ROW_2: '保存失败：外键引用的记录不存在。',
    ER_TABLEACCESS_DENIED_ERROR: '保存失败：当前账号没有该表的 UPDATE 权限。',
    ER_DBACCESS_DENIED_ERROR: '保存失败：当前账号没有该数据库的写入权限。',
    ER_LOCK_DEADLOCK: '保存因死锁回滚，请重新加载后再试。',
    ER_LOCK_WAIT_TIMEOUT: '保存因锁等待超时回滚，请稍后重试。'
  };
  const deleteMessages: Record<string, string> = {
    ER_ROW_IS_REFERENCED: '删除失败：该行仍被外键引用。',
    ER_ROW_IS_REFERENCED_2: '删除失败：该行仍被外键引用。',
    ER_TABLEACCESS_DENIED_ERROR: '删除失败：当前账号没有该表的 DELETE 权限。',
    ER_COLUMNACCESS_DENIED_ERROR: '删除失败：当前账号缺少所需字段权限。',
    ER_DBACCESS_DENIED_ERROR: '删除失败：当前账号没有该数据库的写入权限。',
    ER_SPECIFIC_ACCESS_DENIED_ERROR: '删除失败：当前账号缺少 DELETE 权限。',
    ER_ACCESS_DENIED_ERROR: '删除失败：数据库拒绝了当前账号的权限。',
    ER_LOCK_DEADLOCK: '删除因死锁回滚，请重新加载后再试。',
    ER_LOCK_WAIT_TIMEOUT: '删除因锁等待超时回滚，请稍后重试。'
  };
  if (operation === 'delete' && ['ER_ROW_IS_REFERENCED', 'ER_ROW_IS_REFERENCED_2'].includes(code)) {
    return new RowEditError(describeForeignKeyReference(error));
  }
  const message = operation === 'delete'
    ? deleteMessages[code] ?? '删除失败，请查看 Rinda MySQL 输出获取已脱敏诊断。'
    : saveMessages[code] ?? '保存失败，请查看 Rinda MySQL 输出获取已脱敏诊断。';
  return new RowEditError(message);
}

function describeForeignKeyReference(error: unknown): string {
  const rawMessage = error instanceof Error ? error.message : '';
  const match = /constraint fails \(`([^`]*)`\.`([^`]*)`, CONSTRAINT `([^`]*)`/i.exec(rawMessage);
  if (!match) return '删除失败：该行仍被外键引用。';
  const database = safeIdentifierLabel(match[1]);
  const table = safeIdentifierLabel(match[2]);
  const constraint = safeIdentifierLabel(match[3]);
  return `删除失败：该行仍被 ${database}.${table} 的外键 ${constraint} 引用。`;
}

function safeIdentifierLabel(value: string | undefined): string {
  return (value ?? '').replace(/[\u0000-\u001f\u007f]/g, '�').slice(0, 128);
}
