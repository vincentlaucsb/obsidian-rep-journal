import { exactRepRecordIds, exactRepRecords, exerciseHistory, progressExercises, strengthTrend } from './analytics.ts';
import { matchesExerciseName, pickerTags, starterExercises } from './catalog.ts';
import { journalFolder } from './journal-paths.ts';
import {
  combineAliases, compareWorkouts, describeSet, exerciseFrontmatter, isDate, isDistanceUnit, isElevationUnit, isId, isRecord, isUnit,
  measurements, parseDuration, readExercise, setMeasurements,
  tagGroups, validateSet, type DistanceUnit, type ElevationUnit, type Exercise, type ExerciseChoice, type ExerciseNote, type ExerciseTag,
  type LedgerData, type Measurement, type WeightUnit, type Workout, type WorkoutChange, type WorkoutFile, type WorkoutSet,
} from './model.ts';

import { displayUnits, entryUnits, type MeasurementSystem, type MeasurementUnits } from './units.ts';

export const maxPlanBytes = 512 * 1024;

export interface PlanNote { path: string; title: string }

export type WorkoutSaveResult = WorkoutFile & { personalRecord?: true; personalRecordSetIds?: Record<string, string[]> };

export function workoutSaveResult(data: LedgerData, saved: WorkoutFile, newSetId?: string): WorkoutSaveResult {
  const workouts = data.workouts.filter(({ workout }) => workout.id !== saved.workout.id).map(({ workout }) => workout);
  workouts.push(saved.workout);
  const personalRecordSetIds = exactRepRecordIds(workouts);
  return {
    ...saved, personalRecordSetIds,
    ...(newSetId && personalRecordSetIds[saved.workout.id]?.includes(newSetId) ? { personalRecord: true } : {}),
  };
}

export interface LogSetInput {
  date: string;
  selectedDate?: boolean;
  workoutId: string | null;
  automaticSession?: boolean;
  exerciseId: string;
  setId: string;
  values: SetInputs;
  units?: Required<MeasurementUnits>;
}

type SetInputs = Partial<Record<Exclude<Measurement, 'time' | 'elevationGain'>, number> &
  { time: number | string; elevationGain: number | null }>;

export type WorkoutEditInput = {
  date: string;
  workoutId: string;
  change:
    | { kind: 'edit'; original: WorkoutSet; values: SetInputs; elevationUnit?: ElevationUnit }
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
    weightUnit?: WeightUnit | null;
    distanceUnit?: DistanceUnit | null;
    elevationUnit?: ElevationUnit | null;
    tags: ExerciseTag[];
  };
}

export function isWorkoutPlanPath(path: string, root = journalFolder): boolean {
  return !path.split('/').some((part) => part.startsWith('.')) &&
    !['Exercises', 'Exports', 'Workouts'].some((folder) => path.startsWith(`${root}/${folder}/`));
}

export function exerciseProgress(data: LedgerData, exerciseId: string | null, journalUnit: WeightUnit, system?: MeasurementSystem) {
  const exercises = progressExercises(data);
  const selected = exercises.find(({ id }) => id === exerciseId);
  const { unit, trend, sessions } = progressHistory(data, selected, journalUnit);
  const units = displayUnits(system, selected);
  return {
    exercises, selected, tags: pickerTags(exercises), unit,
    trend: trend.map(({ set, ...point }) => ({ ...point, set: describeSet(set, units) })),
    sessions: sessions.map(({ sets, estimatedMax, personalRecordIndices, ...session }) => {
      const recordsByIndex = personalRecordIndices.flatMap((index) => {
        const reps = sets[index].reps;
        return reps === undefined ? [] : [[index, reps] as const];
      });
      return {
        ...session, sets: sets.map((set) => describeSet(set, units)), estimatedMax: estimatedMax?.value,
        ...(recordsByIndex.length ? {
          personalRecordIndices,
          personalRecordReps: Object.fromEntries(recordsByIndex),
        } : {}),
      };
    }),
  };
}

export function progressHistory(data: LedgerData, exercise: ExerciseChoice | undefined, journalUnit: WeightUnit) {
  const workouts = data.workouts.map(({ workout }) => workout);
  const history = exercise ? exerciseHistory(workouts, exercise.id) : [];
  const records = exercise ? exactRepRecords(workouts, exercise.id) : undefined;
  const unit = exercise?.weightUnit ?? journalUnit;
  const trend = strengthTrend(history, unit);
  const estimates = new Map(trend.map(({ sessionId, value, set }) => [sessionId, { value, set }]));
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
    unit,
    trend: trend.map((point) => ({ ...point, number: sessionNumber(point.date, point.sessionId) })),
    sessions: history.map(({ workout: { id, date }, sets }) => {
      const earned = records?.get(id);
      const best = estimates.get(id);
      return {
        id, date, number: sessionNumber(date, id), sets,
        estimatedMax: best ? { value: best.value, setIndex: sets.indexOf(best.set) } : null,
        personalRecordIndices: sets.flatMap((set, index) => earned?.has(set) ? [index] : []),
      };
    }),
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
  if (input.automaticSession !== undefined && typeof input.automaticSession !== 'boolean') {
    throw new Error('Choose a workout session.');
  }
  if (!isId(input.setId) || !isRecord(input.values)) throw new Error('Missing set ID or measurements.');
  const units = input.units === undefined ? undefined : readEntryUnits(input.units);
  return {
    date, exerciseId: input.exerciseId, workoutId: input.workoutId, setId: input.setId, values: input.values, units,
    isToday: date === today, automaticSession: date === today && input.automaticSession === true,
  };
}

const sessionInactivityMs = 60 * 60 * 1000;

