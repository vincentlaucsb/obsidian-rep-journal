import { expect } from '@playwright/test';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { journalSettingsFile } from '../../src/journal-paths.ts';
import { parseWorkout } from '../../src/model.ts';
import { exerciseId, exerciseName, test } from './obsidian.ts';

test('renders plan Markdown and opens technique links relative to the plan note', async ({ obsidian: { page } }) => {
  const planFolder = 'Training';
  const source = [
    '# Technique session', '', '**Start slowly.**', '', '## Main', '', '- Pause between sets.',
    '', `### ${exerciseName}`, '',
    `See [[Rep Journal/Exercises/${exerciseName}|Exercise note]] and [[./Technique|Dead Bug technique and video]].`,
  ].join('\n');
  await page.evaluate(async ({ planFolder, source }) => {
    const { vault } = window.app;
    await vault.createFolder(planFolder);
    await vault.create('Technique.md', 'Other technique');
    await vault.create(`${planFolder}/Technique.md`, 'Local technique');
    await vault.create(`${planFolder}/Workout plan.md`, source);
  }, { planFolder, source });
  await page.getByLabel('Open workout log', { exact: true }).click();
  const journal = page.locator('.rep-journal-modern');
  await journal.getByRole('button', { name: 'Follow a plan' }).click();
  await journal.getByRole('button', { name: /Training\/Workout plan\.md/ }).click();
  await expect(journal.locator('strong').filter({ hasText: 'Start slowly.' })).toBeVisible();
  await expect(journal.getByRole('listitem').filter({ hasText: 'Pause between sets.' })).toBeVisible();
  await expect(journal.getByRole('link').filter({ hasText: 'Exercise note' })).toBeVisible();
  const technique = journal.getByRole('link').filter({ hasText: 'Dead Bug technique and video' });
  await expect(technique).toBeVisible();
  await journal.getByRole('button', { name: 'Start plan', exact: true }).click();
  await journal.getByRole('button', { name: `Start ${exerciseName}` }).click();
  await technique.click();
  await expect.poll(() => page.evaluate(() => window.app.workspace.getActiveFile()?.path)).toBe('Training/Technique.md');
});

test('keeps the active plan controls working after closing and reopening the journal', async ({ obsidian: { page } }) => {
  await page.evaluate(async ({ exerciseId, exerciseName }) => {
    const { vault } = window.app;
    const original = vault.getFileByPath(`Rep Journal/Exercises/${exerciseName}.md`);
    if (!original) throw new Error('Missing fixture exercise.');
    const row = (await vault.cachedRead(original))
      .replace(exerciseName, 'Fixture Row')
      .replace(exerciseId, '94a112a1-d823-4218-9864-269bf6baa894');
    await vault.create('Rep Journal/Exercises/Fixture Row.md', row);
    await vault.create('Training plan.md', [
      '# Upper body', '', 'Keep the first set comfortable.', '', '## Warm-up', '', 'Start easy.',
      '', '## Working sets', 'Mode: superset', '', `### ${exerciseName}`, '', 'Pause at the bottom.',
      '', '### Fixture Row', '', 'Keep your back still.',
    ].join('\n'));
  }, { exerciseId, exerciseName });

  const ribbon = page.getByLabel('Open workout log', { exact: true });
  const journal = page.locator('.rep-journal-modern');
  const viewPlan = journal.getByRole('button', { name: 'View plan', exact: true });
  const plan = journal.getByRole('heading', { name: 'Upper body', exact: true });
  const next = journal.getByRole('button', { name: 'Next section', exact: true });
  const previous = journal.getByRole('button', { name: 'Previous section', exact: true });
  await ribbon.click();
  await journal.getByRole('button', { name: 'Follow a plan', exact: true }).click();
  await journal.getByRole('button', { name: /Training plan\.md/ }).click();
  await expect(plan).toBeVisible();
  await expect(journal.getByText('Keep the first set comfortable.', { exact: true })).toBeVisible();
  await expect(journal.getByText('Superset', { exact: true })).toBeVisible();
  await journal.getByRole('button', { name: 'Start plan', exact: true }).click();
  await viewPlan.click();
  await expect(previous).toBeDisabled();
  await next.click();
  await expect(next).toBeDisabled();
  await previous.click();
  await journal.getByRole('button', { name: 'Done with Warm-up', exact: true }).click();
  const section = journal.getByRole('heading', { name: 'Working sets', exact: true });
  await expect(section).toBeFocused();
  await expect(journal.locator('[aria-current="step"]')).toContainText('Working sets');
  const row = journal.getByRole('button', { name: 'Fixture Row', exact: true });
  await row.click();
  await expect(row).toHaveAttribute('aria-pressed', 'true');
  await journal.getByRole('button', { name: 'Start Fixture Row', exact: true }).click();
  await expect(journal.getByLabel('Weight (lb)', { exact: true })).toBeFocused();
  await journal.getByLabel('Weight (lb)', { exact: true }).fill('25');
  await journal.getByLabel('Reps', { exact: true }).fill('8');
  await journal.getByRole('button', { name: 'Log set →', exact: true }).click();
  await viewPlan.click();
  await expect(journal.getByRole('button', { name: exerciseName, exact: true })).toHaveAttribute('aria-pressed', 'true');

  await page.evaluate(() => window.app.workspace.detachLeavesOfType('rep-journal-today'));
  await expect(journal).toHaveCount(0);
  await ribbon.click();
  await viewPlan.click();
  await expect(plan).toBeVisible();
  await journal.getByRole('button', { name: '← Workout log', exact: true }).click();
  await viewPlan.click();
  await expect(plan).toHaveCount(1);
  await journal.getByRole('button', { name: 'Stop plan', exact: true }).click();
  await expect(viewPlan).toHaveCount(0);
});

