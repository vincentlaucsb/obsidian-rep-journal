import type { TFile } from 'obsidian';
import { automaticCsvFilename, exportSnapshotFilename, toCsv, type ExportFormat } from './exports.ts';
import { journalFolder, nextWorkoutSession, normalizeJournalFolder, workoutFilename } from './journal-paths.ts';
import {
  changeWorkout, compareWorkouts, createWorkout, parseWorkout, type Exercise, type ExerciseDetails, type ExerciseNote,
  type LedgerData, type WorkoutChange, type WorkoutFile,
} from './model.ts';
import { ExerciseRepository } from './repo/exercise-repository.ts';
import { ensureFolder, isRecordPath, readRecords, uniqueRecords, type LedgerVault } from './repo/vault-records.ts';

const workoutCreations = new WeakMap<LedgerVault, Promise<WorkoutFile>>();

export class LedgerRepository {
  private readonly vault: LedgerVault;
  private readonly exercises: ExerciseRepository;
  readonly root: string;
  private automaticCsvUpdate?: Promise<void>;
  private automaticCsvRequested = false;

  constructor(vault: LedgerVault, root = journalFolder) {
    this.vault = vault;
    this.root = normalizeJournalFolder(root);
    this.exercises = new ExerciseRepository(vault, this.root);
  }

  async read(): Promise<LedgerData> {
    const issues: string[] = [];
    const workoutPaths = await this.workoutPaths();
    const [exercises, workouts] = await Promise.all([
      this.exercises.read(issues),
      readRecords(workoutPaths, async (path) => ({ path, workout: parseWorkout(await this.readWorkoutText(path)) }), issues),
    ]);
    return {
      exercises,
      workouts: uniqueRecords(workouts, ({ workout }) => workout.id, issues).sort((a, b) => compareWorkouts(a.workout, b.workout)),
      issues: issues.sort(),
    };
  }

  saveStarter(starter: Exercise): Promise<ExerciseNote> {
    return this.exercises.saveStarter(starter);
  }

  saveExercise(details: ExerciseDetails, original?: ExerciseNote, id?: string): Promise<ExerciseNote> {
    return this.exercises.saveExercise(details, original, id);
  }

  tidyExerciseNotes(renameFile: (file: TFile, path: string) => Promise<void>): ReturnType<ExerciseRepository['tidyExerciseNotes']> {
    return this.exercises.tidyExerciseNotes(renameFile);
  }

  async saveWorkout(date: string, change: WorkoutChange, original?: WorkoutFile, newWorkoutId?: string): Promise<WorkoutFile> {
    if (!original) {
      const workout = changeWorkout(createWorkout(date), change);
      if (newWorkoutId) workout.id = newWorkoutId;
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

    const relativePath = original.path.slice(`${this.root}/Workouts/`.length);
    if (!isRecordPath(original.path, this.root, 'Workouts') || !/^(?:\d{4}\/)?[^/]+\.json$/.test(relativePath)) {
      throw new Error('The workout is outside the workout folder.');
    }
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

  async writeExport(format: ExportFormat, text: string): Promise<string> {
    const folder = await ensureFolder(this.vault, `${this.root}/Exports`);
    while (true) {
      const path = `${folder}/${exportSnapshotFilename(format)}`;
      if (await this.vault.adapter.exists(path)) continue;
      try {
        return (await this.vault.create(path, text)).path;
      } catch (error: unknown) {
        if (!await this.vault.adapter.exists(path)) throw error;
      }
    }
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
    const folder = await ensureFolder(this.vault, `${this.root}/Exports`);
    const path = `${folder}/${automaticCsvFilename}`;
    if (!await this.vault.adapter.exists(path)) {
      await this.vault.create(path, text);
      return;
    }
    if (await this.vault.adapter.read(path) === text) return;
    const file = this.vault.getFileByPath(path);
    if (file) await this.vault.modify(file, text);
    else await this.vault.adapter.write(path, text);
  }

  private async workoutPaths(): Promise<string[]> {
    // JSON can be hidden by Obsidian's file-type visibility setting. Enumerate only our workout directory.
    const path = `${this.root}/Workouts`;
    if (!await this.vault.adapter.exists(path)) return [];
    const { files, folders } = await this.vault.adapter.list(path);
    const yearFolders = folders.filter((folder) => /^\d{4}$/.test(folder.slice(path.length + 1)));
    const nestedFiles = await Promise.all(yearFolders.map(async (folder) => (await this.vault.adapter.list(folder)).files));
    return [...files, ...nestedFiles.flat()].filter((path) => path.endsWith('.json')).sort();
  }

  private async createWorkoutFile(workout: WorkoutFile['workout']): Promise<WorkoutFile> {
    const { date } = workout;
    const year = date.slice(0, 4);
    const folder = await ensureFolder(this.vault, `${this.root}/Workouts/${year}`);
    let session = nextWorkoutSession(date, await this.workoutPaths());
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
}
