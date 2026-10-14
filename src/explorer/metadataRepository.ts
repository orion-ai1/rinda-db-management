import type { ConnectionManager } from '../connection/ConnectionManager.js';

export interface DatabaseObject {
  name: string;
  type: 'table' | 'view';
}

export interface ColumnInfo {
  table: string;
  column: string;
  dataType: string;
  columnType: string;
  nullable: boolean;
  comment?: string;
}

export interface TableOverview {
  objectType: 'table' | 'view';
  engine?: string;
  estimatedRows?: string;
  dataBytes?: string;
  indexBytes?: string;
  autoIncrement?: string;
  collation?: string;
  createdAt?: string;
  updatedAt?: string;
}

export class MetadataRepository {
  public constructor(private readonly connections: ConnectionManager) {}

  public listDatabases(connectionId: string): Promise<string[]> {
    return this.connections.withConnection(connectionId, async (connection) => {
      const [rows] = await connection.query({
        sql: 'SELECT schema_name FROM information_schema.schemata ORDER BY schema_name',
        rowsAsArray: true
      });
      return (rows as unknown[][]).map((row) => String(row[0]));
    });
  }

  public listObjects(connectionId: string, database: string): Promise<DatabaseObject[]> {
    return this.connections.withConnection(connectionId, async (connection) => {
      const [rows] = await connection.execute({
        sql: `SELECT table_name, table_type
              FROM information_schema.tables
              WHERE table_schema = ?
              ORDER BY table_name`,
        values: [database],
        rowsAsArray: true
      });
      return (rows as unknown[][]).map((row) => ({
        name: String(row[0]),
        type: String(row[1]).toUpperCase() === 'VIEW' ? 'view' : 'table'
      }));
    });
  }

  public getTableOverview(
    connectionId: string,
    database: string,
    table: string
  ): Promise<TableOverview | undefined> {
    return this.connections.withConnection(connectionId, async (connection) => {
      const [rows] = await connection.execute({
        sql: `SELECT table_type, engine, table_rows, data_length, index_length,
                     auto_increment, table_collation, create_time, update_time
              FROM information_schema.tables
              WHERE table_schema = ? AND table_name = ?
              LIMIT 1`,
        values: [database, table],
        rowsAsArray: true
      });
      const row = (rows as unknown[][])[0];
      if (!row) return undefined;
      return {
        objectType: String(row[0]).toUpperCase() === 'VIEW' ? 'view' : 'table',
        engine: optionalString(row[1]),
        estimatedRows: optionalString(row[2]),
        dataBytes: optionalString(row[3]),
        indexBytes: optionalString(row[4]),
        autoIncrement: optionalString(row[5]),
        collation: optionalString(row[6]),
        createdAt: optionalDateString(row[7]),
        updatedAt: optionalDateString(row[8])
      };
    });
  }

  public listDatabasesWithSizes(
    connectionId: string
  ): Promise<Array<{ name: string; size?: string }>> {
    return this.connections.withConnection(connectionId, async (connection) => {
      try {
        const [rows] = await connection.query({
          sql: `SELECT s.schema_name, SUM(t.data_length + t.index_length) as total_bytes
                FROM information_schema.schemata s
                LEFT JOIN information_schema.tables t ON s.schema_name = t.table_schema
                GROUP BY s.schema_name
                ORDER BY s.schema_name`,
          rowsAsArray: true
        });
        return (rows as unknown[][]).map((row) => ({
          name: String(row[0]),
          size: formatDataSize(optionalNumber(row[1]))
        }));
      } catch {
        const databases = await this.listDatabases(connectionId);
        return databases.map((name) => ({ name }));
      }
    });
  }

