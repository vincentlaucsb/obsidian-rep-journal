import assert from 'node:assert/strict';
import { test } from 'node:test';
import { exerciseProgress } from '../src/journal-workflow.ts';
import { createWorkout, makeId, type ExerciseNote, type LedgerData, type WorkoutSet } from '../src/model.ts';
import { runProgressCli } from '../src/progress-cli.ts';

const exercise: ExerciseNote = {
  id: makeId(), name: 'Bench Press', aliases: ['Bench'], equipment: '', archived: false, path: 'Bench Press.md',
  loadMode: 'weight', unit: 'lb', weightUnit: 'kg', measurements: ['weight', 'reps'], tags: [],
};

void test('CLI output keeps recorded sets and the full-history PR baseline in the filtered range', async () => {
  const set = (reps: number, value: number, unit: 'lb' | 'kg', warmup = false): WorkoutSet => ({
    id: makeId(), exerciseId: exercise.id, exerciseName: exercise.name, reps, load: { mode: 'weight', value, unit }, warmup,
  });
  const first = { ...createWorkout('2026-10-14'), sets: [set(5, 100, 'kg'), set(15, 50, 'kg')] };
  const second = {
    ...createWorkout('2026-11-01'), createdAt: '2026-11-01T08:00:00.000Z',
    sets: [set(5, 220, 'lb'), set(15, 51.123456, 'kg'), set(15, 52, 'kg', true)],
  };
  const unrelated = { ...createWorkout(second.date), createdAt: '2026-11-01T09:00:00.000Z' };
  const data = {
    exercises: [exercise], workouts: [first, second, unrelated].map((workout) => ({ path: '', workout })), issues: [],
  } satisfies LedgerData;
  const readJournal = async () => ({ data, unit: 'lb' as const });
  const params = { exercise: '  BENCH  ', since: second.date };
  const ui = exerciseProgress(data, exercise.id, 'lb');
  const output: unknown = JSON.parse(await runProgressCli({ ...params, format: 'json' }, readJournal));
  assert.deepEqual(output, {
    exercise: { id: exercise.id, name: exercise.name }, unit: 'kg', issues: [],
    sessions: [{
      id: second.id, date: second.date, number: 1, sets: second.sets,
      estimatedMax: { value: ui.sessions[0].estimatedMax, setIndex: 0 }, personalRecordIndices: [1],
    }],
  });
  assert.deepEqual(ui.sessions[0].personalRecordIndices, [1]);
  const text = await runProgressCli(params, readJournal);
  assert.match(text, /2026-11-01 \(session 1\)/);
  assert.match(text, /Estimated 1RM: 116\.4 kg from set 1/);
  assert.match(text, /51\.123456 kg \(15-rep PR\)/);
  assert.doesNotMatch(text, /2026-10-14/);
});

void test('CLI accepts missing notes by ID and supports sessions without estimates or PRs', async () => {
  const running: WorkoutSet = {
    id: makeId(), exerciseId: makeId(), exerciseName: 'Run', distance: { value: 1.23456789, unit: 'mi' },
    durationSeconds: 540, warmup: false,
  };
  const workout = { ...createWorkout('2026-11-01'), sets: [running] };
  const data = { exercises: [exercise], workouts: [{ path: '', workout }], issues: [] } satisfies LedgerData;
  const readJournal = async () => ({ data, unit: 'lb' as const });
  const output: unknown = JSON.parse(await runProgressCli({ exercise: running.exerciseId, format: 'json' }, readJournal));
  assert.deepEqual(output, {
    exercise: { id: running.exerciseId, name: 'Run' }, unit: 'lb', issues: [],
    sessions: [{ id: workout.id, date: workout.date, sets: [running], estimatedMax: null, personalRecordIndices: [] }],
  });
  assert.match(await runProgressCli({ exercise: exercise.id }, readJournal), /No recorded sessions\./);
  assert.match(await runProgressCli({ exercise: 'Run', since: '2026-11-02' }, readJournal), /No recorded sessions since 2026-11-02/);

  data.exercises.push({ ...exercise, id: makeId(), name: 'Other Bench Press' });
  await assert.rejects(runProgressCli({ exercise: 'Bench' }, readJournal), /Multiple exercises match.*Use an exercise ID/);
  await assert.rejects(runProgressCli({ exercise: 'Unknown' }, readJournal), /No exercise matches/);
});

void test('CLI validates the exercise, date, and format before reading the journal', async () => {
  const readJournal = async (): Promise<never> => assert.fail('Invalid input should never read the journal');
  await assert.rejects(runProgressCli({}, readJournal), /Specify an exercise/);
  await assert.rejects(runProgressCli({ exercise: 'Bench', since: '2026-02-30' }, readJournal), /since=YYYY-MM-DD/);
  await assert.rejects(runProgressCli({ exercise: 'Bench', format: 'xml' }, readJournal), /format=json or format=text/);
});
