import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  exerciseFrontmatter, parseWorkout, readExercise, type ExerciseNote, type LedgerData,
} from '../src/model.ts';
import { importExerciseCatalog, planWorkoutImport } from '../src/workout-import.ts';

const date = '2026-11-20';
const exerciseId = '12345678-1234-4123-8123-123456789aaa';
const workoutId = '12345678-1234-4123-8123-123456789bbb';
const setId = '12345678-1234-4123-8123-123456789ccc';
const empty: LedgerData = { exercises: [], workouts: [], issues: [] };

function note(name: string, aliases: string[] = [], id = exerciseId): ExerciseNote {
  const exercise = readExercise(exerciseFrontmatter({
    id, name, aliases, equipment: '', archived: false, loadMode: 'weight', unit: 'lb',
  }));
  assert.ok(exercise);
  return { ...exercise, path: `Exercises/${name}.md` };
}

function oneWorkout(sets: unknown[], details: Record<string, unknown> = {}): unknown {
  return { workouts: [{ date, sets, ...details }] };
}

void test('LLM-shaped imports use exact aliases, preserve measurement units, and materialize starters', async () => {
  const importData = {
    workouts: [{ date, sets: [
      { exerciseName: ' military  press ', load: { value: 135, unit: 'lb' }, reps: 5 },
      { exerciseName: 'Erg', durationSeconds: 68, distance: { value: 500, unit: 'm' } },
    ] }],
  };
  const plan = await planWorkoutImport(importData, empty);
  assert.deepEqual(plan.issues, []);
  assert.deepEqual(plan.exercises.map(({ name }) => name), ['Overhead Press', 'Rowing']);
  const [workout] = plan.workouts;
  assert.equal(workout.createdAt, `${date}T00:00:00.000Z`);
  assert.equal(workout.schemaVersion, 2);
  assert.equal(workout.sets[0].exerciseId, plan.exercises[0].id);
  assert.deepEqual(workout.sets[0].load, { mode: 'weight', value: 135, unit: 'lb' });
  assert.equal(workout.sets[1].durationSeconds, 68);
  assert.deepEqual(workout.sets[1].distance, { value: 500, unit: 'm' });
  assert.deepEqual(parseWorkout(JSON.stringify(workout)), workout);

  const renamed = plan.exercises.map((exercise): ExerciseNote => ({
    ...exercise, name: exercise.name === 'Overhead Press' ? 'Shoulder Press' : exercise.name,
    path: `Exercises/${exercise.name}.md`,
  }));
  const resumed = await planWorkoutImport(importData, {
    ...empty, exercises: renamed, workouts: [{ path: `Workouts/${date}.json`, workout }],
  });
  assert.deepEqual(resumed, { issues: [], exercises: [], workouts: [], skippedWorkoutIds: [workout.id] });
});

void test('unmatched or ambiguous exercises produce useful suggestions and unit errors point to the field', async () => {
  const data = { ...empty, exercises: [note('Cable press', ['Press']), note('Incline press', ['Press'], setId)] };
  const plan = await planWorkoutImport(oneWorkout([
    { exerciseName: 'Bnech Press', reps: 8, load: { value: 45, unit: 'pounds' } },
    { exerciseName: 'Press', reps: 5 },
    { exerciseId: exerciseId, exerciseName: 'Incline press', reps: 3 },
    { exerciseId: workoutId, exerciseName: 'Push-up', reps: 6 },
    { exerciseName: 'Running', distance: { value: 1, unit: 'miles' } },
  ]), data);
  const issues = new Map(plan.issues.map((entry) => [entry.code, entry]));
  assert.equal(issues.get('UNKNOWN_EXERCISE')?.path, 'workouts[0].sets[0].exerciseName');
  assert.equal(issues.get('UNKNOWN_EXERCISE')?.suggestions?.[0].name, 'Bench Press');
  assert.match(issues.get('INVALID_WEIGHT_UNIT')?.message ?? '', /lb or kg/);
  assert.equal(issues.get('INVALID_WEIGHT_UNIT')?.path, 'workouts[0].sets[0].load.unit');
  assert.deepEqual(issues.get('AMBIGUOUS_EXERCISE')?.suggestions?.map(({ exerciseId }) => exerciseId), [exerciseId, setId]);
  assert.equal(issues.get('EXERCISE_ID_NAME_CONFLICT')?.path, 'workouts[0].sets[2].exerciseId');
  assert.equal(issues.get('UNKNOWN_EXERCISE_ID')?.suggestions?.[0].name, 'Push-up');
  assert.equal(issues.get('INVALID_DISTANCE_UNIT')?.path, 'workouts[0].sets[4].distance.unit');
  assert.deepEqual(plan.workouts, []);
  assert.deepEqual(plan.exercises, []);
});

