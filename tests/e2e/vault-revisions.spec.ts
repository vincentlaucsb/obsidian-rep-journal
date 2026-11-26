import { expect } from '@playwright/test';
import { readFile, stat, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readImportVault } from '../../scripts/import-vault.ts';
import { toCsv } from '../../src/exports.ts';
import { changeWorkout, createWorkout, localDate, makeId, type WorkoutSet } from '../../src/model.ts';
import { exerciseId, exerciseName, test } from './obsidian.ts';

declare global {
  interface Window {
    updateJournalFilesFromDisk(): Promise<void>;
  }
}

test('rediscovers and opens a plan edited with its previous timestamp', async ({ obsidian: { page } }) => {
  const path = 'Templates/Strength.md';
  const title = 'Quiet practice';
  const previous = `# ${title}\n\n## Main\n\n### ${exerciseName.replace('Bench', 'Pinch')}\n5 slow reps\n`;
  const updated = `# ${title}\n\n## Main\n\n### ${exerciseName}\n7 slow reps\n`;
  expect(updated).toHaveLength(previous.length);
  await page.evaluate(async ({ path, previous }) => {
    const { vault } = window.app;
    await vault.createFolder('Templates');
    await vault.create(path, previous);
  }, { path, previous });

  const journal = page.locator('.rep-journal-modern');
  await page.getByLabel('Open workout log', { exact: true }).click();
  await journal.getByRole('button', { name: 'Follow a plan', exact: true }).click();
  await expect(journal.getByText('No Markdown workout plans found.', { exact: true })).toBeVisible();
  await journal.getByRole('button', { name: '← Workout log', exact: true }).click();
  await page.evaluate(async ({ path, updated }) => {
    const { vault } = window.app;
    const file = vault.getFileByPath(path);
    if (!file) throw new Error('Expected the fixture plan note.');
    const { mtime } = file.stat;
    await vault.modify(file, updated, { mtime });
    if (file.stat.mtime !== mtime) throw new Error('The fixture did not keep the original timestamp.');
  }, { path, updated });

  await journal.getByRole('button', { name: 'Follow a plan', exact: true }).click();
  await journal.getByRole('button', { name: new RegExp(title) }).click();
  await expect(journal.getByRole('heading', { name: title, exact: true })).toBeVisible();
  await expect(journal.getByText('7 slow reps', { exact: true })).toBeVisible();
});

test('automatic CSV includes timestamp-preserved external edits made during a workout save', async ({ obsidian: { page, vault } }) => {
  const folder = 'Rep Journal/Workouts';
  const exercisePath = `Rep Journal/Exercises/${exerciseName}.md`;
  const renamedExercise = exerciseName.replace('Press', 'Raise');
  const day = localDate();
  const historicalDay = '2000-01-01';
  const set: WorkoutSet = { id: makeId(), exerciseId, exerciseName, reps: 8,
    load: { mode: 'weight', value: 135, unit: 'lb' }, warmup: false };
  const historical = changeWorkout(createWorkout(historicalDay), { kind: 'add', set });
  const current = changeWorkout(createWorkout(day), { kind: 'add', set: { ...set, id: makeId(), reps: 4 } });
  const historicalPath = `${folder}/${historicalDay}.json`;
  const currentPath = `${folder}/${day}.json`;
  const mtime = Date.UTC(2024, 0, 1);
  await page.evaluate(async ({ folder, historicalPath, currentPath, exercisePath, historical, current, mtime }) => {
    const { vault } = window.app;
    await vault.createFolder(folder);
    const old = await vault.create(historicalPath, JSON.stringify(historical, null, 2) + '\n', { mtime });
    await vault.create(currentPath, JSON.stringify(current, null, 2) + '\n');
    const exercise = vault.getFileByPath(exercisePath);
    if (!exercise || vault.getFileByPath(historicalPath) !== old) throw new Error('Expected indexed fixture records.');
    await vault.modify(exercise, await vault.cachedRead(exercise), { mtime });
    await vault.cachedRead(old);
    await vault.cachedRead(exercise);

    const process = vault.process.bind(vault);
    vault.process = async (file, transform, options) => {
      if (file.path === currentPath) await window.updateJournalFilesFromDisk();
      return process(file, transform, options);
    };
  }, { folder, historicalPath, currentPath, exercisePath, historical, current, mtime });

  async function replaceWithoutChangingMtime(path: string, previous: string, replacement: string) {
    const target = join(vault, path);
    const before = await stat(target, { bigint: true });
    const text = await readFile(target, 'utf8');
    const updated = text.replace(previous, replacement);
    expect(updated).not.toBe(text);
    expect(updated).toHaveLength(text.length);
    await writeFile(target, updated);
    await utimes(target, Number(before.atimeMs) / 1000, mtime / 1000);
    const after = await stat(target, { bigint: true });
    expect(after.mtimeNs).toBe(before.mtimeNs);
    expect(after.size).toBe(before.size);
  }

  await page.exposeFunction('updateJournalFilesFromDisk', async () => {
    await replaceWithoutChangingMtime(historicalPath, '"reps": 8', '"reps": 9');
    await replaceWithoutChangingMtime(exercisePath, exerciseName, renamedExercise);
  });
  const journal = page.locator('.rep-journal-modern');
  await page.getByLabel('Open workout log', { exact: true }).click();
  await journal.getByRole('button', { name: `Edit set 1 for ${exerciseName}`, exact: true }).click();
  await journal.getByLabel('Reps', { exact: true }).fill('5');
  await journal.getByRole('button', { name: 'Save set', exact: true }).click();
  const csvPath = join(vault, 'Rep Journal/Exports/rep-journal.csv');
  const csv = () => readFile(csvPath, 'utf8').catch(() => '');
  await expect.poll(csv).toContain(`"${renamedExercise}",9,"weight"`);
  expect(await csv()).toContain(`"${renamedExercise}",5,"weight"`);
  expect(await csv()).toBe(toCsv((await readImportVault(vault)).data));
});
