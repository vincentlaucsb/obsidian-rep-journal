import { lineChart } from 'svgplot-wasm/embedded';
import type { JournalAdapter } from '../standalone/app.ts';

export const drawObsidianStrengthChart: NonNullable<JournalAdapter['drawStrengthChart']> = lineChart;
