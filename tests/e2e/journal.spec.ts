import { expect } from '@playwright/test';
import { mkdir, readFile, readdir, stat, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { journalSettingsFile } from '../../src/journal-paths.ts';
import { createWorkout, localDate, makeId, parseWorkout } from '../../src/model.ts';
import { exerciseId, exerciseName, test } from './obsidian.ts';

test('installs the bundled Garmin prompt from settings', async ({ obsidian: { page, vault } }) => {
  const button = page.locator('.clickable-icon:has(.lucide-settings)').filter({ visible: true });
  const [settings] = await Promise.all([page.context().waitForEvent('page'), button.click()]);
  await settings.getByText('Rep Journal', { exact: true }).click();
  await settings.getByRole('button', { name: 'Enable or repair' }).click();
  const source = await readFile(join(import.meta.dirname, '../../prompts/rep-journal-garmin/SKILL.md'), 'utf8');
  for (const dir of ['.agents', '.claude', '.opencode']) {
    const path = join(vault, dir, 'skills/rep-journal-garmin/SKILL.md');
    await expect.poll(async () => (await readFile(path, 'utf8').catch(() => '')).replace(/\r\n/g, '\n'))
      .toContain(source.replace(/\r\n/g, '\n'));
  }
});

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
  await journal.getByRole('button', { name: 'Log set', exact: true }).click();
  await expect(journal.getByRole('heading', { name: exerciseName, exact: true })).toBeVisible();
  await journal.getByRole('button', { name: '← Workout log', exact: true }).click();
  await viewPlan.click();
  await expect(journal.getByRole('button', { name: exerciseName, exact: true })).toHaveAttribute('aria-pressed', 'true');

  await page.evaluate(() => window.app.workspace.detachLeavesOfType('rep-journal-today'));
  await expect(journal).toHaveCount(0);
  await ribbon.click();
  await viewPlan.click();
  await expect(plan).toBeVisible();
  await journal.getByRole('button', { name: '← Workout log', exact: true }).click();
  await page.addStyleTag({ content: `
    .rep-journal-ui-compact.is-phone.is-floating-nav { --view-bottom-spacing: 54px; --navbar-bottom-offset: 14px; }
    .rep-journal-ui-compact .rep-journal-modern-content { width: 350px; height: 325px; flex: none; overflow-y: auto; }
    .rep-journal-ui-compact .log-groups { min-height: 500px; }
  ` });
  const clearance = await journal.evaluate((root) => {
    const host = root.closest('.rep-journal-modern-view')?.parentElement;
    const pane = root.closest<HTMLElement>('.rep-journal-modern-content');
    const log = root.querySelector<HTMLElement>('.log-groups');
    const notes = root.querySelector('.session-notes summary');
    const banner = root.querySelector('.log-screen > .plan-banner');
    if (!host || !pane || !log || !notes || !banner) throw new Error('Missing journal layout.');
    // Apply Obsidian mobile variables to the installed desktop host's pane.
    host.classList.add('rep-journal-ui-compact', 'is-phone', 'is-floating-nav');
    const toolbarTop = pane.getBoundingClientRect().bottom - 66;
    const offsets = () => [notes, ...banner.querySelectorAll('button')]
      .map((control) => toolbarTop - control.getBoundingClientRect().bottom);
    pane.scrollTop = Math.max(0, pane.scrollHeight - pane.clientHeight - 140);
    const stickyControls = offsets().slice(1);
    pane.scrollTop = pane.scrollHeight;
    const result = {
      scrollTop: pane.scrollTop,
      stickyControls,
      bottomControls: offsets(),
    };
    pane.scrollTop = 0;
    host.classList.remove('rep-journal-ui-compact', 'is-phone', 'is-floating-nav');
    return result;
  });
  expect(clearance.scrollTop).toBeGreaterThan(140);
  expect(clearance.stickyControls.length).toBeGreaterThan(0);
  for (const gap of [...clearance.stickyControls, ...clearance.bottomControls]) expect(gap).toBeGreaterThan(0);
  await viewPlan.click();
  await expect(plan).toHaveCount(1);
  await journal.getByRole('button', { name: 'Stop plan', exact: true }).click();
  await expect(viewPlan).toHaveCount(0);
});

