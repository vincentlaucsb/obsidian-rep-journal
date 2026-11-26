import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { installGarminPrompt } from '../src/garmin-prompt.ts';

void test('repair upgrades the installed prompt, restores missing copies and preserves user edits', async (t) => {
  const root = await fs.mkdtemp(join(tmpdir(), 'rep-journal-garmin-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const path = (agent: string) => join(root, agent, 'skills', 'rep-journal-garmin', 'SKILL.md');
  assert.deepEqual(await installGarminPrompt(fs, root, 'First prompt'), []);
  const original = await fs.readFile(path('.claude'), 'utf8');
  const edited = original.replace('First prompt', 'My own prompt');
  await fs.writeFile(path('.claude'), edited);
  await fs.unlink(path('.opencode'));
  const preserved = ['.claude/skills/rep-journal-garmin'];
  assert.deepEqual(await installGarminPrompt(fs, root, 'Updated prompt'), preserved);
  assert.deepEqual(await installGarminPrompt(fs, root, 'Updated prompt'), preserved);
  const updated = await fs.readFile(path('.agents'), 'utf8');
  assert.match(updated, /^Updated prompt\n/);
  assert.equal(await fs.readFile(path('.opencode'), 'utf8'), updated);
  assert.equal(await fs.readFile(path('.claude'), 'utf8'), edited);
});

void test('preserves an existing skill and a linked agent directory', async (t) => {
  const root = await fs.mkdtemp(join(tmpdir(), 'rep-journal-garmin-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const existing = join(root, '.agents', 'skills', 'rep-journal-garmin');
  const other = join(root, 'other');
  await fs.mkdir(existing, { recursive: true });
  await fs.writeFile(join(existing, 'SKILL.md'), 'My skill');
  await fs.mkdir(other);
  await fs.symlink(other, join(root, '.claude'), 'junction');
  assert.deepEqual(await installGarminPrompt(fs, root, 'Packaged prompt'), [
    '.agents/skills/rep-journal-garmin', '.claude/skills/rep-journal-garmin',
  ]);
  assert.equal(await fs.readFile(join(existing, 'SKILL.md'), 'utf8'), 'My skill');
  assert.deepEqual(await fs.readdir(other), []);
});
