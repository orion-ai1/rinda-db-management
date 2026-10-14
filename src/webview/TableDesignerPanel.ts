import * as vscode from 'vscode';
import { generatePreviewSql } from '../design/TableDdlGenerator.js';
import type { TableDesignerService } from '../design/TableDesignerService.js';
import type { TableDesignerState } from '../design/TableDesignerTypes.js';
import { buildTableDesignerHtml } from './tableDesignerHtml.js';

interface TableDesignerPanelOptions {
  state: TableDesignerState;
  service: TableDesignerService;
  onTableSaved?: () => Promise<void> | void;
}

export class TableDesignerPanel {
  private static readonly activePanels = new Map<string, TableDesignerPanel>();

  private readonly panel: vscode.WebviewPanel;
  private isDirty = false;
  private baseTitle: string;

  private constructor(
    private readonly key: string,
    private state: TableDesignerState,
    private readonly service: TableDesignerService,
    private readonly onTableSaved?: () => Promise<void> | void
  ) {
    this.baseTitle =
      state.mode === 'create'
        ? `新建表 · ${state.database}`
        : `设计表 · ${state.database}.${state.tableName}`;

    this.panel = vscode.window.createWebviewPanel(
      'rindaMysql.tableDesigner',
      this.baseTitle,
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true
      }
    );

    this.panel.webview.html = buildTableDesignerHtml(this.state);

    this.panel.onDidDispose(() => {
      TableDesignerPanel.activePanels.delete(this.key);
    });

    this.panel.webview.onDidReceiveMessage(async (message: unknown) => {
      if (!isDesignerMessage(message)) return;

      if (message.type === 'dirtyState' && typeof message.dirty === 'boolean') {
        this.isDirty = message.dirty;
        this.panel.title = `${this.isDirty ? '● ' : ''}${this.baseTitle}`;
        return;
      }

      if (message.type === 'copy' && typeof message.text === 'string') {
        await vscode.env.clipboard.writeText(message.text);
        return;
      }

      if (message.type === 'getPreviewSql' && message.state) {
        const previewSql = generatePreviewSql(message.state as TableDesignerState);
        await this.panel.webview.postMessage({ type: 'previewSql', sql: previewSql });
        return;
      }

      if (message.type === 'save' && message.state) {
        const currentState = message.state as TableDesignerState;
        try {
          const outcome = await this.service.executeSave(currentState);
          if (!outcome.ok) {
            void vscode.window.showErrorMessage(`保存失败：${outcome.message}`);
            await this.panel.webview.postMessage({ type: 'saveError', error: outcome.message });
            return;
          }

          void vscode.window.showInformationMessage(outcome.message);

          // Notify tree to refresh
          if (this.onTableSaved) {
            await this.onTableSaved();
          }

          // Reload updated table schema from database to establish fresh baseline
          try {
            const reloadedState = await this.service.loadTableSchema(
              currentState.connectionId,
              currentState.database,
              currentState.tableName.trim()
            );
            this.state = reloadedState;
            this.baseTitle = `设计表 · ${reloadedState.database}.${reloadedState.tableName}`;
            this.panel.title = this.baseTitle;
            this.isDirty = false;
            await this.panel.webview.postMessage({
              type: 'saveSuccess',
              newState: reloadedState
            });
          } catch {
            this.isDirty = false;
            this.panel.title = this.baseTitle;
            await this.panel.webview.postMessage({ type: 'saveSuccess' });
          }
        } catch (error) {
          const messageText = error instanceof Error ? error.message : String(error);
          void vscode.window.showErrorMessage(`执行 DDL 失败：${messageText}`);
          await this.panel.webview.postMessage({ type: 'saveError', error: messageText });
        }
      }
    });
  }

  public static show(options: TableDesignerPanelOptions): TableDesignerPanel {
    const key = `${options.state.connectionId}:${options.state.database}:${options.state.originalTableName || options.state.tableName || '__new__'}`;
    const existing = this.activePanels.get(key);
    if (existing) {
      existing.panel.reveal(vscode.ViewColumn.Active);
      return existing;
    }

    const panel = new TableDesignerPanel(key, options.state, options.service, options.onTableSaved);
    this.activePanels.set(key, panel);
    return panel;
  }
}

function isDesignerMessage(
  raw: unknown
): raw is { type: string; dirty?: boolean; text?: string; state?: unknown } {
  return typeof raw === 'object' && raw !== null && 'type' in raw;
}
