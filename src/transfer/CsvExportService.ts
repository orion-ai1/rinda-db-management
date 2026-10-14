import { createHash } from 'node:crypto';
import type { Connection, FieldPacket } from 'mysql2';
import type * as vscode from 'vscode';
import type { ConnectionManager } from '../connection/ConnectionManager.js';
import { escapeIdentifier } from '../query/sqlGuards.js';
import { SafeFileWriter } from './SafeFileWriter.js';
import type { ExportProgress, ExportResult } from './types.js';
import { ExportCancelledError, throwIfAborted } from './types.js';

export interface CsvExportOptions {
  connectionId: string;
  database: string;
  table: string;
  targetPath: string;
  allowOverwrite: boolean;
  includeBom?: boolean;
  signal?: AbortSignal;
  onProgress?: (progress: ExportProgress) => void;
}

export class CsvExportService {
  public constructor(
    private readonly connections: ConnectionManager,
    private readonly output: vscode.OutputChannel
  ) {}

  public async export(options: CsvExportOptions): Promise<ExportResult> {
    const startedAt = performance.now();
    validateIdentifier(options.database, '数据库');
    validateIdentifier(options.table, '表');
    throwIfAborted(options.signal);
    await assertBaseTable(this.connections, options.connectionId, options.database, options.table);
    const writer = await SafeFileWriter.create(options.targetPath, options.allowOverwrite);
    const hash = createHash('sha256');
    let rows = 0;
    try {
      if (options.includeBom) {
        const bom = Buffer.from([0xef, 0xbb, 0xbf]);
        await writer.write(bom);
        hash.update(bom);
      }
      await this.connections.withStreamingConnection(options.connectionId, async (connection) => {
        const result = await streamTableToCsv({
          connection,
          database: options.database,
          table: options.table,
          writer,
          hash,
          signal: options.signal,
          onProgress: (count) => {
            rows = count;
            options.onProgress?.({ message: `已导出 ${count.toLocaleString()} 行…`, rows: count, bytes: writer.bytesWritten });
          }
        });
        rows = result;
      });
      throwIfAborted(options.signal);
      await writer.commit();
      const durationMs = Math.round(performance.now() - startedAt);
      const sha256 = hash.digest('hex');
      this.output.appendLine(
        `[导出] CSV ${options.database}.${options.table} 完成，${rows} 行，${writer.bytesWritten} bytes，${durationMs} ms`
      );
      return {
        targetPath: options.targetPath,
        bytes: writer.bytesWritten,
        durationMs,
        rows,
        sha256,
        warnings: []
      };
    } catch (error) {
      await writer.abort();
      if ((error as Error).name === 'AbortError') {
        this.output.appendLine(`[导出] CSV ${options.database}.${options.table} 已取消`);
        throw new ExportCancelledError();
      }
      this.output.appendLine(`[导出] CSV ${options.database}.${options.table} 失败`);
      throw error;
    }
  }
}

export function formatCsvRow(values: readonly unknown[], fields: readonly Pick<FieldPacket, 'name' | 'columnType' | 'type'>[]): string {
  return values.map((value, index) => formatCsvCell(value, fields[index])).join(',') + '\r\n';
}

export function formatCsvCell(
  value: unknown,
  field?: Pick<FieldPacket, 'name' | 'columnType' | 'type'>,
  forceText = false
): string {
  if (value === null || value === undefined) return 'NULL';
  let text: string;
  if (Buffer.isBuffer(value)) text = `base64:${value.toString('base64')}`;
  else if (value instanceof Date) text = value.toISOString();
  else text = String(value);
  if ((forceText || isTextField(field)) && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

async function streamTableToCsv(options: {
  connection: Connection;
  database: string;
  table: string;
  writer: SafeFileWriter;
  hash: ReturnType<typeof createHash>;
  signal?: AbortSignal;
  onProgress: (rows: number) => void;
}): Promise<number> {
  const query = options.connection.query({
    sql: `SELECT * FROM ${escapeIdentifier(options.database)}.${escapeIdentifier(options.table)}`,
    rowsAsArray: true
  });
  const fieldsPromise = new Promise<FieldPacket[]>((resolve, reject) => {
    query.once('fields', (fields: FieldPacket[]) => resolve(fields));
    query.once('error', reject);
  });
  const queryCompletion = new Promise<void>((resolve, reject) => {
    query.once('end', resolve);
    query.once('error', reject);
  });
  const stream = query.stream({ highWaterMark: 32 });
  const abort = (): void => {
    stream.destroy(new ExportCancelledError());
    options.connection.destroy();
  };
  options.signal?.addEventListener('abort', abort, { once: true });
  let rows = 0;
  try {
    const fields = await fieldsPromise;
    const header = formatCsvRow(fields.map((field) => field.name), fields.map((field) => ({ ...field, columnType: 253 })));
    await options.writer.write(header);
    options.hash.update(header);
    for await (const value of stream) {
      throwIfAborted(options.signal);
      const line = formatCsvRow(value as unknown[], fields);
      await options.writer.write(line);
      options.hash.update(line);
      rows += 1;
      if (rows % 1_000 === 0) options.onProgress(rows);
    }
    await queryCompletion;
    options.onProgress(rows);
    return rows;
  } finally {
    options.signal?.removeEventListener('abort', abort);
  }
}

async function assertBaseTable(
  connections: ConnectionManager,
  connectionId: string,
  database: string,
  table: string
): Promise<void> {
  await connections.withConnection(connectionId, async (connection) => {
    const [rows] = await connection.execute({
      sql: `SELECT table_type FROM information_schema.tables
            WHERE table_schema = ? AND table_name = ? LIMIT 1`,
      values: [database, table],
      rowsAsArray: true
    });
    const type = (rows as unknown[][])[0]?.[0];
    if (type === undefined) throw new Error('要导出的表不存在。');
    if (String(type).toUpperCase() !== 'BASE TABLE') throw new Error('CSV 导出仅支持基础表，不支持视图。');
  });
}

function validateIdentifier(value: string, label: string): void {
  if (!value || value.includes('\0')) throw new Error(`${label}名称无效。`);
}

function isTextField(field?: Pick<FieldPacket, 'columnType' | 'type'>): boolean {
  const type = field?.columnType ?? field?.type;
  return type !== undefined && new Set([15, 245, 247, 248, 249, 250, 251, 252, 253, 254]).has(type);
}
