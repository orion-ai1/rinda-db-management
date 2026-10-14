import assert from 'node:assert/strict';
import test from 'node:test';
import type { ConnectionProfile } from '../../src/connection/types.js';
import { validateConnectionFormPayload } from '../../src/webview/connectionFormModel.js';

const validPayload = {
  name: ' Local ',
  host: ' 127.0.0.1 ',
  port: 3306,
  user: ' root ',
  password: '',
  database: ' app ',
  ssl: false
};

test('validates and normalizes a complete new connection form', () => {
  const validation = validateConnectionFormPayload(validPayload);
  assert.deepEqual(validation.errors, {});
  assert.deepEqual(validation.result, {
    name: 'Local',
    host: '127.0.0.1',
    port: 3306,
    user: 'root',
    password: '',
    database: 'app',
    ssl: false
  });
});

test('keeps the saved password when an edit submits a blank password', () => {
  const current: ConnectionProfile = {
    id: 'connection-1',
    name: 'Old',
    host: 'localhost',
    port: 3306,
    user: 'root',
    ssl: false,
    createdAt: '2026-10-13T00:00:00.000Z',
    updatedAt: '2026-10-13T00:00:00.000Z'
  };
  const validation = validateConnectionFormPayload(validPayload, current);
  assert.equal(validation.result?.password, undefined);
});

test('rejects missing required fields and invalid connection settings', () => {
  const validation = validateConnectionFormPayload({
    name: ' ',
    host: '',
    port: 65_536,
    user: null,
    password: 123,
    database: [],
    ssl: 'yes'
  });
  assert.deepEqual(Object.keys(validation.errors).sort(), [
    'database',
    'host',
    'name',
    'password',
    'port',
    'ssl',
    'user'
  ]);
  assert.equal(validation.result, undefined);
});
