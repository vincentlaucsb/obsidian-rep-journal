import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { WorkoutSet } from '../src/model.ts';
import type { DatedPlanNote } from '../src/repo/plan-repository.ts';
import type { WorkoutPlan } from '../src/workout-plan.ts';
import { PlanUses, plannedExercise, type PlanUse } from '../standalone/plan-uses.ts';

const firstDay = '2026-11-22';
const secondDay = '2026-11-23';
const plan: WorkoutPlan = {
  title: 'Upper body', notes: 'Take your time.',
  sections: [
    { name: 'Working sets', notes: '', superset: true, exercises: [
      { name: 'Bench press', exerciseId: 'bench', notes: '' },
      { name: 'Row', exerciseId: 'row', notes: '' },
    ] },
    { name: 'Cooldown', notes: '', superset: false, exercises: [] },
  ],
};
const first: DatedPlanNote = { date: firstDay, path: 'Upper body.md', title: 'Upper body', plan };
const second: DatedPlanNote = { ...first, path: 'Other plan.md' };
const dated = [first, second];
const readPlan = async () => ({ plan });

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    key: (index: number) => [...values.keys()][index] ?? null,
    getItem: (key: string) => values.get(key) ?? null,
    setItem(key: string, value: string) { values.set(key, value); },
    removeItem(key: string) { values.delete(key); },
  };
}

function active(uses: PlanUses, date: string, path: string, notes = dated): PlanUse {
  const use = uses.active(date, notes).find((candidate) => candidate.path === path);
  assert(use);
  return use;
}

void test('dated uses advance, stop, and restart independently across reloads', async () => {
  const storage = memoryStorage();
  const firstPane = new PlanUses(() => storage, 'vault');
  const secondPane = new PlanUses(() => storage, 'vault');

  const set: WorkoutSet = { id: 'set', exerciseId: 'bench', exerciseName: 'Bench press', reps: 8, warmup: false };
  firstPane.log(active(firstPane, firstDay, first.path), set);
  secondPane.stop(active(secondPane, firstDay, second.path));
  assert.equal(firstPane.active(secondDay, dated).length, 0);

  const reopened = new PlanUses(() => storage, 'vault');
  await reopened.restore(firstDay, readPlan, dated);
  assert.deepEqual(reopened.active(firstDay, dated).map(({ path, exercise }) => [path, exercise]), [[first.path, 1]]);
  assert.equal(plannedExercise(active(reopened, firstDay, first.path)).name, 'Row');
  reopened.start(second, true);
  assert.equal(active(reopened, firstDay, second.path).exercise, 0);
  assert.equal(active(reopened, firstDay, first.path).exercise, 1);
  assert.deepEqual(reopened.active(firstDay, [first]).map(({ path }) => path), [first.path]);
});

void test('the same template has an independent position when started on another date', async () => {
  const storage = memoryStorage();
  const vault = new PlanUses(() => storage, 'vault');
  vault.start({ ...first, date: secondDay }, false);
  vault.move(active(vault, secondDay, first.path), 1);
  vault.stop(active(vault, firstDay, first.path));

  const reopened = new PlanUses(() => storage, 'vault');
  await reopened.restore(firstDay, readPlan, dated);
  await reopened.refreshManual(secondDay, dated, readPlan);
  assert.deepEqual(reopened.active(firstDay, dated).map(({ path }) => path), [second.path]);
  assert.equal(active(reopened, secondDay, first.path).section, 1);
  const otherVault = new PlanUses(() => storage, 'other-vault');
  await otherVault.restore(firstDay, readPlan, dated);
  await otherVault.refreshManual(secondDay, dated, readPlan);
  assert.equal(otherVault.active(secondDay, dated).length, 0);
  assert.equal(otherVault.active(firstDay, dated).length, 2);
});

void test('migrates the legacy active plan to Today with its saved position', async () => {
  const storage = memoryStorage();
  const legacy = 'rep-journal:active-plan:vault';
  storage.setItem(legacy, JSON.stringify({
    path: first.path, title: first.title, section: 0, exercise: 1, signature: JSON.stringify(plan),
  }));
  const uses = new PlanUses(() => storage, 'vault');
  await uses.restore(secondDay, readPlan, dated);
  assert.equal(active(uses, secondDay, first.path).exercise, 1);
  assert.equal(active(uses, firstDay, first.path).exercise, 0);
  assert.equal(storage.getItem(legacy), null);
});

void test('stale planned sets cannot revive a plan dismissed in another pane', () => {
  const storage = memoryStorage();
  const firstPane = new PlanUses(() => storage, 'vault');
  const secondPane = new PlanUses(() => storage, 'vault');
  const stale = active(secondPane, firstDay, first.path);
  firstPane.stop(active(firstPane, firstDay, first.path));

  const set: WorkoutSet = { id: 'set', exerciseId: 'bench', exerciseName: 'Bench press', reps: 8, warmup: false };
  secondPane.log(stale, set);
  assert.deepEqual(secondPane.active(firstDay, dated).map(({ path }) => path), [second.path]);

  firstPane.start(first, true);
  secondPane.log(stale, set);
  assert.equal(active(secondPane, firstDay, first.path).exercise, 0);
  secondPane.log(active(secondPane, firstDay, first.path), set);
  assert.equal(active(firstPane, firstDay, first.path).exercise, 1);
});

void test('fetches only manual uses for the selected date and refreshes changed definitions', async () => {
  const storage = memoryStorage();
  const vault = new PlanUses(() => storage, 'vault');
  vault.start(first, false);
  vault.start({ ...second, date: secondDay }, false);

  const reopened = new PlanUses(() => storage, 'vault');
  const reads: string[] = [];
  const read = async (path: string) => {
    reads.push(path);
    return { plan };
  };
  await reopened.restore(firstDay, read, []);
  assert.deepEqual(reads, []);
  await reopened.refreshManual(secondDay, [], read);
  assert.deepEqual(reads, [second.path]);
  assert.equal(active(reopened, secondDay, second.path, []).plan.title, 'Upper body');

  const updated = { ...second, plan: { ...plan, title: 'Horizontal pull' } };
  await reopened.refreshManual(secondDay, [updated], read);
  assert.deepEqual(reads, [second.path]);
  assert.equal(active(reopened, secondDay, second.path, []).plan.title, 'Horizontal pull');
  await reopened.refreshManual(secondDay, [], async () => ({ issues: [] }));
  assert.deepEqual(reopened.active(secondDay, []), []);
});
