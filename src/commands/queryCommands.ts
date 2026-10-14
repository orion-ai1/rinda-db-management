import * as vscode from 'vscode';
import type { ConnectionStore } from '../connection/ConnectionStore.js';
import type { TableEditingService } from '../editing/TableEditingService.js';
import type { MysqlTreeNode, MysqlTreeProvider } from '../explorer/MysqlTreeProvider.js';
import type { MetadataRepository, TableOverview } from '../explorer/metadataRepository.js';
import type { QueryService } from '../query/QueryService.js';
import type { QueryStorageService } from '../query/QueryStorageService.js';
import { resolveExecutableSql } from '../query/sqlGuards.js';
import { redactSensitiveText } from '../security/redaction.js';
import { isSameTablePreviewSql, ResultPanel } from '../webview/ResultPanel.js';

interface QueryCommandServices {
  store: ConnectionStore;
  query: QueryService;
  metadata: MetadataRepository;
  editing: TableEditingService;
  queryStorage?: QueryStorageService;
  tree?: MysqlTreeProvider;
}

interface PanelQueryOptions {
  connectionId: string;
  title: string;
  sql: string;
  tableOverview?: TableOverview;
  tableOverviewError?: string;
  sourceTable?: { database: string; table: string };
  onSameTableSql?: () => Promise<void>;
}

