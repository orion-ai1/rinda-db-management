import * as path from 'node:path';
import * as vscode from 'vscode';
import type {
  BatchEditOutcome,
  BatchEditRequest,
  BatchRowDeleteRequest,
  RowDeleteRequest,
  RowEditOutcome
} from '../editing/types.js';
import type { TableEditingService } from '../editing/TableEditingService.js';
import type { TableOverview } from '../explorer/metadataRepository.js';
import type { QueryResult } from '../query/QueryService.js';
import { buildTablePreviewEditorSql } from '../query/sqlGuards.js';
import { formatCsvCell } from '../transfer/CsvExportService.js';
import { SafeFileWriter } from '../transfer/SafeFileWriter.js';
import { validatePanelSql } from './queryEditorModel.js';
import {
  buildHtml,
  emptyResult,
  type RenderOptions
} from './resultPanelHtml.js';

interface ResultViewOptions {
  title: string;
  result: QueryResult;
  sql: string;
  tableOverview?: TableOverview;
  tableOverviewError?: string;
  onExecute: (sql: string) => Promise<void>;
}

interface ErrorViewOptions extends Omit<ResultViewOptions, 'result'> {
  error: string;
}

interface PanelMessage {
  type: string;
  text?: unknown;
  direction?: unknown;
  sql?: unknown;
  operationId?: unknown;
  edits?: unknown;
  values?: unknown;
  columns?: unknown;
  rows?: unknown;
  suggestedName?: unknown;
  dirty?: unknown;
  token?: unknown;
  tokens?: unknown;
  confirmation?: unknown;
}

export class ResultPanel {
  private static current: ResultPanel | undefined;
  private pageHandler: ((direction: number) => Promise<void>) | undefined;
  private executeHandler: ((sql: string) => Promise<void>) | undefined;
  private batchEditHandler: ((request: BatchEditRequest) => Promise<BatchEditOutcome>) | undefined;
  private deleteRowHandler: ((request: RowDeleteRequest) => Promise<RowEditOutcome>) | undefined;
  private deleteRowsHandler: ((request: BatchRowDeleteRequest) => Promise<RowEditOutcome>) | undefined;
  private insertRowHandler: ((request: { operationId: string; values: Record<string, unknown> }) => Promise<RowEditOutcome>) | undefined;
  private refreshHandler: (() => Promise<void>) | undefined;
  private executing = false;
  private mutating = false;
  private dirty = false;
  private baseTitle = '';