test('shows the matching current sets and celebrates exact-rep improvements in Obsidian', async ({ obsidian: { page, vault } }) => {
  await page.getByLabel('Open workout log', { exact: true }).click();
  const journal = page.locator('.rep-journal-modern');
  const chooseExercise = async () => {
    await journal.getByRole('button', { name: '+ Log set', exact: true }).click();
    await journal.getByRole('searchbox', { name: 'Search exercises' }).fill(exerciseName);
    await journal.getByRole('button', { name: exerciseName, exact: true }).click();
  };
  const logAnother = journal.getByRole('button', { name: `Log another set for ${exerciseName}` });
  const back = journal.getByRole('button', { name: '← Workout log', exact: true });
  const save = async (weight: string, reps: string) => {
    await journal.getByLabel('Weight (lb)', { exact: true }).fill(weight);
    await journal.getByLabel('Reps', { exact: true }).fill(reps);
    await journal.getByRole('button', { name: 'Log set', exact: true }).click();
    await expect(journal.locator('.session-reference').first().getByRole('listitem').last()).toHaveText(`${weight} lb · ${reps} reps`);
    await expect(journal.getByLabel('Reps', { exact: true })).toBeFocused();
    await expect(journal.getByLabel('Reps', { exact: true })).toHaveValue('');
  };
  const toast = journal.locator('.record-toast');
  await chooseExercise();
  await save('15', '15');
  await expect(toast).toBeEmpty();
  await expect(journal.locator('.record-badge')).toHaveCount(0);
  const workoutFolder = join(vault, 'Rep Journal', 'Workouts');
  const [baselinePath] = (await readdir(workoutFolder, { recursive: true })).filter((path) => path.endsWith('.json'));
  const baselineFile = join(workoutFolder, baselinePath);
  await back.click();
  await journal.getByLabel("Today's session").selectOption({ label: 'New workout' });
  await chooseExercise();
  await expect(journal.getByRole('heading', { name: 'Current session' })).toHaveCount(0);
  await expect(journal.locator('.last-session')).toContainText('15 lb · 15 reps');
  await save('10', '15');
  await expect(journal.getByRole('heading', { name: exerciseName, exact: true })).toBeVisible();
  await expect(toast).toBeEmpty();

  await expect(journal.locator('.session-reference h2')).toHaveText(['Current session', 'Last session']);
  await expect(journal.locator('.session-reference').first()).toContainText('10 lb · 15 reps');
  await expect(journal.getByLabel('Weight (lb)', { exact: true })).toHaveValue('10');
  const pane = page.locator('.rep-journal-modern-content');
  for (const width of [720, 350]) {
    const layout = await pane.evaluate((pane, width) => {
      const originalWidth = pane.style.width;
      pane.style.width = `${width}px`;
      const box = (selector: string) => {
        const element = pane.querySelector(selector);
        if (!element) throw new Error(`Missing entry control ${selector}`);
        return element.getBoundingClientRect();
      };
      try {
        const title = box('h1');
        const actions = box('.entry-header button');
        return {
          actionsBesideTitle: actions.left >= title.right && actions.top < title.bottom && actions.bottom > title.top,
          fieldsBelowHeader: box('.entry-fields').top >= box('.entry-header').bottom,
          historyBelowSubmit: box('.session-reference').top >= box('.entry-form [type="submit"]').bottom,
          horizontalOverflow: pane.scrollWidth - pane.clientWidth,
        };
      } finally {
        pane.style.width = originalWidth;
      }
    }, width);
    if (width === 720) expect(layout.actionsBesideTitle).toBe(true);
    expect(layout).toMatchObject({ fieldsBelowHeader: true, historyBelowSubmit: true, horizontalOverflow: 0 });
  }
  const original = await readFile(baselineFile, 'utf8');
  const revision = await stat(baselineFile);
  const replacement = original.replace('"value": 15,', '"value": 25,');
  expect(replacement).not.toBe(original);
  expect(replacement).toHaveLength(original.length);
  await writeFile(baselineFile, replacement);
  await utimes(baselineFile, revision.atime, revision.mtime);
  await save('20', '15');
  await expect(journal.locator('.session-reference').first().getByRole('listitem')).toHaveCount(2);
  await back.click();
  await expect(journal.getByLabel("Today's session").locator('option:checked')).toHaveText('Automatic');
  await expect(toast).toBeEmpty();
  await expect(journal.locator('.record-badge')).toHaveCount(0);
  await journal.getByRole('button', { name: `Edit set 2 for ${exerciseName}`, exact: true }).click();
  await journal.getByLabel('Weight (lb)', { exact: true }).fill('22');
  await journal.getByRole('button', { name: 'Save set', exact: true }).click();
  await expect(logAnother).toBeVisible();
  await expect(journal.locator('.record-badge')).toHaveCount(0);
  await journal.getByRole('button', { name: `View progress for ${exerciseName}` }).click();
  const history = journal.getByLabel('Exercise history');
  await expect(history).toContainText('15 reps · 22 lb');
  await expect(history.locator('.record-badge')).toHaveCount(0);
  await journal.getByRole('button', { name: 'Back to workout' }).click();
  await logAnother.click();
  await save('30', '15');
  await expect(toast).toHaveText(`New 15-rep PR! · ${exerciseName} · 30 lb`);
  await back.click();
  const badge = journal.getByRole('img', { name: '15-rep PR', exact: true });
  await expect(badge).toBeVisible();
  await expect(badge).toHaveText('15-rep PR');
  await journal.getByRole('button', { name: `View progress for ${exerciseName}` }).click();
  await expect(history.getByRole('img', { name: '15-rep PR', exact: true })).toBeVisible();
});

