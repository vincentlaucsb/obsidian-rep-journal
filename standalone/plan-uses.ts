import type { PlanNote } from '../src/journal-workflow.ts';
import { isDate, isRecord, type WorkoutSet } from '../src/model.ts';
import type { DatedPlanNote } from '../src/repo/plan-repository.ts';
import { advanceWorkoutPlan, type parseWorkoutPlan, type WorkoutPlan } from '../src/workout-plan.ts';

type Position = { section: number; exercise: number };
type SavedPlan = PlanNote & Position & { signature: string };
type PlanIdentity = { date: string; path: string };
type RecordForDay = PlanIdentity & { revision: number } & (
  | { status: 'dated' | 'manual'; title: string; fingerprint: string; section: number; exercise: number }
  | { status: 'stopped' }
);
type ReadPlan = (path: string) => Promise<ReturnType<typeof parseWorkoutPlan>>;
type PlanStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'key' | 'length'>;

export type PlanUse = DatedPlanNote & Position & { revision: number };

export function plannedExercise(use: PlanUse) {
  return use.plan.sections[use.section].exercises[use.exercise];
}

const useKey = ({ date, path }: PlanIdentity) => JSON.stringify([date, path]);

function isSavedPlan(value: unknown): value is SavedPlan {
  return isRecord(value) && typeof value.path === 'string' && typeof value.title === 'string' &&
    typeof value.section === 'number' && Number.isInteger(value.section) &&
    typeof value.exercise === 'number' && Number.isInteger(value.exercise) &&
    typeof value.signature === 'string';
}

function isRecordForDay(value: unknown): value is RecordForDay {
  if (!isRecord(value) || !isDate(value.date) || typeof value.path !== 'string' ||
    typeof value.revision !== 'number' || !Number.isSafeInteger(value.revision) || value.revision < 1) return false;
  if (value.status === 'stopped') return true;
  return (value.status === 'dated' || value.status === 'manual') && typeof value.title === 'string' &&
    typeof value.section === 'number' && Number.isInteger(value.section) &&
    typeof value.exercise === 'number' && Number.isInteger(value.exercise) && typeof value.fingerprint === 'string';
}

function validPosition(plan: WorkoutPlan, { section, exercise }: Position) {
  const current = plan.sections[section];
  return Boolean(current && exercise >= 0 && exercise < Math.max(1, current.exercises.length));
}

export class PlanUses {
  private readonly fingerprints = new WeakMap<WorkoutPlan, string>();
  private readonly unsaved = new Map<string, RecordForDay>();
  private readonly manualPlans = new Map<string, { plan: WorkoutPlan; fingerprint: string }>();
  private readonly storage: () => PlanStorage;
  private readonly prefix: string;
  private readonly legacyKey: string;

  constructor(storage: () => PlanStorage, vaultKey: string) {
    this.storage = storage;
    this.prefix = `rep-journal:plan-use:${JSON.stringify(vaultKey)}:`;
    this.legacyKey = `rep-journal:active-plan:${vaultKey}`;
  }

  async restore(today: string, readPlan: ReadPlan, datedPlans: readonly DatedPlanNote[]): Promise<void> {
    const legacy = this.readStorage(this.legacyKey);
    if (!isSavedPlan(legacy)) return;
    const identity = { date: today, path: legacy.path };
    if (!this.latest(identity)) {
      const note = datedPlans.find(({ path }) => path === legacy.path);
      const plan = note?.plan ?? await readPlan(legacy.path).then((result) => result.plan).catch(() => undefined);
      if (!plan) return;
      if (!this.latest(identity) && legacy.signature === JSON.stringify(plan) && validPosition(plan, legacy)) {
        if (!this.write({ ...legacy, date: today, plan, revision: 0 }, note?.date === today ? 'dated' : 'manual')) return;
      }
    }
    try { this.storage().removeItem(this.legacyKey); } catch { /* Storage can be unavailable. */ }
  }

  async refreshManual(date: string, datedPlans: readonly DatedPlanNote[], readPlan: ReadPlan): Promise<boolean> {
    const records = this.recordsFor(date);
    const changed = await Promise.all([...records].map(async ([key, record]) => {
      if (record.status !== 'manual') return false;
      const current = datedPlans.find(({ path }) => path === record.path);
      const plan = current?.plan ?? await readPlan(record.path).then((result) => result.plan).catch(() => undefined);
      if (this.latest(record)?.revision !== record.revision) return false;
      const previous = this.manualPlans.get(key);
      if (plan) this.manualPlans.set(key, { plan, fingerprint: record.fingerprint });
      else this.manualPlans.delete(key);
      return previous?.plan !== plan || previous?.fingerprint !== record.fingerprint;
    }));
    return changed.some(Boolean);
  }

