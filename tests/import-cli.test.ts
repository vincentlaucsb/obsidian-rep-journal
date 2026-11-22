import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, rmdir, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseWorkout, createWorkout, exerciseFrontmatter, type Exercise } from '../src/model.ts';
import { starterExercises } from '../src/catalog.ts';
import { exerciseFilename, journalSettingsFile } from '../src/journal-paths.ts';
import { stringify } from 'yaml';

const cli = fileURLToPath(new URL('../scripts/import-cli.ts', import.meta.url));
const testDate = '2026-11-20';

async function scratchVault(context: TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'rep-journal-import-'));
  context.after(async () => {
    assert.equal(dirname(root), tmpdir());
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

function run(vault: string, args: string[], input?: string) {
  const result = spawnSync(process.execPath, [cli, '--vault', vault, ...args], { input, encoding: 'utf8' });
  assert.ifError(result.error);
  const output: unknown = JSON.parse(result.stdout);
  return { status: result.status, output };
}

void test('catalog and dry-run resolve existing aliases without writing files', async (context) => {
  const vault = await scratchVault(context);
  const folder = join(vault, 'Rep Journal', 'Exercises', 'Strength');
  await mkdir(folder, { recursive: true });
  const exercise: Exercise = {
    id: '3494dc19-fc44-43b0-a8e9-7031bfc60848',
    name: 'Military Press', aliases: ['Overhead Press'], equipment: 'Barbell',
    measurements: ['weight', 'reps'], archived: false, loadMode: 'weight', unit: 'lb', distanceUnit: 'm', tags: [],
  };
  const name = 'Military Press.md';
  const frontmatter = stringify(exerciseFrontmatter(exercise));
  await writeFile(join(folder, name), `\uFEFF---\r\n${frontmatter.replace(/\n/g, '\r\n')}---\r\n\r\nGym notes.\r\n`);
  const catalog = run(vault, ['--catalog']);
  assert.equal(catalog.status, 0);
  assert.match(JSON.stringify(catalog.output), /"exerciseId":"3494dc19-fc44-43b0-a8e9-7031bfc60848","name":"Military Press"/);
  assert.doesNotMatch(JSON.stringify(catalog.output), /"name":"Overhead Press"/);

  const input = JSON.stringify({
    workouts: [{ date: testDate, sets: [{ exerciseName: ' overhead press ', reps: 5, load: { value: 60, unit: 'kg' } }] }],
  });
  const result = run(vault, ['--input', '-'], input);
  assert.equal(result.status, 0);
  assert.partialDeepStrictEqual(result.output, {
    ok: true, mode: 'plan', issues: [],
    plan: {
      exercises: [], resolvedExercises: [{ exerciseId: exercise.id, name: exercise.name, setCount: 1 }],
    },
  });
  assert.deepEqual(await readdir(join(vault, 'Rep Journal')), ['Exercises']);
  assert.deepEqual(await readdir(folder), [name]);
});

void test('apply uses the configured folder, numbers flat and yearly workouts, and skips an identical replay', async (context) => {
  const vault = await scratchVault(context);
  const journalFolder = 'Training/Routine';
  await writeFile(join(vault, journalSettingsFile), JSON.stringify({ journalFolder }));
  const root = join(vault, journalFolder);
  const dir = join(root, 'Workouts');
  const year = join(dir, '2026');
  await mkdir(year, { recursive: true });
  const legacy = createWorkout(testDate);
  const legacyName = `${testDate}-${legacy.id}.json`;
  const legacyPath = join(dir, legacyName);
  const legacyText = JSON.stringify(legacy);
  await writeFile(legacyPath, legacyText);
  const existingYearlyName = `${testDate}-4.json`;
  await writeFile(join(year, existingYearlyName), JSON.stringify(createWorkout(testDate)));
  const unselected = join(vault, 'Set Ledger', 'Workouts');
  await mkdir(unselected, { recursive: true });
  await writeFile(join(unselected, 'broken.json'), 'unselected');
  const inputPath = join(vault, 'input file.json');
  const input = JSON.stringify({
    workouts: [
      { date: testDate, sets: [{ exerciseName: 'OHP', reps: 5, load: { value: 135, unit: 'lb' } }] },
      { date: testDate, sets: [{ exerciseName: 'Rowing', durationSeconds: 115, distance: { value: 500, unit: 'm' } }] },
    ],
  });
  await writeFile(inputPath, input);
  const result = run(vault, ['--input', inputPath, '--apply']);
  assert.equal(result.status, 0);
  assert.partialDeepStrictEqual(result.output, { ok: true, mode: 'apply', issues: [] });
  assert.deepEqual((await readdir(dir)).sort(), ['2026', legacyName]);
  const yearlyNames = [existingYearlyName, `${testDate}-5.json`, `${testDate}-6.json`];
  assert.deepEqual((await readdir(year)).sort(), yearlyNames);
  assert.equal(await readFile(legacyPath, 'utf8'), legacyText);
  const second = parseWorkout(await readFile(join(year, `${testDate}-5.json`), 'utf8'));
  const third = parseWorkout(await readFile(join(year, `${testDate}-6.json`), 'utf8'));
  assert.deepEqual(second.sets[0].load, { mode: 'weight', value: 135, unit: 'lb' });
  assert.deepEqual(third.sets[0].distance, { value: 500, unit: 'm' });
  assert.equal(third.sets[0].durationSeconds, 115);
  assert.equal((await readdir(join(root, 'Exercises'))).length, 2);

  const replay = run(vault, ['--input', inputPath, '--apply']);
  assert.equal(replay.status, 0);
  assert.partialDeepStrictEqual(replay.output, {
    ok: true, mode: 'apply', issues: [], written: { exercises: [], workouts: [] },
    plan: { exercises: [], workouts: [] },
  });
  assert.deepEqual((await readdir(dir)).sort(), ['2026', legacyName]);
  assert.deepEqual((await readdir(year)).sort(), yearlyNames);
  assert.deepEqual(await readdir(unselected), ['broken.json']);
});

void test('invalid input reports structured errors and apply leaves the vault untouched', async (context) => {
  const vault = await scratchVault(context);
  const input = JSON.stringify({
    workouts: [{ date: testDate, sets: [
      { exerciseName: 'Overhead Press', reps: 3, load: { value: 20, unit: 'kg' } },
      { exerciseName: 'Press made up for this test', reps: 7 },
    ] }],
  });
  const validation = run(vault, ['--input', '-', '--apply'], input);
  assert.equal(validation.status, 2);
  assert.partialDeepStrictEqual(validation.output, {
    ok: false, mode: 'apply', issues: [{ path: 'workouts[0].sets[1].exerciseName' }],
    written: { exercises: [], workouts: [] },
  });
  assert.deepEqual(await readdir(vault), []);

  const syntax = run(vault, ['--input', '-'], '{');
  assert.equal(syntax.status, 2);
  assert.partialDeepStrictEqual(syntax.output, {
    ok: false, mode: 'plan', issues: [{ path: 'input', code: 'INVALID_JSON' }],
  });
});

void test('a corrupt existing workout stops apply and identifies the vault record', async (context) => {
  const vault = await scratchVault(context);
  const folder = join(vault, 'Rep Journal', 'Workouts');
  const filename = 'broken.json';
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, filename), 'incomplete');
  const result = run(vault, ['--input', '-', '--apply'], JSON.stringify({
    workouts: [{ date: testDate, sets: [{ exerciseName: 'Pull-up', reps: 5 }] }],
  }));
  assert.equal(result.status, 1);
  assert.partialDeepStrictEqual(result.output, {
    ok: false, mode: 'apply', issues: [{ path: 'Rep Journal/Workouts/broken.json', code: 'VAULT_RECORD_UNREADABLE' }],
    written: { exercises: [], workouts: [] },
  });
  assert.deepEqual(await readdir(folder), [filename]);
});