test('opens Progress at the workout session and opens the latest session from the menu', async ({ obsidian: { page, vault } }) => {
  const historicalDate = '2001-01-02';
  const today = localDate();
  const folder = join(vault, 'Rep Journal', 'Workouts');
  for (const [date, hour, weight] of [[historicalDate, '09', 80], [historicalDate, '12', 100], [today, '09', 120]] as const) {
    const workout = createWorkout(date);
    workout.createdAt = `${date}T${hour}:00:00.000Z`;
    for (const [reps, value] of [[1, weight], [8, weight - 30], [15, weight - 50]]) {
      workout.sets.push({ id: makeId(), exerciseId, exerciseName, reps, warmup: false, load: { mode: 'weight', value, unit: 'lb' } });
    }
    await mkdir(join(folder, date.slice(0, 4)), { recursive: true });
    await writeFile(join(folder, date.slice(0, 4), `${date}-${hour}.json`), JSON.stringify(workout));
  }

  await page.getByLabel('Open workout log', { exact: true }).click();
  const journal = page.locator('.rep-journal-modern');
  await journal.getByRole('button', { name: 'Previous workout', exact: true }).click();
  const labels = ['1-rep PR', '8-rep PR', '15-rep PR'];
  const badges = journal.locator('.record-badge');
  await expect(badges).toHaveText(labels);
  for (const name of labels) await expect(journal.getByRole('img', { name, exact: true })).toBeVisible();

  await journal.getByRole('button', { name: `View progress for ${exerciseName}` }).click();
  const detail = journal.locator('.strength-chart-detail');
  const selectedMarker = journal.locator('.strength-chart-plot .line-marker.is-selected');
  const expanded = journal.getByRole('region', { name: 'Exercise history' }).locator('details[open]');
  await expect(journal.getByRole('button', { name: 'All time' })).toHaveAttribute('aria-pressed', 'true');
  await expect(detail).toContainText(`${historicalDate} · Session 2`);
  await expect(detail).toContainText('Estimated 1RM 100.0 lb');
  await expect(selectedMarker).toHaveCount(1);
  await expect(expanded.locator('summary')).toContainText(`${historicalDate} · Session 2`);
  await expect(expanded.locator('.record-badge')).toHaveText(labels);
  for (const name of labels) await expect(expanded.getByRole('img', { name, exact: true })).toBeVisible();

  await journal.getByRole('button', { name: 'Back to workout' }).click();
  await expect(badges).toHaveText(labels);
  await journal.getByRole('button', { name: 'Menu', exact: true }).click();
  await journal.getByRole('button', { name: 'Progress', exact: true }).click();
  await expect(detail).toContainText(today);
  await expect(detail).toContainText('Estimated 1RM 120.0 lb');
  await expect(expanded.locator('summary')).toContainText(today);
  await expect(journal.getByRole('button', { name: 'Back to workout' })).toHaveCount(0);
});