  active(date: string, datedPlans: readonly DatedPlanNote[]): PlanUse[] {
    const plans = new Map(datedPlans.filter((note) => note.date === date).map((note) => [useKey(note), note]));
    const records = this.recordsFor(date);
    for (const [key, record] of records) {
      if (record.status !== 'manual' || plans.has(key)) continue;
      const current = this.manualPlans.get(key);
      if (current?.fingerprint === record.fingerprint) {
        plans.set(key, { date, path: record.path, title: record.title, plan: current.plan });
      }
    }
    const uses: PlanUse[] = [];
    for (const [key, note] of plans) {
      const record = records.get(key);
      if (record?.status === 'stopped') continue;
      const position = record && record.fingerprint === this.fingerprint(note.plan) && validPosition(note.plan, record)
        ? { section: record.section, exercise: record.exercise } : { section: 0, exercise: 0 };
      uses.push({ ...note, ...position, revision: record?.revision ?? 0 });
    }
    return uses;
  }

  start(note: DatedPlanNote, dated: boolean): void {
    const revision = this.latest(note)?.revision ?? 0;
    this.write({ ...note, section: 0, exercise: 0, revision }, dated ? 'dated' : 'manual');
  }

  stop(use: PlanUse): void {
    if ((this.latest(use)?.revision ?? 0) !== use.revision) return;
    this.manualPlans.delete(useKey(use));
    this.save({ date: use.date, path: use.path, revision: use.revision + 1, status: 'stopped' });
  }

  move(use: PlanUse, section: number, exercise = 0): void {
    if (!validPosition(use.plan, { section, exercise })) return;
    const current = this.latest(use);
    if ((current?.revision ?? 0) !== use.revision || current?.status === 'stopped') return;
    if (current?.status === 'manual') {
      const plan = this.manualPlans.get(useKey(use))?.plan;
      if (!plan || this.fingerprint(plan) !== this.fingerprint(use.plan)) return;
    }
    this.write({ ...use, section, exercise }, current?.status === 'manual' ? 'manual' : 'dated');
  }

  log(use: PlanUse, set: WorkoutSet): void {
    const { sectionIndex, exerciseIndex } = advanceWorkoutPlan(use.plan, {
      sectionIndex: use.section, exerciseIndex: use.exercise,
    }, { kind: 'add', set });
    if (sectionIndex !== use.section || exerciseIndex !== use.exercise) this.move(use, sectionIndex, exerciseIndex);
  }

  private fingerprint(plan: WorkoutPlan): string {
    const cached = this.fingerprints.get(plan);
    if (cached) return cached;
    // FNV-1a keeps persisted fingerprints small even when plan notes are large.
    const serialized = JSON.stringify(plan);
    let hash = 0x811c9dc5;
    for (let index = 0; index < serialized.length; index++) {
      hash = Math.imul(hash ^ serialized.charCodeAt(index), 0x01000193);
    }
    const fingerprint = `${serialized.length}:${(hash >>> 0).toString(16)}`;
    this.fingerprints.set(plan, fingerprint);
    return fingerprint;
  }

  private write(use: PlanUse, status: 'dated' | 'manual'): boolean {
    const { date, path, title, section, exercise, plan, revision } = use;
    const fingerprint = this.fingerprint(plan);
    const key = useKey(use);
    if (status === 'manual') this.manualPlans.set(key, { plan, fingerprint });
    else this.manualPlans.delete(key);
    return this.save({ date, path, title, section, exercise, revision: revision + 1, fingerprint, status });
  }

  private save(record: RecordForDay): boolean {
    const key = useKey(record);
    try {
      this.storage().setItem(this.prefix + key, JSON.stringify(record));
      this.unsaved.delete(key);
      return true;
    } catch {
      this.unsaved.set(key, record);
      return false;
    }
  }

  private latest(identity: PlanIdentity): RecordForDay | undefined {
    const key = useKey(identity);
    const saved = this.readStorage(this.prefix + key);
    const stored = isRecordForDay(saved) ? saved : undefined;
    const unsaved = this.unsaved.get(key);
    if (unsaved && unsaved.revision > (stored?.revision ?? 0)) return unsaved;
    return stored;
  }

  private recordsFor(date: string): Map<string, RecordForDay> {
    const records = new Map<string, RecordForDay>();
    const datePrefix = this.prefix + `["${date}",`;
    try {
      const storage = this.storage();
      for (let index = 0; index < storage.length; index++) {
        const key = storage.key(index);
        if (!key?.startsWith(datePrefix)) continue;
        const record = this.readStorage(key);
        if (isRecordForDay(record) && record.date === date) records.set(useKey(record), record);
      }
    } catch { /* Storage can be unavailable. */ }
    for (const [key, record] of this.unsaved) {
      if (record.date === date && record.revision > (records.get(key)?.revision ?? 0)) records.set(key, record);
    }
    return records;
  }

  private readStorage(key: string): unknown {
    try { return JSON.parse(this.storage().getItem(key) ?? 'null') as unknown; }
    catch { return undefined; }
  }
}
