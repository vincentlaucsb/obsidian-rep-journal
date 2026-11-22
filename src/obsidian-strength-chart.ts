import { initializeSvgplot, lineChart } from 'svgplot-wasm';
import wasmBinary from 'svgplot-wasm/line-engine.wasm';
import type { JournalAdapter } from '../standalone/app.ts';

let ready: Promise<void> | undefined;

export const drawObsidianStrengthChart: NonNullable<JournalAdapter['drawStrengthChart']> = async (host, options) => {
  ready ??= initializeSvgplot({ wasmBinary }).catch((error: unknown) => {
    ready = undefined;
    throw error;
  });
  await ready;
  return lineChart(host, options);
};
