import { expect } from '@playwright/test';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { parseWorkout } from '../../src/model.ts';
import { exerciseId, exerciseName, test } from './obsidian.ts';

test('logs a weighted set and restores it from the vault', async ({ obsidian: { page, vault } }) => {
  const ribbon = page.getByLabel('Open workout log', { exact: true });
  const journal = page.locator('.rep-journal-modern');
  await ribbon.click();
  await expect(journal.getByText('No sets logged for this session.', { exact: true })).toBeVisible();
  await journal.getByRole('button', { name: '+ Log set', exact: true }).click();
  await journal.getByRole('searchbox', { name: 'Search exercises' }).fill(exerciseName);
  await journal.getByRole('button', { name: exerciseName, exact: true }).click();
  await journal.getByLabel('Weight (lb)', { exact: true }).fill('135');
  await journal.getByLabel('Reps', { exact: true }).fill('5');
  await journal.getByRole('button', { name: 'Log set →', exact: true }).click();

  const editSet = journal.getByRole('button', { name: `Edit set 1 for ${exerciseName}`, exact: true });
  await expect(editSet).toBeVisible();
  const workouts = join(vault, 'Rep Journal', 'Workouts');
  const files = await readdir(workouts);
  expect(files).toHaveLength(1);
  const workout = parseWorkout(await readFile(join(workouts, files[0]), 'utf8'));
  expect(workout.sets).toHaveLength(1);
  expect(workout.sets[0]).toMatchObject({
    exerciseId, exerciseName, load: { mode: 'weight', value: 135, unit: 'lb' }, reps: 5,
  });

  await page.reload();
  await ribbon.click();
  await editSet.click();
  await expect(journal.getByRole('heading', { name: 'Edit set', exact: true })).toBeVisible();
  await expect(journal.getByLabel('Weight (lb)', { exact: true })).toHaveValue('135');
  await expect(journal.getByLabel('Reps', { exact: true })).toHaveValue('5');
});
