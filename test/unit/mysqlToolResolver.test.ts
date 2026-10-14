import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MysqlClientResolver,
  MySqlToolResolver,
  buildMysqlClientCandidates,
  buildMysqldumpCandidates,
  parseMysqlClientVersion,
  parseMysqldumpVersion
} from '../../src/transfer/MySqlToolResolver.js';

test('parses supported MySQL and MariaDB mysqldump versions', () => {
  assert.deepEqual(
    parseMysqldumpVersion('/usr/bin/mysqldump', 'mysqldump  Ver 8.4.11 for macos15.4 on arm64'),
    {
      path: '/usr/bin/mysqldump',
      vendor: 'mysql',
      version: '8.4.11',
      major: 8,
      rawVersion: 'mysqldump  Ver 8.4.11 for macos15.4 on arm64'
    }
  );
  assert.equal(
    parseMysqldumpVersion('mariadb-dump', 'mariadb-dump  Ver 10.19 Distrib 11.8.8-MariaDB').vendor,
    'mariadb'
  );
  assert.throws(
    () => parseMysqldumpVersion('old', 'mysqldump  Ver 5.6.51'),
    /过旧/
  );
});

test('resolves mysqldump with shell-free version probe arguments', async () => {
  const calls: Array<{ executable: string; args: readonly string[] }> = [];
  const resolver = new MySqlToolResolver('mysqldump-custom', async (executable, args) => {
    calls.push({ executable, args });
    return { stdout: 'mysqldump  Ver 8.0.42 for Linux on x86_64', stderr: '', code: 0 };
  });
  const result = await resolver.resolve();
  assert.equal(result.path, 'mysqldump-custom');
  assert.deepEqual(calls, [{ executable: 'mysqldump-custom', args: ['--version'] }]);
});

test('candidate list is deduplicated and includes PATH entries', () => {
  const candidates = buildMysqldumpCandidates('linux', '/one:/two:/one');
  assert.deepEqual(candidates, ['mysqldump', '/one/mysqldump', '/two/mysqldump']);
});

test('parses and resolves mysql clients with a shell-free version probe', async () => {
  assert.equal(
    parseMysqlClientVersion('/usr/bin/mysql', 'mysql  Ver 8.4.11 for Linux on x86_64').version,
    '8.4.11'
  );
  assert.equal(
    parseMysqlClientVersion('mariadb', 'mysql from 11.8.8-MariaDB, client 15.2').vendor,
    'mariadb'
  );
  const calls: Array<{ executable: string; args: readonly string[] }> = [];
  const resolver = new MysqlClientResolver('mysql-custom', async (executable, args) => {
    calls.push({ executable, args });
    return { stdout: 'mysql  Ver 8.0.42 for Linux on x86_64', stderr: '', code: 0 };
  });
  assert.equal((await resolver.resolve()).path, 'mysql-custom');
  assert.deepEqual(calls, [{ executable: 'mysql-custom', args: ['--version'] }]);
  assert.deepEqual(buildMysqlClientCandidates('linux', '/one:/two:/one'), [
    'mysql', '/one/mysql', '/two/mysql'
  ]);
});
