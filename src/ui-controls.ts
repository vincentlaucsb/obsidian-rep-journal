import { Modal, Notice, Setting, SuggestModal, type App } from 'obsidian';
import { matchesExerciseName, matchesTags, pickerTags } from './catalog.ts';
import {
  distanceUnits, errorMessage, isDistanceUnit, measurements, tagGroups, tagKey,
  type ExerciseChoice, type ExerciseDetails, type ExerciseNote, type Measurement, type TagGroup, type WeightUnit,
} from './model.ts';

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
  private readonly selectedTags = new Set<string>();

  constructor(
    app: App,
    private readonly exercises: ExerciseChoice[],
    private readonly choose: (exercise: ExerciseChoice) => void,
    private readonly create?: (name: string) => void,
  ) {
    super(app);
    this.setPlaceholder('Search exercises');
    this.limit = 50;
    this.addTagFilters();
  }

  private addTagFilters(): void {
    const tags = pickerTags(this.exercises);
    if (!tags.length) return;
    const filters = this.modalEl.createEl('details', { cls: 'rep-journal-tag-filters' });
    this.resultContainerEl.insertAdjacentElement('beforebegin', filters);
    const heading = filters.createEl('summary', { text: 'Filter by tags' });
    const checkboxes: HTMLInputElement[] = [];
    const refresh = (): void => {
      const count = this.selectedTags.size;
      heading.setText(count ? `Filter by tags (${count})` : 'Filter by tags');
      this.inputEl.trigger('input');
    };
    for (const [group, title] of Object.entries(tagGroups)) {
      const choices = tags.filter((tag) => tag.group === group);
      if (!choices.length) continue;
      const field = filters.createEl('fieldset', { cls: 'rep-journal-tag-group' });
      field.createEl('legend', { text: title });
      for (const tag of choices) {
        const key = tagKey(tag);
        const label = field.createEl('label');
        const input = label.createEl('input', { attr: { type: 'checkbox' } });
        checkboxes.push(input);
        label.createSpan({ text: tag.name });
        input.addEventListener('change', () => {
          if (input.checked) this.selectedTags.add(key);
          else this.selectedTags.delete(key);
          refresh();
        });
      }
    }
    actionButton(filters, 'Clear tag filters', () => {
      for (const input of checkboxes) input.checked = false;
      this.selectedTags.clear();
      refresh();
    });
  }

  getSuggestions(query: string): PickerEntry[] {
    const name = query.trim().slice(0, 120);
    const matches = this.exercises.filter((exercise) =>
      matchesExerciseName(exercise, name) && matchesTags(exercise, this.selectedTags));
    matches.sort((a, b) => Number(matchesExerciseName(b, name, true)) - Number(matchesExerciseName(a, name, true)));
    const entries: PickerEntry[] = matches.slice(0, this.limit - 1).map((exercise) => ({ kind: 'exercise', exercise }));
    if (this.create && (name || !this.selectedTags.size) &&
        !this.exercises.some((exercise) => matchesExerciseName(exercise, name, true))) {
      const newExercise: PickerEntry = { kind: 'create', name };
      if (name) entries.push(newExercise);
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
    const description = [entry.exercise.archived ? 'Archived' : '', entry.exercise.missingNote ? 'Exercise note missing' : '',
      ...entry.exercise.tags.map(({ name }) => name)].filter(Boolean).join(' · ');
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
    private readonly weightUnit: WeightUnit,
    private readonly original?: ExerciseNote,
  ) {
    super(app);
  }

  onOpen(): void {
    this.setTitle(this.original ? 'Edit exercise' : 'Create exercise');
    const form = this.contentEl.createEl('form');
    const fields = form.createEl('fieldset', { cls: 'rep-journal-fields' });
    let name = this.original?.name ?? this.initialName;
    let aliases = this.original?.aliases.join(', ') ?? '';
    const tracked = new Set<Measurement>(this.original?.measurements ?? ['weight', 'reps']);
    let distanceUnit = this.original?.distanceUnit ?? 'm';
    let archived = this.original?.archived ?? false;

    new Setting(fields).setName('Display name').addText((control) => {
      control.setValue(name).onChange((value) => { name = value; });
      control.inputEl.required = true;
      control.inputEl.maxLength = 120;
      control.inputEl.setAttribute('aria-label', 'Display name');
    });
    new Setting(fields).setName('Search aliases').setDesc('Separate names with commas. Previous display names remain searchable.').addText((control) => {
      control.setValue(aliases).onChange((value) => { aliases = value; });
      control.inputEl.setAttribute('aria-label', 'Search aliases');
    });
    const measureFields = fields.createEl('fieldset', { cls: 'rep-journal-tag-group' });
    measureFields.createEl('legend', { text: 'Measurements' });
    const distanceFields = fields.createDiv();
    for (const key of Object.keys(measurements) as Measurement[]) {
      const label = measureFields.createEl('label');
      const input = label.createEl('input', { attr: { type: 'checkbox' } });
      label.createSpan({ text: measurements[key] });
      input.checked = tracked.has(key);
      input.addEventListener('change', () => {
        if (input.checked) tracked.add(key);
        else tracked.delete(key);
        distanceFields.hidden = !tracked.has('distance');
      });
    }
    distanceFields.hidden = !tracked.has('distance');
    new Setting(distanceFields).setName('Distance unit').addDropdown((control) => {
      for (const unit of distanceUnits) control.addOption(unit, unit);
      control.setValue(distanceUnit).onChange((value) => { if (isDistanceUnit(value)) distanceUnit = value; });
      control.selectEl.setAttribute('aria-label', 'Distance unit');
    });
    const tags = fields.createEl('details', { cls: 'rep-journal-exercise-tags' });
    tags.createEl('summary', { text: 'Exercise tags' });
    const tagInputs = new Map<TagGroup, string>();
    for (const group of Object.keys(tagGroups) as TagGroup[]) {
      const title = tagGroups[group];
      const current = this.original?.tags.filter((tag) => tag.group === group).map(({ name }) => name).join(', ') ?? '';
      tagInputs.set(group, current);
      new Setting(tags).setName(title).addText((control) => {
        control.setValue(current).onChange((value) => { tagInputs.set(group, value); });
        control.inputEl.setAttribute('aria-label', title);
        control.setPlaceholder('Separate tags with commas');
      });
    }
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
      if (!tracked.size) {
        message.setText('Choose at least one measurement.');
        return;
      }
      submit.disabled = true;
      fields.disabled = true;
      const loadMode = this.original?.loadMode;
      const details: ExerciseDetails = {
        name: name.trim(), equipment: this.original?.equipment ?? '', aliases: commaSeparated(aliases),
        loadMode: loadMode === 'added' || loadMode === 'assistance' ? loadMode : tracked.has('weight') ? 'weight' : 'bodyweight',
        unit: this.original?.unit ?? this.weightUnit,
        archived, measurements: [...tracked], distanceUnit,
        tags: [...tagInputs].flatMap(([group, names]) => commaSeparated(names).map((tag) => ({ group, name: tag }))),
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

function commaSeparated(text: string): string[] {
  return text.split(',').map((part) => part.trim()).filter(Boolean);
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
