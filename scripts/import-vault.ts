import { constants } from 'node:fs';
import { copyFile, link, lstat, mkdir, open, readFile, readdir, realpath, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { isDeepStrictEqual } from 'node:util';
import { parse, stringify } from 'yaml';
import { readCatalogExercise } from '../src/catalog.ts';
import { appendExerciseGuides } from '../src/exercise-guides.ts';
import { exerciseFilename, journalFolder, journalSettingsFile, nextWorkoutSession, normalizeJournalFolder, parseJournalFolder, workoutFilename } from '../src/journal-paths.ts';
import {
  compareWorkouts, errorMessage, exerciseFrontmatter, isRecord, parseWorkout, readExercise,
  type Exercise, type ExerciseNote, type LedgerData, type Workout, type WorkoutFile,
} from '../src/model.ts';
import { type ImportIssue, type WorkoutImportPlan } from '../src/workout-import.ts';

interface ImportVault {
  root: string;
  folder: string;
  data: LedgerData;
  issues: ImportIssue[];
}

interface WrittenRecords {
  exercises: Array<{ exerciseId: string; path: string }>;
  workouts: Array<{ workoutId: string; path: string }>;
}

export function hasErrorCode(error: unknown, ...codes: string[]): boolean {
  return isRecord(error) && typeof error.code === 'string' && codes.includes(error.code);
}

async function directoryExists(path: string): Promise<boolean> {
  try {
    if (!(await lstat(path)).isDirectory()) throw new Error('Expected a directory.');
    return true;
  } catch (error: unknown) {
    if (hasErrorCode(error, 'ENOENT')) return false;
    throw error;
  }
}

export async function readJournalFolder(root: string): Promise<string> {
  const settings = join(root, journalSettingsFile);
  try {
    if (!(await lstat(settings)).isFile()) throw new Error(`Expected a file at ${journalSettingsFile}.`);
    return parseJournalFolder(await readFile(settings, 'utf8'));
  } catch (error: unknown) {
    if (hasErrorCode(error, 'ENOENT')) return journalFolder;
    throw error;
  }
}

function directoryPrefixes(path: string): string[] {
  const parts = path.split('/');
  return parts.map((_, index) => parts.slice(0, index + 1).join('/'));
}

export function exerciseNoteHeader(text: string): RegExpExecArray | null {
  const header = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)^---[ \t]*\r?$/m.exec(text);
  if (header?.index === 0) return header;
  if (/^\uFEFF?---[ \t]*\r?\n/.test(text) && /^set_ledger_id:/m.test(text)) {
    throw new Error('Exercise frontmatter needs a closing --- line.');
  }
  return null;
}

function readNote(text: string): Exercise | null {
  const header = exerciseNoteHeader(text);
  return header ? readCatalogExercise(parse(header[1])) : null;
}

async function listRecords(root: string, section: string, kind: 'exercises' | 'workouts'): Promise<string[]> {
  for (const directory of directoryPrefixes(section)) {
    if (!await directoryExists(join(root, directory))) return [];
  }
  const paths: string[] = [];
  const pending = [section];
  const extension = kind === 'exercises' ? '.md' : '.json';
  while (pending.length) {
    const folder = pending.pop();
    if (!folder) break;
    const entries = await readdir(join(root, folder), { withFileTypes: true });
    for (const entry of entries) {
      const path = `${folder}/${entry.name}`;
      if (entry.isDirectory() && (kind === 'exercises' || (folder === section && /^\d{4}$/.test(entry.name)))) pending.push(path);
      else if (entry.isFile() && entry.name.endsWith(extension)) paths.push(path);
    }
  }
  return paths.sort();
}

async function readRecords<T extends { path: string }>(
  paths: string[],
  read: (path: string) => Promise<T | null>,
  kind: string,
  idFor: (entry: T) => string,
  issues: ImportIssue[],
): Promise<T[]> {
  const records: T[] = [];
  const seen = new Map<string, string>();
  for (let start = 0; start < paths.length; start += 24) {
    const batch = paths.slice(start, start + 24);
    const results = await Promise.allSettled(batch.map(read));
    for (const [index, result] of results.entries()) {
      if (result.status === 'rejected') {
        issues.push({
          code: 'VAULT_RECORD_UNREADABLE', path: batch[index],
          message: `Could not read the ${kind}. ${errorMessage(result.reason)} Repair the file and retry.`,
        });
        continue;
      }
      if (!result.value) continue;
      const id = idFor(result.value);
      const duplicate = seen.get(id);
      if (duplicate) {
        issues.push({
          code: 'VAULT_DUPLICATE_ID', path: result.value.path,
          message: `The ${kind} ID ${id} also appears at ${duplicate}. Resolve the duplicate and retry.`,
        });
      } else {
        seen.set(id, result.value.path);
        records.push(result.value);
      }
    }
  }
  return records;
}

