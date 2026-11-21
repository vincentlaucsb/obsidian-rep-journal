import { randomUUID } from 'node:crypto';
import { lstat, readFile, readdir, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parseDocument } from 'yaml';
import { progressExercises } from './analytics.ts';
import { readCatalogExercise } from './catalog.ts';
import { automaticCsvFilename, exportSnapshotFilename, serializeExport, toCsv, type ExportFormat } from './exports.ts';
import { ensureDirectory, exerciseNoteHeader, hasErrorCode, lockImportVault, readImportVault, writeImportVault, writeNewFile } from './import-vault.ts';
import { journalFolders } from './journal-paths.ts';
import { maxPlanBytes, planNoteFrom, prepareExerciseEdit, prepareLogSet, prepareStarter, prepareWorkoutEdit, readLogSetInput, type PlanNote } from './journal-workflow.ts';
import {
  changeWorkout, createWorkout, errorMessage, exerciseFrontmatter, parseWorkout, type Exercise, type ExerciseNote, type LedgerData,
  type WeightUnit, type WorkoutChange, type WorkoutFile,
} from './model.ts';
import { parseWorkoutPlan } from './workout-plan.ts';

function isInside(root: string, path: string): boolean {
  const remainder = relative(root, path);
  return remainder !== '' && remainder !== '..' && !remainder.startsWith('..' + sep) && !isAbsolute(remainder);
}

async function existingVaultFile(root: string, path: string): Promise<string> {
  if (!path || path.includes('\\') || path.startsWith('/') || path.split('/').some((part) => !part || part === '.' || part === '..' || part.startsWith('.'))) {
    throw new Error('Choose a file inside the vault.');
  }
  const candidate = resolve(root, path);
  if (!isInside(root, candidate) || !(await lstat(candidate)).isFile()) throw new Error('Choose a file inside the vault.');
  const actual = await realpath(candidate);
  if (!isInside(root, actual)) throw new Error('Choose a file inside the vault.');
  return actual;
}

export async function readStandalonePlan(root: string, path: string, data: LedgerData) {
  if (!/\.md$/i.test(path)) throw new Error('Choose a Markdown workout plan.');
  const file = await existingVaultFile(root, path);
  if ((await lstat(file)).size > maxPlanBytes) throw new Error('The plan is too large to open.');
  return parseWorkoutPlan(await readFile(file, 'utf8'), progressExercises(data));
}

export async function listStandalonePlans(root: string, data: LedgerData): Promise<PlanNote[]> {
  const exercises = progressExercises(data);
  const plans: PlanNote[] = [];
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
        if (!journalFolders.some((journal) => ['Exercises', 'Exports', 'Workouts'].some((name) => path === `${journal}/${name}`))) folders.push(path);
      } else if (entry.isFile() && /\.md$/i.test(entry.name)) {
        const file = join(root, path);
        const stat = await lstat(file).catch(() => undefined);
        if (!stat?.isFile() || stat.size > maxPlanBytes) continue;
        const markdown = await readFile(file, 'utf8').catch(() => '');
        const note = planNoteFrom(path, markdown, exercises);
        if (note) plans.push(note);
      }
    }
  }
  return plans.sort((a, b) => a.title.localeCompare(b.title) || a.path.localeCompare(b.path));
}

