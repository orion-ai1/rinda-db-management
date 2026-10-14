import assert from 'node:assert/strict';
import test from 'node:test';
import type { ProcesslistSnapshot } from '../../src/monitor/ProcesslistTypes.js';
import { buildProcesslistHtml } from '../../src/webview/processlistHtml.js';

test('buildProcesslistHtml generates valid HTML, CSP, and toolbar elements', () => {
  const mockSnapshot: ProcesslistSnapshot = {
    connectionId: 'conn-abc',
    connectionName: 'Production <DB>',
    serverVersion: '8.0.35',
    currentConnectionId: 42,
    processes: [
      {
        id: 42,
        user: 'root',
        host: '127.0.0.1:50000',
        db: 'main_db',
        command: 'Query',
        time: 0,
        state: 'executing',
        info: 'SHOW FULL PROCESSLIST',
        isCurrent: true
      },
      {
        id: 88,
        user: 'app',
        host: '10.0.0.2:33445',
        db: 'analytics',
        command: 'Query',
        time: 55,
        state: 'Sending data',
        info: 'SELECT count(*) FROM huge_logs GROUP BY date;',
        isCurrent: false
      }
    ],
    totalCount: 2,
    activeCount: 1,
    maxTime: 55,
    timestamp: Date.now()
  };

  const html = buildProcesslistHtml(mockSnapshot);

  // 1. Structure & CSP
  assert.ok(html.includes('<!doctype html>'));
  assert.ok(html.includes('Content-Security-Policy'));
  assert.ok(html.includes('style-src \'nonce-'));
  assert.ok(html.includes('script-src \'nonce-'));

  // 2. Escaping in title and HTML
  assert.ok(html.includes('Production &lt;DB&gt;'));

  // 3. Serialized JSON state embedded safely
  assert.ok(html.includes('"connectionId":"conn-abc"'));
  assert.ok(html.includes('"serverVersion":"8.0.35"'));

  // 4. Critical UI controls
  assert.ok(html.includes('id="btnRefresh"'));
  assert.ok(html.includes('id="autoRefreshSelect"'));
  assert.ok(html.includes('id="hideSleepCheckbox"'));
  assert.ok(html.includes('id="searchInput"'));
  assert.ok(html.includes('id="btnKillQuery"'));
  assert.ok(html.includes('id="btnKillProcess"'));
  assert.ok(html.includes('id="btnOpenInEditor"'));

  // 5. Table & Drawer
  assert.ok(html.includes('class="process-table"'));
  assert.ok(html.includes('class="detail-drawer"'));
  assert.ok(html.includes('id="killModal"'));
});