void test('apply returns completed paths after a write error and accepts the same input on retry', async (context) => {
  const vault = await scratchVault(context);
  const input = JSON.stringify({
    workouts: [{ date: testDate, sets: [
      { exerciseName: 'Overhead Press', reps: 3, load: { value: 20, unit: 'kg' } },
      { exerciseName: 'Pull-up', reps: 5 },
    ] }],
  });
  const starters = starterExercises([]);
  const press = starters.find(({ name }) => name === 'Overhead Press');
  const pullup = starters.find(({ name }) => name === 'Pull-up');
  assert.ok(press && pullup);
  const blockedPath = `Rep Journal/Exercises/${exerciseFilename(pullup)}`;
  await mkdir(join(vault, blockedPath), { recursive: true });

  const result = run(vault, ['--input', '-', '--apply'], input);
  assert.equal(result.status, 1);
  assert.partialDeepStrictEqual(result.output, {
    ok: false, mode: 'apply', issues: [{ path: blockedPath, code: 'VAULT_WRITE_FAILED' }],
    written: { exercises: [{ exerciseId: press.id, path: `Rep Journal/Exercises/${exerciseFilename(press)}` }], workouts: [] },
  });
  await rmdir(join(vault, blockedPath));

  const retry = run(vault, ['--input', '-', '--apply'], input);
  assert.equal(retry.status, 0);
  assert.partialDeepStrictEqual(retry.output, {
    ok: true, mode: 'apply', issues: [],
    written: { exercises: [{ exerciseId: pullup.id, path: blockedPath }], workouts: [{ path: `Rep Journal/Workouts/2026/${testDate}.json` }] },
  });
  assert.equal((await readdir(join(vault, 'Rep Journal', 'Exercises'))).length, 2);
});

