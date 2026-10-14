import { isColumnEditable } from './RowLocatorService.js';
import type { ColumnMetadata, RowLocator, TableEditMetadata } from './types.js';

const MAX_EDIT_PAYLOAD_CHARACTERS = 1_000_000;
const INTEGER_RANGES: Record<string, [bigint, bigint]> = {
  tinyint: [-128n, 127n],
  smallint: [-32_768n, 32_767n],
  mediumint: [-8_388_608n, 8_388_607n],
  int: [-2_147_483_648n, 2_147_483_647n],
  integer: [-2_147_483_648n, 2_147_483_647n],
  bigint: [-9_223_372_036_854_775_808n, 9_223_372_036_854_775_807n]
};

export interface EditValidationResult {
  values?: Record<string, string | null>;
  errors: Record<string, string>;
}

export function validateRowChanges(
  changes: unknown,
  metadata: TableEditMetadata,
  locator: RowLocator
): EditValidationResult {
  if (!isRecord(changes)) return { errors: { form: '编辑数据格式无效。' } };
  const columnMap = new Map(metadata.columns.map((column) => [column.name, column]));
  const values: Record<string, string | null> = {};
  const errors: Record<string, string> = {};
  let totalCharacters = 0;

  for (const [name, rawValue] of Object.entries(changes)) {
    const column = columnMap.get(name);
    if (!column || !isColumnEditable(column, locator)) {
      errors[name] = '该字段不可编辑。';
      continue;
    }
    if (rawValue === null) {
      if (!column.nullable) errors[name] = '该字段不允许 NULL。';
      else values[name] = null;
      continue;
    }
    if (typeof rawValue !== 'string') {
      errors[name] = '字段值必须是文本或 NULL。';
      continue;
    }
    totalCharacters += rawValue.length;
    if (totalCharacters > MAX_EDIT_PAYLOAD_CHARACTERS) {
      errors.form = '本次编辑内容不能超过 1,000,000 个字符。';
      break;
    }
    const normalized = normalizeAndValidate(rawValue, column, errors);
    if (normalized !== undefined) values[name] = normalized;
  }

  if (Object.keys(changes).length === 0) errors.form = '没有需要保存的字段。';
  return Object.keys(errors).length > 0 ? { errors } : { values, errors };
}

export function validateInsertRow(
  changes: unknown,
  columnsOrMetadata: ColumnMetadata[] | { columns: ColumnMetadata[] }
): EditValidationResult {
  const columns = Array.isArray(columnsOrMetadata) ? columnsOrMetadata : (columnsOrMetadata?.columns ?? []);
  if (!isRecord(changes)) return { errors: { form: '插入数据格式无效。' } };
  const columnMap = new Map(columns.map((column) => [column.name, column]));
  const values: Record<string, string | null> = {};
  const errors: Record<string, string> = {};
  let totalCharacters = 0;

  for (const [name, rawValue] of Object.entries(changes)) {
    const column = columnMap.get(name);
    if (!column) {
      errors[name] = '未知字段。';
      continue;
    }
    if (column.extra.toLowerCase().includes('auto_increment')
      || column.extra.toLowerCase().includes('generated')
      || column.generationExpression) {
      continue;
    }
    if (rawValue === null) {
      if (!column.nullable) errors[name] = '该字段不允许 NULL。';
      else values[name] = null;
      continue;
    }
    if (typeof rawValue !== 'string') {
      errors[name] = '字段值必须是文本或 NULL。';
      continue;
    }
    totalCharacters += rawValue.length;
    if (totalCharacters > MAX_EDIT_PAYLOAD_CHARACTERS) {
      errors.form = '本次插入内容不能超过 1,000,000 个字符。';
      break;
    }
    const normalized = normalizeAndValidate(rawValue, column, errors);
    if (normalized !== undefined) values[name] = normalized;
  }

  if (Object.keys(values).length === 0 && Object.keys(errors).length === 0) {
    errors.form = '没有需要插入的字段。';
  }
  return Object.keys(errors).length > 0 ? { errors } : { values, errors };
}

