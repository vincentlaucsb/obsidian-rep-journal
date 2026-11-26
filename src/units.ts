import type { DistanceUnit, WeightUnit } from './model.ts';

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
