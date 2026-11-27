import assert from 'node:assert/strict';
import { test } from 'node:test';
import { exactRepRecords } from '../src/analytics.ts';
import { createWorkout, makeId, type WorkoutSet } from '../src/model.ts';

void test('finds chronological exact-rep records across compatible units and load modes', () => {
  const exerciseId = makeId();
  function set(reps: number, load: WorkoutSet['load'], warmup = false): WorkoutSet {
    return { id: makeId(), exerciseId, exerciseName: 'Bench', reps, load, warmup };
  }
  const kg = (value: number) => ({ mode: 'weight' as const, value, unit: 'kg' as const });
  const lb = (value: number) => ({ mode: 'weight' as const, value, unit: 'lb' as const });
  const added = (value: number) => ({ mode: 'added' as const, value, unit: 'lb' as const });
  const first = { ...createWorkout('2025-01-01'), createdAt: '2025-01-01T08:00:00.000Z' };
  first.sets = [
    set(1, kg(100)), set(15, kg(4.5359237)), set(15, kg(1000), true),
    set(15, { mode: 'assistance', value: 200, unit: 'lb' }), set(15, { mode: 'bodyweight' }),
    set(2, lb(0)), set(2, lb(1)),
  ];
  const single = set(1, lb(225));
  const fifteen = set(15, kg(4.535923700000001));
  const weighted = set(15, added(1.5));
  const second = { ...createWorkout(first.date), createdAt: '2025-01-01T16:00:00.000Z' };
  second.sets = [
    set(15, lb(10)), single, set(1, lb(225)), fifteen, set(15, kg(4.535923700000001)),
    set(15, added(1)), weighted, set(2, lb(0.9)), { ...set(1, lb(999)), exerciseId: makeId() },
  ];
  const third = { ...createWorkout('2025-01-02'), sets: [set(1, kg(150))] };
  const records = exactRepRecords([third, second, first]);
  assert.deepEqual([...records.entries()], [[second.id, new Set([single, fifteen, weighted])], [third.id, new Set(third.sets)]]);
});
