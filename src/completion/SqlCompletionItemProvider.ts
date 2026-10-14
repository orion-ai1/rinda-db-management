import * as vscode from 'vscode';
import type { ConnectionStore } from '../connection/ConnectionStore.js';
import type { MetadataRepository, DatabaseObject, ColumnInfo } from '../explorer/metadataRepository.js';
import {
  SQL_KEYWORDS,
  SQL_FUNCTIONS,
  isTableContextPrefix,
  extractTableQualifier,
  extractTableAliases,
  extractContextFromText
} from './sqlCompletionHelpers.js';

interface CachedDatabaseMetadata {
  objects: DatabaseObject[];
  columns: ColumnInfo[];
  fetchedAt: number;
}

const CACHE_TTL_MS = 3 * 60 * 1000; // 3 minutes cache

export class SqlCompletionItemProvider implements vscode.CompletionItemProvider {
  private readonly cache = new Map<string, CachedDatabaseMetadata>();

  public constructor(
    private readonly store: ConnectionStore,
    private readonly metadata: MetadataRepository,
    private readonly globalState: vscode.Memento
  ) {}

  public clearCache(): void {
    this.cache.clear();
  }

  public async provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position
  ): Promise<vscode.CompletionItem[]> {
    const lineText = document.lineAt(position).text;
    const prefix = lineText.substring(0, position.character);

    // Skip string literals or comments
    const trimmedBefore = prefix.trimStart();
    if (trimmedBefore.startsWith('--') || trimmedBefore.startsWith('#')) {
      return [];
    }

    const { connectionId, database } = this.resolveContext(document);
    let dbMeta: CachedDatabaseMetadata | undefined;
    if (connectionId && database) {
      dbMeta = await this.getOrFetchMetadata(connectionId, database);
    }

    const items: vscode.CompletionItem[] = [];

    // 1. Check if dot trigger: e.g. "users." or "`users`." or "u."
    const rawTarget = extractTableQualifier(prefix);
    if (rawTarget) {
      // Match against table names or aliases
      if (dbMeta) {
        const aliases = extractTableAliases(document.getText());
        const targetTable = aliases.get(rawTarget) || rawTarget;
        const tableColumns = dbMeta.columns.filter(
          (c) => c.table.toLowerCase() === targetTable
        );
        if (tableColumns.length > 0) {
          for (const col of tableColumns) {
            const item = new vscode.CompletionItem(col.column, vscode.CompletionItemKind.Field);
            item.detail = `${col.columnType}${col.nullable ? ' (NULL)' : ' (NOT NULL)'}`;
            item.documentation = col.comment
              ? new vscode.MarkdownString(`**${col.table}.${col.column}**\n\n${col.comment}`)
              : new vscode.MarkdownString(`所属表：\`${col.table}\``);
            item.insertText = col.column;
            items.push(item);
          }
          return items;
        }
      }
    }

    // 2. Check if table-expecting context: e.g. "FROM ", "JOIN ", "INTO ", "UPDATE ", "TABLE "
    const isTableContext = isTableContextPrefix(prefix);

    if (dbMeta) {
      // Add tables and views
      for (const obj of dbMeta.objects) {
        const item = new vscode.CompletionItem(
          obj.name,
          obj.type === 'view' ? vscode.CompletionItemKind.Interface : vscode.CompletionItemKind.Class
        );
        item.detail = obj.type === 'view' ? '视图 (VIEW)' : '数据表 (TABLE)';
        item.documentation = new vscode.MarkdownString(`数据库：\`${database}\`\n\n类型：${obj.type}`);
        item.insertText = obj.name;
        // Prioritize tables if in table context
        item.sortText = isTableContext ? `0_${obj.name}` : `1_${obj.name}`;
        items.push(item);
      }

      // If NOT purely table context, also suggest columns from active database
      if (!isTableContext) {
        // Collect unique column names
        const seenColumns = new Set<string>();
        for (const col of dbMeta.columns) {
          if (!seenColumns.has(col.column)) {
            seenColumns.add(col.column);
            const item = new vscode.CompletionItem(col.column, vscode.CompletionItemKind.Field);
            item.detail = `${col.columnType} · ${col.table}`;
            item.documentation = col.comment ? `${col.comment} (来自表 ${col.table})` : `来自表 ${col.table}`;
            item.insertText = col.column;
            item.sortText = `1_${col.column}`;
            items.push(item);
          }
        }
      }
    }

    // 3. Keywords
    for (const kw of SQL_KEYWORDS) {
      const item = new vscode.CompletionItem(kw, vscode.CompletionItemKind.Keyword);
      item.detail = 'SQL 关键字';
      item.sortText = `2_${kw}`;
      items.push(item);
    }

    // 4. Common Functions
    for (const fn of SQL_FUNCTIONS) {
      const item = new vscode.CompletionItem(fn.name, vscode.CompletionItemKind.Function);
      item.detail = `函数: ${fn.desc}`;
      item.insertText = new vscode.SnippetString(fn.snippet);
      item.sortText = `3_${fn.name}`;
      items.push(item);
    }

    return items;
  }

  private resolveContext(document: vscode.TextDocument): { connectionId?: string; database?: string } {
    const text = document.getText(new vscode.Range(0, 0, Math.min(25, document.lineCount), 0));
    const filePath = document.uri.scheme === 'file' ? document.uri.fsPath : undefined;
    const { profileName, database: parsedDb } = extractContextFromText(text, filePath);

    let connectionId: string | undefined;
    if (profileName) {
      const profile = this.store.list().find((p) => p.name === profileName);
      if (profile) connectionId = profile.id;
    }
    if (!connectionId) {
      connectionId = this.globalState.get<string>('rindaMysql.lastConnectionId');
    }
    if (!connectionId) {
      const first = this.store.list()[0];
      if (first) connectionId = first.id;
    }

    const matchedDb = parsedDb || this.globalState.get<string>('rindaMysql.lastDatabase');

    return { connectionId, database: matchedDb };
  }

  private async getOrFetchMetadata(connectionId: string, database: string): Promise<CachedDatabaseMetadata | undefined> {
    const cacheKey = `${connectionId}:${database}`;
    const cached = this.cache.get(cacheKey);
    const now = Date.now();
    if (cached && now - cached.fetchedAt < CACHE_TTL_MS) {
      return cached;
    }

    try {
      const [objects, columns] = await Promise.all([
        this.metadata.listObjects(connectionId, database).catch(() => []),
        this.metadata.listColumns(connectionId, database).catch(() => [])
      ]);
      const entry: CachedDatabaseMetadata = {
        objects,
        columns,
        fetchedAt: now
      };
      this.cache.set(cacheKey, entry);
      return entry;
    } catch {
      return cached;
    }
  }
}
