import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, lstat, mkdtemp, open, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { Transform } from 'node:stream';
import type { SqlExportScope, SqlObjectSummary, SqlPackageMetadata } from './types.js';
import { throwIfAborted } from './types.js';

const MAX_HEADER_BYTES = 65_536;
const FOOTER_READ_BYTES = 512;
const FOOTER_PATTERN = /-- rinda-sha256: ([a-f0-9]{64})\n-- rinda-export-end\n$/;

export interface PreparedSqlPackage {
  sourcePath: string;
  stagedPath: string;
  bytes: number;
  sha256: string;
  metadata: SqlPackageMetadata;
  cleanup(): Promise<void>;
}

export async function prepareSqlPackage(
  sourcePath: string,
  signal?: AbortSignal
): Promise<PreparedSqlPackage> {
  throwIfAborted(signal);
  if (!isAbsolute(sourcePath)) throw new Error('SQL 包路径必须是绝对路径。');
  const normalized = resolve(sourcePath);
  const pathDetails = await lstat(normalized);
  if (pathDetails.isSymbolicLink() || !pathDetails.isFile()) {
    throw new Error('SQL 包必须是普通文件，不能是目录、设备或符号链接。');
  }

  const source = await open(normalized, 'r');
  let temporaryDirectory: string | undefined;
  let stagedHandle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const initial = await source.stat();
    if (!initial.isFile() || initial.dev !== pathDetails.dev || initial.ino !== pathDetails.ino) {
      throw new Error('SQL 包在选择后发生变化，已拒绝读取。');
    }
    if (initial.size < 128) throw new Error('SQL 包过小，缺少完整的 Rinda 元数据与校验尾注。');

    const headerBuffer = Buffer.alloc(Math.min(initial.size, MAX_HEADER_BYTES));
    await source.read(headerBuffer, 0, headerBuffer.length, 0);
    const metadata = parseHeader(headerBuffer.toString('utf8'));

    const footerLength = Math.min(initial.size, FOOTER_READ_BYTES);
    const footerBuffer = Buffer.alloc(footerLength);
    await source.read(footerBuffer, 0, footerLength, initial.size - footerLength);
    const footerText = footerBuffer.toString('utf8');
    const footer = FOOTER_PATTERN.exec(footerText);
    if (!footer?.[1]) throw new Error('SQL 包缺少完整的 Rinda SHA-256 尾注。');
    const expectedSha256 = footer[1];
    const matchedFooter = footer[0];
    const bodyBytes = initial.size - Buffer.byteLength(matchedFooter, 'utf8');
    if (bodyBytes <= 0) throw new Error('SQL 包正文为空。');

    temporaryDirectory = await mkdtemp(join(tmpdir(), 'rinda-mysql-restore-'));
    if (process.platform !== 'win32') await chmod(temporaryDirectory, 0o700);
    const stagedPath = join(temporaryDirectory, `validated-${randomUUID()}.sql`);
    stagedHandle = await open(stagedPath, 'wx', 0o600);
    const hash = createHash('sha256');
    const scanner = new SqlSafetyScanner();
    const decoder = new StringDecoder('utf8');
    const stream = createReadStream(normalized, {
      fd: source.fd,
      autoClose: false,
      start: 0,
      end: bodyBytes - 1,
      highWaterMark: 256 * 1024
    });
    for await (const value of stream) {
      throwIfAborted(signal);
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      hash.update(chunk);
      scanner.write(decoder.write(chunk));
      await stagedHandle.write(chunk);
    }
    scanner.write(decoder.end());
    scanner.finish();
    const actualSha256 = hash.digest('hex');
    if (actualSha256 !== expectedSha256) {
      throw new Error(`SQL 包完整性校验失败：期望 ${expectedSha256}，实际 ${actualSha256}。`);
    }
    const final = await source.stat();
    if (final.dev !== initial.dev || final.ino !== initial.ino
      || final.size !== initial.size || final.mtimeMs !== initial.mtimeMs) {
      throw new Error('SQL 包在完整性校验期间发生变化，已拒绝恢复。');
    }
    await stagedHandle.sync();
    await stagedHandle.close();
    stagedHandle = undefined;
    let cleaned = false;
    const directory = temporaryDirectory;
    temporaryDirectory = undefined;
    return {
      sourcePath: normalized,
      stagedPath,
      bytes: bodyBytes,
      sha256: actualSha256,
      metadata,
      cleanup: async () => {
        if (cleaned) return;
        cleaned = true;
        await rm(directory, { recursive: true, force: true });
      }
    };
  } catch (error) {
    await stagedHandle?.close().catch(() => undefined);
    if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  } finally {
    await source.close().catch(() => undefined);
  }
}

