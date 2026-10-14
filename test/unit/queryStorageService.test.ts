import test from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { QueryStorageService } from '../../src/query/QueryStorageService.js';
import type { ConnectionProfile } from '../../src/connection/types.js';

test('QueryStorageService: creates user template file and query files under hidden directory', async () => {
  const tmpProjectDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'rinda-test-project-'));
  const tmpFallbackDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'rinda-test-fallback-'));
  try {
    const hiddenDir = path.join(tmpProjectDir, '.rinda');
    const service = new QueryStorageService(() => hiddenDir, tmpFallbackDir);
    const profile: ConnectionProfile = {
      id: 'conn1',
      name: 'Local DB',
      host: '127.0.0.1',
      port: 3306,
      user: 'root',
      ssl: false,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z'
    };

    // 1. Create user template
    const userPath = await service.createUserTemplateFile(profile);
    assert.ok(userPath.includes(path.join('.rinda', 'queries')));
    const userSql = await fs.promises.readFile(userPath, 'utf8');
    assert.ok(userSql.includes("CREATE USER ''@'%' IDENTIFIED BY 'password';"));
    assert.ok(userSql.includes("GRANT SELECT ON *.* TO ''@'%' WITH GRANT OPTION;"));
    assert.ok(userSql.includes("GRANT ALL PRIVILEGES ON *.* TO ''@'%' WITH GRANT OPTION;"));

    // 2. Create query file
    const queryPath = await service.createQueryFile(profile, 'migration');
    assert.ok(queryPath.includes(path.join('.rinda', 'queries')));
    const querySql = await fs.promises.readFile(queryPath, 'utf8');
    assert.ok(querySql.includes('Local DB · migration'));
    assert.ok(querySql.includes('SELECT 1;'));

    // 3. List query files
    const files = await service.listQueryFiles(profile, 'migration');
    assert.equal(files.length, 1);
    assert.equal(files[0]?.path, queryPath);

    // 4. Test fallback listing: add a legacy query in fallback root
    const legacyDir = path.join(tmpFallbackDir, 'storage', 'Local_DB@127.0.0.1@3306', 'migration');
    await fs.promises.mkdir(legacyDir, { recursive: true });
    const legacyFile = path.join(legacyDir, 'legacy_query.sql');
    await fs.promises.writeFile(legacyFile, 'SELECT * FROM legacy;', 'utf8');

    const filesWithFallback = await service.listQueryFiles(profile, 'migration');
    assert.equal(filesWithFallback.length, 2);
    assert.ok(filesWithFallback.some(f => f.name === 'legacy_query.sql'));

    // 5. Delete query file
    await service.deleteFile(queryPath);
    const filesAfter = await service.listQueryFiles(profile, 'migration');
    assert.equal(filesAfter.length, 1);
    assert.equal(filesAfter[0]?.name, 'legacy_query.sql');
  } finally {
    await fs.promises.rm(tmpProjectDir, { recursive: true, force: true });
    await fs.promises.rm(tmpFallbackDir, { recursive: true, force: true });
  }
});
