import { progressExercises } from './analytics.ts';
import { starterExercises, suggestExercises } from './catalog.ts';
import {
  combineAliases, distanceUnits, isDate, isDistanceUnit, isId, isRecord, isUnit, measurements, nameKey,
  parseWorkout, SCHEMA_VERSION, setMeasurements,
  type DistanceUnit, type Exercise, type ExerciseChoice, type LedgerData, type Measurement,
  type SetDistance, type SetLoad, type Workout, type WorkoutSet,
} from './model.ts';

interface ExerciseSuggestion {
  exerciseId: string;
  name: string;
}

export interface ImportIssue {
  code: string;
  path: string;
  message: string;
  suggestions?: ExerciseSuggestion[];
}

export interface WorkoutImportPlan {
  exercises: Exercise[];
  workouts: Workout[];
  skippedWorkoutIds: string[];
  issues: ImportIssue[];
}

type DraftSet = Omit<WorkoutSet, 'id'> & { id?: string };

interface DraftExercise {
  exercise: Exercise;
  measurementsSpecified: boolean;
  distanceUnitSpecified: boolean;
}

const measurementKeys = Object.keys(measurements) as Measurement[];
const rootFields = ['schemaVersion', 'exercises', 'workouts'];
const exerciseFields = ['name', 'id', 'aliases', 'measurements', 'distanceUnit'];
const workoutFields = ['schemaVersion', 'id', 'date', 'createdAt', 'notes', 'sets'];
const setFields = ['id', 'exerciseId', 'exerciseName', 'reps', 'load', 'durationSeconds', 'distance', 'warmup'];

class ExerciseIndex {
  readonly byId = new Map<string, ExerciseChoice>();
  private readonly names = new Map<string, ExerciseChoice[]>();

  add(exercise: ExerciseChoice): void {
    this.byId.set(exercise.id, exercise);
    for (const key of new Set([exercise.name, ...exercise.aliases].map(nameKey))) {
      const matches = this.names.get(key) ?? [];
      matches.push(exercise);
      this.names.set(key, matches);
    }
  }

  find(name: string): ExerciseChoice[] {
    return this.names.get(nameKey(name)) ?? [];
  }
}

export function importExerciseCatalog(data: LedgerData): ExerciseChoice[] {
  const known = progressExercises(data);
  return [...known, ...starterExercises(known)].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

function issue(issues: ImportIssue[], code: string, path: string, message: string, matches?: ExerciseChoice[]): void {
  const next: ImportIssue = { code, path, message };
  if (matches?.length) next.suggestions = matches.map(({ id, name }) => ({ exerciseId: id, name }));
  issues.push(next);
}

function checkFields(value: Record<string, unknown>, path: string, fields: string[], issues: ImportIssue[]): void {
  for (const key of Object.keys(value)) {
    if (fields.includes(key)) continue;
    const fieldPath = /^[a-zA-Z_]\w*$/.test(key) ? (path ? `${path}.${key}` : key) : `${path}[${JSON.stringify(key)}]`;
    issue(issues, 'UNKNOWN_FIELD', fieldPath, `Remove this field. Accepted fields are ${fields.join(', ')}.`);
  }
}

function checkVersion(value: unknown, path: string, issues: ImportIssue[]): void {
  if (value !== undefined && value !== 1 && value !== SCHEMA_VERSION) {
    issue(issues, 'UNSUPPORTED_SCHEMA', path, 'Omit schemaVersion or use 1 or 2. The importer selects the saved format from the measurements.');
  }
}

function readId(value: unknown, path: string, issues: ImportIssue[]): string | undefined {
  if (value === undefined) return undefined;
  const id = typeof value === 'string' ? value.trim().toLowerCase() : value;
  if (isId(id)) return id;
  issue(issues, 'INVALID_ID', path, 'Use a UUID such as 12345678-1234-4123-8123-123456789abc, or omit this field.');
}

function readName(value: unknown, path: string, issues: ImportIssue[]): string | undefined {
  if (typeof value === 'string' && value.trim() && value.trim().length <= 120 && !/[\r\n]/.test(value)) return value.trim();
  issue(issues, 'INVALID_NAME', path, 'Enter a nonempty name of at most 120 characters on one line.');
}

async function stableId(kind: string, value: unknown): Promise<string> {
  const input = new TextEncoder().encode(JSON.stringify(['rep-journal-import-v1', kind, value]));
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', input)).subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x80;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function readAliases(value: unknown, path: string, issues: ImportIssue[]): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    issue(issues, 'INVALID_ARRAY', path, 'Enter an array of exercise names or omit aliases.');
    return [];
  }
  return value.flatMap((alias, index) => {
    const name = readName(alias, `${path}[${index}]`, issues);
    return name ? [name] : [];
  });
}