  public listUsers(connectionId: string): Promise<string[]> {
    return this.connections.withConnection(connectionId, async (connection) => {
      try {
        const [rows] = await connection.query({
          sql: `SELECT DISTINCT CONCAT(user, '@', host) FROM mysql.user ORDER BY user, host`,
          rowsAsArray: true
        });
        return (rows as unknown[][]).map((row) => String(row[0]));
      } catch {
        try {
          const [rows] = await connection.query({
            sql: `SELECT CURRENT_USER()`,
            rowsAsArray: true
          });
          return (rows as unknown[][]).map((row) => String(row[0]));
        } catch {
          return [];
        }
      }
    });
  }

  public listTables(connectionId: string, database: string): Promise<string[]> {
    return this.connections.withConnection(connectionId, async (connection) => {
      const [rows] = await connection.execute({
        sql: `SELECT table_name FROM information_schema.tables
              WHERE table_schema = ? AND table_type = 'BASE TABLE'
              ORDER BY table_name`,
        values: [database],
        rowsAsArray: true
      });
      return (rows as unknown[][]).map((row) => String(row[0]));
    });
  }

  public listViews(connectionId: string, database: string): Promise<string[]> {
    return this.connections.withConnection(connectionId, async (connection) => {
      const [rows] = await connection.execute({
        sql: `SELECT table_name FROM information_schema.tables
              WHERE table_schema = ? AND table_type = 'VIEW'
              ORDER BY table_name`,
        values: [database],
        rowsAsArray: true
      });
      return (rows as unknown[][]).map((row) => String(row[0]));
    });
  }

  public listColumns(connectionId: string, database: string, table?: string): Promise<ColumnInfo[]> {
    return this.connections.withConnection(connectionId, async (connection) => {
      const sql = table
        ? `SELECT table_name, column_name, data_type, column_type, is_nullable, column_comment
           FROM information_schema.columns
           WHERE table_schema = ? AND table_name = ?
           ORDER BY table_name, ordinal_position`
        : `SELECT table_name, column_name, data_type, column_type, is_nullable, column_comment
           FROM information_schema.columns
           WHERE table_schema = ?
           ORDER BY table_name, ordinal_position`;
      const values = table ? [database, table] : [database];
      const [rows] = await connection.execute({ sql, values, rowsAsArray: true });
      return (rows as unknown[][]).map((row) => ({
        table: String(row[0]),
        column: String(row[1]),
        dataType: String(row[2]),
        columnType: String(row[3]),
        nullable: String(row[4]).toUpperCase() === 'YES',
        comment: row[5] ? String(row[5]) : undefined
      }));
    });
  }

  public listFunctions(connectionId: string, database: string): Promise<string[]> {
    return this.connections.withConnection(connectionId, async (connection) => {
      try {
        const [rows] = await connection.execute({
          sql: `SELECT routine_name FROM information_schema.routines
                WHERE routine_schema = ? AND routine_type = 'FUNCTION'
                ORDER BY routine_name`,
          values: [database],
          rowsAsArray: true
        });
        return (rows as unknown[][]).map((row) => String(row[0]));
      } catch {
        return [];
      }
    });
  }

  public listProcedures(connectionId: string, database: string): Promise<string[]> {
    return this.connections.withConnection(connectionId, async (connection) => {
      try {
        const [rows] = await connection.execute({
          sql: `SELECT routine_name FROM information_schema.routines
                WHERE routine_schema = ? AND routine_type = 'PROCEDURE'
                ORDER BY routine_name`,
          values: [database],
          rowsAsArray: true
        });
        return (rows as unknown[][]).map((row) => String(row[0]));
      } catch {
        return [];
      }
    });
  }
}

export function formatDataSize(bytes: number | null | undefined): string | undefined {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes) || bytes <= 0) {
    return undefined;
  }
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}K`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)}M`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)}G`;
}

function optionalNumber(value: unknown): number | undefined {
  if (value === null || value === undefined) return undefined;
  const num = Number(value);
  return Number.isFinite(num) ? num : undefined;
}

function optionalString(value: unknown): string | undefined {
  return value === null || value === undefined ? undefined : String(value);
}

function optionalDateString(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  return value instanceof Date ? value.toISOString() : String(value);
}
