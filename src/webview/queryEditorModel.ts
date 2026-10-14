export const MAX_PANEL_SQL_LENGTH = 1_000_000;

export type PanelSqlValidation =
  | { sql: string; error?: never }
  | { sql?: never; error: string };

export function validatePanelSql(value: unknown): PanelSqlValidation {
  if (typeof value !== 'string') return { error: 'SQL 内容格式无效。' };
  const sql = value.trim();
  if (!sql) return { error: '请输入要执行的 SQL。' };
  if (sql.length > MAX_PANEL_SQL_LENGTH) {
    return { error: `SQL 不能超过 ${MAX_PANEL_SQL_LENGTH.toLocaleString('en-US')} 个字符。` };
  }
  return { sql };
}

export function isSameTablePreviewSql(sql: string, database: string, table: string): boolean {
  const trimmed = sql.trim().replace(/;\s*$/, '');
  const escDb = escapeRegex(database);
  const escTbl = escapeRegex(table);
  const pattern = new RegExp(
    `^select\\s+\\*\\s+from\\s+([\\\`"']?${escDb}[\\\`"']?\\.)?[\\\`"']?${escTbl}[\\\`"']?(\\s+(limit|offset)\\b[\\s\\S]*)?$`,
    'i'
  );
  return pattern.test(trimmed);
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