function readMeasurements(value: unknown, path: string, issues: ImportIssue[]): Measurement[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length === 0) {
    issue(issues, 'INVALID_MEASUREMENTS', path, 'Choose at least one of weight, reps, time, or distance.');
    return [];
  }
  const result = new Set<Measurement>();
  value.forEach((entry, index) => {
    const measurement = measurementKeys.find((key) => key === entry);
    if (measurement) result.add(measurement);
    else issue(issues, 'INVALID_MEASUREMENT', `${path}[${index}]`, 'Use weight, reps, time, or distance.');
  });
  return [...result];
}

function readDistanceUnit(value: unknown, path: string, issues: ImportIssue[]): DistanceUnit | undefined {
  if (isDistanceUnit(value)) return value;
  issue(issues, 'INVALID_DISTANCE_UNIT', path, `Enter the original distance unit as one of ${distanceUnits.join(', ')}.`);
}

async function readExerciseDeclarations(
  value: unknown, catalog: ExerciseIndex, issues: ImportIssue[],
): Promise<Map<string, DraftExercise>> {
  const drafts = new Map<string, DraftExercise>();
  if (value === undefined) return drafts;
  if (!Array.isArray(value)) {
    issue(issues, 'INVALID_ARRAY', 'exercises', 'Enter an array of exercise declarations or omit exercises.');
    return drafts;
  }
  for (const [index, declaration] of value.entries()) {
    const path = `exercises[${index}]`;
    if (!isRecord(declaration)) {
      issue(issues, 'INVALID_OBJECT', path, 'Enter an exercise object with a name.');
      continue;
    }
    const errorCount = issues.length;
    checkFields(declaration, path, exerciseFields, issues);
    const name = readName(declaration.name, `${path}.name`, issues);
    const requestedId = readId(declaration.id, `${path}.id`, issues);
    const aliases = readAliases(declaration.aliases, `${path}.aliases`, issues);
    const tracked = readMeasurements(declaration.measurements, `${path}.measurements`, issues);
    const distanceUnit = declaration.distanceUnit === undefined ? undefined
      : readDistanceUnit(declaration.distanceUnit, `${path}.distanceUnit`, issues);
    if (!name || issues.length !== errorCount) continue;

    const matches = catalog.find(name);
    const byId = requestedId ? catalog.byId.get(requestedId) : undefined;
    const existing = byId ?? (matches.length === 1 ? matches[0] : undefined);
    if (byId && !matches.some((entry) => entry.id === byId.id)) {
      issue(issues, 'EXERCISE_ID_CONFLICT', `${path}.id`, 'This ID already belongs to an exercise with a different name. Use its existing name or use another ID.', [byId]);
      continue;
    }
    if (!byId && matches.length > 1) {
      issue(issues, 'AMBIGUOUS_EXERCISE', `${path}.name`, 'Multiple exercises match this name. Provide the intended exercise ID.', matches);
      continue;
    }
    if (existing && requestedId && requestedId !== existing.id) {
      issue(issues, 'EXERCISE_ID_CONFLICT', `${path}.id`, 'This name already belongs to a different exercise ID. Use the existing ID or choose a distinct name.', [existing]);
      continue;
    }
    for (const [aliasIndex, alias] of aliases.entries()) {
      const conflicts = catalog.find(alias).filter((candidate) => candidate.id !== existing?.id);
      if (conflicts.length) issue(issues, 'EXERCISE_ALIAS_CONFLICT', `${path}.aliases[${aliasIndex}]`,
        `The alias "${alias}" already belongs to an exercise. Remove it or choose a different alias.`, conflicts);
    }
    if (existing) {
      if (drafts.has(existing.id)) {
        issue(issues, 'DUPLICATE_EXERCISE', `${path}.name`, 'Declare each new exercise once.', [existing]);
      }
      continue;
    }
    if (issues.length !== errorCount) continue;
    const id = requestedId ?? await stableId('exercise', nameKey(name));
    const collision = catalog.byId.get(id);
    if (collision) {
      issue(issues, 'EXERCISE_ID_CONFLICT', `${path}.id`, 'The generated ID already belongs to another exercise. Supply a different unused ID.', [collision]);
      continue;
    }
    const exercise: Exercise = {
      id, name, aliases: combineAliases(name, aliases), equipment: '', archived: false,
      loadMode: 'weight', unit: 'lb', measurements: tracked, distanceUnit: distanceUnit ?? 'm', tags: [],
    };
    drafts.set(id, {
      exercise, measurementsSpecified: declaration.measurements !== undefined,
      distanceUnitSpecified: declaration.distanceUnit !== undefined,
    });
    catalog.add(exercise);
  }
  return drafts;
}