export async function resolveImportVaultRoot(vaultPath: string): Promise<string> {
  const root = await realpath(vaultPath);
  if (!await directoryExists(root)) throw new Error('Expected an existing Obsidian vault directory.');
  return root;
}

const lockName = '.rep-journal-import.lock';

export async function lockImportVault(root: string): Promise<
  { release: () => Promise<void> } | { issue: ImportIssue }
> {
  const path = join(root, lockName);
  let lock: Awaited<ReturnType<typeof open>>;
  try {
    lock = await open(path, 'wx');
  } catch (error: unknown) {
    if (!hasErrorCode(error, 'EEXIST')) throw error;
    return {
      issue: {
        code: 'VAULT_IMPORT_LOCKED', path: lockName,
        message: `Another import may be running. Wait for it and retry. If no importer is running for this vault, remove the abandoned ${lockName} file and retry.`,
      },
    };
  }
  try {
    try {
      await lock.writeFile(JSON.stringify({ host: hostname(), pid: process.pid, startedAt: new Date().toISOString() }), 'utf8');
    } finally {
      await lock.close();
    }
  } catch (error: unknown) {
    await unlink(path).catch(() => undefined);
    throw error;
  }
  return { release: () => unlink(path) };
}

export async function readImportVault(root: string, configuredFolder?: string): Promise<ImportVault> {
  const folder = configuredFolder === undefined ? await readJournalFolder(root) : normalizeJournalFolder(configuredFolder);
  const issues: ImportIssue[] = [];
  const exercisePaths: string[] = [];
  const workoutPaths: string[] = [];
  const sections = [
    { name: 'Exercises', kind: 'exercises', paths: exercisePaths },
    { name: 'Workouts', kind: 'workouts', paths: workoutPaths },
  ] as const;
  for (const section of sections) {
    const path = `${folder}/${section.name}`;
    try {
      section.paths.push(...await listRecords(root, path, section.kind));
    } catch (error: unknown) {
      issues.push({ code: 'VAULT_DIRECTORY_UNREADABLE', path, message: errorMessage(error) });
    }
  }

  const [exercises, workouts] = await Promise.all([
    readRecords<ExerciseNote>(exercisePaths, async (path) => {
      const exercise = readNote(await readFile(join(root, path), 'utf8'));
      return exercise ? { ...exercise, path } : null;
    }, 'exercise note', (exercise) => exercise.id, issues),
    readRecords<WorkoutFile>(workoutPaths, async (path) => ({
      path, workout: parseWorkout(await readFile(join(root, path), 'utf8')),
    }), 'workout', ({ workout }) => workout.id, issues),
  ]);
  issues.sort((a, b) => a.path.localeCompare(b.path));
  return {
    root, folder,
    data: {
      exercises: exercises.sort((a, b) => a.name.localeCompare(b.name)),
      workouts: workouts.sort((a, b) => compareWorkouts(a.workout, b.workout)),
      issues: issues.map((issue) => `${issue.path}: ${issue.message}`),
    },
    issues,
  };
}

export async function writeNewFile(path: string, text: string): Promise<void> {
  const temporary = join(dirname(path), `.rep-journal-import-${randomUUID()}.tmp`);
  const file = await open(temporary, 'wx');
  try {
    try {
      await file.writeFile(text, 'utf8');
    } finally {
      await file.close();
    }
    try {
      // Publish a complete file while keeping the existing destination on a race.
      await link(temporary, path);
    } catch (error: unknown) {
      if (!hasErrorCode(error, 'ENOSYS', 'ENOTSUP', 'EOPNOTSUPP', 'EPERM', 'EXDEV')) throw error;
      await copyFile(temporary, path, constants.COPYFILE_EXCL);
    }
  } finally {
    // A temporary file is never treated as a vault record.
    await unlink(temporary).catch(() => undefined);
  }
}

