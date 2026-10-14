import { createReadStream } from 'node:fs';
import { lstat, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import * as vscode from 'vscode';
import type { ConnectionManager } from '../connection/ConnectionManager.js';
import type { ConnectionStore } from '../connection/ConnectionStore.js';
import type { MysqlTreeNode } from '../explorer/MysqlTreeProvider.js';
import type { MysqlTreeProvider } from '../explorer/MysqlTreeProvider.js';
import type { MetadataRepository } from '../explorer/metadataRepository.js';
import { redactSensitiveText } from '../security/redaction.js';
import { createCredentialFile } from '../transfer/CredentialFile.js';
import type { CsvExportService } from '../transfer/CsvExportService.js';
import type { MysqlClientResolver } from '../transfer/MySqlToolResolver.js';
import type { SqlExportService } from '../transfer/SqlExportService.js';
import { SqlRestoreError } from '../transfer/SqlRestoreService.js';
import type { SqlRestoreService, RestoreTargetMode } from '../transfer/SqlRestoreService.js';
import type { PreparedSqlPackage } from '../transfer/SqlPackage.js';
import type { ExportResult, MysqlClientTool, SqlExportScope } from '../transfer/types.js';
import { throwIfAborted } from '../transfer/types.js';

export interface TransferCommandServices {
  store: ConnectionStore;
  connections: ConnectionManager;
  metadata: MetadataRepository;
  sql: SqlExportService;
  csv: CsvExportService;
  restore: SqlRestoreService;
  clientResolver?: MysqlClientResolver;
  output?: vscode.OutputChannel;
  tree: MysqlTreeProvider;
  includeCsvBom: boolean;
}

interface DatabaseTarget {
  connectionId: string;
  database: string;
}

interface TableTarget extends DatabaseTarget {
  table: string;
}

export function registerTransferCommands(
  context: vscode.ExtensionContext,
  services: TransferCommandServices
): void {
  let transferRunning = false;

  const runExport = async (
    title: string,
    target: DatabaseTarget,
    extension: 'sql' | 'csv',
    operation: (path: string, allowOverwrite: boolean, signal: AbortSignal, report: (message: string) => void) => Promise<ExportResult>
  ): Promise<void> => {
    if (transferRunning) {
      void vscode.window.showWarningMessage('已有导出或恢复任务正在运行；当前版本一次只执行一个传输任务。');
      return;
    }
    const selection = await chooseOutputPath(extension, target.database, isTableTarget(target) ? target.table : undefined);
    if (!selection) return;
    transferRunning = true;
    try {
      const result = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title,
          cancellable: true
        },
        async (progress, token) => {
          const controller = new AbortController();
          const cancellation = token.onCancellationRequested(() => controller.abort());
          try {
            return await operation(selection.path, selection.allowOverwrite, controller.signal, (message) => {
              progress.report({ message });
            });
          } finally {
            cancellation.dispose();
          }
        }
      );
      const detail = extension === 'csv'
        ? `${result.rows?.toLocaleString() ?? 0} 行，${formatBytes(result.bytes)}`
        : `${formatBytes(result.bytes)}，SHA-256 ${result.sha256 ?? '不可用'}`;
      const action = await vscode.window.showInformationMessage(`导出完成：${detail}`, '在文件管理器中显示');
      if (action === '在文件管理器中显示') {
        await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(result.targetPath));
      }
      for (const warning of result.warnings) void vscode.window.showWarningMessage(warning);
    } catch (error) {
      if ((error as Error).name === 'AbortError') {
        void vscode.window.showInformationMessage('导出已取消，临时文件已清理。');
        return;
      }
      const password = await services.store.getPassword(target.connectionId);
      void vscode.window.showErrorMessage(
        `导出失败：${redactSensitiveText(error, password ? [password] : [])}`
      );
    } finally {
      transferRunning = false;
    }
  };

  context.subscriptions.push(vscode.commands.registerCommand('rindaMysql.exportDatabaseSql', async (node?: MysqlTreeNode) => {
    const target = await resolveDatabaseTarget(services, node);
    if (!target) return;
    const scope: SqlExportScope = { kind: 'database', database: target.database };
    await runExport(`正在导出数据库 ${target.database}…`, target, 'sql', (path, allowOverwrite, signal, report) =>
      services.sql.export({
        connectionId: target.connectionId,
        scope,
        targetPath: path,
        allowOverwrite,
        signal,
        onProgress: ({ message }) => report(message)
      }));
  }));

  context.subscriptions.push(vscode.commands.registerCommand('rindaMysql.exportTableSql', async (node?: MysqlTreeNode) => {
    const target = await resolveTableTarget(services, node);
    if (!target) return;
    const scope: SqlExportScope = { kind: 'table', database: target.database, table: target.table };
    await runExport(`正在导出表 ${target.database}.${target.table}…`, target, 'sql', (path, allowOverwrite, signal, report) =>
      services.sql.export({
        connectionId: target.connectionId,
        scope,
        targetPath: path,
        allowOverwrite,
        signal,
        onProgress: ({ message }) => report(message)
      }));
  }));

  context.subscriptions.push(vscode.commands.registerCommand('rindaMysql.exportTableCsv', async (node?: MysqlTreeNode) => {
    const target = await resolveTableTarget(services, node);
    if (!target) return;
    await runExport(`正在导出 CSV ${target.database}.${target.table}…`, target, 'csv', (path, allowOverwrite, signal, report) =>
      services.csv.export({
        connectionId: target.connectionId,
        database: target.database,
        table: target.table,
        targetPath: path,
        allowOverwrite,
        includeBom: services.includeCsvBom,
        signal,
        onProgress: ({ message }) => report(message)
      }));
  }));

  context.subscriptions.push(vscode.commands.registerCommand('rindaMysql.importDatabaseSql', async (node?: MysqlTreeNode) => {
    if (transferRunning) {
      void vscode.window.showWarningMessage('已有导出或恢复任务正在运行；当前版本一次只执行一个传输任务。');
      return;
    }
    const target = await resolveDatabaseTarget(services, node);
    if (!target) return;

    const source = await vscode.window.showOpenDialog({
      title: `选择要导入到 ${target.database} 的 SQL 文件`,
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: false,
      filters: { 'SQL 脚本文件 (*.sql)': ['sql'], '所有文件 (*.*)': ['*'] },
      openLabel: '导入到此数据库'
    });
    const uri = source?.[0];
    if (!uri) return;
    if (uri.scheme !== 'file') {
      void vscode.window.showErrorMessage('当前版本只接受本地 file: SQL 脚本文件。');
      return;
    }

    const statInfo = await lstat(uri.fsPath);
    if (statInfo.isDirectory()) {
      void vscode.window.showErrorMessage('请选择有效的 SQL 文件，不能选择目录。');
      return;
    }

    const fileName = uri.fsPath.split(/[\\/]/).pop() ?? 'SQL 文件';
    const fileSizeMb = (statInfo.size / (1024 * 1024)).toFixed(2);

    const confirmation = await vscode.window.showWarningMessage(
      `即将把 SQL 文件 "${fileName}" (${fileSizeMb} MB) 导入并执行到目标数据库 "${target.database}"。\n\n执行过程将运行其中的 SQL 语句并直接写入数据库。`,
      { modal: true },
      '确认导入'
    );
    if (confirmation !== '确认导入') return;

    transferRunning = true;
    try {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `正在将 ${fileName} 导入到 ${target.database}…`,
          cancellable: true
        },
        async (progress, token) => {
          const controller = new AbortController();
          const cancellation = token.onCancellationRequested(() => controller.abort());
          try {
            await executeSqlFileImport(services, target, uri.fsPath, controller.signal, (msg) => progress.report({ message: msg }));
          } finally {
            cancellation.dispose();
          }
        }
      );
      services.tree.refresh();
      void vscode.window.showInformationMessage(`SQL 文件 "${fileName}" 已成功导入到数据库 ${target.database}！已刷新对象树。`);
    } catch (error) {
      const password = await services.store.getPassword(target.connectionId);
      const detail = redactSensitiveText(error, password ? [password] : []);
      if ((error as Error).name === 'AbortError') {
        void vscode.window.showInformationMessage('导入已取消。');
      } else {
        void vscode.window.showErrorMessage(`导入到 ${target.database} 失败：${detail}`);
      }
    } finally {
      transferRunning = false;
    }
  }));

  context.subscriptions.push(vscode.commands.registerCommand('rindaMysql.restoreSqlPackage', async (node?: MysqlTreeNode) => {
    if (transferRunning) {
      void vscode.window.showWarningMessage('已有导出或恢复任务正在运行；当前版本一次只执行一个传输任务。');
      return;
    }
    const source = await vscode.window.showOpenDialog({
      title: '选择由 Rinda MySQL 0.3.1+ 生成的 SQL 包',
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: false,
      filters: { 'Rinda SQL 包': ['sql'] },
      openLabel: '校验并继续'
    });
    const uri = source?.[0];
    if (!uri) return;
    if (uri.scheme !== 'file') {
      void vscode.window.showErrorMessage('当前版本只接受 Extension Host 可访问的本地 file: SQL 包。');
      return;
    }

    transferRunning = true;
    let packageFile: PreparedSqlPackage | undefined;
    let connectionId: string | undefined;
    let failureStage = 'SQL 包校验阶段';
    try {
      packageFile = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: '正在校验并暂存 SQL 包…', cancellable: true },
        async (progress, token) => {
          const controller = new AbortController();
          const cancellation = token.onCancellationRequested(() => controller.abort());
          try {
            progress.report({ message: '核对格式、对象清单和 SHA-256…' });
            return await services.restore.preparePackage(uri.fsPath, controller.signal);
          } finally {
            cancellation.dispose();
          }
        }
      );
      failureStage = '目标选择阶段';
      connectionId = await chooseConnection(
        services.store,
        node && 'connectionId' in node ? node.connectionId : undefined,
        '选择恢复目标连接'
      );
      if (!connectionId) return;
      const target = await chooseRestoreTarget(services, connectionId);
      if (!target) return;
      failureStage = '恢复预检阶段';
      const preflight = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: '正在执行恢复预检…', cancellable: true },
        async (_progress, token) => {
          const controller = new AbortController();
          const cancellation = token.onCancellationRequested(() => controller.abort());
          try {
            return await services.restore.preflight(
              packageFile as PreparedSqlPackage,
              connectionId as string,
              target.database,
              target.mode,
              controller.signal
            );
          } finally {
            cancellation.dispose();
          }
        }
      );
      const scope = packageFile.metadata.scope.kind === 'database'
        ? `数据库 ${packageFile.metadata.scope.database}`
        : `表 ${packageFile.metadata.scope.database}.${packageFile.metadata.scope.table}`;
      const modeLabel = target.mode === 'create' ? '创建新数据库' : '使用已确认空数据库';
      const confirmation = await vscode.window.showWarningMessage(
        [
          `将把已验证的 Rinda SQL 包恢复到“${target.database}”。`,
          `来源：${scope}；来源版本：${packageFile.metadata.sourceServerVersion}。`,
          `目标：${modeLabel}；目标版本：${preflight.targetServerVersion}。`,
          '执行后若失败可能留下部分对象或数据；扩展不会自动回滚、重试或删除目标库。'
        ].join('\n'),
        { modal: true },
        '继续确认'
      );
      if (confirmation !== '继续确认') return;
      const phrase = `RESTORE ${target.database}`;
      const typed = await vscode.window.showInputBox({
        title: '最终确认受控 SQL 恢复',
        prompt: `请输入 ${phrase} 以开始恢复`,
        placeHolder: phrase,
        ignoreFocusOut: true,
        validateInput: (value) => value === phrase ? undefined : `必须完整输入：${phrase}`
      });
      if (typed !== phrase) return;

      failureStage = '恢复执行阶段';
      const result = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `正在恢复到 ${target.database}…`,
          cancellable: true
        },
        async (progress, token) => {
          const controller = new AbortController();
          const cancellation = token.onCancellationRequested(() => controller.abort());
          try {
            return await services.restore.restore({
              connectionId: connectionId as string,
              targetDatabase: target.database,
              targetMode: target.mode,
              package: packageFile as PreparedSqlPackage,
              signal: controller.signal,
              onProgress: ({ message }) => progress.report({ message })
            });
          } finally {
            cancellation.dispose();
          }
        }
      );
      services.tree.refresh();
      const objects = result.objects;
      void vscode.window.showInformationMessage(
        `恢复完成：${result.targetDatabase}（表 ${objects.tables}、视图 ${objects.views}、例程 ${objects.routines}、事件 ${objects.events}、触发器 ${objects.triggers}，${result.durationMs} ms）`
      );
      for (const warning of result.warnings) void vscode.window.showWarningMessage(warning);
    } catch (error) {
      const password = connectionId ? await services.store.getPassword(connectionId) : undefined;
      const detail = redactSensitiveText(error, password ? [password] : []);
      if (error instanceof SqlRestoreError) {
        void vscode.window.showErrorMessage(
          `${detail}\n${error.guidance}`,
          { modal: error.partialSuccess }
        );
      } else if ((error as Error).name === 'AbortError') {
        void vscode.window.showInformationMessage('SQL 包校验或预检已取消；未执行恢复语句。');
      } else {
        void vscode.window.showErrorMessage(`${failureStage}失败：${detail}`);
      }
    } finally {
      await packageFile?.cleanup();
      transferRunning = false;
    }
  }));
}

