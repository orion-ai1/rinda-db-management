import type { ConnectionDraft, ConnectionProfile } from '../connection/types.js';

export type ConnectionFormResult = Omit<ConnectionDraft, 'password'> & { password?: string };

export interface ConnectionFormValidation {
  result?: ConnectionFormResult;
  errors: Record<string, string>;
}

export function validateConnectionFormPayload(
  payload: unknown,
  current?: ConnectionProfile
): ConnectionFormValidation {
  if (!isRecord(payload)) {
    return { errors: { form: '表单数据无效，请重新填写。' } };
  }

  const errors: Record<string, string> = {};
  const name = readText(payload.name, 'name', '请输入连接名称。', 128, errors);
  const host = readText(payload.host, 'host', '请输入主机名或 IP 地址。', 253, errors);
  const user = readText(payload.user, 'user', '请输入用户名。', 128, errors);
  const database = readOptionalText(payload.database, 'database', 128, errors);
  const password = typeof payload.password === 'string' ? payload.password : '';
  if (typeof payload.password !== 'string') errors.password = '密码格式无效。';
  if (password.length > 4_096) errors.password = '密码长度不能超过 4096 个字符。';

  const port = typeof payload.port === 'number' ? payload.port : Number(payload.port);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    errors.port = '请输入 1–65535 之间的整数。';
  }
  if (typeof payload.ssl !== 'boolean') errors.ssl = '请选择是否启用 SSL。';

  if (Object.keys(errors).length > 0) return { errors };
  return {
    errors,
    result: {
      name,
      host,
      port,
      user,
      password: current && password.length === 0 ? undefined : password,
      database: database || undefined,
      ssl: payload.ssl as boolean
    }
  };
}

function readText(
  value: unknown,
  field: string,
  requiredMessage: string,
  maximumLength: number,
  errors: Record<string, string>
): string {
  if (typeof value !== 'string' || !value.trim()) {
    errors[field] = requiredMessage;
    return '';
  }
  const normalized = value.trim();
  if (normalized.length > maximumLength) {
    errors[field] = `不能超过 ${maximumLength} 个字符。`;
  }
  return normalized;
}

function readOptionalText(
  value: unknown,
  field: string,
  maximumLength: number,
  errors: Record<string, string>
): string {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') {
    errors[field] = '字段格式无效。';
    return '';
  }
  const normalized = value.trim();
  if (normalized.length > maximumLength) {
    errors[field] = `不能超过 ${maximumLength} 个字符。`;
  }
  return normalized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