void test('explicit exercise declarations are reproducible after partial writes and infer measurement fields', async () => {
  const input = {
    exercises: [{ name: 'Weighted sled pull', aliases: ['sled'] }],
    workouts: [{ date, sets: [{ exerciseName: 'sled', load: { value: 70, unit: 'kg' }, distance: { value: 30, unit: 'yd' } }] }],
  };
  const first = await planWorkoutImport(input, empty);
  assert.deepEqual(first.issues, []);
  assert.equal(first.exercises.length, 1);
  const [exercise] = first.exercises;
  assert.deepEqual(exercise.measurements, ['weight', 'distance']);
  assert.equal(exercise.distanceUnit, undefined);
  assert.deepEqual(first.workouts[0].sets[0].distance, { value: 30, unit: 'yd' });
  assert.equal(exercise.unit, 'kg');
  assert.equal(first.workouts[0].sets[0].exerciseId, exercise.id);
  const resumed = await planWorkoutImport(input, { ...empty, exercises: [{ ...exercise, path: 'Exercises/Sled.md' }] });
  assert.deepEqual(resumed.issues, []);
  assert.deepEqual(resumed.exercises, []);
  assert.deepEqual(resumed.workouts, first.workouts);
});

void test('exercise catalog keeps historical IDs and excludes overlapping starter choices', async () => {
  const data = { ...empty, exercises: [note('My overhead press', ['Overhead Press', 'OHP'])] };
  assert.equal(importExerciseCatalog(data).filter((item) => item.aliases.includes('OHP')).length, 1);
  const plan = await planWorkoutImport(oneWorkout([{ exerciseName: 'OHP', reps: 5, load: { value: 20, unit: 'kg' } }]), data);
  assert.deepEqual(plan.issues, []);
  assert.deepEqual(plan.exercises, []);
  const [workout] = plan.workouts;
  assert.equal(workout.sets[0].exerciseId, exerciseId);
  assert.equal(workout.schemaVersion, 1);
  const missing = await planWorkoutImport(oneWorkout([{ exerciseId, reps: 5 }]), {
    ...empty, workouts: [{ path: 'workout.json', workout }],
  });
  assert.deepEqual(missing.issues, []);
  assert.equal(missing.workouts[0].sets[0].exerciseId, exerciseId);
});

void test('elevation gain imports preserve zero, unit and precision for new and existing exercises', async () => {
  const input = {
    exercises: [{ name: 'Mountain Biking', distanceUnit: 'mi', elevationUnit: 'ft' }],
    workouts: [{ id: workoutId, date, sets: [
      { exerciseName: 'Mountain Biking', distance: { value: 7415.126, unit: 'm' }, elevationGain: { value: 345.123, unit: 'm' } },
      { exerciseName: 'Mountain Biking', elevationGain: { value: 0, unit: 'ft' } },
    ] }],
  };
  const plan = await planWorkoutImport(input, empty);
  assert.deepEqual(plan.issues, []);
  assert.partialDeepStrictEqual(plan.exercises, [{ measurements: ['distance', 'elevationGain'], distanceUnit: 'mi', elevationUnit: 'ft' }]);
  const [workout] = plan.workouts;
  assert.equal(workout.schemaVersion, 2);
  assert.deepEqual(workout.sets.map(({ elevationGain }) => elevationGain), [{ value: 345.123, unit: 'm' }, { value: 0, unit: 'ft' }]);
  const data = { ...empty, exercises: [{ ...plan.exercises[0], path: 'Exercises/Mountain Biking.md' }],
    workouts: [{ path: 'Workouts/ride.json', workout }] };
  assert.deepEqual((await planWorkoutImport(input, data)).skippedWorkoutIds, [workoutId]);

  const bad = await planWorkoutImport(oneWorkout([
    { exerciseName: 'Mountain Biking', elevationGain: { value: -1, unit: 'yd' } },
  ]), data);
  assert.deepEqual(bad.issues.map(({ code, path }) => [code, path]), [
    ['INVALID_ELEVATION_UNIT', 'workouts[0].sets[0].elevationGain.unit'],
    ['INVALID_ELEVATION_VALUE', 'workouts[0].sets[0].elevationGain.value'],
  ]);
});