async function resolveDatabaseTarget(
  services: Pick<TransferCommandServices, 'store' | 'metadata'>,
  node?: MysqlTreeNode
): Promise<DatabaseTarget | undefined> {
  if (node?.kind === 'database') return { connectionId: node.connectionId, database: node.database };
  if (node?.kind === 'object') return { connectionId: node.connectionId, database: node.database };
  const connectionId = await chooseConnection(services.store, node && 'connectionId' in node ? node.connectionId : undefined);
  if (!connectionId) return undefined;
  try {
    const databases = await services.metadata.listDatabases(connectionId);
    const database = await vscode.window.showQuickPick(databases, {
      title: '选择要导出的数据库',
      placeHolder: '数据库'
    });
    return database ? { connectionId, database } : undefined;
  } catch (error) {
    const password = await services.store.getPassword(connectionId);
    void vscode.window.showErrorMessage(`无法读取数据库：${redactSensitiveText(error, password ? [password] : [])}`);
    return undefined;
  }
}

async function resolveTableTarget(
  services: Pick<TransferCommandServices, 'store' | 'metadata'>,
  node?: MysqlTreeNode
): Promise<TableTarget | undefined> {
  if (node?.kind === 'object' && node.object.type === 'table') {
    return { connectionId: node.connectionId, database: node.database, table: node.object.name };
  }
  const databaseTarget = await resolveDatabaseTarget(services, node);
  if (!databaseTarget) return undefined;
  try {
    const tables = (await services.metadata.listObjects(databaseTarget.connectionId, databaseTarget.database))
      .filter((object) => object.type === 'table');
    if (tables.length === 0) {
      void vscode.window.showInformationMessage('该数据库没有可导出的基础表。');
      return undefined;
    }
    const selected = await vscode.window.showQuickPick(
      tables.map((table) => ({ label: table.name, table: table.name })),
      { title: `选择 ${databaseTarget.database} 中要导出的表`, placeHolder: '基础表' }
    );
    return selected ? { ...databaseTarget, table: selected.table } : undefined;
  } catch (error) {
    const password = await services.store.getPassword(databaseTarget.connectionId);
    void vscode.window.showErrorMessage(`无法读取表：${redactSensitiveText(error, password ? [password] : [])}`);
    return undefined;
  }
}

