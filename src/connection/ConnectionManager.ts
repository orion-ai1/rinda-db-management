import { createConnection as createRawConnection } from 'mysql2';
import type { Connection as RawConnection, ConnectionOptions } from 'mysql2';
import { createPool } from 'mysql2/promise';
import type { Pool, PoolConnection, PoolOptions } from 'mysql2/promise';
import type * as vscode from 'vscode';
import { redactSensitiveText } from '../security/redaction.js';
import type { ConnectionStore } from './ConnectionStore.js';

export class ConnectionManager {
  private readonly pools = new Map<string, Pool>();
  private readonly poolConnections = new Map<string, Set<PoolConnection>>();

  public constructor(
    private readonly store: ConnectionStore,
    private readonly output: vscode.OutputChannel
  ) {}

  public isConnected(id: string): boolean {
    return this.pools.has(id);
  }

  public async connect(id: string): Promise<void> {
    const pool = await this.getOrCreatePool(id);
    const connection = await pool.getConnection();
    this.trackPoolConnection(id, connection);
    try {
      await connection.ping();
      const profile = this.store.getRequired(id);
      this.output.appendLine(`[连接] ${profile.name} (${profile.host}:${profile.port}) 已连接`);
    } finally {
      connection.release();
    }
  }

  public async test(id: string): Promise<number> {
    const start = performance.now();
    try {
      await this.connect(id);
      return Math.round(performance.now() - start);
    } catch (error) {
      await this.disconnect(id);
      const password = await this.store.getPassword(id);
      this.output.appendLine(`[错误] ${redactSensitiveText(error, password ? [password] : [])}`);
      throw error;
    }
  }

  public async withConnection<T>(
    id: string,
    operation: (connection: PoolConnection) => Promise<T>
  ): Promise<T> {
    const pool = await this.getOrCreatePool(id);
    const connection = await pool.getConnection();
    this.trackPoolConnection(id, connection);
    try {
      return await operation(connection);
    } catch (error) {
      const password = await this.store.getPassword(id);
      this.output.appendLine(`[错误] ${redactSensitiveText(error, password ? [password] : [])}`);
      throw error;
    } finally {
      connection.release();
    }
  }

  public async withStreamingConnection<T>(
    id: string,
    operation: (connection: RawConnection) => Promise<T>
  ): Promise<T> {
    const options = await this.buildConnectionOptions(id);
    const connection = createRawConnection(options);
    try {
      return await operation(connection);
    } catch (error) {
      const password = await this.store.getPassword(id);
      this.output.appendLine(`[错误] ${redactSensitiveText(error, password ? [password] : [])}`);
      throw error;
    } finally {
      connection.destroy();
    }
  }

  public async executeScript(
    id: string,
    database: string,
    sql: string,
    signal?: AbortSignal
  ): Promise<void> {
    const options = await this.buildConnectionOptions(id);
    options.database = database;
    options.multipleStatements = true;
    const connection = createRawConnection(options);
    try {
      if (signal?.aborted) throw new Error('操作已取消');
      const onAbort = (): void => {
        connection.destroy();
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      try {
        await new Promise<void>((resolve, reject) => {
          connection.query(sql, (err) => {
            if (err) reject(err);
            else resolve();
          });
        });
      } finally {
        signal?.removeEventListener('abort', onAbort);
      }
    } catch (error) {
      const password = await this.store.getPassword(id);
      this.output.appendLine(`[错误] 执行脚本失败: ${redactSensitiveText(error, password ? [password] : [])}`);
      throw error;
    } finally {
      connection.destroy();
    }
  }

  public async disconnect(id: string): Promise<void> {
    const pool = this.pools.get(id);
    if (!pool) {
      return;
    }
    this.pools.delete(id);
    const connections = [...(this.poolConnections.get(id) ?? [])];
    this.poolConnections.delete(id);
    await closePool(pool);
    for (const connection of connections) connection.destroy();
    const profile = this.store.get(id);
    if (profile) {
      this.output.appendLine(`[连接] ${profile.name} 已断开`);
    }
  }

  public async reset(id: string): Promise<void> {
    await this.disconnect(id);
  }

  public async dispose(): Promise<void> {
    const pools = [...this.pools.values()];
    const connections = [...this.poolConnections.values()].flatMap((items) => [...items]);
    this.pools.clear();
    this.poolConnections.clear();
    await Promise.allSettled(pools.map(closePool));
    for (const connection of connections) connection.destroy();
  }

  private async getOrCreatePool(id: string): Promise<Pool> {
    const existing = this.pools.get(id);
    if (existing) {
      return existing;
    }
    const options: PoolOptions = {
      ...await this.buildConnectionOptions(id),
      connectionLimit: 5
    };
    const pool = createPool(options);
    this.pools.set(id, pool);
    return pool;
  }

  private async buildConnectionOptions(id: string): Promise<ConnectionOptions> {
    const profile = this.store.getRequired(id);
    const password = await this.store.getPassword(id) ?? '';
    return {
      host: profile.host,
      port: profile.port,
      user: profile.user,
      password,
      database: profile.database,
      ssl: profile.ssl ? {} : undefined,
      connectTimeout: 10_000,
      enableKeepAlive: true,
      keepAliveInitialDelay: 0,
      multipleStatements: false,
      namedPlaceholders: false,
      dateStrings: true,
      supportBigNumbers: true,
      bigNumberStrings: true,
      decimalNumbers: false
    };
  }

  private trackPoolConnection(id: string, connection: PoolConnection): void {
    const connections = this.poolConnections.get(id) ?? new Set<PoolConnection>();
    connections.add(connection);
    this.poolConnections.set(id, connections);
  }
}

async function closePool(pool: Pool): Promise<void> {
  const core = pool.pool as unknown as {
    _allConnections?: { length: number; get(index: number): { destroy(): void } | undefined };
  };
  const connections: Array<{ destroy(): void }> = [];
  const collection = core._allConnections;
  if (collection) {
    for (let index = 0; index < collection.length; index += 1) {
      const connection = collection.get(index);
      if (connection) connections.push(connection);
    }
  }
  try {
    await pool.end();
  } finally {
    // mysql2 3.24 mutates its internal connection queue while ending it; destroy the
    // pre-end snapshot as a final safety net so extension deactivation cannot leak sockets.
    for (const connection of connections) connection.destroy();
  }
}
