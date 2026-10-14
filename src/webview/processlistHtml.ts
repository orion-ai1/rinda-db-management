import { randomBytes } from 'node:crypto';
import type { ProcesslistSnapshot } from '../monitor/ProcesslistTypes.js';

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function buildProcesslistHtml(initialSnapshot: ProcesslistSnapshot): string {
  const nonce = randomBytes(16).toString('base64');
  const serializedSnapshot = JSON.stringify(initialSnapshot).replaceAll('<', '\\u003c');

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
  <title>服务器进程列表 · ${escapeHtml(initialSnapshot.connectionName)}</title>
  <style nonce="${nonce}">
    *, *::before, *::after { box-sizing: border-box; }
    *:focus, *:focus-visible { outline: none; }
    html, body {
      margin: 0;
      padding: 0;
      width: 100%;
      height: 100%;
      overflow: hidden;
      font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif);
      font-size: 12px;
      line-height: 1.4;
      color: var(--vscode-editor-foreground);
      background: var(--vscode-editor-background);
      -webkit-font-smoothing: antialiased;
    }

    button, input, select {
      font: inherit;
      color: inherit;
    }

    .monitor-root {
      display: flex;
      flex-direction: column;
      height: 100vh;
      width: 100vw;
      background: var(--vscode-editor-background);
    }

    /* Top Action Bar (Navicat Toolbar) */
    .toolbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      padding: 6px 12px;
      background: var(--vscode-editorWidget-background, #252526);
      border-bottom: 1px solid var(--vscode-widget-border, rgba(128, 128, 128, 0.2));
      flex-shrink: 0;
      user-select: none;
      flex-wrap: wrap;
    }

    .toolbar-left, .toolbar-right {
      display: flex;
      align-items: center;
      gap: 6px;
      flex-wrap: wrap;
    }

    .tool-title {
      font-weight: 600;
      font-size: 13px;
      display: flex;
      align-items: center;
      gap: 6px;
      margin-right: 6px;
    }

    .server-badge {
      font-size: 11px;
      padding: 1px 6px;
      border-radius: 10px;
      background: var(--vscode-badge-background, #4d4d4d);
      color: var(--vscode-badge-foreground, #fff);
      font-weight: normal;
    }

    .tool-btn {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      height: 26px;
      padding: 0 9px;
      border: 1px solid transparent;
      border-radius: 4px;
      background: transparent;
      color: var(--vscode-foreground);
      font-size: 12px;
      cursor: pointer;
      transition: background 150ms ease, border-color 150ms ease;
    }

    .tool-btn:hover:not(:disabled) {
      background: var(--vscode-toolbar-hoverBackground, rgba(90, 93, 94, 0.25));
      border-color: var(--vscode-focusBorder, rgba(0, 120, 215, 0.4));
    }

    .tool-btn:active:not(:disabled) {
      background: var(--vscode-toolbar-activeBackground, rgba(90, 93, 94, 0.4));
    }

    .tool-btn:disabled {
      opacity: 0.4;
      cursor: not-allowed;
    }

    .tool-btn.btn-danger {
      color: var(--vscode-errorForeground, #f14c4c);
    }
    .tool-btn.btn-danger:hover:not(:disabled) {
      background: rgba(241, 76, 76, 0.15);
      border-color: rgba(241, 76, 76, 0.4);
    }

    .tool-btn.btn-warning {
      color: #e5a50a;
    }
    .tool-btn.btn-warning:hover:not(:disabled) {
      background: rgba(229, 165, 10, 0.15);
      border-color: rgba(229, 165, 10, 0.4);
    }

    .toolbar-divider {
      width: 1px;
      height: 18px;
      background: var(--vscode-widget-border, rgba(128, 128, 128, 0.25));
      margin: 0 4px;
    }

    .search-box {
      display: flex;
      align-items: center;
      background: var(--vscode-input-background, #3c3c3c);
      border: 1px solid var(--vscode-input-border, rgba(128, 128, 128, 0.3));
      border-radius: 4px;
      padding: 0 6px;
      height: 26px;
    }

    .search-box input {
      border: none;
      background: transparent;
      outline: none;
      font-size: 12px;
      width: 160px;
    }

    .filter-checkbox {
      display: flex;
      align-items: center;
      gap: 4px;
      font-size: 12px;
      cursor: pointer;
      user-select: none;
    }

    .auto-refresh-wrap {
      display: flex;
      align-items: center;
      gap: 4px;
      font-size: 12px;
    }

    .auto-refresh-wrap select {
      background: var(--vscode-dropdown-background, #3c3c3c);
      color: var(--vscode-dropdown-foreground, #f0f0f0);
      border: 1px solid var(--vscode-dropdown-border, rgba(128, 128, 128, 0.3));
      border-radius: 4px;
      padding: 2px 4px;
      height: 26px;
      outline: none;
    }

    .pulse-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: #388a34;
      display: inline-block;
      animation: pulse 1.6s infinite ease-in-out;
    }
    @keyframes pulse {
      0% { transform: scale(0.9); opacity: 0.6; }
      50% { transform: scale(1.25); opacity: 1; }
      100% { transform: scale(0.9); opacity: 0.6; }
    }

    /* KPI Summary Row */
    .kpi-row {
      display: flex;
      align-items: center;
      gap: 16px;
      padding: 6px 14px;
      background: var(--vscode-sideBar-background, #1e1e1e);
      border-bottom: 1px solid var(--vscode-widget-border, rgba(128, 128, 128, 0.15));
      font-size: 11px;
      flex-shrink: 0;
    }

    .kpi-item {
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .kpi-label {
      color: var(--vscode-descriptionForeground, #999);
    }
    .kpi-val {
      font-weight: 600;
      color: var(--vscode-foreground);
    }
    .kpi-val.highlight-warn {
      color: #e5a50a;
    }
    .kpi-val.highlight-danger {
      color: var(--vscode-errorForeground, #f14c4c);
    }

    /* Process Table Container */
    .table-container {
      flex: 1;
      overflow: auto;
      position: relative;
    }

    table.process-table {
      width: 100%;
      border-collapse: collapse;
      table-layout: fixed;
      font-size: 12px;
    }

    table.process-table thead {
      position: sticky;
      top: 0;
      z-index: 10;
      background: var(--vscode-editorWidget-background, #252526);
      border-bottom: 1px solid var(--vscode-widget-border, rgba(128, 128, 128, 0.3));
    }

    table.process-table th {
      padding: 6px 8px;
      text-align: left;
      font-weight: 600;
      color: var(--vscode-foreground);
      border-right: 1px solid var(--vscode-widget-border, rgba(128, 128, 128, 0.15));
      cursor: pointer;
      user-select: none;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    table.process-table th:hover {
      background: var(--vscode-list-hoverBackground, rgba(90, 93, 94, 0.2));
    }
    table.process-table th .sort-arrow {
      margin-left: 4px;
      opacity: 0.6;
      font-size: 10px;
    }

    table.process-table td {
      padding: 5px 8px;
      border-bottom: 1px solid var(--vscode-widget-border, rgba(128, 128, 128, 0.1));
      border-right: 1px solid var(--vscode-widget-border, rgba(128, 128, 128, 0.08));
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      user-select: text;
    }

    table.process-table tr {
      cursor: pointer;
      transition: background 80ms ease;
    }

    table.process-table tr:hover {
      background: var(--vscode-list-hoverBackground, rgba(90, 93, 94, 0.15));
    }

    table.process-table tr.selected {
      background: var(--vscode-list-activeSelectionBackground, #04395e) !important;
      color: var(--vscode-list-activeSelectionForeground, #ffffff);
    }

    /* Badges */
    .badge {
      display: inline-block;
      padding: 1px 6px;
      border-radius: 4px;
      font-size: 11px;
      font-weight: 500;
      line-height: 1.3;
    }

    .badge-query {
      color: #388a34;
      background: rgba(56, 138, 52, 0.18);
    }
    .badge-sleep {
      color: var(--vscode-descriptionForeground, #888);
      background: rgba(128, 128, 128, 0.15);
    }
    .badge-binlog {
      color: #b180ff;
      background: rgba(177, 128, 255, 0.18);
    }
    .badge-other {
      color: #007acc;
      background: rgba(0, 122, 204, 0.18);
    }

    .time-normal {
      color: var(--vscode-foreground);
    }
    .time-warn {
      color: #cca700;
      font-weight: 600;
    }
    .time-danger {
      color: #f14c4c;
      font-weight: 600;
      animation: blink 2s infinite;
    }
    @keyframes blink {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.6; }
    }

    .current-session-tag {
      font-size: 10px;
      padding: 0 4px;
      margin-left: 4px;
      border-radius: 3px;
      background: #007acc;
      color: #fff;
    }

    .sql-code-cell {
      font-family: var(--vscode-editor-font-family, Menlo, Monaco, "Courier New", monospace);
      font-size: 11px;
      color: var(--vscode-textPreformat-foreground, #dcdcaa);
    }

    .row-actions {
      display: flex;
      align-items: center;
      gap: 4px;
    }
    .row-btn {
      padding: 2px 5px;
      border-radius: 3px;
      border: 1px solid rgba(128, 128, 128, 0.25);
      background: transparent;
      font-size: 11px;
      cursor: pointer;
    }
    .row-btn:hover {
      background: var(--vscode-toolbar-hoverBackground, rgba(90, 93, 94, 0.3));
    }
    .row-btn.kill-query:hover {
      color: #e5a50a;
      border-color: #e5a50a;
    }
    .row-btn.kill-proc:hover {
      color: #f14c4c;
      border-color: #f14c4c;
    }

    /* Bottom Details Drawer */
    .detail-drawer {
      height: 180px;
      flex-shrink: 0;
      border-top: 2px solid var(--vscode-widget-border, rgba(128, 128, 128, 0.25));
      background: var(--vscode-editor-background);
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }

    .drawer-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 4px 10px;
      background: var(--vscode-editorWidget-background, #252526);
      border-bottom: 1px solid var(--vscode-widget-border, rgba(128, 128, 128, 0.15));
      font-size: 11px;
      font-weight: 600;
    }

    .drawer-body {
      flex: 1;
      padding: 8px 12px;
      overflow: auto;
      font-family: var(--vscode-editor-font-family, Menlo, Monaco, "Courier New", monospace);
      font-size: 12px;
      line-height: 1.5;
      white-space: pre-wrap;
      word-break: break-all;
      background: var(--vscode-editor-background);
      user-select: text;
    }

    .empty-state {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      height: 100%;
      color: var(--vscode-descriptionForeground, #888);
      font-size: 13px;
      gap: 8px;
    }

    /* Modal */
    .modal-backdrop {
      position: fixed;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      background: rgba(0, 0, 0, 0.55);
      display: none;
      align-items: center;
      justify-content: center;
      z-index: 1000;
    }
    .modal-backdrop.show {
      display: flex;
    }
    .modal-card {
      width: 480px;
      max-width: 90vw;
      background: var(--vscode-editorWidget-background, #252526);
      border: 1px solid var(--vscode-widget-border, rgba(128, 128, 128, 0.3));
      border-radius: 6px;
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45);
      overflow: hidden;
      display: flex;
      flex-direction: column;
    }
    .modal-header {
      padding: 10px 14px;
      font-size: 13px;
      font-weight: 600;
      border-bottom: 1px solid var(--vscode-widget-border, rgba(128, 128, 128, 0.2));
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .modal-body {
      padding: 14px;
      font-size: 12px;
      line-height: 1.5;
    }
    .modal-warning {
      padding: 8px 10px;
      border-radius: 4px;
      background: rgba(229, 165, 10, 0.15);
      border: 1px solid rgba(229, 165, 10, 0.4);
      color: #e5a50a;
      margin-top: 8px;
      font-size: 11px;
    }
    .modal-sql-box {
      margin-top: 8px;
      padding: 8px;
      border-radius: 4px;
      background: var(--vscode-editor-background);
      border: 1px solid var(--vscode-widget-border, rgba(128, 128, 128, 0.2));
      font-family: monospace;
      font-size: 11px;
      max-height: 100px;
      overflow-y: auto;
      white-space: pre-wrap;
      word-break: break-all;
    }
    .modal-footer {
      padding: 8px 14px;
      border-top: 1px solid var(--vscode-widget-border, rgba(128, 128, 128, 0.2));
      display: flex;
      justify-content: flex-end;
      gap: 8px;
      background: var(--vscode-sideBar-background, #1e1e1e);
    }
    .modal-btn {
      padding: 5px 12px;
      border-radius: 4px;
      font-size: 12px;
      border: 1px solid rgba(128, 128, 128, 0.3);
      background: transparent;
      cursor: pointer;
    }
    .modal-btn.confirm-danger {
      background: var(--vscode-button-background, #0e639c);
      color: var(--vscode-button-foreground, #fff);
      border: none;
    }
    .modal-btn.confirm-danger:hover {
      background: var(--vscode-button-hoverBackground, #1177bb);
    }
    .modal-btn.confirm-danger.btn-kill-proc {
      background: #c72e2e;
    }
    .modal-btn.confirm-danger.btn-kill-proc:hover {
      background: #e03838;
    }
  </style>
</head>
<body>
  <div class="monitor-root">
    <!-- Toolbar -->
    <div class="toolbar">
      <div class="toolbar-left">
        <span class="tool-title">
          <span>⚡ 服务器进程 (Processlist)</span>
          <span class="server-badge" id="serverVersionBadge">MySQL</span>
        </span>
        <button class="tool-btn" id="btnRefresh" title="刷新进程列表 (Ctrl/Cmd+R)">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
            <path d="M13.65 2.35A8 8 0 1 0 16 8h-2a6 6 0 1 1-1.76-4.24l-2.24 2.24H16V0l-2.35 2.35z"/>
          </svg>
          刷新
        </button>
        <div class="auto-refresh-wrap">
          <span id="pulseIndicator" style="display: none;" class="pulse-dot"></span>
          <span>自动刷新:</span>
          <select id="autoRefreshSelect">
            <option value="0">关闭</option>
            <option value="2000">2 秒</option>
            <option value="5000" selected>5 秒</option>
            <option value="10000">10 秒</option>
          </select>
        </div>
        <div class="toolbar-divider"></div>
        <div class="search-box">
          <input type="text" id="searchInput" placeholder="搜索 用户/库名/SQL..." />
        </div>
        <label class="filter-checkbox">
          <input type="checkbox" id="hideSleepCheckbox" checked />
          <span>隐藏 Sleep 连接</span>
        </label>
      </div>

      <div class="toolbar-right">
        <button class="tool-btn btn-warning" id="btnKillQuery" disabled title="终止选中进程正在执行的慢查询 (保留连接)">
          🛑 终止查询 (Kill Query)
        </button>
        <button class="tool-btn btn-danger" id="btnKillProcess" disabled title="终止选中进程的连接会话">
          ❌ 结束连接 (Kill)
        </button>
        <div class="toolbar-divider"></div>
        <button class="tool-btn" id="btnOpenInEditor" disabled title="在 SQL 查询窗口打开该语句">
          📄 打开 SQL
        </button>
      </div>
    </div>

    <!-- KPI Summary Row -->
    <div class="kpi-row">
      <div class="kpi-item">
        <span class="kpi-label">总连接数:</span>
        <span class="kpi-val" id="kpiTotal">0</span>
      </div>
      <div class="kpi-item">
        <span class="kpi-label">活跃查询:</span>
        <span class="kpi-val" id="kpiActive">0</span>
      </div>
      <div class="kpi-item">
        <span class="kpi-label">最长耗时:</span>
        <span class="kpi-val" id="kpiMaxTime">0 s</span>
      </div>
      <div class="kpi-item">
        <span class="kpi-label">当前会话 ID:</span>
        <span class="kpi-val" id="kpiCurrentSession">-</span>
      </div>
      <div class="kpi-item" style="margin-left: auto;">
        <span class="kpi-label">更新时间:</span>
        <span class="kpi-val" id="kpiUpdatedTime">-</span>
      </div>
    </div>

    <!-- Table Container -->
    <div class="table-container">
      <table class="process-table" id="processTable">
        <thead>
          <tr>
            <th style="width: 80px;" data-sort="id">ID <span class="sort-arrow">▼</span></th>
            <th style="width: 100px;" data-sort="user">User <span class="sort-arrow"></span></th>
            <th style="width: 140px;" data-sort="host">Host <span class="sort-arrow"></span></th>
            <th style="width: 120px;" data-sort="db">Database <span class="sort-arrow"></span></th>
            <th style="width: 100px;" data-sort="command">Command <span class="sort-arrow"></span></th>
            <th style="width: 90px;" data-sort="time">Time (s) <span class="sort-arrow"></span></th>
            <th style="width: 160px;" data-sort="state">State <span class="sort-arrow"></span></th>
            <th data-sort="info">SQL Info <span class="sort-arrow"></span></th>
            <th style="width: 140px;">操作</th>
          </tr>
        </thead>
        <tbody id="processTbody">
        </tbody>
      </table>
    </div>

    <!-- Bottom Details Drawer -->
    <div class="detail-drawer">
      <div class="drawer-header">
        <span id="drawerTitle">进程详细信息 (点击上方行选中)</span>
        <div style="display: flex; gap: 6px;">
          <button class="tool-btn" id="btnCopySql" disabled style="height: 22px; padding: 0 6px;">📋 复制 SQL</button>
          <button class="tool-btn" id="btnCopyId" disabled style="height: 22px; padding: 0 6px;">ID: 复制</button>
        </div>
      </div>
      <div class="drawer-body" id="drawerBody">
        <div class="empty-state">
          <span>请从列表中选中一行查看完整 SQL 与状态详情</span>
        </div>
      </div>
    </div>
  </div>

  <!-- Confirmation Modal -->
  <div class="modal-backdrop" id="killModal">
    <div class="modal-card">
      <div class="modal-header">
        <span id="modalTitle">终止进程确认</span>
      </div>
      <div class="modal-body">
        <div id="modalDesc">确定要执行此操作吗？</div>
        <div class="modal-warning" id="modalSelfWarn" style="display: none;">
          ⚠️ 警告：目标线程是当前管理插件正在使用的连接！终止此线程将断开当前会话。
        </div>
        <div class="modal-sql-box" id="modalSqlBox" style="display: none;"></div>
      </div>
      <div class="modal-footer">
        <button class="modal-btn" id="btnModalCancel">取消</button>
        <button class="modal-btn confirm-danger" id="btnModalConfirm">确认终止</button>
      </div>
    </div>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    let currentSnapshot = ${serializedSnapshot};
    let selectedProcessId = null;
    let autoRefreshTimer = null;
    let sortKey = 'time';
    let sortAsc = false;

    // Elements
    const tbody = document.getElementById('processTbody');
    const searchInput = document.getElementById('searchInput');
    const hideSleepCheckbox = document.getElementById('hideSleepCheckbox');
    const autoRefreshSelect = document.getElementById('autoRefreshSelect');
    const pulseIndicator = document.getElementById('pulseIndicator');
    const btnRefresh = document.getElementById('btnRefresh');
    const btnKillQuery = document.getElementById('btnKillQuery');
    const btnKillProcess = document.getElementById('btnKillProcess');
    const btnOpenInEditor = document.getElementById('btnOpenInEditor');
    const drawerTitle = document.getElementById('drawerTitle');
    const drawerBody = document.getElementById('drawerBody');
    const btnCopySql = document.getElementById('btnCopySql');
    const btnCopyId = document.getElementById('btnCopyId');

    const kpiTotal = document.getElementById('kpiTotal');
    const kpiActive = document.getElementById('kpiActive');
    const kpiMaxTime = document.getElementById('kpiMaxTime');
    const kpiCurrentSession = document.getElementById('kpiCurrentSession');
    const kpiUpdatedTime = document.getElementById('kpiUpdatedTime');
    const serverVersionBadge = document.getElementById('serverVersionBadge');

    // Modal elements
    const killModal = document.getElementById('killModal');
    const modalTitle = document.getElementById('modalTitle');
    const modalDesc = document.getElementById('modalDesc');
    const modalSelfWarn = document.getElementById('modalSelfWarn');
    const modalSqlBox = document.getElementById('modalSqlBox');
    const btnModalCancel = document.getElementById('btnModalCancel');
    const btnModalConfirm = document.getElementById('btnModalConfirm');

    let pendingKill = null;

    function renderSnapshot(snapshot) {
      currentSnapshot = snapshot;
      serverVersionBadge.textContent = snapshot.serverVersion ? snapshot.serverVersion : 'MySQL';

      // KPI
      kpiTotal.textContent = snapshot.totalCount;
      kpiActive.textContent = snapshot.activeCount;
      kpiMaxTime.textContent = snapshot.maxTime + ' s';
      if (snapshot.maxTime >= 30) {
        kpiMaxTime.className = 'kpi-val highlight-danger';
      } else if (snapshot.maxTime >= 5) {
        kpiMaxTime.className = 'kpi-val highlight-warn';
      } else {
        kpiMaxTime.className = 'kpi-val';
      }

      kpiCurrentSession.textContent = snapshot.currentConnectionId ? '#' + snapshot.currentConnectionId : '-';
      kpiUpdatedTime.textContent = new Date(snapshot.timestamp).toLocaleTimeString();

      renderTable();
    }

    function renderTable() {
      const query = (searchInput.value || '').trim().toLowerCase();
      const hideSleep = hideSleepCheckbox.checked;

      let list = currentSnapshot.processes.filter(p => {
        if (hideSleep && p.command.toLowerCase() === 'sleep') return false;
        if (!query) return true;
        return (
          String(p.id).includes(query) ||
          (p.user && p.user.toLowerCase().includes(query)) ||
          (p.host && p.host.toLowerCase().includes(query)) ||
          (p.db && p.db.toLowerCase().includes(query)) ||
          (p.command && p.command.toLowerCase().includes(query)) ||
          (p.state && p.state.toLowerCase().includes(query)) ||
          (p.info && p.info.toLowerCase().includes(query))
        );
      });

      // Sort
      list.sort((a, b) => {
        let valA = a[sortKey];
        let valB = b[sortKey];
        if (valA === null || valA === undefined) valA = '';
        if (valB === null || valB === undefined) valB = '';

        if (typeof valA === 'number' && typeof valB === 'number') {
          return sortAsc ? valA - valB : valB - valA;
        }
        valA = String(valA).toLowerCase();
        valB = String(valB).toLowerCase();
        if (valA < valB) return sortAsc ? -1 : 1;
        if (valA > valB) return sortAsc ? 1 : -1;
        return 0;
      });

      tbody.innerHTML = '';

      if (list.length === 0) {
        const tr = document.createElement('tr');
        tr.innerHTML = '<td colspan="9" style="text-align:center; padding: 24px; color: var(--vscode-descriptionForeground);">未匹配到任何进程</td>';
        tbody.appendChild(tr);
        updateSelection(null);
        return;
      }

      for (const p of list) {
        const tr = document.createElement('tr');
        if (p.id === selectedProcessId) {
          tr.classList.add('selected');
        }

        // Command Badge
        let cmdClass = 'badge badge-other';
        const lowerCmd = p.command.toLowerCase();
        if (lowerCmd === 'query') cmdClass = 'badge badge-query';
        else if (lowerCmd === 'sleep') cmdClass = 'badge badge-sleep';
        else if (lowerCmd.includes('binlog')) cmdClass = 'badge badge-binlog';

        // Time styling
        let timeClass = 'time-normal';
        let timeExtra = '';
        if (p.time >= 30 && lowerCmd === 'query') {
          timeClass = 'time-danger';
          timeExtra = ' ⚠️ 慢查询';
        } else if (p.time >= 5 && lowerCmd === 'query') {
          timeClass = 'time-warn';
        }

        const currentTag = p.isCurrent ? '<span class="current-session-tag">You</span>' : '';

        tr.innerHTML = \`
          <td><strong>#\${p.id}</strong>\${currentTag}</td>
          <td>\${escapeHtml(p.user || '')}</td>
          <td title="\${escapeHtml(p.host || '')}">\${escapeHtml(p.host || '')}</td>
          <td>\${escapeHtml(p.db || '-')}</td>
          <td><span class="\${cmdClass}">\${escapeHtml(p.command)}</span></td>
          <td class="\${timeClass}">\${p.time}\${timeExtra}</td>
          <td title="\${escapeHtml(p.state || '')}">\${escapeHtml(p.state || '-')}</td>
          <td class="sql-code-cell" title="\${escapeHtml(p.info || '')}">\${escapeHtml(p.info || '-')}</td>
          <td>
            <div class="row-actions">
              <button class="row-btn kill-query" data-id="\${p.id}" title="仅终止当前查询">杀查询</button>
              <button class="row-btn kill-proc" data-id="\${p.id}" title="终止整个连接">结束</button>
            </div>
          </td>
        \`;

        tr.addEventListener('click', (e) => {
          if (e.target.closest('.row-btn')) return;
          updateSelection(p);
        });

        // Fast actions
        const btnRowKillQuery = tr.querySelector('.kill-query');
        btnRowKillQuery.addEventListener('click', (e) => {
          e.stopPropagation();
          promptKill(p, true);
        });

        const btnRowKillProc = tr.querySelector('.kill-proc');
        btnRowKillProc.addEventListener('click', (e) => {
          e.stopPropagation();
          promptKill(p, false);
        });

        tbody.appendChild(tr);
      }

      // Sync selection drawer
      const selectedItem = currentSnapshot.processes.find(p => p.id === selectedProcessId);
      updateSelection(selectedItem || null);
    }

    function updateSelection(item) {
      selectedProcessId = item ? item.id : null;

      // Update table classes
      const rows = tbody.querySelectorAll('tr');
      rows.forEach(r => r.classList.remove('selected'));
      if (item) {
        const activeTr = Array.from(rows).find(r => r.innerHTML.includes('#' + item.id));
        if (activeTr) activeTr.classList.add('selected');
      }

      btnKillQuery.disabled = !item;
      btnKillProcess.disabled = !item;
      btnOpenInEditor.disabled = !item || !item.info;
      btnCopySql.disabled = !item || !item.info;
      btnCopyId.disabled = !item;

      if (!item) {
        drawerTitle.textContent = '进程详细信息 (点击上方行选中)';
        drawerBody.innerHTML = '<div class="empty-state"><span>请从列表中选中一行查看完整 SQL 与状态详情</span></div>';
        return;
      }

      drawerTitle.textContent = \`进程 #\${item.id} · 用户: \${item.user} · 库: \${item.db || '无'} · 耗时: \${item.time}s\`;
      btnCopyId.textContent = 'ID: #' + item.id;

      if (item.info) {
        drawerBody.textContent = item.info;
      } else {
        drawerBody.innerHTML = \`<span style="color: var(--vscode-descriptionForeground);">当前命令为 \${escapeHtml(item.command)}，无正在执行的 SQL 语句。状态: \${escapeHtml(item.state || '空闲')}</span>\`;
      }
    }

    function promptKill(item, queryOnly) {
      pendingKill = { item, queryOnly };
      modalTitle.textContent = queryOnly ? '终止正在执行的查询 (Kill Query)' : '结束数据库连接线程 (Kill Process)';
      modalDesc.innerHTML = queryOnly
        ? \`确定要终止线程 <strong>#\${item.id}</strong> (用户: <em>\${escapeHtml(item.user)}</em>) 正在运行的查询吗？<br><span style="color:var(--vscode-descriptionForeground); font-size:11px;">注意：该操作仅阻断卡死 SQL，客户端不会断开连接。</span>\`
        : \`确定要结束线程 <strong>#\${item.id}</strong> (用户: <em>\${escapeHtml(item.user)}</em>, 主机: <em>\${escapeHtml(item.host)}</em>) 的数据库连接吗？\`;

      modalSelfWarn.style.display = item.isCurrent ? 'block' : 'none';

      if (item.info) {
        modalSqlBox.style.display = 'block';
        modalSqlBox.textContent = item.info;
      } else {
        modalSqlBox.style.display = 'none';
      }

      btnModalConfirm.className = queryOnly ? 'modal-btn confirm-danger' : 'modal-btn confirm-danger btn-kill-proc';
      btnModalConfirm.textContent = queryOnly ? '终止查询' : '结束连接';

      killModal.classList.add('show');
    }

    function closeModal() {
      killModal.classList.remove('show');
      pendingKill = null;
    }

    btnModalCancel.addEventListener('click', closeModal);
    killModal.addEventListener('click', (e) => {
      if (e.target === killModal) closeModal();
    });

    btnModalConfirm.addEventListener('click', () => {
      if (!pendingKill) return;
      const { item, queryOnly } = pendingKill;
      closeModal();
      vscode.postMessage({
        type: 'kill',
        processId: item.id,
        queryOnly: queryOnly
      });
    });

    // Top action buttons
    btnRefresh.addEventListener('click', () => {
      vscode.postMessage({ type: 'refresh' });
    });

    btnKillQuery.addEventListener('click', () => {
      const item = currentSnapshot.processes.find(p => p.id === selectedProcessId);
      if (item) promptKill(item, true);
    });

    btnKillProcess.addEventListener('click', () => {
      const item = currentSnapshot.processes.find(p => p.id === selectedProcessId);
      if (item) promptKill(item, false);
    });

    btnOpenInEditor.addEventListener('click', () => {
      const item = currentSnapshot.processes.find(p => p.id === selectedProcessId);
      if (item && item.info) {
        vscode.postMessage({ type: 'openInQuery', sql: item.info });
      }
    });

    btnCopySql.addEventListener('click', () => {
      const item = currentSnapshot.processes.find(p => p.id === selectedProcessId);
      if (item && item.info) {
        vscode.postMessage({ type: 'copy', text: item.info });
      }
    });

    btnCopyId.addEventListener('click', () => {
      if (selectedProcessId) {
        vscode.postMessage({ type: 'copy', text: String(selectedProcessId) });
      }
    });

    // Sorting
    document.querySelectorAll('table.process-table th[data-sort]').forEach(th => {
      th.addEventListener('click', () => {
        const key = th.getAttribute('data-sort');
        if (sortKey === key) {
          sortAsc = !sortAsc;
        } else {
          sortKey = key;
          sortAsc = key === 'id' || key === 'user' ? true : false;
        }

        // Update indicators
        document.querySelectorAll('table.process-table th .sort-arrow').forEach(span => span.textContent = '');
        const arrow = th.querySelector('.sort-arrow');
        if (arrow) arrow.textContent = sortAsc ? '▲' : '▼';

        renderTable();
      });
    });

    // Filter & search events
    searchInput.addEventListener('input', renderTable);
    hideSleepCheckbox.addEventListener('change', renderTable);

    // Auto refresh management
    function startAutoRefresh(ms) {
      if (autoRefreshTimer) {
        clearInterval(autoRefreshTimer);
        autoRefreshTimer = null;
      }
      if (ms > 0) {
        pulseIndicator.style.display = 'inline-block';
        autoRefreshTimer = setInterval(() => {
          vscode.postMessage({ type: 'refresh' });
        }, ms);
      } else {
        pulseIndicator.style.display = 'none';
      }
    }

    autoRefreshSelect.addEventListener('change', (e) => {
      const interval = Number(e.target.value);
      startAutoRefresh(interval);
    });

    // Start with default 5s
    startAutoRefresh(5000);

    // Handle messages from Extension
    window.addEventListener('message', event => {
      const message = event.data;
      if (message.type === 'snapshot') {
        renderSnapshot(message.snapshot);
      }
    });

    function escapeHtml(str) {
      if (!str) return '';
      return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }

    // Initial render
    renderSnapshot(currentSnapshot);
  </script>
</body>
</html>`;
}
