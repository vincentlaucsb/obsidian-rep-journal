import type { LineChartOptions } from 'svgplot-wasm';
import type { ExerciseChoice, ExerciseNote, LedgerData, WeightUnit, WorkoutFile } from '../src/model.ts';
import type { ContextOptions, ExportFormat } from '../src/exports.ts';
import type { exerciseProgress, ExerciseEditInput, LogSetInput, PlanNote, WorkoutEditInput } from '../src/journal-workflow.ts';
import type { parseWorkoutPlan } from '../src/workout-plan.ts';

export interface JournalAdapter {
  loadJournal(): Promise<LedgerData & { starters: ExerciseChoice[]; today: string; unit: WeightUnit; vaultKey: string }>;
  listPlans(): Promise<PlanNote[]>;
  readPlan(path: string): Promise<ReturnType<typeof parseWorkoutPlan>>;
  makeSetId(): string;
  saveSet(input: LogSetInput, unit: WeightUnit): Promise<WorkoutFile>;
  editWorkout(input: WorkoutEditInput): Promise<WorkoutFile>;
  saveExercise(input: ExerciseEditInput, unit: WeightUnit): Promise<ExerciseNote>;
  addStarter(id: string): Promise<ExerciseNote>;
  readProgress(exerciseId: string | null): Promise<ReturnType<typeof exerciseProgress>>;
  drawStrengthChart?(host: HTMLElement, options: LineChartOptions): Promise<SVGSVGElement>;
  saveExport(format: ExportFormat): Promise<string>;
  refreshAutomaticCsv(): Promise<void>;
  readAutomaticCsvError?(): Promise<string | undefined>;
  prepareContext(options: ContextOptions): Promise<string>;
  openExerciseNote?(exercise: ExerciseNote): void;
}

export interface MountedJournal {
  ready: Promise<void>;
  showToday(): Promise<void>;
  openProgress(exerciseId?: string): Promise<void>;
  openExport(): Promise<void>;
  openPlan(file: PlanNote, start?: boolean): Promise<void>;
  reload(force?: boolean): Promise<void>;
  setWeightUnit(unit: WeightUnit): void;
  dispose(): void;
}

export function mountJournal(root: HTMLElement, adapter: JournalAdapter): MountedJournal;
