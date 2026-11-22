import { mountJournal, type JournalAdapter } from './app.js';

const root = document.querySelector<HTMLElement>('#journal');
const browser = root?.ownerDocument.defaultView;
if (!root || !browser) throw new Error('Rep Journal needs a browser window.');

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  if (!browser) throw new Error('Rep Journal needs a browser window.');
  const response = await browser.fetch(path, options);
  const result: unknown = await response.json();
  if (!response.ok) {
    const message = result && typeof result === 'object' && 'error' in result ? result.error : null;
    throw new Error(typeof message === 'string' ? message : 'Rep Journal could not complete the request.');
  }
  // The version-matched local server produces the response for each adapter method.
  return result as T;
}

function post<T>(path: string, input: unknown): Promise<T> {
  return request<T>(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
}

mountJournal(root, {
  loadJournal: () => request('/api/journal'),
  enablePopover: async () => {
    const { apply, isSupported } = await import('/popover-fn.js');
    if (!isSupported()) apply();
  },
  listPlans: () => request('/api/plans'),
  readPlan: (path) => request('/api/plan?path=' + encodeURIComponent(path)),
  makeSetId: () => browser.crypto.randomUUID(),
  saveSet: (input) => post('/api/sets', input),
  editWorkout: (input) => post('/api/workout-edits', input),
  saveExercise: (input) => post('/api/exercises', input),
  addStarter: (starterId) => post('/api/exercises', { starterId }),
  readProgress: (id) => request(id ? `/api/progress?exercise=${encodeURIComponent(id)}` : '/api/progress'),
  drawStrengthChart: async (host, options) => (await import('/svgplot/charts.js')).lineChart(host, options),
  saveExport: async (format) => (await post<{ path: string }>('/api/exports', { format })).path,
  refreshAutomaticCsv: async () => { await post('/api/exports', { format: 'automatic-csv' }); },
  readAutomaticCsvError: async () => (await request<{ automaticCsvError?: string }>('/api/exports')).automaticCsvError,
  prepareContext: async (input) => (await post<{ text: string }>('/api/context', input)).text,
} satisfies JournalAdapter, (tag) => document.createElement(tag));