test('fills the pane and insets the header controls and workout content', async ({ obsidian: { page } }) => {
  await page.getByLabel('Open workout log', { exact: true }).click();
  const pane = page.locator('.rep-journal-modern-content');
  await expect(pane.locator('.session-header')).toBeVisible();

  for (const width of [960, 350]) {
    const layout = await pane.evaluate((viewContent, width) => {
      viewContent.style.width = `${width}px`;
      const paneBox = viewContent.getBoundingClientRect();
      const gap = (selector: string) => {
        const element = viewContent.querySelector(selector);
        if (!element) throw new Error(`Missing journal layout element ${selector}`);
        const box = element.getBoundingClientRect();
        return [box.left - paneBox.left, paneBox.right - box.right];
      };
      const masthead = viewContent.querySelector('.masthead');
      const session = viewContent.querySelector('.session-header');
      if (!masthead || !session) throw new Error('Missing journal headers');
      return {
        width: paneBox.width,
        outerGaps: ['.masthead', '.rj-workspace'].map(gap),
        headerInsets: [gap('.wordmark')[0], gap('.masthead nav')[1]],
        contentInsets: gap('.session-header'),
        top: masthead.getBoundingClientRect().top - paneBox.top,
        headerGap: session.getBoundingClientRect().top - masthead.getBoundingClientRect().bottom,
        overflow: viewContent.scrollWidth - viewContent.clientWidth,
      };
    }, width);
    expect(layout).toMatchObject({ width, outerGaps: [[0, 0], [0, 0]], top: 0, overflow: 0 });
    expect(layout.headerInsets).toEqual(layout.contentInsets);
    for (const inset of [...layout.contentInsets, layout.headerGap]) {
      expect(inset).toBeGreaterThanOrEqual(10);
      expect(inset).toBeLessThanOrEqual(24);
    }
  }
});

test('logs, charts, and restores a weighted set', async ({ obsidian: { page, vault } }) => {
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
  const [year] = await readdir(workouts);
  const files = await readdir(join(workouts, year));
  expect(files).toHaveLength(1);
  const workout = parseWorkout(await readFile(join(workouts, year, files[0]), 'utf8'));
  expect(year).toBe(workout.date.slice(0, 4));
  expect(workout.sets).toHaveLength(1);
  expect(workout.sets[0]).toMatchObject({
    exerciseId, exerciseName, load: { mode: 'weight', value: 135, unit: 'lb' }, reps: 5,
  });

  await journal.getByRole('button', { name: `View progress for ${exerciseName}`, exact: true }).click();
  await expect(journal.locator('.strength-chart-plot svg use.line-marker')).toHaveCount(1);
  await journal.getByRole('button', { name: 'Back to workout', exact: true }).click();
  await expect(editSet).toBeVisible();

  await page.reload();
  await ribbon.click();
  await editSet.click();
  await expect(journal.getByRole('heading', { name: 'Edit set', exact: true })).toBeVisible();
  await expect(journal.getByLabel('Weight (lb)', { exact: true })).toHaveValue('135');
  await expect(journal.getByLabel('Reps', { exact: true })).toHaveValue('5');
});

