import { expect, type Page } from '@playwright/test';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { mock } from 'node:test';
import { startStandalone } from '../../scripts/standalone-server.ts';
import { createWorkout, parseWorkout } from '../../src/model.ts';
import { exerciseId, exerciseName, test } from './obsidian.ts';

const originalDay = '2026-11-22';
const reuseDay = '2026-11-25';
const today = new Date(2026, 10, 28, 12);
const primaryTitle = 'Dated strength';
const secondaryTitle = 'Dated accessories';
const manualTitle = 'Ordinary strength';
const rowName = 'Fixture Row';
const workoutsFolder = 'Rep Journal/Workouts/2026';
const originalFile = `${originalDay}.json`;
const secondFile = `${originalDay}-2.json`;

async function seed(page: Page) {
  const originalSession = createWorkout(originalDay);
  const secondSession = createWorkout(originalDay);
  await page.evaluate(async ({ folders, files, exerciseName, exerciseId, rowName }) => {
    const { vault } = window.app;
    for (const folder of folders) await vault.createFolder(folder);
    for (const [path, contents] of files) await vault.create(path, contents);
    const original = vault.getFileByPath(`Rep Journal/Exercises/${exerciseName}.md`);
    if (!original) throw new Error('Missing fixture exercise');
    const row = (await vault.cachedRead(original))
      .replace(exerciseName, rowName)
      .replace(exerciseId, '94a112a1-d823-4218-9864-269bf6baa894');
    await vault.create(`Rep Journal/Exercises/${rowName}.md`, row);
  }, {
    folders: ['Rep Journal/Plans', 'Rep Journal/Plans/2026', 'Rep Journal/Workouts', workoutsFolder],
    files: [
      [`Rep Journal/Plans/2026/${originalDay}.md`, [
        `# ${primaryTitle}`, '', '## Pair', '', 'Mode: superset', '', `### ${exerciseName}`, '5 reps', '',
        `### ${rowName}`, '8 reps', '', '## Finisher', '', `### ${exerciseName}`, '10 reps', '',
      ].join('\n')],
      [`Rep Journal/Plans/2026/${originalDay} Accessories.md`,
        `# ${secondaryTitle}\n\n## Accessories\n\n### ${rowName}\n10 reps\n`],
      ['Ordinary plan.md', `# ${manualTitle}\n\n## Lifts\n\n### ${exerciseName}\n5 reps\n`],
      [`${workoutsFolder}/${originalFile}`, JSON.stringify(originalSession)],
      [`${workoutsFolder}/${secondFile}`, JSON.stringify(secondSession)],
    ],
    exerciseName, exerciseId, rowName,
  });
  return originalSession.id;
}

