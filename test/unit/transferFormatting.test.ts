import assert from 'node:assert/strict';
import test from 'node:test';
import { formatCsvCell, formatCsvRow } from '../../src/transfer/CsvExportService.js';
import { buildMysqldumpArgs, buildSqlHeader } from '../../src/transfer/SqlExportService.js';
import type { MysqldumpTool } from '../../src/transfer/types.js';

const tool: MysqldumpTool = {
  path: '/usr/local/bin/mysqldump',
  vendor: 'mysql',
  version: '8.4.11',
  major: 8,
  rawVersion: 'mysqldump Ver 8.4.11'
};

test('builds mysql8 database and table dumps without credentials in process args', () => {
  const database = buildMysqldumpArgs(tool, '/private/credentials/client.cnf', {
    kind: 'database',
    database: 'sales-db'
  });
  assert.equal(database[0], '--defaults-extra-file=/private/credentials/client.cnf');
  assert.equal(database.includes('--column-statistics=0'), true);
  assert.deepEqual(database.slice(-4), ['--routines', '--events', '--triggers', 'sales-db']);
  assert.equal(database.includes('--databases'), false);
  assert.equal(database.includes('--no-create-db'), true);
  assert.equal(database.includes('--skip-add-drop-table'), true);
  assert.equal(database.includes('--skip-add-locks'), true);
  assert.equal(database.some((argument) => /password/i.test(argument)), false);

  const table = buildMysqldumpArgs(tool, '/private/credentials/client.cnf', {
    kind: 'table',
    database: 'sales-db',
    table: 'orders'
  });
  assert.deepEqual(table.slice(-3), ['--triggers', 'sales-db', 'orders']);
});

test('omits MySQL-only flags when a MariaDB mysqldump is selected', () => {
  const mariaTool: MysqldumpTool = {
    path: '/usr/local/bin/mysqldump',
    vendor: 'mariadb',
    version: '11.8.8',
    major: 11,
    rawVersion: 'mariadb-dump Distrib 11.8.8-MariaDB'
  };
  const args = buildMysqldumpArgs(mariaTool, '/private/credentials/client.cnf', {
    kind: 'database',
    database: 'sales'
  });
  assert.equal(args.includes('--set-gtid-purged=OFF'), false);
  assert.equal(args.includes('--column-statistics=0'), false);
});

test('rejects option-like object names before spawning mysqldump', () => {
  assert.throws(
    () => buildMysqldumpArgs(tool, '/credentials', { kind: 'database', database: '--help' }),
    /不能安全/
  );
});

test('writes a parseable SQL export header without raw metadata injection', () => {
  const header = buildSqlHeader({ database: 'line\nbreak', formatVersion: 1 });
  assert.match(header, /^-- Rinda MySQL SQL Export\n/);
  assert.match(header, /-- rinda-format-version: 2\n/);
  assert.equal(header.includes('line\nbreak'), false);
  const encoded = /rinda-metadata-base64url: ([A-Za-z0-9_-]+)/.exec(header)?.[1];
  assert.ok(encoded);
  assert.deepEqual(JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')), {
    database: 'line\nbreak',
    formatVersion: 1
  });
});

test('formats RFC 4180 CSV with NULL, Unicode, BLOB and formula protection', () => {
  const fields = [
    { name: 'text', columnType: 253 },
    { name: 'decimal', columnType: 246 },
    { name: 'nullable', columnType: 253 },
    { name: 'blob', columnType: 252 }
  ];
  assert.equal(
    formatCsvRow(['=SUM(1,2)', '-12345678901234567890.00', null, Buffer.from([0xde, 0xad])], fields),
    '"\'=SUM(1,2)",-12345678901234567890.00,NULL,base64:3q0=\r\n'
  );
  assert.equal(formatCsvCell('a,"b"\n东京', { name: 'text', columnType: 253 }), '"a,""b""\n东京"');
  assert.equal(formatCsvCell('-12.50', { name: 'amount', columnType: 246 }), '-12.50');
  assert.equal(formatCsvCell('@command', { name: 'text', columnType: 253 }), "'@command");
});
