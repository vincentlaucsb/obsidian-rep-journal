import { Modal, Notice, type App } from 'obsidian';
import { exerciseHistory } from './analytics.ts';
import { type NoteDraft } from './drafts.ts';
import {
  compareWorkouts, describeSet, errorMessage, isDate, isLoadMode, isUnit, loadModes, makeId, validateSet,
  type ExerciseNote, type LedgerData, type LoadMode, type SetLoad, type WeightUnit, type Workout, type WorkoutChange,
  type WorkoutFile, type WorkoutSet,
} from './model.ts';
import { actionButton, addOption, labeledInput, labeledSelect } from './ui-controls.ts';

interface SetFields {
  load: SetLoad;
  reps: number;
  warmup: boolean;
}

export interface SetDraft {
  mode: LoadMode;
  unit: WeightUnit;
  weight: string;
  reps: string;
  warmup: boolean;
}

interface SetFormOptions {
  exercise?: ExerciseNote;
  submitText: string;
  onSave: (fields: SetFields) => Promise<void>;
  initial?: WorkoutSet;
  draft?: SetDraft;
  onDraft?: (draft: SetDraft) => void;
}

function setForm(parent: HTMLElement, options: SetFormOptions): (set: WorkoutSet) => void {
  const { exercise, initial, draft, onSave, onDraft, submitText } = options;
  const form = parent.createEl('form', { cls: 'rep-journal-set-form' });
  const fields = form.createDiv({ cls: 'rep-journal-form-grid' });
  const mode = labeledSelect(fields, 'Load type');
  for (const option of loadModes) addOption(mode, option.value, option.label);
  mode.value = exercise?.loadMode ?? 'weight';
  const unit = labeledSelect(fields, 'Unit');
  addOption(unit, 'lb', 'lb');
  addOption(unit, 'kg', 'kg');
  unit.value = exercise?.unit ?? 'lb';
  const weight = labeledInput(fields, 'Weight', { type: 'number', min: '0', step: 'any', inputmode: 'decimal' });
  const reps = labeledInput(fields, 'Reps', { type: 'number', min: '1', max: '1000', step: '1', inputmode: 'numeric', required: '' });
  const warmupLabel = form.createEl('label', { cls: 'rep-journal-check' });
  const warmup = warmupLabel.createEl('input', { attr: { type: 'checkbox' } });
  warmupLabel.createSpan({ text: 'Warm-up set' });
  const submit = form.createEl('button', { cls: 'mod-cta', text: submitText, attr: { type: 'submit' } });
  const status = form.createEl('p', { cls: 'rep-journal-status', attr: { role: 'status' } });

  const remember = (): void => {
    if (onDraft && isLoadMode(mode.value) && isUnit(unit.value)) {
      onDraft({ mode: mode.value, unit: unit.value, weight: weight.value, reps: reps.value, warmup: warmup.checked });
    }
  };

  const updateLoadField = (): void => {
    const weighted = mode.value !== 'bodyweight';
    if (weight.parentElement) weight.parentElement.hidden = !weighted;
    if (unit.parentElement) unit.parentElement.hidden = !weighted;
    weight.required = weighted;
    weight.disabled = !weighted;
    unit.disabled = !weighted;
  };
  const fillFrom = (set: WorkoutSet): void => {
    mode.value = set.load.mode;
    if (set.load.mode !== 'bodyweight') {
      weight.value = String(set.load.value);
      unit.value = set.load.unit;
    }
    reps.value = String(set.reps);
    warmup.checked = set.warmup;
    updateLoadField();
    remember();
  };

  if (initial) fillFrom(initial);
  if (draft) {
    mode.value = draft.mode;
    unit.value = draft.unit;
    weight.value = draft.weight;
    reps.value = draft.reps;
    warmup.checked = draft.warmup;
  }
  updateLoadField();
  mode.addEventListener('change', updateLoadField);
  form.addEventListener('input', remember);
  form.addEventListener('change', remember);
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (submit.disabled) return;
    const loadMode = mode.value;
    if (!isLoadMode(loadMode) || !isUnit(unit.value)) return;
    const load: SetLoad = loadMode === 'bodyweight'
      ? { mode: loadMode }
      : { mode: loadMode, value: weight.valueAsNumber, unit: unit.value };
    submit.disabled = true;
    status.setText('');
    void onSave({ load, reps: reps.valueAsNumber, warmup: warmup.checked }).then(() => {
      status.setText(initial ? 'Set updated.' : 'Set logged.');
      submit.disabled = false;
    }, (error: unknown) => {
      status.setText(errorMessage(error));
      submit.disabled = false;
    });
  });
  return fillFrom;
}

