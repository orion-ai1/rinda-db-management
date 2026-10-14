import type { ConnectionManager } from '../connection/ConnectionManager.js';
import {
  generateAlterTableSql,
  generateCreateTableSql,
  validateDesignerState
} from './TableDdlGenerator.js';
import type {
  DesignerColumn,
  DesignerIndex,
  TableDesignerState,
  TableOptions
} from './TableDesignerTypes.js';

export class TableDesignerService {
  public constructor(private readonly connections: ConnectionManager) {}

  public createEmptyTableSchema(
    connectionId: string,
    database: string,
    tableName?: string
  ): TableDesignerState {
    const columns: DesignerColumn[] = [
      {
        id: 'col_' + Math.random().toString(36).slice(2, 9),
        name: 'id',
        dataType: 'BIGINT',
        length: '20',
        scale: '',
        notNull: true,
        isPrimaryKey: true,
        autoIncrement: true,
        defaultValue: '',
        comment: ''
      }
    ];

    const options: TableOptions = {
      engine: 'InnoDB',
      charset: 'utf8mb4',
      collation: 'utf8mb4_unicode_ci',
      autoIncrement: '',
      comment: ''
    };

    return {
      mode: 'create',
      connectionId,
      database,
      tableName: tableName || 'new_table',
      columns,
      indexes: [],
      options
    };
  }

