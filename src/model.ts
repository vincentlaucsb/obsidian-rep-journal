export const SCHEMA_VERSION = 1;

export type WeightUnit = 'lb' | 'kg';
export type LoadMode = 'weight' | 'bodyweight' | 'added' | 'assistance';

export const loadModes: ReadonlyArray<{ value: LoadMode; label: string }> = [
  { value: 'weight', label: 'External weight' },
  { value: 'bodyweight', label: 'Bodyweight' },
  { value: 'added', label: 'Added weight' },
  { value: 'assistance', label: 'Assistance' },
];

export type SetLoad = { mode: 'bodyweight' } | {
  mode: Exclude<LoadMode, 'bodyweight'>;
  value: number;
  unit: WeightUnit;
};

export interface ExerciseDetails {
  name: string;
  aliases: string[];
  equipment: string;
  loadMode: LoadMode;
  unit: WeightUnit;
  archived: boolean;
}

export interface Exercise extends ExerciseDetails {
  id: string;
}

export interface ExerciseNote extends Exercise {
  path: string;
}

export type ExerciseChoice = Pick<Exercise, 'id' | 'name' | 'aliases' | 'equipment' | 'unit' | 'archived'> & {
  missingNote?: boolean;
};

export interface WorkoutSet {
  id: string;
  exerciseId: string;
  exerciseName: string;
  reps: number;
  load: SetLoad;
  warmup: boolean;
}

export interface Workout {
  schemaVersion: typeof SCHEMA_VERSION;
  id: string;
  date: string;
  createdAt: string;
  notes: string;
  sets: WorkoutSet[];
}

export interface WorkoutFile {
  path: string;
  workout: Workout;
}

export interface LedgerData {
  exercises: ExerciseNote[];
  workouts: WorkoutFile[];
  issues: string[];
}

export type WorkoutChange =
  | { kind: 'add'; set: WorkoutSet }
  | { kind: 'edit'; original: WorkoutSet; set: WorkoutSet }
  | { kind: 'remove'; original: WorkoutSet }
  | { kind: 'notes'; original: string; value: string };

export function localDate(date = new Date()): string {
  const year = String(date.getFullYear()).padStart(4, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function resolveWorkoutDate(date: string, followsToday: boolean, now = new Date()): string {
  return followsToday ? localDate(now) : date;
}

export function isDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith('0000')) {
    return false;
  }
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

function isTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const timestamp = new Date(value);
  return Number.isFinite(timestamp.valueOf()) && timestamp.toISOString() === value;
}

export function makeId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function isId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isUnit(value: unknown): value is WeightUnit {
  return value === 'lb' || value === 'kg';
}

export function isLoadMode(value: unknown): value is LoadMode {
  return loadModes.some((mode) => mode.value === value);
}

function isName(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 120 && !/[\r\n]/.test(value);
}

function isLoad(value: unknown): value is SetLoad {
  if (!isRecord(value)) return false;
  if (value.mode === 'bodyweight') return true;
  return isLoadMode(value.mode) && isUnit(value.unit) && typeof value.value === 'number' &&
    Number.isFinite(value.value) && value.value <= 100_000 &&
    (value.mode === 'weight' ? value.value >= 0 : value.value > 0);
}

function isSet(value: unknown): value is WorkoutSet {
  return isRecord(value) && isId(value.id) && isId(value.exerciseId) && isName(value.exerciseName) &&
    typeof value.reps === 'number' && Number.isInteger(value.reps) && value.reps >= 1 && value.reps <= 1000 &&
    isLoad(value.load) && typeof value.warmup === 'boolean';
}

export function validateSet(set: WorkoutSet): WorkoutSet {
  if (!isSet(set)) {
    throw new Error('Enter 1 to 1000 whole reps and a valid load. Added weight and assistance must be positive.');
  }
  return set;
}