export function latestWorkout(workouts: readonly Workout[], date: string, preferredId?: string | null): Workout | undefined {
  let latest: Workout | undefined;
  for (const workout of workouts) {
    if (workout.date === date && (!latest || compareWorkouts(workout, latest, preferredId) > 0)) latest = workout;
  }
  return latest;
}

export function automaticWorkout(workouts: readonly Workout[], date: string, now: Date, preferredId?: string | null): Workout | undefined {
  const latest = latestWorkout(workouts, date, preferredId);
  const loggedAt = latest?.sets.at(-1)?.loggedAt;
  return loggedAt && now.getTime() - Date.parse(loggedAt) >= sessionInactivityMs ? undefined : latest;
}

function readEntryUnits(units: unknown): Required<MeasurementUnits> {
  if (!isRecord(units) || !isUnit(units.weightUnit) || !isDistanceUnit(units.distanceUnit) || !isElevationUnit(units.elevationUnit)) {
    throw new Error('Invalid measurement units.');
  }
  return { weightUnit: units.weightUnit, distanceUnit: units.distanceUnit, elevationUnit: units.elevationUnit };
}

export function prepareLogSet(data: LedgerData, input: ReturnType<typeof readLogSetInput>, unit: WeightUnit, system?: MeasurementSystem, now = new Date()):
  { replay: WorkoutFile } | { original?: WorkoutFile; set: WorkoutSet } {
  if (data.issues.length) throw new Error(data.issues[0]);
  const exercise = data.exercises.find(({ id, archived }) => id === input.exerciseId && !archived);
  if (!exercise) throw new Error('That exercise is no longer available. Refresh and try again.');
  const units = input.units ?? entryUnits(unit, system, exercise);
  const set: WorkoutSet = { id: input.setId, exerciseId: exercise.id, exerciseName: exercise.name, warmup: false };
  for (const measurement of exercise.measurements) {
    if (measurement === 'elevationGain' && input.values.elevationGain === undefined) continue;
    const value = measurementValue(input.values, measurement);
    if (measurement === 'reps') set.reps = value;
    if (measurement === 'time') set.durationSeconds = value;
    if (measurement === 'distance') set.distance = { value, unit: units.distanceUnit };
    if (measurement === 'elevationGain') set.elevationGain = { value, unit: units.elevationUnit };
    if (measurement === 'weight') {
      const mode = exercise.loadMode;
      set.load = { mode: mode === 'assistance' || mode === 'added' ? mode : 'weight', value, unit: units.weightUnit };
    }
  }
  if (!set.load && set.reps !== undefined && set.durationSeconds === undefined && !set.distance && !set.elevationGain) {
    set.load = { mode: 'bodyweight' };
  }
  validateSet(set);

  const replay = data.workouts.find(({ workout }) => workout.sets.some(({ id }) => id === set.id));
  if (replay) {
    const existing = replay.workout.sets.find(({ id }) => id === set.id);
    if (replay.workout.date !== input.date || (!input.automaticSession && input.workoutId !== null && replay.workout.id !== input.workoutId) ||
      JSON.stringify({ ...existing, loggedAt: undefined }) !== JSON.stringify(set)) {
      throw new Error('This set ID is already in use. Reopen the entry and try again.');
    }
    return { replay };
  }
  const workoutId = input.automaticSession
    ? automaticWorkout(data.workouts.map(({ workout }) => workout), input.date, now, input.workoutId)?.id
    : input.workoutId;
  const original = data.workouts.find(({ workout }) => workout.date === input.date && workout.id === workoutId);
  if (workoutId != null && !original) throw new Error('The session is no longer available on that date. Refresh and try again.');
  if (input.isToday) set.loggedAt = now.toISOString();
  return { original, set };
}

export function prepareWorkoutEdit(data: LedgerData, input: unknown, today: string, system?: MeasurementSystem):
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
    if (measurement === 'elevationGain') continue;
    const value = measurementValue(change.values, measurement);
    if (measurement === 'reps') set.reps = value;
    if (measurement === 'time') set.durationSeconds = value;
    if (measurement === 'distance' && before.distance) set.distance = { ...before.distance, value };
    if (measurement === 'weight' && before.load && before.load.mode !== 'bodyweight') set.load = { ...before.load, value };
  }
  const exercise = data.exercises.find(({ id }) => id === before.exerciseId);
  if (change.values.elevationGain !== undefined) {
    if (change.values.elevationGain === null) {
      delete set.elevationGain;
    } else if (before.elevationGain || exercise?.measurements.includes('elevationGain')) {
      if (change.elevationUnit !== undefined && !isElevationUnit(change.elevationUnit)) throw new Error('Invalid elevation unit.');
      set.elevationGain = {
        value: measurementValue(change.values, 'elevationGain'),
        unit: before.elevationGain?.unit ?? change.elevationUnit ?? entryUnits('lb', system, exercise).elevationUnit,
      };
    } else {
      throw new Error('Enable elevation gain for this exercise before adding it to a set.');
    }
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
      (values.weightUnit != null && !isUnit(values.weightUnit)) ||
      (values.distanceUnit != null && !isDistanceUnit(values.distanceUnit)) ||
      (values.elevationUnit != null && !isElevationUnit(values.elevationUnit)) ||
      !Array.isArray(values.tags) || !values.tags.every(isExerciseTag)) {
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
    archived: values.archived, measurements: values.measurements,
    weightUnit: values.weightUnit === undefined ? original?.weightUnit : values.weightUnit ?? undefined,
    distanceUnit: values.distanceUnit === undefined ? original?.distanceUnit : values.distanceUnit ?? undefined,
    elevationUnit: values.elevationUnit === undefined ? original?.elevationUnit : values.elevationUnit ?? undefined,
    tags: values.tags,
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