  private constructor(private readonly panel: vscode.WebviewPanel) {
    panel.onDidDispose(() => {
      if (ResultPanel.current === this) ResultPanel.current = undefined;
    });
    panel.webview.onDidReceiveMessage(async (raw: unknown) => {
      if (!isMessage(raw)) return;
      if (raw.type === 'dirtyState' && typeof raw.dirty === 'boolean') {
        this.dirty = raw.dirty;
        this.panel.title = `${raw.dirty ? '● ' : ''}${this.baseTitle}`;
        return;
      }
      if (raw.type === 'copy' && typeof raw.text === 'string' && raw.text.length <= 25_000_000) {
        await vscode.env.clipboard.writeText(raw.text);
        return;
      }
      if (raw.type === 'exportSelectionCsv') {
        try {
          const selection = parseSelectionExport(raw);
          const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
          const storageDirName = vscode.workspace.getConfiguration('rindaMysql').get<string>('storageDirectory', '.rinda') || '.rinda';
          let defaultUri = vscode.Uri.file(selection.suggestedName);
          if (workspaceFolder && workspaceFolder.uri.scheme === 'file') {
            defaultUri = vscode.Uri.file(path.join(workspaceFolder.uri.fsPath, storageDirName, 'exports', selection.suggestedName));
          }
          const uri = await vscode.window.showSaveDialog({
            title: '导出所选行为 CSV',
            defaultUri,
            filters: { CSV: ['csv'] },
            saveLabel: '导出所选行'
          });
          if (!uri) {
            await this.panel.webview.postMessage({ type: 'selectionExportState', ok: false, cancelled: true, message: '已取消导出。' });
            return;
          }
          await writeSelectionCsv(uri.fsPath, selection.columns, selection.rows);
          await this.panel.webview.postMessage({
            type: 'selectionExportState',
            ok: true,
            message: `已安全导出 ${selection.rows.length} 行到 ${uri.fsPath}`
          });
        } catch (error) {
          await this.panel.webview.postMessage({
            type: 'selectionExportState',
            ok: false,
            message: error instanceof Error ? error.message : '所选行导出失败。'
          });
        }
        return;
      }
      if (raw.type === 'page' && typeof raw.direction === 'number') {
        await this.pageHandler?.(raw.direction);
        return;
      }
      if (raw.type === 'executeSql') {
        const validation = validatePanelSql(raw.sql);
        if (!validation.sql || !this.executeHandler) {
          await this.panel.webview.postMessage({
            type: 'executionState',
            running: false,
            error: validation.error ?? '当前结果不能重新执行。'
          });
          return;
        }
        if (this.executing) return;
        this.executing = true;
        try {
          await this.executeHandler(validation.sql);
        } catch (error) {
          await this.panel.webview.postMessage({
            type: 'executionState',
            running: false,
            error: error instanceof Error ? error.message : String(error)
          });
        } finally {
          this.executing = false;
          await this.panel.webview.postMessage({ type: 'executionState', running: false });
        }
        return;
      }
      if (raw.type === 'saveBatch') {
        if (!isBatchEditMessage(raw)) return;
        if (!this.batchEditHandler) {
          await this.panel.webview.postMessage({ type: 'batchEditState', ok: false, message: '当前结果不可编辑，请重新打开单表预览。' });
          return;
        }
        if (this.mutating) {
          await this.panel.webview.postMessage({ type: 'batchEditState', ok: false, message: '上一项写操作尚未完成。' });
          return;
        }
        this.mutating = true;
        try {
          const outcome = await this.batchEditHandler({ operationId: raw.operationId, edits: raw.edits });
          if (outcome.ok) {
            this.dirty = false;
            this.panel.title = this.baseTitle;
          }
          await this.panel.webview.postMessage({ type: 'batchEditState', ...outcome });
        } catch (error) {
          await this.panel.webview.postMessage({
            type: 'batchEditState',
            ok: false,
            message: error instanceof Error ? error.message : '提交草稿异常，请重试。'
          });
        } finally {
          this.mutating = false;
        }
        return;
      }
      if (raw.type === 'deleteRow' || raw.type === 'deleteRows') {
        if (!isDeleteMessage(raw)) return;
        const handler = this.deleteRowsHandler;
        if (!handler) {
          await this.panel.webview.postMessage({ type: 'deleteRowState', ok: false, message: '当前表不可删除行。' });
          return;
        }
        if (this.mutating) {
          await this.panel.webview.postMessage({ type: 'deleteRowState', ok: false, message: '上一项写操作尚未完成。' });
          return;
        }
        this.mutating = true;
        try {
          const outcome = await handler({
            tokens: raw.tokens,
            operationId: raw.operationId,
            confirmation: raw.confirmation
          });
          await this.panel.webview.postMessage({ type: 'deleteRowState', ...outcome });
          if (outcome.ok) {
            this.dirty = false;
            this.panel.title = this.baseTitle;
            await this.refreshHandler?.();
          }
        } catch (error) {
          await this.panel.webview.postMessage({
            type: 'deleteRowState',
            ok: false,
            message: error instanceof Error ? error.message : '删除异常，请重试。'
          });
        } finally {
          this.mutating = false;
        }
        return;
      }
      if (raw.type === 'insertRow') {
        const handler = this.insertRowHandler;
        if (!handler) {
          await this.panel.webview.postMessage({ type: 'insertRowState', ok: false, message: '当前表不可插入行。' });
          return;
        }
        if (this.mutating) {
          await this.panel.webview.postMessage({ type: 'insertRowState', ok: false, message: '上一项写操作尚未完成。' });
          return;
        }
        this.mutating = true;
        try {
          const outcome = await handler({
            operationId: String(raw.operationId || ''),
            values: (raw.values && typeof raw.values === 'object') ? (raw.values as Record<string, unknown>) : {}
          });
          await this.panel.webview.postMessage({ type: 'insertRowState', ...outcome });
          if (outcome.ok) {
            this.dirty = false;
            this.panel.title = this.baseTitle;
            await this.refreshHandler?.();
          }
        } catch (error) {
          await this.panel.webview.postMessage({
            type: 'insertRowState',
            ok: false,
            message: error instanceof Error ? error.message : '插入异常，请重试。'
          });
        } finally {
          this.mutating = false;
        }
        return;
      }
      if (raw.type === 'refreshPage' && !this.mutating) {
        await this.refreshHandler?.();
      }
    });
  }

