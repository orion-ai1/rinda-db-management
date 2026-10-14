import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { buildSqlHeader } from '../../src/transfer/SqlExportService.js';
import { createDatabaseQualifierRewriteStream, prepareSqlPackage } from '../../src/transfer/SqlPackage.js';
import type { SqlPackageMetadata } from '../../src/transfer/types.js';

const metadata: SqlPackageMetadata = {
  formatVersion: 2,
  contentPolicy: 'rinda-controlled-restore-v1',
  exportedAt: '2026-10-14T00:00:00.000Z',
  sourceServerVersion: '8.4.11',
  scope: { kind: 'table', database: 'source_db', table: 'items' },
  characterSet: 'utf8mb4',
  objects: { tables: 1, views: 0, routines: 0, events: 0, triggers: 0 },
  restorePolicy: { standalone: true, reasons: [] },
  tool: { vendor: 'mysql', version: '8.4.11' }
};

test('validates, privately stages and cleans a Rinda v2 SQL package', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rinda-package-test-'));
  const path = join(root, 'valid.sql');
  try {
    await writeFile(path, buildPackage('CREATE TABLE `items` (`id` int);\n'));
    const prepared = await prepareSqlPackage(path);
    assert.equal(prepared.metadata.scope.kind, 'table');
    assert.equal(prepared.sha256.length, 64);
    assert.doesNotMatch(await readFile(prepared.stagedPath, 'utf8'), /rinda-export-end/);
    const stagedPath = prepared.stagedPath;
    await prepared.cleanup();
    await assert.rejects(access(stagedPath));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects tampering, legacy packages and prohibited account/database statements', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rinda-package-reject-'));
  try {
    const tampered = join(root, 'tampered.sql');
    await writeFile(tampered, `${buildPackage('CREATE TABLE `items` (`id` int);\n')} `);
    await assert.rejects(prepareSqlPackage(tampered), /尾注/);

    const legacy = join(root, 'legacy.sql');
    const legacyBody = buildSqlHeader(metadata).replace('version: 2', 'version: 1');
    await writeFile(legacy, withFooter(`${legacyBody}SELECT 1;\n`));
    await assert.rejects(prepareSqlPackage(legacy), /0\.3\.1\+.*v2/);

    for (const [name, sql] of [
      ['grant', 'GRANT ALL ON *.* TO attacker;\n'],
      ['user', "CREATE USER 'attacker'@'%';\n"],
      ['database', 'USE `other`;\n']
    ] as const) {
      const path = join(root, `${name}.sql`);
      await writeFile(path, buildPackage(sql));
      await assert.rejects(prepareSqlPackage(path), /禁止的语句/);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rewrites only executable source-database qualifiers for a cloned target', async () => {
  const input = [
    "INSERT INTO source_",
    "db.items VALUES ('source_db.items');\n",
    'CREATE VIEW `v` AS SELECT * FROM `source_db`.`items`;\n',
    '-- source_db.items stays in a comment\n'
  ];
  const stream = Readable.from(input).pipe(createDatabaseQualifierRewriteStream('source_db', 'target-db'));
  let output = '';
  for await (const chunk of stream) output += Buffer.from(chunk).toString('utf8');
  assert.match(output, /INSERT INTO `target-db`\.items/);
  assert.match(output, /FROM `target-db`\.`items`/);
  assert.match(output, /'source_db\.items'/);
  assert.match(output, /-- source_db\.items stays in a comment/);
});

function buildPackage(sql: string): string {
  return withFooter(`${buildSqlHeader(metadata)}${sql}`);
}

function withFooter(body: string): string {
  const normalized = body.endsWith('\n') ? body : `${body}\n`;
  const sha256 = createHash('sha256').update(normalized).digest('hex');
  return `${normalized}-- rinda-sha256: ${sha256}\n-- rinda-export-end\n`;
}
