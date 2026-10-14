import * as vscode from 'vscode';
import type { ConnectionStore } from '../connection/ConnectionStore.js';
import type { TableDesignerService } from '../design/TableDesignerService.js';
import type { MysqlTreeNode, MysqlTreeProvider } from '../explorer/MysqlTreeProvider.js';
import type { MetadataRepository } from '../explorer/metadataRepository.js';
import { TableDesignerPanel } from '../webview/TableDesignerPanel.js';

interface TableDesignCommandServices {
  store: ConnectionStore;
  metadata: MetadataRepository;
  designer: TableDesignerService;
  tree: MysqlTreeProvider;
}

export function registerTableDesignCommands(
  context: vscode.ExtensionContext,
  services: TableDesignCommandServices
): void {
  // Command: Create Table (新建表)
  context.subscriptions.push(
    vscode.commands.registerCommand('rindaMysql.createTable', async (node?: MysqlTreeNode) => {
      let connectionId: string | undefined;
      let database: string | undefined;

      if (node && (node.kind === 'database' || node.kind === 'tableGroup')) {
        connectionId = node.connectionId;
        database = node.database;
      } else {
        connectionId = await chooseConnection(services.store);
        if (!connectionId) return;
        database = await chooseDatabase(services.metadata, connectionId);
        if (!database) return;
      }

      const state = services.designer.createEmptyTableSchema(connectionId, database);
      TableDesignerPanel.show({
        state,
        service: services.designer,
        onTableSaved: () => {
          services.tree.refresh();
        }
      });
    })
  );

  // Command: Design Table (设计表)
  context.subscriptions.push(
    vscode.commands.registerCommand('rindaMysql.designTable', async (node?: MysqlTreeNode) => {
      let connectionId: string | undefined;
      let database: string | undefined;
      let table: string | undefined;

      if (node && node.kind === 'object' && node.object.type === 'table') {
        connectionId = node.connectionId;
        database = node.database;
        table = node.object.name;
      } else {
        connectionId = await chooseConnection(services.store);
        if (!connectionId) return;
        database = await chooseDatabase(services.metadata, connectionId);
        if (!database) return;
        table = await chooseTable(services.metadata, connectionId, database);
        if (!table) return;
      }

      try {
        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: `正在加载表结构 · ${database}.${table}...`
          },
          async () => {
            const state = await services.designer.loadTableSchema(connectionId, database, table);
            TableDesignerPanel.show({
              state,
              service: services.designer,
              onTableSaved: () => {
                services.tree.refresh();
              }
            });
          }
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        void vscode.window.showErrorMessage(`加载表结构失败：${message}`);
      }
    })
  );
}

async function chooseConnection(store: ConnectionStore): Promise<string | undefined> {
  const profiles = store.list();
  if (profiles.length === 0) {
    const action = await vscode.window.showInformationMessage('尚未配置 MySQL 连接。', '新建连接');
    if (action === '新建连接') await vscode.commands.executeCommand('rindaMysql.addConnection');
    return undefined;
  }
  if (profiles.length === 1) return profiles[0]?.id;
  const selected = await vscode.window.showQuickPick(
    profiles.map((profile) => ({
      label: profile.name,
      description: `${profile.user}@${profile.host}:${profile.port}`,
      id: profile.id
    })),
    { title: '选择数据库连接', ignoreFocusOut: true }
  );
  return selected?.id;
}

async function chooseDatabase(metadata: MetadataRepository, connectionId: string): Promise<string | undefined> {
  try {
    const databases = await metadata.listDatabases(connectionId);
    if (databases.length === 0) {
      void vscode.window.showInformationMessage('该连接下没有数据库。');
      return undefined;
    }
    const selected = await vscode.window.showQuickPick(
      databases.map((db) => ({ label: db })),
      { title: '选择数据库', ignoreFocusOut: true }
    );
    return selected?.label;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    void vscode.window.showErrorMessage(`获取数据库列表失败：${message}`);
    return undefined;
  }
}

async function chooseTable(
  metadata: MetadataRepository,
  connectionId: string,
  database: string
): Promise<string | undefined> {
  try {
    const objects = await metadata.listObjects(connectionId, database);
    const tables = objects.filter((obj) => obj.type === 'table');
    if (tables.length === 0) {
      void vscode.window.showInformationMessage('该数据库下没有表。');
      return undefined;
    }
    const selected = await vscode.window.showQuickPick(
      tables.map((t) => ({ label: t.name })),
      { title: '选择要设计的表', ignoreFocusOut: true }
    );
    return selected?.label;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    void vscode.window.showErrorMessage(`获取表列表失败：${message}`);
    return undefined;
  }
}
