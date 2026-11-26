import { apply, isSupported } from '@oddbird/popover-polyfill/fn';
import type { TFile, Vault } from 'obsidian';
import type { JournalAdapter } from '../standalone/app.ts';
import { progressExercises } from './analytics.ts';
import { readContextOptions, serializeExport, workoutContext } from './exports.ts';
import {
  exerciseProgress, isWorkoutPlanPath, maxPlanBytes, prepareExerciseEdit, prepareLogSet, prepareStarter, prepareWorkoutEdit,
  readLogSetInput, workoutStarters,
} from './journal-workflow.ts';
import { localDate, makeId, type WeightUnit } from './model.ts';
import { DatedPlanRepository, isPlanYear, PlanPickerRepository } from './repo/plan-repository.ts';
import { diskFileRevision, type StatDiskFile } from './repo/workout-snapshot.ts';
import type { LedgerRepository } from './repository.ts';
import { defaultMeasurementSystem, journalWeightUnit, type MeasurementSystem } from './units.ts';
import { parseWorkoutPlan } from './workout-plan.ts';

type JournalVault = Pick<Vault, 'getMarkdownFiles' | 'getFolderByPath' | 'getFileByPath' | 'cachedRead'> & {
  adapter: Pick<Vault['adapter'], 'read'>;
};
type JournalRepository = Pick<LedgerRepository, 'root' | 'read' | 'readExercises' | 'readWorkoutSnapshot' | 'saveWorkout' | 'saveExercise' | 'saveStarter' |
  'writeExport' | 'refreshAutomaticCsv'>;

export function createObsidianJournalAdapter(
  vault: JournalVault,
  repository: JournalRepository,
  options: {
    vaultKey: string;
    statFile?: StatDiskFile;
    weightUnit: () => WeightUnit;
    measurementSystem?: () => Promise<MeasurementSystem>;
    reportExportError: (error: unknown) => void;
    openExerciseNote: NonNullable<JournalAdapter['openExerciseNote']>;
  },
): JournalAdapter {
  const measurementSystem = options.measurementSystem ?? (() => Promise.resolve(defaultMeasurementSystem(options.weightUnit())));
  let writes: Promise<unknown> = Promise.resolve();
  const plans = new DatedPlanRepository(repository.root);
  const planPicker = new PlanPickerRepository(repository.root);
  const updateAutomaticCsv = (workout?: Parameters<JournalRepository['refreshAutomaticCsv']>[0]): Promise<void> =>
    repository.refreshAutomaticCsv(workout).catch(options.reportExportError);

  function write<T>(apply: () => Promise<T>): Promise<T> {
    const pending = writes.catch(() => undefined).then(apply);
    writes = pending;
    return pending;
  }

  async function inspectPlan(file: TFile) {
    const { path } = file;
    const stat = await options.statFile?.(path).catch(() => undefined);
    const disk = stat?.isFile() ? stat : undefined;
    return {
      size: disk?.size ?? file.stat.size,
      revision: disk && diskFileRevision(disk),
      read: () => vault.adapter.read(path),
    };
  }

  return {
    async loadJournal() {
      const data = await repository.read();
      const plansFolder = vault.getFolderByPath(`${repository.root}/Plans`);
      const paths = plansFolder?.children.flatMap(({ name, path }) =>
        isPlanYear(name) ? vault.getFolderByPath(path)?.children.map(({ path }) => path) ?? [] : []) ?? [];
      const datedPlans = await plans.read(paths, progressExercises(data), async (path) => {
        const file = vault.getFileByPath(path);
        if (file && file.stat.size <= maxPlanBytes) return vault.cachedRead(file);
      });
      const system = await measurementSystem();
      return { ...data, datedPlans, starters: workoutStarters(data), today: localDate(), unit: journalWeightUnit(system), measurementSystem: system, vaultKey: options.vaultKey };
    },
    async enablePopover() {
      if (!isSupported()) apply();
    },
    async listPlans() {
      const exercises = await repository.readExercises();
      const paths = vault.getMarkdownFiles().map(({ path }) => path).filter((path) => isWorkoutPlanPath(path, repository.root));
      return planPicker.read(paths, exercises, async (path) => {
        const file = vault.getFileByPath(path);
        if (!file) return;
        const plan = await inspectPlan(file);
        if (plan.size <= maxPlanBytes) return plan;
      });
    },
    async readPlan(path) {
      const note = vault.getFileByPath(path);
      if (!note || note.extension.toLowerCase() !== 'md') throw new Error('The workout plan note is no longer available.');
      const plan = await inspectPlan(note);
      if (plan.size > maxPlanBytes) throw new Error('The plan is too large to open.');
      const [markdown, exercises] = await Promise.all([plan.read(), repository.readExercises()]);
      const result = parseWorkoutPlan(markdown, exercises);
      if (result.plan) return result;
      return parseWorkoutPlan(markdown, progressExercises(await repository.read({ fresh: true })));
    },
    makeSetId: makeId,
    saveSet(input, unit) {
      return write(async () => {
        const request = readLogSetInput(input, localDate());
        const snapshot = await repository.readWorkoutSnapshot();
        const prepared = prepareLogSet(snapshot.data, request, unit, request.units ? undefined : options.measurementSystem ? await measurementSystem() : defaultMeasurementSystem(unit));
        if ('replay' in prepared) return prepared.replay;
        const saved = await repository.saveWorkout(request.date, { kind: 'add', set: prepared.set }, prepared.original);
        void updateAutomaticCsv({ snapshot, saved });
        return saved;
      });
    },
    editWorkout(input) {
      return write(async () => {
        const snapshot = await repository.readWorkoutSnapshot();
        const prepared = prepareWorkoutEdit(snapshot.data, input, localDate(), await measurementSystem());
        if ('replay' in prepared) return prepared.replay;
        const saved = await repository.saveWorkout(prepared.date, prepared.change, prepared.original, prepared.newWorkoutId);
        void updateAutomaticCsv({ snapshot, saved });
        return saved;
      });
    },
    saveExercise(input, unit) {
      return write(async () => {
        const prepared = prepareExerciseEdit(await repository.read(), input, unit);
        if ('replay' in prepared) return prepared.replay;
        const saved = await repository.saveExercise(prepared.exercise, prepared.original, prepared.exercise.id);
        void updateAutomaticCsv();
        return saved;
      });
    },
    addStarter(id) {
      return write(async () => {
        const prepared = prepareStarter(await repository.read(), id);
        if (prepared.existing) return prepared.existing;
        const saved = await repository.saveStarter(prepared.starter);
        void updateAutomaticCsv();
        return saved;
      });
    },
    async readProgress(exerciseId) {
      const system = await measurementSystem();
      return exerciseProgress(await repository.read(), exerciseId, journalWeightUnit(system), system);
    },
    saveExport(format) {
      return write(async () => repository.writeExport(format, serializeExport(await repository.read(), format)));
    },
    refreshAutomaticCsv: () => repository.refreshAutomaticCsv(),
    async prepareContext(input) {
      const context = readContextOptions(input);
      return workoutContext(await repository.read(), context, journalWeightUnit(await measurementSystem()));
    },
    openExerciseNote: options.openExerciseNote,
  };
}
