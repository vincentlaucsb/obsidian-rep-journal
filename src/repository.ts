import { getFrontMatterInfo, parseYaml, stringifyYaml, TFile, TFolder, type DataAdapter, type Vault } from 'obsidian';
import {
  changeWorkout, compareWorkouts, createWorkout, errorMessage, exerciseFrontmatter, isRecord, makeId,
  parseWorkout, readExercise, type Exercise, type ExerciseDetails, type ExerciseNote, type LedgerData,
  type WorkoutChange, type WorkoutFile,
} from './model.ts';

const JOURNAL_FOLDER = 'Rep Journal';
const LEGACY_FOLDER = 'Set Ledger';
const DATA_FOLDERS = [JOURNAL_FOLDER, LEGACY_FOLDER];

type Section = 'Exercises' | 'Workouts' | 'Exports';

type LedgerVault = Pick<Vault, 'cachedRead' | 'create' | 'createFolder' | 'getAbstractFileByPath' |
  'getFileByPath' | 'getFolderByPath' | 'process'> & {
  adapter: Pick<DataAdapter, 'exists' | 'list' | 'process' | 'read'>;
};

function isRecordPath(path: string, section: Section): boolean {
  return DATA_FOLDERS.some((folder) => path.startsWith(`${folder}/${section}/`));
}

function noteProperties(text: string): unknown {
  const info = getFrontMatterInfo(text);
  return info.exists ? parseYaml(info.frontmatter) : null;
}

function exerciseFilename(exercise: Exercise): string {
  const slug = exercise.name.replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '').slice(0, 45) || 'exercise';
  return `${slug}-${exercise.id}.md`;
}

function uniqueRecords<T extends { path: string }>(records: T[], idFor: (record: T) => string, issues: string[]): T[] {
  const groups = new Map<string, T[]>();
  for (const record of records) {
    const id = idFor(record);
    const group = groups.get(id) ?? [];
    group.push(record);
    groups.set(id, group);
  }
  const result: T[] = [];
  for (const group of groups.values()) {
    if (group.length === 1) {
      result.push(group[0]);
    } else {
      issues.push(`Duplicate record ID in ${group.map((record) => record.path).join(', ')}`);
    }
  }
  return result;
}

async function readRecords<T>(paths: string[], read: (path: string) => Promise<T | null>, issues: string[]): Promise<T[]> {
  const records: T[] = [];
  for (let start = 0; start < paths.length; start += 24) {
    const batch = paths.slice(start, start + 24);
    const results = await Promise.allSettled(batch.map(read));
    for (const [index, result] of results.entries()) {
      if (result.status === 'rejected') {
        issues.push(`${batch[index]}: ${errorMessage(result.reason)}`);
      } else if (result.value !== null) {
        records.push(result.value);
      }
    }
  }
  return records;
}

export class LedgerRepository {
  private readonly vault: LedgerVault;

  constructor(vault: LedgerVault) {
    this.vault = vault;
  }

  async read(): Promise<LedgerData> {
    const issues: string[] = [];
    const exercisePaths = DATA_FOLDERS.flatMap((folder) => this.exercisePaths(`${folder}/Exercises`));
    const workoutPaths = (await Promise.all(DATA_FOLDERS.map((folder) => this.workoutPaths(`${folder}/Workouts`)))).flat();
    const [exercises, workouts] = await Promise.all([
      readRecords(exercisePaths, async (path) => {
        const file = this.vault.getFileByPath(path);
        if (!file) throw new Error('Exercise note moved while loading.');
        const exercise = readExercise(noteProperties(await this.vault.cachedRead(file)));
        return exercise ? { ...exercise, path } : null;
      }, issues),
      readRecords(workoutPaths, async (path) => ({ path, workout: parseWorkout(await this.readWorkoutText(path)) }), issues),
    ]);
    return {
      exercises: uniqueRecords(exercises, (exercise) => exercise.id, issues).sort((a, b) => a.name.localeCompare(b.name)),
      workouts: uniqueRecords(workouts, ({ workout }) => workout.id, issues).sort((a, b) => compareWorkouts(a.workout, b.workout)),
      issues: issues.sort(),
    };
  }