class EditSetDialog extends Modal {
  constructor(
    app: App,
    private readonly set: WorkoutSet,
    private readonly exercise: ExerciseNote | undefined,
    private readonly save: (change: WorkoutChange) => Promise<void>,
  ) {
    super(app);
  }

  onOpen(): void {
    this.setTitle('Edit set');
    this.contentEl.createEl('p', { text: this.exercise?.name ?? this.set.exerciseName });
    setForm(this.contentEl, {
      exercise: this.exercise, submitText: 'Save changes', initial: this.set,
      onSave: async (fields) => {
        await this.save({ kind: 'edit', original: this.set, set: validateSet({ ...this.set, ...fields }) });
        this.close();
      },
    });

    const message = this.contentEl.createEl('p', { cls: 'rep-journal-status', attr: { role: 'status' } });
    let confirm = false;
    const remove = actionButton(this.contentEl, 'Delete set', () => {
      if (!confirm) {
        confirm = true;
        remove.setText('Confirm delete');
        message.setText('Delete this set from the workout?');
        return;
      }
      remove.disabled = true;
      void this.save({ kind: 'remove', original: this.set }).then(() => this.close(), (error: unknown) => {
        message.setText(errorMessage(error));
        remove.disabled = false;
      });
    });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

interface WorkoutViewOptions {
  app: App;
  date: string;
  exercise?: ExerciseNote;
  session?: WorkoutFile;
  data: LedgerData;
  noteDraft?: NoteDraft;
  setDraft?: SetDraft;
  onNoteDraft: (workoutId: string | null, draft: NoteDraft) => void;
  onSetDraft: (draft: SetDraft) => void;
  onDate: (date: string) => void;
  onToday: () => void;
  onSession: (id: string | null) => void;
  chooseExercise: () => void;
  openModal: (modal: Modal) => void;
  persist: (change: WorkoutChange, original?: WorkoutFile) => Promise<WorkoutFile>;
}

export function renderWorkoutView(parent: HTMLElement, options: WorkoutViewOptions): void {
  const { app, data, date, exercise } = options;
  let session = options.session;
  let saving = false;
  const names = new Map(data.exercises.map((entry) => [entry.id, entry]));
  const daySessions = data.workouts.filter((entry) => entry.workout.date === date);
  const toolbar = parent.createDiv({ cls: 'rep-journal-form-grid rep-journal-workout-toolbar' });
  const dateInput = labeledInput(toolbar, 'Workout date', { type: 'date' });
  dateInput.value = date;
  dateInput.addEventListener('change', () => {
    if (isDate(dateInput.value)) options.onDate(dateInput.value);
    else dateInput.value = date;
  });
  const sessionSelect = labeledSelect(toolbar, 'Session');
  const today = actionButton(toolbar, 'Today', options.onToday);
  const updateSessionSelect = (): void => {
    sessionSelect.empty();
    for (const [index, entry] of daySessions.entries()) addOption(sessionSelect, entry.workout.id, `Workout ${index + 1}`);
    addOption(sessionSelect, '', 'New workout');
    sessionSelect.value = session?.workout.id ?? '';
  };
  updateSessionSelect();
  sessionSelect.addEventListener('change', () => options.onSession(sessionSelect.value || null));

  const layout = parent.createDiv({ cls: 'rep-journal-workout-layout' });
  const logger = layout.createDiv({ cls: 'rep-journal-panel' });
  const review = layout.createDiv({ cls: 'rep-journal-panel' });
  const selectExercise = actionButton(logger, exercise?.name ?? 'Choose exercise', options.chooseExercise, !exercise);
  selectExercise.setAttribute('aria-label', exercise ? `Change exercise, ${exercise.name} selected` : 'Choose exercise');
  if (!exercise) logger.createEl('p', { cls: 'rep-journal-muted', text: 'Choose or create an exercise to log a set.' });
  const previous = logger.createDiv({ cls: 'rep-journal-previous' });
  const sets = review.createDiv();
  review.createEl('h3', { text: 'Workout note' });
  const notes = review.createEl('textarea', { attr: { rows: '3', 'aria-label': 'Workout note' } });
  let originalNotes = options.noteDraft?.original ?? session?.workout.notes ?? '';
  notes.value = options.noteDraft?.value ?? originalNotes;
  const noteStatus = review.createEl('p', { cls: 'rep-journal-status', attr: { role: 'status' } });
  const saveNote = actionButton(review, 'Save note', () => {
    const value = notes.value;
    noteStatus.setText('');
    notes.disabled = true;
    saveNote.disabled = true;
    void persist({ kind: 'notes', original: originalNotes, value }).then(() => {
      originalNotes = value;
      rememberNote();
      noteStatus.setText('Workout note saved.');
    }, (error: unknown) => noteStatus.setText(errorMessage(error))).finally(() => {
      notes.disabled = false;
      saveNote.disabled = notes.value === originalNotes;
      updateSavedNoteButton();
    });
  });
  const useSavedNote = actionButton(review, 'Use saved note', () => {
    originalNotes = session?.workout.notes ?? '';
    notes.value = originalNotes;
    rememberNote();
    noteStatus.setText('');
  });
  const updateSavedNoteButton = (): void => { useSavedNote.hidden = originalNotes === (session?.workout.notes ?? ''); };
  const rememberNote = (): void => {
    options.onNoteDraft(session?.workout.id ?? null, { original: originalNotes, value: notes.value });
    saveNote.disabled = notes.value === originalNotes;
    updateSavedNoteButton();
  };
  saveNote.disabled = notes.value === originalNotes;
  updateSavedNoteButton();
  notes.addEventListener('input', rememberNote);

  let fillFrom: ((set: WorkoutSet) => void) | undefined;

  function drawPrevious(): void {
    previous.empty();
    if (!exercise) return;
    const earlier = data.workouts.map(({ workout }) => workout).filter((workout) => isEarlier(workout));
    const last = exerciseHistory(earlier, exercise.id)[0];
    if (!last) return;
    previous.createEl('h3', { text: 'Last session' });
    previous.createEl('p', { text: last.workout.date, cls: 'rep-journal-muted' });
    const list = previous.createEl('ul');
    for (const set of last.sets) list.createEl('li', { text: `${describeSet(set)}${set.warmup ? ' · warm-up' : ''}` });
    const reusable = [...last.sets].reverse().find((set) => !set.warmup) ?? last.sets[last.sets.length - 1];
    actionButton(previous, 'Use last set', () => fillFrom?.(reusable));
  }

  function isEarlier(candidate: Workout): boolean {
    return session ? compareWorkouts(candidate, session.workout) < 0 : candidate.date <= date;
  }

  function drawSets(): void {
    sets.empty();
    sets.createEl('h3', { text: 'Logged sets' });
    const entries = session?.workout.sets ?? [];
    if (!entries.length) {
      sets.createEl('p', { text: 'No sets logged for this workout.', cls: 'rep-journal-muted' });
      return;
    }
    const list = sets.createEl('ol', { cls: 'rep-journal-set-list' });
    for (const set of entries) {
      const item = list.createEl('li');
      const entry = names.get(set.exerciseId);
      const name = entry?.name ?? set.exerciseName;
      const button = actionButton(item, name, () => {
        if (!saving) options.openModal(new EditSetDialog(app, set, entry, async (change) => { await persist(change); }));
      });
      button.addClass('rep-journal-set-row');
      button.createSpan({ text: `${describeSet(set)}${set.warmup ? ' · warm-up' : ''}`, cls: 'rep-journal-muted' });
    }
  }

  async function persist(change: WorkoutChange): Promise<void> {
    if (saving) throw new Error('Wait for the current change to save.');
    saving = true;
    dateInput.disabled = true;
    today.disabled = true;
    sessionSelect.disabled = true;
    selectExercise.disabled = true;
    try {
      session = await options.persist(change, session);
      if (!daySessions.some((entry) => entry.workout.id === session?.workout.id)) daySessions.push(session);
      if (change.kind !== 'notes' && notes.value === originalNotes) {
        originalNotes = session.workout.notes;
        notes.value = originalNotes;
      }
      updateSavedNoteButton();
      updateSessionSelect();
      drawSets();
      if (change.kind === 'remove') new Notice('Set deleted.');
    } finally {
      saving = false;
      dateInput.disabled = false;
      today.disabled = false;
      sessionSelect.disabled = false;
      selectExercise.disabled = false;
    }
  }

  drawPrevious();
  if (exercise) {
    fillFrom = setForm(logger, {
      exercise, submitText: 'Log set', draft: options.setDraft, onDraft: options.onSetDraft,
      onSave: async (fields) => {
        const set = validateSet({ id: makeId(), exerciseId: exercise.id, exerciseName: exercise.name, ...fields });
        await persist({ kind: 'add', set });
      },
    });
  }
  drawSets();
}
