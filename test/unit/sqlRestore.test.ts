import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildMysqlRestoreArgs,
  findMissingPrivileges,
  requiredRestorePrivileges
} from '../../src/transfer/SqlRestoreService.js';

test('builds a shell-free mysql restore argument list without secrets or force mode', () => {
  const args = buildMysqlRestoreArgs('/private/credentials/client.cnf', 'restored_db');
  assert.equal(args[0], '--defaults-extra-file=/private/credentials/client.cnf');
  assert.equal(args.includes('--force'), false);
  assert.equal(args.includes('--batch'), true);
  assert.equal(args.at(-1), '--database=restored_db');
  assert.equal(args.some((argument) => /password/i.test(argument)), false);
});

test('derives object-specific privileges and detects missing grants', () => {
  const required = requiredRestorePrivileges({
    tables: 2,
    views: 1,
    routines: 1,
    events: 1,
    triggers: 1
  }, 'create');
  assert.deepEqual(required, [
    'ALTER', 'ALTER ROUTINE', 'CREATE', 'CREATE ROUTINE', 'CREATE VIEW',
    'DROP', 'EVENT', 'INSERT', 'SHOW VIEW', 'TRIGGER'
  ]);
  assert.deepEqual(
    findMissingPrivileges(['GRANT ALL PRIVILEGES ON *.* TO `root`@`%`'], required, 'target_db'),
    []
  );
  assert.deepEqual(
    findMissingPrivileges([
      'GRANT CREATE, INSERT, ALTER ON `target_db`.* TO `writer`@`%`'
    ], ['CREATE', 'INSERT', 'ALTER', 'TRIGGER'], 'target_db'),
    ['TRIGGER']
  );
});
