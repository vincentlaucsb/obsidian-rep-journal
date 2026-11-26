import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import {
  changeWorkout, errorMessage, isRecord, nameKey, parseWorkout,
  type SetElevationGain, type WorkoutFile, type WorkoutSet,
} from '../src/model.ts';
import { importedSetId, readElevationGain, type ImportIssue } from '../src/workout-import.ts';
import {
  existingVaultFile, hasErrorCode, replaceVaultFile, readImportVault, VaultFileChanged, writeAutomaticCsv, type ImportVault,
} from './import-vault.ts';

const urlNamespace = new Uint8Array([0x6b, 0xa7, 0xb8, 0x11, 0x9d, 0xad, 0x11, 0xd1, 0x80, 0xb4, 0x00, 0xc0, 0x4f, 0xd4, 0x30, 0xc8]);
const mountainBikingNames = new Set(['mountain biking', 'mountain bike', 'mtb']);
type RawJsonReviver = (key: string, value: unknown, context: { source?: string }) => unknown;
const rawJson = JSON as unknown as {
  parse(text: string, reviver: RawJsonReviver): unknown;
  rawJSON(text: string): unknown;
};

function garminWorkoutId(activityId: string): string {
  const bytes = createHash('sha1').update(urlNamespace).update(`https://connect.garmin.com/modern/activity/${activityId}`).digest();
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex', 0, 16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

interface BackfillActivity {
  activityId: string;
  elevationGain: SetElevationGain;
}

interface BackfillResult extends BackfillActivity {
  workoutId: string;
  setId: string;
  status: 'eligible' | 'current' | 'conflict' | 'missing-workout' | 'missing-set' | 'ineligible-exercise';
  date?: string;
  path?: string;
  currentElevationGain?: SetElevationGain;
}

interface BackfillChange {
  result: BackfillResult;
  original: WorkoutFile;
  set: WorkoutSet;
}

export interface GarminElevationPlan {
  activities: BackfillResult[];
  changes: BackfillChange[];
  issues: ImportIssue[];
}

function readActivities(input: unknown, issues: ImportIssue[]): BackfillActivity[] {
  if (!isRecord(input) || !Array.isArray(input.activities) || Object.keys(input).some((key) => key !== 'activities')) {
    issues.push({ code: 'INVALID_ACTIVITIES', path: '$', message: 'Enter an object containing only an activities array.' });
    return [];
  }
  const seen = new Set<string>();
  return input.activities.flatMap((entry, index) => {
    const path = `activities[${index}]`;
    if (!isRecord(entry) || Object.keys(entry).some((key) => key !== 'activityId' && key !== 'elevationGain')) {
      issues.push({ code: 'INVALID_ACTIVITY', path, message: 'Use an object with activityId and elevationGain.' });
      return [];
    }
    const { activityId } = entry;
    if (typeof activityId !== 'string' || !/^[1-9]\d*$/.test(activityId)) {
      issues.push({ code: 'INVALID_GARMIN_ID', path: `${path}.activityId`, message: 'Enter the Garmin activity ID as a decimal string without leading zeros.' });
      return [];
    }
    if (seen.has(activityId)) {
      issues.push({ code: 'DUPLICATE_GARMIN_ID', path: `${path}.activityId`, message: 'Include each Garmin activity only once.' });
      return [];
    }
    seen.add(activityId);
    if (entry.elevationGain === undefined) {
      issues.push({ code: 'MISSING_ELEVATION_GAIN', path: `${path}.elevationGain`, message: 'Supply source-reported elevation gain, or omit the activity.' });
      return [];
    }
    const elevationGain = readElevationGain(entry.elevationGain, `${path}.elevationGain`, issues);
    return elevationGain ? [{ activityId, elevationGain }] : [];
  });
}

export async function planGarminElevation(input: unknown, vault: ImportVault): Promise<GarminElevationPlan> {
  const plan: GarminElevationPlan = { activities: [], changes: [], issues: [...vault.issues] };
  if (plan.issues.length) return plan;
  const activities = readActivities(input, plan.issues);
  if (plan.issues.length) return plan;

  const byId = new Map(vault.data.workouts.map((entry) => [entry.workout.id, entry]));
  const exercises = new Map(vault.data.exercises.map((entry) => [entry.id, entry]));
  for (const activity of activities) {
    const workoutId = garminWorkoutId(activity.activityId);
    const setId = await importedSetId(workoutId, 0);
    const result: BackfillResult = { ...activity, workoutId, setId, status: 'missing-workout' };
    plan.activities.push(result);
    const original = byId.get(workoutId);
    if (!original) continue;

    result.path = original.path;
    result.date = original.workout.date;
    const set = original.workout.sets.find(({ id }) => id === setId);
    if (!set) {
      result.status = 'missing-set';
      continue;
    }
    const exercise = exercises.get(set.exerciseId);
    const names = exercise ? [exercise.name, ...exercise.aliases] : [set.exerciseName];
    if (!names.some((name) => mountainBikingNames.has(nameKey(name)))) {
      result.status = 'ineligible-exercise';
      continue;
    }
    const current = set.elevationGain;
    if (current) {
      result.currentElevationGain = current;
      result.status = current.unit === activity.elevationGain.unit && current.value === activity.elevationGain.value ? 'current' : 'conflict';
      continue;
    }
    result.status = 'eligible';
    plan.changes.push({ result, original, set });
  }
  return plan;
}

export async function writeGarminElevation(vault: ImportVault, plan: GarminElevationPlan) {
  const written = { exercises: [], workouts: [] as Array<{ activityId: string; workoutId: string; setId: string; path: string }> };
  const issues: ImportIssue[] = [];
  if (plan.issues.length) return { written, issues: plan.issues };
  for (const { result, original, set } of plan.changes) {
    const { activityId, workoutId, setId, elevationGain } = result;
    const { path } = original;
    try {
      const file = await existingVaultFile(vault.root, path);
      const bytes = await readFile(file);
      const text = bytes.toString('utf8');
      const current = parseWorkout(text);
      if (!isDeepStrictEqual(current, original.workout)) throw new VaultFileChanged();
      const updated = changeWorkout(current, { kind: 'edit', original: set, set: { ...set, elevationGain } });
      // The raw record also contains user metadata, whose numbers may lie outside Number precision.
      const raw = rawJson.parse(text, (_key, value, { source }) =>
        typeof value === 'number' && source !== undefined ? rawJson.rawJSON(source) : value);
      const rawSet: unknown = isRecord(raw) && Array.isArray(raw.sets)
        ? raw.sets[current.sets.findIndex(({ id }) => id === setId)] : undefined;
      if (!isRecord(raw) || !isRecord(rawSet)) throw new Error('Invalid workout record.');
      rawSet.elevationGain = elevationGain;
      if (updated.schemaVersion !== current.schemaVersion) raw.schemaVersion = updated.schemaVersion;
      await replaceVaultFile(file, bytes, `${JSON.stringify(raw, null, 2)}\n`);
      written.workouts.push({ activityId, workoutId, setId, path });
    } catch (error: unknown) {
      if (error instanceof VaultFileChanged || hasErrorCode(error, 'ENOENT')) {
        result.status = 'conflict';
        issues.push({ code: 'VAULT_WORKOUT_CHANGED', path, message: 'The workout changed during backfill. Preview again before retrying.' });
      } else {
        issues.push({ code: 'VAULT_WRITE_FAILED', path, message: errorMessage(error) });
      }
    }
  }
  if (written.workouts.length || plan.activities.some(({ status }) => status === 'current')) {
    try {
      await writeAutomaticCsv(written.workouts.length ? await readImportVault(vault.root, vault.folder) : vault);
    } catch (error: unknown) {
      issues.push({ code: 'AUTOMATIC_CSV_FAILED', path: `${vault.folder}/Exports`, message: errorMessage(error) });
    }
  }
  return { written, issues };
}
