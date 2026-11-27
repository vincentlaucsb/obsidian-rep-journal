import { expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { changeWorkout, createWorkout, exerciseFrontmatter, localDate, makeId, parseWorkout } from '../../src/model.ts';
import { startStandalone } from '../../scripts/standalone-server.ts';
import { journalSettingsFile } from '../../src/journal-paths.ts';
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
  await journal.getByRole('button', { name: 'Log set', exact: true }).click();
  await expect(journal.locator('.session-reference').first().getByRole('listitem').last()).toContainText('4.25 mi');
  await journal.getByRole('button', { name: '← Workout log', exact: true }).click();
  await expect(journal.getByText('4.25 mi', { exact: true })).toBeVisible();
  const [, logged] = parseWorkout(await readFile(join(vault, path), 'utf8')).sets;
  expect(logged.distance).toEqual({ value: 4.251, unit: 'mi' });
  expect(logged).not.toHaveProperty('elevationGain');
});


test('shares the journal system across hosts and clears an exercise override', async ({ obsidian: { page, vault } }) => {
  const exerciseId = makeId();
  const exerciseName = 'Fixture Ride';
  const properties = exerciseFrontmatter({
    id: exerciseId, name: exerciseName, aliases: [], equipment: '', archived: false,
    loadMode: 'weight', unit: 'lb', measurements: ['weight', 'distance', 'elevationGain'], distanceUnit: 'm',
  });
  const date = localDate();
  const ride = changeWorkout(createWorkout(date), { kind: 'add', set: {
    id: makeId(), exerciseId, exerciseName, warmup: false, load: { mode: 'weight', value: 80.123, unit: 'lb' },
    distance: { value: 1.23456, unit: 'mi' }, elevationGain: { value: 41.234, unit: 'ft' },
  } });
  const path = `Rep Journal/Workouts/${date}.json`;
  const original = JSON.stringify(ride);
  await page.evaluate(async ({ exerciseName, frontmatter, path, original }) => {
    const { vault } = window.app;
    await vault.create(`Rep Journal/Exercises/${exerciseName}.md`, `---
${frontmatter}---
`);
    await vault.createFolder('Rep Journal/Workouts');
    await vault.adapter.write(path, original);
  }, { exerciseName, frontmatter: stringify(properties), path, original });

  await page.getByLabel('Open workout log', { exact: true }).click();
  const journal = page.locator('.rep-journal-modern');
  await expect(journal.getByText('41 ft elevation gain', { exact: true })).toBeVisible();
  const settingsButton = page.locator('.clickable-icon:has(.lucide-settings)').filter({ visible: true });
  const [settings] = await Promise.all([page.context().waitForEvent('page'), settingsButton.click()]);
  await settings.getByText('Rep Journal', { exact: true }).click();
  await settings.getByLabel('Measurement system', { exact: true }).selectOption('metric');
  await expect.poll(async () => JSON.parse(await readFile(join(vault, journalSettingsFile), 'utf8').catch(() => '{}')) as unknown)
    .toEqual({ measurementSystem: 'metric' });
  await settings.close();
  await expect(journal.getByText('36.34 kg', { exact: true })).toBeVisible();
  await expect(journal.getByText('13 m elevation gain', { exact: true })).toBeVisible();
  await expect(journal.getByText('1986.83 m', { exact: true })).toBeVisible();
  expect(await readFile(join(vault, path), 'utf8')).toBe(original);

  await journal.getByRole('button', { name: `Log another set for ${exerciseName}`, exact: true }).click();
  const kg = journal.getByLabel('Weight (kg)', { exact: true });
  await kg.fill('2.01');
  await journal.getByLabel('Distance (m)', { exact: true }).fill('100');
  const addKg = journal.getByRole('button', { name: 'Add 22.5 kg', exact: true });
  await addKg.click();
  await expect(kg).toHaveValue('24.51');
  await addKg.click();
  await expect(kg).toHaveValue('47.01');
  await journal.getByRole('button', { name: '← Workout log', exact: true }).click();
  expect(await readFile(join(vault, path), 'utf8')).toBe(original);

  const { server, origin } = await startStandalone(vault, 0);
  try {
    const response = await page.request.get(`${origin}/api/journal`);
    expect(await response.json() as unknown).toMatchObject({ measurementSystem: 'metric', unit: 'kg' });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => { if (error) reject(error); else resolve(); }));
  }

  await journal.getByRole('button', { name: 'Exercises', exact: true }).click();
  await journal.getByRole('button', { name: exerciseName, exact: true }).click();
  await expect(journal.getByRole('combobox', { name: 'Distance unit', exact: true })).toHaveValue('m');
  await journal.getByRole('combobox', { name: 'Distance unit', exact: true }).selectOption({ label: 'Use journal default' });
  await journal.getByRole('combobox', { name: 'Weight unit', exact: true }).selectOption('lb');
  await journal.getByRole('button', { name: 'Save exercise', exact: true }).click();
  await expect(journal.getByRole('heading', { name: 'Edit exercise', exact: true })).toBeHidden();
  const note = await readFile(join(vault, 'Rep Journal', 'Exercises', `${exerciseName}.md`), 'utf8');
  expect(note).not.toContain('distance_unit:');
  expect(note).toContain('weight_unit_override: lb');
  await journal.getByRole('button', { name: '← Workout log', exact: true }).click();
  await expect(journal.getByText('1.99 km', { exact: true })).toBeVisible();
  await expect(journal.getByText('80.123 lb', { exact: true })).toBeVisible();
  await journal.getByRole('button', { name: `Log another set for ${exerciseName}`, exact: true }).click();
  await expect(journal.getByLabel('Distance (km)', { exact: true })).toBeVisible();
  await expect(journal.getByLabel('Elevation gain (m)', { exact: true })).toBeVisible();
  await journal.getByRole('button', { name: 'Add 45 lb', exact: true }).click();
  await expect(journal.getByLabel('Weight (lb)', { exact: true })).toHaveValue('125.123');
});