void test('apply rejects an outside-vault symlink in the configured folder path', async (context) => {
  const vault = await scratchVault(context);
  const outside = await scratchVault(context);
  await symlink(outside, join(vault, 'Linked'), 'junction');
  await writeFile(join(vault, journalSettingsFile), JSON.stringify({ journalFolder: 'Linked/Training' }));
  const result = run(vault, ['--input', '-', '--apply'], JSON.stringify({
    workouts: [{ date: testDate, sets: [{ exerciseName: 'Pull-up', reps: 5 }] }],
  }));
  assert.equal(result.status, 1);
  assert.partialDeepStrictEqual(result.output, {
    ok: false, mode: 'apply',
    issues: [
      { path: 'Linked/Training/Exercises', code: 'VAULT_DIRECTORY_UNREADABLE' },
      { path: 'Linked/Training/Workouts', code: 'VAULT_DIRECTORY_UNREADABLE' },
    ],
    written: { exercises: [], workouts: [] },
  });
  assert.deepEqual(await readdir(outside), []);
});

void test('a vault import lock blocks competing applies while plans remain read-only', async (context) => {
  const vault = await scratchVault(context);
  const lock = '.rep-journal-import.lock';
  await writeFile(join(vault, lock), 'Another importer is working.');
  const input = JSON.stringify({
    workouts: [{ date: testDate, sets: [{ exerciseName: 'Pull-up', reps: 5 }] }],
  });

  const blocked = run(vault, ['--input', '-', '--apply'], input);
  assert.equal(blocked.status, 1);
  assert.partialDeepStrictEqual(blocked.output, {
    ok: false, mode: 'apply', issues: [{ path: lock, code: 'VAULT_IMPORT_LOCKED' }],
    written: { exercises: [], workouts: [] },
  });
  assert.equal(run(vault, ['--input', '-'], input).status, 0);
  assert.equal(run(vault, ['--catalog']).status, 0);
  assert.deepEqual(await readdir(vault), [lock]);

  await unlink(join(vault, lock));
  assert.equal(run(vault, ['--input', '-', '--apply'], input).status, 0);
  assert.deepEqual(await readdir(vault), ['Rep Journal']);
});