export function createDatabaseQualifierRewriteStream(
  sourceDatabase: string,
  targetDatabase: string
): Transform {
  safeIdentifier(sourceDatabase, '源数据库');
  safeIdentifier(targetDatabase, '目标数据库');
  return new DatabaseQualifierTransform(sourceDatabase, targetDatabase);
}

function parseHeader(contents: string): SqlPackageMetadata {
  const lines = contents.split('\n', 5);
  if (lines.length < 5) throw new Error('SQL 包头不完整。');
  if (lines[0] !== '-- Rinda MySQL SQL Export' || lines[1] !== '-- rinda-format-version: 2') {
    throw new Error('仅支持由 Rinda MySQL 0.3.1+ 生成的 v2 SQL 包；请使用当前版本重新导出。');
  }
  if (lines[3] !== '-- SHA-256 covers this header and the mysqldump body through the byte before rinda-sha256.') {
    throw new Error('SQL 包头策略标记无效。');
  }
  const encoded = /^-- rinda-metadata-base64url: ([A-Za-z0-9_-]+)$/.exec(lines[2] ?? '')?.[1];
  if (!encoded || encoded.length > 32_768) throw new Error('SQL 包元数据缺失或过大。');
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  } catch {
    throw new Error('SQL 包元数据无法解析。');
  }
  return validateMetadata(value);
}

function validateMetadata(value: unknown): SqlPackageMetadata {
  if (!isRecord(value)
    || value.formatVersion !== 2
    || value.contentPolicy !== 'rinda-controlled-restore-v1'
    || value.characterSet !== 'utf8mb4'
    || typeof value.exportedAt !== 'string'
    || !Number.isFinite(Date.parse(value.exportedAt))
    || typeof value.sourceServerVersion !== 'string'
    || value.sourceServerVersion.length > 200
    || !isRecord(value.tool)
    || (value.tool.vendor !== 'mysql' && value.tool.vendor !== 'mariadb')
    || typeof value.tool.version !== 'string'
    || value.tool.version.length > 100) {
    throw new Error('SQL 包元数据不符合受控恢复格式。');
  }
  const scope = validateScope(value.scope);
  const objects = validateObjects(value.objects);
  const restorePolicy = validateRestorePolicy(value.restorePolicy);
  return {
    formatVersion: 2,
    contentPolicy: 'rinda-controlled-restore-v1',
    exportedAt: value.exportedAt,
    sourceServerVersion: value.sourceServerVersion,
    scope,
    characterSet: 'utf8mb4',
    objects,
    restorePolicy,
    tool: { vendor: value.tool.vendor, version: value.tool.version }
  };
}

function validateRestorePolicy(value: unknown): SqlPackageMetadata['restorePolicy'] {
  if (!isRecord(value) || typeof value.standalone !== 'boolean' || !Array.isArray(value.reasons)
    || value.reasons.length > 100
    || value.reasons.some((reason) => typeof reason !== 'string' || reason.length > 300)) {
    throw new Error('SQL 包缺少有效的受控恢复策略。');
  }
  const reasons = value.reasons as string[];
  if (value.standalone !== (reasons.length === 0)) {
    throw new Error('SQL 包受控恢复策略前后矛盾。');
  }
  return { standalone: value.standalone, reasons: [...reasons] };
}

function validateScope(value: unknown): SqlExportScope {
  if (!isRecord(value) || (value.kind !== 'database' && value.kind !== 'table')) {
    throw new Error('SQL 包的导出范围无效。');
  }
  const database = safeIdentifier(value.database, '源数据库');
  if (isSystemSchema(database)) throw new Error('SQL 包来源为系统数据库，受控恢复不允许处理系统库。');
  if (value.kind === 'database') return { kind: 'database', database };
  return { kind: 'table', database, table: safeIdentifier(value.table, '源表') };
}

function validateObjects(value: unknown): SqlObjectSummary {
  if (!isRecord(value)) throw new Error('SQL 包缺少对象清单。');
  const result: SqlObjectSummary = {
    tables: safeCount(value.tables),
    views: safeCount(value.views),
    routines: safeCount(value.routines),
    events: safeCount(value.events),
    triggers: safeCount(value.triggers)
  };
  return result;
}