  async saveExercise(details: ExerciseDetails, original?: ExerciseNote): Promise<ExerciseNote> {
    const exercise = { ...details, id: original?.id ?? makeId() };
    const properties = exerciseFrontmatter(exercise);
    readExercise(properties);
    if (!original) {
      const folder = await this.ensureFolder('Exercises');
      const path = `${folder}/${exerciseFilename(exercise)}`;
      await this.vault.create(path, `---\n${stringifyYaml(properties).trimEnd()}\n---\n`);
      return { ...exercise, path };
    }

    const file = this.vault.getFileByPath(original.path);
    if (!file || !isRecordPath(file.path, 'Exercises')) throw new Error('The exercise note moved. Refresh and try again.');
    await this.vault.process(file, (text) => {
      const info = getFrontMatterInfo(text);
      const current: unknown = parseYaml(info.frontmatter);
      if (!info.exists || !isRecord(current) || JSON.stringify(readExercise(current)) !== JSON.stringify(this.withoutPath(original))) {
        throw new Error('The exercise changed. Refresh and try again.');
      }
      const yaml = stringifyYaml({ ...current, ...properties }).trimEnd();
      return `${text.slice(0, info.from)}${yaml}\n${text.slice(info.to)}`;
    });
    return { ...exercise, path: file.path };
  }

  async saveWorkout(date: string, change: WorkoutChange, original?: WorkoutFile): Promise<WorkoutFile> {
    if (!original) {
      const workout = changeWorkout(createWorkout(date), change);
      const folder = await this.ensureFolder('Workouts');
      const path = `${folder}/${workout.date}-${workout.id}.json`;
      await this.vault.create(path, this.workoutText(workout));
      return { workout, path };
    }

    if (!isRecordPath(original.path, 'Workouts')) throw new Error('The workout is outside the workout folder.');
    const update = (text: string): string => {
      const current = parseWorkout(text);
      if (current.id !== original.workout.id || current.date !== date || current.createdAt !== original.workout.createdAt) {
        throw new Error('The workout changed. Refresh and try again.');
      }
      return this.workoutText(changeWorkout(current, change));
    };
    const file = this.vault.getFileByPath(original.path);
    const text = file
      ? await this.vault.process(file, update)
      : await this.vault.adapter.process(original.path, update);
    return { workout: parseWorkout(text), path: original.path };
  }

  async writeExport(extension: 'csv' | 'json', text: string): Promise<string> {
    const folder = await this.ensureFolder('Exports');
    const date = new Date().toISOString().slice(0, 10);
    const path = `${folder}/rep-journal-${date}-${makeId().slice(0, 8)}.${extension}`;
    return (await this.vault.create(path, text)).path;
  }

  private withoutPath({ id, name, aliases, equipment, loadMode, unit, archived }: ExerciseNote): Exercise {
    return { id, name, aliases, equipment, loadMode, unit, archived };
  }

  private exercisePaths(path: string): string[] {
    const folder = this.vault.getAbstractFileByPath(path);
    if (!folder) return [];
    if (!(folder instanceof TFolder)) throw new Error(`Expected a folder at ${path}.`);
    const paths: string[] = [];
    const pending = [folder];
    while (pending.length) {
      const next = pending.pop();
      for (const item of next?.children ?? []) {
        if (item instanceof TFolder) pending.push(item);
        if (item instanceof TFile && item.extension === 'md') paths.push(item.path);
      }
    }
    return paths.sort();
  }

  private async workoutPaths(path: string): Promise<string[]> {
    // JSON can be hidden by Obsidian's file-type visibility setting. Enumerate only our workout directory.
    if (!await this.vault.adapter.exists(path)) return [];
    const { files } = await this.vault.adapter.list(path);
    return files.filter((path) => path.endsWith('.json')).sort();
  }

  private readWorkoutText(path: string): Promise<string> {
    const file = this.vault.getFileByPath(path);
    return file ? this.vault.cachedRead(file) : this.vault.adapter.read(path);
  }

  private workoutText(workout: WorkoutFile['workout']): string {
    return `${JSON.stringify(workout, null, 2)}\n`;
  }

  private async ensureFolder(section: Section): Promise<string> {
    const root = this.vault.getFolderByPath(JOURNAL_FOLDER) || !this.vault.getFolderByPath(LEGACY_FOLDER)
      ? JOURNAL_FOLDER : LEGACY_FOLDER;
    const path = `${root}/${section}`;
    for (const directory of [root, path]) {
      if (this.vault.getFolderByPath(directory)) continue;
      try {
        await this.vault.createFolder(directory);
      } catch (error: unknown) {
        if (!this.vault.getFolderByPath(directory)) throw error;
      }
    }
    return path;
  }
}
