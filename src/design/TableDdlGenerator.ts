import { escapeIdentifier } from '../query/sqlGuards.js';
import type { DesignerColumn, TableDesignerState, TableDesignerValidation } from './TableDesignerTypes.js';

export function escapeSqlString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

export function formatDataType(dataType: string, length?: string, scale?: string): string {
  const dt = dataType.trim().toUpperCase();
  const len = length ? length.trim() : '';
  const sc = scale ? scale.trim() : '';

  if (['DECIMAL', 'NUMERIC'].includes(dt)) {
    if (len && sc) return `${dt}(${len},${sc})`;
    if (len) return `${dt}(${len})`;
    return dt;
  }

  if (['VARCHAR', 'CHAR', 'VARBINARY', 'BINARY', 'BIT'].includes(dt)) {
    return `${dt}(${len || '255'})`;
  }

  if (['INT', 'INTEGER', 'BIGINT', 'TINYINT', 'SMALLINT', 'MEDIUMINT'].includes(dt)) {
    if (len) return `${dt}(${len})`;
    return dt;
  }

  if (['DATETIME', 'TIMESTAMP', 'TIME'].includes(dt)) {
    if (len && ['0', '1', '2', '3', '4', '5', '6'].includes(len)) {
      return `${dt}(${len})`;
    }
    return dt;
  }

  if (len) return `${dt}(${len})`;
  return dt;
}

export function formatColumnDef(col: DesignerColumn): string {
  const name = escapeIdentifier(col.name);
  const type = formatDataType(col.dataType, col.length, col.scale);
  let def = `${name} ${type}`;

  if (col.notNull) {
    def += ' NOT NULL';
  } else {
    def += ' NULL';
  }

  if (col.autoIncrement) {
    def += ' AUTO_INCREMENT';
  } else if (col.defaultValue !== undefined && col.defaultValue !== '') {
    const rawVal = col.defaultValue.trim();
    if (rawVal.toUpperCase() === 'NULL') {
      if (!col.notNull) {
        def += ' DEFAULT NULL';
      }
    } else if (rawVal.toUpperCase() === 'CURRENT_TIMESTAMP' || rawVal.toUpperCase() === 'NOW()') {
      def += ' DEFAULT CURRENT_TIMESTAMP';
    } else if (rawVal === "''" || rawVal.toUpperCase() === 'EMPTY') {
      def += " DEFAULT ''";
    } else {
      def += ` DEFAULT '${escapeSqlString(rawVal)}'`;
    }
  }

  if (col.collation && col.collation.trim() !== '') {
    def += ` COLLATE ${col.collation.trim()}`;
  }

  if (col.comment && col.comment.trim() !== '') {
    def += ` COMMENT '${escapeSqlString(col.comment.trim())}'`;
  }

  return def;
}

