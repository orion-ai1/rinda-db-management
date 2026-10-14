import assert from 'node:assert/strict';
import test from 'node:test';
import { buildHtml, getColumnTypeBadge } from '../../src/webview/resultPanelHtml.js';
import type { QueryResult } from '../../src/query/QueryService.js';
import type { TableEditingView } from '../../src/editing/types.js';

test('buildHtml produces valid HTML and syntactically valid JavaScript', () => {
  const result: QueryResult = {
    columns: ['id', 'option_name', 'option_value', 'autoload'],
    rows: [
      ['1', 'siteurl', 'https://example.com', 'yes'],
      ['2', 'home', 'https://example.com', 'yes'],
      ['3', 'active_plugins', 'a:1:{i:0;s:19:"akismet/akismet.php";}', 'yes'],
      ['4', 'config_json', '{"theme":"dark","version":2}', 'no'],
      ['5', 'null_field', null, 'yes']
    ],
    rowCount: 5,
    affectedRows: 0,
    durationMs: 12,
    truncated: false,
    hasMore: false
  };

  const editing: TableEditingView = {
    sessionId: 'test-session-123',
    database: 'wordpress',
    table: 'wp_options',
    enabled: true,
    deletionEnabled: true,
    locatorLabel: 'PRIMARY KEY (id)',
    columns: [
      { name: 'id', dataType: 'bigint', columnType: 'bigint(20) unsigned', nullable: false, editable: false, multiline: false, readOnlyReason: '主键' },
      { name: 'option_name', dataType: 'varchar', columnType: 'varchar(191)', nullable: false, editable: true, multiline: false },
      { name: 'option_value', dataType: 'longtext', columnType: 'longtext', nullable: true, editable: true, multiline: true },
      { name: 'autoload', dataType: 'varchar', columnType: 'varchar(20)', nullable: false, editable: true, multiline: false }
    ],
    rows: [
      { token: 'tok-1', locatorValues: [{ name: 'id', value: '1' }] },
      { token: 'tok-2', locatorValues: [{ name: 'id', value: '2' }] },
      { token: 'tok-3', locatorValues: [{ name: 'id', value: '3' }] },
      { token: 'tok-4', locatorValues: [{ name: 'id', value: '4' }] },
      { token: 'tok-5', locatorValues: [{ name: 'id', value: '5' }] }
    ]
  };

  const html = buildHtml(result, {
    title: 'wordpress.wp_options · Local',
    editing,
    page: 0,
    canGoBack: false,
    canGoForward: false,
    sql: 'SELECT * FROM `wordpress`.`wp_options`\nLIMIT 100 OFFSET 0;'
  });

  // 1. Verify HTML contains expected elements
  assert.match(html, /<title>wordpress\.wp_options · Local<\/title>/);
  assert.match(html, /data-tab="text"/);
  assert.match(html, /data-tab="json"/);
  // Hex, image, web tabs should NOT exist
  assert.doesNotMatch(html, /data-tab="hex"/);
  assert.doesNotMatch(html, /data-tab="image"/);
  assert.doesNotMatch(html, /data-tab="web"/);

  // Verify compact single-row topbar elements
  assert.match(html, /class="compact-sql-bar"/);
  assert.match(html, /id="sqlEditor"/);
  assert.match(html, /id="executeSql"/);
  assert.match(html, /id="searchBtn"/);
  assert.doesNotMatch(html, /<h2>当前 SQL<\/h2>/);
  assert.doesNotMatch(html, /可编辑并重新执行；离开或重跑前保护未提交草稿/);

  // Verify search widget and folding detail panel
  assert.match(html, /id="searchWidget"/);
  assert.match(html, /id="searchInput"/);
  assert.match(html, /id="detailPanel"/);
  assert.match(html, /id="toggleDetailBtn"/);
  assert.match(html, /id="bottomToggleDetailBtn"/);

  // Verify row hover and active-row styles
  assert.match(html, /tbody tr:hover td/);
  assert.match(html, /tbody tr\.active-row td/);
  assert.match(html, /\.cell-detail-btn/);
  assert.match(html, /\.cell-detail-icon/);
  assert.match(html, /openDetailForEdit/);

  // Verify tab labels indicate editable / read-only
  assert.match(html, /文本 \(可编辑\)/);
  assert.match(html, /JSON \(只读\)/);

  // Verify context menu and drag selection
  assert.match(html, /id="tableContextMenu"/);
  assert.match(html, /data-action="copyCell"/);
  assert.match(html, /data-action="setNull"/);
  assert.match(html, /data-action="setEmpty"/);
  assert.match(html, /data-action="copyRows"/);
  assert.match(html, /data-action="copyInsert"/);
  assert.match(html, /data-action="deleteRows"/);
  assert.match(html, /isDraggingRows/);

  // Verify header sorting elements
  assert.match(html, /class="grid-th"/);
  assert.match(html, /class="sort-badge"/);
  assert.match(html, /applySort/);
  assert.match(html, /sortBadge_/);

  // 2. Extract the script content
  const scriptMatch = html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/);
  assert.ok(scriptMatch, 'script tag must be found in html');
  const scriptContent = scriptMatch[1] ?? '';

  // 3. Verify JavaScript syntax by compiling it with new Function inside a mock environment
  // We mock browser/vscode globals so mock evaluation can parse the code cleanly
  const mockCode = `
    const acquireVsCodeApi = () => ({
      postMessage: () => {},
      getState: () => null,
      setState: () => {}
    });
    const document = {
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener: () => {}
    };
    const window = {
      addEventListener: () => {}
    };
    ${scriptContent}
  `;

  // Compiling with new Function throws a SyntaxError if JavaScript syntax is invalid
  assert.doesNotThrow(() => {
    new Function(mockCode);
  }, 'Webview script MUST be syntactically valid JavaScript without syntax errors');
});

