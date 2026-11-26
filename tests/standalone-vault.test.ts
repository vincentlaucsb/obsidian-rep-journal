import assert from 'node:assert/strict';
import fs, { mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { test, type TestContext } from 'node:test';
import { stringify } from 'yaml';
import { readImportVault } from '../scripts/import-vault.ts';
import { editStandaloneWorkout, listStandalonePlans, refreshStandaloneCsv, saveStandaloneSet, type StandaloneVault } from '../scripts/standalone-vault.ts';
import { toCsv } from '../src/exports.ts';
import { changeWorkout, createWorkout, exerciseFrontmatter, makeId, type WorkoutSet } from '../src/model.ts';
import { PlanPickerRepository } from '../src/repo/plan-repository.ts';

const folder = 'Training/Strength';
const exercise = { id: makeId(), name: 'Bench Press', aliases: ['Bench'], equipment: '', loadMode: 'weight', unit: 'lb', archived: false } as const;

async function testVault(context: TestContext) {
  const temporaryBase = resolve(tmpdir());
  const root = await mkdtemp(join(temporaryBase, 'rep-journal-standalone-vault-'));
  context.after(async () => {
    assert.equal(dirname(resolve(root)), temporaryBase);
    assert.match(basename(root), /^rep-journal-standalone-vault-/);
    await rm(root, { recursive: true, force: true });
  });
  const exercisePath = join(root, folder, 'Exercises', 'Bench Press.md');
  await mkdir(dirname(exercisePath), { recursive: true });
  const writeExercise = (archived: boolean) => writeFile(exercisePath,
    `---\n${stringify(exerciseFrontmatter({ ...exercise, aliases: [...exercise.aliases], archived }))}---\n`);
  await writeExercise(false);
  return { root, writeExercise };
}

void test('standalone plan picker reads only changed or previously unavailable candidates', async (context) => {
  const { root, writeExercise } = await testVault(context);
  await mkdir(join(root, 'Templates'));
  await mkdir(join(root, folder, 'Plans/2024'), { recursive: true });
  const template = 'Templates/Strength.md';
  const unrelated = 'Templates/Ordinary.md';
  const dated = `${folder}/Plans/2024/2024-01-02.md`;
  const markdown = '# First\n\n## Main\n\n### Bench\n';
  await writeFile(join(root, template), markdown);
  await writeFile(join(root, unrelated), '# Meetings\n');
  await writeFile(join(root, dated), '# Missing sections\n');
  const repository = new PlanPickerRepository(folder);
  const planRead = repository.read.bind(repository);
  const reads: string[] = [];
  let failed = false;
  repository.read = (paths, exercises, inspect) => planRead(paths, exercises, async (path) => {
    const file = await inspect(path);
    if (!file) return;
    return {
      revision: file.revision,
      async read() {
        reads.push(path);
        if (path === template && !failed) {
          failed = true;
          throw new Error('Temporary read failure');
        }
        return file.read();
      },
    };
  });
  const list = () => listStandalonePlans(root, folder, repository);
  const datedChoice = { path: dated, title: '2024-01-02' };
  assert.deepEqual(await list(), [datedChoice]);
  assert.deepEqual(reads.splice(0).sort(), [dated, template, unrelated].sort());
  assert.deepEqual(await list(), [datedChoice, { path: template, title: 'First' }]);
  assert.deepEqual(reads.splice(0), [template]);
  assert.deepEqual(await list(), [datedChoice, { path: template, title: 'First' }]);
  assert.equal(reads.length, 0);

  await writeFile(join(root, template), markdown.replace('First', 'Other'));
  assert.deepEqual(await list(), [datedChoice, { path: template, title: 'Other' }]);
  assert.deepEqual(reads.splice(0), [template]);
  await writeExercise(true);
  assert.deepEqual(await list(), [datedChoice]);
  assert.equal(reads.splice(0).includes(unrelated), false);
  await writeExercise(false);
  const moved = 'Templates/New name.md';
  await rename(join(root, template), join(root, moved));
  assert.deepEqual(await list(), [datedChoice, { path: moved, title: 'Other' }]);
  await rm(join(root, moved));
  assert.deepEqual(await list(), [datedChoice]);
  assert.deepEqual(reads.filter((path) => path === unrelated), []);
});

void test('standalone workout changes reuse the validated ledger and refresh when outside files change', async (context) => {
  const { root, writeExercise } = await testVault(context);
  const date = '2026-10-01';
  const set: WorkoutSet = { id: makeId(), exerciseId: exercise.id, exerciseName: exercise.name, reps: 5,
    load: { mode: 'weight', value: 60, unit: 'lb' }, warmup: false };
  const historical = changeWorkout(createWorkout('2026-09-30'), { kind: 'add', set });
  const historicalPath = join(root, folder, 'Workouts/2026-09-30.json');
  const csvPath = join(root, folder, 'Exports/rep-journal.csv');
  await mkdir(dirname(historicalPath));
  await writeFile(historicalPath, JSON.stringify(historical));
  let reads = 0;
  let outside: (() => Promise<void>) | undefined;
  const store: StandaloneVault = {
    root,
    async read(revisions) {
      reads++;
      const vault = await readImportVault(root, folder, revisions);
      const change = outside;
      outside = undefined;
      await change?.();
      return vault;
    },
  };
  const errors: string[] = [];
  const report = (error?: string) => { if (error) errors.push(error); };
  const saved = await saveStandaloneSet(store, { date, workoutId: null, exerciseId: exercise.id, setId: makeId(), values: { weight: 65, reps: 6 } }, date, 'lb', report);
  assert.equal(reads, 1);
  assert.equal(await readFile(csvPath, 'utf8'), toCsv((await readImportVault(root, folder)).data));

  const edit = (original: string, value: string) => editStandaloneWorkout(store, {
    date, workoutId: saved.workout.id, change: { kind: 'notes', original, value },
  }, date, report);
  await edit('', 'First');
  assert.equal(reads, 2);
  outside = () => writeFile(historicalPath, JSON.stringify({ ...historical, sets: [{ ...set, reps: 7 }] }));
  await edit('First', 'Second');
  assert.equal(reads, 4);
  assert.deepEqual(errors, []);
  const complete = await readFile(csvPath, 'utf8');
  assert.match(complete, /,7,"weight",60,"lb",/);
  assert.equal(complete, toCsv((await readImportVault(root, folder)).data));

  const corrupt = join(root, folder, 'Workouts/broken.json');
  outside = () => writeFile(corrupt, '{');
  await edit('Second', 'Third');
  assert.equal(reads, 6);
  assert.match(errors[0], /broken\.json/);
  assert.equal(await readFile(csvPath, 'utf8'), complete);
  await rm(corrupt);
  await writeExercise(true);
  await refreshStandaloneCsv(store);
  assert.equal(reads, 7);
  assert.equal(await readFile(csvPath, 'utf8'), toCsv((await readImportVault(root, folder)).data));
});

void test('standalone replacement retries sharing errors and checks the original bytes again', async (context) => {
  const { root } = await testVault(context);
  const date = '2026-10-01';
  const set: WorkoutSet = { id: makeId(), exerciseId: exercise.id, exerciseName: exercise.name, reps: 5,
    load: { mode: 'weight', value: 60, unit: 'lb' }, warmup: false };
  const workout = changeWorkout(createWorkout(date), { kind: 'add', set });
  const path = join(root, folder, 'Workouts', `${date}.json`);
  await mkdir(dirname(path));
  await writeFile(path, JSON.stringify(workout));
  const store = { root, read: () => readImportVault(root, folder) };
  await refreshStandaloneCsv(store);
  const workoutPath = await realpath(path);
  const csvPath = await realpath(join(root, folder, 'Exports', 'rep-journal.csv'));
  const edit = (original: WorkoutSet, reps: number) => editStandaloneWorkout(store, {
    date, workoutId: workout.id, change: { kind: 'edit', original, values: { weight: 60, reps } },
  }, date, (error) => assert.equal(error, undefined));

  const sharingError = Object.assign(new Error('File is open in another process'), { code: 'EPERM' });
  const actualRename = rename;
  const attempts = new Map<string, number>();
  let onRename: typeof rename = async (source, target) => {
    const file = String(target);
    const count = attempts.get(file) ?? 0;
    attempts.set(file, count + 1);
    if (count === 0) throw sharingError;
    return actualRename(source, target);
  };
  const mockRename: typeof rename = (source, target) => onRename(source, target);
  const renameMock = context.mock.method(fs, 'rename', mockRename);
  syncBuiltinESMExports();
  try {
    const saved = await edit(set, 6);
    assert.ok((attempts.get(workoutPath) ?? 0) >= 2);
    assert.ok((attempts.get(csvPath) ?? 0) >= 2);
    assert.equal(saved.workout.sets[0].reps, 6);
    const csv = await readFile(csvPath, 'utf8');
    assert.equal(csv, toCsv((await readImportVault(root, folder)).data));

    const outside = { ...workout, sets: [{ ...set, reps: 7 }] };
    const outsideText = JSON.stringify(outside);
    onRename = async (_source, target) => {
      await writeFile(target, outsideText);
      throw sharingError;
    };
    renameMock.mock.resetCalls();
    await assert.rejects(edit(saved.workout.sets[0], 8), /The file changed\. Refresh and try again\./);
    assert.equal(renameMock.mock.callCount(), 1);
    assert.equal(await readFile(workoutPath, 'utf8'), outsideText);

    onRename = () => Promise.reject(sharingError);
    renameMock.mock.resetCalls();
    await assert.rejects(edit(outside.sets[0], 8), (error) => error === sharingError);
    assert.equal(renameMock.mock.callCount(), 5);
    assert.equal(await readFile(workoutPath, 'utf8'), outsideText);
    assert.equal(await readFile(csvPath, 'utf8'), csv);
    assert.deepEqual(await readdir(dirname(workoutPath)), [basename(workoutPath)]);
    assert.deepEqual(await readdir(dirname(csvPath)), [basename(csvPath)]);
  } finally {
    renameMock.mock.restore();
    syncBuiltinESMExports();
  }
});
