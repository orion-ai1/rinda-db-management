import assert from 'node:assert/strict';
import test from 'node:test';
import { isSameTablePreviewSql, MAX_PANEL_SQL_LENGTH, validatePanelSql } from '../../src/webview/queryEditorModel.js';

test('validates editable result-panel SQL before execution', () => {
  assert.deepEqual(validatePanelSql(' SELECT 1; '), { sql: 'SELECT 1;' });
  assert.match(validatePanelSql('   ').error ?? '', /请输入/);
  assert.match(validatePanelSql({}).error ?? '', /格式无效/);
  assert.match(validatePanelSql('x'.repeat(MAX_PANEL_SQL_LENGTH + 1)).error ?? '', /不能超过/);
});

test('detects table preview SQL for the current table', () => {
  assert.equal(isSameTablePreviewSql('SELECT * FROM `migration`.`wp_options` LIMIT 100 OFFSET 0;', 'migration', 'wp_options'), true);
  assert.equal(isSameTablePreviewSql('select * from `wp_options` limit 50 offset 100', 'migration', 'wp_options'), true);
  assert.equal(isSameTablePreviewSql('select * from migration.wp_options', 'migration', 'wp_options'), true);
  assert.equal(isSameTablePreviewSql('SELECT * FROM wp_options', 'migration', 'wp_options'), true);
  assert.equal(isSameTablePreviewSql('SELECT * FROM other_table LIMIT 10;', 'migration', 'wp_options'), false);
  assert.equal(isSameTablePreviewSql('SELECT option_id FROM wp_options;', 'migration', 'wp_options'), false);
  assert.equal(isSameTablePreviewSql('DELETE FROM wp_options WHERE option_id = 1;', 'migration', 'wp_options'), false);
});