test('buildHtml handles read-only query results without error', () => {
  const result: QueryResult = {
    columns: ['cnt'],
    rows: [['42']],
    rowCount: 1,
    affectedRows: 0,
    durationMs: 5,
    truncated: false,
    hasMore: false
  };

  const html = buildHtml(result, {
    title: 'COUNT(*) Query',
    sql: 'SELECT COUNT(*) AS cnt FROM wp_options;'
  });

  assert.match(html, /COUNT\(\*\) Query/);
  const scriptMatch = html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/);
  assert.ok(scriptMatch);
  assert.doesNotThrow(() => {
    new Function(`
      const acquireVsCodeApi = () => ({ postMessage: () => {}, getState: () => null, setState: () => {} });
      const document = { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], addEventListener: () => {} };
      const window = { addEventListener: () => {} };
      ${scriptMatch[1]}
    `);
  });
});

test('getColumnTypeBadge correctly infers types from schema and sample values', () => {
  // Explicit schema type
  assert.match(getColumnTypeBadge('bigint(20)', 'bigint'), /123.*BIGINT/);
  assert.match(getColumnTypeBadge('varchar(255)', 'varchar'), /ABC.*VARCHAR/);
  assert.match(getColumnTypeBadge('json', 'json'), /\{ \}.*JSON/);
  assert.match(getColumnTypeBadge('datetime', 'datetime'), /DAT.*DATETIME/);

  // Inferred from numbers
  assert.match(getColumnTypeBadge(undefined, undefined, ['1', '2', '300']), /123.*NUM/);
  // Inferred from date strings
  assert.match(getColumnTypeBadge(undefined, undefined, ['2026-10-14 12:00:00', '2026-10-15']), /DAT.*DATETIME/);
  // Inferred from json strings
  assert.match(getColumnTypeBadge(undefined, undefined, ['{"a":1}', '{"b":2}']), /\{ \}.*JSON/);
  // Inferred from plain text
  assert.match(getColumnTypeBadge(undefined, undefined, ['hello', 'world']), /ABC.*TEXT/);
});

test('buildHtml includes EXPLAIN button in SQL bar and handles explain query result', () => {
  const explainResult: QueryResult = {
    columns: ['id', 'select_type', 'table', 'partitions', 'type', 'possible_keys', 'key', 'key_len', 'ref', 'rows', 'filtered', 'Extra'],
    rows: [
      ['1', 'SIMPLE', 'wp_posts', null, 'ALL', null, null, null, null, '120000', '100.00', 'Using filesort']
    ],
    rowCount: 1,
    affectedRows: 0,
    durationMs: 3,
    truncated: false,
    hasMore: false
  };

  const html = buildHtml(explainResult, {
    title: 'EXPLAIN 分析 · Local',
    sql: 'EXPLAIN SELECT * FROM wp_posts ORDER BY post_date DESC;'
  });

  // Verify compact SQL bar contains EXPLAIN button
  assert.match(html, /id="explainSql"/);
  assert.match(html, /class="[^"]*sql-explain-btn[^"]*"/);
  assert.match(html, /EXPLAIN/);

  // Verify HTML contains explain badges style classes
  assert.match(html, /explain-badge danger/);
  assert.match(html, /ALL \(全表扫描\)/);

  // Verify script parses and is syntactically valid
  const scriptMatch = html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/);
  assert.ok(scriptMatch);
  assert.doesNotThrow(() => {
    new Function(`
      const acquireVsCodeApi = () => ({ postMessage: () => {}, getState: () => null, setState: () => {} });
      const document = { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], addEventListener: () => {} };
      const window = { addEventListener: () => {} };
      ${scriptMatch[1]}
    `);
  });
});

