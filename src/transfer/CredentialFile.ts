import { chmod, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import type { ConnectionProfile } from '../connection/types.js';

export interface TemporaryCredentialFile {
  path: string;
  cleanup: () => Promise<void>;
}

export async function createCredentialFile(
  profile: ConnectionProfile,
  password: string,
  vendor: 'mysql' | 'mariadb' = 'mysql'
): Promise<TemporaryCredentialFile> {
  const directory = await mkdtemp(join(tmpdir(), 'rinda-mysql-credentials-'));
  const path = join(directory, 'client.cnf');
  try {
    if (process.platform !== 'win32') await chmod(directory, 0o700);
    const tlsOptions = vendor === 'mariadb'
      ? profile.ssl ? ['ssl=1', 'ssl-verify-server-cert=1'] : ['ssl=0']
      : [`ssl-mode=${profile.ssl ? 'VERIFY_IDENTITY' : 'DISABLED'}`];
    const content = [
      '[client]',
      `host=${quoteOptionValue(profile.host)}`,
      `port=${profile.port}`,
      `user=${quoteOptionValue(profile.user)}`,
      `password=${quoteOptionValue(password)}`,
      'protocol=TCP',
      ...tlsOptions,
      ''
    ].join('\n');
    await writeFile(path, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    if (process.platform === 'win32') await restrictWindowsAcl(path);
    else {
      await chmod(path, 0o600);
      const details = await stat(path);
      if ((details.mode & 0o077) !== 0) throw new Error('无法保证临时凭据文件仅当前用户可读写。');
    }
    let cleaned = false;
    return {
      path,
      cleanup: async () => {
        if (cleaned) return;
        cleaned = true;
        await rm(directory, { recursive: true, force: true });
      }
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

export function quoteOptionValue(value: string): string {
  const escaped = value
    .replaceAll('\\', '\\\\')
    .replaceAll('"', '\\"')
    .replaceAll('\0', '\\0')
    .replaceAll('\n', '\\n')
    .replaceAll('\r', '\\r');
  return `"${escaped}"`;
}

async function restrictWindowsAcl(path: string): Promise<void> {
  const username = process.env.USERNAME;
  if (!username) throw new Error('无法确定当前 Windows 用户，已拒绝创建凭据文件。');
  await new Promise<void>((resolve, reject) => {
    const child = spawn('icacls.exe', [path, '/inheritance:r', '/grant:r', `${username}:(R,W)`], {
      shell: false,
      windowsHide: true,
      stdio: 'ignore'
    });
    child.once('error', reject);
    child.once('close', (code) => code === 0
      ? resolve()
      : reject(new Error('无法限制临时凭据文件 ACL，已拒绝执行数据库传输。')));
  });
}