  public static showResult(options: ResultViewOptions): void {
    const instance = this.getOrCreate(options.title);
    instance.pageHandler = undefined;
    instance.executeHandler = options.onExecute;
    instance.batchEditHandler = undefined;
    instance.deleteRowHandler = undefined;
    instance.deleteRowsHandler = undefined;
    instance.insertRowHandler = undefined;
    instance.refreshHandler = async () => options.onExecute(options.sql);
    instance.render(options.result, options);
  }

  public static showError(options: ErrorViewOptions): void {
    const instance = this.getOrCreate(options.title);
    instance.pageHandler = undefined;
    instance.executeHandler = options.onExecute;
    instance.batchEditHandler = undefined;
    instance.deleteRowHandler = undefined;
    instance.deleteRowsHandler = undefined;
    instance.insertRowHandler = undefined;
    instance.refreshHandler = async () => options.onExecute(options.sql);
    instance.render(emptyResult(), options);
  }

  public static async showTablePreview(options: {
    title: string;
    connectionId: string;
    database: string;
    table: string;
    editingService: TableEditingService;
    tableOverview?: TableOverview;
    tableOverviewError?: string;
    onExecute: (sql: string) => Promise<void>;
    formatError?: (error: unknown) => Promise<string>;
    pageSize?: number;
  }): Promise<void> {
    const instance = this.getOrCreate(options.title);
    let currentSql: string | undefined = undefined;
    let page = 0;
    let loading = false;
    const pageSize = options.pageSize ?? 100;

    const load = async (): Promise<void> => {
      if (loading) return;
      loading = true;
      try {
        let editablePage = await options.editingService.loadPage(
          options.connectionId,
          options.database,
          options.table,
          page,
          pageSize,
          currentSql
        );
        if (page > 0 && editablePage.result.rows.length === 0) {
          page -= 1;
          editablePage = await options.editingService.loadPage(
            options.connectionId,
            options.database,
            options.table,
            page,
            pageSize,
            currentSql
          );
        }
        instance.batchEditHandler = editablePage.updateRows;
        instance.deleteRowHandler = editablePage.deleteRow;
        instance.deleteRowsHandler = editablePage.deleteRows;
        instance.insertRowHandler = editablePage.insertRow;
        instance.refreshHandler = load;
        const displaySql = currentSql ?? buildTablePreviewEditorSql(options.database, options.table, page, pageSize);
        instance.render(editablePage.result, {
          title: options.title,
          page,
          canGoBack: page > 0,
          canGoForward: editablePage.result.hasMore,
          sql: displaySql,
          tableOverview: options.tableOverview,
          tableOverviewError: options.tableOverviewError,
          editing: editablePage.editing
        });
      } catch (error) {
        instance.batchEditHandler = undefined;
        instance.deleteRowHandler = undefined;
        instance.deleteRowsHandler = undefined;
        instance.insertRowHandler = undefined;
        instance.refreshHandler = load;
        const message = options.formatError
          ? await options.formatError(error)
          : error instanceof Error ? error.message : String(error);
        const displaySql = currentSql ?? buildTablePreviewEditorSql(options.database, options.table, page, pageSize);
        instance.render(emptyResult(), {
          title: options.title,
          page,
          canGoBack: page > 0,
          sql: displaySql,
          tableOverview: options.tableOverview,
          tableOverviewError: options.tableOverviewError,
          error: message
        });
      } finally {
        loading = false;
      }
    };

    instance.executeHandler = async (sql: string): Promise<void> => {
      currentSql = sql;
      const offsetWordMatch = sql.match(/\boffset\s+(\d+)\b/i);
      const limitCommaMatch = sql.match(/\blimit\s+(\d+)\s*,\s*(\d+)\b/i);
      if (offsetWordMatch && offsetWordMatch[1]) {
        const offsetNum = parseInt(offsetWordMatch[1], 10);
        page = Math.max(0, Math.floor(offsetNum / pageSize));
      } else if (limitCommaMatch && limitCommaMatch[1]) {
        const offsetNum = parseInt(limitCommaMatch[1], 10);
        page = Math.max(0, Math.floor(offsetNum / pageSize));
      } else {
        page = 0;
      }
      await load();
    };

    instance.pageHandler = async (direction: number) => {
      page = Math.max(0, page + direction);
      if (currentSql) {
        if (/\blimit\s+\d+\s+offset\s+\d+\b/i.test(currentSql)) {
          currentSql = currentSql.replace(/\blimit\s+\d+\s+offset\s+\d+\b/i, `LIMIT ${pageSize} OFFSET ${page * pageSize}`);
        } else if (/\blimit\s+\d+\s*,\s*\d+\b/i.test(currentSql)) {
          currentSql = currentSql.replace(/\blimit\s+\d+\s*,\s*\d+\b/i, `LIMIT ${page * pageSize}, ${pageSize}`);
        }
      }
      await load();
    };

    await load();
  }