test('splits Today at save time and lets the calendar select a session by its set times', async ({ obsidian: { page } }) => {
  const at = (hour: number, minute: number) => new Date(2026, 10, 26, hour, minute);
  await page.clock.setFixedTime(at(8, 0));
  await page.getByLabel('Open workout log', { exact: true }).click();
  const journal = page.locator('.rep-journal-modern');
  const picker = journal.getByLabel("Today's session");
  const logAnother = journal.getByRole('button', { name: `Log another set for ${exerciseName}` });
  const submitSet = async () => {
    await journal.getByLabel('Weight (lb)', { exact: true }).fill('25');
    await journal.getByLabel('Reps', { exact: true }).fill('8');
    await journal.getByRole('button', { name: 'Log set', exact: true }).click();
    await expect(journal.getByLabel('Reps', { exact: true })).toHaveValue('');
  };
  const save = async () => {
    await submitSet();
    await journal.getByRole('button', { name: '← Workout log', exact: true }).click();
    await expect(logAnother).toBeVisible();
  };
  await journal.getByRole('button', { name: '+ Log set' }).click();
  await journal.getByRole('searchbox', { name: 'Search exercises' }).fill(exerciseName);
  await journal.getByRole('button', { name: exerciseName, exact: true }).click();
  await save();
  await expect(picker.locator('option')).toHaveText(['Automatic', 'Session 1', 'New workout']);
  await journal.getByRole('button', { name: 'Calendar', exact: true }).click();
  await journal.getByLabel('Workout date', { exact: true }).fill('2026-11-25');
  await journal.getByRole('button', { name: 'Go to date', exact: true }).click();
  await journal.getByRole('button', { name: 'Calendar', exact: true }).click();
  const today = journal.locator('.calendar-day[aria-current="date"]');
  await expect(today).toHaveAttribute('aria-pressed', 'false');
  await expect(journal.locator('.calendar-day[aria-pressed="true"]')).toHaveText('25');
  await today.click();
  await expect(picker.locator('option:checked')).toHaveText('Automatic');
  await page.clock.setFixedTime(at(8, 59));
  await logAnother.click();
  await expect(journal.getByRole('heading', { name: 'Current session' })).toBeVisible();
  await page.clock.setFixedTime(at(9, 0));
  await save();
  await page.clock.setFixedTime(at(9, 25));
  await logAnother.click();
  await save();
  const [first, start, end] = await page.evaluate((times) => {
    const formatter = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
    return times.map((time) => formatter.format(time));
  }, [at(8, 0), at(9, 0), at(9, 25)].map(Number));
  await expect(picker.locator('option')).toHaveText([
    'Automatic', `${first} · Session 1`, `${start}–${end} · Session 2`, 'New workout',
  ]);
  await journal.getByRole('button', { name: 'Calendar', exact: true }).click();
  await today.click();
  await expect(today).toHaveAttribute('aria-pressed', 'true');
  const sessionChoice = journal.getByRole('button', { name: `${start}–${end} · Session 2 · 2 sets · ${exerciseName}`, exact: true });
  await expect(sessionChoice).toBeVisible();
  const narrowPane = await page.addStyleTag({ content: '.rep-journal-modern-content { width: 180px; }' });
  const textFits = await sessionChoice.evaluate(button => {
    const range = button.ownerDocument.createRange();
    range.selectNodeContents(button);
    const text = range.getBoundingClientRect();
    const box = button.getBoundingClientRect();
    return range.getClientRects().length >= 3 && text.top >= box.top && text.bottom <= box.bottom;
  });
  await narrowPane.evaluate(style => style.parentNode?.removeChild(style));
  expect(textFits).toBe(true);
  await journal.getByRole('button', { name: `${first} · Session 1 · 1 set · ${exerciseName}`, exact: true }).click();
  await page.clock.setFixedTime(at(11, 0));
  await logAnother.click();
  await save();
  await expect(journal.locator('.log-groups .set-row')).toHaveCount(2);
  await expect(picker.locator('option:checked')).toContainText('Session 1');
  await journal.getByRole('button', { name: `Edit set 2 for ${exerciseName}`, exact: true }).click();
  await expect(journal.getByText(`${exerciseName} · Set 2`, { exact: true })).toBeVisible();
  await expect(journal.getByText(/^2026-11-26 · .*Session 1$/)).toBeVisible();
  await journal.getByRole('button', { name: '← Workout log', exact: true }).click();
  await picker.selectOption({ label: 'Automatic' });
  await logAnother.click();
  await expect(journal.getByRole('heading', { name: 'Current session' })).toHaveCount(0);
  await save();
  await expect(picker.locator('option')).toHaveCount(5);

  // While the form for session 3 is open, another device removes that session.
  await picker.selectOption({ label: `${start}–${end} · Session 2` });
  await logAnother.click();
  await save();
  await picker.selectOption({ label: 'Automatic' });
  await logAnother.click();
  await page.evaluate(async () => window.app.vault.adapter.remove('Rep Journal/Workouts/2026/2026-11-26-3.json'));
  await save();
  await expect(journal.locator('.session-title')).toContainText('Session 2');
  await expect(journal.locator('.log-groups .set-row')).toHaveCount(4);
  await expect(picker.locator('option')).toHaveCount(4);

  // New workout applies to the first set. Keep the form open across the automatic split.
  await picker.selectOption({ label: 'New workout' });
  await journal.getByRole('button', { name: '+ Log set', exact: true }).click();
  await journal.getByRole('button', { name: exerciseName, exact: true }).click();
  await submitSet();
  await page.clock.setFixedTime(at(12, 0));
  await submitSet();
  await journal.getByRole('button', { name: '← Workout log', exact: true }).click();
  await expect(journal.locator('.session-title')).toContainText('Session 4');
  await expect(journal.locator('.log-groups .set-row')).toHaveCount(1);
});

