import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WorkoutNoteDrafts } from '../standalone/drafts.ts';
import { exerciseHistory, estimatedMax, progressExercises, strengthTrend } from '../src/analytics.ts';
import { matchesExerciseName, matchesTags, starterExercises } from '../src/catalog.ts';
import { toCsv, toJson, workoutContext, type ContextOptions } from '../src/exports.ts';
import {
  changeWorkout, createWorkout, describeSet, exerciseFrontmatter, isDate, makeId, parseDuration, parseWorkout,
  readExercise, SCHEMA_VERSION, setMeasurements, tagKey,
  type ExerciseNote, type LedgerData, type Workout, type WorkoutSet,
} from '../src/model.ts';

const exercise: ExerciseNote = {
  id: makeId(), name: 'Bench press', aliases: ['Bench'], equipment: 'Barbell', loadMode: 'weight',
  unit: 'lb', archived: false, path: 'Rep Journal/Exercises/Bench.md',
  measurements: ['weight', 'reps'], distanceUnit: 'm', tags: [{ group: 'muscles', name: 'Chest' }],
};

function set(overrides: Partial<WorkoutSet> = {}): WorkoutSet {
  return {
    id: makeId(), exerciseId: exercise.id, exerciseName: exercise.name, reps: 5,
    load: { mode: 'weight', value: 135, unit: 'lb' }, warmup: false, ...overrides,
  };
}

function workout(date: string, sets: WorkoutSet[] = [], notes = ''): Workout {
  return { ...createWorkout(date), sets, notes };
}

function data(workouts: Workout[]): LedgerData {
  return { exercises: [exercise], workouts: workouts.map((entry) => ({ workout: entry, path: `${entry.id}.json` })), issues: [] };
}

const contextOptions: ContextOptions = {
  from: '2026-10-01', to: '2026-10-31', goal: 'Build strength', equipment: 'Barbell', daysPerWeek: 3, includeNotes: false,
};

void test('validates calendar dates', () => {
  assert.equal(isDate('2024-02-29'), true);
  assert.equal(isDate('2025-02-29'), false);
  assert.equal(isDate('2026-11-31'), false);
  assert.equal(isDate('0000-01-01'), false);
});

void test('workout records retain order and reject corrupt, duplicate, or unsupported sets', () => {
  const entry = workout('2026-10-01', [set(), set({ load: { mode: 'bodyweight' } })], 'Some notes');
  assert.deepEqual(parseWorkout(JSON.stringify(entry)), entry);
  assert.throws(() => parseWorkout(JSON.stringify({ ...entry, schemaVersion: 999 })), /Unsupported/);
  assert.throws(() => parseWorkout(JSON.stringify({ ...entry, sets: [entry.sets[0], entry.sets[0]] })), /Invalid/);
  assert.throws(() => parseWorkout(JSON.stringify({ ...entry, sets: [set({ reps: 1.5 })] })), /Invalid/);
  assert.throws(() => parseWorkout(JSON.stringify({ ...entry, sets: [set({ load: { mode: 'assistance', value: 0, unit: 'lb' } })] })), /Invalid/);
});

void test('mixed-format workouts keep legacy units and accept independent measurements', () => {
  const earlier = set({ load: { mode: 'assistance', value: 40, unit: 'lb' }, warmup: true });
  const previous = parseWorkout(JSON.stringify(workout('2026-10-01', [earlier])));
  const durationDistance = set({ reps: undefined, load: undefined, durationSeconds: 245, distance: { value: 500, unit: 'm' } });
  const carry = set({ reps: undefined, load: { mode: 'weight', value: 15, unit: 'kg' }, distance: { value: 50, unit: 'yd' } });
  const lunge = set({ load: undefined, distance: { value: 15, unit: 'm' } });
  let session = previous;
  for (const entry of [durationDistance, carry, lunge]) session = changeWorkout(session, { kind: 'add', set: entry });
  const saved = parseWorkout(JSON.stringify(session));
  assert.equal(previous.schemaVersion, 1);
  assert.equal(saved.schemaVersion, SCHEMA_VERSION);
  assert.deepEqual(saved.sets[0], earlier);
  assert.deepEqual(saved.sets.slice(1).map(setMeasurements), [['time', 'distance'], ['weight', 'distance'], ['reps', 'distance']]);
  assert.equal(describeSet(saved.sets[1]), '4:05 · 500 m');
  assert.equal(estimatedMax(saved.sets[0], 'kg'), null);
  assert.equal(estimatedMax(saved.sets[2], 'kg'), null);
  assert.throws(() => parseWorkout(JSON.stringify({ ...saved, schemaVersion: 1 })), /Invalid/);
  assert.throws(() => changeWorkout(saved, { kind: 'add', set: { ...durationDistance, distance: { value: 0, unit: 'm' } } }), /measurements/);
  assert.equal(parseDuration('1:05:02'), 3902);
  assert.equal(parseDuration('45'), 45);
  assert.ok(Number.isNaN(parseDuration('1:60')));
});