async function exerciseDatedPlans(page: Page, vault: string, sessionId: string, reopen?: () => Promise<void>) {
  const journal = page.locator('.rep-journal-modern');
  const control = (name: string) => journal.getByRole('button', { name, exact: true });
  const banners = journal.locator('.plan-banner');
  const primary = journal.getByRole('complementary', { name: primaryTitle, exact: true });
  const secondary = journal.getByRole('complementary', { name: secondaryTitle, exact: true });
  const manual = journal.getByRole('complementary', { name: manualTitle, exact: true });
  const activeSection = journal.locator('[aria-current="step"]');
  const selectDay = async (day: string) => {
    await control('Calendar').click();
    await journal.getByLabel('Workout date', { exact: true }).fill(day);
    await control('Go to date').click();
  };
  const viewPlan = async (banner: typeof primary) => {
    await banner.getByRole('button', { name: 'View plan', exact: true }).click();
  };
  const startPlan = async (path: string) => {
    await control('Menu').click();
    await control('Plans').click();
    await journal.getByRole('button').filter({ hasText: path }).click();
    await control('Start plan').click();
  };

  await expect(journal.getByRole('heading', { name: 'Today' })).toBeVisible();
  await expect(banners).toHaveCount(0);
  await selectDay(originalDay);
  await expect(banners).toHaveCount(2);
  await expect(primary).toContainText(`Up next · ${exerciseName}`);
  await expect(secondary).toContainText(`Up next · ${rowName}`);

  await journal.getByLabel('Workout session', { exact: true }).selectOption(sessionId);
  await primary.getByRole('button', { name: `Start ${exerciseName}`, exact: true }).click();
  await journal.getByLabel('Weight (lb)', { exact: true }).fill('135');
  await journal.getByLabel('Reps', { exact: true }).fill('5');
  await control('Log set →').click();
  await expect(control(`Edit set 1 for ${exerciseName}`)).toBeVisible();
  await expect(journal.getByLabel('Workout session', { exact: true })).toHaveValue(sessionId);
  await expect(primary).toContainText(`Up next · ${rowName}`);
  await expect(secondary).toContainText(`Up next · ${rowName}`);

  const directory = join(vault, workoutsFolder);
  expect((await readdir(directory)).sort()).toEqual([secondFile, originalFile]);
  const first = parseWorkout(await readFile(join(directory, originalFile), 'utf8'));
  const second = parseWorkout(await readFile(join(directory, secondFile), 'utf8'));
  expect(first).toMatchObject({ id: sessionId, date: originalDay, sets: [{ exerciseId, reps: 5 }] });
  expect(second.sets).toHaveLength(0);

  await viewPlan(primary);
  await control('Next section').click();
  await expect(activeSection.getByRole('heading', { name: 'Finisher' })).toBeVisible();
  await control('Stop plan').click();
  await expect(primary).toHaveCount(0);
  await expect(secondary).toBeVisible();
  await selectDay(reuseDay);
  await expect(banners).toHaveCount(0);
  await selectDay(originalDay);
  await expect(secondary).toBeVisible();
  await expect(primary).toHaveCount(0);

  await page.reload();
  await reopen?.();
  await selectDay(originalDay);
  await expect(secondary).toBeVisible();
  await expect(primary).toHaveCount(0);

  await selectDay(reuseDay);
  await startPlan(`${originalDay}.md`);
  await expect(primary).toContainText(`Up next · ${exerciseName}`);
  await expect(secondary).toHaveCount(0);
  await viewPlan(primary);
  await expect(activeSection.getByRole('heading', { name: 'Pair' })).toBeVisible();
  await control('← Workout log').click();
  await selectDay(originalDay);
  await expect(secondary).toBeVisible();
  await expect(primary).toHaveCount(0);
  await startPlan(`${originalDay}.md`);
  await expect(banners).toHaveCount(2);
  await expect(primary).toContainText(`Up next · ${exerciseName}`);
  await viewPlan(secondary);
  await expect(activeSection.getByRole('heading', { name: 'Accessories' })).toBeVisible();
  await control('Stop plan').click();
  await expect(secondary).toHaveCount(0);
  await expect(primary).toBeVisible();

  await selectDay(reuseDay);
  await expect(primary).toBeVisible();
  await startPlan('Ordinary plan.md');
  await expect(manual).toBeVisible();
  await expect(primary).toBeVisible();
  await viewPlan(manual);
  await expect(activeSection.getByRole('heading', { name: 'Lifts' })).toBeVisible();
  await control('Stop plan').click();
  await expect(manual).toHaveCount(0);
  await expect(primary).toBeVisible();
}

test('keeps dated plan uses and historical sets independent in Obsidian', async ({ obsidian: { page, vault } }) => {
  await page.clock.setFixedTime(today);
  const sessionId = await seed(page);
  const reopen = async () => { await page.getByLabel('Open workout log', { exact: true }).click(); };
  await reopen();
  await exerciseDatedPlans(page, vault, sessionId, reopen);

  const newDay = '2026-11-24';
  const notePath = `Rep Journal/Plans/2026/${newDay} Live.md`;
  const title = 'Live dated plan';
  const banner = page.getByRole('complementary', { name: title, exact: true });
  await page.evaluate(async ({ notePath, title, exerciseName }) => {
    await window.app.vault.create(notePath, `# ${title}\n\n## Lift\n\n### ${exerciseName}\n5 reps\n`);
  }, { notePath, title, exerciseName });
  await expect(banner).toHaveCount(0);
  await page.getByRole('button', { name: 'Calendar', exact: true }).click();
  await page.getByLabel('Workout date', { exact: true }).fill(newDay);
  await page.getByRole('button', { name: 'Go to date', exact: true }).click();
  await expect(banner).toBeVisible();
  const updatedTitle = 'Live dated lift';
  await page.evaluate(async ({ notePath, title, updatedTitle }) => {
    const { vault } = window.app;
    const note = vault.getFileByPath(notePath);
    if (!note) throw new Error('Missing live dated plan');
    await vault.process(note, (markdown) => markdown.replace(title, updatedTitle));
  }, { notePath, title, updatedTitle });
  const updatedBanner = page.getByRole('complementary', { name: updatedTitle, exact: true });
  await expect(updatedBanner).toBeVisible();
  await page.evaluate(async (path) => {
    const { vault } = window.app;
    const note = vault.getFileByPath(path);
    if (!note) throw new Error('Missing live dated plan');
    await vault.rename(note, 'Rep Journal/Plans/2026/2026-11-26 Live.md');
  }, notePath);
  await expect(updatedBanner).toHaveCount(0);
});

test('keeps dated plan uses and historical sets independent in standalone', async ({ obsidian: { page, vault } }) => {
  const sessionId = await seed(page);
  mock.timers.enable({ apis: ['Date'], now: today });
  try {
    const { server, origin } = await startStandalone(vault, 0);
    try {
      await page.goto(origin, { timeout: 10_000 });
      await exerciseDatedPlans(page, vault, sessionId);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => {
        if (error) reject(error);
        else resolve();
      }));
    }
  } finally {
    mock.timers.reset();
  }
});
