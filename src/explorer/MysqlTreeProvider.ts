import * as vscode from 'vscode';
import type { ConnectionManager } from '../connection/ConnectionManager.js';
import type { ConnectionStore } from '../connection/ConnectionStore.js';
import type { ConnectionProfile } from '../connection/types.js';
import type { QueryStorageService } from '../query/QueryStorageService.js';
import { redactSensitiveText } from '../security/redaction.js';
import type { DatabaseObject, MetadataRepository } from './metadataRepository.js';

export type MysqlTreeNode =
  | { kind: 'connection'; connectionId: string; profile: ConnectionProfile }
  | { kind: 'usersGroup'; connectionId: string }
  | { kind: 'userItem'; connectionId: string; user: string }
  | { kind: 'database'; connectionId: string; database: string; size?: string }
  | { kind: 'queryGroup'; connectionId: string; database: string }
  | { kind: 'queryFile'; connectionId: string; database: string; fileUri: vscode.Uri; fileName: string }
  | { kind: 'tableGroup'; connectionId: string; database: string; count: number }
  | { kind: 'viewGroup'; connectionId: string; database: string; count: number }
  | { kind: 'functionGroup'; connectionId: string; database: string; count: number }
  | { kind: 'procedureGroup'; connectionId: string; database: string; count: number }
  | { kind: 'object'; connectionId: string; database: string; object: DatabaseObject }
  | { kind: 'routine'; connectionId: string; database: string; routineType: 'function' | 'procedure'; name: string }
  | { kind: 'message'; label: string; connectionId?: string };

export class MysqlTreeProvider implements vscode.TreeDataProvider<MysqlTreeNode> {
  private readonly changeEmitter = new vscode.EventEmitter<MysqlTreeNode | undefined>();
  public readonly onDidChangeTreeData = this.changeEmitter.event;

  public constructor(
    private readonly store: ConnectionStore,
    private readonly connections: ConnectionManager,
    private readonly metadata: MetadataRepository,
    private readonly queryStorage: QueryStorageService
  ) {}

  public refresh(node?: MysqlTreeNode): void {
    this.changeEmitter.fire(node);
  }