export function registerQueryCommands(
  context: vscode.ExtensionContext,
  services: QueryCommandServices
): void {
  let activeController: AbortController | undefined;
  let lastConnectionId = context.globalState.get<string>('rindaMysql.lastConnectionId');

  const runPanelQuery = async (options: PanelQueryOptions): Promise<void> => {
    const profile = services.store.get(options.connectionId);
    if (!profile) {
      void vscode.window.showErrorMessage('连接配置已不存在，请重新选择连接。');
      return;
    }
    const onExecute = async (sql: string): Promise<void> => {
      if (options.sourceTable && isSameTablePreviewSql(sql, options.sourceTable.database, options.sourceTable.table)) {
        await options.onSameTableSql?.();
        return;
      }
      await runPanelQuery({ ...options, sql });
    };
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `正在 ${profile.name} 执行查询…`,
        cancellable: true
      },
      async (_progress, token) => {
        const controller = new AbortController();
        activeController = controller;
        const cancellation = token.onCancellationRequested(() => controller.abort());
        try {
          const result = await services.query.execute({
            connectionId: options.connectionId,
            sql: options.sql,
            database: options.sourceTable?.database,
            signal: controller.signal
          });
          ResultPanel.showResult({
            title: options.title,
            result,
            sql: options.sql,
            tableOverview: options.tableOverview,
            tableOverviewError: options.tableOverviewError,
            onExecute
          });
        } catch (error) {
          const password = await services.store.getPassword(options.connectionId);
          const message = redactSensitiveText(error, password ? [password] : []);
          ResultPanel.showError({
            title: options.title,
            error: message,
            sql: options.sql,
            tableOverview: options.tableOverview,
            tableOverviewError: options.tableOverviewError,
            onExecute
          });
          if ((error as Error).name !== 'AbortError') {
            void vscode.window.showErrorMessage(`查询失败：${message}`);
          }
        } finally {
          cancellation.dispose();
          if (activeController === controller) activeController = undefined;
        }
      }
    );
  };

  context.subscriptions.push(vscode.commands.registerCommand('rindaMysql.openQuery', async (node?: MysqlTreeNode) => {
    const connectionId = node && 'connectionId' in node ? node.connectionId : undefined;
    if (connectionId) {
      lastConnectionId = connectionId;
      await context.globalState.update('rindaMysql.lastConnectionId', connectionId);
    }
    const profile = connectionId
      ? services.store.get(connectionId)
      : (lastConnectionId ? services.store.get(lastConnectionId) : services.store.list()[0]);
    const database = (node && 'database' in node ? node.database : undefined)
      || profile?.database
      || context.globalState.get<string>('rindaMysql.lastDatabase');

    if (services.queryStorage && profile && database) {
      try {
        const filePath = await services.queryStorage.createQueryFile(profile, database);
        const document = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
        await vscode.window.showTextDocument(document);
        services.tree?.refresh();
        return;
      } catch {
        // fallback to memory document
      }
    }

    const content = profile
      ? `-- Active: ${profile.name} · ${database || 'default'}\n-- 选中 SQL 后按 Cmd/Ctrl+R 执行选中部分；按 Cmd/Ctrl+Enter 执行全文。\n\nSELECT 1;\n`
      : '-- Rinda MySQL\n-- 选中 SQL 后按 Cmd/Ctrl+R 执行选中部分；按 Cmd/Ctrl+Enter 执行全文。\n\nSELECT 1;\n';
    const document = await vscode.workspace.openTextDocument({ language: 'sql', content });
    await vscode.window.showTextDocument(document);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('rindaMysql.executeQuery', async (node?: MysqlTreeNode) => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      void vscode.window.showErrorMessage('请先打开 SQL 编辑器。');
      return;
    }
    const selectedText = editor.selection.isEmpty ? undefined : editor.document.getText(editor.selection);
    let sql: string;
    try {
      sql = resolveExecutableSql(editor.document.getText(), selectedText);
    } catch (error) {
      void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
      return;
    }
    const nodeConnectionId = node && 'connectionId' in node ? node.connectionId : undefined;
    const connectionId = await chooseConnection(services.store, nodeConnectionId ?? lastConnectionId);
    if (!connectionId) return;
    lastConnectionId = connectionId;
    await context.globalState.update('rindaMysql.lastConnectionId', connectionId);
    const profile = services.store.getRequired(connectionId);
    const database = resolveDatabaseFromDocument(editor.document, context.globalState, profile.database);
    if (database) {
      await context.globalState.update('rindaMysql.lastDatabase', database);
    }
    await runPanelQuery({
      connectionId,
      title: `查询结果 · ${profile.name}${database ? ` (${database})` : ''}`,
      sql,
      sourceTable: database ? { database, table: '' } : undefined
    });
  }));

  context.subscriptions.push(vscode.commands.registerCommand('rindaMysql.runSelectedSql', async (node?: MysqlTreeNode) => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      void vscode.window.showErrorMessage('请先打开 SQL 编辑器。');
      return;
    }
    const selection = editor.selection;
    const selectedText = editor.document.getText(selection).trim();
    if (!selectedText) {
      void vscode.window.showWarningMessage('请先用鼠标选中要执行的 SQL 语句。');
      return;
    }
    const nodeConnectionId = node && 'connectionId' in node ? node.connectionId : undefined;
    const connectionId = await chooseConnection(services.store, nodeConnectionId ?? lastConnectionId);
    if (!connectionId) return;
    lastConnectionId = connectionId;
    await context.globalState.update('rindaMysql.lastConnectionId', connectionId);
    const profile = services.store.getRequired(connectionId);
    const database = resolveDatabaseFromDocument(editor.document, context.globalState, profile.database);
    if (database) {
      await context.globalState.update('rindaMysql.lastDatabase', database);
    }
    await runPanelQuery({
      connectionId,
      title: `选中查询 · ${profile.name}${database ? ` (${database})` : ''}`,
      sql: selectedText,
      sourceTable: database ? { database, table: '' } : undefined
    });
  }));

  context.subscriptions.push(vscode.commands.registerCommand('rindaMysql.explainQuery', async (node?: MysqlTreeNode) => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      void vscode.window.showErrorMessage('请先打开 SQL 编辑器。');
      return;
    }
    const selectedText = editor.selection.isEmpty ? undefined : editor.document.getText(editor.selection);
    let sql: string;
    try {
      sql = resolveExecutableSql(editor.document.getText(), selectedText);
    } catch (error) {
      void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
      return;
    }
    const nodeConnectionId = node && 'connectionId' in node ? node.connectionId : undefined;
    const connectionId = await chooseConnection(services.store, nodeConnectionId ?? lastConnectionId);
    if (!connectionId) return;
    lastConnectionId = connectionId;
    await context.globalState.update('rindaMysql.lastConnectionId', connectionId);
    const profile = services.store.getRequired(connectionId);
    const database = resolveDatabaseFromDocument(editor.document, context.globalState, profile.database);
    if (database) {
      await context.globalState.update('rindaMysql.lastDatabase', database);
    }
    const cleanSql = sql.trim().replace(/;\s*$/, '');
    const explainSql = /^\s*explain\b/i.test(cleanSql) ? cleanSql : `EXPLAIN ${cleanSql}`;
    await runPanelQuery({
      connectionId,
      title: `EXPLAIN 分析 · ${profile.name}${database ? ` (${database})` : ''}`,
      sql: explainSql,
      sourceTable: database ? { database, table: '' } : undefined
    });
  }));

  context.subscriptions.push(vscode.commands.registerCommand('rindaMysql.cancelQuery', () => {
    if (!activeController) {
      void vscode.window.showInformationMessage('当前没有正在执行的查询。');
      return;
    }
    activeController.abort();
  }));

  context.subscriptions.push(vscode.commands.registerCommand('rindaMysql.previewTable', async (node?: MysqlTreeNode) => {
    if (!node || node.kind !== 'object') return;
    const profile = services.store.get(node.connectionId);
    if (!profile) return;
    lastConnectionId = node.connectionId;
    await context.globalState.update('rindaMysql.lastConnectionId', node.connectionId);
    await context.globalState.update('rindaMysql.lastDatabase', node.database);
    let tableOverview: TableOverview | undefined;
    let tableOverviewError: string | undefined;
    try {
      tableOverview = await services.metadata.getTableOverview(
        node.connectionId,
        node.database,
        node.object.name
      );
      if (!tableOverview) tableOverviewError = '未找到该对象的元数据。';
    } catch (error) {
      const password = await services.store.getPassword(node.connectionId);
      tableOverviewError = redactSensitiveText(error, password ? [password] : []);
    }
    const title = `${node.database}.${node.object.name} · ${profile.name}`;
    const reloadTable = async (): Promise<void> => {
      await ResultPanel.showTablePreview({
        title,
        connectionId: node.connectionId,
        database: node.database,
        table: node.object.name,
        editingService: services.editing,
        tableOverview,
        tableOverviewError,
        onExecute,
        formatError: async (error) => {
          const password = await services.store.getPassword(node.connectionId);
          return redactSensitiveText(error, password ? [password] : []);
        },
        pageSize: 100
      });
    };
    const onExecute = async (sql: string): Promise<void> => {
      if (isSameTablePreviewSql(sql, node.database, node.object.name)) {
        await reloadTable();
        return;
      }
      await runPanelQuery({
        connectionId: node.connectionId,
        title,
        sql,
        tableOverview,
        tableOverviewError,
        onSameTableSql: reloadTable,
        sourceTable: { database: node.database, table: node.object.name }
      });
    };
    await reloadTable();
  }));

  context.subscriptions.push(vscode.commands.registerCommand('rindaMysql.showTableDdl', async (node?: MysqlTreeNode) => {
    if (!node || node.kind !== 'object') {
      void vscode.window.showErrorMessage('请在对象树中右键点击表或视图。');
      return;
    }
    const profile = services.store.get(node.connectionId);
    if (!profile) return;
    const isView = node.object.type === 'view';
    const escapedDb = node.database.replace(/`/g, '``');
    const escapedTbl = node.object.name.replace(/`/g, '``');
    const showSql = isView
      ? `SHOW CREATE VIEW \`${escapedDb}\`.\`${escapedTbl}\``
      : `SHOW CREATE TABLE \`${escapedDb}\`.\`${escapedTbl}\``;

    try {
      const result = await services.query.execute({
        connectionId: node.connectionId,
        database: node.database,
        sql: showSql
      });
      const ddlIndex = result.columns.findIndex((c) => c.toLowerCase().includes('create'));
      const ddl = (ddlIndex >= 0 && result.rows[0]?.[ddlIndex]) ? result.rows[0][ddlIndex] : '';
      if (!ddl) {
        void vscode.window.showErrorMessage(`未能获取到 ${node.database}.${node.object.name} 的 DDL 语句。`);
        return;
      }
      const content = [
        `-- ===================================================`,
        `-- ${isView ? 'View' : 'Table'} DDL: \`${node.database}\`.\`${node.object.name}\``,
        `-- Connection: ${profile.name} (${profile.host}:${profile.port})`,
        `-- Generated At: ${new Date().toLocaleString()}`,
        `-- ===================================================`,
        ``,
        `${ddl};`,
        ``
      ].join('\n');

      const document = await vscode.workspace.openTextDocument({
        language: 'sql',
        content
      });
      await vscode.window.showTextDocument(document, { preview: true });
    } catch (error) {
      const password = await services.store.getPassword(node.connectionId);
      const detail = redactSensitiveText(error, password ? [password] : []);
      void vscode.window.showErrorMessage(`获取 DDL 失败：${detail}`);
    }
  }));
}