async function chooseConnection(
  store: ConnectionStore,
  preferredId?: string,
  title = '选择导出源连接'
): Promise<string | undefined> {
  const profiles = store.list();
  if (profiles.length === 0) {
    void vscode.window.showInformationMessage('请先新建 MySQL 连接。');
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
    { title, ignoreFocusOut: true }
  );
  return selected?.id;
}

async function chooseRestoreTarget(
  services: Pick<TransferCommandServices, 'metadata' | 'store'>,
  connectionId: string
): Promise<{ mode: RestoreTargetMode; database: string } | undefined> {
  const mode = await vscode.window.showQuickPick([
    {
      label: '$(new-folder) 创建新目标数据库',
      description: '目标名称必须尚不存在',
      mode: 'create' as const
    },
    {
      label: '$(database) 使用已存在且为空的数据库',
      description: '执行前会再次核对所有对象类型均为空',
      mode: 'empty' as const
    }
  ], {
    title: '选择受控恢复目标模式',
    ignoreFocusOut: true
  });
  if (!mode) return undefined;
  if (mode.mode === 'create') {
    const database = await vscode.window.showInputBox({
      title: '新目标数据库名称',
      prompt: '该数据库必须尚不存在；创建字符集固定为 utf8mb4',
      ignoreFocusOut: true,
      validateInput: validateDatabaseInput
    });
    return database ? { mode: 'create', database } : undefined;
  }
  try {
    const databases = (await services.metadata.listDatabases(connectionId))
      .filter((database) => !['information_schema', 'mysql', 'performance_schema', 'sys'].includes(database.toLowerCase()));
    const database = await vscode.window.showQuickPick(databases, {
      title: '选择已存在的空目标数据库',
      placeHolder: '预检会拒绝包含任何表、视图、例程、事件或触发器的数据库',
      ignoreFocusOut: true
    });
    return database ? { mode: 'empty', database } : undefined;
  } catch (error) {
    const password = await services.store.getPassword(connectionId);
    void vscode.window.showErrorMessage(`无法读取目标数据库：${redactSensitiveText(error, password ? [password] : [])}`);
    return undefined;
  }
}

