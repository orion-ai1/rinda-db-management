import type { ColumnMetadata, RowLocator, TableEditMetadata, UniqueIndexMetadata } from './types.js';

const LARGE_KEY_TYPES = new Set([
  'tinytext', 'text', 'mediumtext', 'longtext',
  'tinyblob', 'blob', 'mediumblob', 'longblob', 'json', 'geometry'
]);

const BINARY_TYPES = new Set(['binary', 'varbinary', 'tinyblob', 'blob', 'mediumblob', 'longblob']);
const SPATIAL_TYPES = new Set([
  'geometry', 'point', 'linestring', 'polygon', 'multipoint', 'multilinestring',
  'multipolygon', 'geometrycollection'
]);

export function selectRowLocator(
  metadata: TableEditMetadata,
  availableColumns?: readonly string[]
): RowLocator | undefined {
  const available = availableColumns ? new Set(availableColumns) : undefined;
  const candidates = metadata.uniqueIndexes.filter((index) => isReliableIndex(index)
    && (!available || index.columns.every((column) => available.has(column.name))));
  const primary = candidates.find((index) => index.primary);
  const selected = primary ?? candidates
    .filter((index) => !index.primary)
    .sort((left, right) => scoreIndex(left, metadata.columns) - scoreIndex(right, metadata.columns))[0];
  if (!selected) return undefined;
  return {
    kind: selected.primary ? 'primary' : 'unique',
    indexName: selected.name,
    columns: selected.columns.map((column) => column.name),
    permitsNullableValues: selected.columns.some((column) => column.nullable)
  };
}

export function isColumnEditable(column: ColumnMetadata, locator?: RowLocator): boolean {
  if (!locator) return false;
  if (locator.columns.includes(column.name)) return false;
  if (column.extra.toLowerCase().includes('auto_increment')) return false;
  if (column.extra.toLowerCase().includes('generated') || column.generationExpression) return false;
  if (BINARY_TYPES.has(column.dataType) || column.characterSet === 'binary') return false;
  if (SPATIAL_TYPES.has(column.dataType)) return false;
  return true;
}

export function columnReadOnlyReason(column: ColumnMetadata, locator?: RowLocator): string | undefined {
  if (!locator) return '表缺少可靠主键或唯一键';
  if (locator.columns.includes(column.name)) return '定位键字段暂不支持编辑';
  if (column.extra.toLowerCase().includes('auto_increment')) return '自增字段不可编辑';
  if (column.extra.toLowerCase().includes('generated') || column.generationExpression) return '生成字段不可编辑';
  if (BINARY_TYPES.has(column.dataType) || column.characterSet === 'binary') return 'BLOB/二进制字段暂不支持编辑';
  if (SPATIAL_TYPES.has(column.dataType)) return '空间字段暂不支持编辑';
  return undefined;
}

export function metadataSignature(metadata: TableEditMetadata, locator: RowLocator): string {
  return JSON.stringify({
    locator,
    columns: metadata.columns.map((column) => ({
      name: column.name,
      type: column.columnType,
      nullable: column.nullable,
      extra: column.extra,
      generationExpression: column.generationExpression ?? ''
    }))
  });
}

function isReliableIndex(index: UniqueIndexMetadata): boolean {
  return index.columns.length > 0 && index.columns.every((column) => column.prefixLength === undefined);
}

function scoreIndex(index: UniqueIndexMetadata, columns: ColumnMetadata[]): number {
  const columnMap = new Map(columns.map((column) => [column.name, column]));
  const nullablePenalty = index.columns.some((column) => column.nullable) ? 10_000 : 0;
  const largePenalty = index.columns.some((column) => LARGE_KEY_TYPES.has(columnMap.get(column.name)?.dataType ?? ''))
    ? 1_000
    : 0;
  return nullablePenalty + largePenalty + index.columns.length;
}
