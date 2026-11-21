import type { LineChartOptions } from 'svgplot-wasm';
import type { exerciseProgress } from '../src/journal-workflow.ts';
import type { WeightUnit } from '../src/model.ts';

export type StrengthChartRange = '1W' | '1M' | '3M' | '6M' | '1Y' | 'Max';

export function strengthChartRange<T extends { date: string }>(
  points: readonly T[], today: string, range: StrengthChartRange,
): { start: number; end: number; points: readonly T[] };

export function strengthChartAxis(start: number, end: number, width: number): {
  xDomain: LineChartOptions['xDomain'];
  xTickLabels: NonNullable<LineChartOptions['xTickLabels']>;
};

export function mountStrengthChart(
  section: HTMLElement, points: ReturnType<typeof exerciseProgress>['trend'], unit: WeightUnit, today: string,
  drawChart: (host: HTMLElement, options: LineChartOptions) => Promise<SVGSVGElement>,
): () => void;