function resolveExercise(
  set: Record<string, unknown>, path: string, catalog: ExerciseIndex, issues: ImportIssue[],
  fuzzyMatches: (name: string) => ExerciseChoice[],
): ExerciseChoice | undefined {
  const errorCount = issues.length;
  const id = readId(set.exerciseId, `${path}.exerciseId`, issues);
  const name = set.exerciseName === undefined ? undefined : readName(set.exerciseName, `${path}.exerciseName`, issues);
  if (issues.length !== errorCount) return;
  const matches = name ? catalog.find(name) : [];
  if (id) {
    const exercise = catalog.byId.get(id);
    if (!exercise) {
      issue(issues, 'UNKNOWN_EXERCISE_ID', `${path}.exerciseId`,
        'Choose an ID from the exercise catalog, or omit exerciseId and provide an exact name or alias.',
        matches.length ? matches : name ? fuzzyMatches(name) : []);
      return;
    }
    if (matches.length && !matches.some((candidate) => candidate.id === id)) {
      issue(issues, 'EXERCISE_ID_NAME_CONFLICT', `${path}.exerciseId`,
        'The ID and name identify different exercises. Correct the ID or name to select the intended entry.', [exercise, ...matches]);
      return;
    }
    return exercise;
  }
  if (!name) {
    issue(issues, 'MISSING_EXERCISE', `${path}.exerciseName`, 'Provide an exerciseName or a known exerciseId.');
  } else if (matches.length === 1) {
    return matches[0];
  } else if (matches.length > 1) {
    issue(issues, 'AMBIGUOUS_EXERCISE', `${path}.exerciseName`, 'Multiple exercises match exactly. Supply the intended exerciseId.', matches);
  } else {
    issue(issues, 'UNKNOWN_EXERCISE', `${path}.exerciseName`,
      `No exercise matches "${name}". Choose an existing name, alias, or ID, or declare a new exercise in exercises.`, fuzzyMatches(name));
  }
}

function readLoad(value: unknown, path: string, issues: ImportIssue[]): SetLoad | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    issue(issues, 'INVALID_OBJECT', path, 'Enter a load object with value and unit, or omit load.');
    return;
  }
  const errorCount = issues.length;
  checkFields(value, path, ['mode', 'value', 'unit'], issues);
  const mode = value.mode === undefined ? 'weight' : value.mode;
  if (mode === 'bodyweight') {
    if (value.value !== undefined || value.unit !== undefined) {
      issue(issues, 'INVALID_LOAD', path, 'Use only mode for a bodyweight load. Use weight, added, or assistance for a measured load.');
    }
    if (issues.length === errorCount) return { mode };
    return;
  }
  if (mode !== 'weight' && mode !== 'added' && mode !== 'assistance') {
    issue(issues, 'INVALID_LOAD_MODE', `${path}.mode`, 'Use weight, bodyweight, added, or assistance. Omit mode for weight.');
    return;
  }
  const validAmount = typeof value.value === 'number' && Number.isFinite(value.value) &&
    value.value <= 100_000 && (mode === 'weight' ? value.value >= 0 : value.value > 0);
  if (!validAmount) issue(issues, 'INVALID_LOAD_VALUE', `${path}.value`,
    mode === 'weight' ? 'Enter a number from 0 to 100000.' : 'Enter a positive number up to 100000.');
  if (!isUnit(value.unit)) {
    issue(issues, 'INVALID_WEIGHT_UNIT', `${path}.unit`, 'Enter the original weight unit as lb or kg.');
  } else if (validAmount && typeof value.value === 'number' && issues.length === errorCount) {
    return { mode, value: value.value, unit: value.unit };
  }
}

