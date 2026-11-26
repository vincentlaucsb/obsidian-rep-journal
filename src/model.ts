import { convertDistance, convertWeight } from './units.ts';

const LEGACY_SCHEMA_VERSION = 1;
export const SCHEMA_VERSION = 2;

export type WeightUnit = 'lb' | 'kg';
export type LoadMode = 'weight' | 'bodyweight' | 'added' | 'assistance';

export const measurements = { weight: 'Weight', reps: 'Reps', time: 'Time', distance: 'Distance', elevationGain: 'Elevation gain' } as const;
export type Measurement = keyof typeof measurements;
export const distanceUnits = ['m', 'km', 'mi', 'yd', 'ft'] as const;
export type DistanceUnit = typeof distanceUnits[number];
export const elevationUnits = ['m', 'ft'] as const;
export type ElevationUnit = typeof elevationUnits[number];
export const tagGroups = {
  region: 'Body region', role: 'Training role', muscles: 'Muscle group',
  activity: 'Activity type', movement: 'Movement pattern', custom: 'Ungrouped',
} as const;
export type TagGroup = keyof typeof tagGroups;

export interface ExerciseTag {
  group: TagGroup;
  name: string;
}

export interface SetDistance {
  value: number;
  unit: DistanceUnit;
}

export interface SetElevationGain {
  value: number;
  unit: ElevationUnit;
}

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
  measurements?: Measurement[];
  weightUnit?: WeightUnit;
  distanceUnit?: DistanceUnit;
  elevationUnit?: ElevationUnit;
  tags?: ExerciseTag[];
}

export interface Exercise extends ExerciseDetails {
  id: string;
  measurements: Measurement[];
  tags: ExerciseTag[];
}

export interface ExerciseNote extends Exercise {
  path: string;
}

export type ExerciseChoice = Exercise & {
  missingNote?: boolean;
  starter?: boolean;
};

export interface WorkoutSet {
  id: string;
  exerciseId: string;
  exerciseName: string;
  reps?: number;
  load?: SetLoad;
  durationSeconds?: number;
  distance?: SetDistance;
  elevationGain?: SetElevationGain;
  warmup: boolean;
}

