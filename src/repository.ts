import { getFrontMatterInfo, parseYaml, stringifyYaml, TFile, TFolder, type DataAdapter, type Vault } from 'obsidian';
import { readCatalogExercise } from './catalog.ts';
import { appendExerciseGuides } from './exercise-guides.ts';
import { toCsv } from './exports.ts';
import {
  exerciseFilename, hasLegacyExerciseFilename, journalFolder, journalFolders, legacyFolder, nextWorkoutSession, workoutFilename,
} from './journal-paths.ts';
import {
  changeWorkout, combineAliases, compareWorkouts, createWorkout, errorMessage, exerciseFrontmatter, isRecord, makeId, nameKey,
  parseWorkout, readExercise, type Exercise, type ExerciseDetails, type ExerciseNote, type LedgerData,
  type WorkoutChange, type WorkoutFile,
} from './model.ts';

type Section = 'Exercises' | 'Workouts' | 'Exports';

type LedgerVault = Pick<Vault, 'cachedRead' | 'create' | 'createFolder' | 'getAbstractFileByPath' |
  'getFileByPath' | 'getFolderByPath' | 'modify' | 'process'> & {
  adapter: Pick<DataAdapter, 'exists' | 'list' | 'process' | 'read' | 'write'>;
};

const workoutCreations = new WeakMap<LedgerVault, Promise<WorkoutFile>>();

function isRecordPath(path: string, section: Section): boolean {
  return journalFolders.some((folder) => path.startsWith(`${folder}/${section}/`));
}

