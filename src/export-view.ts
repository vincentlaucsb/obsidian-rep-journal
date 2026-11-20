import { type ContextOptions } from './exports.ts';
import { errorMessage, isDate, localDate } from './model.ts';
import { actionButton, labeledInput } from './ui-controls.ts';

interface ExportOptions {
  saveFile: (extension: 'csv' | 'json') => Promise<string>;
  showContext: (options: ContextOptions) => Promise<void>;
}

export function renderExportView(parent: HTMLElement, options: ExportOptions): void {
  const exports = parent.createDiv({ cls: 'rep-journal-panel' });
  exports.createEl('h3', { text: 'Export training data' });
  exports.createEl('p', { text: 'CSV contains one row per set. JSON includes the full exercise catalog and workout history.' });
  const buttons = exports.createDiv({ cls: 'rep-journal-actions' });
  const fileStatus = exports.createEl('p', { cls: 'rep-journal-status', attr: { role: 'status' } });
  const csv = actionButton(buttons, 'Export CSV', () => save('csv'));
  const json = actionButton(buttons, 'Export JSON', () => save('json'));
  function save(extension: 'csv' | 'json'): void {
    fileStatus.setText('');
    csv.disabled = true;
    json.disabled = true;
    void options.saveFile(extension).then((path) => {
      fileStatus.setText(`Saved to ${path}`);
    }, (error: unknown) => {
      fileStatus.setText(errorMessage(error));
    }).finally(() => {
      csv.disabled = false;
      json.disabled = false;
    });
  }

  const form = parent.createEl('form', { cls: 'rep-journal-panel' });
  form.createEl('h3', { text: 'Workout context' });
  const dateFields = form.createDiv({ cls: 'rep-journal-form-grid' });
  const from = labeledInput(dateFields, 'From', { type: 'date', required: '' });
  const to = labeledInput(dateFields, 'Through', { type: 'date', required: '' });
  const start = new Date();
  start.setDate(start.getDate() - 41);
  from.value = localDate(start);
  to.value = localDate();
  const goal = labeledInput(form, 'Training goal', { type: 'text', maxlength: '500' });
  const equipment = labeledInput(form, 'Available equipment', { type: 'text', maxlength: '500' });
  const days = labeledInput(form, 'Days per week', { type: 'number', inputmode: 'numeric', min: '1', max: '7' });
  const notesLabel = form.createEl('label', { cls: 'rep-journal-check' });
  const includeNotes = notesLabel.createEl('input', { attr: { type: 'checkbox' } });
  notesLabel.createSpan({ text: 'Include workout notes' });
  const prepare = form.createEl('button', { cls: 'mod-cta', text: 'Prepare workout context', attr: { type: 'submit' } });
  const status = form.createEl('p', { cls: 'rep-journal-status', attr: { role: 'status' } });
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (prepare.disabled) return;
    if (!isDate(from.value) || !isDate(to.value) || from.value > to.value) {
      status.setText('Choose a valid date range.');
      return;
    }
    status.setText('');
    prepare.disabled = true;
    void options.showContext({
      from: from.value, to: to.value, goal: goal.value.trim(), equipment: equipment.value.trim(),
      daysPerWeek: days.value ? days.valueAsNumber : null, includeNotes: includeNotes.checked,
    }).catch((error: unknown) => status.setText(errorMessage(error))).finally(() => { prepare.disabled = false; });
  });
}
