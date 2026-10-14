import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTableDesignerHtml } from '../../src/webview/tableDesignerHtml.js';
import type { TableDesignerState } from '../../src/design/TableDesignerTypes.js';

test('buildTableDesignerHtml: generates valid HTML structure with CSP and serialized state', () => {
  const state: TableDesignerState = {
    mode: 'create',
    connectionId: 'conn_test',
    database: 'demo_store',
    tableName: 'orders',
    columns: [
      {
        id: 'col_1',
        name: 'order_id',
        dataType: 'BIGINT',
        length: '20',
        notNull: true,
        isPrimaryKey: true,
        autoIncrement: true,
        defaultValue: '',
        comment: '订单主键'
      },
      {
        id: 'col_2',
        name: 'user_id',
        dataType: 'BIGINT',
        notNull: true,
        isPrimaryKey: false,
        defaultValue: '0',
        comment: '买家ID'
      }
    ],
    options: {
      engine: 'InnoDB',
      charset: 'utf8mb4',
      collation: 'utf8mb4_unicode_ci',
      comment: '订单记录表'
    }
  };

  const html = buildTableDesignerHtml(state);

  assert.ok(html.includes('<!doctype html>'));
  assert.ok(html.includes('Content-Security-Policy'));
  assert.ok(html.includes('新建表'));
  assert.ok(html.includes('orders'));
  assert.ok(html.includes('order_id'));
  assert.ok(html.includes('user_id'));
  assert.ok(html.includes('btnAddField'));
  assert.ok(html.includes('btnInsertField'));
  assert.ok(html.includes('btnDeleteField'));
  assert.ok(html.includes('btnTogglePk'));
  assert.ok(html.includes('btnMoveUp'));
  assert.ok(html.includes('btnMoveDown'));
  assert.ok(html.includes('previewSqlText'));
  assert.ok(html.includes('pane-indexes'));
  assert.ok(html.includes('btnAddIndex'));
  assert.ok(html.includes('btnDeleteIndex'));
  assert.ok(html.includes('tblAutoIncrement'));
});
