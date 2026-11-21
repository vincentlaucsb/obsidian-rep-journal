import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { test } from 'node:test';
import { matchesExerciseName, starterExercises } from '../src/catalog.ts';
import { toCsv, toJson } from '../src/exports.ts';
import { createWorkout, makeId, type ExerciseDetails, type WorkoutSet } from '../src/model.ts';
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

void test('persists exercise notes and hidden workout JSON through a reload and correction', async () => {
  const vault = new MemoryVault();
  const writer = new LedgerRepository(vault);
  const exercise = await writer.saveExercise(details);
  assert.match(exercise.path, /^Rep Journal\/Exercises\//);
  const date = '2026-10-01';
  const first: WorkoutSet = {
    id: makeId(), exerciseId: exercise.id, exerciseName: exercise.name, reps: 5,
    load: { mode: 'weight', value: 60, unit: 'kg' }, warmup: false,
  };
  const created = await writer.saveWorkout(date, { kind: 'add', set: first });
  assert.equal(created.path, 'Rep Journal/Workouts/2026-10-01.json');
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
    'Rep Journal/Workouts/2026-10-03-2.json',
    'Rep Journal/Workouts/2026-10-03-3.json',
    'Rep Journal/Workouts/2026-10-03.json',
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
  const firstPath = 'Rep Journal/Workouts/2026-10-03.json';
  const otherWorkout = createWorkout(date);
  const create = vault.create.bind(vault);
  vault.create = async (path, text) => {
    if (path === firstPath) await create(firstPath, JSON.stringify(otherWorkout));
    return create(path, text);
  };
  const saved = await repository.saveWorkout(date, { kind: 'notes', original: '', value: 'New workout' });
  assert.equal(saved.path, 'Rep Journal/Workouts/2026-10-03-2.json');
  assert.deepEqual(JSON.parse(await vault.adapter.read(firstPath)), otherWorkout);
});

void test('date numbering includes legacy sessions across roots and continues above existing suffixes', async () => {
  const vault = new MemoryVault();
  const repository = new LedgerRepository(vault);
  const date = '2026-10-03';
  const legacy = createWorkout(date);
  const legacyPath = `Set Ledger/Workouts/${date}-${legacy.id}.json`;
  await vault.createFolder('Set Ledger');
  await vault.createFolder('Set Ledger/Workouts');
  await vault.create(legacyPath, JSON.stringify(legacy));
  await vault.createFolder('Rep Journal');
  const second = await repository.saveWorkout(date, { kind: 'notes', original: '', value: 'Second session' });
  assert.equal(second.path, 'Rep Journal/Workouts/2026-10-03-2.json');
  await vault.create('Rep Journal/Workouts/2026-10-03-5.json', JSON.stringify(createWorkout(date)));
  const later = await repository.saveWorkout(date, { kind: 'notes', original: '', value: 'Later session' });
  assert.equal(later.path, 'Rep Journal/Workouts/2026-10-03-6.json');
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
  await vault.createFolder('Set Ledger');
  await vault.createFolder('Set Ledger/Exercises');
  const properties = {
    set_ledger_id: makeId(), set_ledger_schema: 1, exercise_name: 'Bench Press',
    load_mode: 'weight', weight_unit: 'lb',
  };
  await vault.create('Set Ledger/Exercises/Bench Press.md', `---\n${JSON.stringify(properties)}\n---\n`);

  const [exercise] = (await repository.read()).exercises;
  assert.ok(exercise.tags.some(({ group, name }) => group === 'role' && name === 'Main'));
  assert.ok(exercise.tags.some(({ group, name }) => group === 'region' && name === 'Upper Body'));
  await repository.saveExercise({ ...exercise, tags: [] }, exercise);
  assert.deepEqual((await repository.read()).exercises[0].tags, []);
});

void test('automatic CSV updates one hidden file while manual exports save dated copies', async () => {
  const vault = new MemoryVault();
  const repository = new LedgerRepository(vault);
  await vault.createFolder('Set Ledger');
  const exercise = await repository.saveExercise(details);
  const date = '2026-10-01';
  const set: WorkoutSet = {
    id: makeId(), exerciseId: exercise.id, exerciseName: exercise.name, reps: 5,
    load: { mode: 'weight', value: 60, unit: 'kg' }, warmup: false,
  };
  const saved = await repository.saveWorkout(date, { kind: 'add', set });
  await repository.refreshAutomaticCsv();
  const path = 'Set Ledger/Exports/rep-journal.csv';
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
  assert.match(snapshot, /^Set Ledger\/Exports\/rep-journal-/);

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

void test('keeps preview workout and exercise data in place when the new folder appears', async () => {
  const vault = new MemoryVault();
  const repository = new LedgerRepository(vault);
  await vault.createFolder('Set Ledger');
  const exercise = await repository.saveExercise(details);
  const oldWorkout = await repository.saveWorkout('2026-10-01', { kind: 'notes', original: '', value: 'Preview data' });
  assert.match(exercise.path, /^Set Ledger\/Exercises\//);
  assert.match(oldWorkout.path, /^Set Ledger\/Workouts\//);
  await vault.createFolder('Rep Journal');
  const newWorkout = await repository.saveWorkout('2026-10-02', { kind: 'notes', original: '', value: 'New entry' });
  const updated = await repository.saveWorkout(oldWorkout.workout.date, {
    kind: 'notes', original: 'Preview data', value: 'Updated preview data',
  }, oldWorkout);
  const renamed = await repository.saveExercise({ ...details, name: 'Renamed exercise' }, exercise);
  const data = await repository.read();
  assert.equal(renamed.path, exercise.path);
  assert.equal(updated.path, oldWorkout.path);
  assert.match(newWorkout.path, /^Rep Journal\/Workouts\//);
  assert.deepEqual(data.exercises, [renamed]);
  assert.deepEqual(data.workouts, [updated, newWorkout]);
  assert.deepEqual(data.issues, []);
});