void test('edits retain unrelated sets and stale edits or notes are rejected', () => {
  const first = set({ warmup: true });
  const second = set();
  const original = workout('2026-10-01', [first]);
  const withSecond = changeWorkout(original, { kind: 'add', set: second });
  const edited = changeWorkout(withSecond, { kind: 'edit', original: first, set: { ...first, reps: 6 } });
  assert.equal(edited.sets[0].reps, 6);
  assert.equal(edited.sets[0].warmup, true);
  assert.equal(edited.sets[1], second);
  assert.throws(() => changeWorkout(edited, { kind: 'remove', original: first }), /changed/);
  assert.equal(changeWorkout(edited, { kind: 'remove', original: second }).sets.length, 1);
  const withNotes = changeWorkout(edited, { kind: 'notes', original: '', value: 'New notes' });
  assert.throws(() => changeWorkout(withNotes, { kind: 'notes', original: '', value: 'Stale draft' }), /changed/);
});

void test('unsaved notes remain attached to their session and follow the first logged set', () => {
  const drafts = new WorkoutNoteDrafts();
  const date = '2026-10-01';
  const a = makeId();
  const b = makeId();
  const draft = { original: '', value: 'Finish with a lighter set' };
  drafts.save(date, null, draft);
  drafts.associate(date, a);
  assert.deepEqual(drafts.get(date, a), draft);
  assert.equal(drafts.get(date, b), undefined);
  assert.equal(drafts.get(date, null), undefined);
  drafts.save(date, a, { original: draft.value, value: draft.value });
  assert.equal(drafts.get(date, a), undefined);
});

void test('editing exercise properties preserves the ID used by historical sets', () => {
  const renamed = readExercise(exerciseFrontmatter({ ...exercise, name: 'Barbell bench press', archived: true }));
  assert.equal(renamed?.id, exercise.id);
  assert.equal(renamed?.name, 'Barbell bench press');
  assert.equal(renamed?.archived, true);
  assert.equal(exerciseHistory([workout('2026-10-01', [set()])], exercise.id).length, 1);
});

void test('legacy exercise notes get sensible defaults and their starter aliases resolve to one ID', () => {
  const properties = exerciseFrontmatter(exercise);
  delete properties.exercise_measurements;
  delete properties.exercise_tags;
  delete properties.distance_unit;
  const old = readExercise({ ...properties, load_mode: 'assistance' });
  assert.deepEqual(old?.measurements, ['weight', 'reps']);
  assert.equal(old?.loadMode, 'assistance');
  assert.deepEqual(old?.tags, []);
  assert.throws(() => readExercise({ ...properties, exercise_tags: ['regionX'] }), /tag/);

  const starters = starterExercises([exercise]);
  assert.ok(!starters.some((entry) => entry.name === 'Bench Press'));
  const press = starters.find((entry) => entry.name === 'Overhead Press');
  assert.ok(press);
  for (const alias of ['military  press', ' Overhead Press ', 'SHOULDER PRESS', 'OHP']) {
    assert.deepEqual(starters.filter((entry) => matchesExerciseName(entry, alias, true)).map(({ id }) => id), [press.id]);
  }
  const upper = tagKey({ group: 'region', name: 'Upper Body' });
  const push = tagKey({ group: 'movement', name: 'Push' });
  const auxiliary = tagKey({ group: 'role', name: 'Auxiliary' });
  assert.ok(matchesTags(press, new Set([upper, push])));
  assert.ok(!matchesTags(press, new Set([upper, auxiliary])));
});

void test('history keeps exercises whose Markdown notes are temporarily absent', () => {
  const old = workout('2026-10-01', [set({ exerciseName: 'Old name' })]);
  const recent = workout('2026-10-02', [set({ exerciseName: 'Last recorded name' })]);
  const ledger = { ...data([recent, old]), exercises: [] };
  assert.equal(progressExercises(ledger)[0].name, 'Last recorded name');
  assert.equal(progressExercises(ledger)[0].missingNote, true);
  assert.equal(exerciseHistory([old, recent], progressExercises(ledger)[0].id).length, 2);
});

