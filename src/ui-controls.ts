import { Modal, Notice, Setting, SuggestModal, type App } from 'obsidian';
import { errorMessage, isLoadMode, isUnit, loadModes, type ExerciseChoice, type ExerciseDetails, type ExerciseNote } from './model.ts';

export function labeledInput(parent: HTMLElement, label: string, attrs: Record<string, string>): HTMLInputElement {
  const field = parent.createEl('label', { cls: 'rep-journal-field' });
  field.createSpan({ text: label });
  return field.createEl('input', { attr: attrs });
}

export function labeledSelect(parent: HTMLElement, label: string): HTMLSelectElement {
  const field = parent.createEl('label', { cls: 'rep-journal-field' });
  field.createSpan({ text: label });
  return field.createEl('select');
}

export function actionButton(parent: HTMLElement, label: string, onClick: () => void, primary = false): HTMLButtonElement {
  const button = parent.createEl('button', { text: label, attr: { type: 'button' } });
  if (primary) button.addClass('mod-cta');
  button.addEventListener('click', onClick);
  return button;
}

export function addOption(select: HTMLSelectElement, value: string, label: string): void {
  select.createEl('option', { text: label, attr: { value } });
}

type PickerEntry = { kind: 'exercise'; exercise: ExerciseChoice } | { kind: 'create'; name: string };

export class ExercisePicker extends SuggestModal<PickerEntry> {
  constructor(
    app: App,
    private readonly exercises: ExerciseChoice[],
    private readonly choose: (exercise: ExerciseChoice) => void,
    private readonly create?: (name: string) => void,
  ) {
    super(app);
    this.setPlaceholder('Search exercises');
    this.limit = 50;
  }

  getSuggestions(query: string): PickerEntry[] {
    const name = query.trim().slice(0, 120);
    const lower = name.toLowerCase();
    const matches = this.exercises.filter((exercise) =>
      [exercise.name, ...exercise.aliases, exercise.equipment].some((text) => text.toLowerCase().includes(lower)));
    const entries: PickerEntry[] = matches.slice(0, this.limit - 1).map((exercise) => ({ kind: 'exercise', exercise }));
    if (this.create && (!lower || !matches.some((exercise) => exercise.name.toLowerCase() === lower))) {
      const newExercise: PickerEntry = { kind: 'create', name };
      if (lower) entries.push(newExercise);
      else entries.unshift(newExercise);
    }
    return entries;
  }

  renderSuggestion(entry: PickerEntry, el: HTMLElement): void {
    if (entry.kind === 'create') {
      el.createDiv({ text: entry.name ? `Create exercise “${entry.name}”` : 'Create an exercise' });
      return;
    }
    el.createDiv({ text: entry.exercise.name });
    const description = [entry.exercise.equipment, entry.exercise.archived ? 'Archived' : '',
      entry.exercise.missingNote ? 'Exercise note missing' : ''].filter(Boolean).join(' · ');
    if (description) el.createDiv({ cls: 'suggestion-note', text: description });
  }

  onChooseSuggestion(entry: PickerEntry): void {
    if (entry.kind === 'create') this.create?.(entry.name);
    else this.choose(entry.exercise);
  }
}

export class ExerciseDialog extends Modal {
  constructor(
    app: App,
    private readonly save: (details: ExerciseDetails) => Promise<void>,
    private readonly initialName: string,
    private readonly original?: ExerciseNote,
  ) {
    super(app);
  }

  onOpen(): void {
    this.setTitle(this.original ? 'Edit exercise' : 'Create exercise');
    const form = this.contentEl.createEl('form');
    const fields = form.createEl('fieldset', { cls: 'rep-journal-fields' });
    let name = this.original?.name ?? this.initialName;
    let equipment = this.original?.equipment ?? '';
    let aliases = this.original?.aliases.join(', ') ?? '';
    let loadMode = this.original?.loadMode ?? 'weight';
    let unit = this.original?.unit ?? 'lb';
    let archived = this.original?.archived ?? false;

    new Setting(fields).setName('Name').addText((control) => {
      control.setValue(name).onChange((value) => { name = value; });
      control.inputEl.required = true;
      control.inputEl.maxLength = 120;
      control.inputEl.setAttribute('aria-label', 'Name');
    });
    new Setting(fields).setName('Equipment').addText((control) => {
      control.setValue(equipment).onChange((value) => { equipment = value; });
      control.inputEl.setAttribute('aria-label', 'Equipment');
    });
    new Setting(fields).setName('Aliases').setDesc('Separate search aliases with commas.').addText((control) => {
      control.setValue(aliases).onChange((value) => { aliases = value; });
      control.inputEl.setAttribute('aria-label', 'Aliases');
    });
    new Setting(fields).setName('Default load').addDropdown((control) => {
      for (const mode of loadModes) control.addOption(mode.value, mode.label);
      control.setValue(loadMode).onChange((value) => { if (isLoadMode(value)) loadMode = value; });
      control.selectEl.setAttribute('aria-label', 'Default load');
    });
    new Setting(fields).setName('Default unit').addDropdown((control) => {
      control.addOption('lb', 'Pounds (lb)').addOption('kg', 'Kilograms (kg)').setValue(unit)
        .onChange((value) => { if (isUnit(value)) unit = value; });
      control.selectEl.setAttribute('aria-label', 'Default unit');
    });
    if (this.original) {
      new Setting(fields).setName('Archived').setDesc('Hide this exercise from the workout picker.').addToggle((control) => {
        control.setValue(archived).setTooltip('Archived').onChange((value) => { archived = value; });
      });
    }
    const actions = form.createDiv({ cls: 'rep-journal-actions' });
    const submit = actions.createEl('button', { cls: 'mod-cta', text: 'Save exercise', attr: { type: 'submit' } });
    const message = form.createEl('p', { cls: 'rep-journal-status', attr: { role: 'status' } });
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      if (submit.disabled) return;
      if (!name.trim()) {
        message.setText('Enter an exercise name.');
        return;
      }
      submit.disabled = true;
      fields.disabled = true;
      const details = {
        name: name.trim(), equipment: equipment.trim(),
        aliases: [...new Set(aliases.split(',').map((alias) => alias.trim()).filter(Boolean))],
        loadMode, unit, archived,
      };
      void this.save(details).then(() => this.close(), (error: unknown) => {
        message.setText(errorMessage(error));
        submit.disabled = false;
        fields.disabled = false;
      });
    });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

export class ContextDialog extends Modal {
  constructor(app: App, private readonly context: string) {
    super(app);
  }

  onOpen(): void {
    this.setTitle('Workout context');
    const preview = this.contentEl.createEl('textarea', {
      cls: 'rep-journal-context', attr: { readonly: 'true', 'aria-label': 'Workout context' },
    });
    preview.value = this.context;
    const message = this.contentEl.createEl('p', { cls: 'rep-journal-status', attr: { role: 'status' } });
    const selectForCopy = (): void => {
      preview.focus();
      preview.select();
      message.setText('Select and copy the text manually.');
    };
    actionButton(this.contentEl, 'Copy workout context', () => {
      const clipboard = preview.ownerDocument.defaultView?.navigator.clipboard;
      if (!clipboard) {
        selectForCopy();
        return;
      }
      void clipboard.writeText(this.context).then(() => {
        new Notice('Workout context copied.');
        this.close();
      }, selectForCopy);
    }, true);
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
