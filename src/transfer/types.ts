export type SqlExportScope =
  | { kind: 'database'; database: string }
  | { kind: 'table'; database: string; table: string };

export interface ExportProgress {
  message: string;
  rows?: number;
  bytes?: number;
}

export interface ExportResult {
  targetPath: string;
  bytes: number;
  durationMs: number;
  rows?: number;
  sha256?: string;
  warnings: string[];
}

export interface MysqldumpTool {
  path: string;
  vendor: 'mysql' | 'mariadb';
  version: string;
  major: number;
  rawVersion: string;
}

export interface MysqlClientTool {
  path: string;
  vendor: 'mysql' | 'mariadb';
  version: string;
  major: number;
  rawVersion: string;
}

export interface SqlObjectSummary {
  tables: number;
  views: number;
  routines: number;
  events: number;
  triggers: number;
}

export interface SqlPackageMetadata {
  formatVersion: 2;
  contentPolicy: 'rinda-controlled-restore-v1';
  exportedAt: string;
  sourceServerVersion: string;
  scope: SqlExportScope;
  characterSet: 'utf8mb4';
  objects: SqlObjectSummary;
  restorePolicy: {
    standalone: boolean;
    reasons: string[];
  };
  tool: {
    vendor: 'mysql' | 'mariadb';
    version: string;
  };
}

export class ExportCancelledError extends Error {
  public constructor() {
    super('导出已取消。未生成不完整文件。');
    this.name = 'AbortError';
  }
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new ExportCancelledError();
}
