import * as vscode from 'vscode';
import type { ConnectionStore } from '../connection/ConnectionStore.js';
import type { MysqlTreeNode, MysqlTreeProvider } from '../explorer/MysqlTreeProvider.js';
import type {
  TableMaintenanceOperation,
  TableMaintenanceSnapshot,
  TableMaintenanceService
} from '../maintenance/TableMaintenanceService.js';
import { confirmationPhrase, TableMaintenanceError } from '../maintenance/TableMaintenanceService.js';
import { redactSensitiveText } from '../security/redaction.js';
import type { SqlExportService } from '../transfer/SqlExportService.js';
import { chooseOutputPath } from './transferCommands.js';

interface MaintenanceCommandServices {
  store: ConnectionStore;
  maintenance: TableMaintenanceService;
  sql: SqlExportService;
  tree: MysqlTreeProvider;
  lock: MaintenanceCommandLock;
}

export interface MaintenanceCommandLock {
  running: boolean;
}

interface TableTarget {
  connectionId: string;
  database: string;
  table: string;
}

export function registerMaintenanceCommands(
  context: vscode.ExtensionContext,
  services: MaintenanceCommandServices
): void {
  const register = (command: string, operation: TableMaintenanceOperation): void => {
    context.subscriptions.push(vscode.commands.registerCommand(command, async (node?: MysqlTreeNode) => {
      const target = resolveTableTarget(node);
      if (!target) {
        void vscode.window.showErrorMessage('高风险维护只能从对象树中的单个基础表右键菜单启动。');
        return;
      }
      if (services.lock.running) {
        void vscode.window.showWarningMessage('已有单表高风险维护流程正在进行；请先完成或取消当前流程。');
        return;
      }
      services.lock.running = true;
      try {
        await runMaintenance(services, target, operation);
      } catch (error) {
        const password = await services.store.getPassword(target.connectionId);
        const detail = redactSensitiveText(error, password ? [password] : []);
        if ((error as Error).name === 'AbortError') {
          void vscode.window.showInformationMessage('维护前备份已取消；临时文件已清理，未执行维护语句。');
        } else if (error instanceof TableMaintenanceError && error.resultUnknown) {
          services.tree.refresh();
          void vscode.window.showErrorMessage(detail, { modal: true });
        } else {
          void vscode.window.showErrorMessage(detail);
        }
      } finally {
        services.lock.running = false;
      }
    }));
  };

  register('rindaMysql.truncateTable', 'truncate');
  register('rindaMysql.dropTable', 'drop');
}

async function runMaintenance(
  services: MaintenanceCommandServices,
  target: TableTarget,
  operation: TableMaintenanceOperation
): Promise<void> {
  const snapshot = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `正在分析 ${target.database}.${target.table} 的依赖与影响…`,
      cancellable: false
    },
    () => services.maintenance.analyze(target.connectionId, target.database, target.table, operation)
  );

  const proceed = await vscode.window.showWarningMessage(
    analysisMessage(snapshot),
    { modal: true },
    '继续并生成备份'
  );
  if (proceed !== '继续并生成备份') return;

  const selection = await chooseOutputPath('sql', target.database, `${target.table}-before-${operation}`);
  if (!selection) return;
  const exportResult = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `正在备份并验证 ${target.database}.${target.table}…`,
      cancellable: true
    },
    async (progress, token) => {
      const controller = new AbortController();
      const cancellation = token.onCancellationRequested(() => controller.abort());
      try {
        const result = await services.sql.export({
          connectionId: target.connectionId,
          scope: { kind: 'table', database: target.database, table: target.table },
          targetPath: selection.path,
          allowOverwrite: selection.allowOverwrite,
          signal: controller.signal,
          onProgress: ({ message }) => progress.report({ message })
        });
        progress.report({ message: '正在回读并核对备份范围与 SHA-256…' });
        const backup = await services.maintenance.verifyBackup(snapshot, result.targetPath, result.sha256);
        return { result, backup };
      } finally {
        cancellation.dispose();
      }
    }
  );

  const phrase = confirmationPhrase(operation, target.database, target.table);
  const firstConfirmation = await vscode.window.showInputBox({
    title: '第一层确认：精确目标',
    prompt: [
      `备份已验证：${exportResult.backup.path}`,
      `SHA-256：${exportResult.backup.sha256}`,
      exportResult.backup.standalone
        ? '恢复策略：该包可独立恢复。'
        : `恢复策略：该包依赖现有对象（${exportResult.backup.restoreReasons.join('；')}）；备份完整性已验证，但不能恢复到完全空库。`,
      `请输入 ${phrase}`
    ].join('\n'),
    placeHolder: phrase,
    ignoreFocusOut: true,
    validateInput: (value) => value === phrase ? undefined : `必须完整输入：${phrase}`
  });
  if (firstConfirmation === undefined) return;

  const authorization = services.maintenance.authorize(
    snapshot,
    exportResult.backup,
    firstConfirmation
  );
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
      title: `正在执行 ${phrase}…`,
      cancellable: false
    },
    () => services.maintenance.execute(authorization.token, finalConfirmation)
  );
  services.tree.refresh();
  void vscode.window.showInformationMessage(
    `${result.operation === 'truncate' ? '表已清空' : '表已删除'}：${result.database}.${result.table}（${result.durationMs} ms）。已刷新对象树；安全备份保留在 ${exportResult.backup.path}`
  );
}

function resolveTableTarget(node?: MysqlTreeNode): TableTarget | undefined {
  if (node?.kind !== 'object' || node.object.type !== 'table') return undefined;
  return { connectionId: node.connectionId, database: node.database, table: node.object.name };
}

function analysisMessage(snapshot: TableMaintenanceSnapshot): string {
  const action = snapshot.operation === 'truncate' ? '永久清空全部行并重置 AUTO_INCREMENT' : '永久删除表结构、数据、索引和触发器';
  const outbound = snapshot.outboundForeignKeys.length === 0
    ? '无'
    : snapshot.outboundForeignKeys.map((item) => `${item.schema}.${item.table}（${item.name}）`).join('、');
  const triggers = snapshot.triggers.length === 0 ? '无' : snapshot.triggers.join('、');
  const views = snapshot.referencingViews.length === 0
    ? '无'
    : snapshot.referencingViews.map((item) => `${item.schema}.${item.table}`).join('、');
  return [
    `目标：${snapshot.database}.${snapshot.table}`,
    `操作：${snapshot.operation === 'truncate' ? 'TRUNCATE TABLE' : 'DROP TABLE'}（${action}）`,
    `引擎：${snapshot.engine ?? '未知'}；估算行数：${snapshot.estimatedRows?.toLocaleString() ?? '未知'}；占用：${formatBytes((snapshot.dataBytes ?? 0) + (snapshot.indexBytes ?? 0))}`,
    `向外外键：${outbound}`,
    `引用视图：${views}`,
    `触发器：${triggers}${snapshot.operation === 'drop' && snapshot.triggers.length > 0 ? '（将随表删除）' : ''}`,
    '外部引用外键已核对为 0；DROP TABLE 还要求引用视图为 0。下一步必须先生成并回读验证单表 SQL 备份。',
    '扩展不会批量处理、CASCADE、关闭外键检查，也不会降级为 DELETE。'
  ].join('\n');
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}
