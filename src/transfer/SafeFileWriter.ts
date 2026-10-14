import { randomUUID } from 'node:crypto';
import { open, lstat, realpath, rename, rm } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import type { FileHandle } from 'node:fs/promises';

interface TargetFingerprint {
  device: number;
  inode: number;
  size: number;
  modifiedAt: number;
}

export class SafeFileWriter {
  private handle: FileHandle | undefined;
  private committed = false;
  private byteCount = 0;

  private constructor(
    public readonly targetPath: string,
    private readonly temporaryPath: string,
    handle: FileHandle,
    private readonly allowOverwrite: boolean,
    private readonly expectedTarget: TargetFingerprint | undefined
  ) {
    this.handle = handle;
  }

  public static async create(targetPath: string, allowOverwrite: boolean): Promise<SafeFileWriter> {
    if (!isAbsolute(targetPath)) throw new Error('导出路径必须是绝对路径。');
    const normalized = resolve(targetPath);
    const name = basename(normalized);
    if (!name || name === '.' || name === '..' || name.includes('\0')) throw new Error('导出文件名无效。');
    const parent = dirname(normalized);
    const parentDetails = await lstat(parent);
    if (!parentDetails.isDirectory()) throw new Error('导出目标的父路径不是目录。');
    if (parentDetails.isSymbolicLink() || await realpath(parent) !== parent) {
      throw new Error('为避免路径重定向，导出目录不能是符号链接。');
    }
    const expectedTarget = await validateExistingTarget(normalized, allowOverwrite);
    const temporaryPath = join(parent, `.${name}.rinda-${randomUUID()}.tmp`);
    const handle = await open(temporaryPath, 'wx', 0o600);
    return new SafeFileWriter(normalized, temporaryPath, handle, allowOverwrite, expectedTarget);
  }

  public get bytesWritten(): number {
    return this.byteCount;
  }

  public async write(value: string | Uint8Array): Promise<void> {
    if (!this.handle || this.committed) throw new Error('导出文件写入器已关闭。');
    const buffer = typeof value === 'string' ? Buffer.from(value, 'utf8') : Buffer.from(value);
    await this.handle.write(buffer);
    this.byteCount += buffer.length;
  }

  public async commit(): Promise<void> {
    if (!this.handle || this.committed) throw new Error('导出文件写入器已关闭。');
    await this.handle.sync();
    await this.handle.close();
    this.handle = undefined;
    const currentTarget = await validateExistingTarget(this.targetPath, this.allowOverwrite);
    if (!sameTarget(this.expectedTarget, currentTarget)) {
      throw new Error('目标文件在确认后发生变化，已拒绝覆盖。请重新选择并确认。');
    }
    if (process.platform === 'win32' && this.allowOverwrite) {
      const backup = `${this.targetPath}.rinda-${randomUUID()}.backup`;
      await rename(this.targetPath, backup);
      try {
        await rename(this.temporaryPath, this.targetPath);
        await rm(backup, { force: true });
      } catch (error) {
        await rename(backup, this.targetPath).catch(() => undefined);
        throw error;
      }
    } else {
      await rename(this.temporaryPath, this.targetPath);
    }
    this.committed = true;
    await syncDirectory(dirname(this.targetPath));
  }

  public async abort(): Promise<void> {
    if (this.handle) {
      await this.handle.close().catch(() => undefined);
      this.handle = undefined;
    }
    if (!this.committed) await rm(this.temporaryPath, { force: true }).catch(() => undefined);
  }
}

async function validateExistingTarget(path: string, allowOverwrite: boolean): Promise<TargetFingerprint | undefined> {
  try {
    const details = await lstat(path);
    if (details.isSymbolicLink() || !details.isFile()) {
      throw new Error('导出目标必须是普通文件，不能是目录、设备或符号链接。');
    }
    if (!allowOverwrite) throw new Error('目标文件已存在，必须明确确认覆盖。');
    return {
      device: details.dev,
      inode: details.ino,
      size: details.size,
      modifiedAt: details.mtimeMs
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return undefined;
  }
}

function sameTarget(left: TargetFingerprint | undefined, right: TargetFingerprint | undefined): boolean {
  if (!left || !right) return left === right;
  return left.device === right.device
    && left.inode === right.inode
    && left.size === right.size
    && left.modifiedAt === right.modifiedAt;
}

async function syncDirectory(path: string): Promise<void> {
  if (process.platform === 'win32') return;
  const directory = await open(path, 'r');
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}