export function parseWorkout(text: string): Workout {
  const value: unknown = JSON.parse(text);
  if (!isRecord(value) || value.schemaVersion !== SCHEMA_VERSION) {
    throw new Error('Unsupported workout schema.');
  }
  if (!isId(value.id) || !isDate(value.date) || !isTimestamp(value.createdAt) ||
      typeof value.notes !== 'string' || !Array.isArray(value.sets) || !value.sets.every(isSet) ||
      new Set(value.sets.map((set) => set.id)).size !== value.sets.length) {
    throw new Error('Invalid workout record.');
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    id: value.id,
    date: value.date,
    createdAt: value.createdAt,
    notes: value.notes,
    sets: value.sets,
  };
}

export function createWorkout(date: string): Workout {
  if (!isDate(date)) throw new Error('Choose a valid workout date.');
  return { schemaVersion: SCHEMA_VERSION, id: makeId(), date, createdAt: new Date().toISOString(), notes: '', sets: [] };
}

export function compareWorkouts(a: Workout, b: Workout): number {
  return a.date.localeCompare(b.date) || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
}

export function changeWorkout(workout: Workout, change: WorkoutChange): Workout {
  if (change.kind === 'notes') {
    if (workout.notes !== change.original) throw new Error('The workout note changed. Refresh and try again.');
    return { ...workout, notes: change.value };
  }
  if (change.kind === 'add') {
    const set = validateSet(change.set);
    if (workout.sets.some((existing) => existing.id === set.id)) throw new Error('This set was already saved.');
    return { ...workout, sets: [...workout.sets, set] };
  }

  const index = workout.sets.findIndex((set) => set.id === change.original.id);
  if (index === -1 || JSON.stringify(workout.sets[index]) !== JSON.stringify(change.original)) {
    throw new Error('This set changed or was removed. Refresh and try again.');
  }
  const sets = [...workout.sets];
  if (change.kind === 'remove') {
    sets.splice(index, 1);
  } else {
    if (change.set.id !== change.original.id || change.set.exerciseId !== change.original.exerciseId) {
      throw new Error('Set and exercise IDs are fixed.');
    }
    sets[index] = validateSet(change.set);
  }
  return { ...workout, sets };
}

export function exerciseFrontmatter(exercise: Exercise): Record<string, unknown> {
  return {
    set_ledger_id: exercise.id,
    set_ledger_schema: SCHEMA_VERSION,
    exercise_name: exercise.name,
    aliases: exercise.aliases,
    equipment: exercise.equipment,
    load_mode: exercise.loadMode,
    weight_unit: exercise.unit,
    archived: exercise.archived,
  };
}

export function readExercise(value: unknown): Exercise | null {
  if (!isRecord(value) || !Object.prototype.hasOwnProperty.call(value, 'set_ledger_id')) return null;
  if (!isId(value.set_ledger_id) || value.set_ledger_schema !== SCHEMA_VERSION || !isName(value.exercise_name) ||
      !isLoadMode(value.load_mode) || !isUnit(value.weight_unit)) {
    throw new Error('Invalid or unsupported exercise properties.');
  }
  const aliases: unknown = value.aliases ?? [];
  const equipment: unknown = value.equipment ?? '';
  const archived: unknown = value.archived ?? false;
  if (!Array.isArray(aliases) || !aliases.every(isName) || typeof equipment !== 'string' || typeof archived !== 'boolean') {
    throw new Error('Invalid or unsupported exercise properties.');
  }
  return {
    id: value.set_ledger_id,
    name: value.exercise_name,
    aliases,
    equipment,
    loadMode: value.load_mode,
    unit: value.weight_unit,
    archived,
  };
}

export function describeSet(set: WorkoutSet): string {
  const { load } = set;
  switch (load.mode) {
    case 'bodyweight': return `${set.reps} reps · bodyweight`;
    case 'added': return `${set.reps} reps · +${load.value} ${load.unit}`;
    case 'assistance': return `${set.reps} reps · ${load.value} ${load.unit} assistance`;
    case 'weight': return `${set.reps} reps · ${load.value} ${load.unit}`;
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
