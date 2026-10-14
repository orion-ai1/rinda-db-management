import assert from 'node:assert/strict';
import { access, readFile, stat } from 'node:fs/promises';
import test from 'node:test';
import type { ConnectionProfile } from '../../src/connection/types.js';
import { createCredentialFile, quoteOptionValue } from '../../src/transfer/CredentialFile.js';

const profile: ConnectionProfile = {
  id: 'local',
  name: 'Local',
  host: '127.0.0.1',
  port: 3306,
  user: 'tester',
  ssl: true,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z'
};

test('creates a private option file, safely quotes secrets and cleans it', async () => {
  const password = 'p\\ass"word\nnext';
  const credential = await createCredentialFile(profile, password);
  const contents = await readFile(credential.path, 'utf8');
  assert.match(contents, /\[client\]/);
  assert.match(contents, /host="127\.0\.0\.1"/);
  assert.match(contents, /password="p\\\\ass\\"word\\nnext"/);
  assert.match(contents, /ssl-mode=VERIFY_IDENTITY/);
  if (process.platform !== 'win32') {
    assert.equal((await stat(credential.path)).mode & 0o077, 0);
  }
  await credential.cleanup();
  await assert.rejects(access(credential.path));
});

test('quotes option-file control characters without adding lines', () => {
  assert.equal(quoteOptionValue('a\r\nb"c\\d'), '"a\\r\\nb\\"c\\\\d"');
});

test('uses MariaDB-compatible TLS option names when needed', async () => {
  const credential = await createCredentialFile(profile, 'secret', 'mariadb');
  try {
    const contents = await readFile(credential.path, 'utf8');
    assert.match(contents, /ssl=1/);
    assert.match(contents, /ssl-verify-server-cert=1/);
    assert.doesNotMatch(contents, /ssl-mode=/);
  } finally {
    await credential.cleanup();
  }
});