function validateDatabaseInput(value: string): string | undefined {
  if (!value) return '请输入数据库名称。';
  if (value.length > 64) return '数据库名称不能超过 64 个字符。';
  if (value.includes('\0') || /[\r\n]/.test(value) || value.startsWith('-')) return '数据库名称包含不安全字符。';
  if (['information_schema', 'mysql', 'performance_schema', 'sys'].includes(value.toLowerCase())) {
    return '不能使用系统数据库。';
  }
  return undefined;
}

export async function chooseOutputPath(
  extension: 'sql' | 'csv',
  database: string,
  table?: string
): Promise<{ path: string; allowOverwrite: boolean } | undefined> {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const base = [database, table, timestamp]
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .map(safeFilenamePart)
    .join('-');
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  const storageDirName = vscode.workspace.getConfiguration('rindaMysql').get<string>('storageDirectory', '.rinda') || '.rinda';
  let defaultDir = homedir();
  if (workspaceFolder && workspaceFolder.uri.scheme === 'file') {
    defaultDir = join(workspaceFolder.uri.fsPath, storageDirName, extension === 'sql' ? 'dumps' : 'exports');
  }
  const uri = await vscode.window.showSaveDialog({
    title: extension === 'sql' ? '保存 SQL 导出' : '保存 CSV 导出',
    defaultUri: vscode.Uri.file(join(defaultDir, `${base}.${extension}`)),
    filters: extension === 'sql' ? { 'SQL 文件': ['sql'] } : { 'CSV 文件': ['csv'] },
    saveLabel: '导出'
  });
  if (!uri) return undefined;
  if (uri.scheme !== 'file') {
    void vscode.window.showErrorMessage('当前版本只支持导出到 Extension Host 可访问的本地 file: 路径。');
    return undefined;
  }
  let exists = false;
  try {
    const details = await lstat(uri.fsPath);
    if (details.isSymbolicLink() || !details.isFile()) {
      void vscode.window.showErrorMessage('导出目标必须是普通文件，不能是目录、设备或符号链接。');
      return undefined;
    }
    exists = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (exists) {
    const confirmation = await vscode.window.showWarningMessage(
      `文件“${uri.fsPath}”已存在。确认覆盖吗？`,
      { modal: true },
      '覆盖'
    );
    if (confirmation !== '覆盖') return undefined;
  }
  return { path: uri.fsPath, allowOverwrite: exists };
}

function safeFilenamePart(value: string): string {
  const sanitized = value.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/^\.+$/, '_');
  return sanitized.slice(0, 80) || 'export';
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

function isTableTarget(target: DatabaseTarget): target is TableTarget {
  return 'table' in target && typeof (target as Partial<TableTarget>).table === 'string';
}

async function executeSqlFileImport(
  services: TransferCommandServices,
  target: DatabaseTarget,
  filePath: string,
  signal: AbortSignal,
  report: (message: string) => void
): Promise<void> {
  throwIfAborted(signal);
  report('正在准备导入…');

  const profile = services.store.getRequired(target.connectionId);
  const password = await services.store.getPassword(target.connectionId) ?? '';

  let usedCli = false;
  if (services.clientResolver) {
    try {
      const client = await services.clientResolver.resolve(signal);
      const credential = await createCredentialFile(profile, password, client.vendor);
      try {
        report('正在通过 MySQL 客户端执行流式导入…');
        await runMysqlImport(client, credential.path, target.database, filePath, password, signal);
        usedCli = true;
      } finally {
        await credential.cleanup();
      }
    } catch (cliErr) {
      if ((cliErr as Error).name === 'AbortError') throw cliErr;
      services.output?.appendLine(`[导入] mysql 客户端不可用，转用连接驱动执行：${cliErr instanceof Error ? cliErr.message : String(cliErr)}`);
    }
  }

  if (!usedCli) {
    report('正在读取 SQL 文件内容…');
    const content = await readFile(filePath, 'utf8');
    throwIfAborted(signal);
    report('正在执行 SQL 语句…');
    await services.connections.executeScript(target.connectionId, target.database, content, signal);
  }
}

async function runMysqlImport(
  tool: MysqlClientTool,
  credentialPath: string,
  targetDatabase: string,
  filePath: string,
  password: string,
  signal?: AbortSignal
): Promise<void> {
  throwIfAborted(signal);
  const child = spawn(
    tool.path,
    [
      `--defaults-extra-file=${credentialPath}`,
      '--protocol=TCP',
      '--default-character-set=utf8mb4',
      '--binary-mode',
      '--show-warnings',
      '--batch',
      `--database=${targetDatabase}`
    ],
    { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }
  );

  const stderr: Buffer[] = [];
  let stderrBytes = 0;
  let forceKill: NodeJS.Timeout | undefined;
  const abort = (): void => {
    child.kill('SIGTERM');
    forceKill = setTimeout(() => child.kill('SIGKILL'), 2000);
    forceKill.unref();
  };
  signal?.addEventListener('abort', abort, { once: true });

  child.stderr.on('data', (chunk: Buffer) => {
    if (stderrBytes >= 65536) return;
    const kept = chunk.subarray(0, 65536 - stderrBytes);
    stderr.push(kept);
    stderrBytes += kept.length;
  });

  const exit = new Promise<{ code: number | null; error?: Error }>((resolve) => {
    child.once('error', (error) => resolve({ code: null, error }));
    child.once('close', (code) => resolve({ code }));
  });

  const input = pipeline(
    createReadStream(filePath),
    child.stdin
  ).catch((err: unknown) => err as Error);

  try {
    const result = await exit;
    const inputErr = await input;
    throwIfAborted(signal);
    if (result.error) throw result.error;
    if (result.code !== 0) {
      const errText = redactSensitiveText(Buffer.concat(stderr).toString('utf8').trim(), password ? [password] : []);
      throw new Error(`mysql 导入返回错误（退出码 ${result.code}）：${errText || '未知错误'}`);
    }
    if (inputErr instanceof Error) throw inputErr;
  } finally {
    signal?.removeEventListener('abort', abort);
    if (forceKill) clearTimeout(forceKill);
  }
}
