import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SQL_KEYWORDS,
  SQL_FUNCTIONS,
  isTableContextPrefix,
  extractTableQualifier,
  extractTableAliases,
  extractContextFromText
} from '../../src/completion/sqlCompletionHelpers.js';

test('sqlCompletionHelpers: SQL_KEYWORDS and SQL_FUNCTIONS are defined and valid', () => {
  assert.ok(SQL_KEYWORDS.includes('SELECT'));
  assert.ok(SQL_KEYWORDS.includes('FROM'));
  assert.ok(SQL_KEYWORDS.includes('WHERE'));
  assert.ok(SQL_KEYWORDS.includes('EXPLAIN'));

  assert.ok(SQL_FUNCTIONS.some(f => f.name === 'COUNT'));
  assert.ok(SQL_FUNCTIONS.some(f => f.name === 'DATE_FORMAT'));
  assert.ok(SQL_FUNCTIONS.some(f => f.name === 'JSON_EXTRACT'));
});

test('sqlCompletionHelpers: isTableContextPrefix detects table-expecting positions', () => {
  assert.equal(isTableContextPrefix('SELECT * FROM '), true);
  assert.equal(isTableContextPrefix('SELECT * FROM us'), true);
  assert.equal(isTableContextPrefix('SELECT * FROM `db`.`tab'), true);
  assert.equal(isTableContextPrefix('LEFT JOIN '), true);
  assert.equal(isTableContextPrefix('INNER JOIN wp_'), true);
  assert.equal(isTableContextPrefix('INSERT INTO '), true);
  assert.equal(isTableContextPrefix('UPDATE '), true);
  assert.equal(isTableContextPrefix('DESCRIBE '), true);
  assert.equal(isTableContextPrefix('TRUNCATE TABLE '), true);

  // Non-table positions
  assert.equal(isTableContextPrefix('SELECT '), false);
  assert.equal(isTableContextPrefix('SELECT id, '), false);
  assert.equal(isTableContextPrefix('WHERE id = '), false);
  assert.equal(isTableContextPrefix('ORDER BY '), false);
});

test('sqlCompletionHelpers: extractTableQualifier extracts table prefix before dot', () => {
  assert.equal(extractTableQualifier('users.'), 'users');
  assert.equal(extractTableQualifier('SELECT users.'), 'users');
  assert.equal(extractTableQualifier('`wp_posts`.'), 'wp_posts');
  assert.equal(extractTableQualifier('SELECT `u`.'), 'u');
  assert.equal(extractTableQualifier('users'), undefined);
  assert.equal(extractTableQualifier('SELECT * FROM users WHERE '), undefined);
});

test('sqlCompletionHelpers: extractTableAliases extracts table aliases in query', () => {
  const sql = 'SELECT u.id, o.amount FROM users u JOIN orders AS o ON u.id = o.user_id WHERE u.status = 1';
  const aliases = extractTableAliases(sql);
  assert.equal(aliases.get('u'), 'users');
  assert.equal(aliases.get('o'), 'orders');

  const backtickSql = 'SELECT * FROM `wp_posts` `p` JOIN `wp_users` AS `usr` ON p.author = usr.id';
  const backtickAliases = extractTableAliases(backtickSql);
  assert.equal(backtickAliases.get('p'), 'wp_posts');
  assert.equal(backtickAliases.get('usr'), 'wp_users');
});

test('sqlCompletionHelpers: extractContextFromText parses active connection and database hints', () => {
  // 1. Header with Active connection & database
  const headerText = `-- Active: Production · my_database\nSELECT * FROM users;`;
  const res1 = extractContextFromText(headerText);
  assert.equal(res1.profileName, 'Production');
  assert.equal(res1.database, 'my_database');

  // 2. Database comment
  const dbCommentText = `-- Database: analytics_db\nSELECT count(*) FROM events;`;
  const res2 = extractContextFromText(dbCommentText);
  assert.equal(res2.database, 'analytics_db');

  // 3. USE statement
  const useText = `USE \`ecommerce\`;\nSELECT * FROM orders;`;
  const res3 = extractContextFromText(useText);
  assert.equal(res3.database, 'ecommerce');

  // 4. File storage path (legacy)
  const storageFilePath = '/User/test/appData/storage/Dev@localhost@3306/crm_data/query-1.sql';
  const res4 = extractContextFromText('SELECT 1;', storageFilePath);
  assert.equal(res4.database, 'crm_data');

  // 5. Project hidden folder path (.rinda/queries/...)
  const projectRindaPath = '/Workspace/my-project/.rinda/queries/Dev@localhost@3306/shop_db/query_20261014.sql';
  const res5 = extractContextFromText('SELECT 1;', projectRindaPath);
  assert.equal(res5.database, 'shop_db');
});