async function saveNewExercise(root: string, path: string, exercise: Exercise): Promise<'written' | 'same' | 'occupied'> {
  const properties = exerciseFrontmatter(exercise);
  const absolute = join(root, path);
  try {
    const markdown = appendExerciseGuides(`---\n${stringify(properties, { lineWidth: 0 })}---\n`, exercise);
    await writeNewFile(absolute, markdown);
    return 'written';
  } catch (error: unknown) {
    if (!hasErrorCode(error, 'EEXIST')) throw error;
    if (!(await lstat(absolute)).isFile()) throw new Error('Expected an exercise note file.');
    const existing = readNote(await readFile(absolute, 'utf8'));
    if (existing?.id !== exercise.id) return 'occupied';
    if (isDeepStrictEqual(existing, readExercise(properties))) return 'same';
    throw new Error('This exercise ID was saved with different content. Replan the import and resolve the conflict.');
  }
}

async function saveNewWorkout(root: string, path: string, workout: Workout): Promise<'written' | 'same' | 'occupied'> {
  const absolute = join(root, path);
  try {
    await writeNewFile(absolute, `${JSON.stringify(workout, null, 2)}\n`);
    return 'written';
  } catch (error: unknown) {
    if (!hasErrorCode(error, 'EEXIST')) throw error;
    if (!(await lstat(absolute)).isFile()) throw new Error('Expected a workout file.');
    const existing = parseWorkout(await readFile(absolute, 'utf8'));
    if (existing.id !== workout.id) return 'occupied';
    if (isDeepStrictEqual(existing, workout)) return 'same';
    throw new Error('This workout ID was saved with different content. Replan the import and resolve the conflict.');
  }
}

export async function ensureDirectory(root: string, folder: string, section: string): Promise<void> {
  for (const path of directoryPrefixes(`${folder}/${section}`)) {
    const absolute = join(root, path);
    if (await directoryExists(absolute)) continue;
    try {
      await mkdir(absolute);
    } catch (error: unknown) {
      if (!hasErrorCode(error, 'EEXIST') || !await directoryExists(absolute)) throw error;
    }
  }
}

export async function writeImportVault(vault: ImportVault, plan: WorkoutImportPlan): Promise<{
  written: WrittenRecords; skippedWorkoutIds: string[]; issues: ImportIssue[];
}> {
  const { folder, root } = vault;
  const written: WrittenRecords = { exercises: [], workouts: [] };
  const skippedWorkoutIds: string[] = [];
  const issues: ImportIssue[] = [];
  let path: string = folder;
  try {
    if (plan.exercises.length) {
      path = `${folder}/Exercises`;
      await ensureDirectory(root, folder, 'Exercises');
    }
    for (const exercise of plan.exercises) {
      for (let number = 1; ; number++) {
        path = `${folder}/Exercises/${exerciseFilename(exercise, number)}`;
        const result = await saveNewExercise(root, path, exercise);
        if (result === 'written') written.exercises.push({ exerciseId: exercise.id, path });
        if (result !== 'occupied') break;
      }
    }

    const pathsForDate = new Map<string, Set<string>>();
    for (const { path: existingPath } of vault.data.workouts) {
      const date = existingPath.slice(existingPath.lastIndexOf('/') + 1).slice(0, 10);
      const existingPaths = pathsForDate.get(date) ?? new Set<string>();
      existingPaths.add(existingPath);
      pathsForDate.set(date, existingPaths);
    }
    for (const workout of plan.workouts) {
      const section = `Workouts/${workout.date.slice(0, 4)}`;
      path = `${folder}/${section}`;
      await ensureDirectory(root, folder, section);
      const paths = pathsForDate.get(workout.date) ?? new Set<string>();
      pathsForDate.set(workout.date, paths);
      let session = nextWorkoutSession(workout.date, [...paths]);
      while (true) {
        path = `${folder}/${section}/${workoutFilename(workout.date, session)}`;
        const result = await saveNewWorkout(root, path, workout);
        paths.add(path);
        if (result === 'written') written.workouts.push({ workoutId: workout.id, path });
        if (result === 'same') skippedWorkoutIds.push(workout.id);
        if (result !== 'occupied') break;
        session++;
      }
    }
  } catch (error: unknown) {
    issues.push({
      code: 'VAULT_WRITE_FAILED', path,
      message: `${errorMessage(error)} The written list shows completed files. After resolving the problem, retry the same input.`,
    });
  }
  return { written, skippedWorkoutIds, issues };
}
