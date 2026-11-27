import { convertWeight } from './units.ts';
import {
  compareWorkouts, setMeasurements, type ExerciseChoice, type LedgerData, type WeightUnit,
  type Workout, type WorkoutSet,
} from './model.ts';

export interface ExerciseSession {
  workout: Workout;
  sets: WorkoutSet[];
}

export interface StrengthPoint {
  date: string;
  sessionId: string;
  set: WorkoutSet;
  value: number;
}

export function exactRepRecords(workouts: readonly Workout[], exerciseId?: string): Map<string, Set<WorkoutSet>> {
  const best = new Map<string, { value: number; unit: WeightUnit }>();
  const records = new Map<string, Set<WorkoutSet>>();
  for (const workout of [...workouts].sort(compareWorkouts)) {
    for (const set of workout.sets) {
      const { load, reps } = set;
      if (set.warmup || (exerciseId !== undefined && set.exerciseId !== exerciseId) || !reps ||
        (load?.mode !== 'weight' && load?.mode !== 'added') || load.value <= 0) continue;
      const key = JSON.stringify([set.exerciseId, load.mode, reps]);
      const previous = best.get(key);
      if (previous) {
        const weight = convertWeight(load.value, load.unit, previous.unit);
        // Unit conversion can move an exact tie by one floating-point step.
        const tolerance = load.unit === previous.unit ? 0 : Math.max(weight, previous.value) * Number.EPSILON;
        if (weight - previous.value <= tolerance) continue;
      }
      best.set(key, load);
      if (previous === undefined) continue;
      const earned = records.get(workout.id) ?? new Set<WorkoutSet>();
      earned.add(set);
      records.set(workout.id, earned);
    }
  }
  return records;
}

export function exactRepRecordIds(workouts: readonly Workout[]): Record<string, string[]> {
  return Object.fromEntries([...exactRepRecords(workouts)].map(([workoutId, sets]) => [
    workoutId, [...sets].map(({ id }) => id),
  ]));
}

export function exerciseHistory(workouts: Workout[], exerciseId: string): ExerciseSession[] {
  return workouts
    .map((workout) => ({ workout, sets: workout.sets.filter((set) => set.exerciseId === exerciseId) }))
    .filter((entry) => entry.sets.length > 0)
    .sort((a, b) => compareWorkouts(b.workout, a.workout));
}

export function progressExercises(data: LedgerData): ExerciseChoice[] {
  const catalog = new Map<string, ExerciseChoice>(data.exercises.map((exercise) => [exercise.id, exercise]));
  const workouts = data.workouts.map(({ workout }) => workout).sort((a, b) => compareWorkouts(b, a));
  for (const workout of workouts) {
    for (const set of workout.sets) {
      if (catalog.has(set.exerciseId)) continue;
      catalog.set(set.exerciseId, {
        id: set.exerciseId, name: set.exerciseName, aliases: [], equipment: '', archived: false, missingNote: true,
        loadMode: set.load?.mode ?? 'bodyweight',
        unit: set.load && set.load.mode !== 'bodyweight' ? set.load.unit : 'lb',
        measurements: setMeasurements(set), tags: [],
      });
    }
  }
  return [...catalog.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function estimatedMax(set: WorkoutSet, unit: WeightUnit): number | null {
  if (set.load?.mode !== 'weight' || set.load.value <= 0 || set.reps === undefined || set.reps > 10) return null;
  const weight = convertWeight(set.load.value, set.load.unit, unit);
  return set.reps === 1 ? weight : weight * (1 + set.reps / 30);
}

export function strengthTrend(history: ExerciseSession[], unit: WeightUnit): StrengthPoint[] {
  const points: StrengthPoint[] = [];
  for (const { workout, sets } of [...history].sort((a, b) => compareWorkouts(a.workout, b.workout))) {
    let best: StrengthPoint | undefined;
    for (const set of sets) {
      const value = estimatedMax(set, unit);
      if (value !== null && (!best || value > best.value)) {
        best = { date: workout.date, sessionId: workout.id, set, value };
      }
    }
    if (best) points.push(best);
  }
  return points;
}