function readDistance(value: unknown, path: string, issues: ImportIssue[]): SetDistance | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    issue(issues, 'INVALID_OBJECT', path, 'Enter a distance object with value and unit, or omit distance.');
    return;
  }
  const errorCount = issues.length;
  checkFields(value, path, ['value', 'unit'], issues);
  const unit = readDistanceUnit(value.unit, `${path}.unit`, issues);
  if (typeof value.value !== 'number' || !Number.isFinite(value.value) || value.value <= 0) {
    issue(issues, 'INVALID_DISTANCE_VALUE', `${path}.value`, 'Enter a positive distance as a number.');
  } else if (unit && issues.length === errorCount) {
    return { value: value.value, unit };
  }
}

function readInteger(value: unknown, path: string, maximum: number, issues: ImportIssue[]): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= maximum) return value;
  const isReps = maximum === 1000;
  issue(issues, isReps ? 'INVALID_REPS' : 'INVALID_DURATION', path,
    isReps ? 'Enter a whole number from 1 to 1000.' : 'Enter the duration in positive whole seconds.');
}

function readSet(
  value: unknown, path: string, catalog: ExerciseIndex, issues: ImportIssue[],
  fuzzyMatches: (name: string) => ExerciseChoice[],
): DraftSet | undefined {
  if (!isRecord(value)) {
    issue(issues, 'INVALID_OBJECT', path, 'Enter an object with an exercise and one or more measurements.');
    return;
  }
  const errorCount = issues.length;
  checkFields(value, path, setFields, issues);
  const id = readId(value.id, `${path}.id`, issues);
  const exercise = resolveExercise(value, path, catalog, issues, fuzzyMatches);
  const beforeMeasurements = issues.length;
  const reps = readInteger(value.reps, `${path}.reps`, 1000, issues);
  const durationSeconds = readInteger(value.durationSeconds, `${path}.durationSeconds`, Number.MAX_SAFE_INTEGER, issues);
  const load = readLoad(value.load, `${path}.load`, issues);
  const distance = readDistance(value.distance, `${path}.distance`, issues);
  if (issues.length === beforeMeasurements && reps === undefined && durationSeconds === undefined &&
      !distance && (!load || load.mode === 'bodyweight')) {
    issue(issues, 'MISSING_MEASUREMENT', path, 'Provide reps, a measured load, durationSeconds, or distance.');
  }
  if (value.warmup !== undefined && typeof value.warmup !== 'boolean') {
    issue(issues, 'INVALID_BOOLEAN', `${path}.warmup`, 'Use true or false, or omit warmup.');
  }
  if (exercise && issues.length === errorCount) {
    return { id, exerciseId: exercise.id, exerciseName: exercise.name, reps, load, durationSeconds, distance, warmup: value.warmup === true };
  }
}

function readCreatedAt(value: unknown, date: string | undefined, path: string, issues: ImportIssue[]): string | undefined {
  if (value === undefined) return date ? `${date}T00:00:00.000Z` : undefined;
  if (typeof value === 'string') {
    const instant = new Date(value);
    if (Number.isFinite(instant.valueOf()) && instant.toISOString() === value) return value;
  }
  issue(issues, 'INVALID_TIMESTAMP', path, 'Use a UTC ISO timestamp such as 2026-11-20T08:30:00.000Z, or omit createdAt.');
}

function recordedMeasurements(set: DraftSet): unknown[] {
  const { load, distance } = set;
  const loadIdentity = load && load.mode !== 'bodyweight' ? [load.mode, load.value, load.unit] : null;
  return [set.exerciseId, set.reps, loadIdentity, set.durationSeconds, distance ? [distance.value, distance.unit] : null];
}

function setIdentity(set: DraftSet): unknown[] {
  return [...recordedMeasurements(set), set.warmup];
}

