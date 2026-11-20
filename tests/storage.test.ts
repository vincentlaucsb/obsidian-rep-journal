import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { test } from 'node:test';
import { toCsv, toJson } from '../src/exports.ts';
import { makeId, type ExerciseDetails, type WorkoutSet } from '../src/model.ts';
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
  assert.match(created.path, /^Rep Journal\/Workouts\//);
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
  assert.ok((await vault.adapter.read(exercise.path)).endsWith('## Form cue\nKeep elbows under the bar.\n'));
  const finished = await reader.read();
  assert.equal(finished.exercises[0].name, 'Barbell bench press');
  assert.deepEqual(finished.workouts[0].workout.sets.map((entry) => entry.reps), [6, 4]);
  assert.deepEqual(finished.issues, []);
  const csv = await reader.writeExport('csv', toCsv(finished));
  assert.match(csv, /^Rep Journal\/Exports\/rep-journal-/);
  assert.match(await vault.adapter.read(csv), /Barbell bench press/);
});

void test('reports corrupt and duplicate sessions while preserving the source files', async () => {
  const vault = new MemoryVault();
  const repository = new LedgerRepository(vault);
  const workout = await repository.saveWorkout('2026-10-01', { kind: 'notes', original: '', value: 'Workout notes' });
  await vault.create('Rep Journal/Workouts/duplicate.json', await vault.adapter.read(workout.path));
  await vault.create('Rep Journal/Workouts/corrupt.json', '{');
  const data = await repository.read();
  assert.equal(data.workouts.length, 0);
  assert.equal(data.issues.length, 2);
  assert.ok(data.issues.some((issue) => issue.includes('duplicate.json')));
  assert.ok(data.issues.some((issue) => issue.includes('corrupt.json')));
  assert.throws(() => toJson(data), /could not be read/);
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