test('switches the open workout log to the configured folder and restores it on reload', async ({ obsidian: { page, vault } }) => {
  const ribbon = page.getByLabel('Open workout log', { exact: true });
  const journal = page.locator('.rep-journal-modern');
  const customRoot = 'Training/Journal';
  const customExercise = 'Fixture Cable Press';
  await writeFile(join(vault, journalSettingsFile), JSON.stringify({ fixtureProperty: 'keep' }));
  await page.evaluate(async ({ customRoot, customExercise, exerciseName }) => {
    const { vault } = window.app;
    const original = vault.getFileByPath(`Rep Journal/Exercises/${exerciseName}.md`);
    if (!original) throw new Error('Missing fixture exercise.');
    await vault.createFolder(`${customRoot}/Exercises`);
    await vault.create(`${customRoot}/Exercises/${customExercise}.md`, (await vault.cachedRead(original)).replace(exerciseName, customExercise));
  }, { customRoot, customExercise, exerciseName });

  await ribbon.click();
  await journal.getByRole('button', { name: 'Exercises', exact: true }).click();
  await expect(journal.getByRole('button', { name: exerciseName, exact: true })).toBeVisible();
  const settingsButton = page.locator('.clickable-icon:has(.lucide-settings)').filter({ visible: true });
  await expect(settingsButton).toBeVisible();
  const [settings] = await Promise.all([page.context().waitForEvent('page', { timeout: 10_000 }), settingsButton.click()]);
  const settingTab = settings.getByText('Rep Journal', { exact: true });
  await expect(settingTab).toBeVisible();
  await settingTab.click();
  await expect(settings.getByRole('textbox', { name: 'Journal folder' })).toHaveValue('Rep Journal');
  await settings.getByRole('textbox', { name: 'Journal folder' }).fill(customRoot);
  await settings.getByRole('button', { name: 'Save folder' }).click();
  await expect.poll(async () => {
    const config: unknown = JSON.parse(await readFile(join(vault, journalSettingsFile), 'utf8'));
    return config;
  }).toEqual({
    fixtureProperty: 'keep', journalFolder: customRoot,
  });
  await expect(settings.getByRole('button', { name: 'Save folder' })).toBeEnabled();
  expect((await readdir(vault)).filter((name) => name.startsWith(journalSettingsFile))).toEqual([journalSettingsFile]);
  await settings.close();
  await journal.getByRole('button', { name: 'Exercises', exact: true }).click();
  await expect(journal.getByRole('button', { name: customExercise, exact: true })).toBeVisible();
  await expect(journal.getByRole('button', { name: exerciseName, exact: true })).toHaveCount(0);

  await page.reload();
  await ribbon.click();
  await journal.getByRole('button', { name: 'Exercises', exact: true }).click();
  await expect(journal.getByRole('button', { name: customExercise, exact: true })).toBeVisible();
});

test('refreshes exercise notes in place and preserves the exercise editor', async ({ obsidian: { page } }) => {
  const journal = page.locator('.rep-journal-modern');
  await page.getByLabel('Open workout log', { exact: true }).click();
  await journal.getByRole('button', { name: 'Exercises', exact: true }).click();
  const search = journal.getByRole('searchbox', { name: 'Search exercises' });
  await search.fill('Fixture');

  const originalPath = `Rep Journal/Exercises/${exerciseName}.md`;
  const addedPath = 'Rep Journal/Exercises/Fixture Row.md';
  const addedName = 'Fixture Row';
  const changedName = 'Fixture Cable Row';
  const added = journal.getByRole('button', { name: addedName, exact: true });
  await page.evaluate(async ({ originalPath, addedPath, addedName, exerciseId, exerciseName }) => {
    const { vault } = window.app;
    const original = vault.getFileByPath(originalPath);
    if (!original) throw new Error('Missing fixture exercise.');
    const markdown = await vault.cachedRead(original);
    await vault.create(addedPath, markdown.replace(exerciseName, addedName).replace(exerciseId, 'cb1c8fa0-b62c-4d12-b1b4-896454cafd80'));
  }, { originalPath, addedPath, addedName, exerciseId, exerciseName });
  await expect(added).toBeVisible();
  await expect(search).toHaveValue('Fixture');
  await expect(search).toBeFocused();

  await journal.getByRole('button', { name: exerciseName, exact: true }).click();
  const name = journal.getByRole('textbox', { name: 'Display name' });
  await name.fill('Unsaved exercise draft');
  await page.evaluate(async ({ addedPath, addedName, changedName }) => {
    const { vault } = window.app;
    const file = vault.getFileByPath(addedPath);
    if (!file) throw new Error('Missing added exercise.');
    await vault.process(file, (markdown) => markdown.replace(addedName, changedName));
  }, { addedPath, addedName, changedName });
  await expect(name).toHaveValue('Unsaved exercise draft');
  await expect(name).toBeFocused();
  await journal.getByRole('button', { name: '← Exercises', exact: true }).click();
  const changed = journal.getByRole('button', { name: changedName, exact: true });
  await expect(changed).toBeVisible();
  await expect(search).toHaveValue('Fixture');

  await page.evaluate(async (addedPath) => {
    const file = window.app.vault.getFileByPath(addedPath);
    if (!file) throw new Error('Missing added exercise.');
    await window.app.fileManager.renameFile(file, 'Moved Fixture Row.md');
  }, addedPath);
  await expect(changed).toHaveCount(0);
  await page.evaluate(async (addedPath) => {
    const file = window.app.vault.getFileByPath('Moved Fixture Row.md');
    if (!file) throw new Error('Missing moved exercise.');
    await window.app.fileManager.renameFile(file, addedPath);
  }, addedPath);
  await expect(changed).toBeVisible();
  await page.evaluate(async (addedPath) => {
    const file = window.app.vault.getFileByPath(addedPath);
    if (!file) throw new Error('Missing restored exercise.');
    await window.app.fileManager.trashFile(file);
  }, addedPath);
  await expect(changed).toHaveCount(0);
});