  private static getOrCreate(title: string): ResultPanel {
    if (this.current) {
      this.current.baseTitle = title;
      this.current.panel.title = title;
      this.current.panel.reveal(vscode.ViewColumn.Beside, true);
      return this.current;
    }
    const panel = vscode.window.createWebviewPanel(
      'rindaMysql.results',
      title,
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      { enableScripts: true, retainContextWhenHidden: true }
    );
    this.current = new ResultPanel(panel);
    this.current.baseTitle = title;
    return this.current;
  }

  private render(result: QueryResult, options: RenderOptions): void {
    this.dirty = false;
    this.baseTitle = options.title;
    this.panel.title = options.title;
    this.panel.webview.html = buildHtml(result, options);
  }
}

async function writeSelectionCsv(targetPath: string, columns: string[], rows: Array<Array<string | null>>): Promise<void> {
  const writer = await SafeFileWriter.create(targetPath, true);
  try {
    const line = (values: readonly (string | null)[]): string => values
      .map((value) => formatCsvCell(value, undefined, true)).join(',') + '\r\n';
    await writer.write(line(columns));
    for (const row of rows) await writer.write(line(row));
    await writer.commit();
  } catch (error) {
    await writer.abort();
    throw error;
  }
}

function parseSelectionExport(message: PanelMessage): {
  columns: string[];
  rows: Array<Array<string | null>>;
  suggestedName: string;
} {
  if (!Array.isArray(message.columns) || message.columns.length < 1 || message.columns.length > 1_000
    || message.columns.some((value) => typeof value !== 'string' || value.length > 512)) {
  throw new Error('CSV 列定义无效。');
  }
  if (!Array.isArray(message.rows) || message.rows.length < 1 || message.rows.length > 500) {
    throw new Error('一次只能导出当前结果中的 1–500 行。');
  }
  let characters = 0;
  const columnCount = message.columns.length;
  const rows = message.rows.map((row) => {
    if (!Array.isArray(row) || row.length !== columnCount) throw new Error('CSV 行结构无效。');
    return row.map((value) => {
      if (value !== null && typeof value !== 'string') throw new Error('CSV 单元格格式无效。');
      characters += value?.length ?? 0;
      if (characters > 25_000_000) throw new Error('所选内容超过 25,000,000 个字符，请减少选择后重试。');
      return value;
    });
  });
  const suggested = typeof message.suggestedName === 'string'
    ? message.suggestedName.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 180)
    : 'rinda-selection.csv';
  return {
    columns: message.columns as string[],
    rows,
    suggestedName: suggested.toLowerCase().endsWith('.csv') ? suggested : `${suggested}.csv`
  };
}

function isMessage(value: unknown): value is PanelMessage {
  return typeof value === 'object' && value !== null && 'type' in value;
}

function isBatchEditMessage(value: PanelMessage): value is PanelMessage & {
  operationId: string;
  edits: Array<{ token: string; changes: unknown }>;
} {
  return typeof value.operationId === 'string' && value.operationId.length <= 128
    && Array.isArray(value.edits) && value.edits.length >= 1 && value.edits.length <= 50
    && value.edits.every((edit) => typeof edit === 'object' && edit !== null
      && 'token' in edit && typeof edit.token === 'string' && edit.token.length <= 128
      && 'changes' in edit && typeof edit.changes === 'object' && edit.changes !== null && !Array.isArray(edit.changes));
}

function isDeleteMessage(value: PanelMessage): value is PanelMessage & {
  tokens: string[];
  operationId: string;
  confirmation: string;
} {
  const rawTokens = Array.isArray(value.tokens)
    ? value.tokens
    : (typeof value.token === 'string' ? [value.token] : null);
  if (!rawTokens || rawTokens.length < 1 || rawTokens.length > 50) return false;
  if (!rawTokens.every((t) => typeof t === 'string' && t.length >= 8 && t.length <= 128)) return false;
  (value as { tokens: string[] }).tokens = rawTokens as string[];
  return typeof value.operationId === 'string' && value.operationId.length >= 8 && value.operationId.length <= 128
    && typeof value.confirmation === 'string';
}

export { isSameTablePreviewSql } from './queryEditorModel.js';
