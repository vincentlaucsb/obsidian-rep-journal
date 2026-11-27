import { expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createWorkout, localDate, makeId } from '../../src/model.ts';
import { startStandalone } from '../../scripts/standalone-server.ts';
import { exerciseId, exerciseName, test } from './obsidian.ts';

for (const host of ['Obsidian', 'standalone'] as const) {
  test(`discovers arriving workout JSON in an open ${host} journal and preserves drafts`, async ({ obsidian: { page, vault } }) => {
    const server = host === 'standalone' ? await startStandalone(vault, 0) : undefined;
    try {
      if (server) await page.goto(server.origin);
      else await page.getByLabel('Open workout log', { exact: true }).click();
      const journal = page.locator('.rep-journal-modern');
      const date = localDate();
      const folder = join(vault, 'Rep Journal', 'Workouts');
      if (!server) {
        await page.evaluate(() => {
          const vault = window.app.vault;
          const trigger = vault.trigger.bind(vault);
          // Exercise the raw watcher even when an unsupported file has no TFile create event.
          vault.trigger = (event: string, ...args: unknown[]) => {
            const file = args[0];
            if (event === 'create' && typeof file === 'object' && file && 'path' in file &&
              String(file.path).endsWith('.json')) return;
            if (event === 'raw' && file === 'Rep Journal/Workouts/incoming.json') document.body.dataset.workoutArrival = 'seen';
            trigger(event, ...args);
          };
        });
      }
      async function arrive(path: string, reps: number) {
        const workout = createWorkout(date);
        workout.sets.push({ id: makeId(), exerciseId, exerciseName, reps, warmup: false, load: { mode: 'weight', value: 57, unit: 'lb' } });
        await writeFile(join(folder, path), JSON.stringify(workout));
      }
      await expect(journal.getByText('No sets logged for this session.')).toBeVisible();
      await mkdir(join(folder, date.slice(0, 4)), { recursive: true });
      await arrive(`${date.slice(0, 4)}/${date}.json`, 12);
      await expect(journal.getByText('12 reps', { exact: true })).toBeVisible();

      await journal.getByRole('button', { name: `Log another set for ${exerciseName}` }).click();
      const reps = journal.getByLabel('Reps', { exact: true });
      await reps.fill('7');
      const listing = server && page.waitForResponse(async (response) =>
        response.url().endsWith('/api/workout-files') && (await response.json() as string[]).includes('Rep Journal/Workouts/incoming.json'));
      await arrive('incoming.json', 14);
      if (listing) await listing;
      else await expect(page.locator('body')).toHaveAttribute('data-workout-arrival', 'seen');
      await expect(reps).toHaveValue('7');
      await expect(reps).toBeFocused();
      await journal.getByRole('button', { name: '← Workout log' }).click();
      await expect(journal.getByText('14 reps', { exact: true })).toBeVisible();

      await journal.getByRole('button', { name: 'Calendar', exact: true }).click();
      const jump = journal.getByLabel('Workout date', { exact: true });
      await jump.fill('2001-01-02');
      await arrive('another.json', 16);
      await expect(journal.getByRole('button', { name: /, 3 workouts$/ })).toBeVisible();
      await expect(jump).toHaveValue('2001-01-02');
    } finally {
      if (server) await new Promise<void>((resolve) => server.server.close(() => resolve()));
    }
  });
}

test('warns about excluded JSON in a connected vault and clears the header icon when enabled', async ({ obsidian: { page } }) => {
  await page.getByLabel('Open workout log', { exact: true }).click();
  const name = 'Workout JSON is excluded from Obsidian Sync';
  const icon = page.getByRole('button', { name });
  await expect(icon).toHaveCount(0);
  // Exercise the host integration with local Sync preferences and no remote account.
  await page.evaluate(() => {
    const app = window.app as typeof window.app & { internalPlugins: { getEnabledPluginById(id: string): unknown } };
    const plugins = app.internalPlugins;
    const original = plugins.getEnabledPluginById.bind(plugins);
    plugins.getEnabledPluginById = (id) => id === 'sync' ? {
      getRemoteVaultId: () => 'fixture', filter: { allowTypes: new Set(document.body.dataset.jsonSync ? ['unsupported'] : []) },
    } : original(id);
  });
  await expect(icon).toBeVisible();
  await icon.click();
  await expect(page.getByText(/On this device, enable Settings → Sync/)).toBeVisible();
  const [settings] = await Promise.all([page.context().waitForEvent('page'),
    page.locator('.clickable-icon:has(.lucide-settings)').filter({ visible: true }).click()]);
  await settings.getByText('Rep Journal', { exact: true }).click();
  await expect(settings.getByText(name, { exact: true })).toBeVisible();
  await settings.close();
  await page.evaluate(() => { document.body.dataset.jsonSync = 'enabled'; });
  await expect(icon).toHaveCount(0);
});
