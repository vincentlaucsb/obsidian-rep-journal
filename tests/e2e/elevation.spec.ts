import { expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { changeWorkout, createWorkout, exerciseFrontmatter, localDate, makeId, parseWorkout } from '../../src/model.ts';
import { test } from './obsidian.ts';

test('displays preferred cardio units and edits recorded values in their original units', async ({ obsidian: { page, vault } }) => {
  const exerciseId = makeId();
  const exerciseName = 'Mountain Biking';
  const properties = exerciseFrontmatter({
    id: exerciseId, name: exerciseName, aliases: ['MTB'], equipment: '', archived: false,
    loadMode: 'bodyweight', unit: 'lb', measurements: ['time', 'distance', 'elevationGain'], distanceUnit: 'mi', elevationUnit: 'ft',
  });
  const date = localDate();
  const ride = changeWorkout(createWorkout(date), { kind: 'add', set: {
    id: makeId(), exerciseId, exerciseName, warmup: false, durationSeconds: 1234,
    distance: { value: 2167.876, unit: 'm' }, elevationGain: { value: 123.456, unit: 'm' },
  } });
  const path = `Rep Journal/Workouts/${date}.json`;
  await page.evaluate(async ({ exerciseName, frontmatter, path, ride }) => {
    const { vault } = window.app;
    await vault.create(`Rep Journal/Exercises/${exerciseName}.md`, `---\n${frontmatter}---\n`);
    await vault.createFolder('Rep Journal/Workouts');
    await vault.adapter.write(path, JSON.stringify(ride));
  }, { exerciseName, frontmatter: stringify(properties), path, ride });

  await page.getByLabel('Open workout log', { exact: true }).click();
  const journal = page.locator('.rep-journal-modern');
  await expect(journal.getByText('1.35 mi', { exact: true })).toBeVisible();
  await expect(journal.getByText('405 ft elevation gain', { exact: true })).toBeVisible();
  await journal.getByRole('button', { name: 'View progress for Mountain Biking', exact: true }).click();
  await expect(journal.getByText(/1\.35 mi · 405 ft elevation gain/)).toBeVisible();
  await journal.getByRole('button', { name: 'Back to workout', exact: true }).click();
  await journal.getByRole('button', { name: 'Edit set 1 for Mountain Biking', exact: true }).click();
  await expect(journal.getByLabel('Distance (m)', { exact: true })).toHaveValue('2167.876');
  const originalElevation = journal.getByLabel('Elevation gain (m)', { exact: true });
  await expect(originalElevation).toHaveValue('123.456');
  await originalElevation.fill('0');
  await journal.getByRole('button', { name: 'Save set', exact: true }).click();
  await expect(journal.getByText('0 ft elevation gain', { exact: true })).toBeVisible();
  const [updated] = parseWorkout(await readFile(join(vault, path), 'utf8')).sets;
  expect(updated.distance).toEqual(ride.sets[0].distance);
  expect(updated.elevationGain).toEqual({ value: 0, unit: 'm' });

  await journal.getByRole('button', { name: 'Log another set for Mountain Biking', exact: true }).click();
  await journal.getByLabel('Time (seconds or mm:ss)', { exact: true }).fill('20:00');
  await journal.getByLabel('Distance (mi)', { exact: true }).fill('4.251');
  await expect(journal.getByLabel('Elevation gain (ft)', { exact: true })).toHaveValue('');
  await journal.getByRole('button', { name: 'Log set →', exact: true }).click();
  await expect(journal.getByText('4.25 mi', { exact: true })).toBeVisible();
  const [, logged] = parseWorkout(await readFile(join(vault, path), 'utf8')).sets;
  expect(logged.distance).toEqual({ value: 4.251, unit: 'mi' });
  expect(logged).not.toHaveProperty('elevationGain');
});
