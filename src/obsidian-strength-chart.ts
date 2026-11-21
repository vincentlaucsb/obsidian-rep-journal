import type { JournalAdapter } from '../standalone/app.js';

let chart: Promise<typeof import('svgplot-wasm').lineChart> | undefined;

export const drawObsidianStrengthChart: NonNullable<JournalAdapter['drawStrengthChart']> = async (host, options) => {
  chart ??= Promise.all([import('svgplot-wasm'), import('svgplot-wasm/line-engine.wasm')]).then(async ([svgplot, bytes]) => {
    await svgplot.initializeSvgplot({ wasmBinary: bytes.default });
    return svgplot.lineChart;
  }).catch((error: unknown) => {
    chart = undefined;
    throw error;
  });
  return (await chart)(host, options);
};
