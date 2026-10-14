import * as path from 'node:path';

export const SQL_KEYWORDS = [
  'SELECT', 'FROM', 'WHERE', 'JOIN', 'LEFT JOIN', 'RIGHT JOIN', 'INNER JOIN', 'CROSS JOIN',
  'ON', 'GROUP BY', 'ORDER BY', 'HAVING', 'LIMIT', 'OFFSET', 'INSERT INTO', 'VALUES',
  'UPDATE', 'SET', 'DELETE FROM', 'CREATE TABLE', 'ALTER TABLE', 'DROP TABLE',
  'TRUNCATE TABLE', 'EXPLAIN', 'DESCRIBE', 'SHOW TABLES', 'SHOW DATABASES', 'UNION',
  'UNION ALL', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END', 'AND', 'OR', 'NOT', 'IN',
  'BETWEEN', 'LIKE', 'IS NULL', 'IS NOT NULL', 'EXISTS', 'DISTINCT', 'AS', 'PRIMARY KEY',
  'FOREIGN KEY', 'REFERENCES', 'AUTO_INCREMENT', 'DEFAULT', 'NULL', 'UNIQUE', 'INDEX'
];

export interface SqlFunctionItem {
  name: string;
  snippet: string;
  desc: string;
}

export const SQL_FUNCTIONS: SqlFunctionItem[] = [
  { name: 'COUNT', snippet: 'COUNT(${1:*})', desc: '统计记录总数' },
  { name: 'SUM', snippet: 'SUM(${1:column})', desc: '求数值总和' },
  { name: 'AVG', snippet: 'AVG(${1:column})', desc: '求平均值' },
  { name: 'MIN', snippet: 'MIN(${1:column})', desc: '求最小值' },
  { name: 'MAX', snippet: 'MAX(${1:column})', desc: '求最大值' },
  { name: 'NOW', snippet: 'NOW()', desc: '当前日期和时间' },
  { name: 'CURRENT_TIMESTAMP', snippet: 'CURRENT_TIMESTAMP()', desc: '当前时间戳' },
  { name: 'CONCAT', snippet: 'CONCAT(${1:str1}, ${2:str2})', desc: '拼接字符串' },
  { name: 'IFNULL', snippet: 'IFNULL(${1:expr1}, ${2:default_val})', desc: 'NULL 判断与默认值' },
  { name: 'COALESCE', snippet: 'COALESCE(${1:val1}, ${2:val2})', desc: '返回参数列表第一个非空值' },
  { name: 'DATE_FORMAT', snippet: "DATE_FORMAT(${1:date}, '${2:%Y-%m-%d %H:%i:%s}')", desc: '格式化日期' },
  { name: 'DATE_ADD', snippet: 'DATE_ADD(${1:date}, INTERVAL ${2:1} DAY)', desc: '日期增加时间段' },
  { name: 'DATE_SUB', snippet: 'DATE_SUB(${1:date}, INTERVAL ${2:1} DAY)', desc: '日期减少时间段' },
  { name: 'DATEDIFF', snippet: 'DATEDIFF(${1:date1}, ${2:date2})', desc: '计算两日期相差天数' },
  { name: 'LOWER', snippet: 'LOWER(${1:str})', desc: '转小写' },
  { name: 'UPPER', snippet: 'UPPER(${1:str})', desc: '转大写' },
  { name: 'SUBSTRING', snippet: 'SUBSTRING(${1:str}, ${2:pos}, ${3:len})', desc: '截取字符串' },
  { name: 'LENGTH', snippet: 'LENGTH(${1:str})', desc: '计算字符串字节长度' },
  { name: 'TRIM', snippet: 'TRIM(${1:str})', desc: '去除首尾空格' },
  { name: 'REPLACE', snippet: "REPLACE(${1:str}, '${2:search}', '${3:replace}')", desc: '替换字符串' },
  { name: 'ROUND', snippet: 'ROUND(${1:val}, ${2:2})', desc: '四舍五入' },
  { name: 'FLOOR', snippet: 'FLOOR(${1:val})', desc: '向下取整' },
  { name: 'CEIL', snippet: 'CEIL(${1:val})', desc: '向上取整' },
  { name: 'JSON_EXTRACT', snippet: "JSON_EXTRACT(${1:json_doc}, '$.${2:path}')", desc: '提取 JSON 字段内容' },
  { name: 'JSON_UNQUOTE', snippet: 'JSON_UNQUOTE(${1:json_val})', desc: '去除 JSON 引号' }
];

