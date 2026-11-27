import { lstat, readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { parseDocument } from 'yaml';
import { progressExercises } from '../src/analytics.ts';
import { readCatalogExercise } from '../src/catalog.ts';
import { exportSnapshotFilename, serializeExport, type ExportFormat } from '../src/exports.ts';
import {
  ensureDirectory, exerciseNoteHeader, existingVaultFile, hasErrorCode, isInside, lockImportVault, readImportExercises, readImportVault,
  replaceVaultFile, unchangedImportVaultRecords, writeAutomaticCsv, writeImportVault, writeNewFile,
} from './import-vault.ts';
import { isWorkoutPlanPath, maxPlanBytes, prepareExerciseEdit, prepareLogSet, prepareStarter, prepareWorkoutEdit, readLogSetInput, workoutSaveResult, type WorkoutSaveResult, type PlanNote } from '../src/journal-workflow.ts';
import {
  changeWorkout, createWorkout, errorMessage, exerciseFrontmatter, exerciseUnitFields, localDate, parseWorkout, type Exercise, type ExerciseNote, type LedgerData,
  type WeightUnit, type WorkoutChange, type WorkoutFile,
} from '../src/model.ts';
import { isPlanYear, type DatedPlanNote, type DatedPlanRepository, type PlanPickerRepository } from '../src/repo/plan-repository.ts';
import { diskFileRevision, ledgerWithCommittedWorkout, type RecordRevisions } from '../src/repo/workout-snapshot.ts';
import type { MeasurementSystem } from '../src/units.ts';
import { parseWorkoutPlan } from '../src/workout-plan.ts';

export interface StandaloneVault {
  root: string;
  read(revisions?: RecordRevisions): ReturnType<typeof readImportVault>;
}

export async function readStandalonePlan(store: StandaloneVault, folder: string, path: string) {
  if (!/\.md$/i.test(path)) throw new Error('Choose a Markdown workout plan.');
  const file = await existingVaultFile(store.root, path);
  if ((await lstat(file)).size > maxPlanBytes) throw new Error('The plan is too large to open.');
  const [markdown, exercises] = await Promise.all([readFile(file, 'utf8'), readImportExercises(store.root, folder)]);
  const result = parseWorkoutPlan(markdown, exercises);
  if (result.plan) return result;
  return parseWorkoutPlan(markdown, progressExercises((await store.read()).data));
}

async function listDatedPlanPaths(root: string, folder: string): Promise<string[]> {
  const plans = `${folder}/Plans`;
  const plansDirectory = join(root, plans);
  if (!isInside(root, plansDirectory)) return [];
  for (let directory = plansDirectory; directory !== root; directory = dirname(directory)) {
    if (!(await lstat(directory).catch(() => undefined))?.isDirectory()) return [];
  }
  const paths: string[] = [];
  for (const year of await readdir(plansDirectory, { withFileTypes: true }).catch(() => [])) {
    if (!year.isDirectory() || !isPlanYear(year.name)) continue;
    const path = `${plans}/${year.name}`;
    const entries = await readdir(join(root, path), { withFileTypes: true }).catch(() => []);
    for (const entry of entries) if (entry.isFile()) paths.push(`${path}/${entry.name}`);
  }
  return paths;
}

export async function listStandaloneDatedPlans(root: string, folder: string, data: LedgerData, repository: DatedPlanRepository): Promise<DatedPlanNote[]> {
  const paths = await listDatedPlanPaths(root, folder);
  return repository.read(paths, progressExercises(data), async (path) => {
    const file = await existingVaultFile(root, path);
    if ((await lstat(file)).size <= maxPlanBytes) return readFile(file, 'utf8');
  });
}

export async function listStandalonePlans(root: string, journalFolder: string, repository: PlanPickerRepository): Promise<PlanNote[]> {
  const exercises = await readImportExercises(root, journalFolder);
  const paths: string[] = [];
  const folders = [''];
  while (folders.length) {
    const folder = folders.pop() ?? '';
    const entries = await readdir(join(root, folder), { withFileTypes: true }).catch((error: unknown) => {
      if (!folder) throw error;
      return [];
    });
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const path = folder ? `${folder}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (isWorkoutPlanPath(`${path}/`, journalFolder)) folders.push(path);
      } else if (entry.isFile() && /\.md$/i.test(entry.name)) {
        paths.push(path);
      }
    }
  }
  return repository.read(paths, exercises, async (path) => {
    const file = join(root, path);
    const stat = await lstat(file, { bigint: true });
    if (!stat.isFile() || stat.size > maxPlanBytes) return;
    return { revision: diskFileRevision(stat), read: () => readFile(file, 'utf8') };
  });
}

async function applyToWorkout(root: string, saved: WorkoutFile, change: WorkoutChange): Promise<WorkoutFile> {
  const file = await existingVaultFile(root, saved.path);
  const original = await readFile(file);
  const workout = parseWorkout(original.toString('utf8'));
  if (workout.id !== saved.workout.id || workout.date !== saved.workout.date || workout.createdAt !== saved.workout.createdAt) {
    throw new Error('The session changed. Refresh and try again.');
  }
  const updated = changeWorkout(workout, change);
  await replaceVaultFile(file, original, `${JSON.stringify(updated, null, 2)}\n`);
  return { path: saved.path, workout: updated };
}

async function withVault<T>(
  store: StandaloneVault, apply: (vault: Awaited<ReturnType<typeof readImportVault>>) => Promise<T>, revisions?: RecordRevisions,
): Promise<T> {
  const lock = await lockImportVault(store.root);
  if ('issue' in lock) throw new Error(lock.issue.message);
  try {
    return await apply(await store.read(revisions));
  } finally {
    await lock.release();
  }
}

export function refreshStandaloneCsv(store: StandaloneVault): Promise<void> {
  return withVault(store, writeAutomaticCsv);
}

export function saveStandaloneExport(store: StandaloneVault, format: ExportFormat): Promise<string> {
  return withVault(store, async ({ root, data, folder }) => {
    const text = serializeExport(data, format);
    await ensureDirectory(root, folder, 'Exports');
    while (true) {
      const path = `${folder}/Exports/${exportSnapshotFilename(format)}`;
      try {
        await writeNewFile(join(root, path), text);
        return path;
      } catch (error: unknown) {
        if (!hasErrorCode(error, 'EEXIST')) throw error;
      }
    }
  });
}

type ReportAutomaticCsvError = (message?: string) => void;

async function reuseWorkoutSnapshot(
  vault: Awaited<ReturnType<typeof readImportVault>>, revisions: RecordRevisions, saved: WorkoutFile,
): Promise<LedgerData | undefined> {
  const data = ledgerWithCommittedWorkout(vault.data, saved);
  if (!data) return;
  try {
    if (!await unchangedImportVaultRecords(vault.root, vault.folder, revisions, saved.path)) return;
    const file = await existingVaultFile(vault.root, saved.path);
    if (await readFile(file, 'utf8') === `${JSON.stringify(saved.workout, null, 2)}\n`) return data;
  } catch {
    // Use a fresh read to report vault issues when the committed snapshot cannot be verified.
  }
}

function withVaultEdit<T extends WorkoutFile | ExerciseNote>(
  store: StandaloneVault, reportAutomaticCsv: ReportAutomaticCsvError,
  apply: (vault: Awaited<ReturnType<typeof readImportVault>>) => Promise<T>, trackWorkout = false,
): Promise<T> {
  const revisions: RecordRevisions | undefined = trackWorkout ? new Map() : undefined;
  return withVault(store, async (vault) => {
    const saved = await apply(vault);
    try {
      const data = revisions && 'workout' in saved ? await reuseWorkoutSnapshot(vault, revisions, saved) : undefined;
      await writeAutomaticCsv(data ? { ...vault, data } : await store.read());
      reportAutomaticCsv();
    } catch (error: unknown) {
      reportAutomaticCsv(errorMessage(error));
    }
    return saved;
  }, revisions);
}

async function writeWorkoutChange(
  vault: Awaited<ReturnType<typeof readImportVault>>, date: string, change: WorkoutChange, original?: WorkoutFile, newWorkoutId?: string,
): Promise<WorkoutFile> {
  if (original) return applyToWorkout(vault.root, original, change);
  const workout = changeWorkout(createWorkout(date), change);
  if (newWorkoutId) workout.id = newWorkoutId;
  const result = await writeImportVault(vault, { exercises: [], workouts: [workout], skippedWorkoutIds: [], issues: [] });
  const path = result.written.workouts[0]?.path;
  if (!path) throw new Error(result.issues[0]?.message ?? 'Could not create a workout.');
  return { path, workout };
}

export function saveStandaloneSet(
  store: StandaloneVault, input: unknown, unit: WeightUnit, reportAutomaticCsv: ReportAutomaticCsvError, system?: MeasurementSystem,
): Promise<WorkoutSaveResult> {
  const now = new Date();
  const request = readLogSetInput(input, localDate(now));
  return withVaultEdit(store, reportAutomaticCsv, async (vault) => {
    const prepared = prepareLogSet(vault.data, request, unit, system, now);
    if ('replay' in prepared) return workoutSaveResult(vault.data, prepared.replay);
    const saved = await writeWorkoutChange(vault, request.date, { kind: 'add', set: prepared.set }, prepared.original);
    return workoutSaveResult(vault.data, saved, prepared.set.id);
  }, true);
}

export function editStandaloneWorkout(store: StandaloneVault, input: unknown, today: string, reportAutomaticCsv: ReportAutomaticCsvError, system?: MeasurementSystem): Promise<WorkoutSaveResult> {
  return withVaultEdit(store, reportAutomaticCsv, async (vault) => {
    const prepared = prepareWorkoutEdit(vault.data, input, today, system);
    if ('replay' in prepared) return workoutSaveResult(vault.data, prepared.replay);
    const saved = await writeWorkoutChange(vault, prepared.date, prepared.change, prepared.original, prepared.newWorkoutId);
    return workoutSaveResult(vault.data, saved);
  }, true);
}

async function writeNewExercise(vault: Awaited<ReturnType<typeof readImportVault>>, exercise: Exercise): Promise<ExerciseNote> {
  const result = await writeImportVault(vault, { exercises: [exercise], workouts: [], skippedWorkoutIds: [], issues: [] });
  const path = result.written.exercises[0]?.path;
  if (!path) throw new Error(result.issues[0]?.message ?? 'Could not create an exercise.');
  return { ...exercise, path };
}

export function addStandaloneStarter(store: StandaloneVault, id: unknown, reportAutomaticCsv: ReportAutomaticCsvError): Promise<ExerciseNote> {
  return withVaultEdit(store, reportAutomaticCsv, (vault) => {
    const prepared = prepareStarter(vault.data, id);
    return prepared.existing ? Promise.resolve(prepared.existing) : writeNewExercise(vault, prepared.starter);
  });
}

export function editStandaloneExercise(store: StandaloneVault, input: unknown, unit: WeightUnit, reportAutomaticCsv: ReportAutomaticCsvError): Promise<ExerciseNote> {
  return withVaultEdit(store, reportAutomaticCsv, async (vault) => {
    const prepared = prepareExerciseEdit(vault.data, input, unit);
    if ('replay' in prepared) return prepared.replay;
    const { original, exercise } = prepared;
    if (!original) return writeNewExercise(vault, exercise);
    const { path, ...before } = original;
    const file = await existingVaultFile(vault.root, path);
    const originalBytes = await readFile(file);
    const text = originalBytes.toString('utf8');
    const head = exerciseNoteHeader(text);
    if (!head) throw new Error('The exercise changed. Refresh and try again.');
    const yaml = parseDocument(head[1]);
    if (yaml.errors.length || JSON.stringify(readCatalogExercise(yaml.toJS() as unknown)) !== JSON.stringify(before)) {
      throw new Error('The exercise changed. Refresh and try again.');
    }
    const properties = exerciseFrontmatter(exercise);
    for (const [key, value] of Object.entries(properties)) yaml.set(key, value);
    for (const key of exerciseUnitFields) if (!(key in properties)) yaml.delete(key);
    const openingEnd = head[0].indexOf('\n') + 1;
    const closingStart = head[0].lastIndexOf('\n') + 1;
    const frontmatter = head[0].includes('\r\n') ? yaml.toString().replace(/\n/g, '\r\n') : yaml.toString();
    await replaceVaultFile(file, originalBytes, text.slice(0, openingEnd) + frontmatter + text.slice(closingStart));
    return { ...exercise, path };
  });
}
