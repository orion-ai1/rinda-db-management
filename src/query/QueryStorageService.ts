import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ConnectionProfile } from '../connection/types.js';

export interface StoredQueryFile {
  name: string;
  path: string;
}

export class QueryStorageService {
  private readonly getRoot: () => string;
  private readonly getFallbackRoot?: () => string | undefined;

  public constructor(
    storageRoot: string | (() => string),
    fallbackStorageRoot?: string | (() => string | undefined)
  ) {
    this.getRoot = typeof storageRoot === 'function' ? storageRoot : () => storageRoot;
    if (fallbackStorageRoot) {
      this.getFallbackRoot = typeof fallbackStorageRoot === 'function' ? fallbackStorageRoot : () => fallbackStorageRoot;
    }
  }

  public get storageRoot(): string {
    return this.getRoot();
  }

  public getStorageDir(profile: ConnectionProfile, database?: string): string {
    const sanitize = (value: string): string => value.replace(/[^a-zA-Z0-9_\-\.]/g, '_');
    const dbPart = database ? sanitize(database) : 'security';
    const connPart = `${sanitize(profile.name)}@${sanitize(profile.host)}@${profile.port}`;
    return path.join(this.storageRoot, 'queries', connPart, dbPart);
  }

  public async listQueryFiles(
    profile: ConnectionProfile,
    database: string
  ): Promise<StoredQueryFile[]> {
    const sanitize = (value: string): string => value.replace(/[^a-zA-Z0-9_\-\.]/g, '_');
    const dbPart = sanitize(database);
    const connPart = `${sanitize(profile.name)}@${sanitize(profile.host)}@${profile.port}`;

    const candidateDirs: string[] = [
      path.join(this.storageRoot, 'queries', connPart, dbPart),
      path.join(this.storageRoot, 'storage', connPart, dbPart)
    ];

    const fallback = this.getFallbackRoot?.();
    if (fallback && fallback !== this.storageRoot) {
      candidateDirs.push(
        path.join(fallback, 'queries', connPart, dbPart),
        path.join(fallback, 'storage', connPart, dbPart)
      );
    }

    const seen = new Map<string, StoredQueryFile>();
    for (const dir of candidateDirs) {
      try {
        const entries = await fs.promises.readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isFile() && entry.name.endsWith('.sql') && !seen.has(entry.name)) {
            seen.set(entry.name, {
              name: entry.name,
              path: path.join(dir, entry.name)
            });
          }
        }
      } catch {
        // ignore missing or unreadable directories
      }
    }

    return [...seen.values()].sort((a, b) => b.name.localeCompare(a.name));
  }

  public async createUserTemplateFile(profile: ConnectionProfile): Promise<string> {
    const dir = this.getStorageDir(profile, 'security');
    await fs.promises.mkdir(dir, { recursive: true });

    const content = `CREATE USER ''@'%' IDENTIFIED BY 'password';
-- Grant select privilege to all databases;
GRANT SELECT ON *.* TO ''@'%' WITH GRANT OPTION;
-- Grant all privileges to all databases;
GRANT ALL PRIVILEGES ON *.* TO ''@'%' WITH GRANT OPTION;
`;

    const fileName = 'create-user-template.sql';
    const filePath = path.join(dir, fileName);
    await fs.promises.writeFile(filePath, content, 'utf8');
    return filePath;
  }

  public async createQueryFile(
    profile: ConnectionProfile,
    database: string,
    initialSql?: string
  ): Promise<string> {
    const dir = this.getStorageDir(profile, database);
    await fs.promises.mkdir(dir, { recursive: true });

    const now = new Date();
    const pad = (n: number): string => String(n).padStart(2, '0');
    const timestamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    const fileName = `query_${timestamp}.sql`;
    const filePath = path.join(dir, fileName);

    const content =
      initialSql ||
      `-- Active: ${profile.name} · ${database}
-- 选中 SQL 后按 Cmd/Ctrl+R 执行选中部分；按 Cmd/Ctrl+Enter 执行全文。

SELECT 1;
`;

    await fs.promises.writeFile(filePath, content, 'utf8');
    return filePath;
  }

  public async createViewTemplateFile(
    profile: ConnectionProfile,
    database: string
  ): Promise<string> {
    const dir = this.getStorageDir(profile, database);
    await fs.promises.mkdir(dir, { recursive: true });

    const content = `-- Active: ${profile.name} · ${database}
CREATE OR REPLACE VIEW \`new_view\` AS
SELECT 1;
`;

    const filePath = path.join(dir, 'create-view-template.sql');
    await fs.promises.writeFile(filePath, content, 'utf8');
    return filePath;
  }

  public async createFunctionTemplateFile(
    profile: ConnectionProfile,
    database: string
  ): Promise<string> {
    const dir = this.getStorageDir(profile, database);
    await fs.promises.mkdir(dir, { recursive: true });

    const content = `-- Active: ${profile.name} · ${database}
DELIMITER $$

CREATE FUNCTION \`new_function\`() RETURNS INTEGER
DETERMINISTIC
BEGIN
  RETURN 1;
END$$

DELIMITER ;
`;

    const filePath = path.join(dir, 'create-function-template.sql');
    await fs.promises.writeFile(filePath, content, 'utf8');
    return filePath;
  }

  public async createProcedureTemplateFile(
    profile: ConnectionProfile,
    database: string
  ): Promise<string> {
    const dir = this.getStorageDir(profile, database);
    await fs.promises.mkdir(dir, { recursive: true });

    const content = `-- Active: ${profile.name} · ${database}
DELIMITER $$

CREATE PROCEDURE \`new_procedure\`()
BEGIN
  SELECT 1;
END$$

DELIMITER ;
`;

    const filePath = path.join(dir, 'create-procedure-template.sql');
    await fs.promises.writeFile(filePath, content, 'utf8');
    return filePath;
  }

  public async deleteFile(filePath: string): Promise<void> {
    try {
      await fs.promises.unlink(filePath);
    } catch {
      // ignore
    }
  }
}
