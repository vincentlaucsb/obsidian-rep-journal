import type { DistanceUnit, ElevationUnit, Exercise, WeightUnit } from './model.ts';

export type MeasurementSystem = 'metric' | 'imperial';

export function isMeasurementSystem(value: unknown): value is MeasurementSystem {
  return value === 'metric' || value === 'imperial';
}

export function defaultMeasurementSystem(unit: WeightUnit = 'lb'): MeasurementSystem {
  return unit === 'kg' ? 'metric' : 'imperial';
}

export interface MeasurementUnits {
  weightUnit?: WeightUnit;
  distanceUnit?: DistanceUnit;
  elevationUnit?: ElevationUnit;
}

export function displayUnits(system?: MeasurementSystem, exercise?: Pick<Exercise, keyof MeasurementUnits>): MeasurementUnits {
  return {
    weightUnit: exercise?.weightUnit ?? (system ? journalWeightUnit(system) : undefined),
    distanceUnit: exercise?.distanceUnit ?? (system === 'metric' ? 'km' : system === 'imperial' ? 'mi' : undefined),
    elevationUnit: exercise?.elevationUnit ?? (system === 'metric' ? 'm' : system === 'imperial' ? 'ft' : undefined),
  };
}

export function journalWeightUnit(system?: MeasurementSystem, fallback: WeightUnit = 'lb'): WeightUnit {
  return system === 'metric' ? 'kg' : system === 'imperial' ? 'lb' : fallback;
}

export function entryUnits(unit: WeightUnit, system?: MeasurementSystem, exercise?: Pick<Exercise, keyof MeasurementUnits>): Required<MeasurementUnits> {
  const preferred = displayUnits(system, exercise);
  return { weightUnit: preferred.weightUnit ?? unit, distanceUnit: preferred.distanceUnit ?? 'm', elevationUnit: preferred.elevationUnit ?? 'm' };
}

const kgPerPound = 0.45359237;
const metersPerUnit: Record<DistanceUnit, number> = { m: 1, km: 1000, mi: 1609.344, yd: 0.9144, ft: 0.3048 };

export function convertWeight(value: number, from: WeightUnit, to: WeightUnit): number {
  if (from === to) return value;
  return from === 'lb' ? value * kgPerPound : value / kgPerPound;
}

export function convertDistance(value: number, from: DistanceUnit, to: DistanceUnit): number {
  if (from === to) return value;
  return value * (metersPerUnit[from] / metersPerUnit[to]);
}
