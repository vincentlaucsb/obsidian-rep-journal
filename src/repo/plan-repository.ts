import type { PlanNote } from '../journal-workflow.ts';
import { isDate, type ExerciseChoice } from '../model.ts';
import { parseWorkoutPlan, type WorkoutPlan } from '../workout-plan.ts';

export interface DatedPlanNote {
  date: string;
  path: string;
  title: string;
  plan: WorkoutPlan;
}

export function isPlanYear(name: string): boolean {
  return /^\d{4}$/.test(name) && name !== '0000';
}

export function datedPlanDate(path: string, root: string): string | undefined {
  const plans = `${root}/Plans/`;
  if (!path.startsWith(plans)) return;
  const [year, filename, ...nested] = path.slice(plans.length).split('/');
  if (!isPlanYear(year) || !filename || nested.length || filename.includes('\\')) return;
  const [, date, suffix] = /^(\d{4}-\d{2}-\d{2})([ _-].*)?\.md$/i.exec(filename) ?? [];
  if (suffix && !suffix.replace(/^[ _-]+/, '').trim()) return;
  if (isDate(date) && date.slice(0, 4) === year) return date;
}

export function affectsDatedPlanFolder(path: string, root: string): boolean {
  const plans = `${root}/Plans`;
  return path === plans || plans.startsWith(`${path}/`) ||
    (path.startsWith(`${plans}/`) && isPlanYear(path.slice(plans.length + 1)));
}

interface CachedPlan { markdown: string; note?: DatedPlanNote }

function planExerciseKey(exercises: readonly ExerciseChoice[]): string {
  return JSON.stringify(exercises.map(({ id, name, aliases, archived, missingNote }) => [id, name, aliases, archived, missingNote]));
}

interface PlanFile {
  revision?: string;
  read(): Promise<string>;
}

interface PickerEntry {
  revision?: string;
  checksExercises: boolean;
  note?: PlanNote;
}

export class PlanPickerRepository {
  private readonly root: string;
  private entries = new Map<string, PickerEntry>();
  private exerciseKey = '';
  private version = 0;

  constructor(root: string) {
    this.root = root;
  }

  async read(
    paths: readonly string[], exercises: readonly ExerciseChoice[],
    inspect: (path: string) => PlanFile | undefined | Promise<PlanFile | undefined>,
  ): Promise<PlanNote[]> {
    const version = ++this.version;
    const exerciseKey = planExerciseKey(exercises);
    const sameExercises = exerciseKey === this.exerciseKey;
    const previous = this.entries;
    const entries = new Map<string, PickerEntry>();
    const notes: PlanNote[] = [];
    for (let start = 0; start < paths.length; start += 24) {
      const results = await Promise.allSettled(paths.slice(start, start + 24).map(async (path) => {
        const file = await inspect(path);
        if (!file) return;
        const cached = previous.get(path);
        if (file.revision !== undefined && cached?.revision === file.revision && (sameExercises || !cached.checksExercises)) {
          return { path, entry: cached };
        }
        const markdown = await file.read();
        const dated = Boolean(datedPlanDate(path, this.root));
        const checksExercises = dated || (/^ {0,3}##\s+\S/m.test(markdown) && /^ {0,3}###\s+\S/m.test(markdown));
        const plan = checksExercises ? parseWorkoutPlan(markdown, exercises).plan : undefined;
        const note = plan || dated || (checksExercises && /(?:plan|routine|superset|workout)/i.test(path))
          ? { path, title: plan?.title ?? path.slice(path.lastIndexOf('/') + 1, -3) } : undefined;
        return { path, entry: { revision: file.revision, checksExercises, note } };
      }));
      for (const result of results) {
        if (result.status === 'fulfilled' && result.value) {
          const { path, entry } = result.value;
          if (entry.revision !== undefined) entries.set(path, entry);
          if (entry.note) notes.push(entry.note);
        }
      }
    }
    if (version === this.version) {
      this.entries = entries;
      this.exerciseKey = exerciseKey;
    }
    return notes.sort((a, b) => a.title.localeCompare(b.title) || a.path.localeCompare(b.path));
  }
}

export class DatedPlanRepository {
  private readonly root: string;
  private exerciseKey = '';
  private entries = new Map<string, CachedPlan>();
  private version = 0;

  constructor(root: string) {
    this.root = root;
  }

  async read(
    paths: readonly string[], exercises: readonly ExerciseChoice[], readMarkdown: (path: string) => Promise<string | undefined>,
  ): Promise<DatedPlanNote[]> {
    const version = ++this.version;
    const exerciseKey = planExerciseKey(exercises);
    const cached = exerciseKey === this.exerciseKey ? this.entries : undefined;
    const entries = new Map<string, CachedPlan>();
    const candidates = paths.flatMap((path) => {
      const date = datedPlanDate(path, this.root);
      return date ? [{ path, date }] : [];
    });
    const plans: DatedPlanNote[] = [];
    for (let start = 0; start < candidates.length; start += 24) {
      const notes = await Promise.all(candidates.slice(start, start + 24).map(async ({ path, date }) => {
        const markdown = await readMarkdown(path).catch(() => undefined);
        if (markdown === undefined) return;
        const previous = cached?.get(path);
        if (previous?.markdown === markdown) {
          entries.set(path, previous);
          return previous.note;
        }
        const { plan } = parseWorkoutPlan(markdown, exercises);
        const note = plan ? { date, path, title: plan.title ?? path.slice(path.lastIndexOf('/') + 1, -3), plan } : undefined;
        entries.set(path, { markdown, note });
        return note;
      }));
      for (const note of notes) if (note) plans.push(note);
    }
    if (version === this.version) {
      this.exerciseKey = exerciseKey;
      this.entries = entries;
    }
    return plans.sort((a, b) => a.date.localeCompare(b.date) || a.path.localeCompare(b.path));
  }
}