function noteProperties(text: string): unknown {
  const info = getFrontMatterInfo(text);
  return info.exists ? parseYaml(info.frontmatter) : null;
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
  private automaticCsvUpdate?: Promise<void>;
  private automaticCsvRequested = false;

  constructor(vault: LedgerVault) {
    this.vault = vault;
  }

  async read(): Promise<LedgerData> {
    const issues: string[] = [];
    const workoutPaths = (await Promise.all(journalFolders.map((folder) => this.workoutPaths(`${folder}/Workouts`)))).flat();
    const [exercises, workouts] = await Promise.all([
      this.readExercises(issues),
      readRecords(workoutPaths, async (path) => ({ path, workout: parseWorkout(await this.readWorkoutText(path)) }), issues),
    ]);
    return {
      exercises,
      workouts: uniqueRecords(workouts, ({ workout }) => workout.id, issues).sort((a, b) => compareWorkouts(a.workout, b.workout)),
      issues: issues.sort(),
    };
  }

  async saveStarter(starter: Exercise): Promise<ExerciseNote> {
    const names = new Set([starter.name, ...starter.aliases].map(nameKey));
    const { exercises } = await this.read();
    const existing = exercises.find((exercise) =>
      exercise.id === starter.id || [exercise.name, ...exercise.aliases].some((name) => names.has(nameKey(name))));
    if (existing) return existing;
    try {
      return await this.saveExercise(starter, undefined, starter.id);
    } catch (error: unknown) {
      const { exercises: updated } = await this.read();
      const saved = updated.find((exercise) => exercise.id === starter.id);
      if (saved) return saved;
      throw error;
    }
  }

  async saveExercise(details: ExerciseDetails, original?: ExerciseNote, id = original?.id ?? makeId()): Promise<ExerciseNote> {
    const aliases = combineAliases(details.name, details.aliases, original?.name);
    const properties = exerciseFrontmatter({ ...details, id, aliases });
    const exercise = readExercise(properties);
    if (!exercise) throw new Error('Invalid exercise properties.');
    if (!original) {
      const markdown = appendExerciseGuides(`---\n${stringifyYaml(properties).trimEnd()}\n---\n`, exercise);
      return this.createExerciseNote(exercise, markdown);
    }

    const { path, ...before } = original;
    const file = this.vault.getFileByPath(path);
    if (!file || !isRecordPath(file.path, 'Exercises')) throw new Error('The exercise note moved. Refresh and try again.');
    await this.vault.process(file, (text) => {
      const info = getFrontMatterInfo(text);
      const current: unknown = parseYaml(info.frontmatter);
      if (!info.exists || !isRecord(current) || JSON.stringify(readCatalogExercise(current)) !== JSON.stringify(before)) {
        throw new Error('The exercise changed. Refresh and try again.');
      }
      const yaml = stringifyYaml({ ...current, ...properties }).trimEnd();
      return `${text.slice(0, info.from)}${yaml}\n${text.slice(info.to)}`;
    });
    return { ...exercise, path: file.path };
  }

  async tidyExerciseNotes(renameFile: (file: TFile, path: string) => Promise<void>): Promise<{
    renamed: number; guidesAdded: number; issues: string[];
  }> {
    const issues: string[] = [];
    const exercises = await this.readExercises(issues);
    let renamed = 0;
    let guidesAdded = 0;
    for (const exercise of exercises) {
      const file = this.vault.getFileByPath(exercise.path);
      if (!file) {
        issues.push(`${exercise.path}: Exercise note moved while loading.`);
        continue;
      }
      try {
        if (hasLegacyExerciseFilename(file.path, exercise)) {
          const folder = file.path.slice(0, file.path.lastIndexOf('/'));
          const existing = await this.exerciseEntries(folder);
          for (let number = 1; ; number++) {
            const path = `${folder}/${exerciseFilename(exercise, number)}`;
            if (existing.has(path.toLowerCase()) || await this.vault.adapter.exists(path)) continue;
            try {
              await renameFile(file, path);
              renamed++;
              break;
            } catch (error: unknown) {
              if (!await this.vault.adapter.exists(path)) throw error;
            }
          }
        }
        if (await this.addGuideLinks(file, exercise)) guidesAdded++;
      } catch (error: unknown) {
        issues.push(`${file.path}: ${errorMessage(error)}`);
      }
    }
    return { renamed, guidesAdded, issues };
  }

  async saveWorkout(date: string, change: WorkoutChange, original?: WorkoutFile): Promise<WorkoutFile> {
    if (!original) {
      const workout = changeWorkout(createWorkout(date), change);
      const pending = workoutCreations.get(this.vault) ?? Promise.resolve();
      const creation = pending.catch(() => undefined).then(() => this.createWorkoutFile(workout));
      workoutCreations.set(this.vault, creation);
      try {
        return await creation;
      } finally {
        if (workoutCreations.get(this.vault) === creation) {
          workoutCreations.delete(this.vault);
        }
      }
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

  refreshAutomaticCsv(): Promise<void> {
    this.automaticCsvRequested = true;
    this.automaticCsvUpdate ??= this.updateAutomaticCsv();
    return this.automaticCsvUpdate;
  }

  private async updateAutomaticCsv(): Promise<void> {
    try {
      while (this.automaticCsvRequested) {
        this.automaticCsvRequested = false;
        try {
          await this.writeAutomaticCsv();
        } catch (error: unknown) {
          if (!this.automaticCsvRequested) throw error;
        }
      }
    } finally {
      this.automaticCsvUpdate = undefined;
    }
  }

  private async writeAutomaticCsv(): Promise<void> {
    const text = toCsv(await this.read());
    const folder = await this.ensureFolder('Exports');
    const path = `${folder}/rep-journal.csv`;
    if (!await this.vault.adapter.exists(path)) {
      await this.vault.create(path, text);
      return;
    }
    if (await this.vault.adapter.read(path) === text) return;
    const file = this.vault.getFileByPath(path);
    if (file) await this.vault.modify(file, text);
    else await this.vault.adapter.write(path, text);
  }

  private async readExercises(issues: string[]): Promise<ExerciseNote[]> {
    const paths = journalFolders.flatMap((folder) => this.exercisePaths(`${folder}/Exercises`));
    const exercises = await readRecords(paths, async (path) => {
      const file = this.vault.getFileByPath(path);
      if (!file) throw new Error('Exercise note moved while loading.');
      const exercise = readCatalogExercise(noteProperties(await this.vault.cachedRead(file)));
      return exercise ? { ...exercise, path } : null;
    }, issues);
    return uniqueRecords(exercises, (exercise) => exercise.id, issues).sort((a, b) => a.name.localeCompare(b.name));
  }

  private async exerciseEntries(folder: string): Promise<Map<string, string>> {
    const { files, folders } = await this.vault.adapter.list(folder);
    return new Map([...files, ...folders].map((path) => [path.toLowerCase(), path]));
  }

  private async createExerciseNote(exercise: Exercise, markdown: string): Promise<ExerciseNote> {
    const folder = await this.ensureFolder('Exercises');
    const existing = await this.exerciseEntries(folder);
    for (let number = 1; ; number++) {
      const path = `${folder}/${exerciseFilename(exercise, number)}`;
      const occupied = existing.get(path.toLowerCase());
      if (!occupied && !await this.vault.adapter.exists(path)) {
        try {
          await this.vault.create(path, markdown);
          return { ...exercise, path };
        } catch (error: unknown) {
          if (!await this.vault.adapter.exists(path)) throw error;
        }
      }
      const file = this.vault.getFileByPath(occupied ?? path);
      if (!file) continue;
      const properties = noteProperties(await this.vault.cachedRead(file));
      if (!isRecord(properties) || properties.set_ledger_id !== exercise.id) continue;
      const current = readCatalogExercise(properties);
      if (current) return { ...current, path: file.path };
    }
  }

  private async addGuideLinks(file: TFile, exercise: Exercise): Promise<boolean> {
    const withGuides = (text: string): string => {
      const properties = noteProperties(text);
      const current = readCatalogExercise(properties);
      if (!current || current.id !== exercise.id || !isRecord(properties)) {
        throw new Error('The exercise note changed. Retry the cleanup.');
      }
      return appendExerciseGuides(text, current, properties.sources);
    };
    const text = await this.vault.cachedRead(file);
    if (withGuides(text) === text) return false;
    let added = false;
    await this.vault.process(file, (current) => {
      const updated = withGuides(current);
      added = updated !== current;
      return updated;
    });
    return added;
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

  private async createWorkoutFile(workout: WorkoutFile['workout']): Promise<WorkoutFile> {
    const { date } = workout;
    const folder = await this.ensureFolder('Workouts');
    const paths = await Promise.all(journalFolders.map((root) => this.workoutPaths(`${root}/Workouts`)));
    let session = nextWorkoutSession(date, paths.flat());
    const text = this.workoutText(workout);
    while (true) {
      const path = `${folder}/${workoutFilename(date, session)}`;
      try {
        await this.vault.create(path, text);
        return { workout, path };
      } catch (error: unknown) {
        if (!await this.vault.adapter.exists(path)) throw error;
        session++;
      }
    }
  }

  private readWorkoutText(path: string): Promise<string> {
    const file = this.vault.getFileByPath(path);
    return file ? this.vault.cachedRead(file) : this.vault.adapter.read(path);
  }

  private workoutText(workout: WorkoutFile['workout']): string {
    return `${JSON.stringify(workout, null, 2)}\n`;
  }

  private async ensureFolder(section: Section): Promise<string> {
    const root = this.vault.getFolderByPath(journalFolder) || !this.vault.getFolderByPath(legacyFolder)
      ? journalFolder : legacyFolder;
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
