import * as vscode from 'vscode';
import type { ConnectionManager } from '../connection/ConnectionManager.js';
import type { ConnectionStore } from '../connection/ConnectionStore.js';
import type { ConnectionProfile } from '../connection/types.js';
import type { MysqlTreeNode, MysqlTreeProvider } from '../explorer/MysqlTreeProvider.js';
import { redactSensitiveText } from '../security/redaction.js';
import { ConnectionFormPanel } from '../webview/ConnectionFormPanel.js';

interface ConnectionCommandServices {
  store: ConnectionStore;
  connections: ConnectionManager;
  tree: MysqlTreeProvider;
}

export function registerConnectionCommands(
  context: vscode.ExtensionContext,
  services: ConnectionCommandServices
): void {
  const register = (command: string, callback: (...args: any[]) => unknown): void => {
    context.subscriptions.push(vscode.commands.registerCommand(command, callback));
  };

  register('rindaMysql.addConnection', async () => {
    const draft = await ConnectionFormPanel.show();
    if (!draft || draft.password === undefined) return;
    const profile = await services.store.create({ ...draft, password: draft.password });
    await updateConnectionContext(services.store);
    services.tree.refresh();
    const selection = await vscode.window.showInformationMessage(
      `已保存连接“${profile.name}”。`,
      '测试连接'
    );
    if (selection === '测试连接') {
      await vscode.commands.executeCommand('rindaMysql.testConnection', connectionNode(profile));
    }
  });

  register('rindaMysql.editConnection', async (node?: MysqlTreeNode) => {
    const profile = await resolveProfile(services.store, node);
    if (!profile) return;
    const draft = await ConnectionFormPanel.show(profile);
    if (!draft) return;
    await services.connections.reset(profile.id);
    await services.store.update(profile.id, draft);
    services.tree.refresh();
    void vscode.window.showInformationMessage(`已更新连接“${draft.name}”。`);
  });

  register('rindaMysql.deleteConnection', async (node?: MysqlTreeNode) => {
    const profile = await resolveProfile(services.store, node);
    if (!profile) return;
    const confirmation = await vscode.window.showWarningMessage(
      `确定删除连接“${profile.name}”吗？密码也会从 SecretStorage 删除。`,
      { modal: true },
      '删除'
    );
    if (confirmation !== '删除') return;
    await services.connections.disconnect(profile.id);
    await services.store.remove(profile.id);
    await updateConnectionContext(services.store);
    services.tree.refresh();
  });

  register('rindaMysql.testConnection', async (node?: MysqlTreeNode) => {
    const profile = await resolveProfile(services.store, node);
    if (!profile) return;
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `正在测试 ${profile.name}…` },
      async () => {
        try {
          const duration = await services.connections.test(profile.id);
          services.tree.refresh();
          void vscode.window.showInformationMessage(`连接成功：${profile.name}（${duration} ms）`);
        } catch (error) {
          const password = await services.store.getPassword(profile.id);
          void vscode.window.showErrorMessage(
            `连接失败：${redactSensitiveText(error, password ? [password] : [])}`
          );
        }
      }
    );
  });

  register('rindaMysql.connect', async (node?: MysqlTreeNode) => {
    const profile = await resolveProfile(services.store, node);
    if (!profile) return;
    try {
      await services.connections.connect(profile.id);
      services.tree.refresh();
    } catch (error) {
      const password = await services.store.getPassword(profile.id);
      void vscode.window.showErrorMessage(
        `无法连接：${redactSensitiveText(error, password ? [password] : [])}`
      );
    }
  });

  register('rindaMysql.disconnect', async (node?: MysqlTreeNode) => {
    const profile = await resolveProfile(services.store, node);
    if (!profile) return;
    await services.connections.disconnect(profile.id);
    services.tree.refresh();
  });

  register('rindaMysql.createDatabase', async (node?: MysqlTreeNode) => {
    let connectionId: string | undefined;
    if (node && 'connectionId' in node && node.connectionId) {
      connectionId = node.connectionId;
    } else {
      const profile = await resolveProfile(services.store, node);
      connectionId = profile?.id;
    }
    if (!connectionId) return;

    const profile = services.store.get(connectionId);
    if (!profile) return;

    const dbName = await vscode.window.showInputBox({
      title: `新建数据库 · ${profile.name}`,
      prompt: '请输入新数据库名称',
      placeHolder: '例如：app_db',
      ignoreFocusOut: true,
      validateInput: (value) => {
        const trimmed = value.trim();
        if (!trimmed) return '数据库名称不能为空';
        if (trimmed.length > 64) return '数据库名称不能超过 64 个字符';
        if (/[/\\.\0]/.test(trimmed)) return '数据库名称不能包含 / \\ . 或空字符';
        return undefined;
      }
    });
    if (!dbName || !dbName.trim()) return;
    const cleanDbName = dbName.trim();

    const charsets = [
      { label: 'utf8mb4', description: '推荐 · 支持 Emoji 和完整 4 字节 Unicode 字符' },
      { label: 'utf8', description: '3 字节 UTF-8 (utf8mb3)' },
      { label: 'gbk', description: '简体中文 GBK 编码' },
      { label: 'latin1', description: 'ISO 8859-1 西欧字符' }
    ];
    const selectedCharset = await vscode.window.showQuickPick(charsets, {
      title: '选择数据库字符集 (Character Set)',
      ignoreFocusOut: true
    });
    if (!selectedCharset) return;
    const charset = selectedCharset.label;

    const collationMap: Record<string, Array<{ label: string; description: string }>> = {
      utf8mb4: [
        { label: 'utf8mb4_unicode_ci', description: '推荐 · 基于 Unicode 标准排序规则，大小写不敏感' },
        { label: 'utf8mb4_general_ci', description: '通用排序规则，执行性能高' },
        { label: 'utf8mb4_0900_ai_ci', description: 'MySQL 8.0 默认 Unicode 9.0 排序规则' },
        { label: 'utf8mb4_bin', description: '二进制排序规则，区分大小写' }
      ],
      utf8: [
        { label: 'utf8_general_ci', description: '通用快速排序规则，大小写不敏感' },
        { label: 'utf8_unicode_ci', description: '标准 Unicode 排序规则' },
        { label: 'utf8_bin', description: '二进制区分大小写' }
      ],
      gbk: [
        { label: 'gbk_chinese_ci', description: 'GBK 中文拼音排序规则' },
        { label: 'gbk_bin', description: '二进制区分大小写' }
      ],
      latin1: [
        { label: 'latin1_swedish_ci', description: 'Latin1 默认瑞典语排序规则' },
        { label: 'latin1_general_ci', description: 'Latin1 通用排序规则' },
        { label: 'latin1_bin', description: '二进制区分大小写' }
      ]
    };
    const collations = collationMap[charset] ?? [
      { label: `${charset}_general_ci`, description: '默认通用排序规则' }
    ];
    const selectedCollation = await vscode.window.showQuickPick(collations, {
      title: '选择数据库排序规则 (Collation)',
      ignoreFocusOut: true
    });
    if (!selectedCollation) return;
    const collation = selectedCollation.label;

    const escapedName = cleanDbName.replace(/`/g, '``');
    const sql = `CREATE DATABASE \`${escapedName}\` CHARACTER SET ${charset} COLLATE ${collation};`;

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `正在 ${profile.name} 上创建数据库 ${cleanDbName}…`
      },
      async () => {
        try {
          await services.connections.withConnection(connectionId, async (connection) => {
            await connection.query(sql);
          });
          services.tree.refresh();
          void vscode.window.showInformationMessage(`数据库“${cleanDbName}”创建成功！(字符集: ${charset}, 排序: ${collation})`);
        } catch (error) {
          const password = await services.store.getPassword(connectionId);
          const detail = redactSensitiveText(error, password ? [password] : []);
          void vscode.window.showErrorMessage(`创建数据库失败：${detail}`);
        }
      }
    );
  });

  register('rindaMysql.refresh', () => services.tree.refresh());
}

export function updateConnectionContext(store: ConnectionStore): Thenable<unknown> {
  return vscode.commands.executeCommand('setContext', 'rindaMysql.hasConnections', store.list().length > 0);
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

function connectionNode(profile: ConnectionProfile): MysqlTreeNode {
  return { kind: 'connection', connectionId: profile.id, profile };
}