function workoutIdentity(workout: Workout): string {
  return JSON.stringify([workout.date, workout.createdAt, workout.notes, workout.sets.map((set) => [set.id, ...setIdentity(set)])]);
}

function workoutMeasurements(workout: Workout): string {
  return JSON.stringify([workout.date, workout.sets.map(recordedMeasurements)]);
}

async function readWorkout(
  value: unknown, path: string, catalog: ExerciseIndex, issues: ImportIssue[],
  fuzzyMatches: (name: string) => ExerciseChoice[],
): Promise<Workout | undefined> {
  if (!isRecord(value)) {
    issue(issues, 'INVALID_OBJECT', path, 'Enter a workout object with date and sets.');
    return;
  }
  const errorCount = issues.length;
  checkFields(value, path, workoutFields, issues);
  checkVersion(value.schemaVersion, `${path}.schemaVersion`, issues);
  const id = readId(value.id, `${path}.id`, issues);
  const date = isDate(value.date) ? value.date : undefined;
  if (!date) issue(issues, 'INVALID_DATE', `${path}.date`, 'Use a valid calendar date in YYYY-MM-DD format.');
  const createdAt = readCreatedAt(value.createdAt, date, `${path}.createdAt`, issues);
  const notes = value.notes === undefined ? '' : value.notes;
  if (typeof notes !== 'string') issue(issues, 'INVALID_NOTES', `${path}.notes`, 'Use a string or omit notes.');
  const drafts: DraftSet[] = [];
  const setIds = new Set<string>();
  if (Array.isArray(value.sets)) {
    value.sets.forEach((entry, index) => {
      const setPath = `${path}.sets[${index}]`;
      const draft = readSet(entry, setPath, catalog, issues, fuzzyMatches);
      if (draft) {
        if (draft.id && setIds.has(draft.id)) {
          issue(issues, 'DUPLICATE_SET_ID', `${setPath}.id`, 'Each set in a workout needs a distinct ID. Omit id to let the importer generate one.');
        }
        if (draft.id) setIds.add(draft.id);
        drafts.push(draft);
      }
    });
  } else {
    issue(issues, 'INVALID_ARRAY', `${path}.sets`, 'Enter an array of sets.');
  }
  if (!date || !createdAt || typeof notes !== 'string' || issues.length !== errorCount) return;
  const workoutId = id ?? await stableId('workout', [date, createdAt, notes, drafts.map(setIdentity)]);
  const sets = await Promise.all(drafts.map(async (set, index): Promise<WorkoutSet> => ({
    ...set, id: set.id ?? await stableId('set', [workoutId, index]),
  })));
  if (new Set(sets.map((set) => set.id)).size !== sets.length) {
    issue(issues, 'DUPLICATE_SET_ID', `${path}.sets`, 'A supplied set ID collides with a generated ID. Omit the supplied ID or change it.');
    return;
  }
  const fitsLegacy = sets.every((set) => set.reps !== undefined && set.load !== undefined && !set.durationSeconds && !set.distance);
  return parseWorkout(JSON.stringify({ schemaVersion: fitsLegacy ? 1 : SCHEMA_VERSION, id: workoutId, date, createdAt, notes, sets }));
}

function finalizeDraft(draft: DraftExercise, sets: WorkoutSet[]): Exercise {
  const { exercise, measurementsSpecified, distanceUnitSpecified } = draft;
  const used = new Set(sets.flatMap(setMeasurements));
  const tracked = measurementsSpecified ? exercise.measurements : used.size
    ? measurementKeys.filter((measurement) => used.has(measurement)) : ['weight', 'reps'] as Measurement[];
  const loads = sets.flatMap(({ load }) => load && load.mode !== 'bodyweight' ? [load] : []);
  const modes = new Set(loads.map(({ mode }) => mode));
  const loadMode = tracked.includes('weight') ? (modes.size === 1 ? loads[0].mode : 'weight') : 'bodyweight';
  return {
    ...exercise, measurements: tracked, loadMode, unit: loads[0]?.unit ?? exercise.unit,
    distanceUnit: distanceUnitSpecified ? exercise.distanceUnit : sets.find((set) => set.distance)?.distance?.unit ?? exercise.distanceUnit,
  };
}

