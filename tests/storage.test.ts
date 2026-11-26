import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { test } from 'node:test';
import { matchesExerciseName, starterExercises } from '../src/catalog.ts';
import { toCsv, toJson } from '../src/exports.ts';
import { maxPlanBytes, type ExerciseEditInput } from '../src/journal-workflow.ts';
import { createWorkout, makeId, type ExerciseDetails, type WorkoutSet } from '../src/model.ts';
import { normalizeJournalFolder, parseJournalFolder } from '../src/journal-paths.ts';
import { createObsidianJournalAdapter } from '../src/obsidian-journal-adapter.ts';
import { MemoryVault } from './fixtures/obsidian.ts';

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'obsidian') return { url: new URL('./fixtures/obsidian.ts', import.meta.url).href, shortCircuit: true };
    return nextResolve(specifier, context);
  },
});
const { LedgerRepository } = await import('../src/repository.ts');
hooks.deregister();

const details: ExerciseDetails = {
  name: 'Bench press', aliases: ['Bench'], equipment: 'Barbell', loadMode: 'weight', unit: 'lb', archived: false,
};

void test('native dated plan discovery reads valid notes in the configured plan year folders', async () => {
  const vault = new MemoryVault();
  const root = 'Training/Strength';
  const repository = new LedgerRepository(vault, root);
  const exercise = await repository.saveExercise(details);
  const plans = `${root}/Plans`;
  const year = `${plans}/2024`;
  const first = `${year}/2024-02-29.md`;
  const second = `${year}/2024-02-29 - Assistance.md`;
  const invalid = `${year}/2024-03-01.md`;
  const manual = 'Templates/2024-02-29.md';
  const markdown = '# Strength\n\n## Main\n\n### Bench\n';
  for (const folder of [plans, year, `${plans}/2025`, `${year}/Nested`, 'Templates']) await vault.createFolder(folder);
  for (const path of [first, second, manual, `${plans}/2024-02-29.md`, `${plans}/2025/2024-02-29.md`,
    `${year}/2024-02-30.md`, `${year}/2024-02-291.md`, `${year}/2024-02-29 - .md`,
    `${year}/Workout 2024-02-29.md`, `${year}/Nested/2024-02-29.md`]) {
    await vault.create(path, markdown);
  }
  await vault.create(invalid, '# Missing sections\n');
  const oversized = await vault.create(`${year}/2024-03-02.md`, markdown);
  oversized.stat.size = maxPlanBytes + 1;
  const adapter = createObsidianJournalAdapter(vault, repository, {
    vaultKey: 'memory-vault', weightUnit: () => 'lb',
    reportExportError: (error) => assert.fail(String(error)), openExerciseNote: () => undefined,
  });
  const data = await adapter.loadJournal();
  assert.deepEqual(data.issues, []);
  assert.deepEqual(data.datedPlans.map(({ date, path, title, plan }) => ({ date, path, title, exercise: plan.sections[0].exercises[0].exerciseId })),
    [second, first].map((path) => ({ date: '2024-02-29', path, title: 'Strength', exercise: exercise.id })));
  assert.equal((await adapter.loadJournal()).datedPlans[0], data.datedPlans[0]);
  await vault.adapter.write(second, markdown.replace('Strength', 'Workout!'));
  assert.equal((await adapter.loadJournal()).datedPlans[0].title, 'Workout!');
  const archived = await repository.saveExercise({ ...exercise, archived: true }, exercise);
  assert.deepEqual((await adapter.loadJournal()).datedPlans, []);
  await repository.saveExercise({ ...archived, archived: false }, archived);
  assert.equal((await adapter.loadJournal()).datedPlans.length, 2);
  const list = await adapter.listPlans();
  assert.ok(list.some(({ path }) => path === manual));
  assert.ok(list.some(({ path }) => path === invalid));
  assert.match((await adapter.readPlan(invalid)).issues?.[0].message ?? '', /Add a ## heading/);
  const moved = `${year}/2024-03-03.md`;
  vault.rename(first, moved);
  assert.deepEqual((await adapter.loadJournal()).datedPlans.map(({ date, path }) => [date, path]),
    [['2024-02-29', second], ['2024-03-03', moved]]);
});

void test('native plan picker reuses both matches and misses and retries unreadable notes', async () => {
  const vault = new MemoryVault();
  const repository = new LedgerRepository(vault);
  const exercise = await repository.saveExercise(details);
  await vault.createFolder('Templates');
  const note = 'Templates/Strength.md';
  const unrelated = 'Templates/Ordinary.md';
  const markdown = '# First\n\n## Main\n\n### Bench\n';
  const file = await vault.create(note, markdown);
  await vault.create(unrelated, '# Meeting notes\n');
  let statAvailable = true;
  const adapter = createObsidianJournalAdapter(vault, repository, {
    vaultKey: 'memory-vault', weightUnit: () => 'lb', reportExportError: () => undefined, openExerciseNote: () => undefined,
    statFile: (path) => statAvailable ? vault.diskStat(path) : Promise.resolve(undefined),
  });
  const reads: string[] = [];
  let fail = true;
  const read = vault.adapter.read;
  vault.adapter.read = (path) => {
    if (path.startsWith('Templates/')) reads.push(path);
    if (path === note && fail) {
      fail = false;
      return Promise.reject(new Error('Temporary read failure'));
    }
    return read(path);
  };
  assert.deepEqual(await adapter.listPlans(), []);
  assert.deepEqual(reads.splice(0), [note, unrelated]);
  assert.deepEqual(await adapter.listPlans(), [{ path: note, title: 'First' }]);
  assert.deepEqual(reads.splice(0), [note]);
  assert.deepEqual(await adapter.listPlans(), [{ path: note, title: 'First' }]);
  assert.equal(reads.length, 0);

  const { mtime } = file.stat;
  await vault.adapter.write(note, markdown.replace('First', 'Other'));
  file.stat.mtime = mtime;
  assert.deepEqual(await adapter.listPlans(), [{ path: note, title: 'Other' }]);
  assert.deepEqual(reads.splice(0), [note]);

  const archived = await repository.saveExercise({ ...exercise, archived: true }, exercise);
  assert.deepEqual(await adapter.listPlans(), []);
  assert.deepEqual(reads.splice(0), [note]);
  await repository.saveExercise({ ...archived, archived: false }, archived);
  const renamed = 'Templates/New name.md';
  vault.rename(note, renamed);
  assert.deepEqual(await adapter.listPlans(), [{ path: renamed, title: 'Other' }]);
  assert.deepEqual(reads.splice(0), [renamed]);
  vault.delete(renamed);
  assert.deepEqual(await adapter.listPlans(), []);
  assert.equal(reads.length, 0);

  statAvailable = false;
  assert.deepEqual(await adapter.listPlans(), []);
  await vault.adapter.write(unrelated, markdown);
  assert.deepEqual(await adapter.listPlans(), [{ path: unrelated, title: 'First' }]);
  assert.deepEqual(reads, [unrelated, unrelated]);
});

void test('the native workout log uses the vault repository without writing on startup', async () => {
  const vault = new MemoryVault();
  const repository = new LedgerRepository(vault);
  const bench = await repository.saveExercise(details);
  const row = await repository.saveExercise({ ...details, name: 'Row', aliases: [] });
  await vault.createFolder('Exercise');
  const path = 'Exercise/Upper body.md';
  await vault.create(path, '# Upper body\n\n## Pair\nMode: superset\n\n### Bench\n\n### Row\n');
  const exportErrors: unknown[] = [];
  const adapter = createObsidianJournalAdapter(vault, repository, {
    vaultKey: 'memory-vault', weightUnit: () => 'lb',
    reportExportError: (error) => { exportErrors.push(error); }, openExerciseNote: () => undefined,
  });
  const journal = await adapter.loadJournal();
  assert.equal(vault.getFolderByPath('Rep Journal/Exports'), null);
  assert.equal(journal.unit, 'lb');
  assert.deepEqual(await adapter.listPlans(), [{ path, title: 'Upper body' }]);
  const { plan } = await adapter.readPlan(path);
  assert.deepEqual(plan?.sections[0].exercises.map(({ exerciseId }) => exerciseId), [bench.id, row.id]);

  const input = { date: journal.today, workoutId: null, exerciseId: bench.id, setId: adapter.makeSetId(), values: { weight: 45, reps: 8 } };
  const [first, retry] = await Promise.all([adapter.saveSet(input, 'kg'), adapter.saveSet(input, 'kg')]);
  assert.deepEqual(first, retry);
  assert.equal(first.path, `Rep Journal/Workouts/${journal.today.slice(0, 4)}/${journal.today}.json`);
  assert.deepEqual(first.workout.sets[0].load, { mode: 'weight', value: 45, unit: 'kg' });
  const append = await adapter.saveSet({ ...input, workoutId: first.workout.id, setId: adapter.makeSetId(), exerciseId: row.id }, 'lb');
  assert.deepEqual(append.workout.sets.map(({ exerciseId }) => exerciseId), [bench.id, row.id]);

  await adapter.refreshAutomaticCsv();
  assert.match(await vault.adapter.read('Rep Journal/Exports/rep-journal.csv'), /Row/);
  const { selected, sessions, unit } = await adapter.readProgress(bench.id);
  assert.deepEqual(selected?.aliases, ['Bench']);
  assert.equal(unit, 'lb');
  assert.deepEqual(sessions.map(({ id, sets }) => ({ id, sets })), [{ id: first.workout.id, sets: ['8 reps · 99.21 lb'] }]);
  assert.ok((sessions[0].estimatedMax ?? 0) > 125);
  const data = await repository.read();
  assert.equal(await vault.adapter.read(await adapter.saveExport('csv')), toCsv(data));
  assert.equal(await vault.adapter.read(await adapter.saveExport('json')), toJson(data));
  const context = { from: journal.today, to: journal.today, goal: 'Build strength', equipment: 'Rack', daysPerWeek: 3, includeNotes: false };
  const preview = await adapter.prepareContext(context);
  assert.match(preview, /"goal": "Build strength"/);
  assert.match(preview, /"latestEstimated1RM"/);
  await assert.rejects(adapter.prepareContext({ ...context, daysPerWeek: 8 }), /Days per week/);
  assert.deepEqual(exportErrors, []);
});

void test('the native workout log corrects historical workouts and manages exercise notes', async () => {
  const vault = new MemoryVault();
  const repository = new LedgerRepository(vault);
  const exercise = await repository.saveExercise(details);
  await vault.adapter.process(exercise.path, (text) => `${text}\nPrivate setup cue.\n`);
  const opened: string[] = [];
  const adapter = createObsidianJournalAdapter(vault, repository, {
    vaultKey: 'memory-vault', weightUnit: () => 'lb',
    reportExportError: (error) => assert.fail(String(error)), openExerciseNote: ({ path }) => { opened.push(path); },
  });
  const date = '2024-01-06';
  const set: WorkoutSet = {
    id: makeId(), exerciseId: exercise.id, exerciseName: exercise.name, reps: 5,
    load: { mode: 'assistance', value: 60, unit: 'kg' }, warmup: true,
  };
  const saved = await repository.saveWorkout(date, { kind: 'add', set });
  const target = { date, workoutId: saved.workout.id };
  const edited = await adapter.editWorkout({ ...target, change: { kind: 'edit', original: set, values: { reps: 9, weight: 55 } } });
  const updated = { ...set, reps: 9, load: { ...set.load, value: 55 } };
  assert.deepEqual(edited.workout.sets[0], updated);
  await assert.rejects(adapter.editWorkout({ ...target, change: { kind: 'remove', original: set } }), /changed/);
  await adapter.editWorkout({ ...target, change: { kind: 'remove', original: edited.workout.sets[0] } });
  const noted = await adapter.editWorkout({ ...target, change: { kind: 'notes', original: '', value: 'Historical note' } });
  assert.deepEqual(noted, { ...saved, workout: { ...saved.workout, sets: [], notes: 'Historical note' } });
  await assert.rejects(adapter.editWorkout({ ...target, change: { kind: 'notes', original: '', value: 'Stale note' } }), /changed/);

  const today = await adapter.loadJournal();
  const stretch = today.starters.find(({ name }) => name === 'Hip Flexor Stretch');
  assert.ok(stretch);
  const [starter, sameStarter] = await Promise.all([adapter.addStarter(stretch.id), adapter.addStarter(stretch.id)]);
  assert.deepEqual(starter, sameStarter);
  assert.equal(starter.id, stretch.id);
  assert.ok(!(await adapter.loadJournal()).starters.some(({ id }) => id === starter.id));
  const historicalInput = { date, workoutId: null, exerciseId: starter.id, setId: adapter.makeSetId(), values: { time: '1:15' } };
  await assert.rejects(adapter.saveSet(historicalInput, 'lb'), /date changed/);
  const historical = await adapter.saveSet({ ...historicalInput, selectedDate: true }, 'lb');
  assert.equal(historical.path, `Rep Journal/Workouts/${date.slice(0, 4)}/${date}-2.json`);
  assert.equal(historical.workout.sets[0].durationSeconds, 75);
  const appended = await adapter.saveSet({ ...historicalInput, selectedDate: true, workoutId: historical.workout.id, setId: adapter.makeSetId() }, 'lb');
  assert.equal(appended.workout.sets.length, 2);

  const noteOnly = {
    date: today.today, workoutId: null, newWorkoutId: adapter.makeSetId(),
    change: { kind: 'notes' as const, original: '', value: 'Today note' },
  };
  const notes = await Promise.all([adapter.editWorkout(noteOnly), adapter.editWorkout(noteOnly)]);
  assert.deepEqual(notes[0], notes[1]);
  assert.equal(notes[0].workout.id, noteOnly.newWorkoutId);
  const historicalNote = await adapter.editWorkout({ ...noteOnly, date, selectedDate: true, newWorkoutId: adapter.makeSetId() });
  assert.equal(historicalNote.path, `Rep Journal/Workouts/${date.slice(0, 4)}/${date}-3.json`);
  assert.equal(historicalNote.workout.notes, noteOnly.change.value);

  const input: ExerciseEditInput = {
    exerciseId: exercise.id, original: exercise,
    values: { name: 'Paused Bench', aliases: ['Paused, wide grip'], measurements: ['reps', 'time'], distanceUnit: 'm',
      tags: [{ group: 'role', name: 'Auxiliary' }], archived: true },
  };
  const renamed = await adapter.saveExercise(input, 'kg');
  assert.equal(renamed.path, exercise.path);
  assert.equal(renamed.id, exercise.id);
  assert.deepEqual(renamed.aliases, ['Paused, wide grip', exercise.name]);
  assert.equal(renamed.archived, true);
  assert.ok((await vault.adapter.read(exercise.path)).endsWith('Private setup cue.\n'));
  await assert.rejects(adapter.saveExercise(input, 'kg'), /changed/);
  const active = await adapter.saveExercise({ ...input, original: renamed, values: { ...input.values, archived: false } }, 'kg');
  assert.equal(active.archived, false);
  adapter.openExerciseNote?.(active);
  assert.deepEqual(opened, [exercise.path]);

  const newExercise = { ...input, exerciseId: adapter.makeSetId(), original: null,
    values: { ...input.values, name: 'Overhead Press', archived: false } };
  const created = await adapter.saveExercise(newExercise, 'lb');
  assert.equal(created.path, 'Rep Journal/Exercises/Overhead Press.md');
  assert.match(await vault.adapter.read(created.path), /## Exercise guides/);
  assert.deepEqual(await adapter.saveExercise(newExercise, 'lb'), created);
  assert.equal((await adapter.loadJournal()).workouts.length, 4);
});

void test('persists exercise notes and hidden workout JSON through a reload and correction', async () => {
  const vault = new MemoryVault();
  const writer = new LedgerRepository(vault);
  const exercise = await writer.saveExercise(details);
  assert.equal(exercise.path, 'Rep Journal/Exercises/Bench press.md');
  assert.match(await vault.adapter.read(exercise.path), /## Exercise guides/);
  const date = '2026-10-01';
  const first: WorkoutSet = {
    id: makeId(), exerciseId: exercise.id, exerciseName: exercise.name, reps: 5,
    load: { mode: 'weight', value: 60, unit: 'kg' }, warmup: false,
  };
  const created = await writer.saveWorkout(date, { kind: 'add', set: first });
  assert.equal(created.path, 'Rep Journal/Workouts/2026/2026-10-01.json');
  assert.equal(vault.getFileByPath(created.path), null);
  const reader = new LedgerRepository(vault);
  const loaded = await reader.read();
  assert.deepEqual(loaded.exercises, [exercise]);
  assert.deepEqual(loaded.workouts, [created]);

  const second = { ...first, id: makeId(), reps: 4 };
  await writer.saveWorkout(date, { kind: 'add', set: second }, created);
  await reader.saveWorkout(date, { kind: 'edit', original: first, set: { ...first, reps: 6 } }, created);
  await assert.rejects(reader.saveWorkout(date, { kind: 'remove', original: first }, created), /changed/);

  await vault.adapter.process(exercise.path, (text) => `${text}\n## Form cue\nKeep elbows under the bar.\n`);
  const renamed = await reader.saveExercise({ ...details, name: 'Barbell bench press' }, exercise);
  assert.equal(renamed.id, exercise.id);
  assert.deepEqual(renamed.aliases, ['Bench', 'Bench press']);
  assert.ok((await vault.adapter.read(exercise.path)).endsWith('## Form cue\nKeep elbows under the bar.\n'));
  const finished = await reader.read();
  assert.equal(finished.exercises[0].name, 'Barbell bench press');
  assert.deepEqual(finished.workouts[0].workout.sets.map((entry) => entry.reps), [6, 4]);
  assert.deepEqual(finished.issues, []);
  const csv = await reader.writeExport('csv', toCsv(finished));
  assert.match(csv, /^Rep Journal\/Exports\/rep-journal-/);
  assert.match(await vault.adapter.read(csv), /Barbell bench press/);
});

void test('concurrent sessions use sequential date-based filenames and keep their own IDs', async () => {
  const vault = new MemoryVault();
  const date = '2026-10-03';
  const sessions = await Promise.all(['First', 'Second', 'Third'].map((value) =>
    new LedgerRepository(vault).saveWorkout(date, { kind: 'notes', original: '', value })));
  assert.deepEqual(sessions.map(({ path }) => path).sort(), [
    'Rep Journal/Workouts/2026/2026-10-03-2.json',
    'Rep Journal/Workouts/2026/2026-10-03-3.json',
    'Rep Journal/Workouts/2026/2026-10-03.json',
  ]);
  assert.equal(new Set(sessions.map(({ workout }) => workout.id)).size, 3);
  for (const session of sessions) {
    assert.deepEqual(JSON.parse(await vault.adapter.read(session.path)), session.workout);
  }
});

void test('date-based creation retries when another writer takes the chosen filename', async () => {
  const vault = new MemoryVault();
  const repository = new LedgerRepository(vault);
  const date = '2026-10-03';
  const firstPath = 'Rep Journal/Workouts/2026/2026-10-03.json';
  const otherWorkout = createWorkout(date);
  const create = vault.create.bind(vault);
  vault.create = async (path, text) => {
    if (path === firstPath) await create(firstPath, JSON.stringify(otherWorkout));
    return create(path, text);
  };
  const saved = await repository.saveWorkout(date, { kind: 'notes', original: '', value: 'New workout' });
  assert.equal(saved.path, 'Rep Journal/Workouts/2026/2026-10-03-2.json');
  assert.deepEqual(JSON.parse(await vault.adapter.read(firstPath)), otherWorkout);
});

void test('date numbering includes flat sessions and continues above existing suffixes', async () => {
  const vault = new MemoryVault();
  const repository = new LedgerRepository(vault);
  const date = '2026-10-03';
  const legacy = createWorkout(date);
  const legacyPath = `Rep Journal/Workouts/${date}-${legacy.id}.json`;
  await vault.createFolder('Rep Journal');
  await vault.createFolder('Rep Journal/Workouts');
  await vault.create(legacyPath, JSON.stringify(legacy));
  const second = await repository.saveWorkout(date, { kind: 'notes', original: '', value: 'Second session' });
  assert.equal(second.path, 'Rep Journal/Workouts/2026/2026-10-03-2.json');
  await vault.createFolder('Rep Journal/Workouts/2025');
  await vault.create('Rep Journal/Workouts/2025/2026-10-03-5.json', JSON.stringify(createWorkout(date)));
  const later = await repository.saveWorkout(date, { kind: 'notes', original: '', value: 'Later session' });
  assert.equal(later.path, 'Rep Journal/Workouts/2026/2026-10-03-6.json');
  const edited = await repository.saveWorkout(date, { kind: 'notes', original: '', value: 'Legacy session' }, {
    path: legacyPath, workout: legacy,
  });
  assert.equal(edited.path, legacyPath);
  assert.equal(edited.workout.id, legacy.id);
  assert.equal((await repository.read()).workouts.length, 4);
});

void test('starter notes are created on selection and keep one ID when renamed and selected again', async () => {
  const vault = new MemoryVault();
  const repository = new LedgerRepository(vault);
  const before = await repository.read();
  const press = starterExercises(before.exercises).find((entry) => matchesExerciseName(entry, 'Military Press', true));
  assert.ok(press);
  assert.deepEqual(before.exercises, []);
  const initial = await repository.saveStarter(press);
  assert.doesNotMatch(await vault.adapter.read(initial.path), /"equipment"\s*:/);
  const renamed = await repository.saveExercise({ ...initial, name: 'Military Press' }, initial);
  assert.equal(renamed.id, initial.id);
  assert.ok(renamed.aliases.includes('Overhead Press'));
  assert.ok(!renamed.aliases.includes('Military Press'));
  assert.equal((await repository.saveStarter(press)).id, renamed.id);
  assert.deepEqual((await repository.read()).exercises, [renamed]);
});

void test('older bench press notes show starter tags and keep an explicit empty list', async () => {
  const vault = new MemoryVault();
  const repository = new LedgerRepository(vault);
  await vault.createFolder('Rep Journal');
  await vault.createFolder('Rep Journal/Exercises');
  const properties = {
    set_ledger_id: makeId(), set_ledger_schema: 1, exercise_name: 'Bench Press',
    load_mode: 'weight', weight_unit: 'lb',
  };
  await vault.create('Rep Journal/Exercises/Bench Press.md', `---\n${JSON.stringify(properties)}\n---\n`);

  const [exercise] = (await repository.read()).exercises;
  assert.ok(exercise.tags.some(({ group, name }) => group === 'role' && name === 'Main'));
  assert.ok(exercise.tags.some(({ group, name }) => group === 'region' && name === 'Upper Body'));
  await repository.saveExercise({ ...exercise, tags: [] }, exercise);
  assert.deepEqual((await repository.read()).exercises[0].tags, []);
});

void test('tidying an exercise preserves its ID, custom notes and workout references', async () => {
  const vault = new MemoryVault();
  const repository = new LedgerRepository(vault);
  await vault.createFolder('Rep Journal');
  await vault.createFolder('Rep Journal/Exercises');
  const id = makeId();
  const properties = {
    set_ledger_id: id, set_ledger_schema: 1, exercise_name: 'Bench Press',
    load_mode: 'weight', weight_unit: 'lb', sources: ['https://example.org/my-guide'],
  };
  const oldPath = `Rep Journal/Exercises/Bench-Press-${id}.md`;
  const original = `---\n${JSON.stringify(properties)}\n---\n\nMy setup cue.\n`;
  await vault.create(oldPath, original);
  await vault.create('Rep Journal/Exercises/bench press.md', 'An unrelated note.');
  const set: WorkoutSet = { id: makeId(), exerciseId: id, exerciseName: 'Bench Press', reps: 5, warmup: false };
  await repository.saveWorkout('2026-10-01', { kind: 'add', set });
  const rename: Parameters<typeof repository.tidyExerciseNotes>[0] = (file, path) => Promise.resolve(vault.rename(file.path, path));

  assert.deepEqual(await repository.tidyExerciseNotes(rename), { renamed: 1, guidesAdded: 1, issues: [] });
  assert.equal(await vault.adapter.exists(oldPath), false);
  assert.equal(await vault.adapter.read('Rep Journal/Exercises/bench press.md'), 'An unrelated note.');
  const after = await repository.read();
  const [exercise] = after.exercises;
  assert.equal(exercise.path, 'Rep Journal/Exercises/Bench Press (2).md');
  assert.equal(exercise.id, after.workouts[0].workout.sets[0].exerciseId);
  const updated = await vault.adapter.read(exercise.path);
  assert.ok(updated.startsWith(original));
  assert.match(updated, /## Exercise guides[\s\S]*https:\/\/example\.org\/my-guide/);
  assert.deepEqual(await repository.tidyExerciseNotes(rename), { renamed: 0, guidesAdded: 0, issues: [] });
  assert.equal(await vault.adapter.read(exercise.path), updated);
});

void test('automatic CSV updates one hidden file while manual exports save dated copies', async () => {
  const vault = new MemoryVault();
  const repository = new LedgerRepository(vault);
  await vault.createFolder('Rep Journal');
  const exercise = await repository.saveExercise(details);
  const date = '2026-10-01';
  const set: WorkoutSet = {
    id: makeId(), exerciseId: exercise.id, exerciseName: exercise.name, reps: 5,
    load: { mode: 'weight', value: 60, unit: 'kg' }, warmup: false,
  };
  const saved = await repository.saveWorkout(date, { kind: 'add', set });
  await repository.refreshAutomaticCsv();
  const path = 'Rep Journal/Exports/rep-journal.csv';
  assert.equal(vault.getFileByPath(path), null);
  assert.equal(await vault.adapter.read(path), toCsv(await repository.read()));

  let writes = 0;
  const write = vault.adapter.write;
  vault.adapter.write = async (target, text) => {
    writes++;
    await write(target, text);
  };
  await repository.refreshAutomaticCsv();
  assert.equal(writes, 0);

  await repository.saveExercise({ ...details, name: 'Barbell bench press' }, exercise);
  await repository.refreshAutomaticCsv();
  assert.equal(writes, 1);
  const renamedCsv = await vault.adapter.read(path);
  assert.equal(renamedCsv, toCsv(await repository.read()));
  assert.match(renamedCsv, /Barbell bench press/);
  const snapshot = await repository.writeExport('csv', renamedCsv);
  assert.match(snapshot, /^Rep Journal\/Exports\/rep-journal-/);

  await repository.saveWorkout(date, { kind: 'remove', original: set }, saved);
  await repository.refreshAutomaticCsv();
  assert.equal(writes, 2);
  assert.equal(await vault.adapter.read(path), toCsv(await repository.read()));
  assert.doesNotMatch(await vault.adapter.read(path), /Barbell bench press/);
  assert.equal(await vault.adapter.read(snapshot), renamedCsv);
});

void test('automatic CSV serializes overlapping refreshes and can retry a failed write', async () => {
  const vault = new MemoryVault();
  const repository = new LedgerRepository(vault);
  await repository.refreshAutomaticCsv();
  const path = 'Rep Journal/Exports/rep-journal.csv';
  const initial = await vault.adapter.read(path);
  const exercise = await repository.saveExercise(details);
  const date = '2026-10-01';
  const set: WorkoutSet = {
    id: makeId(), exerciseId: exercise.id, exerciseName: exercise.name, reps: 5,
    load: { mode: 'weight', value: 60, unit: 'kg' }, warmup: false,
  };
  const saved = await repository.saveWorkout(date, { kind: 'add', set });
  const write = vault.adapter.write;
  vault.adapter.write = async () => { throw new Error('CSV is locked'); };
  await assert.rejects(repository.refreshAutomaticCsv(), /CSV is locked/);
  assert.equal(await vault.adapter.read(path), initial);
  assert.deepEqual((await repository.read()).workouts, [saved]);

  let signalWrite!: () => void;
  const writing = new Promise<void>((resolve) => { signalWrite = resolve; });
  let resumeWrite!: () => void;
  const paused = new Promise<void>((resolve) => { resumeWrite = resolve; });
  const writes: string[] = [];
  vault.adapter.write = async (target, text) => {
    writes.push(text);
    signalWrite();
    await paused;
    await write(target, text);
  };

  const retry = repository.refreshAutomaticCsv();
  await writing;
  const edited = { ...set, reps: 6 };
  await repository.saveWorkout(date, { kind: 'edit', original: set, set: edited }, saved);
  const next = repository.refreshAutomaticCsv();
  assert.equal(next, retry);
  assert.equal(writes.length, 1);
  resumeWrite();
  await next;
  assert.equal(writes.length, 2);
  assert.equal(await vault.adapter.read(path), toCsv(await repository.read()));
  assert.match(writes[1], /,6,"weight",60,"kg",/);
});

void test('native set saves reuse ledger bodies and validate hidden JSON changes before exporting', async () => {
  const vault = new MemoryVault();
  const stats: string[] = [];
  const repository = new LedgerRepository(vault, undefined, async (path) => {
    stats.push(path);
    return vault.diskStat(path);
  });
  const exercise = await repository.saveExercise(details);
  const date = '2026-10-01';
  const set: WorkoutSet = { id: makeId(), exerciseId: exercise.id, exerciseName: exercise.name, reps: 5,
    load: { mode: 'weight', value: 60, unit: 'lb' }, warmup: false };
  const target = await repository.saveWorkout(date, { kind: 'add', set });
  const historical = await repository.saveWorkout('2026-09-30', { kind: 'add', set: { ...set, id: makeId(), reps: 4 } });
  const path = 'Rep Journal/Exports/rep-journal.csv';
  const errors: unknown[] = [];
  const adapter = createObsidianJournalAdapter(vault, repository, {
    vaultKey: 'memory-vault', weightUnit: () => 'lb', reportExportError: (error) => { errors.push(error); }, openExerciseNote: () => undefined,
  });
  const refresh = repository.refreshAutomaticCsv.bind(repository);
  let automatic: Promise<void> | undefined;
  repository.refreshAutomaticCsv = (request) => {
    automatic = refresh(request);
    return automatic;
  };
  const csvUpdate = () => { assert.ok(automatic); return automatic; };
  const reads: string[] = [];
  const read = vault.adapter.read;
  vault.adapter.read = (target) => { reads.push(target); return read(target); };
  const saved = await adapter.saveSet({ date, selectedDate: true, workoutId: target.workout.id, exerciseId: exercise.id,
    setId: makeId(), values: { weight: 65, reps: 6 } }, 'lb');
  await csvUpdate();
  assert.deepEqual(reads.filter((entry) => entry === exercise.path || entry === historical.path).sort(), [exercise.path, historical.path].sort());
  assert.equal(reads.filter((entry) => entry === target.path).length, 2);
  assert.equal(stats.filter((entry) => entry === historical.path).length, 2);
  assert.equal(await read(path), toCsv(await repository.read()));

  const process = vault.adapter.process;
  const historicalWorkout = { ...historical.workout, sets: [{ ...historical.workout.sets[0], reps: 7 }] };
  vault.adapter.process = async (target, transform) => {
    await vault.adapter.write(historical.path, `${JSON.stringify(historicalWorkout, null, 2)}\n`);
    return process(target, transform);
  };
  await adapter.editWorkout({ date, workoutId: saved.workout.id, change: { kind: 'notes', original: '', value: 'New note' } });
  await csvUpdate();
  const complete = await read(path);
  assert.equal(complete, toCsv(await repository.read()));
  assert.match(complete, /,7,"weight",60,"lb",/);

  vault.adapter.process = async (target, transform) => {
    await vault.create('Rep Journal/Workouts/copy.json', await read(historical.path));
    return process(target, transform);
  };
  await adapter.editWorkout({ date, workoutId: saved.workout.id, change: { kind: 'notes', original: 'New note', value: 'Another note' } });
  await assert.rejects(csvUpdate(), /Duplicate record ID/);
  assert.equal(errors.length, 1);
  assert.equal(await read(path), complete);
});

void test('native CSV rereads hidden workouts when the vault cannot prove their revision', async () => {
  const vault = new MemoryVault();
  const repository = new LedgerRepository(vault);
  const exercise = await repository.saveExercise(details);
  const set: WorkoutSet = { id: makeId(), exerciseId: exercise.id, exerciseName: exercise.name, reps: 8,
    load: { mode: 'weight', value: 60, unit: 'lb' }, warmup: false };
  const historical = await repository.saveWorkout('2026-09-30', { kind: 'add', set });
  const date = '2026-10-01';
  const target = await repository.saveWorkout(date, { kind: 'notes', original: '', value: 'First' });
  const originalStats = await vault.adapter.stat(historical.path);
  const stat = vault.adapter.stat;
  vault.adapter.stat = (path) => path === historical.path ? Promise.resolve(originalStats) : stat(path);

  const snapshot = await repository.readWorkoutSnapshot();
  const saved = await repository.saveWorkout(date, { kind: 'notes', original: 'First', value: 'Edited' }, target);
  const previous = await vault.adapter.read(historical.path);
  await vault.adapter.write(historical.path, previous.replace('"reps": 8', '"reps": 9'));
  assert.deepEqual(await vault.adapter.stat(historical.path), originalStats);
  await repository.refreshAutomaticCsv({ snapshot, saved });
  const text = await vault.adapter.read('Rep Journal/Exports/rep-journal.csv');
  assert.equal(text, toCsv(await repository.read()));
  assert.match(text, /,9,"weight",60,"lb",/);
});

void test('reports corrupt and duplicate sessions while preserving the source files', async () => {
  const vault = new MemoryVault();
  const repository = new LedgerRepository(vault);
  const workout = await repository.saveWorkout('2026-10-01', { kind: 'notes', original: '', value: 'Workout notes' });
  await repository.refreshAutomaticCsv();
  const csvPath = 'Rep Journal/Exports/rep-journal.csv';
  const completeCsv = await vault.adapter.read(csvPath);
  await vault.create('Rep Journal/Workouts/duplicate.json', await vault.adapter.read(workout.path));
  await vault.create('Rep Journal/Workouts/corrupt.json', '{');
  const data = await repository.read();
  assert.equal(data.workouts.length, 0);
  assert.equal(data.issues.length, 2);
  assert.ok(data.issues.some((issue) => issue.includes('duplicate.json')));
  assert.ok(data.issues.some((issue) => issue.includes('corrupt.json')));
  assert.throws(() => toJson(data), /could not be read/);
  await assert.rejects(repository.refreshAutomaticCsv(), /could not be read/);
  assert.equal(await vault.adapter.read(csvPath), completeCsv);
  assert.equal(await vault.adapter.read('Rep Journal/Workouts/corrupt.json'), '{');
});

void test('uses only the configured journal and rejects updates to records from another root', async () => {
  const vault = new MemoryVault();
  const preview = new LedgerRepository(vault, 'Set Ledger');
  const oldExercise = await preview.saveExercise(details);
  const oldWorkout = await preview.saveWorkout('2026-10-01', { kind: 'notes', original: '', value: 'Preview data' });
  assert.deepEqual(await new LedgerRepository(vault).read(), { workouts: [], exercises: [], issues: [] });

  const repository = new LedgerRepository(vault, 'Training/Rep Journal');
  const exercise = await repository.saveExercise(details);
  const workout = await repository.saveWorkout('2025-11-22', { kind: 'notes', original: '', value: 'New entry' });
  await repository.refreshAutomaticCsv();
  assert.equal(exercise.path, 'Training/Rep Journal/Exercises/Bench press.md');
  assert.equal(workout.path, 'Training/Rep Journal/Workouts/2025/2025-11-22.json');
  assert.equal(await vault.adapter.exists('Training/Rep Journal/Exports/rep-journal.csv'), true);
  await assert.rejects(repository.saveWorkout(oldWorkout.workout.date, {
    kind: 'notes', original: 'Preview data', value: 'Updated preview data',
  }, oldWorkout), /outside the workout folder/);
  await assert.rejects(repository.saveExercise(details, oldExercise), /exercise note moved/);
  assert.deepEqual(await repository.read(), { exercises: [exercise], workouts: [workout], issues: [] });
  assert.deepEqual(await preview.read(), { exercises: [oldExercise], workouts: [oldWorkout], issues: [] });
});

void test('parses and validates a vault-relative journal folder', () => {
  assert.equal(parseJournalFolder('{}'), 'Rep Journal');
  assert.equal(parseJournalFolder('{"journalFolder":"Training/Rep Journal"}'), 'Training/Rep Journal');
  assert.equal(normalizeJournalFolder('  Training\\Rep Journal  '), 'Training/Rep Journal');
  for (const path of ['', '/root', 'C:/root', '../root', 'one/../two', 'one/./two', 'one//two', 'one/NUL.txt', 'one/a./two', 'one/a?']) {
    assert.throws(() => normalizeJournalFolder(path), /vault-relative/);
  }
  for (const text of ['{', 'null', '[]', '{"journalFolder":12}']) {
    assert.throws(() => parseJournalFolder(text));
  }
});
