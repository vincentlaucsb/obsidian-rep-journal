import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, rmdir, stat, symlink, unlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseWorkout, createWorkout, exerciseFrontmatter, makeId, type Exercise } from '../src/model.ts';
import { starterExercises } from '../src/catalog.ts';
import { exerciseFilename, journalSettingsFile } from '../src/journal-paths.ts';
import { stringify } from 'yaml';
import { toCsv } from '../src/exports.ts';
import { planGarminElevation, writeGarminElevation } from '../scripts/garmin-elevation-backfill.ts';
import { existingVaultFile, readImportVault } from '../scripts/import-vault.ts';

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

void test('a vault opened through a directory alias resolves its own files and rejects an outside target', async (context) => {
  const parent = await scratchVault(context);
  const vault = join(parent, 'Vault');
  const alias = join(parent, 'Vault Alias');
  const outside = join(parent, 'Outside');
  await mkdir(vault);
  await mkdir(outside);
  await writeFile(join(vault, 'Plan.md'), 'Inside');
  await writeFile(join(outside, 'Plan.md'), 'Outside');
  await symlink(vault, alias, 'junction');
  await symlink(outside, join(vault, 'Linked'), 'junction');
  assert.equal(await readFile(await existingVaultFile(alias, 'Plan.md'), 'utf8'), 'Inside');
  await assert.rejects(existingVaultFile(alias, 'Linked/Plan.md'), /inside the vault/);
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

const garminIds = {
  '71001': '7697604d-0cbe-5a7e-9637-d8ec97b190be',
  '71002': '5de834f4-5141-50ee-9b69-f3bcbff6a6f2',
  '71003': 'd43c9673-39a4-5f0f-a107-00b6ece5bbdd',
  '71004': 'e556fa2c-5e0e-5573-a9a2-3989d1c299da',
  '71005': '3179e6a7-f032-5cd0-9636-1bab6b6e13e3',
  '71006': '445ff4f2-7d1a-5905-90df-c4d2aa3f2196',
} as const;

function backfillInput(...ids: string[]) {
  return { activities: ids.map((activityId) => ({ activityId, elevationGain: { value: 0, unit: 'm' } })) };
}

function runBackfill(vault: string, input: unknown, apply = false) {
  return run(vault, ['--backfill-garmin-elevation', '--input', '-', ...(apply ? ['--apply'] : [])], JSON.stringify(input));
}

async function seedGarminRides(vault: string, ...ids: Array<keyof typeof garminIds>) {
  const importResult = run(vault, ['--input', '-', '--apply'], JSON.stringify({
    exercises: [{ name: 'Mountain Biking', measurements: ['time', 'distance'] }],
    workouts: ids.map((activityId) => ({
      id: garminIds[activityId], date: testDate, sets: [{
        id: activityId === '71004' ? makeId() : undefined,
        exerciseName: activityId === '71005' ? 'Running' : 'Mountain Biking',
        durationSeconds: 1234, distance: { value: 10.437, unit: 'mi' },
        elevationGain: activityId === '71002' ? { value: 0, unit: 'm' } :
          activityId === '71003' ? { value: 777, unit: 'ft' } : undefined,
      }],
    })),
  }));
  assert.equal(importResult.status, 0);
  return readImportVault(vault);
}

void test('Garmin backfill previews without writes and fills only the matching ride set by ID', async (context) => {
  const root = await scratchVault(context);
  const vault = await seedGarminRides(root, '71001', '71002', '71003', '71004', '71005');
  const first = vault.data.workouts.find(({ workout }) => workout.id === garminIds['71001']);
  assert.ok(first);
  const savedPath = join(root, first.path);
  const { workout } = first;
  const [ride] = workout.sets;
  const otherSet = { ...ride, id: makeId(), durationSeconds: 500 };
  const editedRide = { ...ride, durationSeconds: 1200 };
  const locallyEdited = { ...workout, notes: 'Trail repair notes', sets: [otherSet, editedRide] };
  const editedText = JSON.stringify(locallyEdited)
    .replace(`"id":"${ride.id}"`, `"sensor":1.234567890123456789,"id":"${ride.id}"`)
    .replace(/^\{/, '{"externalActivityIdentifier":9007199254740993,');
  await writeFile(savedPath, editedText);
  const input = backfillInput(...Object.keys(garminIds));
  const preview = runBackfill(root, input);
  assert.equal(preview.status, 0);
  assert.partialDeepStrictEqual(preview.output, {
    mode: 'plan', issues: [],
    plan: { activities: [
      { activityId: '71001', workoutId: garminIds['71001'], setId: ride.id, status: 'eligible' },
      { activityId: '71002', status: 'current' },
      { activityId: '71003', status: 'conflict', currentElevationGain: { value: 777, unit: 'ft' } },
      { activityId: '71004', status: 'missing-set' },
      { activityId: '71005', status: 'ineligible-exercise' },
      { activityId: '71006', status: 'missing-workout' },
    ] },
  });
  assert.equal(await readFile(savedPath, 'utf8'), editedText);
  assert.deepEqual((await readdir(join(root, vault.folder))).sort(), ['Exercises', 'Workouts']);
  const otherBytes = new Map(await Promise.all(vault.data.workouts.filter((entry) => entry.path !== first.path)
    .map(async ({ path }) => [path, await readFile(join(root, path), 'utf8')] as const)));

  const malformed = runBackfill(root, { activities: [...input.activities, { activityId: '071006', elevationGain: { value: 10, unit: 'm' } }] }, true);
  assert.equal(malformed.status, 2);
  assert.equal(await readFile(savedPath, 'utf8'), editedText);

  const apply = runBackfill(root, input, true);
  assert.equal(apply.status, 0);
  assert.partialDeepStrictEqual(apply.output, { issues: [], written: { exercises: [], workouts: [{ path: first.path, setId: ride.id }] } });
  const text = await readFile(savedPath, 'utf8');
  assert.match(text, /"externalActivityIdentifier": 9007199254740993/);
  assert.match(text, /"sensor": 1\.234567890123456789/);
  assert.partialDeepStrictEqual(parseWorkout(text), {
    ...locallyEdited, sets: [otherSet, { ...editedRide, elevationGain: { value: 0, unit: 'm' } }],
  });
  for (const [path, bytes] of otherBytes) assert.equal(await readFile(join(root, path), 'utf8'), bytes);
  const csv = join(root, vault.folder, 'Exports', 'rep-journal.csv');
  assert.equal(await readFile(csv, 'utf8'), toCsv((await readImportVault(root)).data));
  const exportRevision = await stat(csv, { bigint: true });
  const savedRevision = await stat(savedPath, { bigint: true });
  const retry = runBackfill(root, input, true);
  assert.equal(retry.status, 0);
  assert.partialDeepStrictEqual(retry.output, { written: { workouts: [] } });
  assert.equal((await stat(csv, { bigint: true })).mtimeNs, exportRevision.mtimeNs);
  assert.equal((await stat(savedPath, { bigint: true })).mtimeNs, savedRevision.mtimeNs);
});

void test('a Garmin backfill retry repairs the automatic CSV after a transient export failure', async (context) => {
  const root = await scratchVault(context);
  const { folder } = await seedGarminRides(root, '71001');
  const exportDirectory = join(root, folder, 'Exports');
  await mkdir(exportDirectory);
  const csv = join(exportDirectory, 'rep-journal.csv');
  await mkdir(csv);
  const input = backfillInput('71001');
  const blocked = runBackfill(root, input, true);
  assert.equal(blocked.status, 1);
  assert.partialDeepStrictEqual(blocked.output, {
    issues: [{ code: 'AUTOMATIC_CSV_FAILED' }], written: { workouts: [{ activityId: '71001' }] },
  });
  await rmdir(csv);
  const retry = runBackfill(root, input, true);
  assert.equal(retry.status, 0);
  assert.partialDeepStrictEqual(retry.output, {
    issues: [], plan: { activities: [{ status: 'current' }] }, written: { workouts: [] },
  });
  assert.equal(await readFile(csv, 'utf8'), toCsv((await readImportVault(root)).data));
});

void test('a workout changed during Garmin backfill is preserved even with the same size and timestamp', async (context) => {
  const root = await scratchVault(context);
  const vault = await seedGarminRides(root, '71001');
  const [ride] = vault.data.workouts;
  const path = join(root, ride.path);
  const stamp = new Date('2026-11-20T10:00:00Z');
  await utimes(path, stamp, stamp);
  const before = await readFile(path, 'utf8');
  const external = before.replace('1234', '1235');
  assert.notEqual(external, before);
  const plan = await planGarminElevation(backfillInput('71001'), vault);
  assert.equal(plan.activities[0].status, 'eligible');
  await writeFile(path, external);
  await utimes(path, stamp, stamp);
  const applied = await writeGarminElevation(vault, plan);
  assert.partialDeepStrictEqual(applied, { written: { workouts: [] }, issues: [{ code: 'VAULT_WORKOUT_CHANGED' }] });
  assert.equal(await readFile(path, 'utf8'), external);
  assert.deepEqual((await readdir(join(root, vault.folder))).sort(), ['Exercises', 'Workouts']);
});