  public async loadTableSchema(
    connectionId: string,
    database: string,
    table: string
  ): Promise<TableDesignerState> {
    return this.connections.withConnection(connectionId, async (connection) => {
      const [colRows] = await connection.execute({
        sql: `SELECT COLUMN_NAME, ORDINAL_POSITION, DATA_TYPE, COLUMN_TYPE,
                     CHARACTER_MAXIMUM_LENGTH, NUMERIC_PRECISION, NUMERIC_SCALE,
                     IS_NULLABLE, COLUMN_DEFAULT, EXTRA, COLUMN_COMMENT, COLLATION_NAME
              FROM information_schema.COLUMNS
              WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
              ORDER BY ORDINAL_POSITION`,
        values: [database, table],
        rowsAsArray: true
      });

      const [pkRows] = await connection.execute({
        sql: `SELECT COLUMN_NAME
              FROM information_schema.STATISTICS
              WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND INDEX_NAME = 'PRIMARY'
              ORDER BY SEQ_IN_INDEX`,
        values: [database, table],
        rowsAsArray: true
      });

      const [idxRows] = await connection.execute({
        sql: `SELECT INDEX_NAME, NON_UNIQUE, COLUMN_NAME, SEQ_IN_INDEX, INDEX_TYPE, INDEX_COMMENT
              FROM information_schema.STATISTICS
              WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND INDEX_NAME != 'PRIMARY'
              ORDER BY INDEX_NAME, SEQ_IN_INDEX`,
        values: [database, table],
        rowsAsArray: true
      });

      const [tableRows] = await connection.execute({
        sql: `SELECT ENGINE, TABLE_COLLATION, TABLE_COMMENT, AUTO_INCREMENT
              FROM information_schema.TABLES
              WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
              LIMIT 1`,
        values: [database, table],
        rowsAsArray: true
      });

      const primaryKeys = new Set((pkRows as unknown[][]).map((row) => String(row[0])));

      const columns: DesignerColumn[] = (colRows as unknown[][]).map((row, index) => {
        const name = String(row[0]);
        const dataType = String(row[2]).toUpperCase();
        const columnType = String(row[3]);
        const charLen = row[4] !== null && row[4] !== undefined ? String(row[4]) : undefined;
        const numPrec = row[5] !== null && row[5] !== undefined ? String(row[5]) : undefined;
        const numScale = row[6] !== null && row[6] !== undefined ? String(row[6]) : undefined;
        const isNullable = String(row[7]).toUpperCase() === 'YES';
        const colDefault = row[8] !== null && row[8] !== undefined ? String(row[8]) : undefined;
        const extra = String(row[9] ?? '').toLowerCase();
        const comment = row[10] !== null && row[10] !== undefined ? String(row[10]) : '';
        const collation = row[11] !== null && row[11] !== undefined ? String(row[11]) : '';

        let length = '';
        let scale = '';

        if (['DECIMAL', 'NUMERIC'].includes(dataType)) {
          length = numPrec ?? '';
          scale = numScale ?? '';
        } else if (charLen) {
          length = charLen;
        } else {
          const match = columnType.match(/\\((\\d+)(?:,\\s*(\\d+))?\\)/);
          if (match) {
            length = match[1] || '';
            scale = match[2] || '';
          }
        }

        return {
          id: 'col_' + index + '_' + Math.random().toString(36).slice(2, 7),
          name,
          originalName: name,
          dataType,
          length,
          scale,
          notNull: !isNullable,
          isPrimaryKey: primaryKeys.has(name),
          autoIncrement: extra.includes('auto_increment'),
          defaultValue: colDefault === null || colDefault === undefined ? 'NULL' : colDefault,
          collation,
          comment
        };
      });

      const indexMap = new Map<string, {
        name: string;
        nonUnique: number;
        columns: string[];
        indexType: string;
        comment: string;
      }>();

      for (const row of idxRows as unknown[][]) {
        const indexName = String(row[0]);
        const nonUnique = Number(row[1]);
        const colName = String(row[2]);
        const indexType = String(row[4] || 'BTREE').toUpperCase();
        const comment = row[5] ? String(row[5]) : '';

        let existing = indexMap.get(indexName);
        if (!existing) {
          existing = {
            name: indexName,
            nonUnique,
            columns: [],
            indexType,
            comment
          };
          indexMap.set(indexName, existing);
        }
        existing.columns.push(colName);
      }

      const indexes: DesignerIndex[] = Array.from(indexMap.values()).map((item, idx) => {
        let type: 'INDEX' | 'UNIQUE' | 'FULLTEXT' = 'INDEX';
        if (item.indexType === 'FULLTEXT' || item.comment.toLowerCase().includes('fulltext')) {
          type = 'FULLTEXT';
        } else if (item.nonUnique === 0) {
          type = 'UNIQUE';
        }
        return {
          id: 'idx_' + idx + '_' + Math.random().toString(36).slice(2, 7),
          name: item.name,
          originalName: item.name,
          columns: item.columns,
          type,
          method: ['BTREE', 'HASH'].includes(item.indexType) ? (item.indexType as 'BTREE' | 'HASH') : 'BTREE',
          comment: item.comment
        };
      });

      const firstTableRow = (tableRows as unknown[][])[0];
      const engine = firstTableRow && firstTableRow[0] ? String(firstTableRow[0]) : 'InnoDB';
      const collation = firstTableRow && firstTableRow[1] ? String(firstTableRow[1]) : 'utf8mb4_unicode_ci';
      const comment = firstTableRow && firstTableRow[2] ? String(firstTableRow[2]) : '';
      const autoIncrement = firstTableRow && firstTableRow[3] !== null && firstTableRow[3] !== undefined ? String(firstTableRow[3]) : '';
      const charset = collation.split('_')[0] || 'utf8mb4';

      const options: TableOptions = {
        engine,
        charset,
        collation,
        autoIncrement,
        comment
      };

      return {
        mode: 'alter',
        connectionId,
        database,
        tableName: table,
        originalTableName: table,
        columns,
        originalColumns: JSON.parse(JSON.stringify(columns)) as DesignerColumn[],
        indexes,
        originalIndexes: JSON.parse(JSON.stringify(indexes)) as DesignerIndex[],
        options,
        originalOptions: { ...options }
      };
    });
  }

  public async executeSave(
    state: TableDesignerState
  ): Promise<{ ok: boolean; message: string; sql: string }> {
    const validation = validateDesignerState(state);
    if (!validation.valid) {
      return {
        ok: false,
        message: validation.errors.join('；'),
        sql: ''
      };
    }

    const sql =
      state.mode === 'create'
        ? generateCreateTableSql(state)
        : generateAlterTableSql(state);

    if (sql.startsWith('-- 当前没有未保存的结构变更')) {
      return {
        ok: true,
        message: '当前没有未保存的结构变更。',
        sql
      };
    }

    await this.connections.withConnection(state.connectionId, async (connection) => {
      await connection.query(sql);
    });

    return {
      ok: true,
      message: `表 ${state.tableName} 结构保存成功。`,
      sql
    };
  }
}
