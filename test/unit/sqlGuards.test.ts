import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyResultLimit,
  buildTablePreviewEditorSql,
  buildTablePreviewSql,
  escapeIdentifier,
  hasTopLevelLimit,
  resolveExecutableSql
} from '../../src/query/sqlGuards.js';

test('escapes MySQL identifiers', () => {
  assert.equal(escapeIdentifier('order`items'), '`order``items`');
  assert.equal(
    buildTablePreviewSql('sales-db', 'order`items'),
    'SELECT * FROM `sales-db`.`order``items` LIMIT ? OFFSET ?'
  );
  assert.equal(
    buildTablePreviewEditorSql('sales-db', 'order`items', 2, 100),
    'SELECT * FROM `sales-db`.`order``items`\nLIMIT 100 OFFSET 200;'
  );
});

test('uses selected SQL and falls back to the document', () => {
  assert.equal(resolveExecutableSql('SELECT 1', ' SELECT 2; '), 'SELECT 2;');
  assert.equal(resolveExecutableSql(' SELECT 1 '), 'SELECT 1');
  assert.throws(() => resolveExecutableSql('  '), /没有可执行的 SQL/);
});

test('detects only top-level LIMIT clauses', () => {
  assert.equal(hasTopLevelLimit("SELECT 'limit 9' AS value"), false);
  assert.equal(hasTopLevelLimit('SELECT * FROM (SELECT * FROM users LIMIT 1) nested'), false);
  assert.equal(hasTopLevelLimit('SELECT * FROM users LIMIT 20'), true);
  assert.equal(hasTopLevelLimit('SELECT * FROM users /* LIMIT 1 */'), false);
});

test('adds a defensive result limit to SELECT and WITH queries', () => {
  assert.equal(applyResultLimit('SELECT * FROM users;', 500), 'SELECT * FROM users LIMIT 501');
  assert.equal(applyResultLimit('WITH data AS (SELECT 1) SELECT * FROM data', 10), 'WITH data AS (SELECT 1) SELECT * FROM data LIMIT 11');
  assert.equal(applyResultLimit('UPDATE users SET active = 1;', 500), 'UPDATE users SET active = 1');
  assert.equal(applyResultLimit('SELECT * FROM users LIMIT 5;', 500), 'SELECT * FROM users LIMIT 5');
  assert.equal(applyResultLimit('SELECT * FROM users LIMIT 50000;', 500), 'SELECT * FROM users LIMIT 501');
  assert.equal(applyResultLimit('SELECT * FROM users LIMIT 40, 50000;', 500), 'SELECT * FROM users LIMIT 40, 501');
  assert.equal(applyResultLimit('SELECT * FROM users LIMIT 50000 OFFSET 40;', 500), 'SELECT * FROM users LIMIT 501 OFFSET 40');
});
