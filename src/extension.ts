import * as path from 'node:path';
import * as vscode from 'vscode';
import { registerConnectionCommands, updateConnectionContext } from './commands/connectionCommands.js';
import { registerDatabaseMaintenanceCommands } from './commands/databaseMaintenanceCommands.js';
import { registerMaintenanceCommands } from './commands/maintenanceCommands.js';
import type { MaintenanceCommandLock } from './commands/maintenanceCommands.js';
import { registerMonitorCommands } from './commands/monitorCommands.js';
import { registerObjectTreeCommands } from './commands/objectTreeCommands.js';
import { registerQueryCommands } from './commands/queryCommands.js';
import { registerTableDesignCommands } from './commands/tableDesignCommands.js';
import { registerTransferCommands } from './commands/transferCommands.js';
import { ConnectionManager } from './connection/ConnectionManager.js';
import { ConnectionStore } from './connection/ConnectionStore.js';
import { TableDesignerService } from './design/TableDesignerService.js';
import { RowMutationService } from './editing/RowMutationService.js';
import { TableEditingService } from './editing/TableEditingService.js';
import { TableMetadataRepository } from './editing/TableMetadataRepository.js';
import { MetadataRepository } from './explorer/metadataRepository.js';
import { DatabaseMaintenanceService } from './maintenance/DatabaseMaintenanceService.js';
import { TableMaintenanceService } from './maintenance/TableMaintenanceService.js';
import { MysqlTreeProvider } from './explorer/MysqlTreeProvider.js';
import { QueryService } from './query/QueryService.js';
import { QueryStorageService } from './query/QueryStorageService.js';
import { ProcesslistService } from './monitor/ProcesslistService.js';
import { CsvExportService } from './transfer/CsvExportService.js';
import { MysqlClientResolver, MySqlToolResolver } from './transfer/MySqlToolResolver.js';
import { SqlExportService } from './transfer/SqlExportService.js';
import { SqlRestoreService } from './transfer/SqlRestoreService.js';
import { SqlCompletionItemProvider } from './completion/SqlCompletionItemProvider.js';

let connectionManager: ConnectionManager | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const output = vscode.window.createOutputChannel('Rinda MySQL');
  const store = new ConnectionStore(context.globalState, context.secrets);
  connectionManager = new ConnectionManager(store, output);
  const metadata = new MetadataRepository(connectionManager);
  const getStorageRoot = (): string => {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    const storageDirName = vscode.workspace.getConfiguration('rindaMysql').get<string>('storageDirectory', '.rinda') || '.rinda';
    if (workspaceFolder && workspaceFolder.uri.scheme === 'file') {
      return path.join(workspaceFolder.uri.fsPath, storageDirName);
    }
    return context.globalStorageUri.fsPath;
  };
  const queryStorage = new QueryStorageService(getStorageRoot, context.globalStorageUri.fsPath);
  const tree = new MysqlTreeProvider(store, connectionManager, metadata, queryStorage);
  const configuration = vscode.workspace.getConfiguration('rindaMysql');
  const timeoutMs = configuration.get<number>('queryTimeout', 30_000);
  const maximumRows = Math.min(500, Math.max(10, configuration.get<number>('maxRows', 500)));
  const query = new QueryService(connectionManager, timeoutMs, maximumRows);
  const editMetadata = new TableMetadataRepository(connectionManager);
  const mutations = new RowMutationService(connectionManager, editMetadata, timeoutMs);
  const editing = new TableEditingService(query, editMetadata, mutations);
  const toolResolver = new MySqlToolResolver(configuration.get<string>('mysqldumpPath', ''));
  const sqlExport = new SqlExportService(store, connectionManager, toolResolver, output);
  const csvExport = new CsvExportService(connectionManager, output);
  const clientResolver = new MysqlClientResolver(configuration.get<string>('mysqlPath', ''));
  const sqlRestore = new SqlRestoreService(store, connectionManager, clientResolver, output);
  const maintenance = new TableMaintenanceService(connectionManager, output);
  const databaseMaintenance = new DatabaseMaintenanceService(
    store,
    connectionManager,
    output,
    configuration.get<string[]>('protectedDatabases', [])
  );
  const tableDesigner = new TableDesignerService(connectionManager);
  const maintenanceLock: MaintenanceCommandLock = { running: false };

  context.subscriptions.push(
    output,
    vscode.window.createTreeView('rindaMysql.connections', {
      treeDataProvider: tree,
      showCollapseAll: true
    })
  );
  registerConnectionCommands(context, { store, connections: connectionManager, tree });
  registerQueryCommands(context, { store, query, metadata, editing, queryStorage, tree });
  registerTableDesignCommands(context, { store, metadata, designer: tableDesigner, tree });
  registerObjectTreeCommands(context, { store, queryStorage, tree });
  registerTransferCommands(context, {
    store,
    connections: connectionManager,
    metadata,
    sql: sqlExport,
    csv: csvExport,
    restore: sqlRestore,
    clientResolver,
    output,
    tree,
    includeCsvBom: configuration.get<boolean>('csvIncludeBom', false)
  });
  registerMaintenanceCommands(context, { store, maintenance, sql: sqlExport, tree, lock: maintenanceLock });
  registerDatabaseMaintenanceCommands(context, {
    store,
    maintenance: databaseMaintenance,
    sql: sqlExport,
    tree,
    lock: maintenanceLock
  });
  const processlist = new ProcesslistService(connectionManager);
  registerMonitorCommands(context, { store, processlist });
  const completionProvider = new SqlCompletionItemProvider(store, metadata, context.globalState);
  context.subscriptions.push(
    vscode.languages.registerCompletionItemProvider(
      { scheme: 'file', language: 'sql' },
      completionProvider,
      '.', ' ', '`'
    ),
    vscode.languages.registerCompletionItemProvider(
      { scheme: 'untitled', language: 'sql' },
      completionProvider,
      '.', ' ', '`'
    )
  );
  await updateConnectionContext(store);
  output.appendLine(`Rinda MySQL 已激活，最大结果行数 ${maximumRows}，查询超时 ${timeoutMs} ms。`);
}

export async function deactivate(): Promise<void> {
  await connectionManager?.dispose();
  connectionManager = undefined;
}
