import { access, constants, stat } from 'node:fs/promises';
import { delimiter, isAbsolute, join } from 'node:path';
import { spawn } from 'node:child_process';
import type { MysqlClientTool, MysqldumpTool } from './types.js';
import { ExportCancelledError, throwIfAborted } from './types.js';

interface CommandResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

type CommandRunner = (executable: string, args: readonly string[], signal?: AbortSignal) => Promise<CommandResult>;

export class MySqlToolResolver {
  public constructor(
    private readonly explicitPath?: string,
    private readonly runner: CommandRunner = runCommand,
    private readonly platform: NodeJS.Platform = process.platform,
    private readonly pathValue = process.env.PATH ?? ''
  ) {}

  public async resolve(signal?: AbortSignal): Promise<MysqldumpTool> {
    throwIfAborted(signal);
    const explicit = this.explicitPath?.trim();
    const candidates = explicit ? [explicit] : buildMysqldumpCandidates(this.platform, this.pathValue);
    const errors: string[] = [];
    for (const candidate of candidates) {
      try {
        if (isAbsolute(candidate)) await assertExecutableFile(candidate);
        const result = await this.runner(candidate, ['--version'], signal);
        if (result.code !== 0) throw new Error(result.stderr.trim() || `退出码 ${String(result.code)}`);
        return parseMysqldumpVersion(candidate, `${result.stdout}\n${result.stderr}`);
      } catch (error) {
        if ((error as Error).name === 'AbortError') throw error;
        errors.push(`${candidate}: ${error instanceof Error ? error.message : String(error)}`);
        if (explicit) break;
      }
    }
    const prefix = explicit
      ? '配置的 mysqldump 无法使用'
      : '未找到可用的 mysqldump';
    throw new Error(`${prefix}。请安装 MySQL Client，或在设置中配置 rindaMysql.mysqldumpPath。${errors[0] ? ` (${errors[0]})` : ''}`);
  }
}

export class MysqlClientResolver {
  public constructor(
    private readonly explicitPath?: string,
    private readonly runner: CommandRunner = runCommand,
    private readonly platform: NodeJS.Platform = process.platform,
    private readonly pathValue = process.env.PATH ?? ''
  ) {}

  public async resolve(signal?: AbortSignal): Promise<MysqlClientTool> {
    throwIfAborted(signal);
    const explicit = this.explicitPath?.trim();
    const candidates = explicit ? [explicit] : buildMysqlClientCandidates(this.platform, this.pathValue);
    const errors: string[] = [];
    for (const candidate of candidates) {
      try {
        if (isAbsolute(candidate)) await assertExecutableFile(candidate);
        const result = await this.runner(candidate, ['--version'], signal);
        if (result.code !== 0) throw new Error(result.stderr.trim() || `退出码 ${String(result.code)}`);
        return parseMysqlClientVersion(candidate, `${result.stdout}\n${result.stderr}`);
      } catch (error) {
        if ((error as Error).name === 'AbortError') throw error;
        errors.push(`${candidate}: ${error instanceof Error ? error.message : String(error)}`);
        if (explicit) break;
      }
    }
    const prefix = explicit ? '配置的 mysql 客户端无法使用' : '未找到可用的 mysql 客户端';
    throw new Error(`${prefix}。请安装 MySQL Client，或在设置中配置 rindaMysql.mysqlPath。${errors[0] ? ` (${errors[0]})` : ''}`);
  }
}

export function parseMysqldumpVersion(path: string, output: string): MysqldumpTool {
  const rawVersion = output.trim().replace(/[\r\n]+/g, ' ');
  const vendor = /mariadb/i.test(rawVersion) ? 'mariadb' : 'mysql';
  const match = vendor === 'mariadb'
    ? /Distrib\s+(\d+\.\d+(?:\.\d+)?)/i.exec(rawVersion)
    : /\bVer\s+(\d+\.\d+(?:\.\d+)?)/i.exec(rawVersion);
  if (!match?.[1]) throw new Error('无法解析 mysqldump 版本。');
  const version = match[1];
  const major = Number(version.split('.')[0]);
  const minimumMet = vendor === 'mysql'
    ? compareVersions(version, '5.7.0') >= 0
    : compareVersions(version, '10.3.0') >= 0;
  if (!minimumMet) throw new Error(`mysqldump ${version} 过旧；需要 MySQL 5.7+ 或 MariaDB 10.3+。`);
  return { path, vendor, version, major, rawVersion };
}

