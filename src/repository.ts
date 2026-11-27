import type { TFile } from 'obsidian';
import { automaticCsvFilename, exportSnapshotFilename, toCsv, type ExportFormat } from './exports.ts';
import { isWorkoutFilePath, journalFolder, nextWorkoutSession, normalizeJournalFolder, workoutFilename } from './journal-paths.ts';
import {
  changeWorkout, compareWorkouts, createWorkout, parseWorkout, type Exercise, type ExerciseDetails, type ExerciseNote,
  type LedgerData, type WorkoutChange, type WorkoutFile,
} from './model.ts';
import { ExerciseRepository } from './repo/exercise-repository.ts';
import { ensureFolder, readRecords, uniqueRecords, type LedgerVault } from './repo/vault-records.ts';
import { diskFileRevision, ledgerWithCommittedWorkout, unchangedRecords, type StatDiskFile, type RecordRevisions, type WorkoutSnapshot } from './repo/workout-snapshot.ts';

const workoutCreations = new WeakMap<LedgerVault, Promise<WorkoutFile>>();

export class LedgerRepository {
  private readonly vault: LedgerVault;
  private readonly exercises: ExerciseRepository;
  private readonly statFile?: StatDiskFile;
  readonly root: string;
  private automaticCsvUpdate?: Promise<void>;
  private automaticCsvRequest?: 'fresh' | { snapshot: WorkoutSnapshot; saved: WorkoutFile };

  constructor(vault: LedgerVault, root = journalFolder, statFile?: StatDiskFile) {
    this.vault = vault;
    this.root = normalizeJournalFolder(root);
    this.exercises = new ExerciseRepository(vault, this.root);
    this.statFile = statFile;
  }

  read(options: { fresh?: boolean; freshWorkouts?: boolean } = {}): Promise<LedgerData> {
    return this.readData(options);
  }

  async readWorkoutSnapshot(): Promise<WorkoutSnapshot> {
    const revisions: RecordRevisions = new Map();
    const data = await this.readData({ fresh: true, revisions });
    return { data, revisions };
  }

  private async readData({ fresh = false, freshWorkouts = false, revisions }: {
    fresh?: boolean; freshWorkouts?: boolean; revisions?: RecordRevisions;
  }): Promise<LedgerData> {
    const issues: string[] = [];
    const workoutPaths = await this.workoutPaths();
    const readText = async (path: string, file?: TFile | null): Promise<string> => {
      if (revisions) revisions.set(path, await this.recordRevision(path).catch(() => undefined));
      return fresh || !file ? this.vault.adapter.read(path) : this.vault.cachedRead(file);
    };
    const [exercises, workouts] = await Promise.all([
      this.exercises.read(issues, (file) => readText(file.path, file)),
      readRecords(workoutPaths, async (path) => {
        const file = fresh || freshWorkouts ? undefined : this.vault.getFileByPath(path);
        const text = await readText(path, file);
        return { path, workout: parseWorkout(text) };
      }, issues),
    ]);
    return {
      exercises,
      workouts: uniqueRecords(workouts, ({ workout }) => workout.id, issues).sort((a, b) => compareWorkouts(a.workout, b.workout)),
      issues: issues.sort(),
    };
  }

  readExercises(): Promise<ExerciseNote[]> {
    return this.exercises.read([], (file) => this.vault.adapter.read(file.path));
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

    if (!isWorkoutFilePath(original.path, this.root)) {
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

  refreshAutomaticCsv(workout?: { snapshot: WorkoutSnapshot; saved: WorkoutFile }): Promise<void> {
    if (this.automaticCsvRequest !== 'fresh') this.automaticCsvRequest = workout ?? 'fresh';
    this.automaticCsvUpdate ??= this.updateAutomaticCsv();
    return this.automaticCsvUpdate;
  }

  private async updateAutomaticCsv(): Promise<void> {
    try {
      while (this.automaticCsvRequest) {
        const request = this.automaticCsvRequest;
        this.automaticCsvRequest = undefined;
        try {
          const data = request === 'fresh' ? undefined : await this.reuseWorkoutSnapshot(request.snapshot, request.saved);
          await this.writeAutomaticCsv(data ?? await this.read({ fresh: true }));
        } catch (error: unknown) {
          if (!this.automaticCsvRequest) throw error;
        }
      }
    } finally {
      this.automaticCsvUpdate = undefined;
    }
  }

  private async reuseWorkoutSnapshot(snapshot: WorkoutSnapshot, saved: WorkoutFile): Promise<LedgerData | undefined> {
    const data = ledgerWithCommittedWorkout(snapshot.data, saved);
    if (!data) return;
    for (const [path, revision] of snapshot.revisions) {
      if (path !== saved.path && revision === undefined) return;
    }
    try {
      const workouts = await this.workoutPaths();
      const paths = [...this.exercises.paths(), ...workouts];
      if (!await unchangedRecords(paths, snapshot.revisions, saved.path, (path) => this.recordRevision(path))) return;
      if (await this.vault.adapter.read(saved.path) === this.workoutText(saved.workout)) return data;
    } catch {
      // Use a fresh read to report vault issues when the committed snapshot cannot be verified.
    }
  }

  private async recordRevision(path: string): Promise<string | undefined> {
    // Obsidian's public ctime is the creation time, which stays fixed on some external writes.
    const stat = await this.statFile?.(path);
    if (stat?.isFile()) return diskFileRevision(stat);
  }

  private async writeAutomaticCsv(data: LedgerData): Promise<void> {
    const text = toCsv(data);
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

  private workoutText(workout: WorkoutFile['workout']): string {
    return `${JSON.stringify(workout, null, 2)}\n`;
  }
}
