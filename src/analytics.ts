import {
  compareWorkouts, setMeasurements, type DistanceUnit, type ExerciseChoice, type LedgerData, type WeightUnit,
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

const KG_PER_LB = 0.45359237;
const METERS_PER_UNIT: Record<DistanceUnit, number> = { m: 1, km: 1000, mi: 1609.344, yd: 0.9144, ft: 0.3048 };

export function convertWeight(value: number, from: WeightUnit, to: WeightUnit): number {
  if (from === to) return value;
  return from === 'lb' ? value * KG_PER_LB : value / KG_PER_LB;
}

export function convertDistance(value: number, from: DistanceUnit, to: DistanceUnit): number {
  if (from === to) return value;
  return value * (METERS_PER_UNIT[from] / METERS_PER_UNIT[to]);
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
        measurements: setMeasurements(set), distanceUnit: set.distance?.unit ?? 'm', tags: [],
      });
    }
  }
  return [...catalog.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function workoutExercises(data: LedgerData): ExerciseChoice[] {
  const remaining = new Map(data.exercises.filter((exercise) => !exercise.archived).map((exercise) => [exercise.id, exercise]));
  const recent: ExerciseChoice[] = [];
  for (const { workout } of [...data.workouts].reverse()) {
    for (const set of [...workout.sets].reverse()) {
      const exercise = remaining.get(set.exerciseId);
      if (exercise) {
        recent.push(exercise);
        remaining.delete(set.exerciseId);
      }
    }
    if (!remaining.size) break;
  }
  return [...recent, ...remaining.values()];
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
