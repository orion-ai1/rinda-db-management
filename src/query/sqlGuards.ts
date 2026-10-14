export function escapeIdentifier(identifier: string): string {
  return `\`${identifier.replaceAll('`', '``')}\``;
}

export function buildTablePreviewSql(database: string, table: string): string {
  return `SELECT * FROM ${escapeIdentifier(database)}.${escapeIdentifier(table)} LIMIT ? OFFSET ?`;
}

export function buildTablePreviewEditorSql(
  database: string,
  table: string,
  page: number,
  pageSize: number
): string {
  const safePage = Math.max(0, Math.trunc(page));
  const safePageSize = Math.max(1, Math.trunc(pageSize));
  return `SELECT * FROM ${escapeIdentifier(database)}.${escapeIdentifier(table)}\nLIMIT ${safePageSize} OFFSET ${safePage * safePageSize};`;
}

export function resolveExecutableSql(documentText: string, selectedText?: string): string {
  const sql = selectedText?.trim() || documentText.trim();
  if (!sql) {
    throw new Error('没有可执行的 SQL。请选择 SQL 或在编辑器中输入语句。');
  }
  return sql;
}

export function hasTopLevelLimit(sql: string): boolean {
  return findTopLevelLimit(sql) >= 0;
}

function findTopLevelLimit(sql: string): number {
  let depth = 0;
  let quote: "'" | '"' | '`' | undefined;
  let lineComment = false;
  let blockComment = false;
  let word = '';
  let wordStart = -1;

  for (let index = 0; index < sql.length; index += 1) {
    const char = sql[index] ?? '';
    const next = sql[index + 1] ?? '';
    if (lineComment) {
      if (char === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === '*' && next === '/') {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (char === '\\') {
        index += 1;
      } else if (char === quote) {
        if (quote === '`' && next === '`') index += 1;
        else quote = undefined;
      }
      continue;
    }
    if (char === '-' && next === '-' && /\s/.test(sql[index + 2] ?? '')) {
      lineComment = true;
      index += 1;
      continue;
    }
    if (char === '#') {
      lineComment = true;
      continue;
    }
    if (char === '/' && next === '*') {
      blockComment = true;
      index += 1;
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char;
      continue;
    }
    if (char === '(') depth += 1;
    if (char === ')') depth = Math.max(0, depth - 1);
    if (/[A-Za-z_]/.test(char)) {
      if (!word) wordStart = index;
      word += char;
      continue;
    }
    if (word) {
      if (depth === 0 && word.toLowerCase() === 'limit') return wordStart;
      word = '';
      wordStart = -1;
    }
  }
  return depth === 0 && word.toLowerCase() === 'limit' ? wordStart : -1;
}

export function applyResultLimit(sql: string, maximumRows: number): string {
  const trimmed = sql.trim().replace(/;\s*$/, '');
  if (!/^(select|with)\b/i.test(trimmed)) return trimmed;

  const cap = maximumRows + 1;
  const limitIndex = findTopLevelLimit(trimmed);
  if (limitIndex < 0) return `${trimmed} LIMIT ${cap}`;

  const suffix = trimmed.slice(limitIndex);
  const match = /^limit\s+(?:(\d+)\s*,\s*(\d+)|(\d+)(?:\s+offset\s+(\d+))?)/i.exec(suffix);
  if (!match) return trimmed;
  if (match[1] !== undefined && match[2] !== undefined) {
    const count = Math.min(Number(match[2]), cap);
    const replacement = `LIMIT ${match[1]}, ${count}`;
    return `${trimmed.slice(0, limitIndex)}${replacement}${suffix.slice(match[0].length)}`;
  }
  if (match[3] !== undefined) {
    const count = Math.min(Number(match[3]), cap);
    const offset = match[4] === undefined ? '' : ` OFFSET ${match[4]}`;
    const replacement = `LIMIT ${count}${offset}`;
    return `${trimmed.slice(0, limitIndex)}${replacement}${suffix.slice(match[0].length)}`;
  }
  return trimmed;
}