void test('1RM uses one best eligible set per session and converts to the selected unit', () => {
  const single = set({ reps: 1, load: { mode: 'weight', value: 200, unit: 'lb' } });
  assert.equal(estimatedMax(single, 'lb'), 200);
  assert.ok(Math.abs((estimatedMax(single, 'kg') ?? 0) - 90.718474) < 0.000001);
  const five = set({ reps: 5, load: { mode: 'weight', value: 200, unit: 'lb' } });
  const excluded = [
    set({ reps: 11 }),
    set({ load: { mode: 'assistance', value: 30, unit: 'lb' } }),
    set({ load: { mode: 'added', value: 45, unit: 'lb' } }), set({ load: { mode: 'bodyweight' } }),
  ];
  for (const entry of excluded) assert.equal(estimatedMax(entry, 'lb'), null);
  const lighter = set({ warmup: true, reps: 10, load: { mode: 'weight', value: 70, unit: 'lb' } });
  const heavier = set({ warmup: true, reps: 10, load: { mode: 'weight', value: 140, unit: 'lb' } });
  const history = exerciseHistory([
    workout('2026-10-03', [lighter, heavier]),
    workout('2026-10-02', [single, five, ...excluded]),
    workout('2026-10-01', excluded),
  ], exercise.id);
  const points = strengthTrend(history, 'lb');
  assert.equal(points.length, 2);
  assert.equal(points[0].set.id, five.id);
  assert.ok(Math.abs(points[0].value - 233.33333) < 0.00001);
  assert.equal(points[1].set.id, heavier.id);
  assert.ok(Math.abs(points[1].value - 186.66667) < 0.00001);
});

void test('CSV has one ordered set per row and protects spreadsheet formulas; JSON preserves exact records', () => {
  const quote = set({ exerciseName: 'Bench, "pause"', warmup: true });
  const bodyweight = set({ load: { mode: 'bodyweight' } });
  const record = workout('2026-10-01', [quote, bodyweight], 'Preserved notes');
  const ledger = data([record]);
  ledger.exercises[0] = { ...exercise, name: '=1+1, "quoted"' };
  const [header, first, second, end] = toCsv(ledger).split('\r\n');
  assert.match(header, /set_id,set_order,exercise_id/);
  assert.match(header, /,warmup,duration_seconds,distance_value,distance_unit$/);
  assert.ok(first.includes(`"${quote.id}",1,`));
  assert.ok(first.includes(`"'=1+1, ""quoted"""`));
  assert.ok(first.endsWith(',true,,,'));
  assert.ok(second.endsWith('"bodyweight",,,false,,,'));
  assert.equal(end, '');
  const snapshot: unknown = JSON.parse(toJson(ledger));
  const { path, ...exportedExercise } = ledger.exercises[0];
  assert.deepEqual(snapshot, {
    schemaVersion: SCHEMA_VERSION,
    exercises: [{ ...exportedExercise, notePath: path }],
    workouts: [record],
  });
});

void test('CSV and workout context preserve duration and the actual distance unit', () => {
  const cardio = { ...exercise, measurements: ['time', 'distance'] as const, distanceUnit: 'mi' as const };
  const record = changeWorkout(createWorkout('2026-10-01'), {
    kind: 'add', set: set({ load: undefined, reps: undefined, durationSeconds: 621, distance: { value: 1.3, unit: 'mi' } }),
  });
  const ledger = data([record]);
  ledger.exercises = [{ ...cardio, measurements: [...cardio.measurements] }];
  const [, row] = toCsv(ledger).split('\r\n');
  assert.ok(row.endsWith(',,,,,false,621,1.3,"mi"'));
  const context = workoutContext(ledger, contextOptions);
  assert.match(context, /"durationSeconds": 621/);
  assert.match(context, /"distance": \{\s+"value": 1.3,\s+"unit": "mi"/);
  assert.doesNotMatch(context, /latestEstimated1RM/);
});

void test('complete exports reject partially unreadable or duplicate data', () => {
  const ledger = { ...data([workout('2026-10-01', [set()])]), issues: ['Broken.json: Unsupported workout schema.'] };
  assert.throws(() => toCsv(ledger), /Broken\.json/);
  assert.throws(() => toJson(ledger), /Broken\.json/);
  assert.throws(() => workoutContext(ledger, contextOptions), /Broken\.json/);
});

void test('context includes every logged set in range and never copies extra stored load fields', () => {
  const inRange = workout('2026-10-31', [set(), set({ warmup: true })], 'Opt-in note');
  const [first, warmup] = inRange.sets;
  const modified = parseWorkout(JSON.stringify({
    ...inRange, sets: [{ ...first, load: { ...first.load, privateText: 'Unexpected load note' } }, warmup],
  }));
  const older = workout('2026-09-30', [set()], 'Older note');
  const ledger = data([older, modified]);
  const context = workoutContext(ledger, contextOptions);
  assert.ok(context.includes(first.id));
  assert.ok(context.includes(warmup.id));
  assert.match(context, /"loggedSets": 2/);
  assert.ok(context.includes('latestEstimated1RM'));
  for (const unexpected of [older.id, 'workingSets', 'Opt-in note', 'Older note', 'Unexpected load note']) {
    assert.ok(!context.includes(unexpected));
  }
  assert.ok(workoutContext(ledger, { ...contextOptions, includeNotes: true }).includes('Opt-in note'));
});
