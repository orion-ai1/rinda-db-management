import assert from 'node:assert/strict';
import test from 'node:test';
import type { ConnectionManager } from '../../src/connection/ConnectionManager.js';
import { ProcesslistService } from '../../src/monitor/ProcesslistService.js';

function createMockConnectionManager(handlers: {
  query?: (sql: string) => Promise<[unknown, unknown]>;
}): ConnectionManager {
  return {
    withConnection: async (_id: string, operation: (conn: any) => Promise<any>) => {
      const mockConn = {
        query: handlers.query ?? (async () => [[], []])
      };
      return await operation(mockConn);
    }
  } as unknown as ConnectionManager;
}

test('ProcesslistService.getSnapshot parses processlist rows and stats correctly', async () => {
  const mockRows = [
    {
      Id: 101,
      User: 'root',
      Host: 'localhost:51234',
      db: 'shop_db',
      Command: 'Query',
      Time: 45,
      State: 'Sending data',
      Info: 'SELECT * FROM big_orders WHERE status = 1;'
    },
    {
      Id: 102,
      User: 'app_user',
      Host: '192.168.1.50:4001',
      db: 'analytics',
      Command: 'Sleep',
      Time: 120,
      State: null,
      Info: null
    },
    {
      Id: 103,
      User: 'admin',
      Host: '127.0.0.1:55555',
      db: null,
      Command: 'Query',
      Time: 1,
      State: 'executing',
      Info: 'SHOW FULL PROCESSLIST'
    }
  ];

  const manager = createMockConnectionManager({
    query: async (sql: string) => {
      if (sql.includes('CONNECTION_ID()')) {
        return [[{ cid: 103, ver: '8.0.35-MySQL' }], []];
      }
      if (sql.includes('SHOW FULL PROCESSLIST')) {
        return [mockRows, []];
      }
      return [[], []];
    }
  });

  const service = new ProcesslistService(manager);
  const snapshot = await service.getSnapshot('conn-1', 'Local MySQL');

  assert.equal(snapshot.connectionId, 'conn-1');
  assert.equal(snapshot.connectionName, 'Local MySQL');
  assert.equal(snapshot.serverVersion, '8.0.35-MySQL');
  assert.equal(snapshot.currentConnectionId, 103);
  assert.equal(snapshot.totalCount, 3);
  assert.equal(snapshot.activeCount, 1); // 101 is active (102 is Sleep, 103 is current)
  assert.equal(snapshot.maxTime, 120);

  // Check process 101
  const p101 = snapshot.processes.find(p => p.id === 101);
  assert.ok(p101);
  assert.equal(p101.user, 'root');
  assert.equal(p101.db, 'shop_db');
  assert.equal(p101.command, 'Query');
  assert.equal(p101.time, 45);
  assert.equal(p101.isCurrent, false);
  assert.equal(p101.info, 'SELECT * FROM big_orders WHERE status = 1;');

  // Check process 103 (current)
  const p103 = snapshot.processes.find(p => p.id === 103);
  assert.ok(p103);
  assert.equal(p103.isCurrent, true);
});

test('ProcesslistService.killProcess validates processId and issues KILL / KILL QUERY', async () => {
  const executedSqls: string[] = [];

  const manager = createMockConnectionManager({
    query: async (sql: string) => {
      executedSqls.push(sql);
      return [[], []];
    }
  });

  const service = new ProcesslistService(manager);

  // 1. Invalid processId
  const invalidResult = await service.killProcess('conn-1', 0);
  assert.equal(invalidResult.ok, false);
  assert.match(invalidResult.message, /无效的进程 ID/);

  // 2. Kill Query
  const killQueryResult = await service.killProcess('conn-1', 101, true);
  assert.equal(killQueryResult.ok, true);
  assert.equal(killQueryResult.processId, 101);
  assert.equal(killQueryResult.queryOnly, true);
  assert.match(killQueryResult.message, /成功终止进程 #101 正在执行的查询/);
  assert.equal(executedSqls[0], 'KILL QUERY 101');

  // 3. Kill Process
  const killProcResult = await service.killProcess('conn-1', 102, false);
  assert.equal(killProcResult.ok, true);
  assert.equal(killProcResult.processId, 102);
  assert.equal(killProcResult.queryOnly, false);
  assert.match(killProcResult.message, /成功结束进程 #102 的连接会话/);
  assert.equal(executedSqls[1], 'KILL 102');
});

test('ProcesslistService.killProcess handles MySQL error codes gracefully', async () => {
  // 1. No such thread
  const noThreadManager = createMockConnectionManager({
    query: async () => {
      const err = new Error('Unknown thread id: 999');
      (err as any).code = 1094;
      throw err;
    }
  });
  const service1 = new ProcesslistService(noThreadManager);
  const res1 = await service1.killProcess('conn-1', 999);
  assert.equal(res1.ok, false);
  assert.match(res1.message, /进程 #999 已结束或不存在/);

  // 2. Permission denied
  const noPermManager = createMockConnectionManager({
    query: async () => {
      const err = new Error('Access denied; you need (at least one of) the PROCESS or CONNECTION_ADMIN privilege(s) for this operation');
      (err as any).code = 1227;
      throw err;
    }
  });
  const service2 = new ProcesslistService(noPermManager);
  const res2 = await service2.killProcess('conn-1', 888);
  assert.equal(res2.ok, false);
  assert.match(res2.message, /权限不足/);
});