export function isTableContextPrefix(prefix: string): boolean {
  return /\b(from|join|into|update|table|desc|describe|truncate)\s+[a-zA-Z0-9_$.`]*$/i.test(prefix);
}

export function extractTableQualifier(prefix: string): string | undefined {
  const dotMatch = prefix.match(/([a-zA-Z0-9_$`]+)\.\s*$/);
  if (dotMatch && dotMatch[1]) {
    return dotMatch[1].replace(/[`"']/g, '').toLowerCase();
  }
  return undefined;
}

export function extractTableAliases(sql: string): Map<string, string> {
  const aliases = new Map<string, string>();
  const regex = /\b(?:from|join)\s+[`"]?([a-zA-Z0-9_$]+)[`"]?(?:\s+(?:as\s+)?[`"]?([a-zA-Z0-9_$]+)[`"]?)?/gi;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(sql)) !== null) {
    const table = match[1]?.toLowerCase();
    const alias = match[2]?.toLowerCase();
    if (
      table &&
      alias &&
      !['where', 'on', 'join', 'inner', 'left', 'right', 'cross', 'group', 'order', 'having', 'limit', 'set', 'into', 'using'].includes(alias)
    ) {
      aliases.set(alias, table);
    }
  }
  return aliases;
}

export function extractContextFromText(text: string, filePath?: string): { profileName?: string; database?: string } {
  let profileName: string | undefined;
  let database: string | undefined;

  // Try finding -- Active: <profile> · <database>
  const activeMatch = text.match(/--\s*Active:\s*([^\n·\r]+)·\s*([a-zA-Z0-9_$]+)/i);
  if (activeMatch && activeMatch[1] && activeMatch[2]) {
    profileName = activeMatch[1].trim();
    database = activeMatch[2].trim();
  }

  // Try finding -- Database: <database>
  if (!database) {
    const dbCommentMatch = text.match(/--\s*Database:\s*([a-zA-Z0-9_$]+)/i);
    if (dbCommentMatch && dbCommentMatch[1]) {
      database = dbCommentMatch[1].trim();
    }
  }

  // Try finding file path pattern: .../queries/<conn>/<db>/ or .../storage/<conn>/<db>/ or .../.rinda/<conn>/<db>/
  if (!database && filePath) {
    const parts = filePath.split(path.sep);
    const queriesIdx = parts.indexOf('queries');
    if (queriesIdx >= 0 && parts.length > queriesIdx + 2) {
      const dbPart = parts[queriesIdx + 2];
      if (dbPart && dbPart !== 'security') {
        database = dbPart;
      }
    }
    if (!database) {
      const storageIdx = parts.indexOf('storage');
      if (storageIdx >= 0 && parts.length > storageIdx + 2) {
        const dbPart = parts[storageIdx + 2];
        if (dbPart && dbPart !== 'security') {
          database = dbPart;
        }
      }
    }
    if (!database) {
      const rindaIdx = parts.findIndex((p) => p.startsWith('.rinda'));
      if (rindaIdx >= 0 && parts.length > rindaIdx + 2) {
        const nextPart = parts[rindaIdx + 1];
        if (nextPart !== 'queries' && nextPart !== 'storage' && parts.length > rindaIdx + 2) {
          const dbPart = parts[rindaIdx + 2];
          if (dbPart && dbPart !== 'security') {
            database = dbPart;
          }
        }
      }
    }
  }

  // Try finding USE `dbname`;
  if (!database) {
    const useMatch = text.match(/\buse\s+[`"']?([a-zA-Z0-9_$]+)[`"']?\s*;/i);
    if (useMatch && useMatch[1]) {
      database = useMatch[1].trim();
    }
  }

  return { profileName, database };
}
