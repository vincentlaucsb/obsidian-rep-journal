import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { writeDesktopJournalSettings } from '../src/desktop-journal-settings.ts';
import { journalSettingsFile } from '../src/journal-paths.ts';
import { makeId } from '../src/model.ts';

void test('desktop settings retry a sharing error and merge edits made before retry', async (context) => {
  const parent = resolve(tmpdir());
  const root = await fs.mkdtemp(join(parent, 'rep-journal-settings-'));
  context.after(async () => {
    assert.equal(dirname(resolve(root)), parent);
    assert.match(basename(root), /^rep-journal-settings-/);
    await fs.rm(root, { recursive: true, force: true });
  });
  const path = join(root, journalSettingsFile);
  await fs.writeFile(path, JSON.stringify({ journalFolder: 'Original folder' }));

  let renameAttempts = 0;
  const delays: number[] = [];
  const wait = (delay: number) => { delays.push(delay); return Promise.resolve(); };
  const sharingError = Object.assign(new Error('File is open in another process'), { code: 'EPERM' });
  await writeDesktopJournalSettings({
    ...fs,
    async rename(source, destination) {
      renameAttempts++;
      if (renameAttempts === 1) {
        await fs.writeFile(path, JSON.stringify({ journalFolder: 'Updated folder' }));
        throw sharingError;
      }
      if (renameAttempts === 2) throw sharingError;
      return fs.rename(source, destination);
    },
  }, path, { measurementSystem: 'metric' }, makeId(), wait);

  assert.equal(renameAttempts, 3);
  assert.deepEqual(delays, [20, 40]);
  const saved = await fs.readFile(path, 'utf8');
  assert.deepEqual(JSON.parse(saved), { journalFolder: 'Updated folder', measurementSystem: 'metric' });
  assert.deepEqual(await fs.readdir(root), [journalSettingsFile]);

  const permanentError = Object.assign(new Error('Device is full'), { code: 'ENOSPC' });
  await assert.rejects(writeDesktopJournalSettings({
    ...fs,
    rename() { return Promise.reject(permanentError); },
  }, path, { measurementSystem: 'imperial' }, makeId(), wait), (error) => error === permanentError);
  assert.deepEqual(delays, [20, 40]);
  delays.length = 0;
  await assert.rejects(writeDesktopJournalSettings({
    ...fs,
    rename() { return Promise.reject(sharingError); },
  }, path, { measurementSystem: 'imperial' }, makeId(), wait), (error) => error === sharingError);
  assert.deepEqual(delays, [20, 40, 80, 160, 320, 640, 800]);
  assert.equal(await fs.readFile(path, 'utf8'), saved);
  assert.deepEqual(await fs.readdir(root), [journalSettingsFile]);
});
