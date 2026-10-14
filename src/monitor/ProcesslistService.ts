import type { ConnectionManager } from '../connection/ConnectionManager.js';
import { redactSensitiveText } from '../security/redaction.js';
import type { KillProcessResult, ProcessItem, ProcesslistSnapshot } from './ProcesslistTypes.js';

export class ProcesslistService {
  public constructor(private readonly connections: ConnectionManager) {}

  public async getSnapshot(connectionId: string, connectionName: string): Promise<ProcesslistSnapshot> {
    return await this.connections.withConnection(connectionId, async (connection) => {
      let currentConnectionId: number | undefined;
      let serverVersion: string | undefined;

      try {
        const [metaResult] = await connection.query('SELECT CONNECTION_ID() AS cid, VERSION() AS ver');
        if (Array.isArray(metaResult) && metaResult.length > 0) {
          const row = metaResult[0] as Record<string, unknown>;
          const cidVal = row.cid ?? row.CID;
          if (cidVal !== undefined && cidVal !== null) {
            currentConnectionId = Number(cidVal);
          }
          const verVal = row.ver ?? row.VER;
          if (verVal !== undefined && verVal !== null) {
            serverVersion = String(verVal);
          }
        }
      } catch {
        // Ignored, fallback if server restricts metadata function
      }

      const [rows] = await connection.query('SHOW FULL PROCESSLIST');
      const rawList = Array.isArray(rows) ? (rows as Array<Record<string, unknown>>) : [];

      let activeCount = 0;
      let maxTime = 0;

      const processes: ProcessItem[] = rawList.map((row) => {
        const id = Number(row.Id ?? row.ID ?? 0);
        const user = String(row.User ?? row.USER ?? '');
        const host = String(row.Host ?? row.HOST ?? '');
        const rawDb = row.db ?? row.Db ?? row.DB ?? null;
        const db = rawDb !== null && rawDb !== undefined ? String(rawDb) : null;
        const command = String(row.Command ?? row.COMMAND ?? '');
        const time = Number(row.Time ?? row.TIME ?? 0);
        const rawState = row.State ?? row.STATE ?? null;
        const state = rawState !== null && rawState !== undefined ? String(rawState) : null;
        const rawInfo = row.Info ?? row.INFO ?? null;
        const info = rawInfo !== null && rawInfo !== undefined ? String(rawInfo) : null;

        const isCurrent = currentConnectionId !== undefined && id === currentConnectionId;

        if (command.toLowerCase() !== 'sleep' && !isCurrent) {
          activeCount++;
        }
        if (time > maxTime) {
          maxTime = time;
        }

        return {
          id,
          user,
          host,
          db,
          command,
          time,
          state,
          info,
          isCurrent
        };
      });

      return {
        connectionId,
        connectionName,
        serverVersion,
        currentConnectionId,
        processes,
        totalCount: processes.length,
        activeCount,
        maxTime,
        timestamp: Date.now()
      };
    });
  }

  public async killProcess(
    connectionId: string,
    processId: number,
    queryOnly: boolean = false
  ): Promise<KillProcessResult> {
    const idNum = Number(processId);
    if (!Number.isInteger(idNum) || idNum <= 0) {
      return {
        ok: false,
        message: `无效的进程 ID: ${processId}`,
        processId: idNum,
        queryOnly
      };
    }

    const sql = queryOnly ? `KILL QUERY ${idNum}` : `KILL ${idNum}`;

    try {
      await this.connections.withConnection(connectionId, async (connection) => {
        await connection.query(sql);
      });

      return {
        ok: true,
        message: queryOnly
          ? `已成功终止进程 #${idNum} 正在执行的查询。`
          : `已成功结束进程 #${idNum} 的连接会话。`,
        processId: idNum,
        queryOnly
      };
    } catch (error: unknown) {
      const err = error as { code?: number | string; message?: string };
      const rawMessage = err?.message || String(error);

      if (err?.code === 1094 || err?.code === 'ER_NO_SUCH_THREAD' || rawMessage.includes('Unknown thread id')) {
        return {
          ok: false,
          message: `进程 #${idNum} 已结束或不存在。`,
          processId: idNum,
          queryOnly
        };
      }

      if (
        err?.code === 1227 ||
        err?.code === 1045 ||
        err?.code === 'ER_SPECIFIC_ACCESS_DENIED_ERROR' ||
        rawMessage.includes('Access denied')
      ) {
        return {
          ok: false,
          message: `操作失败：当前 MySQL 账号权限不足，无法结束进程 #${idNum} (需要 PROCESS 或 CONNECTION_ADMIN 权限)。`,
          processId: idNum,
          queryOnly
        };
      }

      const safeMessage = redactSensitiveText(rawMessage, []);
      return {
        ok: false,
        message: `终止进程失败：${safeMessage}`,
        processId: idNum,
        queryOnly
      };
    }
  }
}