export function validateDesignerState(state: TableDesignerState): TableDesignerValidation {
  const errors: string[] = [];

  const trimmedTableName = state.tableName.trim();
  if (!trimmedTableName) {
    errors.push('表名不能为空。');
  } else if (/[\/\\\.\0]/.test(trimmedTableName)) {
    errors.push('表名包含无效字符（/、\\、.）。');
  }

  if (!state.columns || state.columns.length === 0) {
    errors.push('表至少需要包含一个字段。');
    return { valid: errors.length === 0, errors };
  }

  const seenNames = new Set<string>();
  let hasAutoIncrement = false;

  for (let index = 0; index < state.columns.length; index += 1) {
    const col = state.columns[index];
    if (!col) continue;
    const colName = col.name.trim();
    if (!colName) {
      errors.push(`第 ${index + 1} 个字段名称不能为空。`);
      continue;
    }
    const lowerName = colName.toLowerCase();
    if (seenNames.has(lowerName)) {
      errors.push(`存在重复的字段名: "${colName}"。`);
    }
    seenNames.add(lowerName);

    if (!col.dataType || !col.dataType.trim()) {
      errors.push(`字段 "${colName}" 必须指定数据类型。`);
    }

    if (col.autoIncrement) {
      if (hasAutoIncrement) {
        errors.push('一个表最多只能有一个自动递增字段。');
      }
      hasAutoIncrement = true;
      const typeUpper = col.dataType.trim().toUpperCase();
      const intTypes = ['TINYINT', 'SMALLINT', 'MEDIUMINT', 'INT', 'INTEGER', 'BIGINT'];
      if (!intTypes.includes(typeUpper)) {
        errors.push(`自动递增字段 "${colName}" 必须是整数类型（INT/BIGINT 等）。`);
      }
      if (!col.isPrimaryKey) {
        errors.push(`自动递增字段 "${colName}" 必须设置为主键。`);
      }
    }
  }

  if (state.indexes && state.indexes.length > 0) {
    const seenIndexNames = new Set<string>();
    for (let i = 0; i < state.indexes.length; i += 1) {
      const idx = state.indexes[i]!;
      const idxName = idx.name.trim();
      if (!idxName) {
        errors.push(`第 ${i + 1} 个索引名称不能为空。`);
      } else {
        const lower = idxName.toLowerCase();
        if (seenIndexNames.has(lower)) {
          errors.push(`存在重复的索引名称: "${idxName}"。`);
        }
        seenIndexNames.add(lower);
      }
      if (!idx.columns || idx.columns.length === 0) {
        errors.push(`索引 "${idxName || `第 ${i + 1} 个索引`}" 必须包含至少一个字段。`);
      } else {
        for (const colName of idx.columns) {
          if (!seenNames.has(colName.toLowerCase())) {
            errors.push(`索引 "${idxName}" 引用的字段 "${colName}" 不存在。`);
          }
        }
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

export function generateCreateTableSql(state: TableDesignerState): string {
  const targetTable = `${escapeIdentifier(state.database)}.${escapeIdentifier(state.tableName.trim())}`;
  const lines: string[] = [];

  for (const col of state.columns) {
    lines.push(`  ${formatColumnDef(col)}`);
  }

  const pkCols = state.columns
    .filter((col) => col.isPrimaryKey)
    .map((col) => escapeIdentifier(col.name));

  if (pkCols.length > 0) {
    lines.push(`  PRIMARY KEY (${pkCols.join(', ')})`);
  }

  if (state.indexes && state.indexes.length > 0) {
    for (const idx of state.indexes) {
      const idxCols = idx.columns.map(escapeIdentifier).join(', ');
      const commentClause = idx.comment && idx.comment.trim() ? ` COMMENT '${escapeSqlString(idx.comment.trim())}'` : '';
      const methodClause = idx.method && ['BTREE', 'HASH'].includes(idx.method.toUpperCase()) ? ` USING ${idx.method.toUpperCase()}` : '';
      if (idx.type === 'UNIQUE') {
        lines.push(`  UNIQUE KEY ${escapeIdentifier(idx.name.trim())} (${idxCols})${methodClause}${commentClause}`);
      } else if (idx.type === 'FULLTEXT') {
        lines.push(`  FULLTEXT KEY ${escapeIdentifier(idx.name.trim())} (${idxCols})${commentClause}`);
      } else {
        lines.push(`  INDEX ${escapeIdentifier(idx.name.trim())} (${idxCols})${methodClause}${commentClause}`);
      }
    }
  }

  let tableOptions = `ENGINE=${state.options.engine || 'InnoDB'} DEFAULT CHARSET=${state.options.charset || 'utf8mb4'}`;
  if (state.options.collation) {
    tableOptions += ` COLLATE=${state.options.collation}`;
  }
  if (state.options.autoIncrement && state.options.autoIncrement.trim()) {
    tableOptions += ` AUTO_INCREMENT=${state.options.autoIncrement.trim()}`;
  }
  if (state.options.comment && state.options.comment.trim() !== '') {
    tableOptions += ` COMMENT='${escapeSqlString(state.options.comment.trim())}'`;
  }

  return `CREATE TABLE ${targetTable} (\n${lines.join(',\n')}\n) ${tableOptions};`;
}

export function generateAlterTableSql(state: TableDesignerState): string {
  const origTableName = (state.originalTableName || state.tableName).trim();
  const currentTableName = state.tableName.trim();
  const targetTable = `${escapeIdentifier(state.database)}.${escapeIdentifier(origTableName)}`;
  const origCols = state.originalColumns || [];
  const currCols = state.columns;

  const clauses: string[] = [];

  // Check PK changes
  const origPk = origCols.filter((col) => col.isPrimaryKey).map((col) => col.name);
  const currPk = currCols.filter((col) => col.isPrimaryKey).map((col) => col.name);
  const pkChanged = origPk.length !== currPk.length || origPk.some((name, i) => name !== currPk[i]);

  if (pkChanged && origPk.length > 0) {
    clauses.push('DROP PRIMARY KEY');
  }

  // Dropped columns: in origCols but not in currCols (matched by originalName or name)
  const remainingOrigNames = new Set(
    currCols.map((c) => (c.originalName ? c.originalName.toLowerCase() : c.name.toLowerCase()))
  );

  for (const origCol of origCols) {
    if (!remainingOrigNames.has(origCol.name.toLowerCase())) {
      clauses.push(`DROP COLUMN ${escapeIdentifier(origCol.name)}`);
    }
  }

  // Added and modified/renamed columns
  for (let index = 0; index < currCols.length; index += 1) {
    const col = currCols[index]!;
    const pos = index === 0 ? 'FIRST' : `AFTER ${escapeIdentifier(currCols[index - 1]!.name)}`;

    if (!col.originalName) {
      // New column
      clauses.push(`ADD COLUMN ${formatColumnDef(col)} ${pos}`);
    } else {
      // Existing column: check if name or definition changed
      const origCol = origCols.find(
        (o) => o.name.toLowerCase() === col.originalName!.toLowerCase()
      );

      const origPos = origCol ? origCols.indexOf(origCol) : -1;
      const expectedOrigPrev = origPos > 0 ? origCols[origPos - 1]?.name : undefined;
      const currentPrev = index > 0 ? currCols[index - 1]?.name : undefined;
      const positionChanged = (index === 0 && origPos !== 0) || (index > 0 && currentPrev !== expectedOrigPrev);

      const nameChanged = col.name !== col.originalName;
      const defChanged = !origCol || isColumnDefChanged(origCol, col) || positionChanged;

      if (nameChanged) {
        clauses.push(
          `CHANGE COLUMN ${escapeIdentifier(col.originalName)} ${formatColumnDef(col)} ${pos}`
        );
      } else if (defChanged) {
        clauses.push(`MODIFY COLUMN ${formatColumnDef(col)} ${pos}`);
      }
    }
  }

  // Add new PK if changed and not empty
  if (pkChanged && currPk.length > 0) {
    clauses.push(`ADD PRIMARY KEY (${currPk.map(escapeIdentifier).join(', ')})`);
  }

  // Compare indexes
  const origIndexes = state.originalIndexes || [];
  const currIndexes = state.indexes || [];

  // Dropped indexes
  const remainingOrigIdxNames = new Set(
    currIndexes.map((idx) => (idx.originalName ? idx.originalName.toLowerCase() : idx.name.toLowerCase()))
  );
  for (const origIdx of origIndexes) {
    if (!remainingOrigIdxNames.has(origIdx.name.toLowerCase())) {
      clauses.push(`DROP INDEX ${escapeIdentifier(origIdx.name)}`);
    }
  }

  // Added and modified indexes
  for (const idx of currIndexes) {
    const origIdx = origIndexes.find(
      (o) => o.name.toLowerCase() === (idx.originalName || idx.name).toLowerCase()
    );
    if (!origIdx) {
      const idxCols = idx.columns.map(escapeIdentifier).join(', ');
      const commentClause = idx.comment && idx.comment.trim() ? ` COMMENT '${escapeSqlString(idx.comment.trim())}'` : '';
      const methodClause = idx.method && ['BTREE', 'HASH'].includes(idx.method.toUpperCase()) ? ` USING ${idx.method.toUpperCase()}` : '';
      if (idx.type === 'UNIQUE') {
        clauses.push(`ADD UNIQUE KEY ${escapeIdentifier(idx.name.trim())} (${idxCols})${methodClause}${commentClause}`);
      } else if (idx.type === 'FULLTEXT') {
        clauses.push(`ADD FULLTEXT KEY ${escapeIdentifier(idx.name.trim())} (${idxCols})${commentClause}`);
      } else {
        clauses.push(`ADD INDEX ${escapeIdentifier(idx.name.trim())} (${idxCols})${methodClause}${commentClause}`);
      }
    } else {
      const colsChanged = origIdx.columns.join(',') !== idx.columns.join(',');
      const typeChanged = origIdx.type !== idx.type;
      const methodChanged = (origIdx.method || '') !== (idx.method || '');
      const commentChanged = (origIdx.comment || '') !== (idx.comment || '');
      const nameChanged = origIdx.name !== idx.name;

      if (colsChanged || typeChanged || methodChanged || commentChanged || nameChanged) {
        clauses.push(`DROP INDEX ${escapeIdentifier(origIdx.name)}`);
        const idxCols = idx.columns.map(escapeIdentifier).join(', ');
        const commentClause = idx.comment && idx.comment.trim() ? ` COMMENT '${escapeSqlString(idx.comment.trim())}'` : '';
        const methodClause = idx.method && ['BTREE', 'HASH'].includes(idx.method.toUpperCase()) ? ` USING ${idx.method.toUpperCase()}` : '';
        if (idx.type === 'UNIQUE') {
          clauses.push(`ADD UNIQUE KEY ${escapeIdentifier(idx.name.trim())} (${idxCols})${methodClause}${commentClause}`);
        } else if (idx.type === 'FULLTEXT') {
          clauses.push(`ADD FULLTEXT KEY ${escapeIdentifier(idx.name.trim())} (${idxCols})${commentClause}`);
        } else {
          clauses.push(`ADD INDEX ${escapeIdentifier(idx.name.trim())} (${idxCols})${methodClause}${commentClause}`);
        }
      }
    }
  }

  // Table options changes
  if (state.originalOptions) {
    if (state.options.comment !== state.originalOptions.comment) {
      clauses.push(`COMMENT = '${escapeSqlString(state.options.comment || '')}'`);
    }
    if (state.options.engine && state.options.engine !== state.originalOptions.engine) {
      clauses.push(`ENGINE = ${state.options.engine}`);
    }
    if (state.options.charset && state.options.charset !== state.originalOptions.charset) {
      clauses.push(`DEFAULT CHARACTER SET = ${state.options.charset}${state.options.collation ? ` COLLATE = ${state.options.collation}` : ''}`);
    } else if (state.options.collation && state.options.collation !== state.originalOptions.collation) {
      clauses.push(`COLLATE = ${state.options.collation}`);
    }
    if (state.options.autoIncrement && state.options.autoIncrement !== state.originalOptions.autoIncrement) {
      clauses.push(`AUTO_INCREMENT = ${state.options.autoIncrement}`);
    }
  }

  // Table rename
  if (origTableName !== currentTableName) {
    clauses.push(`RENAME TO ${escapeIdentifier(state.database)}.${escapeIdentifier(currentTableName)}`);
  }

  if (clauses.length === 0) {
    return '-- 当前没有未保存的结构变更';
  }

  return `ALTER TABLE ${targetTable}\n  ${clauses.join(',\n  ')};`;
}

function isColumnDefChanged(orig: DesignerColumn, curr: DesignerColumn): boolean {
  if (orig.dataType.toLowerCase() !== curr.dataType.toLowerCase()) return true;
  if ((orig.length || '') !== (curr.length || '')) return true;
  if ((orig.scale || '') !== (curr.scale || '')) return true;
  if (orig.notNull !== curr.notNull) return true;
  if (Boolean(orig.autoIncrement) !== Boolean(curr.autoIncrement)) return true;
  if ((orig.defaultValue ?? '') !== (curr.defaultValue ?? '')) return true;
  if ((orig.comment || '') !== (curr.comment || '')) return true;
  if ((orig.collation || '') !== (curr.collation || '')) return true;
  return false;
}

export function generatePreviewSql(state: TableDesignerState): string {
  const validation = validateDesignerState(state);
  if (!validation.valid) {
    return `-- 无法生成 SQL，请检查错误：\n-- ${validation.errors.join('\n-- ')}`;
  }
  if (state.mode === 'create') {
    return generateCreateTableSql(state);
  }
  return generateAlterTableSql(state);
}
