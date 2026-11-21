import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { stringify } from 'yaml';
import { toCsv, toJson } from '../src/exports.ts';
import { readImportVault } from '../src/import-vault.ts';
import { changeWorkout, createWorkout, exerciseFrontmatter, makeId, parseWorkout, SCHEMA_VERSION, type ExerciseDetails } from '../src/model.ts';
import { startStandalone } from '../src/standalone-server.ts';

void test('standalone loads existing files and writes only the selected or new workout', async (context) => {
  const temporaryBase = resolve(tmpdir());
  const root = await mkdtemp(join(temporaryBase, 'rep-journal-standalone-'));
  context.after(async () => {
    assert.equal(dirname(resolve(root)), temporaryBase);
    assert.match(basename(root), /^rep-journal-standalone-/);
    await rm(root, { recursive: true, force: true });
  });

  const exercise: ExerciseDetails = {
    name: 'Bench Press', aliases: ['Bench'], equipment: '', loadMode: 'weight', unit: 'lb', archived: false, measurements: ['weight', 'reps'],
  };
  const exerciseId = makeId();
  const rowId = makeId();
  const writeExercise = async (folder: string, name: string, details: ExerciseDetails, id: string) => {
    const path = join(root, folder, 'Exercises');
    await mkdir(path, { recursive: true });
    await writeFile(join(path, name + '.md'), `---\n${stringify({ ...exerciseFrontmatter({ ...details, id }), custom: 'Keep me' })}---\n\n## Form cue\nKeep the note body.\n`);
  };
  await writeExercise('Rep Journal', exercise.name, exercise, exerciseId);
  await writeExercise('Set Ledger', 'Row', { ...exercise, name: 'Row', aliases: [] }, rowId);
  const history = changeWorkout(createWorkout('2024-01-01'), { kind: 'add', set: {
    id: makeId(), exerciseId, exerciseName: exercise.name, load: { mode: 'assistance', value: 90, unit: 'lb' },
    reps: 8, warmup: true, durationSeconds: 42, distance: { value: 20, unit: 'yd' },
  } });
  const oldPath = join(root, 'Set Ledger', 'Workouts', '2024-01-01.json');
  await mkdir(dirname(oldPath), { recursive: true });
  await writeFile(oldPath, JSON.stringify(history));
  await mkdir(join(root, 'Exercise'));
  const planPath = 'Exercise/Upper Body Superset.md';
  const planText = '# Upper body\n\n## Pair\nMode: superset\n\n### Bench\n8–10 reps\n\n### Row\n10–12 reps\n';
  await writeFile(join(root, planPath), planText);

  const { server, origin } = await startStandalone(root, 0, 'kg');
  context.after(() => new Promise<void>((complete, reject) => server.close((error) => { if (error) reject(error); else complete(); })));
  const index = await fetch(origin);
  assert.equal(index.status, 200);
  assert.match(await index.text(), /Rep Journal[\s\S]*\/bootstrap\.js/);
  assert.match(await (await fetch(`${origin}/bootstrap.js`)).text(), /import \{ mountJournal \}/);
  assert.match(await (await fetch(`${origin}/style.css`)).text(), /\.rep-journal-modern \{[\s\S]*var\(--background-primary/);
  const journal = await (await fetch(`${origin}/api/journal`)).json() as { today: string; unit: string; exercises: Array<{ id: string }>; workouts: unknown[] };
  assert.equal(journal.unit, 'kg');
  assert.equal(journal.exercises.length, 2);
  assert.equal(journal.workouts.length, 1);

  const plans: unknown = await (await fetch(`${origin}/api/plans`)).json();
  assert.deepEqual(plans, [{ path: planPath, title: 'Upper body' }]);
  const parsed = await (await fetch(`${origin}/api/plan?path=${encodeURIComponent(planPath)}`)).json() as { plan: { sections: Array<{ exercises: Array<{ exerciseId: string }>; superset: boolean }> } };
  assert.equal(parsed.plan.sections[0].superset, true);
  assert.deepEqual(parsed.plan.sections[0].exercises.map((entry) => entry.exerciseId), [exerciseId, rowId]);
  const escape = await fetch(`${origin}/api/plan?path=${encodeURIComponent('../outside.md')}`);
  assert.equal(escape.status, 400);

  const payload = { date: journal.today, workoutId: null, exerciseId, setId: makeId(), values: { weight: 42, reps: 9 } };
  const post = (body: unknown, source = origin) => fetch(`${origin}/api/sets`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: source }, body: JSON.stringify(body),
  });
  assert.equal((await post(payload, 'https://example.com')).status, 403);
  assert.equal((await post({ ...payload, date: '2024-01-01' })).status, 400);
  assert.equal((await post({ ...payload, values: { weight: 42, reps: 0 } })).status, 400);
  const initial = await post(payload);
  assert.equal(initial.status, 200);
  const saved = await initial.json() as { path: string; workout: { id: string } };
  assert.equal(saved.path, `Rep Journal/Workouts/${journal.today}.json`);
  assert.equal((await post(payload)).status, 200);
  const append = await post({ ...payload, workoutId: saved.workout.id, setId: makeId(), exerciseId: rowId });
  assert.equal(append.status, 200, append.ok ? undefined : await append.text());
  const another = await post({ ...payload, workoutId: null, setId: makeId() });
  assert.equal(another.status, 200);
  const second = await another.json() as { path: string };
  assert.equal(second.path, `Rep Journal/Workouts/${journal.today}-2.json`);
  const updated = parseWorkout(await readFile(join(root, saved.path), 'utf8'));
  assert.deepEqual(updated.sets.map(({ exerciseId: id }) => id), [exerciseId, rowId]);
  assert.deepEqual(updated.sets[0].load, { mode: 'weight', value: 42, unit: 'kg' });
  assert.deepEqual(parseWorkout(await readFile(oldPath, 'utf8')), history);
  assert.equal(await readFile(join(root, planPath), 'utf8'), planText);

  const edit = (path: string, body: unknown, source = origin) => fetch(`${origin}/api/${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: source }, body: JSON.stringify(body),
  });
  const historical = { date: history.date, workoutId: history.id };
  const change = { kind: 'edit', original: history.sets[0], values: { weight: 75, reps: 7, time: 50, distance: 25 } };
  assert.equal((await edit('workout-edits', { ...historical, change }, 'https://example.com')).status, 403);
  assert.equal((await edit('workout-edits', { ...historical, change })).status, 200);
  const corrected = parseWorkout(await readFile(oldPath, 'utf8'));
  assert.deepEqual(corrected.sets[0], {
    ...history.sets[0], load: { mode: 'assistance', value: 75, unit: 'lb' }, reps: 7,
    durationSeconds: 50, distance: { value: 25, unit: 'yd' },
  });
  assert.equal((await edit('workout-edits', { ...historical, change: { kind: 'remove', original: history.sets[0] } })).status, 400);
  assert.equal((await edit('workout-edits', { ...historical, change: { kind: 'notes', original: '', value: 'Historical note' } })).status, 200);
  assert.equal((await edit('workout-edits', { ...historical, change: { kind: 'notes', original: '', value: 'Other note' } })).status, 400);
  assert.equal((await edit('workout-edits', { ...historical, change: { kind: 'remove', original: corrected.sets[0] } })).status, 200);
  assert.deepEqual(parseWorkout(await readFile(oldPath, 'utf8')), { ...history, notes: 'Historical note', sets: [] });
  const notesOnly = {
    date: journal.today, workoutId: null, newWorkoutId: makeId(), change: { kind: 'notes', original: '', value: 'Note only' },
  };
  assert.equal((await edit('workout-edits', notesOnly)).status, 200);
  assert.equal((await edit('workout-edits', notesOnly)).status, 200);
  const notePath = join(root, 'Rep Journal', 'Workouts', `${journal.today}-3.json`);
  const newWorkout = parseWorkout(await readFile(notePath, 'utf8'));
  assert.equal(newWorkout.id, notesOnly.newWorkoutId);
  assert.equal(newWorkout.notes, 'Note only');

  const original = journal.exercises.find(({ id }) => id === exerciseId);
  const values = { name: 'Incline Bench', aliases: ['Bench'], measurements: ['weight', 'reps', 'distance'], distanceUnit: 'km',
    archived: true, tags: [{ group: 'movement', name: 'Push' }] };
  const exerciseEdit = { exerciseId, original, values };
  assert.equal((await edit('exercises', exerciseEdit, 'https://example.com')).status, 403);
  const archivedResponse = await edit('exercises', exerciseEdit);
  assert.equal(archivedResponse.status, 200);
  const archived = await archivedResponse.json() as { id: string; aliases: string[]; archived: boolean };
  assert.equal(archived.id, exerciseId);
  assert.equal(archived.archived, true);
  assert.deepEqual(archived.aliases, ['Bench', 'Bench Press']);
  const exerciseText = await readFile(join(root, 'Rep Journal', 'Exercises', 'Bench Press.md'), 'utf8');
  assert.match(exerciseText, /^custom: Keep me$/m);
  assert.ok(exerciseText.endsWith('\n\n## Form cue\nKeep the note body.\n'));
  assert.equal((await edit('exercises', exerciseEdit)).status, 400);
  assert.equal((await edit('exercises', { exerciseId, original: archived, values: { ...values, archived: false } })).status, 200);
  const press = { exerciseId: makeId(), original: null, values: { ...values, name: 'Overhead Press', aliases: [], archived: false } };
  assert.equal((await edit('exercises', press)).status, 200);
  assert.equal((await edit('exercises', press)).status, 200);
  assert.match(await readFile(join(root, 'Rep Journal', 'Exercises', 'Overhead Press.md'), 'utf8'), /## Exercise guides/);

  const state = await (await fetch(`${origin}/api/journal`)).json() as { starters: Array<{ id: string; name: string }> };
  const starter = state.starters.find(({ name }) => name === 'Hip Flexor Stretch');
  assert.ok(starter);
  const created = await edit('exercises', { starterId: starter.id });
  assert.equal(created.status, 200);
  const savedStarter = await created.json() as { id: string; path: string };
  assert.equal(savedStarter.id, starter.id);
  assert.match(savedStarter.path, /Hip Flexor Stretch\.md$/);
  const datedSet = { date: history.date, workoutId: null, exerciseId: starter.id, setId: makeId(), values: { time: '1:15' } };
  assert.equal((await post(datedSet)).status, 400);
  const dated = await post({ ...datedSet, selectedDate: true });
  assert.equal(dated.status, 200);
  const datedPath = (await dated.json() as { path: string }).path;
  assert.equal(datedPath, `Rep Journal/Workouts/${history.date}-2.json`);
  assert.equal(parseWorkout(await readFile(join(root, datedPath), 'utf8')).sets[0].durationSeconds, 75);
});

void test('standalone progress and export use the active journal and preserve the CSV when refresh fails', async (context) => {
  const temporaryBase = resolve(tmpdir());
  const root = await mkdtemp(join(temporaryBase, 'rep-journal-exports-'));
  context.after(async () => {
    assert.equal(dirname(resolve(root)), temporaryBase);
    assert.match(basename(root), /^rep-journal-exports-/);
    await rm(root, { recursive: true, force: true });
  });

  const exerciseId = makeId();
  const missingId = makeId();
  const folder = join(root, 'Set Ledger');
  const folderPath = join(folder, 'Workouts');
  await mkdir(folderPath, { recursive: true });
  await mkdir(join(folder, 'Exercises'));
  const note = { id: exerciseId, name: 'Bench press', aliases: ['Bench'], archived: true, equipment: 'Barbell',
    loadMode: 'weight', unit: 'lb', tags: [{ group: 'role', name: 'Main' }] } as const;
  const notePath = join(folder, 'Exercises', 'Bench.md');
  const noteText = `---\n${stringify(exerciseFrontmatter({ ...note, aliases: [...note.aliases], tags: [...note.tags] }))}---\n`;
  await writeFile(notePath, noteText);
  const date = '2024-01-01';
  const early = changeWorkout({ ...createWorkout(date), createdAt: `${date}T09:00:00.000Z`, notes: 'Private note' }, { kind: 'add', set: {
    id: makeId(), exerciseId, exerciseName: 'Bench', load: { mode: 'weight', value: 88, unit: 'lb' }, reps: 8, warmup: false,
  } });
  const later = { ...createWorkout(date), schemaVersion: SCHEMA_VERSION, createdAt: `${date}T18:00:00.000Z`, sets: [
    { ...early.sets[0], id: makeId(), load: { mode: 'weight' as const, value: 50, unit: 'kg' as const }, reps: 5 },
    { ...early.sets[0], id: makeId(), load: undefined, reps: 6 },
    { id: makeId(), exerciseId: missingId, exerciseName: 'Historic carry', distance: { value: 20, unit: 'yd' as const }, warmup: false },
  ] };
  const earlyPath = join(folderPath, `${date}.json`);
  const laterPath = join(folderPath, `${date}-2.json`);
  await writeFile(earlyPath, JSON.stringify(early));
  await writeFile(laterPath, JSON.stringify(later));
  const { server, origin } = await startStandalone(root, 0, 'kg');
  context.after(() => new Promise<void>((complete, reject) => server.close((error) => { if (error) reject(error); else complete(); })));
  const csvPath = join(folder, 'Exports', 'rep-journal.csv');
  const originalData = (await readImportVault(root)).data;
  assert.deepEqual(originalData.issues, []);
  assert.equal(await readFile(csvPath, 'utf8'), toCsv(originalData));
  const page = await fetch(origin);
  assert.match(page.headers.get('content-security-policy') ?? '', /script-src 'self' 'wasm-unsafe-eval';/);
  assert.doesNotMatch(page.headers.get('content-security-policy') ?? '', /'unsafe-eval'|'unsafe-inline'/);
  const binary = await fetch(`${origin}/svgplot/line-engine.wasm`);
  assert.equal(binary.status, 200);
  assert.equal(binary.headers.get('content-type'), 'application/wasm');
  assert.deepEqual(new Uint8Array(await binary.arrayBuffer()).slice(0, 4), new Uint8Array([0, 97, 115, 109]));
  for (const asset of ['charts.js', 'line.js', 'line-engine.mjs']) {
    const response = await fetch(`${origin}/svgplot/${asset}`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /^text\/javascript/);
    assert.ok((await response.text()).length > 0);
  }
  const report = await (await fetch(`${origin}/api/progress?exercise=${exerciseId}`)).json() as {
    selected: { aliases: string[]; archived: boolean }; unit: string; tags: unknown[];
    sessions: Array<{ id: string; number: number; sets: string[]; estimatedMax: number }>;
    trend: Array<{ date: string; sessionId: string; number: number; value: number; set: string }>;
  };
  assert.deepEqual(report.selected.aliases, ['Bench']);
  assert.equal(report.selected.archived, true);
  assert.deepEqual(report.tags, [{ group: 'role', name: 'Main' }]);
  assert.equal(report.unit, 'kg');
  assert.deepEqual(report.sessions.map(({ id, number, sets }) => ({ id, number, sets })), [
    { id: later.id, number: 2, sets: ['5 reps · 50 kg', '6 reps'] },
    { id: early.id, number: 1, sets: ['8 reps · 88 lb'] },
  ]);
  assert.equal(report.sessions[0].estimatedMax, 50 * (1 + 5 / 30));
  assert.deepEqual(report.trend.map(({ sessionId, date, number, set }) => ({ sessionId, date, number, set })), [
    { sessionId: early.id, date, number: 1, set: '8 reps · 88 lb' },
    { sessionId: later.id, date, number: 2, set: '5 reps · 50 kg' },
  ]);
  assert.equal(report.trend[0].value, report.sessions[1].estimatedMax);
  assert.equal(report.trend[1].value, report.sessions[0].estimatedMax);
  const missing = await (await fetch(`${origin}/api/progress?exercise=${missingId}`)).json() as {
    selected: { name: string; missingNote: boolean }; sessions: Array<{ sets: string[] }>;
    trend: unknown[];
  };
  assert.equal(missing.selected.name, 'Historic carry');
  assert.equal(missing.selected.missingNote, true);
  assert.deepEqual(missing.sessions[0].sets, ['20 yd']);
  assert.deepEqual(missing.trend, []);

  const post = (route: string, body: unknown, source = origin) => fetch(`${origin}/api/${route}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: source }, body: JSON.stringify(body),
  });
  assert.equal((await post('exports', { format: 'csv' }, 'https://example.com')).status, 403);
  assert.equal((await post('exports', { format: '../workouts/escape.json' })).status, 400);
  for (const [format, text] of [['csv', toCsv(originalData)], ['json', toJson(originalData)]] as const) {
    const response = await post('exports', { format });
    assert.equal(response.status, 200);
    const { path } = await response.json() as { path: string };
    assert.match(path, /^Set Ledger\/Exports\/rep-journal-\d{4}-\d{2}-\d{2}-[0-9a-f]{8}\.(csv|json)$/);
    assert.equal(await readFile(join(root, path), 'utf8'), text);
  }
  const options = { from: date, to: date, goal: 'Build strength', equipment: 'Rack', daysPerWeek: 3, includeNotes: false };
  assert.equal((await post('context', { ...options, to: '2023-12-31' })).status, 400);
  assert.equal((await post('context', { ...options, daysPerWeek: 2.5 })).status, 400);
  const preview = await (await post('context', options)).json() as { text: string };
  assert.match(preview.text, /"availableEquipment": "Rack"/);
  assert.match(preview.text, /"daysPerWeek": 3/);
  assert.match(preview.text, /"latestEstimated1RM"/);
  assert.doesNotMatch(preview.text, /Private note/);
  const withNotes = await (await post('context', { ...options, includeNotes: true })).json() as { text: string };
  assert.match(withNotes.text, /Private note/);
  assert.equal(await readFile(earlyPath, 'utf8'), JSON.stringify(early));
  assert.equal(await readFile(notePath, 'utf8'), noteText);

  const corruptPath = join(folderPath, `${date}-3.json`);
  await writeFile(corruptPath, 'broken');
  assert.equal((await post('exports', { format: 'automatic-csv' })).status, 400);
  assert.equal(await readFile(csvPath, 'utf8'), toCsv(originalData));
  await rm(corruptPath);
  assert.equal((await post('exports', { format: 'automatic-csv' })).status, 200);

  const backupPath = `${csvPath}.bak`;
  await rename(csvPath, backupPath);
  await mkdir(csvPath);
  const change = { kind: 'remove', original: later.sets[1] };
  const saved = await post('workout-edits', { date, workoutId: later.id, change });
  assert.equal(saved.status, 200);
  assert.equal(parseWorkout(await readFile(laterPath, 'utf8')).sets.length, 2);
  assert.equal(await readFile(backupPath, 'utf8'), toCsv(originalData));
  const { automaticCsvError } = await (await fetch(`${origin}/api/exports`)).json() as { automaticCsvError?: string };
  assert.ok(automaticCsvError);
  await rmdir(csvPath);
  assert.equal((await post('exports', { format: 'automatic-csv' })).status, 200);
  assert.equal(await readFile(csvPath, 'utf8'), toCsv((await readImportVault(root)).data));
});