async function replaceVaultFile(file: string, original: string, updated: string): Promise<void> {
  const temporary = join(dirname(file), `.rep-journal-edit-${randomUUID()}.tmp`);
  await writeFile(temporary, updated, { flag: 'wx' });
  try {
    if (await readFile(file, 'utf8') !== original) throw new Error('The file changed. Refresh and try again.');
    await rename(temporary, file);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

async function applyToWorkout(root: string, saved: WorkoutFile, change: WorkoutChange): Promise<WorkoutFile> {
  const file = await existingVaultFile(root, saved.path);
  const original = await readFile(file, 'utf8');
  const workout = parseWorkout(original);
  if (workout.id !== saved.workout.id || workout.date !== saved.workout.date || workout.createdAt !== saved.workout.createdAt) {
    throw new Error('The session changed. Refresh and try again.');
  }
  const updated = changeWorkout(workout, change);
  await replaceVaultFile(file, original, `${JSON.stringify(updated, null, 2)}\n`);
  return { path: saved.path, workout: updated };
}

async function withVault<T>(root: string, apply: (vault: Awaited<ReturnType<typeof readImportVault>>) => Promise<T>): Promise<T> {
  const lock = await lockImportVault(root);
  if ('issue' in lock) throw new Error(lock.issue.message);
  try {
    return await apply(await readImportVault(root));
  } finally {
    await lock.release();
  }
}

async function writeAutomaticCsv(vault: Awaited<ReturnType<typeof readImportVault>>): Promise<void> {
  const { root, folder, data } = vault;
  const text = toCsv(data);
  await ensureDirectory(root, folder, 'Exports');
  const path = `${folder}/Exports/${automaticCsvFilename}`;
  const file = await existingVaultFile(root, path).catch((error: unknown) => {
    if (hasErrorCode(error, 'ENOENT')) return undefined;
    throw error;
  });
  if (!file) {
    await writeNewFile(join(root, path), text);
    return;
  }
  const previous = await readFile(file, 'utf8');
  if (text !== previous) await replaceVaultFile(file, previous, text);
}

export function refreshStandaloneCsv(root: string): Promise<void> {
  return withVault(root, writeAutomaticCsv);
}

export function saveStandaloneExport(root: string, format: ExportFormat): Promise<string> {
  return withVault(root, async ({ data, folder }) => {
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

function withVaultEdit<T>(
  root: string, reportAutomaticCsv: ReportAutomaticCsvError,
  apply: (vault: Awaited<ReturnType<typeof readImportVault>>) => Promise<T>,
): Promise<T> {
  return withVault(root, async (vault) => {
    const saved = await apply(vault);
    try {
      await writeAutomaticCsv(await readImportVault(root));
      reportAutomaticCsv();
    } catch (error: unknown) {
      reportAutomaticCsv(errorMessage(error));
    }
    return saved;
  });
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
  root: string, input: unknown, today: string, unit: WeightUnit, reportAutomaticCsv: ReportAutomaticCsvError,
): Promise<WorkoutFile> {
  const request = readLogSetInput(input, today);
  return withVaultEdit(root, reportAutomaticCsv, (vault) => {
    const prepared = prepareLogSet(vault.data, request, unit);
    if ('replay' in prepared) return Promise.resolve(prepared.replay);
    return writeWorkoutChange(vault, request.date, { kind: 'add', set: prepared.set }, prepared.original);
  });
}

export function editStandaloneWorkout(root: string, input: unknown, today: string, reportAutomaticCsv: ReportAutomaticCsvError): Promise<WorkoutFile> {
  return withVaultEdit(root, reportAutomaticCsv, (vault) => {
    const prepared = prepareWorkoutEdit(vault.data, input, today);
    if ('replay' in prepared) return Promise.resolve(prepared.replay);
    return writeWorkoutChange(vault, prepared.date, prepared.change, prepared.original, prepared.newWorkoutId);
  });
}

async function writeNewExercise(vault: Awaited<ReturnType<typeof readImportVault>>, exercise: Exercise): Promise<ExerciseNote> {
  const result = await writeImportVault(vault, { exercises: [exercise], workouts: [], skippedWorkoutIds: [], issues: [] });
  const path = result.written.exercises[0]?.path;
  if (!path) throw new Error(result.issues[0]?.message ?? 'Could not create an exercise.');
  return { ...exercise, path };
}

export function addStandaloneStarter(root: string, id: unknown, reportAutomaticCsv: ReportAutomaticCsvError): Promise<ExerciseNote> {
  return withVaultEdit(root, reportAutomaticCsv, (vault) => {
    const prepared = prepareStarter(vault.data, id);
    return prepared.existing ? Promise.resolve(prepared.existing) : writeNewExercise(vault, prepared.starter);
  });
}

export function editStandaloneExercise(root: string, input: unknown, unit: WeightUnit, reportAutomaticCsv: ReportAutomaticCsvError): Promise<ExerciseNote> {
  return withVaultEdit(root, reportAutomaticCsv, async (vault) => {
    const prepared = prepareExerciseEdit(vault.data, input, unit);
    if ('replay' in prepared) return prepared.replay;
    const { original, exercise } = prepared;
    if (!original) return writeNewExercise(vault, exercise);
    const { path, ...before } = original;
    const file = await existingVaultFile(vault.root, path);
    const text = await readFile(file, 'utf8');
    const head = exerciseNoteHeader(text);
    if (!head) throw new Error('The exercise changed. Refresh and try again.');
    const yaml = parseDocument(head[1]);
    if (yaml.errors.length || JSON.stringify(readCatalogExercise(yaml.toJS() as unknown)) !== JSON.stringify(before)) {
      throw new Error('The exercise changed. Refresh and try again.');
    }
    for (const [key, value] of Object.entries(exerciseFrontmatter(exercise))) yaml.set(key, value);
    const openingEnd = head[0].indexOf('\n') + 1;
    const closingStart = head[0].lastIndexOf('\n') + 1;
    const frontmatter = head[0].includes('\r\n') ? yaml.toString().replace(/\n/g, '\r\n') : yaml.toString();
    await replaceVaultFile(file, text, text.slice(0, openingEnd) + frontmatter + text.slice(closingStart));
    return { ...exercise, path };
  });
}
