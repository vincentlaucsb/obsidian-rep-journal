import { chromium, expect, test as base, type BrowserContext, type Page, type TestInfo } from '@playwright/test';
import { Buffer } from 'node:buffer';
import { spawn } from 'node:child_process';
import { access, copyFile, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import process from 'node:process';
import { clearTimeout as clearNodeTimeout, setTimeout as setNodeTimeout } from 'node:timers';
import type { App } from 'obsidian';
import { stringify } from 'yaml';
import { exerciseFrontmatter } from '../../src/model.ts';

declare global {
  interface Window {
    app: App;
    process: typeof process;
  }
}

const obsidianVersion = '1.15.0';
const vaultId = '0123456789abcdef';
const fixturePrefix = 'rep-journal-ui-';
export const exerciseName = 'Fixture Bench Press';
export const exerciseId = '68e3355b-e502-4bfd-bdf5-cd9725136d93';

interface ObsidianFixture {
  page: Page;
  vault: string;
}

export const test = base.extend<{ obsidian: ObsidianFixture }>({
  // eslint-disable-next-line no-empty-pattern -- Playwright requires a destructured fixture argument.
  obsidian: async ({}, use, testInfo) => {
    if (process.platform !== 'win32') throw new Error('The UI suite requires Windows and Obsidian 1.15.0.');
    const executable = process.env.OBSIDIAN_EXECUTABLE ?? join(process.env.LOCALAPPDATA ?? '', 'Obsidian', 'Obsidian.exe');
    await access(executable);

    const temp = await realpath(tmpdir());
    const fixture = await mkdtemp(join(temp, fixturePrefix));
    const vault = join(fixture, 'Workout Journal');
    try {
      await runObsidian(executable, vault, fixture, use, testInfo);
    } finally {
      await removeFixture(fixture, temp);
    }
  },
});

async function removeFixture(fixture: string, temp: string): Promise<void> {
  const target = await realpath(fixture);
  if (dirname(target) !== temp || !basename(target).startsWith(fixturePrefix)) {
    throw new Error('Refusing to remove a directory outside the temporary fixture location.');
  }
  await rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

async function runObsidian(
  executable: string, vault: string, fixture: string, use: (value: ObsidianFixture) => Promise<void>, testInfo: TestInfo,
): Promise<void> {
  const appData = join(fixture, 'appdata');
  const profile = join(appData, 'obsidian');
  const local = join(fixture, 'local');
  const home = join(fixture, 'home');
  const config = join(vault, '.obsidian');
  const plugin = join(config, 'plugins', 'rep-journal');
  const exercises = join(vault, 'Rep Journal', 'Exercises');
  await Promise.all([profile, local, home, plugin, exercises].map((path) => mkdir(path, { recursive: true })));

  const frontmatter = exerciseFrontmatter({
    id: exerciseId, name: exerciseName, aliases: [], equipment: '', loadMode: 'weight',
    unit: 'lb', archived: false, measurements: ['weight', 'reps'],
  });
  const repository = join(import.meta.dirname, '..', '..');
  await Promise.all([
    ...['main.js', 'manifest.json', 'styles.css'].map((name) => copyFile(join(repository, name), join(plugin, name))),
    writeFile(join(profile, 'obsidian.json'), JSON.stringify({ updateDisabled: true, vaults: { [vaultId]: { path: vault, ts: 1, open: true } } })),
    writeFile(join(profile, vaultId + '.json'), '{}'),
    writeFile(join(config, 'community-plugins.json'), '["rep-journal"]'),
    writeFile(join(exercises, exerciseName + '.md'), '---\n' + stringify(frontmatter) + '---\n'),
  ]);

  const child = spawn(executable, [
    `--user-data-dir=${profile}`, '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1',
    '--disable-gpu', '--no-first-run',
  ], {
    env: { ...process.env, APPDATA: appData, LOCALAPPDATA: local, USERPROFILE: home, HOME: home },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let logs = '';
  const append = (message: string): void => { logs = (logs + message).slice(-65_536); };
  const closed = new Promise<void>((finish) => { child.once('close', finish); });
  const endpoint = new Promise<string>((resolve, reject) => {
    const timer = setNodeTimeout(() => { reject(new Error('Obsidian did not start its local Playwright connection.')); }, 25_000);
    child.stdout.on('data', (chunk: Buffer) => { append(chunk.toString()); });
    child.stderr.on('data', (chunk: Buffer) => {
      append(chunk.toString());
      const match = /DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[\w-]+)/.exec(logs);
      if (match) {
        clearNodeTimeout(timer);
        resolve(match[1]);
      }
    });
    child.once('error', (error) => { clearNodeTimeout(timer); reject(error); });
    child.once('close', (code) => { clearNodeTimeout(timer); reject(new Error(`Obsidian exited with code ${String(code)}.`)); });
  });

  let context: BrowserContext | undefined;
  let page: Page | undefined;
  let tracing = false;
  let ready = false;
  try {
    const browser = await chromium.connectOverCDP(await endpoint, { timeout: 10_000 });
    context = browser.contexts()[0];
    if (!context) throw new Error('Obsidian did not expose a browser context.');
    page = context.pages()[0] ?? await context.waitForEvent('page', { timeout: 10_000 });
    page.on('pageerror', (error) => { append(`\nRenderer error: ${error.message}\n`); });
    await page.waitForURL('app://**', { timeout: 10_000 });
    await context.addInitScript((id) => {
      if (location.protocol === 'app:') window.localStorage.setItem('enable-plugin-' + id, 'true');
    }, vaultId);
    await context.tracing.start({ screenshots: true, snapshots: true });
    tracing = true;
    await page.reload({ timeout: 15_000 });
    await expect(page).toHaveTitle(new RegExp(`Obsidian v?${obsidianVersion.replace(/\./g, '\\.')}\\b`));
    await expect(page.getByLabel('Open workout log', { exact: true })).toBeVisible();
    const identity = await page.evaluate(() => {
      function hasBasePath(adapter: unknown): adapter is { getBasePath: () => unknown } {
        return typeof adapter === 'object' && adapter !== null && 'getBasePath' in adapter && typeof adapter.getBasePath === 'function';
      }
      const adapter = window.app.vault.adapter;
      if (!hasBasePath(adapter)) throw new Error('Expected an Obsidian filesystem vault.');
      return { vault: adapter.getBasePath(), profile: window.process.env.APPDATA };
    });
    expect(identity).toEqual({ vault, profile: appData });
    ready = true;
    await use({ page, vault });
  } finally {
    try {
      const failed = !ready || testInfo.status !== testInfo.expectedStatus;
      if (failed) {
        await mkdir(testInfo.outputDir, { recursive: true });
        await writeFile(testInfo.outputPath('obsidian.log'), logs);
        await page?.screenshot({ path: testInfo.outputPath('obsidian.png'), timeout: 3_000 }).catch(() => undefined);
      }
      if (tracing) {
        await context?.tracing.stop(failed ? { path: testInfo.outputPath('trace.zip') } : {}).catch(() => undefined);
      }
    } finally {
      child.kill();
      await closed;
    }
  }
}