async function chooseConnection(store: ConnectionStore, preferredId?: string): Promise<string | undefined> {
  const profiles = store.list();
  if (profiles.length === 0) {
    const action = await vscode.window.showInformationMessage('请先新建 MySQL 连接。', '新建连接');
    if (action === '新建连接') await vscode.commands.executeCommand('rindaMysql.addConnection');
    return undefined;
  }
  if (profiles.length === 1) return profiles[0]?.id;
  const selected = await vscode.window.showQuickPick(
    profiles.map((profile) => ({
      label: profile.name,
      description: `${profile.user}@${profile.host}:${profile.port}`,
      picked: profile.id === preferredId,
      id: profile.id
    })),
    { title: '选择执行查询的 MySQL 连接', ignoreFocusOut: true }
  );
  return selected?.id;
}

function resolveDatabaseFromDocument(
  document: vscode.TextDocument,
  globalState: vscode.Memento,
  defaultDb?: string
): string | undefined {
  const head = document.getText(new vscode.Range(0, 0, Math.min(25, document.lineCount), 0));
  const activeMatch = head.match(/--\s*Active:\s*.*?[·-]\s*([a-zA-Z0-9_$]+)/i);
  if (activeMatch && activeMatch[1]) return activeMatch[1].trim();

  const dbCommentMatch = head.match(/--\s*Database:\s*([a-zA-Z0-9_$]+)/i);
  if (dbCommentMatch && dbCommentMatch[1]) return dbCommentMatch[1].trim();

  if (document.uri.scheme === 'file') {
    const parts = document.uri.fsPath.split(/[\/\\]/);
    const queriesIdx = parts.indexOf('queries');
    if (queriesIdx >= 0 && parts.length > queriesIdx + 2) {
      const dbPart = parts[queriesIdx + 2];
      if (dbPart && dbPart !== 'security') return dbPart;
    }
    const storageIdx = parts.indexOf('storage');
    if (storageIdx >= 0 && parts.length > storageIdx + 2) {
      const dbPart = parts[storageIdx + 2];
      if (dbPart && dbPart !== 'security') return dbPart;
    }
    const rindaIdx = parts.findIndex(p => p.startsWith('.rinda'));
    if (rindaIdx >= 0 && parts.length > rindaIdx + 2) {
      const nextPart = parts[rindaIdx + 1];
      if (nextPart !== 'queries' && nextPart !== 'storage' && parts.length > rindaIdx + 2) {
        const dbPart = parts[rindaIdx + 2];
        if (dbPart && dbPart !== 'security') return dbPart;
      }
    }
  }

  const useMatch = document.getText().match(/\buse\s+[`"']?([a-zA-Z0-9_$]+)[`"']?\s*;/i);
  if (useMatch && useMatch[1]) return useMatch[1].trim();

  return globalState.get<string>('rindaMysql.lastDatabase') || defaultDb;
}
