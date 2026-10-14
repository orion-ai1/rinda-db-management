import * as vscode from 'vscode';
import type { ConnectionStore } from '../connection/ConnectionStore.js';
import type { ConnectionProfile } from '../connection/types.js';
import type { MysqlTreeNode } from '../explorer/MysqlTreeProvider.js';
import type { ProcesslistService } from '../monitor/ProcesslistService.js';
import { ProcesslistPanel } from '../webview/ProcesslistPanel.js';

interface MonitorCommandServices {
  store: ConnectionStore;
  processlist: ProcesslistService;
}

export function registerMonitorCommands(
  context: vscode.ExtensionContext,
  services: MonitorCommandServices
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('rindaMysql.showProcesslist', async (node?: MysqlTreeNode) => {
      const profile = await resolveProfile(services.store, node);
      if (!profile) return;

      try {
        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: `正在获取 ${profile.name} 的进程列表…`
          },
          async () => {
            await ProcesslistPanel.show({
              connectionId: profile.id,
              connectionName: profile.name,
              service: services.processlist
            });
          }
        );
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        void vscode.window.showErrorMessage(`无法打开进程列表：${msg}`);
      }
    })
  );
}

async function resolveProfile(
  store: ConnectionStore,
  node?: MysqlTreeNode
): Promise<ConnectionProfile | undefined> {
  if (node && 'connectionId' in node && node.connectionId) {
    return store.get(node.connectionId);
  }
  const profiles = store.list();
  if (profiles.length === 0) {
    void vscode.window.showInformationMessage('请先新建 MySQL 连接。');
    return undefined;
  }
  if (profiles.length === 1) return profiles[0];
  const selected = await vscode.window.showQuickPick(
    profiles.map((profile) => ({
      label: profile.name,
      description: `${profile.user}@${profile.host}:${profile.port}`,
      profile
    })),
    { title: '选择 MySQL 连接', ignoreFocusOut: true }
  );
  return selected?.profile;
}
