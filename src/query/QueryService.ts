import type { FieldPacket, ResultSetHeader } from 'mysql2';
import type { ConnectionManager } from '../connection/ConnectionManager.js';
import { applyResultLimit, buildTablePreviewSql, hasTopLevelLimit } from './sqlGuards.js';

export interface QueryResult {
  columns: string[];
  rows: Array<Array<string | null>>;
  rowCount: number;
  affectedRows: number;
  durationMs: number;
  truncated: boolean;
  hasMore: boolean;
}

export interface QueryOptions {
  connectionId: string;
  sql: string;
  database?: string;
  params?: readonly unknown[];
  signal?: AbortSignal;
}

export class QueryService {
  public constructor(
    private readonly connections: ConnectionManager,
    private readonly timeoutMs: number,
    private readonly maximumRows: number
  ) {}

  public execute(options: QueryOptions): Promise<QueryResult> {
    const sql = applyResultLimit(options.sql, this.maximumRows);
    return this.run(options.connectionId, sql, options.params ?? [], this.maximumRows, options.signal, options.database);
  }

  public previewTable(
    connectionId: string,
    database: string,
    table: string,
    page: number,
    pageSize: number,
    signal?: AbortSignal
  ): Promise<QueryResult> {
    const safePage = Math.max(0, page);
    const safePageSize = Math.min(Math.max(1, pageSize), this.maximumRows);
    return this.run(
      connectionId,
      buildTablePreviewSql(database, table),
      [safePageSize + 1, safePage * safePageSize],
      safePageSize,
      signal,
      database
    );
  }

  public executeTableQuery(
    connectionId: string,
    database: string,
    sql: string,
    page: number,
    pageSize: number,
    signal?: AbortSignal
  ): Promise<QueryResult> {
    const safePage = Math.max(0, page);
    const safePageSize = Math.min(Math.max(1, pageSize), this.maximumRows);
    const trimmed = sql.trim().replace(/;\s*$/, '');
    let execSql = trimmed;
    if (!hasTopLevelLimit(execSql) && /^(select|with)\b/i.test(execSql)) {
      execSql = `${execSql} LIMIT ${safePageSize + 1} OFFSET ${safePage * safePageSize}`;
    }
    return this.run(connectionId, execSql, [], safePageSize, signal, database);
  }

  private run(
    connectionId: string,
    sql: string,
    params: readonly unknown[],
    rowLimit: number,
    signal?: AbortSignal,
    database?: string
  ): Promise<QueryResult> {
    if (signal?.aborted) {
      return Promise.reject(createAbortError());
    }
    return this.connections.withConnection(connectionId, async (connection) => {
      if (database) {
        await connection.query(`USE \`${database.replace(/`/g, '``')}\``);
      }
      const startedAt = performance.now();
      let aborted = false;
      const abort = (): void => {
        aborted = true;
        connection.destroy();
      };
      signal?.addEventListener('abort', abort, { once: true });
      try {
        const queryResult = await connection.query({
          sql,
          values: [...params],
          timeout: this.timeoutMs,
          rowsAsArray: true
        });
        if (aborted) throw createAbortError();
        const rawRows = queryResult[0] as unknown;
        const fields = (queryResult[1] ?? []) as FieldPacket[];
        return normalizeResult(rawRows, fields, rowLimit, performance.now() - startedAt);
      } catch (error) {
        if (aborted || signal?.aborted) throw createAbortError();
        throw error;
      } finally {
        signal?.removeEventListener('abort', abort);
      }
    });
  }
}

function normalizeResult(
  rawRows: unknown,
  fields: FieldPacket[],
  rowLimit: number,
  durationMs: number
): QueryResult {
  if (Array.isArray(rawRows)) {
    const rows = rawRows as unknown[][];
    const hasMore = rows.length > rowLimit;
    const visibleRows = rows.slice(0, rowLimit).map((row) => row.map(formatQueryCell));
    return {
      columns: fields.map((field) => field.name),
      rows: visibleRows,
      rowCount: visibleRows.length,
      affectedRows: 0,
      durationMs: Math.round(durationMs),
      truncated: hasMore,
      hasMore
    };
  }
  const header = rawRows as ResultSetHeader;
  return {
    columns: [],
    rows: [],
    rowCount: 0,
    affectedRows: header.affectedRows ?? 0,
    durationMs: Math.round(durationMs),
    truncated: false,
    hasMore: false
  };
}

export function formatQueryCell(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (Buffer.isBuffer(value)) return `0x${value.toString('hex')}`;
  return value instanceof Date ? value.toISOString() : String(value);
}

function createAbortError(): Error {
  const error = new Error('查询已取消。');
  error.name = 'AbortError';
  return error;
}