function normalizeAndValidate(
  value: string,
  column: ColumnMetadata,
  errors: Record<string, string>
): string | undefined {
  const numericValue = value.trim();
  if (Object.hasOwn(INTEGER_RANGES, column.dataType)) {
    if (!/^[+-]?\d+$/.test(numericValue)) return fail(column.name, '请输入整数。', errors);
    try {
      const parsed = BigInt(numericValue);
      let [minimum, maximum] = INTEGER_RANGES[column.dataType] ?? [0n, 0n];
      if (/\bunsigned\b/i.test(column.columnType)) {
        maximum = maximum * 2n + 1n;
        minimum = 0n;
      }
      if (parsed < minimum || parsed > maximum) {
        return fail(column.name, `数值超出 ${column.columnType} 范围。`, errors);
      }
      return parsed.toString();
    } catch {
      return fail(column.name, '请输入有效整数。', errors);
    }
  }
  if (column.dataType === 'bit') {
    if (!/^\d+$/.test(numericValue)) return fail(column.name, 'BIT 字段请输入非负整数。', errors);
    const width = /bit\((\d+)\)/i.exec(column.columnType)?.[1];
    const maximum = (1n << BigInt(width ?? '1')) - 1n;
    const parsed = BigInt(numericValue);
    if (parsed > maximum) return fail(column.name, `数值超出 ${column.columnType} 范围。`, errors);
    return parsed.toString();
  }
  if (column.dataType === 'decimal' || column.dataType === 'numeric') {
    if (!/^[+-]?(?:\d+)(?:\.\d+)?$/.test(numericValue)) {
      return fail(column.name, '请输入有效十进制数。', errors);
    }
    const unsignedValue = numericValue.replace(/^[+-]/, '');
    const [integerPart = '', fractionPart = ''] = unsignedValue.split('.');
    const digits = integerPart.replace(/^0+(?=\d)/, '').length + fractionPart.length;
    if (column.numericPrecision !== undefined && digits > column.numericPrecision) {
      return fail(column.name, `总位数不能超过 ${column.numericPrecision}。`, errors);
    }
    if (column.numericScale !== undefined && fractionPart.length > column.numericScale) {
      return fail(column.name, `小数位不能超过 ${column.numericScale}。`, errors);
    }
    return numericValue;
  }
  if (['float', 'double', 'real'].includes(column.dataType)) {
    if (!numericValue || !Number.isFinite(Number(numericValue))) {
      return fail(column.name, '请输入有效数字。', errors);
    }
    return numericValue;
  }
  if (column.dataType === 'year') {
    if (!/^\d{4}$/.test(numericValue)) return fail(column.name, '请输入四位年份。', errors);
    const year = Number(numericValue);
    if (year !== 0 && (year < 1901 || year > 2155)) {
      return fail(column.name, '年份必须为 0000 或 1901–2155。', errors);
    }
    return numericValue;
  }
  if (column.dataType === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(numericValue)) {
    return fail(column.name, '日期格式应为 YYYY-MM-DD。', errors);
  }
  if (['datetime', 'timestamp'].includes(column.dataType)
    && !/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?$/.test(numericValue)) {
    return fail(column.name, '日期时间格式应为 YYYY-MM-DD HH:mm:ss。', errors);
  }
  if (column.dataType === 'time'
    && !/^-?\d{1,3}:[0-5]\d:[0-5]\d(?:\.\d{1,6})?$/.test(numericValue)) {
    return fail(column.name, '时间格式应为 HH:mm:ss。', errors);
  }
  if (column.dataType === 'json') {
    try {
      JSON.parse(value);
    } catch {
      return fail(column.name, '请输入有效 JSON。', errors);
    }
  }
  if (column.dataType === 'enum') {
    const allowed = parseMysqlLiterals(column.columnType);
    if (!allowed.includes(value)) return fail(column.name, '值不在 ENUM 允许范围内。', errors);
  }
  if (column.dataType === 'set') {
    const allowed = new Set(parseMysqlLiterals(column.columnType));
    if (value.split(',').some((item) => !allowed.has(item))) {
      return fail(column.name, '值包含 SET 未定义的选项。', errors);
    }
  }
  if (column.characterMaximumLength !== undefined
    && [...value].length > column.characterMaximumLength) {
    return fail(column.name, `长度不能超过 ${column.characterMaximumLength} 个字符。`, errors);
  }
  if (['date', 'datetime', 'timestamp', 'time'].includes(column.dataType)) return numericValue;
  return value;
}

function parseMysqlLiterals(columnType: string): string[] {
  const values: string[] = [];
  const pattern = /'((?:''|\\.|[^'])*)'/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(columnType)) !== null) {
    values.push((match[1] ?? '').replaceAll("''", "'").replace(/\\(.)/g, '$1'));
  }
  return values;
}

function fail(field: string, message: string, errors: Record<string, string>): undefined {
  errors[field] = message;
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
