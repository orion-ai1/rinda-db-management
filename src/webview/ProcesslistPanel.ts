import * as vscode from 'vscode';
import type { ProcesslistService } from '../monitor/ProcesslistService.js';
import type { ProcesslistSnapshot } from '../monitor/ProcesslistTypes.js';
import { buildProcesslistHtml } from './processlistHtml.js';

interface ProcesslistPanelOptions {
  connectionId: string;
  connectionName: string;
  service: ProcesslistService;
}

export class ProcesslistPanel {
  private static readonly activePanels = new Map<string, ProcesslistPanel>();

  private readonly panel: vscode.WebviewPanel;
  private isRefreshing = false;

  public static async show(options: ProcesslistPanelOptions): Promise<ProcesslistPanel> {
    const existing = ProcesslistPanel.activePanels.get(options.connectionId);
    if (existing) {
      existing.panel.reveal(vscode.ViewColumn.Active);
      await existing.refresh();
      return existing;
    }

    const snapshot = await options.service.getSnapshot(options.connectionId, options.connectionName);
    const instance = new ProcesslistPanel(options.connectionId, options.connectionName, snapshot, options.service);
    ProcesslistPanel.activePanels.set(options.connectionId, instance);
    return instance;
  }

  private constructor(
    private readonly connectionId: string,
    private readonly connectionName: string,
    private snapshot: ProcesslistSnapshot,
    private readonly service: ProcesslistService
  ) {
    this.panel = vscode.window.createWebviewPanel(
      'rindaMysql.processlist',
      `服务器进程 · ${connectionName}`,
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true
      }
    );

    this.panel.webview.html = buildProcesslistHtml(this.snapshot);

    this.panel.onDidDispose(() => {
      ProcesslistPanel.activePanels.delete(this.connectionId);
    });

    this.panel.webview.onDidReceiveMessage(async (message: unknown) => {
      if (!message || typeof message !== 'object') return;
      const msg = message as Record<string, unknown>;

      if (msg.type === 'refresh') {
        await this.refresh();
        return;
      }

      if (msg.type === 'copy' && typeof msg.text === 'string') {
        await vscode.env.clipboard.writeText(msg.text);
        void vscode.window.showInformationMessage('已复制到剪贴板。');
        return;
      }

      if (msg.type === 'openInQuery' && typeof msg.sql === 'string') {
        try {
          const doc = await vscode.workspace.openTextDocument({
            language: 'sql',
            content: `-- Active: ${this.connectionName}\n-- Server Process Query\n${msg.sql.trim()}\n`
          });
          await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside });
        } catch (error) {
          void vscode.window.showErrorMessage(`无法打开查询窗口：${String(error)}`);
        }
        return;
      }

      if (msg.type === 'kill' && typeof msg.processId === 'number') {
        const queryOnly = Boolean(msg.queryOnly);
        const processId = msg.processId;

        const outcome = await this.service.killProcess(this.connectionId, processId, queryOnly);
        if (outcome.ok) {
          void vscode.window.showInformationMessage(outcome.message);
        } else {
          void vscode.window.showErrorMessage(outcome.message);
        }

        // Always refresh immediately to reflect current server state
        await this.refresh();
      }
    });
  }

  public async refresh(): Promise<void> {
    if (this.isRefreshing) return;
    this.isRefreshing = true;
    try {
      this.snapshot = await this.service.getSnapshot(this.connectionId, this.connectionName);
      await this.panel.webview.postMessage({
        type: 'snapshot',
        snapshot: this.snapshot
      });
    } catch (error) {
      // If error occurs during background refresh, show gentle warning if panel is active
      const msg = error instanceof Error ? error.message : String(error);
      this.panel.title = `服务器进程 · ${this.connectionName} (刷新失败)`;
      void vscode.window.showWarningMessage(`刷新服务器进程列表失败：${msg}`);
    } finally {
      this.isRefreshing = false;
      this.panel.title = `服务器进程 · ${this.connectionName}`;
    }
  }
}
