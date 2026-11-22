import { expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { startStandalone } from '../../scripts/standalone-server.ts';
import { exerciseName, test } from './obsidian.ts';

test('starts, resumes, and stops a plan in the standalone app', async ({ obsidian: { page, vault } }) => {
  const plans = join(vault, 'Plans');
  const title = 'Fixture strength plan';
  await mkdir(plans);
  await writeFile(join(plans, `${title}.md`), [
    `# ${title}`, '', '## Warmup', `### ${exerciseName}`, '10 reps', '',
    '## Working sets', `### ${exerciseName}`, '5 reps', '',
  ].join('\n'));

  const { server, origin } = await startStandalone(vault, 0);
  try {
    // The Obsidian fixture supplies an isolated Chromium instance on Windows CI.
    await page.goto(origin, { timeout: 10_000 });
    const menu = page.getByRole('button', { name: 'Menu', exact: true });
    await expect(menu).toBeVisible();
    await menu.click();
    await page.getByRole('button', { name: 'Plans', exact: true }).click();
    await page.getByRole('button', { name: new RegExp(title) }).click();
    await expect(page.getByRole('heading', { name: title })).toBeVisible();
    await page.getByRole('button', { name: 'Start plan', exact: true }).click();

    const banner = page.getByRole('complementary', { name: title, exact: true });
    const activeSection = page.locator('[aria-current="step"]');
    await expect(banner).toContainText(`Up next · ${exerciseName}`);
    await banner.getByRole('button', { name: 'View plan' }).click();
    await expect(activeSection.getByRole('heading', { name: 'Warmup' })).toBeVisible();
    await page.getByRole('button', { name: 'Done with Warmup' }).click();
    await expect(activeSection.getByRole('heading', { name: 'Working sets' })).toBeVisible();

    await page.getByRole('button', { name: '← Workout log' }).click();
    await expect(banner).toBeVisible();
    await page.reload();
    await expect(banner).toBeVisible();
    await banner.getByRole('button', { name: 'View plan' }).click();
    await expect(activeSection.getByRole('heading', { name: 'Working sets' })).toBeVisible();

    await page.getByRole('button', { name: 'Stop plan' }).click();
    await expect(page.getByRole('button', { name: 'Follow a plan' })).toBeVisible();
    await expect(banner).toHaveCount(0);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => {
      if (error) reject(error);
      else resolve();
    }));
  }
});