function notesToCreate(
  drafts: Map<string, DraftExercise>, workouts: Workout[], catalog: ExerciseIndex,
): Exercise[] {
  const setsByExercise = new Map<string, WorkoutSet[]>();
  for (const set of workouts.flatMap(({ sets }) => sets)) {
    const sets = setsByExercise.get(set.exerciseId) ?? [];
    sets.push(set);
    setsByExercise.set(set.exerciseId, sets);
  }
  const notes = [...drafts.values()].map((draft) => finalizeDraft(draft, setsByExercise.get(draft.exercise.id) ?? []));
  for (const id of setsByExercise.keys()) {
    const match = catalog.byId.get(id);
    if (!match?.starter) continue;
    const { id: starterId, name, aliases, equipment, archived, measurements: tracked, distanceUnit, loadMode, unit, tags } = match;
    notes.push({ id: starterId, name, aliases, equipment, archived, measurements: tracked, distanceUnit, loadMode, unit, tags });
  }
  return notes;
}

export async function planWorkoutImport(input: unknown, data: LedgerData): Promise<WorkoutImportPlan> {
  const plan: WorkoutImportPlan = { exercises: [], workouts: [], skippedWorkoutIds: [], issues: [] };
  for (const problem of data.issues) issue(plan.issues, 'VAULT_DATA_INVALID', 'vault', problem);
  if (plan.issues.length) return plan;
  if (!isRecord(input)) {
    issue(plan.issues, 'INVALID_OBJECT', '$', 'Enter a JSON object with a workouts array.');
    return plan;
  }
  checkFields(input, '', rootFields, plan.issues);
  checkVersion(input.schemaVersion, 'schemaVersion', plan.issues);
  if (!Array.isArray(input.workouts)) {
    issue(plan.issues, 'INVALID_ARRAY', 'workouts', 'Enter an array of workout objects.');
    return plan;
  }
  const catalog = new ExerciseIndex();
  for (const exercise of importExerciseCatalog(data)) catalog.add(exercise);
  const drafts = await readExerciseDeclarations(input.exercises, catalog, plan.issues);
  const byId = new Map(data.workouts.map(({ workout }) => [workout.id, workout]));
  const byMeasurements = new Map<string, string>();
  for (const { workout } of data.workouts) {
    if (workout.sets.length) byMeasurements.set(workoutMeasurements(workout), workout.id);
  }
  const imported = new Set<string>();
  const suggestionCache = new Map<string, ExerciseChoice[]>();
  const fuzzyMatches = (name: string): ExerciseChoice[] => {
    const key = nameKey(name);
    const matches = suggestionCache.get(key) ?? suggestExercises(name, catalog.byId.values());
    suggestionCache.set(key, matches);
    return matches;
  };
  for (const [index, value] of input.workouts.entries()) {
    const path = `workouts[${index}]`;
    const workout = await readWorkout(value, path, catalog, plan.issues, fuzzyMatches);
    if (!workout) continue;
    if (imported.has(workout.id)) {
      issue(plan.issues, 'DUPLICATE_WORKOUT_ID', `${path}.id`,
        'This workout duplicates another entry in the import. Remove a duplicate or provide distinct workout IDs for intentional copies.');
      continue;
    }
    imported.add(workout.id);
    const existing = byId.get(workout.id);
    if (existing) {
      if (workoutIdentity(existing) === workoutIdentity(workout)) {
        plan.skippedWorkoutIds.push(workout.id);
      } else {
        issue(plan.issues, 'WORKOUT_ID_CONFLICT', `${path}.id`,
          'This ID is already in the vault with different workout data. Use its original data or choose a different workout ID for a separate session.');
      }
      continue;
    }
    const possibleDuplicate = isRecord(value) && value.id === undefined ? byMeasurements.get(workoutMeasurements(workout)) : undefined;
    if (possibleDuplicate) {
      issue(plan.issues, 'POSSIBLE_DUPLICATE_WORKOUT', `${path}.id`,
        `The date and ordered set measurements match existing workout ${possibleDuplicate}. Remove this entry if it is already logged, or provide a distinct unused workout ID for a separate session.`);
      continue;
    }
    plan.workouts.push(workout);
  }
  if (plan.issues.length) return { ...plan, workouts: [], skippedWorkoutIds: [] };
  plan.exercises = notesToCreate(drafts, plan.workouts, catalog);
  return plan;
}