void test('repeated IDs distinguish exact replays, conflicts, and separate explicit workouts', async () => {
  const sets = [{ id: setId, exerciseName: 'Push-up', reps: 5 }];
  const input = oneWorkout(sets, { id: workoutId });
  const first = await planWorkoutImport(input, empty);
  assert.deepEqual(first.issues, []);
  assert.equal(first.workouts[0].id, workoutId);
  assert.equal(first.workouts[0].sets[0].id, setId);
  const data = { ...empty, workouts: [{ path: `Workouts/${date}.json`, workout: first.workouts[0] }] };
  const replay = await planWorkoutImport(input, data);
  assert.deepEqual(replay.skippedWorkoutIds, [workoutId]);
  assert.deepEqual(replay.issues, []);
  const conflict = await planWorkoutImport(oneWorkout([{ ...sets[0], reps: 9 }], { id: workoutId }), data);
  assert.equal(conflict.issues[0].code, 'WORKOUT_ID_CONFLICT');
  assert.equal(conflict.issues[0].path, 'workouts[0].id');
  const duplicate = await planWorkoutImport({ workouts: [{ date, sets }, { date, sets }] }, empty);
  assert.equal(duplicate.issues[0].code, 'DUPLICATE_WORKOUT_ID');
  const separate = await planWorkoutImport(oneWorkout(sets, { id: exerciseId }), data);
  assert.deepEqual(separate.issues, []);
  assert.equal(separate.workouts.length, 1);
});

void test('matching workouts under different IDs require explicit confirmation for an intentional copy', async () => {
  const sets = [{ exerciseName: 'Bench Press', reps: 5, load: { value: 20, unit: 'kg' } }];
  const { workouts: [workout] } = await planWorkoutImport(oneWorkout(sets, { id: workoutId, notes: 'Original entry' }), empty);
  const data = { ...empty, workouts: [{ path: '2026-11-20.json', workout }] };
  const duplicate = await planWorkoutImport(oneWorkout(sets), data);
  assert.deepEqual(duplicate.workouts, []);
  assert.equal(duplicate.issues[0].code, 'POSSIBLE_DUPLICATE_WORKOUT');
  assert.equal(duplicate.issues[0].path, 'workouts[0].id');
  assert.ok(duplicate.issues[0].message.includes(workoutId));
  assert.deepEqual((await planWorkoutImport(oneWorkout(sets, { id: exerciseId }), data)).issues, []);
  assert.deepEqual((await planWorkoutImport(oneWorkout([{ ...sets[0], reps: 6 }]), data)).issues, []);
});

void test('invalid payloads list specific shape errors without yielding writable entries', async () => {
  const input = { exercises: [{ name: 'Ski erg', measurements: ['distance'] }], workouts: [
    { date: '2026-02-29', createdAt: 'now', sets: [{ exerciseName: 'Plank', seconds: 60 }] },
    { date, sets: [{ exerciseName: 'Plank', durationSeconds: 60 }] },
  ] };
  const plan = await planWorkoutImport(input, empty);
  assert.deepEqual(plan.issues.map(({ code }) => code), ['INVALID_DATE', 'INVALID_TIMESTAMP', 'UNKNOWN_FIELD', 'MISSING_MEASUREMENT']);
  assert.equal(plan.issues[2].path, 'workouts[0].sets[0].seconds');
  assert.deepEqual(plan.exercises, []);
  assert.deepEqual(plan.workouts, []);
});

void test('incomplete vault data blocks planning so missing records cannot misdirect a match', async () => {
  const plan = await planWorkoutImport(oneWorkout([{ exerciseName: 'Plank', durationSeconds: 60 }]), {
    ...empty, issues: ['2026-11-20.json: Invalid workout record.'],
  });
  assert.deepEqual(plan.workouts, []);
  assert.deepEqual(plan.exercises, []);
  assert.equal(plan.issues[0].code, 'VAULT_DATA_INVALID');
});
