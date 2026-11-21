import type { DistanceUnit, WeightUnit } from '../src/model.ts';

export function convertWeight(value: number, from: WeightUnit, to: WeightUnit): number;
export function convertDistance(value: number, from: DistanceUnit, to: DistanceUnit): number;
