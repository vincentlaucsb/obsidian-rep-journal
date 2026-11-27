import type { ContextOptions, ExportFormat } from '../src/exports.ts';
import { errorMessage } from '../src/model.ts';

interface ExportScreenOptions {
  el: <Tag extends keyof HTMLElementTagNameMap>(
    tag: Tag, attributes: Record<string, string | number | undefined>, ...children: Array<Node | string | undefined>
  ) => HTMLElementTagNameMap[Tag];
  button: (label: string, action: () => void | Promise<void>) => HTMLButtonElement;
  saveExport: (format: ExportFormat) => Promise<string>;
  refreshAutomaticCsv: () => Promise<void>;
  readAutomaticCsvError?: () => Promise<string | undefined>;
  prepareContext: (options: ContextOptions) => Promise<string>;
  clipboard: () => Pick<Clipboard, 'writeText'> | undefined;
}

interface ContextDraft extends Omit<ContextOptions, 'daysPerWeek'> {
  days: string;
  text: string;
  status: string;
  error: boolean;
  version: number;
  pending?: boolean;
}

export function createExportScreen({ el, button, saveExport, refreshAutomaticCsv, readAutomaticCsvError, prepareContext, clipboard }: ExportScreenOptions) {
  const fileExport = { pending: false, error: false, status: '', automaticError: '', version: 0 };
  let draft: ContextDraft | undefined;
  let active: { updateFile(): void; updateContext(): void; selectPreview(): void } | undefined;

  function mount(host: HTMLElement, today: string, back: HTMLButtonElement): () => void {
    const file = renderFileExports();
    const workout = renderWorkoutContext(today);
    const view = { updateFile: file.update, updateContext: workout.update, selectPreview: workout.selectPreview };
    active = view;
    host.append(el('section', { class: 'page' }, back, el('h1', {}, 'Export'), file.section, workout.form));
    file.readStatus();
    return () => { if (active === view) active = undefined; };
  }

  function renderFileExports() {
    const csv = button('Export CSV', () => save('csv'));
    const json = button('Export JSON', () => save('json'));
    const refresh = button('Refresh automatic CSV', () => save('automatic-csv'));
    const status = el('p', { role: 'status' });
    const automaticStatus = el('p', { class: 'warning', role: 'status' });
    const section = el('section', { class: 'plan-section' }, el('h2', {}, 'Training data'),
      el('p', { class: 'secondary' }, 'New CSV and JSON exports save dated copies in Exports. The automatic CSV is always named rep-journal.csv.'),
      el('div', { class: 'plan-controls' }, csv, json, refresh), status, automaticStatus);

    function update() {
      for (const control of [csv, json, refresh]) control.disabled = fileExport.pending;
      status.textContent = fileExport.status;
      status.hidden = !fileExport.status;
      status.classList.toggle('warning', fileExport.error);
      automaticStatus.textContent = fileExport.automaticError ? `Could not update the automatic CSV. ${fileExport.automaticError}` : '';
      automaticStatus.hidden = !fileExport.automaticError;
    }

    async function save(format: ExportFormat | 'automatic-csv') {
      if (fileExport.pending) return;
      fileExport.pending = true;
      fileExport.version++;
      fileExport.error = false;
      fileExport.status = 'Saving…';
      const automatic = format === 'automatic-csv';
      if (automatic) fileExport.automaticError = '';
      active?.updateFile();
      try {
        if (automatic) {
          await refreshAutomaticCsv();
          fileExport.status = 'Automatic CSV refreshed.';
        } else {
          const path = await saveExport(format);
          fileExport.status = `Saved to ${path}`;
        }
      } catch (error) {
        fileExport.status = errorMessage(error);
        fileExport.error = true;
      } finally {
        fileExport.pending = false;
        active?.updateFile();
      }
    }

    update();
    function readStatus() {
      if (fileExport.pending || !readAutomaticCsvError) return;
      const version = fileExport.version;
      void readAutomaticCsvError().then((error) => {
        if (active?.updateFile !== update || version !== fileExport.version) return;
        fileExport.automaticError = error ?? '';
        update();
      }).catch(() => undefined);
    }
    return { section, update, readStatus };
  }

  function renderWorkoutContext(today: string) {
    if (!draft) {
      const start = new Date(today + 'T00:00:00Z');
      start.setUTCDate(start.getUTCDate() - 41);
      draft = { from: start.toISOString().slice(0, 10), to: today, goal: '', equipment: '', days: '', includeNotes: false,
        text: '', status: '', error: false, version: 0 };
    }
    const context = draft;
    const from = el('input', { type: 'date', required: '' });
    const to = el('input', { type: 'date', required: '' });
    const goal = el('input', { type: 'text', maxlength: 500 });
    const equipment = el('input', { type: 'text', maxlength: 500 });
    const days = el('input', { type: 'number', min: 1, max: 7, step: 1, inputmode: 'numeric' });
    const includeNotes = el('input', { type: 'checkbox' });
    from.value = context.from;
    to.value = context.to;
    goal.value = context.goal;
    equipment.value = context.equipment;
    days.value = context.days;
    includeNotes.checked = context.includeNotes;
    const submit = el('button', { type: 'submit', class: 'primary' }, 'Prepare workout context');
    const preview = el('textarea', { 'aria-label': 'Workout context preview', readonly: '', rows: 12 });
    const copy = button('Copy workout context', copyContext);
    const output = el('div', { class: 'context-preview' }, preview, el('div', {}, copy));
    const status = el('p', { role: 'status' });
    const form = el('form', { class: 'entry-form plan-section' }, el('h2', {}, 'Workout context'),
      el('div', { class: 'entry-fields' }, el('label', {}, 'From', from), el('label', {}, 'Through', to)),
      el('label', {}, 'Training goal', goal), el('label', {}, 'Available equipment', equipment), el('label', {}, 'Days per week', days),
      el('label', { class: 'check-field' }, includeNotes, 'Include workout notes'), el('div', {}, submit), output, status);

    function update() {
      submit.disabled = Boolean(context.pending);
      output.hidden = !context.text;
      preview.value = context.text;
      status.hidden = !context.status;
      status.textContent = context.status;
      status.classList.toggle('warning', context.error);
    }

    async function copyContext() {
      const version = context.version;
      try {
        const target = clipboard();
        if (!target) throw new Error('Clipboard unavailable.');
        await target.writeText(context.text);
        if (version !== context.version) return;
        context.status = 'Workout context copied.';
      } catch {
        if (version !== context.version) return;
        context.status = 'Copy the selected text manually.';
        active?.updateContext();
        active?.selectPreview();
        return;
      }
      active?.updateContext();
    }

    form.addEventListener('input', (event) => {
      if (event.target === preview) return;
      Object.assign(context, { from: from.value, to: to.value, goal: goal.value, equipment: equipment.value,
        days: days.value, includeNotes: includeNotes.checked, text: '', status: '', error: false, pending: false });
      context.version++;
      update();
    });
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      void prepare();
    });
    async function prepare() {
      if (context.pending) return;
      const version = ++context.version;
      Object.assign(context, { pending: true, text: '', status: 'Preparing workout context…', error: false });
      update();
      try {
        const text = await prepareContext({ from: from.value, to: to.value, goal: goal.value, equipment: equipment.value,
          daysPerWeek: days.value ? days.valueAsNumber : null, includeNotes: includeNotes.checked });
        if (version !== context.version) return;
        context.text = text;
        context.status = '';
      } catch (error) {
        if (version !== context.version) return;
        context.status = errorMessage(error);
        context.error = true;
      } finally {
        if (version === context.version) {
          context.pending = false;
          active?.updateContext();
        }
      }
    }
    update();
    return { form, update, selectPreview: () => { preview.focus(); preview.select(); } };
  }

  return { mount };
}