test('shows a completed set when Today is reopened during its save', async ({ obsidian: { page } }) => {
  const ribbon = page.getByLabel('Open workout log', { exact: true });
  const journal = page.locator('.rep-journal-modern');
  await ribbon.click();
  await journal.getByRole('button', { name: '+ Log set', exact: true }).click();
  await journal.getByRole('button', { name: exerciseName, exact: true }).click();
  await journal.getByLabel('Weight (lb)', { exact: true }).fill('135');
  await journal.getByLabel('Reps', { exact: true }).fill('5');
  await page.evaluate(() => {
    const vault = window.app.vault;
    const create = vault.create.bind(vault);
    vault.create = async (...args) => {
      const file = await create(...args);
      if (file.path.startsWith('Rep Journal/Workouts/') && file.path.endsWith('.json')) {
        document.body.dataset.setSave = 'waiting';
        await new Promise<void>((resolve) => window.addEventListener('resume-set-save', () => resolve(), { once: true }));
      }
      return file;
    };
  });
  await journal.getByRole('button', { name: 'Log set', exact: true }).click();
  await expect(page.locator('body')).toHaveAttribute('data-set-save', 'waiting');
  await ribbon.click();
  await page.evaluate(() => window.dispatchEvent(new Event('resume-set-save')));
  await expect(journal.getByRole('heading', { name: 'Today', exact: true })).toBeVisible();
  await expect(journal.locator('.log-groups .set-row')).toHaveCount(1);
  await expect(journal.getByText('5 reps', { exact: true })).toBeVisible();
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

test('logs, charts, and restores a weighted set offline', { tag: '@offline-chart' }, async ({ obsidian: { page, vault } }) => {
  const requests: string[] = [];
  await page.context().route(/^https?:\/\//, async (route) => {
    requests.push(route.request().url());
    await route.abort('internetdisconnected');
  });
  await page.reload();
  const ribbon = page.getByLabel('Open workout log', { exact: true });
  const journal = page.locator('.rep-journal-modern');
  await expect(ribbon).toBeVisible();
  // Catch relative or non-HTTP fetches too, even if the loader recovers from a failure.
  await page.evaluate(() => {
    document.documentElement.dataset.chartFetchCount = '0';
    window.fetch = () => {
      const data = document.documentElement.dataset;
      data.chartFetchCount = String(Number(data.chartFetchCount) + 1);
      return Promise.reject(new Error('Offline chart test blocked fetch'));
    };
  });
  await ribbon.click();
  await expect(journal.getByText('No sets logged for this session.', { exact: true })).toBeVisible();
  await journal.getByRole('button', { name: '+ Log set', exact: true }).click();
  const search = journal.getByRole('searchbox', { name: 'Search exercises' });
  await expect(search).toBeFocused();
  await page.keyboard.type('Bench');
  await expect(search).toHaveValue('Bench');
  await journal.getByRole('button', { name: exerciseName, exact: true }).click();
  await journal.getByRole('button', { name: 'Change exercise' }).click();
  await expect(search).toBeFocused();
  await page.keyboard.type(exerciseName);
  await expect(search).toHaveValue(exerciseName);
  await journal.getByRole('button', { name: exerciseName, exact: true }).click();
  const addWeight = journal.getByRole('button', { name: 'Add 45 lb', exact: true });
  await addWeight.click();
  await expect(journal.getByLabel('Weight (lb)', { exact: true })).toHaveValue('45');
  await addWeight.click();
  await addWeight.click();
  await expect(journal.getByLabel('Weight (lb)', { exact: true })).toHaveValue('135');
  await journal.getByLabel('Reps', { exact: true }).fill('5');
  await journal.getByRole('button', { name: 'Log set', exact: true }).click();
  await expect(journal.getByRole('heading', { name: 'Current session' })).toBeVisible();
  await journal.getByRole('button', { name: '← Workout log', exact: true }).click();

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
  await journal.getByRole('button', { name: '1 week', exact: true }).click();
  await expect(journal.locator('.strength-chart-plot svg use.line-marker')).toHaveCount(1);
  const ticks = await journal.locator('.strength-chart-plot .y-tick').allTextContents();
  expect(ticks.length).toBeGreaterThan(1);
  expect(new Set(ticks.map(Number)).size).toBe(ticks.length);
  const detail = journal.locator('.strength-chart-detail');
  await expect(detail).toContainText('Estimated 1RM 157.5 lb');
  await expect(detail).toContainText('Logged set · 5 reps · 135 lb');
  await expect(page.locator('html')).toHaveAttribute('data-chart-fetch-count', '0');
  expect(requests).toEqual([]);
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
