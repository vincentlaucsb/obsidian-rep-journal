import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { build, transform } from 'esbuild';
import { readContextOptions, workoutContext } from '../src/exports.ts';
import { journalFolder } from '../src/journal-paths.ts';
import { exerciseProgress, workoutStarters } from '../src/journal-workflow.ts';
import { errorMessage, isId, isRecord, isUnit, localDate, type WeightUnit } from '../src/model.ts';
import { DatedPlanRepository, PlanPickerRepository } from '../src/repo/plan-repository.ts';
import type { RecordRevisions } from '../src/repo/workout-snapshot.ts';
import { readImportVault, readJournalFolder, resolveImportVaultRoot } from './import-vault.ts';
import { svelteNotices, sveltePlugin } from './svelte-esbuild.ts';
import {
  addStandaloneStarter, editStandaloneExercise, editStandaloneWorkout, listStandaloneDatedPlans, listStandalonePlans, readStandalonePlan, refreshStandaloneCsv, saveStandaloneExport,
  saveStandaloneSet,
} from './standalone-vault.ts';

const host = '127.0.0.1';
const postRoutes = new Set(['/api/sets', '/api/workout-edits', '/api/exercises', '/api/exports', '/api/context']);
const assets = new Map([
  ['/', { file: 'standalone/index.html', type: 'text/html' }],
  ['/bootstrap.js', { file: 'standalone/bootstrap.ts', type: 'text/javascript' }],
  ['/drafts.js', { file: 'standalone/drafts.ts', type: 'text/javascript' }],
  ['/icons.js', { file: 'standalone/icons.ts', type: 'text/javascript' }],
  ['/popover-fn.js', { file: 'node_modules/@oddbird/popover-polyfill/dist/popover-fn.js', type: 'text/javascript' }],
  ['/popover-license.txt', { file: 'node_modules/@oddbird/popover-polyfill/LICENSE', type: 'text/plain' }],
  ['/units.js', { file: 'standalone/units.ts', type: 'text/javascript' }],
  ['/strength-chart.js', { file: 'standalone/strength-chart.ts', type: 'text/javascript' }],
  ['/svgplot/charts.js', { file: 'node_modules/svgplot-wasm/charts.js', type: 'text/javascript' }],
  ['/svgplot/line.js', { file: 'node_modules/svgplot-wasm/line.js', type: 'text/javascript' }],
  ['/svgplot/line-engine.mjs', { file: 'node_modules/svgplot-wasm/line-engine.mjs', type: 'text/javascript' }],
  ['/svgplot/line-engine.wasm', { file: 'node_modules/svgplot-wasm/line-engine.wasm', type: 'application/wasm' }],
  ['/style.css', { file: 'styles.css', type: 'text/css' }],
]);

function send(response: ServerResponse, status: number, type: string, content: string | Buffer): void {
  response.writeHead(status, {
    'Content-Type': type === 'application/wasm' ? type : `${type}; charset=utf-8`,
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'self'",
    'X-Content-Type-Options': 'nosniff',
    'Cross-Origin-Resource-Policy': 'same-origin',
  });
  response.end(content);
}

function json(response: ServerResponse, status: number, body: unknown): void {
  send(response, status, 'application/json', JSON.stringify(body));
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const parts: Buffer[] = [];
  let size = 0;
  for await (const part of request as AsyncIterable<Buffer>) {
    size += part.length;
    if (size > 1024 * 1024) throw new Error('This change is too large.');
    parts.push(part);
  }
  return JSON.parse(Buffer.concat(parts).toString('utf8')) as unknown;
}

