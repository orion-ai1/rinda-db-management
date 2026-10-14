import type { ConnectionManager } from '../connection/ConnectionManager.js';
import type {
  ColumnMetadata,
  IndexColumnMetadata,
  TableEditMetadata,
  UniqueIndexMetadata
} from './types.js';

export class TableMetadataRepository {
  public constructor(private readonly connections: ConnectionManager) {}

  public get(connectionId: string, database: string, table: string): Promise<TableEditMetadata> {
    return this.connections.withConnection(connectionId, async (connection) => {
      const [columnRows] = await connection.execute({
        sql: `SELECT column_name, ordinal_position, data_type, column_type, is_nullable,
                     character_maximum_length, numeric_precision, numeric_scale, extra,
                     generation_expression, character_set_name
              FROM information_schema.columns
              WHERE table_schema = ? AND table_name = ?
              ORDER BY ordinal_position`,
        values: [database, table],
        rowsAsArray: true
      });
      const [indexRows] = await connection.execute({
        sql: `SELECT index_name, seq_in_index, column_name, nullable, sub_part
              FROM information_schema.statistics
              WHERE table_schema = ? AND table_name = ? AND non_unique = 0
              ORDER BY CASE WHEN index_name = 'PRIMARY' THEN 0 ELSE 1 END,
                       index_name, seq_in_index`,
        values: [database, table],
        rowsAsArray: true
      });

      const columns = (columnRows as unknown[][]).map(normalizeColumn);
      return {
        database,
        table,
        columns,
        uniqueIndexes: normalizeIndexes(indexRows as unknown[][], columns)
      };
    });
  }
}

function normalizeColumn(row: unknown[]): ColumnMetadata {
  return {
    name: String(row[0]),
    ordinal: Number(row[1]),
    dataType: String(row[2]).toLowerCase(),
    columnType: String(row[3]),
    nullable: String(row[4]).toUpperCase() === 'YES',
    characterMaximumLength: optionalNumber(row[5]),
    numericPrecision: optionalNumber(row[6]),
    numericScale: optionalNumber(row[7]),
    extra: String(row[8] ?? ''),
    generationExpression: optionalString(row[9]),
    characterSet: optionalString(row[10])
  };
}

function normalizeIndexes(rows: unknown[][], columns: ColumnMetadata[]): UniqueIndexMetadata[] {
  const columnMap = new Map(columns.map((column) => [column.name, column]));
  const indexes = new Map<string, UniqueIndexMetadata>();
  const invalidIndexes = new Set<string>();
  for (const row of rows) {
    const name = String(row[0]);
    const columnName = optionalString(row[2]);
    if (!columnName || !columnMap.has(columnName)) {
      invalidIndexes.add(name);
      indexes.delete(name);
      continue;
    }
    if (invalidIndexes.has(name)) continue;
    const index = indexes.get(name) ?? {
      name,
      primary: name === 'PRIMARY',
      columns: []
    };
    const column = columnMap.get(columnName);
    const item: IndexColumnMetadata = {
      name: columnName,
      sequence: Number(row[1]),
      nullable: column?.nullable ?? String(row[3]).toUpperCase() === 'YES',
      prefixLength: optionalNumber(row[4])
    };
    index.columns.push(item);
    indexes.set(name, index);
  }
  return [...indexes.values()].filter((index) => !invalidIndexes.has(index.name)).map((index) => ({
    ...index,
    columns: index.columns.sort((left, right) => left.sequence - right.sequence)
  }));
}

function optionalString(value: unknown): string | undefined {
  return value === null || value === undefined || value === '' ? undefined : String(value);
}

function optionalNumber(value: unknown): number | undefined {
  if (value === null || value === undefined) return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}