export function parseMysqlClientVersion(path: string, output: string): MysqlClientTool {
  const rawVersion = output.trim().replace(/[\r\n]+/g, ' ');
  const vendor = /mariadb/i.test(rawVersion) ? 'mariadb' : 'mysql';
  const match = vendor === 'mariadb'
    ? /(?:Distrib|from)\s+(\d+\.\d+(?:\.\d+)?)/i.exec(rawVersion)
    : /\bVer\s+(\d+\.\d+(?:\.\d+)?)/i.exec(rawVersion);
  if (!match?.[1]) throw new Error('无法解析 mysql 客户端版本。');
  const version = match[1];
  const major = Number(version.split('.')[0]);
  const minimumMet = vendor === 'mysql'
    ? compareVersions(version, '5.7.0') >= 0
    : compareVersions(version, '10.3.0') >= 0;
  if (!minimumMet) throw new Error(`mysql 客户端 ${version} 过旧；需要 MySQL 5.7+ 或 MariaDB 10.3+。`);
  return { path, vendor, version, major, rawVersion };
}

export function buildMysqldumpCandidates(platform: NodeJS.Platform, pathValue: string): string[] {
  const executable = platform === 'win32' ? 'mysqldump.exe' : 'mysqldump';
  const candidates: string[] = [];
  if (platform === 'darwin') {
    candidates.push(
      '/opt/homebrew/opt/mysql-client/bin/mysqldump',
      '/usr/local/opt/mysql-client/bin/mysqldump',
      '/opt/homebrew/opt/mysql@8.4/bin/mysqldump',
      '/usr/local/opt/mysql@8.4/bin/mysqldump'
    );
  }
  candidates.push(executable);
  for (const entry of pathValue.split(delimiter).filter(Boolean)) candidates.push(join(entry, executable));
  return [...new Set(candidates)];
}

export function buildMysqlClientCandidates(platform: NodeJS.Platform, pathValue: string): string[] {
  const executable = platform === 'win32' ? 'mysql.exe' : 'mysql';
  const candidates: string[] = [];
  if (platform === 'darwin') {
    candidates.push(
      '/opt/homebrew/opt/mysql-client/bin/mysql',
      '/usr/local/opt/mysql-client/bin/mysql',
      '/opt/homebrew/opt/mysql@8.4/bin/mysql',
      '/usr/local/opt/mysql@8.4/bin/mysql'
    );
  }
  candidates.push(executable);
  for (const entry of pathValue.split(delimiter).filter(Boolean)) candidates.push(join(entry, executable));
  return [...new Set(candidates)];
}

async function assertExecutableFile(path: string): Promise<void> {
  const details = await stat(path);
  if (!details.isFile()) throw new Error('路径不是普通文件。');
  if (process.platform !== 'win32') await access(path, constants.X_OK);
}

async function runCommand(executable: string, args: readonly string[], signal?: AbortSignal): Promise<CommandResult> {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [...args], {
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const abort = (): void => {
      child.kill('SIGTERM');
      reject(new ExportCancelledError());
    };
    signal?.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.once('error', reject);
    child.once('close', (code) => resolve({
      stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: Buffer.concat(stderr).toString('utf8'),
      code
    }));
    child.once('close', () => signal?.removeEventListener('abort', abort));
  });
}

function compareVersions(left: string, right: string): number {
  const leftParts = left.split('.').map(Number);
  const rightParts = right.split('.').map(Number);
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}
