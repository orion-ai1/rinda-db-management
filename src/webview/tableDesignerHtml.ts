import { randomBytes } from 'node:crypto';
import type { TableDesignerState } from '../design/TableDesignerTypes.js';

export function buildTableDesignerHtml(initialState: TableDesignerState): string {
  const nonce = randomBytes(16).toString('base64');
  const serializedState = JSON.stringify(initialState).replaceAll('<', '\\u003c');
  const title = initialState.mode === 'create' ? '新建表' : `设计表 · ${initialState.tableName}`;

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
  <title>${escapeHtml(title)}</title>
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
      font-size: 13px;
      line-height: 1.4;
      color: var(--vscode-editor-foreground);
      background: var(--vscode-editor-background);
      -webkit-font-smoothing: antialiased;
    }

    button, input, select {
      font: inherit;
      color: inherit;
    }

    /* Layout */
    .designer-root {
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
      gap: 4px;
      padding: 6px 10px;
      background: var(--vscode-editorWidget-background, #252526);
      border-bottom: 1px solid var(--vscode-widget-border, rgba(128, 128, 128, 0.2));
      flex-shrink: 0;
      user-select: none;
    }

    .toolbar-group {
      display: flex;
      align-items: center;
      gap: 2px;
    }

    .toolbar-divider {
      width: 1px;
      height: 18px;
      background: var(--vscode-widget-border, rgba(128, 128, 128, 0.25));
      margin: 0 4px;
    }

    .tool-btn {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      height: 26px;
      padding: 0 8px;
      border: 1px solid transparent;
      border-radius: 4px;
      background: transparent;
      color: var(--vscode-foreground);
      font-size: 12px;
      cursor: pointer;
      transition: background 160ms ease, border-color 160ms ease, color 160ms ease;
    }

    .tool-btn:hover:not(:disabled) {
      background: var(--vscode-toolbar-hoverBackground, rgba(90, 93, 94, 0.2));
      border-color: var(--vscode-focusBorder, rgba(0, 120, 215, 0.4));
    }

    .tool-btn:active:not(:disabled) {
      background: var(--vscode-toolbar-activeBackground, rgba(90, 93, 94, 0.35));
    }

    .tool-btn:disabled {
      opacity: 0.4;
      cursor: not-allowed;
    }

    .tool-btn.btn-save {
      color: #388a34;
      font-weight: 500;
    }
    .tool-btn.btn-save:hover:not(:disabled) {
      background: rgba(56, 138, 52, 0.12);
    }

    .tool-btn.btn-delete:hover:not(:disabled) {
      color: var(--vscode-errorForeground, #f14c4c);
      background: rgba(241, 76, 76, 0.12);
    }

    .tool-btn svg {
      flex-shrink: 0;
    }

    .table-name-wrap {
      display: flex;
      align-items: center;
      gap: 6px;
      margin-left: auto;
      padding-right: 8px;
    }

    .table-name-label {
      font-size: 12px;
      color: var(--vscode-descriptionForeground, #888);
    }

    .table-name-input {
      height: 24px;
      padding: 0 8px;
      border: 1px solid var(--vscode-input-border, rgba(128, 128, 128, 0.3));
      border-radius: 4px;
      background: var(--vscode-input-background, #1e1e1e);
      color: var(--vscode-input-foreground, #ccc);
      font-size: 12px;
      width: 160px;
      transition: border-color 160ms ease;
    }

    .table-name-input:focus {
      border-color: var(--vscode-focusBorder, #007fd4);
    }

    /* Tabs Bar (Navicat Tabs) */
    .tabs-bar {
      display: flex;
      align-items: center;
      gap: 1px;
      padding: 0 10px;
      background: var(--vscode-sideBar-background, #1e1e1e);
      border-bottom: 1px solid var(--vscode-widget-border, rgba(128, 128, 128, 0.2));
      flex-shrink: 0;
      user-select: none;
      overflow-x: auto;
    }

    .tab-item {
      padding: 6px 14px;
      font-size: 12px;
      color: var(--vscode-descriptionForeground, #999);
      background: transparent;
      border: none;
      border-bottom: 2px solid transparent;
      cursor: pointer;
      transition: color 150ms ease, border-color 150ms ease, background 150ms ease;
      white-space: nowrap;
    }

    .tab-item:hover {
      color: var(--vscode-foreground, #fff);
      background: rgba(128, 128, 128, 0.08);
    }

    .tab-item.active {
      color: var(--vscode-foreground, #fff);
      font-weight: 600;
      border-bottom-color: var(--vscode-focusBorder, #0078d4);
      background: var(--vscode-editor-background);
    }

    /* Main Content Area */
    .content-area {
      flex: 1;
      display: flex;
      flex-direction: column;
      overflow: hidden;
      position: relative;
    }

    .tab-pane {
      display: none;
      flex: 1;
      flex-direction: column;
      overflow: hidden;
      height: 100%;
    }

    .tab-pane.active {
      display: flex;
    }

    /* Grid Table Styles */
    .grid-container {
      flex: 1;
      overflow: auto;
      border-bottom: 1px solid var(--vscode-widget-border, rgba(128, 128, 128, 0.2));
      position: relative;
      background: var(--vscode-editor-background);
    }

    .grid-table {
      width: 100%;
      border-collapse: collapse;
      table-layout: fixed;
      font-size: 12px;
    }

    .grid-table thead {
      position: sticky;
      top: 0;
      z-index: 10;
      background: var(--vscode-sideBarSectionHeader-background, #252526);
    }

    .grid-table th {
      padding: 6px 8px;
      text-align: left;
      font-weight: 500;
      color: var(--vscode-sideBarSectionHeader-foreground, #ccc);
      border-right: 1px solid var(--vscode-widget-border, rgba(128, 128, 128, 0.15));
      border-bottom: 1px solid var(--vscode-widget-border, rgba(128, 128, 128, 0.25));
      user-select: none;
      white-space: nowrap;
    }

    .grid-table th.col-sel { width: 34px; text-align: center; }
    .grid-table th.col-name { width: 220px; }
    .grid-table th.col-type { width: 140px; }
    .grid-table th.col-length { width: 80px; }
    .grid-table th.col-scale { width: 80px; }
    .grid-table th.col-notnull { width: 80px; text-align: center; }
    .grid-table th.col-key { width: 70px; text-align: center; }
    .grid-table th.col-comment { min-width: 180px; }

    .grid-table tbody tr {
      cursor: pointer;
      transition: background 120ms ease;
      border-bottom: 1px solid var(--vscode-widget-border, rgba(128, 128, 128, 0.1));
    }

    .grid-table tbody tr:hover {
      background: var(--vscode-list-hoverBackground, rgba(90, 93, 94, 0.15));
    }

    .grid-table tbody tr.selected {
      background: var(--vscode-list-activeSelectionBackground, rgba(0, 120, 215, 0.25));
    }

    .grid-table td {
      padding: 3px 6px;
      border-right: 1px solid var(--vscode-widget-border, rgba(128, 128, 128, 0.1));
      vertical-align: middle;
      height: 28px;
    }

    .grid-table td.col-sel {
      text-align: center;
      color: var(--vscode-focusBorder, #0078d4);
      font-size: 10px;
    }

    .grid-table td.col-notnull,
    .grid-table td.col-key {
      text-align: center;
    }

    .cell-input {
      width: 100%;
      height: 22px;
      padding: 0 4px;
      border: 1px solid transparent;
      border-radius: 2px;
      background: transparent;
      color: inherit;
      font-size: 12px;
      transition: border-color 140ms ease, background 140ms ease;
    }

    .cell-input:hover {
      border-color: rgba(128, 128, 128, 0.3);
    }

    .cell-input:focus {
      border-color: var(--vscode-focusBorder, #0078d4);
      background: var(--vscode-input-background, #1e1e1e);
    }

    .cell-select {
      width: 100%;
      height: 22px;
      padding: 0 2px;
      border: 1px solid transparent;
      border-radius: 2px;
      background: transparent;
      color: inherit;
      font-size: 12px;
      cursor: pointer;
      transition: border-color 140ms ease;
    }

    .cell-select:hover {
      border-color: rgba(128, 128, 128, 0.3);
    }

    .cell-select:focus {
      border-color: var(--vscode-focusBorder, #0078d4);
      background: var(--vscode-input-background, #1e1e1e);
    }

    .custom-checkbox {
      appearance: none;
      -webkit-appearance: none;
      width: 14px;
      height: 14px;
      border: 1px solid var(--vscode-input-border, #666);
      border-radius: 3px;
      outline: none;
      cursor: pointer;
      vertical-align: middle;
      position: relative;
      background: transparent;
      transition: background 150ms ease, border-color 150ms ease;
    }

    .custom-checkbox:checked {
      background: var(--vscode-focusBorder, #0078d4);
      border-color: var(--vscode-focusBorder, #0078d4);
    }

    .custom-checkbox:checked::after {
      content: '';
      position: absolute;
      left: 4px;
      top: 1px;
      width: 4px;
      height: 8px;
      border: solid white;
      border-width: 0 2px 2px 0;
      transform: rotate(45deg);
    }

    .key-badge {
      display: inline-flex;
      align-items: center;
      gap: 3px;
      font-weight: 600;
      font-size: 11px;
      color: #e5a00d;
    }

    /* Bottom Properties Panel */
    .properties-panel {
      height: 180px;
      flex-shrink: 0;
      background: var(--vscode-sideBar-background, #1e1e1e);
      padding: 10px 16px;
      display: flex;
      flex-direction: column;
      gap: 8px;
      overflow-y: auto;
      border-top: 1px solid var(--vscode-widget-border, rgba(128, 128, 128, 0.2));
    }

    .props-grid {
      display: grid;
      grid-template-columns: 80px 240px 100px 240px;
      row-gap: 8px;
      column-gap: 12px;
      align-items: center;
      font-size: 12px;
    }

    .prop-label {
      color: var(--vscode-descriptionForeground, #999);
      text-align: right;
    }

    .prop-val-input, .prop-val-select {
      height: 24px;
      padding: 0 6px;
      border: 1px solid var(--vscode-input-border, rgba(128, 128, 128, 0.3));
      border-radius: 3px;
      background: var(--vscode-input-background, #252526);
      color: var(--vscode-input-foreground, #ccc);
      font-size: 12px;
      width: 100%;
    }

    .prop-val-input:focus, .prop-val-select:focus {
      border-color: var(--vscode-focusBorder, #0078d4);
    }

    /* SQL Preview Pane */
    .preview-pane {
      padding: 16px;
      height: 100%;
      overflow: auto;
      display: flex;
      flex-direction: column;
      gap: 12px;
      background: var(--vscode-editor-background);
    }

    .preview-actions {
      display: flex;
      align-items: center;
      justify-content: space-between;
    }

    .preview-box {
      flex: 1;
      margin: 0;
      padding: 14px;
      background: var(--vscode-editorWidget-background, #1e1e1e);
      border: 1px solid var(--vscode-widget-border, rgba(128, 128, 128, 0.2));
      border-radius: 6px;
      font-family: var(--vscode-editor-font-family, Consolas, Monaco, monospace);
      font-size: 12px;
      line-height: 1.5;
      color: var(--vscode-editor-foreground);
      white-space: pre-wrap;
      word-break: break-all;
      overflow: auto;
    }

    /* Options & Notice Panes */
    .options-pane {
      padding: 20px;
      display: flex;
      flex-direction: column;
      gap: 12px;
      max-width: 600px;
    }

    .notice-pane {
      flex: 1;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 12px;
      color: var(--vscode-descriptionForeground, #888);
      padding: 40px;
      text-align: center;
    }

    /* Status Bar */
    .status-bar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      height: 24px;
      padding: 0 10px;
      font-size: 11px;
      background: var(--vscode-statusBar-background, #007acc);
      color: var(--vscode-statusBar-foreground, #fff);
      flex-shrink: 0;
    }

    .status-msg.error {
      color: #ff6b6b;
      font-weight: 500;
    }
  </style>
</head>
<body>
  <div class="designer-root">
    <!-- Top Action Bar -->
    <div class="toolbar" role="toolbar" aria-label="表设计器工具栏">
      <div class="toolbar-group">
        <button id="btnSave" class="tool-btn btn-save" title="保存表结构更改 (Ctrl+S / Cmd+S)">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>
          <span>保存</span>
        </button>
      </div>
      <div class="toolbar-divider"></div>
      <div class="toolbar-group">
        <button id="btnAddField" class="tool-btn" title="在末尾添加新字段">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="12" x2="16" y2="12"/></svg>
          <span>添加字段</span>
        </button>
        <button id="btnInsertField" class="tool-btn" title="在选中位置上方插入新字段">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 8 8 12 12 16"/><line x1="16" y1="12" x2="8" y2="12"/></svg>
          <span>插入字段</span>
        </button>
        <button id="btnDeleteField" class="tool-btn btn-delete" title="删除选中的字段">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="8" y1="12" x2="16" y2="12"/></svg>
          <span>删除字段</span>
        </button>
      </div>
      <div class="toolbar-divider"></div>
      <div class="toolbar-group">
        <button id="btnTogglePk" class="tool-btn" title="切换选中字段的主键标记">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#e5a00d" stroke-width="2"><path d="M21 2l-2 2m-1.5 1.5L14 9l-1.5-1.5-2 2 1.5 1.5L10 13l-1.5-1.5-2 2 1.5 1.5L6 17l-4 4v-4l4-4 1.5 1.5 2-2-1.5-1.5L11 8l-1.5-1.5 2-2 1.5 1.5 3.5-3.5a5 5 0 1 1 7 7z"/></svg>
          <span>主键</span>
        </button>
      </div>
      <div class="toolbar-divider"></div>
      <div class="toolbar-group">
        <button id="btnMoveUp" class="tool-btn" title="将选中字段上移">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="18 15 12 9 6 15"/></svg>
          <span>上移</span>
        </button>
        <button id="btnMoveDown" class="tool-btn" title="将选中字段下移">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
          <span>下移</span>
        </button>
      </div>

      <div class="table-name-wrap">
        <span class="table-name-label">表名:</span>
        <input id="inputTableName" class="table-name-input" type="text" placeholder="输入表名" value="${escapeHtml(initialState.tableName)}">
      </div>
    </div>

    <!-- Tabs Bar -->
    <div class="tabs-bar" role="tablist">
      <button class="tab-item active" data-tab="fields" role="tab">字段</button>
      <button class="tab-item" data-tab="indexes" role="tab">索引</button>
      <button class="tab-item" data-tab="foreign_keys" role="tab">外键</button>
      <button class="tab-item" data-tab="uniques" role="tab">唯一键</button>
      <button class="tab-item" data-tab="checks" role="tab">检查</button>
      <button class="tab-item" data-tab="triggers" role="tab">触发器</button>
      <button class="tab-item" data-tab="options" role="tab">选项</button>
      <button class="tab-item" data-tab="sql_preview" role="tab">SQL 预览</button>
    </div>

    <!-- Content Area -->
    <div class="content-area">
      <!-- 字段 Tab Pane -->
      <div id="pane-fields" class="tab-pane active">
        <div class="grid-container" id="gridContainer">
          <table class="grid-table" id="fieldsTable">
            <thead>
              <tr>
                <th class="col-sel"></th>
                <th class="col-name">名称</th>
                <th class="col-type">类型</th>
                <th class="col-length">大小</th>
                <th class="col-scale">比例</th>
                <th class="col-notnull">不是 null</th>
                <th class="col-key">键</th>
                <th class="col-comment">注释</th>
              </tr>
            </thead>
            <tbody id="fieldsTbody"></tbody>
          </table>
        </div>

        <!-- Bottom Properties Panel -->
        <div class="properties-panel" id="propertiesPanel">
          <div class="props-grid">
            <span class="prop-label">默认:</span>
            <div style="display:flex;gap:4px;">
              <select id="propDefaultType" class="prop-val-select" style="width:110px;">
                <option value="NULL">NULL</option>
                <option value="EMPTY">空字符串</option>
                <option value="CURRENT_TIMESTAMP">CURRENT_TIMESTAMP</option>
                <option value="CUSTOM">自定义</option>
              </select>
              <input id="propDefaultVal" class="prop-val-input" style="flex:1;" placeholder="默认值">
            </div>

            <span class="prop-label">排序规则:</span>
            <select id="propCollation" class="prop-val-select">
              <option value="">(继承表默认)</option>
              <option value="utf8mb4_general_ci">utf8mb4_general_ci</option>
              <option value="utf8mb4_unicode_ci">utf8mb4_unicode_ci</option>
              <option value="utf8mb4_0900_ai_ci">utf8mb4_0900_ai_ci</option>
              <option value="utf8mb4_bin">utf8mb4_bin</option>
              <option value="utf8_general_ci">utf8_general_ci</option>
              <option value="gbk_chinese_ci">gbk_chinese_ci</option>
            </select>

            <span class="prop-label">自动递增:</span>
            <div style="display:flex;align-items:center;">
              <input id="propAutoInc" type="checkbox" class="custom-checkbox">
              <span style="margin-left:6px;font-size:11px;color:var(--vscode-descriptionForeground);">AUTO_INCREMENT</span>
            </div>

            <span class="prop-label">字段注释:</span>
            <input id="propComment" class="prop-val-input" placeholder="输入字段描述">
          </div>
        </div>
      </div>

      <!-- SQL 预览 Tab Pane -->
      <div id="pane-sql_preview" class="tab-pane">
        <div class="preview-pane">
          <div class="preview-actions">
            <span style="font-size:12px;color:var(--vscode-descriptionForeground);">实时预览根据当前字段设计生成的 DDL 语句：</span>
            <button id="btnCopySql" class="tool-btn" style="border:1px solid var(--vscode-input-border);">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
              <span id="btnCopySqlText">复制 SQL</span>
            </button>
          </div>
          <pre class="preview-box" id="previewSqlText">-- 正在生成 SQL 预览...</pre>
        </div>
      </div>

      <!-- 选项 Tab Pane -->
      <div id="pane-options" class="tab-pane">
        <div class="options-pane">
          <div style="display:grid;grid-template-columns:100px 1fr;gap:12px;align-items:center;">
            <span style="text-align:right;color:var(--vscode-descriptionForeground);">存储引擎:</span>
            <select id="tblEngine" class="prop-val-select" style="max-width:240px;">
              <option value="InnoDB">InnoDB</option>
              <option value="MyISAM">MyISAM</option>
              <option value="MEMORY">MEMORY</option>
            </select>

            <span style="text-align:right;color:var(--vscode-descriptionForeground);">字符集:</span>
            <select id="tblCharset" class="prop-val-select" style="max-width:240px;">
              <option value="utf8mb4">utf8mb4</option>
              <option value="utf8">utf8</option>
              <option value="latin1">latin1</option>
              <option value="gbk">gbk</option>
            </select>

            <span style="text-align:right;color:var(--vscode-descriptionForeground);">排序规则:</span>
            <select id="tblCollation" class="prop-val-select" style="max-width:240px;">
              <option value="utf8mb4_unicode_ci">utf8mb4_unicode_ci</option>
              <option value="utf8mb4_general_ci">utf8mb4_general_ci</option>
              <option value="utf8mb4_0900_ai_ci">utf8mb4_0900_ai_ci</option>
              <option value="utf8mb4_bin">utf8mb4_bin</option>
            </select>

            <span style="text-align:right;color:var(--vscode-descriptionForeground);">自动递增:</span>
            <input id="tblAutoIncrement" class="prop-val-input" style="max-width:240px;" placeholder="初始值，例如 1">

            <span style="text-align:right;color:var(--vscode-descriptionForeground);">表注释:</span>
            <input id="tblComment" class="prop-val-input" style="max-width:360px;" placeholder="表描述信息">
          </div>
        </div>
      </div>

      <!-- 索引 Tab Pane -->
      <div id="pane-indexes" class="tab-pane">
        <div style="padding: 8px 12px; border-bottom: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.2)); display: flex; gap: 8px; align-items: center; background: var(--vscode-sideBar-background, #1e1e1e); flex-shrink: 0;">
          <button id="btnAddIndex" class="tool-btn" type="button" title="添加新索引">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="12" x2="16" y2="12"/></svg>
            <span>添加索引</span>
          </button>
          <button id="btnDeleteIndex" class="tool-btn btn-delete" type="button" title="删除选中的索引" disabled>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="8" y1="12" x2="16" y2="12"/></svg>
            <span>删除索引</span>
          </button>
          <span style="margin-left:auto;font-size:11px;color:var(--vscode-descriptionForeground);">字段列表使用英文逗号分隔，如: col1, col2</span>
        </div>
        <div class="grid-container" style="flex:1;">
          <table class="grid-table" id="indexesTable">
            <thead>
              <tr>
                <th class="col-sel"></th>
                <th style="width:200px;">名</th>
                <th style="width:260px;">字段 (逗号分隔)</th>
                <th style="width:140px;">索引类型</th>
                <th style="width:130px;">索引方法</th>
                <th>注释</th>
              </tr>
            </thead>
            <tbody id="indexesTbody"></tbody>
          </table>
        </div>
      </div>

      <!-- Placeholder Panes for Foreign Keys, etc. -->
      <div id="pane-placeholder" class="tab-pane">
        <div class="notice-pane">
          <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
          <div style="font-size:14px;font-weight:500;" id="placeholderTitle">功能暂未开放</div>
          <div style="font-size:12px;max-width:400px;line-height:1.6;" id="placeholderDesc">第一版重点支持表字段设计、索引管理、表选项设置与 SQL 预览。外键与触发器等将在后续版本支持。</div>
        </div>
      </div>
    </div>

    <!-- Status Bar -->
    <div class="status-bar">
      <span id="statusMessage">就绪</span>
      <span id="statusInfo">${escapeHtml(initialState.database)} · 字段数: <strong id="fieldCount">0</strong></span>
    </div>
  </div>

  <script nonce="${nonce}">
    (function() {
      const vscode = acquireVsCodeApi();
      const state = ${serializedState};
      let activeRowIndex = 0;
      let activeTab = 'fields';
      let isDirty = false;

      const DATA_TYPES = [
        'VARCHAR', 'INT', 'BIGINT', 'TEXT', 'DATETIME', 'DATE', 'TIME', 'TIMESTAMP',
        'DECIMAL', 'TINYINT', 'SMALLINT', 'MEDIUMINT', 'FLOAT', 'DOUBLE',
        'BOOLEAN', 'CHAR', 'BLOB', 'LONGTEXT', 'MEDIUMTEXT', 'JSON'
      ];

      // Elements
      const inputTableName = document.getElementById('inputTableName');
      const fieldsTbody = document.getElementById('fieldsTbody');
      const fieldCountSpan = document.getElementById('fieldCount');
      const statusMessage = document.getElementById('statusMessage');
      const btnSave = document.getElementById('btnSave');
      const btnAddField = document.getElementById('btnAddField');
      const btnInsertField = document.getElementById('btnInsertField');
      const btnDeleteField = document.getElementById('btnDeleteField');
      const btnTogglePk = document.getElementById('btnTogglePk');
      const btnMoveUp = document.getElementById('btnMoveUp');
      const btnMoveDown = document.getElementById('btnMoveDown');
      const previewSqlText = document.getElementById('previewSqlText');
      const btnCopySql = document.getElementById('btnCopySql');
      const btnCopySqlText = document.getElementById('btnCopySqlText');

      // Properties elements
      const propDefaultType = document.getElementById('propDefaultType');
      const propDefaultVal = document.getElementById('propDefaultVal');
      const propCollation = document.getElementById('propCollation');
      const propAutoInc = document.getElementById('propAutoInc');
      const propComment = document.getElementById('propComment');

      // Options elements
      const tblEngine = document.getElementById('tblEngine');
      const tblCharset = document.getElementById('tblCharset');
      const tblCollation = document.getElementById('tblCollation');
      const tblAutoIncrement = document.getElementById('tblAutoIncrement');
      const tblComment = document.getElementById('tblComment');

      // Indexes elements
      let activeIndexRow = -1;
      state.indexes = state.indexes || [];
      const indexesTbody = document.getElementById('indexesTbody');
      const btnAddIndex = document.getElementById('btnAddIndex');
      const btnDeleteIndex = document.getElementById('btnDeleteIndex');

      // Sync Table options
      if (state.options) {
        if (state.options.engine) tblEngine.value = state.options.engine;
        if (state.options.charset) tblCharset.value = state.options.charset;
        if (state.options.collation) tblCollation.value = state.options.collation;
        if (state.options.autoIncrement) tblAutoIncrement.value = state.options.autoIncrement;
        if (state.options.comment) tblComment.value = state.options.comment;
      }

      function setDirty(dirty) {
        isDirty = dirty;
        vscode.postMessage({ type: 'dirtyState', dirty: isDirty });
      }

      function renderFields() {
        fieldsTbody.innerHTML = '';
        fieldCountSpan.textContent = state.columns.length;

        if (activeRowIndex >= state.columns.length) {
          activeRowIndex = Math.max(0, state.columns.length - 1);
        }

        // Enable/disable buttons based on selection
        const hasSelection = state.columns.length > 0 && activeRowIndex >= 0 && activeRowIndex < state.columns.length;
        btnDeleteField.disabled = !hasSelection;
        btnTogglePk.disabled = !hasSelection;
        btnMoveUp.disabled = !hasSelection || activeRowIndex === 0;
        btnMoveDown.disabled = !hasSelection || activeRowIndex === state.columns.length - 1;

        state.columns.forEach((col, index) => {
          const isSelected = index === activeRowIndex;
          const tr = document.createElement('tr');
          if (isSelected) tr.classList.add('selected');

          tr.addEventListener('click', (e) => {
            if (activeRowIndex !== index) {
              activeRowIndex = index;
              renderFields();
            }
          });

          // Col 1: Selector
          const tdSel = document.createElement('td');
          tdSel.className = 'col-sel';
          tdSel.innerHTML = isSelected ? '▶' : '';
          tr.appendChild(tdSel);

          // Col 2: Name
          const tdName = document.createElement('td');
          tdName.className = 'col-name';
          const inputName = document.createElement('input');
          inputName.className = 'cell-input';
          inputName.value = col.name || '';
          inputName.addEventListener('input', (e) => {
            col.name = e.target.value;
            setDirty(true);
            updatePreviewIfActive();
          });
          tdName.appendChild(inputName);
          tr.appendChild(tdName);

          // Col 3: Type
          const tdType = document.createElement('td');
          tdType.className = 'col-type';
          const selectType = document.createElement('select');
          selectType.className = 'cell-select';
          DATA_TYPES.forEach(t => {
            const opt = document.createElement('option');
            opt.value = t;
            opt.textContent = t;
            if (t === (col.dataType || '').toUpperCase()) opt.selected = true;
            selectType.appendChild(opt);
          });
          selectType.addEventListener('change', (e) => {
            col.dataType = e.target.value;
            // auto adjust default length for types
            if (['VARCHAR', 'CHAR'].includes(col.dataType) && !col.length) col.length = '255';
            if (['DECIMAL', 'NUMERIC'].includes(col.dataType) && !col.length) { col.length = '10'; col.scale = '2'; }
            setDirty(true);
            renderFields();
            updatePreviewIfActive();
          });
          tdType.appendChild(selectType);
          tr.appendChild(tdType);

          // Col 4: Length / Size
          const tdLen = document.createElement('td');
          tdLen.className = 'col-length';
          const inputLen = document.createElement('input');
          inputLen.className = 'cell-input';
          inputLen.value = col.length || '';
          inputLen.placeholder = '-';
          inputLen.addEventListener('input', (e) => {
            col.length = e.target.value;
            setDirty(true);
            updatePreviewIfActive();
          });
          tdLen.appendChild(inputLen);
          tr.appendChild(tdLen);

          // Col 5: Scale
          const tdScale = document.createElement('td');
          tdScale.className = 'col-scale';
          const inputScale = document.createElement('input');
          inputScale.className = 'cell-input';
          inputScale.value = col.scale || '';
          inputScale.placeholder = '-';
          inputScale.addEventListener('input', (e) => {
            col.scale = e.target.value;
            setDirty(true);
            updatePreviewIfActive();
          });
          tdScale.appendChild(inputScale);
          tr.appendChild(tdScale);

          // Col 6: Not Null
          const tdNotNull = document.createElement('td');
          tdNotNull.className = 'col-notnull';
          const chkNotNull = document.createElement('input');
          chkNotNull.type = 'checkbox';
          chkNotNull.className = 'custom-checkbox';
          chkNotNull.checked = !!col.notNull;
          chkNotNull.addEventListener('change', (e) => {
            col.notNull = e.target.checked;
            if (!col.notNull && col.isPrimaryKey) {
              // PK cannot be nullable
              col.notNull = true;
              chkNotNull.checked = true;
            }
            setDirty(true);
            updateProperties();
            updatePreviewIfActive();
          });
          tdNotNull.appendChild(chkNotNull);
          tr.appendChild(tdNotNull);

          // Col 7: Key
          const tdKey = document.createElement('td');
          tdKey.className = 'col-key';
          if (col.isPrimaryKey) {
            const pkCols = state.columns.filter(c => c.isPrimaryKey);
            const pkOrder = pkCols.indexOf(col) + 1;
            tdKey.innerHTML = '<span class="key-badge">🔑 ' + (pkCols.length > 1 ? pkOrder : '1') + '</span>';
          }
          tr.appendChild(tdKey);

          // Col 8: Comment
          const tdComment = document.createElement('td');
          tdComment.className = 'col-comment';
          const inputComment = document.createElement('input');
          inputComment.className = 'cell-input';
          inputComment.value = col.comment || '';
          inputComment.placeholder = '字段注释';
          inputComment.addEventListener('input', (e) => {
            col.comment = e.target.value;
            setDirty(true);
            if (activeRowIndex === index) {
              propComment.value = col.comment;
            }
            updatePreviewIfActive();
          });
          tdComment.appendChild(inputComment);
          tr.appendChild(tdComment);

          fieldsTbody.appendChild(tr);
        });

        updateProperties();
      }

      function updateProperties() {
        const col = state.columns[activeRowIndex];
        if (!col) {
          propDefaultType.disabled = true;
          propDefaultVal.disabled = true;
          propCollation.disabled = true;
          propAutoInc.disabled = true;
          propComment.disabled = true;
          return;
        }

        propDefaultType.disabled = false;
        propDefaultVal.disabled = false;
        propCollation.disabled = false;
        propAutoInc.disabled = false;
        propComment.disabled = false;

        const def = (col.defaultValue ?? '').trim();
        if (def.toUpperCase() === 'NULL') {
          propDefaultType.value = 'NULL';
          propDefaultVal.value = '';
          propDefaultVal.style.display = 'none';
        } else if (def === "''" || def.toUpperCase() === 'EMPTY') {
          propDefaultType.value = 'EMPTY';
          propDefaultVal.value = '';
          propDefaultVal.style.display = 'none';
        } else if (def.toUpperCase() === 'CURRENT_TIMESTAMP') {
          propDefaultType.value = 'CURRENT_TIMESTAMP';
          propDefaultVal.value = '';
          propDefaultVal.style.display = 'none';
        } else {
          propDefaultType.value = 'CUSTOM';
          propDefaultVal.value = def;
          propDefaultVal.style.display = 'block';
        }

        propCollation.value = col.collation || '';
        propAutoInc.checked = !!col.autoIncrement;
        propComment.value = col.comment || '';
      }

      // Property Event Handlers
      propDefaultType.addEventListener('change', (e) => {
        const col = state.columns[activeRowIndex];
        if (!col) return;
        const val = e.target.value;
        if (val === 'NULL') {
          col.defaultValue = 'NULL';
          propDefaultVal.style.display = 'none';
        } else if (val === 'EMPTY') {
          col.defaultValue = "''";
          propDefaultVal.style.display = 'none';
        } else if (val === 'CURRENT_TIMESTAMP') {
          col.defaultValue = 'CURRENT_TIMESTAMP';
          propDefaultVal.style.display = 'none';
        } else {
          col.defaultValue = propDefaultVal.value;
          propDefaultVal.style.display = 'block';
        }
        setDirty(true);
        updatePreviewIfActive();
      });

      propDefaultVal.addEventListener('input', (e) => {
        const col = state.columns[activeRowIndex];
        if (!col) return;
        col.defaultValue = e.target.value;
        setDirty(true);
        updatePreviewIfActive();
      });

      propCollation.addEventListener('change', (e) => {
        const col = state.columns[activeRowIndex];
        if (!col) return;
        col.collation = e.target.value;
        setDirty(true);
        updatePreviewIfActive();
      });

      propAutoInc.addEventListener('change', (e) => {
        const col = state.columns[activeRowIndex];
        if (!col) return;
        col.autoIncrement = e.target.checked;
        if (col.autoIncrement) {
          col.isPrimaryKey = true;
          col.notNull = true;
          if (!['TINYINT','SMALLINT','MEDIUMINT','INT','INTEGER','BIGINT'].includes(col.dataType.toUpperCase())) {
            col.dataType = 'BIGINT';
          }
        }
        setDirty(true);
        renderFields();
        updatePreviewIfActive();
      });

      propComment.addEventListener('input', (e) => {
        const col = state.columns[activeRowIndex];
        if (!col) return;
        col.comment = e.target.value;
        setDirty(true);
        renderFields();
        updatePreviewIfActive();
      });

      // Table Options Listeners
      tblEngine.addEventListener('change', (e) => { state.options.engine = e.target.value; setDirty(true); updatePreviewIfActive(); });
      tblCharset.addEventListener('change', (e) => { state.options.charset = e.target.value; setDirty(true); updatePreviewIfActive(); });
      tblCollation.addEventListener('change', (e) => { state.options.collation = e.target.value; setDirty(true); updatePreviewIfActive(); });
      tblAutoIncrement.addEventListener('input', (e) => { state.options.autoIncrement = e.target.value; setDirty(true); updatePreviewIfActive(); });
      tblComment.addEventListener('input', (e) => { state.options.comment = e.target.value; setDirty(true); updatePreviewIfActive(); });

      // Table Name Listener
      inputTableName.addEventListener('input', (e) => {
        state.tableName = e.target.value;
        setDirty(true);
        updatePreviewIfActive();
      });

      // Toolbar Actions
      btnAddField.addEventListener('click', () => {
        const newCol = {
          id: 'col_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
          name: 'field_' + (state.columns.length + 1),
          dataType: 'VARCHAR',
          length: '255',
          scale: '',
          notNull: false,
          isPrimaryKey: false,
          defaultValue: 'NULL',
          collation: '',
          autoIncrement: false,
          comment: ''
        };
        state.columns.push(newCol);
        activeRowIndex = state.columns.length - 1;
        setDirty(true);
        renderFields();
        updatePreviewIfActive();

        // Scroll to bottom
        const container = document.getElementById('gridContainer');
        container.scrollTop = container.scrollHeight;
      });

      btnInsertField.addEventListener('click', () => {
        const insertPos = activeRowIndex >= 0 ? activeRowIndex : 0;
        const newCol = {
          id: 'col_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
          name: 'field_' + (state.columns.length + 1),
          dataType: 'VARCHAR',
          length: '255',
          scale: '',
          notNull: false,
          isPrimaryKey: false,
          defaultValue: 'NULL',
          collation: '',
          autoIncrement: false,
          comment: ''
        };
        state.columns.splice(insertPos, 0, newCol);
        activeRowIndex = insertPos;
        setDirty(true);
        renderFields();
        updatePreviewIfActive();
      });

      btnDeleteField.addEventListener('click', () => {
        if (state.columns.length === 0 || activeRowIndex < 0 || activeRowIndex >= state.columns.length) return;
        state.columns.splice(activeRowIndex, 1);
        if (activeRowIndex >= state.columns.length) {
          activeRowIndex = Math.max(0, state.columns.length - 1);
        }
        setDirty(true);
        renderFields();
        updatePreviewIfActive();
      });

      btnTogglePk.addEventListener('click', () => {
        const col = state.columns[activeRowIndex];
        if (!col) return;
        col.isPrimaryKey = !col.isPrimaryKey;
        if (col.isPrimaryKey) {
          col.notNull = true;
        } else {
          col.autoIncrement = false;
        }
        setDirty(true);
        renderFields();
        updatePreviewIfActive();
      });

      btnMoveUp.addEventListener('click', () => {
        if (activeRowIndex <= 0) return;
        const temp = state.columns[activeRowIndex];
        state.columns[activeRowIndex] = state.columns[activeRowIndex - 1];
        state.columns[activeRowIndex - 1] = temp;
        activeRowIndex -= 1;
        setDirty(true);
        renderFields();
        updatePreviewIfActive();
      });

      btnMoveDown.addEventListener('click', () => {
        if (activeRowIndex >= state.columns.length - 1) return;
        const temp = state.columns[activeRowIndex];
        state.columns[activeRowIndex] = state.columns[activeRowIndex + 1];
        state.columns[activeRowIndex + 1] = temp;
        activeRowIndex += 1;
        setDirty(true);
        renderFields();
        updatePreviewIfActive();
      });

      // Indexes rendering and listeners
      function renderIndexes() {
        indexesTbody.innerHTML = '';
        if (activeIndexRow >= state.indexes.length) {
          activeIndexRow = Math.max(0, state.indexes.length - 1);
        }
        btnDeleteIndex.disabled = state.indexes.length === 0 || activeIndexRow < 0 || activeIndexRow >= state.indexes.length;

        state.indexes.forEach((idx, index) => {
          const isSelected = index === activeIndexRow;
          const tr = document.createElement('tr');
          if (isSelected) tr.classList.add('selected');

          tr.addEventListener('click', () => {
            if (activeIndexRow !== index) {
              activeIndexRow = index;
              renderIndexes();
            }
          });

          // Col 1: Selector
          const tdSel = document.createElement('td');
          tdSel.className = 'col-sel';
          tdSel.innerHTML = isSelected ? '▶' : '';
          tr.appendChild(tdSel);

          // Col 2: Name
          const tdName = document.createElement('td');
          const inputName = document.createElement('input');
          inputName.className = 'cell-input';
          inputName.value = idx.name || '';
          inputName.placeholder = '索引名称';
          inputName.addEventListener('input', (e) => {
            idx.name = e.target.value;
            setDirty(true);
            updatePreviewIfActive();
          });
          tdName.appendChild(inputName);
          tr.appendChild(tdName);

          // Col 3: Columns
          const tdCols = document.createElement('td');
          const inputCols = document.createElement('input');
          inputCols.className = 'cell-input';
          inputCols.value = (idx.columns || []).join(', ');
          inputCols.placeholder = '字段名，逗号分隔';
          inputCols.addEventListener('input', (e) => {
            idx.columns = e.target.value.split(',').map(s => s.trim()).filter(Boolean);
            setDirty(true);
            updatePreviewIfActive();
          });
          tdCols.appendChild(inputCols);
          tr.appendChild(tdCols);

          // Col 4: Type
          const tdType = document.createElement('td');
          const selType = document.createElement('select');
          selType.className = 'cell-select';
          [
            { value: 'INDEX', label: 'INDEX (普通)' },
            { value: 'UNIQUE', label: 'UNIQUE (唯一)' },
            { value: 'FULLTEXT', label: 'FULLTEXT (全文)' }
          ].forEach(t => {
            const opt = document.createElement('option');
            opt.value = t.value;
            opt.textContent = t.label;
            if ((idx.type || 'INDEX').toUpperCase() === t.value) opt.selected = true;
            selType.appendChild(opt);
          });
          selType.addEventListener('change', (e) => {
            idx.type = e.target.value;
            setDirty(true);
            updatePreviewIfActive();
          });
          tdType.appendChild(selType);
          tr.appendChild(tdType);

          // Col 5: Method
          const tdMethod = document.createElement('td');
          const selMethod = document.createElement('select');
          selMethod.className = 'cell-select';
          [
            { value: 'BTREE', label: 'BTREE' },
            { value: 'HASH', label: 'HASH' },
            { value: '', label: '(默认)' }
          ].forEach(m => {
            const opt = document.createElement('option');
            opt.value = m.value;
            opt.textContent = m.label;
            if ((idx.method || 'BTREE').toUpperCase() === m.value) opt.selected = true;
            selMethod.appendChild(opt);
          });
          selMethod.addEventListener('change', (e) => {
            idx.method = e.target.value;
            setDirty(true);
            updatePreviewIfActive();
          });
          tdMethod.appendChild(selMethod);
          tr.appendChild(tdMethod);

          // Col 6: Comment
          const tdComment = document.createElement('td');
          const inputComment = document.createElement('input');
          inputComment.className = 'cell-input';
          inputComment.value = idx.comment || '';
          inputComment.placeholder = '注释';
          inputComment.addEventListener('input', (e) => {
            idx.comment = e.target.value;
            setDirty(true);
            updatePreviewIfActive();
          });
          tdComment.appendChild(inputComment);
          tr.appendChild(tdComment);

          indexesTbody.appendChild(tr);
        });
      }

      btnAddIndex.addEventListener('click', () => {
        const defaultCol = (state.columns && state.columns.length > 0) ? [state.columns[0].name] : [];
        const newIndex = {
          id: 'idx_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
          name: 'idx_' + (state.indexes.length + 1),
          columns: defaultCol,
          type: 'INDEX',
          method: 'BTREE',
          comment: ''
        };
        state.indexes.push(newIndex);
        activeIndexRow = state.indexes.length - 1;
        setDirty(true);
        renderIndexes();
        updatePreviewIfActive();
      });

      btnDeleteIndex.addEventListener('click', () => {
        if (state.indexes.length === 0 || activeIndexRow < 0 || activeIndexRow >= state.indexes.length) return;
        state.indexes.splice(activeIndexRow, 1);
        if (activeIndexRow >= state.indexes.length) {
          activeIndexRow = Math.max(0, state.indexes.length - 1);
        }
        setDirty(true);
        renderIndexes();
        updatePreviewIfActive();
      });

      // Tabs Navigation
      document.querySelectorAll('.tab-item').forEach(tab => {
        tab.addEventListener('click', () => {
          document.querySelectorAll('.tab-item').forEach(t => t.classList.remove('active'));
          document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));

          tab.classList.add('active');
          const tabKey = tab.dataset.tab;
          activeTab = tabKey;

          if (tabKey === 'fields') {
            document.getElementById('pane-fields').classList.add('active');
          } else if (tabKey === 'indexes') {
            document.getElementById('pane-indexes').classList.add('active');
            renderIndexes();
          } else if (tabKey === 'sql_preview') {
            document.getElementById('pane-sql_preview').classList.add('active');
            requestSqlPreview();
          } else if (tabKey === 'options') {
            document.getElementById('pane-options').classList.add('active');
          } else {
            const placeholder = document.getElementById('pane-placeholder');
            placeholder.classList.add('active');
            const titleMap = {
              foreign_keys: '外键管理',
              uniques: '唯一约束',
              checks: '检查约束',
              triggers: '触发器'
            };
            document.getElementById('placeholderTitle').textContent = (titleMap[tabKey] || tabKey) + '（后续版本支持）';
          }
        });
      });

      function updatePreviewIfActive() {
        if (activeTab === 'sql_preview') {
          requestSqlPreview();
        }
      }

      function requestSqlPreview() {
        vscode.postMessage({ type: 'getPreviewSql', state });
      }

      btnCopySql.addEventListener('click', () => {
        const text = previewSqlText.textContent;
        if (!text) return;
        vscode.postMessage({ type: 'copy', text });
        btnCopySqlText.textContent = '已复制！';
        setTimeout(() => { btnCopySqlText.textContent = '复制 SQL'; }, 2000);
      });

      // Save
      btnSave.addEventListener('click', () => {
        statusMessage.textContent = '正在保存表结构...';
        statusMessage.className = 'status-msg';
        btnSave.disabled = true;
        vscode.postMessage({ type: 'save', state });
      });

      // Handle Keyboard Shortcuts
      window.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === 's') {
          e.preventDefault();
          btnSave.click();
        }
      });

      // Handle Backend Messages
      window.addEventListener('message', (event) => {
        const msg = event.data;
        if (!msg) return;

        if (msg.type === 'previewSql') {
          previewSqlText.textContent = msg.sql || '-- 没有可预览的 SQL';
        }

        if (msg.type === 'saveSuccess') {
          btnSave.disabled = false;
          statusMessage.textContent = '保存成功！';
          statusMessage.className = 'status-msg';
          setDirty(false);
          // Update baseline state
          if (msg.newState) {
            Object.assign(state, msg.newState);
            inputTableName.value = state.tableName;
            if (state.options && state.options.autoIncrement) {
              tblAutoIncrement.value = state.options.autoIncrement;
            }
            renderFields();
            renderIndexes();
          }
        }

        if (msg.type === 'saveError') {
          btnSave.disabled = false;
          statusMessage.textContent = '保存失败：' + (msg.error || '未知错误');
          statusMessage.className = 'status-msg error';
        }
      });

      // Initial Render
      renderFields();
      statusMessage.textContent = '就绪';
    })();
  </script>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