export async function startStandalone(vault: string, port = 4317, unit: WeightUnit = 'lb') {
  const root = await resolveImportVaultRoot(vault);
  const folder = await readJournalFolder(root);
  const store = { root, read: (revisions?: RecordRevisions) => readImportVault(root, folder, revisions) };
  const plans = new DatedPlanRepository(folder);
  const planPicker = new PlanPickerRepository(folder);
  const hash = createHash('sha256').update(root);
  if (folder !== journalFolder) hash.update('\0').update(folder);
  const vaultKey = hash.digest('hex').slice(0, 24);
  let automaticCsvError: string | undefined;
  const reportAutomaticCsv = (message?: string): void => { automaticCsvError = message; };
  async function refreshAutomaticCsv(): Promise<void> {
    try {
      await refreshStandaloneCsv(store);
      reportAutomaticCsv();
    } catch (error: unknown) {
      reportAutomaticCsv(errorMessage(error));
      throw error;
    }
  }
  await refreshAutomaticCsv().catch(() => undefined);
  let authority = '';
  const server = createServer((request, response) => {
    void handle(request, response).catch((error: unknown) => {
      if (!response.headersSent) json(response, 400, { error: errorMessage(error) });
      else response.end();
    });
  });

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.headers.host !== authority) {
      json(response, 403, { error: 'Open Rep Journal from its local address.' });
      return;
    }
    const url = new URL(request.url ?? '/', `http://${authority}`);
    if (request.method === 'POST' && postRoutes.has(url.pathname)) {
      if (request.headers.origin !== `http://${authority}` || request.headers['content-type']?.split(';')[0] !== 'application/json') {
        json(response, 403, { error: 'Save changes from the local Rep Journal app.' });
        return;
      }
      const input = await readJson(request);
      if (url.pathname === '/api/workout-edits') json(response, 200, await editStandaloneWorkout(store, input, localDate(), reportAutomaticCsv));
      else if (url.pathname === '/api/exercises') {
        const saved = isRecord(input) && 'starterId' in input
          ? await addStandaloneStarter(store, input.starterId, reportAutomaticCsv)
          : await editStandaloneExercise(store, input, unit, reportAutomaticCsv);
        json(response, 200, saved);
      }
      else if (url.pathname === '/api/sets') json(response, 200, await saveStandaloneSet(store, input, localDate(), unit, reportAutomaticCsv));
      else if (url.pathname === '/api/context') {
        const context = readContextOptions(input);
        json(response, 200, { text: workoutContext((await store.read()).data, context, unit) });
      } else {
        if (!isRecord(input)) throw new Error('Choose an export format.');
        const { format } = input;
        if (format === 'automatic-csv') {
          await refreshAutomaticCsv();
          json(response, 200, {});
        } else if (format === 'csv' || format === 'json') {
          json(response, 200, { path: await saveStandaloneExport(store, format) });
        } else throw new Error('Choose an export format.');
      }
    } else if (request.method !== 'GET') {
      json(response, 405, { error: 'Unsupported request.' });
    } else if (url.pathname === '/api/journal') {
      const { data } = await store.read();
      const datedPlans = await listStandaloneDatedPlans(root, folder, data, plans);
      json(response, 200, { ...data, datedPlans, starters: workoutStarters(data), today: localDate(), unit, vaultKey });
    } else if (url.pathname === '/api/exports') {
      json(response, 200, { automaticCsvError });
    } else if (url.pathname === '/api/progress') {
      const exerciseId = url.searchParams.get('exercise');
      if (exerciseId !== null && !isId(exerciseId)) throw new Error('Choose an exercise.');
      const { data } = await store.read();
      json(response, 200, exerciseProgress(data, exerciseId, unit));
    } else if (url.pathname === '/api/plans') {
      json(response, 200, await listStandalonePlans(root, folder, planPicker));
    } else if (url.pathname === '/api/plan') {
      json(response, 200, await readStandalonePlan(root, url.searchParams.get('path') ?? '', (await store.read()).data));
    } else if (url.pathname === '/app.js') {
      const { outputFiles } = await build({
        entryPoints: [fileURLToPath(new URL('../standalone/app.ts', import.meta.url))],
        bundle: true,
        format: 'esm',
        target: 'es2020',
        write: false,
        plugins: [sveltePlugin],
        banner: { js: `/*! Svelte and bundled dependencies\n${svelteNotices.join('\n')}\n*/` },
      });
      send(response, 200, 'text/javascript', outputFiles[0].text);
    } else {
      const asset = assets.get(url.pathname);
      if (!asset) {
        json(response, 404, { error: 'Page not found.' });
        return;
      }
      const content = await readFile(new URL(`../${asset.file}`, import.meta.url));
      if (asset.file.endsWith('.ts')) {
        const { code } = await transform(content.toString('utf8'), { loader: 'ts', format: 'esm', target: 'es2020', sourcefile: asset.file });
        send(response, 200, asset.type, code);
      } else {
        send(response, 200, asset.type, content);
      }
    }
  }

  await new Promise<void>((resolveListening, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.removeListener('error', reject);
      const address = server.address();
      if (address && typeof address !== 'string') authority = `${host}:${address.port}`;
      resolveListening();
    });
  });
  return { server, origin: `http://${authority}` };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const { values } = parseArgs({ options: { vault: { type: 'string' }, port: { type: 'string' }, unit: { type: 'string' } } });
    const port = Number(values.port ?? '4317');
    const unit = values.unit ?? 'lb';
    if (!values.vault || !Number.isInteger(port) || port < 1 || port > 65535 || !isUnit(unit)) {
      throw new Error('Usage: npm run standalone -- --vault PATH [--port 4317] [--unit lb|kg]');
    }
    const { origin } = await startStandalone(values.vault, port, unit);
    process.stdout.write(`Rep Journal is ready at ${origin}\n`);
  } catch (error: unknown) {
    process.stderr.write(`${errorMessage(error)}\n`);
    process.exitCode = 1;
  }
}
