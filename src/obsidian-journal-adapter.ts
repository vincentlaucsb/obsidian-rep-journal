import { apply, isSupported } from '@oddbird/popover-polyfill/fn';
import type { Vault } from 'obsidian';
import type { JournalAdapter } from '../standalone/app.ts';
import { progressExercises } from './analytics.ts';
import { readContextOptions, serializeExport, workoutContext } from './exports.ts';
import {
  exerciseProgress, isWorkoutPlanPath, maxPlanBytes, planNoteFrom, prepareExerciseEdit, prepareLogSet, prepareStarter, prepareWorkoutEdit,
  readLogSetInput, workoutStarters,
  type PlanNote,
} from './journal-workflow.ts';
import { localDate, makeId, type WeightUnit } from './model.ts';
import { DatedPlanRepository, datedPlanDate, isPlanYear } from './repo/plan-repository.ts';
import type { LedgerRepository } from './repository.ts';
import { parseWorkoutPlan } from './workout-plan.ts';

type JournalVault = Pick<Vault, 'getMarkdownFiles' | 'getFolderByPath' | 'getFileByPath' | 'cachedRead'>;
type JournalRepository = Pick<LedgerRepository, 'root' | 'read' | 'saveWorkout' | 'saveExercise' | 'saveStarter' | 'writeExport' | 'refreshAutomaticCsv'>;

export function createObsidianJournalAdapter(
  vault: JournalVault,
  repository: JournalRepository,
  options: {
    vaultKey: string;
    weightUnit: () => WeightUnit;
    reportExportError: (error: unknown) => void;
    openExerciseNote: NonNullable<JournalAdapter['openExerciseNote']>;
  },
): JournalAdapter {
  let writes: Promise<unknown> = Promise.resolve();
  const plans = new DatedPlanRepository(repository.root);
  const updateAutomaticCsv = (): Promise<void> => repository.refreshAutomaticCsv().catch(options.reportExportError);

  function write<T>(apply: () => Promise<T>): Promise<T> {
    const pending = writes.catch(() => undefined).then(apply);
    writes = pending;
    return pending;
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
      return { ...data, datedPlans, starters: workoutStarters(data), today: localDate(), unit: options.weightUnit(), vaultKey: options.vaultKey };
    },
    async enablePopover() {
      if (!isSupported()) apply();
    },
    async listPlans() {
      const exercises = progressExercises(await repository.read());
      const files = vault.getMarkdownFiles().filter((file) => isWorkoutPlanPath(file.path, repository.root) && file.stat.size <= maxPlanBytes);
      const plans: PlanNote[] = [];
      for (let start = 0; start < files.length; start += 24) {
        const notes = await Promise.all(files.slice(start, start + 24).map(async (file) => {
          const markdown = await vault.cachedRead(file).catch(() => undefined);
          if (markdown === undefined) return;
          return planNoteFrom(file.path, markdown, exercises, !!datedPlanDate(file.path, repository.root));
        }));
        for (const note of notes) if (note) plans.push(note);
      }
      return plans.sort((a, b) => a.title.localeCompare(b.title) || a.path.localeCompare(b.path));
    },
    async readPlan(path) {
      const note = vault.getFileByPath(path);
      if (!note || note.extension.toLowerCase() !== 'md') throw new Error('The workout plan note is no longer available.');
      if (note.stat.size > maxPlanBytes) throw new Error('The plan is too large to open.');
      const [markdown, data] = await Promise.all([vault.cachedRead(note), repository.read()]);
      return parseWorkoutPlan(markdown, progressExercises(data));
    },
    makeSetId: makeId,
    saveSet(input, unit) {
      return write(async () => {
        const request = readLogSetInput(input, localDate());
        const prepared = prepareLogSet(await repository.read(), request, unit);
        if ('replay' in prepared) return prepared.replay;
        const saved = await repository.saveWorkout(request.date, { kind: 'add', set: prepared.set }, prepared.original);
        void updateAutomaticCsv();
        return saved;
      });
    },
    editWorkout(input) {
      return write(async () => {
        const prepared = prepareWorkoutEdit(await repository.read(), input, localDate());
        if ('replay' in prepared) return prepared.replay;
        const saved = await repository.saveWorkout(prepared.date, prepared.change, prepared.original, prepared.newWorkoutId);
        void updateAutomaticCsv();
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
      return exerciseProgress(await repository.read(), exerciseId, options.weightUnit());
    },
    saveExport(format) {
      return write(async () => repository.writeExport(format, serializeExport(await repository.read(), format)));
    },
    refreshAutomaticCsv: () => repository.refreshAutomaticCsv(),
    async prepareContext(input) {
      const context = readContextOptions(input);
      return workoutContext(await repository.read(), context, options.weightUnit());
    },
    openExerciseNote: options.openExerciseNote,
  };
}
