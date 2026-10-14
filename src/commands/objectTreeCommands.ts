import * as vscode from 'vscode';
import type { ConnectionStore } from '../connection/ConnectionStore.js';
import type { MysqlTreeNode, MysqlTreeProvider } from '../explorer/MysqlTreeProvider.js';
import type { QueryStorageService } from '../query/QueryStorageService.js';

interface ObjectTreeCommandServices {
  store: ConnectionStore;
  queryStorage: QueryStorageService;
  tree: MysqlTreeProvider;
}

export function registerObjectTreeCommands(
  context: vscode.ExtensionContext,
  services: ObjectTreeCommandServices
): void {
  // Create User template
  context.subscriptions.push(
    vscode.commands.registerCommand('rindaMysql.createUser', async (node?: MysqlTreeNode) => {
      const connectionId = node && 'connectionId' in node ? node.connectionId : undefined;
      const profile = connectionId ? services.store.get(connectionId) : services.store.list()[0];
      if (!profile) {
        void vscode.window.showErrorMessage('未找到有效的连接配置。');
        return;
      }
      try {
        const filePath = await services.queryStorage.createUserTemplateFile(profile);
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
        await vscode.window.showTextDocument(doc);
        await context.globalState.update('rindaMysql.lastConnectionId', profile.id);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        void vscode.window.showErrorMessage(`创建用户模板失败：${message}`);
      }
    })
  );

  // Refresh Users
  context.subscriptions.push(
    vscode.commands.registerCommand('rindaMysql.refreshUsers', (node?: MysqlTreeNode) => {
      services.tree.refresh(node);
    })
  );

  // Create Query file
  context.subscriptions.push(
    vscode.commands.registerCommand('rindaMysql.createQueryFile', async (node?: MysqlTreeNode) => {
      if (!node || node.kind !== 'queryGroup') {
        return;
      }
      const profile = services.store.get(node.connectionId);
      if (!profile) {
        void vscode.window.showErrorMessage('未找到该数据库连接配置。');
        return;
      }
      try {
        const filePath = await services.queryStorage.createQueryFile(profile, node.database);
        services.tree.refresh(node);
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
        await vscode.window.showTextDocument(doc);
        await context.globalState.update('rindaMysql.lastConnectionId', profile.id);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        void vscode.window.showErrorMessage(`创建查询文件失败：${message}`);
      }
    })
  );

  // Refresh Queries
  context.subscriptions.push(
    vscode.commands.registerCommand('rindaMysql.refreshQueries', (node?: MysqlTreeNode) => {
      services.tree.refresh(node);
    })
  );

  // Refresh Tables
  context.subscriptions.push(
    vscode.commands.registerCommand('rindaMysql.refreshTables', (node?: MysqlTreeNode) => {
      services.tree.refresh(node);
    })
  );

  // Create View template
  context.subscriptions.push(
    vscode.commands.registerCommand('rindaMysql.createView', async (node?: MysqlTreeNode) => {
      if (!node || node.kind !== 'viewGroup') return;
      const profile = services.store.get(node.connectionId);
      if (!profile) return;
      try {
        const filePath = await services.queryStorage.createViewTemplateFile(profile, node.database);
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
        await vscode.window.showTextDocument(doc);
        await context.globalState.update('rindaMysql.lastConnectionId', profile.id);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        void vscode.window.showErrorMessage(`创建视图模板失败：${message}`);
      }
    })
  );

  // Refresh Views
  context.subscriptions.push(
    vscode.commands.registerCommand('rindaMysql.refreshViews', (node?: MysqlTreeNode) => {
      services.tree.refresh(node);
    })
  );

  // Create Function template
  context.subscriptions.push(
    vscode.commands.registerCommand('rindaMysql.createFunction', async (node?: MysqlTreeNode) => {
      if (!node || node.kind !== 'functionGroup') return;
      const profile = services.store.get(node.connectionId);
      if (!profile) return;
      try {
        const filePath = await services.queryStorage.createFunctionTemplateFile(profile, node.database);
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
        await vscode.window.showTextDocument(doc);
        await context.globalState.update('rindaMysql.lastConnectionId', profile.id);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        void vscode.window.showErrorMessage(`创建函数模板失败：${message}`);
      }
    })
  );

  // Refresh Functions
  context.subscriptions.push(
    vscode.commands.registerCommand('rindaMysql.refreshFunctions', (node?: MysqlTreeNode) => {
      services.tree.refresh(node);
    })
  );

  // Create Procedure template
  context.subscriptions.push(
    vscode.commands.registerCommand('rindaMysql.createProcedure', async (node?: MysqlTreeNode) => {
      if (!node || node.kind !== 'procedureGroup') return;
      const profile = services.store.get(node.connectionId);
      if (!profile) return;
      try {
        const filePath = await services.queryStorage.createProcedureTemplateFile(profile, node.database);
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
        await vscode.window.showTextDocument(doc);
        await context.globalState.update('rindaMysql.lastConnectionId', profile.id);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        void vscode.window.showErrorMessage(`创建存储过程模板失败：${message}`);
      }
    })
  );

  // Refresh Procedures
  context.subscriptions.push(
    vscode.commands.registerCommand('rindaMysql.refreshProcedures', (node?: MysqlTreeNode) => {
      services.tree.refresh(node);
    })
  );

  // Delete Query File
  context.subscriptions.push(
    vscode.commands.registerCommand('rindaMysql.deleteQueryFile', async (node?: MysqlTreeNode) => {
      if (!node || node.kind !== 'queryFile') return;
      const confirm = await vscode.window.showWarningMessage(
        `确定要删除查询文件 "${node.fileName}" 吗？`,
        { modal: true },
        '确认删除'
      );
      if (confirm !== '确认删除') return;
      await services.queryStorage.deleteFile(node.fileUri.fsPath);
      services.tree.refresh();
      void vscode.window.showInformationMessage(`已删除 ${node.fileName}`);
    })
  );
}