  public getTreeItem(node: MysqlTreeNode): vscode.TreeItem {
    switch (node.kind) {
      case 'connection': {
        const connected = this.connections.isConnected(node.connectionId);
        const item = new vscode.TreeItem(node.profile.name, vscode.TreeItemCollapsibleState.Collapsed);
        item.description = `${node.profile.host}:${node.profile.port}`;
        item.tooltip = `${node.profile.name}\n${node.profile.user}@${node.profile.host}:${node.profile.port}`;
        item.iconPath = new vscode.ThemeIcon(connected ? 'database' : 'debug-disconnect');
        item.contextValue = connected ? 'connectionConnected' : 'connectionDisconnected';
        return item;
      }
      case 'usersGroup': {
        const item = new vscode.TreeItem('Users', vscode.TreeItemCollapsibleState.Collapsed);
        item.iconPath = new vscode.ThemeIcon('account');
        item.contextValue = 'usersGroup';
        return item;
      }
      case 'userItem': {
        const item = new vscode.TreeItem(node.user, vscode.TreeItemCollapsibleState.None);
        item.iconPath = new vscode.ThemeIcon('person');
        item.contextValue = 'userItem';
        return item;
      }
      case 'database': {
        const item = new vscode.TreeItem(node.database, vscode.TreeItemCollapsibleState.Collapsed);
        item.description = node.size;
        item.iconPath = new vscode.ThemeIcon('database');
        item.contextValue = 'database';
        return item;
      }
      case 'queryGroup': {
        const item = new vscode.TreeItem('Query', vscode.TreeItemCollapsibleState.Collapsed);
        item.iconPath = new vscode.ThemeIcon('database');
        item.contextValue = 'queryGroup';
        return item;
      }
      case 'queryFile': {
        const item = new vscode.TreeItem(node.fileName, vscode.TreeItemCollapsibleState.None);
        item.iconPath = new vscode.ThemeIcon('file-code');
        item.contextValue = 'queryFile';
        item.command = {
          command: 'vscode.open',
          title: '打开查询文件',
          arguments: [node.fileUri]
        };
        return item;
      }
      case 'tableGroup': {
        const label = node.count > 0 ? `Tables (${node.count})` : 'Tables';
        const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.Collapsed);
        item.iconPath = new vscode.ThemeIcon('table');
        item.contextValue = 'tableGroup';
        return item;
      }
      case 'viewGroup': {
        const item = new vscode.TreeItem('Views', vscode.TreeItemCollapsibleState.Collapsed);
        item.iconPath = new vscode.ThemeIcon('eye');
        item.contextValue = 'viewGroup';
        return item;
      }
      case 'functionGroup': {
        const item = new vscode.TreeItem('Functions', vscode.TreeItemCollapsibleState.Collapsed);
        item.iconPath = new vscode.ThemeIcon('symbol-function');
        item.contextValue = 'functionGroup';
        return item;
      }
      case 'procedureGroup': {
        const item = new vscode.TreeItem('Procedures', vscode.TreeItemCollapsibleState.Collapsed);
        item.iconPath = new vscode.ThemeIcon('gear');
        item.contextValue = 'procedureGroup';
        return item;
      }
      case 'object': {
        const item = new vscode.TreeItem(node.object.name, vscode.TreeItemCollapsibleState.None);
        item.description = node.object.type === 'view' ? 'VIEW' : undefined;
        item.iconPath = new vscode.ThemeIcon(node.object.type === 'view' ? 'eye' : 'table');
        item.contextValue = node.object.type;
        item.command = {
          command: 'rindaMysql.previewTable',
          title: '预览数据',
          arguments: [node]
        };
        return item;
      }
      case 'routine': {
        const item = new vscode.TreeItem(node.name, vscode.TreeItemCollapsibleState.None);
        item.iconPath = new vscode.ThemeIcon(
          node.routineType === 'function' ? 'symbol-function' : 'gear'
        );
        item.contextValue = node.routineType === 'function' ? 'functionItem' : 'procedureItem';
        return item;
      }
      case 'message': {
        const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
        item.iconPath = new vscode.ThemeIcon('info');
        item.contextValue = 'message';
        return item;
      }
    }
  }

  public async getChildren(node?: MysqlTreeNode): Promise<MysqlTreeNode[]> {
    if (!node) {
      return this.store.list().map((profile) => ({
        kind: 'connection',
        connectionId: profile.id,
        profile
      }));
    }
    try {
      if (node.kind === 'connection') {
        const databases = await this.metadata.listDatabasesWithSizes(node.connectionId);
        const results: MysqlTreeNode[] = [
          { kind: 'usersGroup', connectionId: node.connectionId }
        ];
        for (const db of databases) {
          results.push({
            kind: 'database',
            connectionId: node.connectionId,
            database: db.name,
            size: db.size
          });
        }
        return results;
      }

      if (node.kind === 'usersGroup') {
        const users = await this.metadata.listUsers(node.connectionId);
        if (users.length === 0) {
          return [{ kind: 'message', label: 'No users found.', connectionId: node.connectionId }];
        }
        return users.map((user) => ({
          kind: 'userItem',
          connectionId: node.connectionId,
          user
        }));
      }

      if (node.kind === 'database') {
        const [tables, views, funcs, procs] = await Promise.all([
          this.metadata.listTables(node.connectionId, node.database),
          this.metadata.listViews(node.connectionId, node.database),
          this.metadata.listFunctions(node.connectionId, node.database),
          this.metadata.listProcedures(node.connectionId, node.database)
        ]);

        return [
          { kind: 'queryGroup', connectionId: node.connectionId, database: node.database },
          {
            kind: 'tableGroup',
            connectionId: node.connectionId,
            database: node.database,
            count: tables.length
          },
          {
            kind: 'viewGroup',
            connectionId: node.connectionId,
            database: node.database,
            count: views.length
          },
          {
            kind: 'functionGroup',
            connectionId: node.connectionId,
            database: node.database,
            count: funcs.length
          },
          {
            kind: 'procedureGroup',
            connectionId: node.connectionId,
            database: node.database,
            count: procs.length
          }
        ];
      }

      if (node.kind === 'queryGroup') {
        const profile = this.store.get(node.connectionId);
        if (!profile) return [{ kind: 'message', label: 'No query files found.' }];
        const files = await this.queryStorage.listQueryFiles(profile, node.database);
        if (files.length === 0) {
          return [{ kind: 'message', label: 'No query files found.' }];
        }
        return files.map((file) => ({
          kind: 'queryFile',
          connectionId: node.connectionId,
          database: node.database,
          fileUri: vscode.Uri.file(file.path),
          fileName: file.name
        }));
      }

      if (node.kind === 'tableGroup') {
        const tables = await this.metadata.listTables(node.connectionId, node.database);
        if (tables.length === 0) {
          return [{ kind: 'message', label: 'No tables found.' }];
        }
        return tables.map((tableName) => ({
          kind: 'object',
          connectionId: node.connectionId,
          database: node.database,
          object: { name: tableName, type: 'table' }
        }));
      }

      if (node.kind === 'viewGroup') {
        const views = await this.metadata.listViews(node.connectionId, node.database);
        if (views.length === 0) {
          return [{ kind: 'message', label: 'No views found.' }];
        }
        return views.map((viewName) => ({
          kind: 'object',
          connectionId: node.connectionId,
          database: node.database,
          object: { name: viewName, type: 'view' }
        }));
      }

      if (node.kind === 'functionGroup') {
        const funcs = await this.metadata.listFunctions(node.connectionId, node.database);
        if (funcs.length === 0) {
          return [{ kind: 'message', label: 'No functions found.' }];
        }
        return funcs.map((fn) => ({
          kind: 'routine',
          connectionId: node.connectionId,
          database: node.database,
          routineType: 'function',
          name: fn
        }));
      }

      if (node.kind === 'procedureGroup') {
        const procs = await this.metadata.listProcedures(node.connectionId, node.database);
        if (procs.length === 0) {
          return [{ kind: 'message', label: 'No procedures found.' }];
        }
        return procs.map((proc) => ({
          kind: 'routine',
          connectionId: node.connectionId,
          database: node.database,
          routineType: 'procedure',
          name: proc
        }));
      }

      return [];
    } catch (error) {
      const connectionId = 'connectionId' in node ? node.connectionId : undefined;
      const password = connectionId ? await this.store.getPassword(connectionId) : undefined;
      const message = error instanceof Error ? error.message : String(error);
      return [{
        kind: 'message',
        label: `加载失败：${redactSensitiveText(message, password ? [password] : [])}`,
        connectionId
      }];
    }
  }
}