export interface Workout {
  schemaVersion: typeof LEGACY_SCHEMA_VERSION | typeof SCHEMA_VERSION;
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

function isLoadMode(value: unknown): value is LoadMode {
  return value === 'weight' || value === 'bodyweight' || value === 'added' || value === 'assistance';
}

function isName(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 120 && !/[\r\n]/.test(value);
}

export function isDistanceUnit(value: unknown): value is DistanceUnit {
  return distanceUnits.some((unit) => value === unit);
}

export function isElevationUnit(value: unknown): value is ElevationUnit {
  return value === 'm' || value === 'ft';
}

export function isElevationGain(value: unknown): value is SetElevationGain {
  return isRecord(value) && isElevationUnit(value.unit) && typeof value.value === 'number' &&
    Number.isFinite(value.value) && value.value >= 0;
}

function isMeasurement(value: unknown): value is Measurement {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(measurements, value);
}

function isTagGroup(value: string): value is TagGroup {
  return Object.prototype.hasOwnProperty.call(tagGroups, value);
}

export function nameKey(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLowerCase();
}

export function tagKey(tag: ExerciseTag): string {
  return `${tag.group}/${nameKey(tag.name)}`;
}

export function combineAliases(name: string, aliases: string[], previousName?: string): string[] {
  const known = new Set([nameKey(name)]);
  const result: string[] = [];
  for (const entry of previousName ? [...aliases, previousName] : aliases) {
    const key = nameKey(entry);
    if (!key || known.has(key)) continue;
    known.add(key);
    result.push(entry.trim());
  }
  return result;
}

function readTags(value: unknown): ExerciseTag[] {
  if (!Array.isArray(value)) throw new Error('Invalid exercise tags.');
  const tags = new Map<string, ExerciseTag>();
  for (const entry of value) {
    if (typeof entry !== 'string') throw new Error('Invalid exercise tag.');
    const slash = entry.indexOf('/');
    if (slash < 1) throw new Error('Invalid exercise tag.');
    const group = entry.slice(0, slash);
    const name = entry.slice(slash + 1).trim();
    if (!isTagGroup(group) || !isName(name)) throw new Error('Invalid exercise tag.');
    const tag = { group, name };
    tags.set(tagKey(tag), tag);
  }
  return [...tags.values()];
}

export function setMeasurements(set: WorkoutSet): Measurement[] {
  const tracked: Measurement[] = [];
  if (set.load && set.load.mode !== 'bodyweight') tracked.push('weight');
  if (set.reps !== undefined) tracked.push('reps');
  if (set.durationSeconds !== undefined) tracked.push('time');
  if (set.distance !== undefined) tracked.push('distance');
  if (set.elevationGain !== undefined) tracked.push('elevationGain');
  return tracked;
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
    typeof value.warmup === 'boolean' &&
    (value.reps === undefined || (typeof value.reps === 'number' && Number.isInteger(value.reps) && value.reps >= 1 && value.reps <= 1000)) &&
    (value.load === undefined || isLoad(value.load)) &&
    (value.durationSeconds === undefined ||
      (typeof value.durationSeconds === 'number' && Number.isSafeInteger(value.durationSeconds) && value.durationSeconds > 0)) &&
    (value.distance === undefined ||
      (isRecord(value.distance) && isDistanceUnit(value.distance.unit) && typeof value.distance.value === 'number' &&
        Number.isFinite(value.distance.value) && value.distance.value > 0)) &&
    (value.elevationGain === undefined || isElevationGain(value.elevationGain)) &&
    (value.reps !== undefined || (isRecord(value.load) && value.load.mode !== 'bodyweight') ||
      value.durationSeconds !== undefined || value.distance !== undefined || value.elevationGain !== undefined);
}

function fitsLegacySchema(set: WorkoutSet): boolean {
  return set.reps !== undefined && set.load !== undefined && set.durationSeconds === undefined && set.distance === undefined &&
    set.elevationGain === undefined;
}

export function validateSet(set: WorkoutSet): WorkoutSet {
  if (!isSet(set)) {
    throw new Error('Enter valid measurements. Reps must be a whole number from 1 to 1000. Time and distance must be positive. Elevation gain must be zero or greater.');
  }
  return set;
}

export function parseWorkout(text: string): Workout {
  const value: unknown = JSON.parse(text);
  if (!isRecord(value) || (value.schemaVersion !== LEGACY_SCHEMA_VERSION && value.schemaVersion !== SCHEMA_VERSION)) {
    throw new Error('Unsupported workout schema.');
  }
  if (!isId(value.id) || !isDate(value.date) || !isTimestamp(value.createdAt) ||
      typeof value.notes !== 'string' || !Array.isArray(value.sets) || !value.sets.every(isSet) ||
      (value.schemaVersion === LEGACY_SCHEMA_VERSION && !value.sets.every(fitsLegacySchema)) ||
      new Set(value.sets.map((set) => set.id)).size !== value.sets.length) {
    throw new Error('Invalid workout record.');
  }
  return {
    schemaVersion: value.schemaVersion,
    id: value.id,
    date: value.date,
    createdAt: value.createdAt,
    notes: value.notes,
    sets: value.sets,
  };
}

export function createWorkout(date: string): Workout {
  if (!isDate(date)) throw new Error('Choose a valid workout date.');
  return { schemaVersion: LEGACY_SCHEMA_VERSION, id: makeId(), date, createdAt: new Date().toISOString(), notes: '', sets: [] };
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
    return { ...workout, schemaVersion: fitsLegacySchema(set) ? workout.schemaVersion : SCHEMA_VERSION, sets: [...workout.sets, set] };
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
  const schemaVersion = change.kind === 'edit' && !fitsLegacySchema(change.set) ? SCHEMA_VERSION : workout.schemaVersion;
  return { ...workout, schemaVersion, sets };
}

export const exerciseUnitFields = ['weight_unit_override', 'distance_unit', 'elevation_unit'] as const;

export function exerciseFrontmatter(exercise: ExerciseDetails & { id: string }): Record<string, unknown> {
  return {
    set_ledger_id: exercise.id,
    set_ledger_schema: LEGACY_SCHEMA_VERSION,
    exercise_name: exercise.name,
    aliases: exercise.aliases,
    ...(exercise.equipment ? { equipment: exercise.equipment } : {}),
    load_mode: exercise.loadMode,
    weight_unit: exercise.unit,
    ...(exercise.weightUnit && { weight_unit_override: exercise.weightUnit }),
    archived: exercise.archived,
    exercise_measurements: exercise.measurements ?? (exercise.loadMode === 'bodyweight' ? ['reps'] : ['weight', 'reps']),
    ...(exercise.distanceUnit && { distance_unit: exercise.distanceUnit }),
    ...(exercise.elevationUnit && { elevation_unit: exercise.elevationUnit }),
    exercise_tags: (exercise.tags ?? []).map(({ group, name }) => `${group}/${name}`),
  };
}

export function readExercise(value: unknown): Exercise | null {
  if (!isRecord(value) || !Object.prototype.hasOwnProperty.call(value, 'set_ledger_id')) return null;
  if (!isId(value.set_ledger_id) || value.set_ledger_schema !== LEGACY_SCHEMA_VERSION || !isName(value.exercise_name) ||
      !isLoadMode(value.load_mode) || !isUnit(value.weight_unit)) {
    throw new Error('Invalid or unsupported exercise properties.');
  }
  const aliases: unknown = value.aliases ?? [];
  const equipment: unknown = value.equipment ?? '';
  const archived: unknown = value.archived ?? false;
  const tracked: unknown = value.exercise_measurements ?? (value.load_mode === 'bodyweight' ? ['reps'] : ['weight', 'reps']);
  const weightUnit = value.weight_unit_override ?? undefined;
  const distanceUnit = value.distance_unit ?? undefined;
  const elevationUnit = value.elevation_unit ?? undefined;
  if (!Array.isArray(aliases) || !aliases.every(isName) || typeof equipment !== 'string' || typeof archived !== 'boolean' ||
      (weightUnit !== undefined && !isUnit(weightUnit)) ||
      (distanceUnit !== undefined && !isDistanceUnit(distanceUnit)) || (elevationUnit !== undefined && !isElevationUnit(elevationUnit)) ||
      !Array.isArray(tracked) || !tracked.length || !tracked.every(isMeasurement)) {
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
    measurements: [...new Set(tracked)],
    ...(weightUnit && { weightUnit }),
    ...(distanceUnit && { distanceUnit }),
    ...(elevationUnit && { elevationUnit }),
    tags: readTags(value.exercise_tags ?? []),
  };
}

export function describeDistance(distance: SetDistance, preferredUnit?: DistanceUnit): string {
  if (!preferredUnit) return `${distance.value} ${distance.unit}`;
  return `${Number(convertDistance(distance.value, distance.unit, preferredUnit).toFixed(2))} ${preferredUnit}`;
}

export function describeElevationGain(elevation: SetElevationGain, preferredUnit?: ElevationUnit): string {
  const amount = preferredUnit ? Math.round(convertDistance(elevation.value, elevation.unit, preferredUnit)) : elevation.value;
  return `${amount} ${preferredUnit ?? elevation.unit} elevation gain`;
}

export function describeWeight(load: Exclude<SetLoad, { mode: 'bodyweight' }>, preferredUnit?: WeightUnit): string {
  if (!preferredUnit || preferredUnit === load.unit) return `${load.value} ${load.unit}`;
  return `${Number(convertWeight(load.value, load.unit, preferredUnit).toFixed(2))} ${preferredUnit}`;
}

export function describeSet(set: WorkoutSet, exercise?: Pick<Exercise, 'weightUnit' | 'distanceUnit' | 'elevationUnit'>): string {
  const { load, reps, durationSeconds, distance, elevationGain } = set;
  const parts: string[] = [];
  if (reps !== undefined) parts.push(`${reps} ${reps === 1 ? 'rep' : 'reps'}`);
  if (load && load.mode !== 'bodyweight') {
    const amount = describeWeight(load, exercise?.weightUnit);
    if (load.mode === 'added') parts.push(`+${amount}`);
    else if (load.mode === 'assistance') parts.push(`${amount} assistance`);
    else parts.push(amount);
  }
  if (durationSeconds !== undefined) parts.push(formatDuration(durationSeconds));
  if (distance) parts.push(describeDistance(distance, exercise?.distanceUnit));
  if (elevationGain) parts.push(describeElevationGain(elevationGain, exercise?.elevationUnit));
  return parts.join(' · ');
}

export function formatDuration(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor(seconds / 60) % 60;
  const remainder = String(seconds % 60).padStart(2, '0');
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${remainder}` : `${minutes}:${remainder}`;
}

export function parseDuration(text: string): number {
  const parts = text.trim().split(':');
  if (parts.length > 3 || parts.some((part) => !/^\d+$/.test(part))) return NaN;
  const values = parts.map(Number);
  if (values.slice(1).some((value) => value >= 60)) return NaN;
  return values.reduce((total, value) => total * 60 + value, 0);
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
