import { randomBytes } from 'node:crypto';
import type { QueryService } from '../query/QueryService.js';
import { columnReadOnlyReason, isColumnEditable, metadataSignature, selectRowLocator } from './RowLocatorService.js';
import { RowEditError } from './RowMutationService.js';
import type { RowMutationService } from './RowMutationService.js';
import type {
  BatchEditOutcome,
  BatchEditRequest,
  BatchRowDeleteRequest,
  EditColumnView,
  EditableTablePage,
  RowDeleteRequest,
  RowEditOutcome,
  RowSnapshot
} from './types.js';
import type { TableMetadataRepository } from './TableMetadataRepository.js';

const OPERATION_ID = /^[A-Za-z0-9_-]{8,128}$/;
const MULTILINE_TYPES = new Set(['tinytext', 'text', 'mediumtext', 'longtext', 'json']);

export class TableEditingService {
  public constructor(
    private readonly query: QueryService,
    private readonly metadata: TableMetadataRepository,
    private readonly mutations: RowMutationService
  ) {}

  public async loadPage(
    connectionId: string,
    database: string,
    table: string,
    page: number,
    pageSize: number,
    customSql?: string
  ): Promise<EditableTablePage> {
    const fetchResult = customSql && customSql.trim()
      ? this.query.executeTableQuery(connectionId, database, customSql, page, pageSize)
      : this.query.previewTable(connectionId, database, table, page, pageSize);

    const [result, metadata] = await Promise.all([
      fetchResult,
      this.metadata.get(connectionId, database, table).catch(() => null)
    ]);
    const locator = metadata ? selectRowLocator(metadata, result.columns) : undefined;

    const columnMap = new Map((metadata?.columns ?? []).map((column) => [column.name, column]));
    const columns: EditColumnView[] = result.columns.map((name) => {
      const column = columnMap.get(name);
      if (!column) {
        return {
          name,
          dataType: 'unknown',
          columnType: 'unknown',
          nullable: true,
          editable: false,
          multiline: false,
          readOnlyReason: '无法读取字段元数据'
        };
      }
      return {
        name,
        dataType: column.dataType,
        columnType: column.columnType,
        nullable: column.nullable,
        editable: isColumnEditable(column, locator),
        autoIncrement: column.extra.includes('auto_increment'),
        multiline: MULTILINE_TYPES.has(column.dataType)
          || (column.characterMaximumLength ?? 0) > 255,
        maximumLength: column.characterMaximumLength,
        readOnlyReason: columnReadOnlyReason(column, locator)
      };
    });

    const editableColumns = columns.filter((column) => column.editable);
    const tableReason = locator
      ? undefined
      : '表缺少可用于可靠定位的完整主键或唯一键，已降级为只读。';
    const editReason = locator && editableColumns.length === 0
      ? '当前结果没有可编辑的非键、非生成、非 BLOB 字段。'
      : undefined;
    const signature = locator && metadata ? metadataSignature(metadata, locator) : undefined;
    const snapshots = new Map<string, RowSnapshot>();
    const rows = result.rows.map((values) => {
      if (!locator || !signature) return { readOnlyReason: tableReason };
      const hasNullableLocatorValue = locator.columns.some((name) => {
        const index = result.columns.indexOf(name);
        return index < 0 || values[index] === null;
      });
      if (hasNullableLocatorValue) {
        return { readOnlyReason: '该行的唯一键包含 NULL，无法可靠定位。' };
      }
      const token = randomBytes(18).toString('base64url');
      snapshots.set(token, {
        database,
        table,
        columnNames: [...result.columns],
        values: [...values],
        locator,
        metadataSignature: signature
      });
      return {
        token,
        locatorValues: locator.columns.map((name) => ({
          name,
          value: values[result.columns.indexOf(name)] ?? ''
        }))
      };
    });
    const usedOperations = new Set<string>();
    const mutationService = this.mutations;

    return {
      result,
      editing: {
        sessionId: randomBytes(18).toString('base64url'),
        database,
        table,
        enabled: Boolean(locator && editableColumns.length > 0),
        deletionEnabled: Boolean(locator),
        reason: tableReason,
        editReason,
        locatorLabel: locator
          ? `${locator.kind === 'primary' ? 'PRIMARY KEY' : `UNIQUE ${locator.indexName}`} (${locator.columns.join(', ')})`
          : undefined,
        columns,
        rows
      },
      updateRow: async (request): Promise<RowEditOutcome> => {
        const outcome = await updateRows({
          operationId: request.operationId,
          edits: [{ token: request.token, changes: request.changes }]
        });
        return {
          ok: outcome.ok,
          message: outcome.message,
          fieldErrors: outcome.fieldErrors,
          conflict: outcome.conflict
        };
      },
      updateRows,
      deleteRow: async (request: RowDeleteRequest): Promise<RowEditOutcome> => {
        const tokens = request.tokens ?? (request.token ? [request.token] : []);
        return deleteRows({
          tokens,
          operationId: request.operationId,
          confirmation: request.confirmation
        });
      },
      deleteRows,
      insertRow: async (request: { operationId: string; values: Record<string, unknown> }): Promise<RowEditOutcome> => {
        if (!OPERATION_ID.test(request.operationId) || usedOperations.has(request.operationId)) {
          return { ok: false, message: '插入请求无效或已处理。' };
        }
        if (!request.values || typeof request.values !== 'object') {
          return { ok: false, message: '插入数据无效。' };
        }
        usedOperations.add(request.operationId);
        try {
          const affected = await this.mutations.insertRow(connectionId, database, table, request.values);
          return { ok: true, message: `成功插入 ${affected} 行记录。`, affectedRows: affected };
        } catch (error) {
          if (error instanceof RowEditError) {
            return {
              ok: false,
              message: error.message,
              fieldErrors: error.fieldErrors,
              conflict: error.conflict
            };
          }
          return { ok: false, message: error instanceof Error ? error.message : '插入记录失败。' };
        }
      }
    };

    async function deleteRows(request: BatchRowDeleteRequest): Promise<RowEditOutcome> {
      if (request.confirmation !== 'DELETE') {
        return { ok: false, message: '删除确认无效，未执行任何操作。' };
      }
      if (!OPERATION_ID.test(request.operationId) || usedOperations.has(request.operationId)) {
        return { ok: false, message: '删除请求无效或已处理，请重新打开确认面板。' };
      }
      if (!Array.isArray(request.tokens) || request.tokens.length < 1 || request.tokens.length > 1000) {
        return { ok: false, message: '一次只能删除 1–1000 行。' };
      }
      if (new Set(request.tokens).size !== request.tokens.length) {
        return { ok: false, message: '删除请求包含重复行，未执行任何操作。' };
      }
      const targetSnapshots: RowSnapshot[] = [];
      for (const token of request.tokens) {
        const snapshot = snapshots.get(token);
        if (!snapshot) {
          return { ok: false, message: '行删除凭证已失效，请重新加载。', conflict: true };
        }
        targetSnapshots.push(snapshot);
      }
      usedOperations.add(request.operationId);
      try {
        const count = typeof mutationService.deleteBatch === 'function'
          ? await mutationService.deleteBatch(connectionId, targetSnapshots)
          : await (async () => {
              for (const s of targetSnapshots) await mutationService.delete(connectionId, s);
              return targetSnapshots.length;
            })();
        for (const token of request.tokens) {
          snapshots.delete(token);
        }
        return {
          ok: true,
          affectedRows: count,
          message: count === 1 ? '该行已删除，正在补取当前页数据。' : `已成功删除 ${count} 行，正在补取当前页数据。`
        };
      } catch (error) {
        if (error instanceof RowEditError) {
          return { ok: false, message: error.message, conflict: error.conflict };
        }
        return { ok: false, message: '删除失败，请查看 Rinda MySQL 输出获取已脱敏诊断。' };
      }
    }

    async function updateRows(request: BatchEditRequest): Promise<BatchEditOutcome> {
      if (!OPERATION_ID.test(request.operationId) || usedOperations.has(request.operationId)) {
        return { ok: false, message: '提交请求无效或已处理，请重新加载表预览。' };
      }
      if (!Array.isArray(request.edits) || request.edits.length < 1 || request.edits.length > 50) {
        return { ok: false, message: '一次只能提交 1–50 行草稿。' };
      }
      const tokens = request.edits.map((edit) => edit.token);
      if (new Set(tokens).size !== tokens.length) {
        return { ok: false, message: '提交请求包含重复行，未执行任何写入。' };
      }
      const fieldCount = request.edits.reduce((count, edit) => count
        + (isRecord(edit.changes) ? Object.keys(edit.changes).length : 0), 0);
      if (fieldCount < 1 || fieldCount > 200) {
        return { ok: false, message: '一次只能提交 1–200 个字段草稿。' };
      }
      const items = request.edits.map((edit) => ({
        token: edit.token,
        changes: edit.changes,
        snapshot: snapshots.get(edit.token)
      }));
      if (items.some((item) => !item.snapshot)) {
        return { ok: false, message: '至少一个行编辑凭证已失效，请重新加载。', conflict: true };
      }
      usedOperations.add(request.operationId);
      try {
        const reloaded = await mutationService.updateBatch(
          connectionId,
          items.map((item) => ({ snapshot: item.snapshot as RowSnapshot, changes: item.changes }))
        );
        const reloadedRows = items.map((item, index) => {
          const values = reloaded[index] ?? [];
          (item.snapshot as RowSnapshot).values = [...values];
          return { token: item.token, values };
        });
        return {
          ok: true,
          message: `${items.length} 行、${fieldCount} 个字段已原子提交并从数据库重读。`,
          reloadedRows
        };
      } catch (error) {
        if (error instanceof RowEditError) {
          return {
            ok: false,
            message: error.message,
            fieldErrors: error.fieldErrors,
            conflict: error.conflict
          };
        }
        return { ok: false, message: '批量提交失败，事务已回滚；请查看 Rinda MySQL 输出获取已脱敏诊断。' };
      }
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
