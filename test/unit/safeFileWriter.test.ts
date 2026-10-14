import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { SafeFileWriter } from '../../src/transfer/SafeFileWriter.js';

test('atomically commits a complete file and removes temporary artifacts', async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'rinda-safe-writer-'));
  try {
    const target = join(root, 'export.sql');
    const writer = await SafeFileWriter.create(target, false);
    await writer.write('first\n');
    await writer.write('second\n');
    await writer.commit();
    assert.equal(await readFile(target, 'utf8'), 'first\nsecond\n');
    assert.deepEqual(await readdir(root), ['export.sql']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('aborts without leaving a partial result and rejects symlink targets', async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'rinda-safe-writer-'));
  try {
    const target = join(root, 'export.csv');
    const writer = await SafeFileWriter.create(target, false);
    await writer.write('partial');
    await writer.abort();
    assert.deepEqual(await readdir(root), []);

    const realTarget = join(root, 'real.csv');
    const linkedTarget = join(root, 'linked.csv');
    await writeFile(realTarget, 'safe');
    await symlink(realTarget, linkedTarget);
    await assert.rejects(SafeFileWriter.create(linkedTarget, true), /符号链接/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('requires explicit overwrite approval', async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'rinda-safe-writer-'));
  try {
    const target = join(root, 'existing.sql');
    await writeFile(target, 'old');
    await assert.rejects(SafeFileWriter.create(target, false), /明确确认覆盖/);
    const writer = await SafeFileWriter.create(target, true);
    await writer.write('new');
    await writer.commit();
    assert.equal(await readFile(target, 'utf8'), 'new');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('refuses to replace a target that changed after overwrite confirmation', async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'rinda-safe-writer-'));
  try {
    const target = join(root, 'changing.sql');
    await writeFile(target, 'old');
    const writer = await SafeFileWriter.create(target, true);
    await writer.write('replacement');
    await writeFile(target, 'changed after confirmation');
    await assert.rejects(writer.commit(), /确认后发生变化/);
    await writer.abort();
    assert.equal(await readFile(target, 'utf8'), 'changed after confirmation');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
