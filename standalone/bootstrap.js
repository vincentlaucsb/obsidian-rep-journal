import { mountJournal } from './app.js';

const root = document.querySelector('#journal');
const browser = root.ownerDocument.defaultView;

async function request(path, options) {
  const response = await browser.fetch(path, options);
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? 'Rep Journal could not complete the request.');
  return result;
}

function post(path, input) {
  return request(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
}

mountJournal(root, {
  loadJournal: () => request('/api/journal'),
  listPlans: () => request('/api/plans'),
  readPlan: (path) => request('/api/plan?path=' + encodeURIComponent(path)),
  makeSetId: () => browser.crypto.randomUUID(),
  saveSet: (input) => post('/api/sets', input),
  editWorkout: (input) => post('/api/workout-edits', input),
  saveExercise: (input) => post('/api/exercises', input),
  addStarter: (starterId) => post('/api/exercises', { starterId }),
  readProgress: (id) => request(id ? `/api/progress?exercise=${encodeURIComponent(id)}` : '/api/progress'),
  saveExport: async (format) => (await post('/api/exports', { format })).path,
  refreshAutomaticCsv: async () => { await post('/api/exports', { format: 'automatic-csv' }); },
  readAutomaticCsvError: async () => (await request('/api/exports')).automaticCsvError,
  prepareContext: async (input) => (await post('/api/context', input)).text,
});