function safeCount(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > 10_000_000) {
    throw new Error('SQL 包对象清单包含无效计数。');
  }
  return value as number;
}

function safeIdentifier(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 64
    || value.includes('\0') || /[\r\n]/.test(value) || value.startsWith('-')) {
    throw new Error(`${label}名称无效。`);
  }
  return value;
}

function isSystemSchema(database: string): boolean {
  return ['information_schema', 'mysql', 'performance_schema', 'sys'].includes(database.toLowerCase());
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

class SqlSafetyScanner {
  private state: 'normal' | 'single' | 'double' | 'backtick' | 'line' | 'block' | 'exec' = 'normal';
  private quoteReturnState: 'normal' | 'exec' = 'normal';
  private carry = '';
  private token = '';
  private readonly recentTokens: string[] = [];

  public write(value: string): void {
    const text = this.carry + value;
    const limit = Math.max(0, text.length - 3);
    this.scan(text, limit);
    this.carry = text.slice(limit);
  }

  public finish(): void {
    this.scan(`${this.carry}\n   `, this.carry.length + 1);
    this.emitToken();
    if (this.state !== 'normal') throw new Error('SQL 包包含未闭合的字符串、标识符或注释。');
  }

  private scan(text: string, limit: number): void {
    for (let index = 0; index < limit; index += 1) {
      const char = text[index] ?? '';
      const next = text[index + 1] ?? '';
      const nextNext = text[index + 2] ?? '';
      if (this.state === 'line') {
        if (char === '\n') this.state = 'normal';
        continue;
      }
      if (this.state === 'block') {
        if (char === '*' && next === '/') {
          this.state = 'normal';
          index += 1;
        }
        continue;
      }
      if (this.state === 'single' || this.state === 'double' || this.state === 'backtick') {
        const quote = this.state === 'single' ? "'" : this.state === 'double' ? '"' : '`';
        if (char === '\\') index += 1;
        else if (char === quote) {
          if (next === quote) index += 1;
          else this.state = this.quoteReturnState;
        }
        continue;
      }
      if (this.state === 'exec' && char === '*' && next === '/') {
        this.emitToken();
        this.state = 'normal';
        index += 1;
        continue;
      }
      if (char === '-' && next === '-' && /\s/.test(nextNext)) {
        this.emitToken();
        this.state = 'line';
        index += 1;
        continue;
      }
      if (char === '#') {
        this.emitToken();
        this.state = 'line';
        continue;
      }
      if (char === '/' && next === '*') {
        this.emitToken();
        if (nextNext === '!') {
          this.state = 'exec';
          index += 2;
          while (/\d/.test(text[index + 1] ?? '')) index += 1;
        } else {
          this.state = 'block';
          index += 1;
        }
        continue;
      }
      if (char === "'" || char === '"' || char === '`') {
        this.emitToken();
        this.quoteReturnState = this.state === 'exec' ? 'exec' : 'normal';
        this.state = char === "'" ? 'single' : char === '"' ? 'double' : 'backtick';
        continue;
      }
      if (/[A-Za-z_]/.test(char)) this.token += char.toUpperCase();
      else if (this.token) this.emitToken();
    }
  }

  private emitToken(): void {
    if (!this.token) return;
    const token = this.token;
    this.token = '';
    this.recentTokens.push(token);
    if (this.recentTokens.length > 3) this.recentTokens.shift();
    const pair = this.recentTokens.slice(-2).join(' ');
    const blockedPairs = [
      'CREATE DATABASE', 'ALTER DATABASE', 'DROP DATABASE',
      'CREATE USER', 'ALTER USER', 'DROP USER', 'RENAME USER',
      'CREATE ROLE', 'DROP ROLE', 'SET PASSWORD', 'LOAD DATA', 'LOAD XML',
      'INSTALL PLUGIN', 'UNINSTALL PLUGIN'
    ];
    const blockedTriple = this.recentTokens.slice(-3).join(' ') === 'SET DEFAULT ROLE';
    if (token === 'GRANT' || token === 'REVOKE' || token === 'SHUTDOWN'
      || token === 'USE' || token === 'SOURCE' || token === 'SYSTEM'
      || blockedTriple
      || blockedPairs.includes(pair)) {
      const statement = blockedTriple ? 'SET DEFAULT ROLE' : blockedPairs.includes(pair) ? pair : token;
      throw new Error(`SQL 包包含受控恢复禁止的语句（${statement}）。`);
    }
  }
}

class DatabaseQualifierTransform extends Transform {
  private readonly decoder = new StringDecoder('utf8');
  private readonly quotedSource: string;
  private readonly quotedTarget: string;
  private readonly lookahead: number;
  private carry = '';
  private state: 'normal' | 'single' | 'double' | 'backtick' | 'line' | 'block' | 'exec' = 'normal';
  private quoteReturnState: 'normal' | 'exec' = 'normal';
  private lastCodeCharacter = '';

  public constructor(private readonly sourceDatabase: string, targetDatabase: string) {
    super();
    this.quotedSource = `\`${sourceDatabase.replaceAll('`', '``')}\``;
    this.quotedTarget = `\`${targetDatabase.replaceAll('`', '``')}\``;
    this.lookahead = Math.max(96, this.quotedSource.length + 16, sourceDatabase.length + 16);
  }

  public override _transform(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void
  ): void {
    try {
      const value = typeof chunk === 'string' ? chunk : this.decoder.write(chunk);
      const text = this.carry + value;
      const limit = Math.max(0, text.length - this.lookahead);
      const rewritten = this.rewrite(text, limit);
      this.push(rewritten.output);
      this.carry = text.slice(rewritten.consumed);
      callback();
    } catch (error) {
      callback(error as Error);
    }
  }

  public override _flush(callback: (error?: Error | null) => void): void {
    try {
      const text = this.carry + this.decoder.end();
      this.push(this.rewrite(text, text.length).output);
      callback();
    } catch (error) {
      callback(error as Error);
    }
  }

  private rewrite(text: string, limit: number): { output: string; consumed: number } {
    let output = '';
    let index = 0;
    for (; index < limit; index += 1) {
      const char = text[index] ?? '';
      const next = text[index + 1] ?? '';
      const nextNext = text[index + 2] ?? '';
      if (this.state === 'line') {
        output += char;
        if (char === '\n') {
          this.state = 'normal';
          this.lastCodeCharacter = char;
        }
        continue;
      }
      if (this.state === 'block') {
        output += char;
        if (char === '*' && next === '/') {
          output += next;
          this.state = 'normal';
          index += 1;
        }
        continue;
      }
      if (this.state === 'single' || this.state === 'double' || this.state === 'backtick') {
        output += char;
        const quote = this.state === 'single' ? "'" : this.state === 'double' ? '"' : '`';
        if (char === '\\') {
          output += next;
          index += 1;
        } else if (char === quote) {
          if (next === quote) {
            output += next;
            index += 1;
          } else {
            this.state = this.quoteReturnState;
          }
        }
        continue;
      }
      if (this.state === 'exec' && char === '*' && next === '/') {
        output += '*/';
        this.state = 'normal';
        index += 1;
        this.lastCodeCharacter = '/';
        continue;
      }
      if (char === '-' && next === '-' && /\s/.test(nextNext)) {
        output += '--';
        this.state = 'line';
        index += 1;
        continue;
      }
      if (char === '#') {
        output += char;
        this.state = 'line';
        continue;
      }
      if (char === '/' && next === '*') {
        output += nextNext === '!' ? '/*!' : '/*';
        this.state = nextNext === '!' ? 'exec' : 'block';
        index += nextNext === '!' ? 2 : 1;
        continue;
      }
      if (text.startsWith(this.quotedSource, index)
        && nextNonWhitespaceIsDot(text, index + this.quotedSource.length)) {
        output += this.quotedTarget;
        index += this.quotedSource.length - 1;
        this.lastCodeCharacter = '`';
        continue;
      }
      if (!/[A-Za-z0-9_$]/.test(this.lastCodeCharacter)
        && text.startsWith(this.sourceDatabase, index)
        && nextNonWhitespaceIsDot(text, index + this.sourceDatabase.length)) {
        output += this.quotedTarget;
        index += this.sourceDatabase.length - 1;
        this.lastCodeCharacter = '`';
        continue;
      }
      if (char === "'" || char === '"' || char === '`') {
        output += char;
        this.quoteReturnState = this.state === 'exec' ? 'exec' : 'normal';
        this.state = char === "'" ? 'single' : char === '"' ? 'double' : 'backtick';
        continue;
      }
      output += char;
      this.lastCodeCharacter = char;
    }
    return { output, consumed: index };
  }
}

function nextNonWhitespaceIsDot(text: string, start: number): boolean {
  let index = start;
  while (/\s/.test(text[index] ?? '')) index += 1;
  return text[index] === '.';
}
