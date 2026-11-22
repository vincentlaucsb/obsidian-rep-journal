import { exerciseHistory, progressExercises, strengthTrend } from './analytics.ts';
import { matchesExerciseName, pickerTags, starterExercises } from './catalog.ts';
import { journalFolder } from './journal-paths.ts';
import {
  combineAliases, describeSet, exerciseFrontmatter, isDate, isDistanceUnit, isId, isRecord, measurements, parseDuration, readExercise, setMeasurements,
  tagGroups, validateSet, type DistanceUnit, type Exercise, type ExerciseChoice, type ExerciseNote, type ExerciseTag,
  type LedgerData, type Measurement, type WeightUnit, type WorkoutChange, type WorkoutFile, type WorkoutSet,
} from './model.ts';
import { parseWorkoutPlan } from './workout-plan.ts';

export const maxPlanBytes = 512 * 1024;

export interface PlanNote { path: string; title: string }

export interface LogSetInput {
  date: string;
  selectedDate?: boolean;
  workoutId: string | null;
  exerciseId: string;
  setId: string;
  values: SetInputs;
}

type SetInputs = Partial<Record<Exclude<Measurement, 'time'>, number> & { time: number | string }>;

export type WorkoutEditInput = {
  date: string;
  workoutId: string;
  change:
    | { kind: 'edit'; original: WorkoutSet; values: SetInputs }
    | { kind: 'remove'; original: WorkoutSet }
    | { kind: 'notes'; original: string; value: string };
} | {
  date: string;
  selectedDate?: boolean;
  workoutId: null;
  newWorkoutId: string;
  change: { kind: 'notes'; original: string; value: string };
};

export interface ExerciseEditInput {
  exerciseId: string;
  original: ExerciseNote | null;
  values: {
    name: string;
    aliases: string[];
    archived: boolean;
    measurements: Measurement[];
    distanceUnit: DistanceUnit;
    tags: ExerciseTag[];
  };
}

export function isWorkoutPlanPath(path: string, root = journalFolder): boolean {
  return !path.split('/').some((part) => part.startsWith('.')) &&
    !['Exercises', 'Exports', 'Workouts'].some((folder) => path.startsWith(`${root}/${folder}/`));
}

