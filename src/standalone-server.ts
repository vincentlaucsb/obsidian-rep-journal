import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { resolve } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { readContextOptions, workoutContext } from './exports.ts';
import { readImportVault, resolveImportVaultRoot } from './import-vault.ts';
import { exerciseProgress, workoutStarters } from './journal-workflow.ts';
import { errorMessage, isId, isRecord, isUnit, localDate, type WeightUnit } from './model.ts';
import {
  addStandaloneStarter, editStandaloneExercise, editStandaloneWorkout, listStandalonePlans, readStandalonePlan, refreshStandaloneCsv, saveStandaloneExport,
  saveStandaloneSet,
} from './standalone-vault.ts';

const host = '127.0.0.1';
const postRoutes = new Set(['/api/sets', '/api/workout-edits', '/api/exercises', '/api/exports', '/api/context']);
const assets = new Map([
  ['/', { file: 'standalone/index.html', type: 'text/html' }],
  ['/app.js', { file: 'standalone/app.js', type: 'text/javascript' }],
  ['/bootstrap.js', { file: 'standalone/bootstrap.js', type: 'text/javascript' }],
  ['/drafts.js', { file: 'standalone/drafts.js', type: 'text/javascript' }],
  ['/units.js', { file: 'standalone/units.js', type: 'text/javascript' }],
  ['/strength-chart.js', { file: 'standalone/strength-chart.js', type: 'text/javascript' }],
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
  const vaultKey = createHash('sha256').update(root).digest('hex').slice(0, 24);
  let automaticCsvError: string | undefined;
  const reportAutomaticCsv = (message?: string): void => { automaticCsvError = message; };
  async function refreshAutomaticCsv(): Promise<void> {
    try {
      await refreshStandaloneCsv(root);
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
      if (url.pathname === '/api/workout-edits') json(response, 200, await editStandaloneWorkout(root, input, localDate(), reportAutomaticCsv));
      else if (url.pathname === '/api/exercises') {
        const saved = isRecord(input) && 'starterId' in input
          ? await addStandaloneStarter(root, input.starterId, reportAutomaticCsv)
          : await editStandaloneExercise(root, input, unit, reportAutomaticCsv);
        json(response, 200, saved);
      }
      else if (url.pathname === '/api/sets') json(response, 200, await saveStandaloneSet(root, input, localDate(), unit, reportAutomaticCsv));
      else if (url.pathname === '/api/context') {
        const context = readContextOptions(input);
        json(response, 200, { text: workoutContext((await readImportVault(root)).data, context, unit) });
      } else {
        if (!isRecord(input)) throw new Error('Choose an export format.');
        const { format } = input;
        if (format === 'automatic-csv') {
          await refreshAutomaticCsv();
          json(response, 200, {});
        } else if (format === 'csv' || format === 'json') {
          json(response, 200, { path: await saveStandaloneExport(root, format) });
        } else throw new Error('Choose an export format.');
      }
    } else if (request.method !== 'GET') {
      json(response, 405, { error: 'Unsupported request.' });
    } else if (url.pathname === '/api/journal') {
      const { data } = await readImportVault(root);
      json(response, 200, { ...data, starters: workoutStarters(data), today: localDate(), unit, vaultKey });
    } else if (url.pathname === '/api/exports') {
      json(response, 200, { automaticCsvError });
    } else if (url.pathname === '/api/progress') {
      const exerciseId = url.searchParams.get('exercise');
      if (exerciseId !== null && !isId(exerciseId)) throw new Error('Choose an exercise.');
      const { data } = await readImportVault(root);
      json(response, 200, exerciseProgress(data, exerciseId, unit));
    } else if (url.pathname === '/api/plans' || url.pathname === '/api/plan') {
      const { data } = await readImportVault(root);
      if (url.pathname === '/api/plans') json(response, 200, await listStandalonePlans(root, data));
      else json(response, 200, await readStandalonePlan(root, url.searchParams.get('path') ?? '', data));
    } else {
      const asset = assets.get(url.pathname);
      if (!asset) json(response, 404, { error: 'Page not found.' });
      else send(response, 200, asset.type, await readFile(new URL(`../${asset.file}`, import.meta.url)));
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
