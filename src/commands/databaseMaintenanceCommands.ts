import * as vscode from 'vscode';
import type { ConnectionStore } from '../connection/ConnectionStore.js';
import type { MysqlTreeNode, MysqlTreeProvider } from '../explorer/MysqlTreeProvider.js';
import type { DatabaseMaintenanceService } from '../maintenance/DatabaseMaintenanceService.js';
import { DatabaseMaintenanceError } from '../maintenance/DatabaseMaintenanceService.js';
import { buildDatabaseImpactReport, formatDatabaseBytes } from '../maintenance/databaseImpactReport.js';
import { redactSensitiveText } from '../security/redaction.js';
import type { SqlExportService } from '../transfer/SqlExportService.js';
import type { MaintenanceCommandLock } from './maintenanceCommands.js';
import { chooseOutputPath } from './transferCommands.js';

interface DatabaseMaintenanceCommandServices {
  store: ConnectionStore;
  maintenance: DatabaseMaintenanceService;
  sql: SqlExportService;
  tree: MysqlTreeProvider;
  lock: MaintenanceCommandLock;
}

export function registerDatabaseMaintenanceCommands(
  context: vscode.ExtensionContext,
  services: DatabaseMaintenanceCommandServices
): void {
  context.subscriptions.push(vscode.commands.registerCommand(
    'rindaMysql.dropDatabase',
    async (node?: MysqlTreeNode) => {
      if (node?.kind !== 'database') {
        void vscode.window.showErrorMessage('DROP DATABASE 只能从对象树中的单个数据库右键菜单启动。');
        return;
      }
      if (services.lock.running) {
        void vscode.window.showWarningMessage('已有高风险维护流程正在进行；请先完成或取消当前流程。');
        return;
      }
      services.lock.running = true;
      try {
        await runDropDatabase(services, node.connectionId, node.database);
      } catch (error) {
        const password = await services.store.getPassword(node.connectionId);
        const detail = redactSensitiveText(error, password ? [password] : []);
        if ((error as Error).name === 'AbortError') {
          void vscode.window.showInformationMessage('全库备份已取消；临时文件已清理，未执行 DROP DATABASE。');
        } else if (error instanceof DatabaseMaintenanceError && error.resultUnknown) {
          services.tree.refresh();
          void vscode.window.showErrorMessage(detail, { modal: true });
        } else {
          void vscode.window.showErrorMessage(detail);
        }
      } finally {
        services.lock.running = false;
      }
    }
  ));
}

async function runDropDatabase(
  services: DatabaseMaintenanceCommandServices,
  connectionId: string,
  database: string
): Promise<void> {
  const snapshot = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `正在完整分析数据库 ${database}…`,
      cancellable: false
    },
    () => services.maintenance.analyze(connectionId, database)
  );
  const report = await vscode.workspace.openTextDocument({
    language: 'markdown',
    content: buildDatabaseImpactReport(snapshot)
  });
  await vscode.window.showTextDocument(report, { preview: true, viewColumn: vscode.ViewColumn.Beside });

  const proceed = await vscode.window.showWarningMessage(
    [
      `将永久删除数据库“${database}”。完整影响清单已在编辑器中打开。`,
      `对象：表 ${snapshot.summary.tables}、视图 ${snapshot.summary.views}、例程 ${snapshot.summary.routines}、事件 ${snapshot.summary.events}、触发器 ${snapshot.summary.triggers}。`,
      `估算行数 ${snapshot.estimatedRows.toLocaleString()}；表数据与索引约 ${formatDatabaseBytes(snapshot.dataBytes + snapshot.indexBytes)}。`,
      '下一步必须先生成并回读验证完整 SQL 备份；扩展不会批量处理、CASCADE、关闭外键检查或自动重试。'
    ].join('\n'),
    { modal: true },
    '继续并生成全库备份'
  );
  if (proceed !== '继续并生成全库备份') return;

  const selection = await chooseOutputPath('sql', database, 'before-drop-database');
  if (!selection) return;
  const exported = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `正在完整备份并验证数据库 ${database}…`,
      cancellable: true
    },
    async (progress, token) => {
      const controller = new AbortController();
      const cancellation = token.onCancellationRequested(() => controller.abort());
      try {
        const result = await services.sql.export({
          connectionId,
          scope: { kind: 'database', database },
          targetPath: selection.path,
          allowOverwrite: selection.allowOverwrite,
          signal: controller.signal,
          onProgress: ({ message }) => progress.report({ message })
        });
        progress.report({ message: '正在回读并核对全库范围、对象清单与 SHA-256…' });
        const backup = await services.maintenance.verifyBackup(snapshot, result.targetPath, result.sha256);
        return { result, backup };
      } finally {
        cancellation.dispose();
      }
    }
  );

  const exactDatabaseName = await vscode.window.showInputBox({
    title: '第一层确认：精确数据库名',
    prompt: [
      `完整备份已验证：${exported.backup.path}`,
      `SHA-256：${exported.backup.sha256}`,
      exported.backup.standalone
        ? '恢复策略：该全库包可独立恢复。'
        : `恢复策略：该包依赖外部对象（${exported.backup.restoreReasons.join('；')}）。`,
      `请输入数据库名：${database}`
    ].join('\n'),
    placeHolder: database,
    ignoreFocusOut: true,
    validateInput: (value) => value === database ? undefined : `必须完整输入数据库名：${database}`
  });
  if (exactDatabaseName === undefined) return;

  const authorization = services.maintenance.authorize(snapshot, exported.backup, exactDatabaseName);
  const finalConfirmation = await vscode.window.showInputBox({
    title: '第二层确认：限时一次性 token',
    prompt: `授权将在 ${new Date(authorization.expiresAt).toLocaleTimeString()} 过期。请完整输入：${authorization.finalPhrase}`,
    placeHolder: authorization.finalPhrase,
    ignoreFocusOut: true,
    validateInput: (value) => value === authorization.finalPhrase
      ? undefined
      : `必须完整输入：${authorization.finalPhrase}`
  });
  if (finalConfirmation === undefined) return;

  const result = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `正在执行 DROP DATABASE ${database}…`,
      cancellable: false
    },
    () => services.maintenance.execute(authorization.token, finalConfirmation)
  );
  services.tree.refresh();
  void vscode.window.showInformationMessage(
    `数据库已删除：${result.database}（${result.durationMs} ms）。对象树已刷新；完整备份保留在 ${exported.backup.path}`
  );
}