export function planNoteFrom(path: string, markdown: string, exercises: readonly ExerciseChoice[], includeInvalid = false): PlanNote | undefined {
  if (!includeInvalid && (!/^ {0,3}##\s+\S/m.test(markdown) || !/^ {0,3}###\s+\S/m.test(markdown))) return;
  const result = parseWorkoutPlan(markdown, exercises);
  if (result.plan || includeInvalid || /(?:plan|routine|superset|workout)/i.test(path)) {
    return { path, title: result.plan?.title ?? path.slice(path.lastIndexOf('/') + 1, -3) };
  }
}

export function exerciseProgress(data: LedgerData, exerciseId: string | null, unit: WeightUnit) {
  const exercises = progressExercises(data);
  const selected = exercises.find(({ id }) => id === exerciseId);
  const workouts = data.workouts.map(({ workout }) => workout);
  const history = selected ? exerciseHistory(workouts, selected.id) : [];
  const trend = strengthTrend(history, unit);
  const estimates = new Map(trend.map(({ sessionId, value }) => [sessionId, value]));
  const days = new Map<string, string[]>();
  for (const { id, date } of workouts) {
    const sessions = days.get(date) ?? [];
    sessions.push(id);
    days.set(date, sessions);
  }
  const sessionNumber = (date: string, id: string): number | undefined => {
    const sameDay = days.get(date) ?? [];
    return sameDay.length > 1 ? sameDay.indexOf(id) + 1 : undefined;
  };
  return {
    exercises, selected, tags: pickerTags(exercises), unit,
    trend: trend.map(({ date, sessionId, set, value }) => ({
      date, sessionId, number: sessionNumber(date, sessionId), value, set: describeSet(set),
    })),
    sessions: history.map(({ workout: { id, date }, sets }) => ({
      id, date, number: sessionNumber(date, id), sets: sets.map(describeSet), estimatedMax: estimates.get(id),
    })),
  };
}

export function workoutStarters(data: LedgerData): ExerciseChoice[] {
  return starterExercises(progressExercises(data));
}

export function prepareStarter(data: LedgerData, id: unknown) {
  const starter = starterExercises([]).find((exercise) => exercise.id === id);
  if (!starter) throw new Error('Choose a starter exercise.');
  const names = [starter.name, ...starter.aliases];
  const existing = data.exercises.find((exercise) => exercise.id === id || names.some((name) => matchesExerciseName(exercise, name, true)));
  if (existing) return { existing };
  if (!workoutStarters(data).some((exercise) => exercise.id === id)) {
    throw new Error('That starter already has workout history. Restore its exercise note to use it.');
  }
  return { starter };
}

function validateWorkoutDate(date: unknown, today: string, selectedDate: unknown): string {
  if (!isDate(date)) throw new Error('Choose a valid workout date.');
  if (selectedDate !== true && date !== today) {
    throw new Error('The date changed. Refresh Rep Journal or choose the workout date in Calendar.');
  }
  return date;
}

function measurementValue(values: Record<string, unknown>, measurement: Measurement): number {
  const input = values[measurement];
  const value = measurement === 'time' && typeof input === 'string' ? parseDuration(input) : input;
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`Enter a valid ${measurement}.`);
  return value;
}

export function readLogSetInput(input: unknown, today: string) {
  if (!isRecord(input) || !isId(input.exerciseId) || !(input.workoutId === null || isId(input.workoutId))) {
    throw new Error('Choose an exercise and a workout session.');
  }
  const date = validateWorkoutDate(input.date, today, input.selectedDate);
  if (!isId(input.setId) || !isRecord(input.values)) throw new Error('Missing set ID or measurements.');
  return { date, exerciseId: input.exerciseId, workoutId: input.workoutId, setId: input.setId, values: input.values };
}

export function prepareLogSet(data: LedgerData, input: ReturnType<typeof readLogSetInput>, unit: WeightUnit):
  { replay: WorkoutFile } | { original?: WorkoutFile; set: WorkoutSet } {
  if (data.issues.length) throw new Error(data.issues[0]);
  const exercise = data.exercises.find(({ id, archived }) => id === input.exerciseId && !archived);
  if (!exercise) throw new Error('That exercise is no longer available. Refresh and try again.');
  const set: WorkoutSet = { id: input.setId, exerciseId: exercise.id, exerciseName: exercise.name, warmup: false };
  for (const measurement of exercise.measurements) {
    const value = measurementValue(input.values, measurement);
    if (measurement === 'reps') set.reps = value;
    if (measurement === 'time') set.durationSeconds = value;
    if (measurement === 'distance') set.distance = { value, unit: exercise.distanceUnit };
    if (measurement === 'weight') {
      const mode = exercise.loadMode;
      set.load = { mode: mode === 'assistance' || mode === 'added' ? mode : 'weight', value, unit };
    }
  }
  if (!set.load && set.reps !== undefined && set.durationSeconds === undefined && !set.distance) set.load = { mode: 'bodyweight' };
  validateSet(set);

  const replay = data.workouts.find(({ workout }) => workout.sets.some(({ id }) => id === set.id));
  if (replay) {
    if (replay.workout.date !== input.date || (input.workoutId !== null && replay.workout.id !== input.workoutId) ||
      !replay.workout.sets.some((existing) => JSON.stringify(existing) === JSON.stringify(set))) {
      throw new Error('This set ID is already in use. Reopen the entry and try again.');
    }
    return { replay };
  }
  const original = data.workouts.find(({ workout }) => workout.date === input.date && workout.id === input.workoutId);
  if (input.workoutId !== null && !original) throw new Error('The session is no longer available on that date. Refresh and try again.');
  return { original, set };
}

export function prepareWorkoutEdit(data: LedgerData, input: unknown, today: string):
  { replay: WorkoutFile } | { date: string; original?: WorkoutFile; newWorkoutId?: string; change: WorkoutChange } {
  if (!isRecord(input) || !isDate(input.date) || !isRecord(input.change)) throw new Error('Choose a workout session.');
  const { date, workoutId, newWorkoutId, change } = input;
  const original = data.workouts.find(({ workout }) => workout.date === date && workout.id === workoutId);
  if (workoutId !== null && (!isId(workoutId) || !original)) throw new Error('The workout is no longer available. Refresh and try again.');

  if (change.kind === 'notes' && typeof change.original === 'string' && typeof change.value === 'string') {
    if (original) {
      if (original.workout.notes === change.value) return { replay: original };
      return { date, original, change: { kind: 'notes', original: change.original, value: change.value } };
    }
    validateWorkoutDate(date, today, input.selectedDate);
    if (!isId(newWorkoutId) || change.original !== '' || !change.value.trim()) throw new Error('Enter a note to start a workout.');
    const replay = data.workouts.find(({ workout }) => workout.id === newWorkoutId);
    if (replay) {
      if (replay.workout.date === date && replay.workout.notes === change.value) return { replay };
      throw new Error('The workout already exists with different notes. Refresh and try again.');
    }
    return { date, newWorkoutId, change: { kind: 'notes', original: '', value: change.value } };
  }

  if (!original || !isRecord(change.original) || !isId(change.original.id)) throw new Error('Choose a logged set.');
  const originalSet = change.original;
  const before = original.workout.sets.find(({ id }) => id === originalSet.id);
  if (!before || JSON.stringify(before) !== JSON.stringify(change.original)) throw new Error('This set changed or was removed. Refresh and try again.');
  if (change.kind === 'remove') return { date, original, change: { kind: 'remove', original: before } };
  if (change.kind !== 'edit' || !isRecord(change.values)) throw new Error('Enter the set measurements.');
  const set = { ...before };
  for (const measurement of setMeasurements(before)) {
    const value = measurementValue(change.values, measurement);
    if (measurement === 'reps') set.reps = value;
    if (measurement === 'time') set.durationSeconds = value;
    if (measurement === 'distance' && before.distance) set.distance = { ...before.distance, value };
    if (measurement === 'weight' && before.load && before.load.mode !== 'bodyweight') set.load = { ...before.load, value };
  }
  return { date, original, change: { kind: 'edit', original: before, set: validateSet(set) } };
}

function isMeasurement(value: unknown): value is Measurement {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(measurements, value);
}

function isExerciseTag(value: unknown): value is ExerciseTag {
  return isRecord(value) && typeof value.group === 'string' && typeof value.name === 'string' &&
    Object.prototype.hasOwnProperty.call(tagGroups, value.group);
}

export function prepareExerciseEdit(data: LedgerData, input: unknown, unit: WeightUnit):
  { replay: ExerciseNote } | { original?: ExerciseNote; exercise: Exercise } {
  if (!isRecord(input) || !isId(input.exerciseId) || !isRecord(input.values)) throw new Error('Choose an exercise to save.');
  const { exerciseId, original: before, values } = input;
  if (typeof values.name !== 'string' || !values.name.trim() || typeof values.archived !== 'boolean' ||
      !Array.isArray(values.aliases) || !values.aliases.every((alias): alias is string => typeof alias === 'string') ||
      !Array.isArray(values.measurements) || !values.measurements.every(isMeasurement) ||
      !isDistanceUnit(values.distanceUnit) || !Array.isArray(values.tags) || !values.tags.every(isExerciseTag)) {
    throw new Error('Enter an exercise name and valid measurements and tags.');
  }
  if (!values.measurements.length) throw new Error('Choose at least one measurement.');
  const current = data.exercises.find(({ id }) => id === exerciseId);
  const original = before === null ? undefined : current;
  if (before !== null && (!original || JSON.stringify(original) !== JSON.stringify(before))) {
    throw new Error('The exercise changed. Refresh and try again.');
  }
  const loadMode = original?.loadMode;
  const name = values.name.trim();
  const exercise = readExercise(exerciseFrontmatter({
    id: exerciseId, name, aliases: combineAliases(name, values.aliases, original?.name),
    archived: values.archived, measurements: values.measurements, distanceUnit: values.distanceUnit, tags: values.tags,
    equipment: original?.equipment ?? '', unit: original?.unit ?? unit,
    loadMode: loadMode === 'assistance' || loadMode === 'added' ? loadMode : values.measurements.includes('weight') ? 'weight' : 'bodyweight',
  }));
  if (!exercise) throw new Error('Invalid exercise properties.');
  if (!original && current) {
    if (JSON.stringify({ ...exercise, path: current.path }) === JSON.stringify(current)) return { replay: current };
    throw new Error('This exercise ID is already in use. Reopen the editor and try again.');
  }
  return { original, exercise };
}
