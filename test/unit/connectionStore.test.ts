import assert from 'node:assert/strict';
import test from 'node:test';
import type * as vscode from 'vscode';
import { ConnectionStore } from '../../src/connection/ConnectionStore.js';

class MemoryMemento {
  private readonly values = new Map<string, unknown>();
  public keys(): readonly string[] { return [...this.values.keys()]; }
  public get<T>(key: string, fallback?: T): T | undefined {
    return (this.values.get(key) as T | undefined) ?? fallback;
  }
  public update(key: string, value: unknown): Thenable<void> {
    this.values.set(key, value);
    return Promise.resolve();
  }
}

class MemorySecrets {
  public readonly values = new Map<string, string>();
  public get(key: string): Thenable<string | undefined> { return Promise.resolve(this.values.get(key)); }
  public store(key: string, value: string): Thenable<void> { this.values.set(key, value); return Promise.resolve(); }
  public delete(key: string): Thenable<void> { this.values.delete(key); return Promise.resolve(); }
  public onDidChange = (() => ({ dispose() {} })) as vscode.Event<vscode.SecretStorageChangeEvent>;
}

test('stores passwords separately from connection profiles', async () => {
  const state = new MemoryMemento();
  const secrets = new MemorySecrets();
  const store = new ConnectionStore(state as vscode.Memento, secrets as vscode.SecretStorage);
  const profile = await store.create({
    name: 'Local', host: '127.0.0.1', port: 3306, user: 'root', password: 'super-secret', ssl: false
  });

  assert.equal('password' in profile, false);
  assert.equal(await store.getPassword(profile.id), 'super-secret');
  assert.equal(JSON.stringify(store.list()).includes('super-secret'), false);
  assert.equal(store.list()[0]?.name, 'Local');
});

test('preserves an existing password when an edit leaves it blank', async () => {
  const store = new ConnectionStore(new MemoryMemento() as vscode.Memento, new MemorySecrets() as vscode.SecretStorage);
  const profile = await store.create({
    name: 'Before', host: 'db.local', port: 3306, user: 'app', password: 'keep-me', ssl: false
  });
  await store.update(profile.id, {
    name: 'After', host: 'db.local', port: 3307, user: 'app', password: undefined, ssl: true
  });
  assert.equal(await store.getPassword(profile.id), 'keep-me');
  assert.equal(store.getRequired(profile.id).port, 3307);
});
