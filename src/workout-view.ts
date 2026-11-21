import { Modal, Notice, type App } from 'obsidian';
import { convertDistance, convertWeight, exerciseHistory } from './analytics.ts';
import { type NoteDraft } from './drafts.ts';
import {
  compareWorkouts, describeSet, errorMessage, formatDuration, isDate, makeId, parseDuration, setMeasurements, validateSet,
  type DistanceUnit, type ExerciseNote, type LedgerData, type Measurement, type SetLoad, type WeightUnit, type Workout,
  type WorkoutChange, type WorkoutFile, type WorkoutSet,
} from './model.ts';
import { actionButton, addOption, labeledInput, labeledSelect } from './ui-controls.ts';

type SetFields = Pick<WorkoutSet, 'reps' | 'load' | 'durationSeconds' | 'distance'>;

export interface SetDraft {
  values: Partial<Record<Measurement, string>>;
  weightUnit: WeightUnit;
  distanceUnit: DistanceUnit;
}

interface SetFormOptions {
  exercise?: ExerciseNote;
  weightUnit: WeightUnit;
  submitText: string;
  onSave: (fields: SetFields) => Promise<void>;
  initial?: WorkoutSet;
  draft?: SetDraft;
  onDraft?: (draft: SetDraft) => void;
}

function setForm(parent: HTMLElement, options: SetFormOptions): (set: WorkoutSet) => void {
  const { exercise, initial, draft, onSave, onDraft, submitText } = options;
  const tracked = initial ? setMeasurements(initial) : (exercise?.measurements ?? []);
  const loadMode = initial?.load?.mode ?? exercise?.loadMode ?? 'weight';
  const weightMode = loadMode === 'bodyweight' ? 'weight' : loadMode;
  const weightUnit = initial?.load && initial.load.mode !== 'bodyweight' ? initial.load.unit : options.weightUnit;
  const distanceUnit = initial?.distance?.unit ?? exercise?.distanceUnit ?? 'm';
  const form = parent.createEl('form', { cls: 'rep-journal-set-form' });
  const fields = form.createDiv({ cls: 'rep-journal-form-grid' });
  const weightName = weightMode === 'assistance' ? 'Assistance' : weightMode === 'added' ? 'Added weight' : 'Weight';
  const weight = tracked.includes('weight') ? labeledInput(fields, `${weightName} (${weightUnit})`, {
    type: 'number', min: '0', max: '100000', step: 'any', inputmode: 'decimal', required: '',
  }) : undefined;
  const reps = tracked.includes('reps') ? labeledInput(fields, 'Reps', {
    type: 'number', min: '1', max: '1000', step: '1', inputmode: 'numeric', required: '',
  }) : undefined;
  const time = tracked.includes('time') ? labeledInput(fields, 'Time', {
    type: 'text', placeholder: 'mm:ss', 'aria-label': 'Time (mm:ss or seconds)', required: '',
  }) : undefined;
  const distance = tracked.includes('distance') ? labeledInput(fields, `Distance (${distanceUnit})`, {
    type: 'number', min: '0', step: 'any', inputmode: 'decimal', required: '',
  }) : undefined;
  const submit = form.createEl('button', { cls: 'mod-cta', text: submitText, attr: { type: 'submit' } });
  const status = form.createEl('p', { cls: 'rep-journal-status', attr: { role: 'status' } });

  const remember = (): void => {
    onDraft?.({
      values: { weight: weight?.value, reps: reps?.value, time: time?.value, distance: distance?.value },
      weightUnit, distanceUnit,
    });
  };

  const fillFrom = (set: WorkoutSet): void => {
    if (weight && set.load?.mode === weightMode) {
      const value = convertWeight(set.load.value, set.load.unit, weightUnit);
      weight.value = numberForInput(value, set.load.unit === weightUnit);
    }
    if (reps && set.reps !== undefined) reps.value = String(set.reps);
    if (time && set.durationSeconds !== undefined) time.value = formatDuration(set.durationSeconds);
    if (distance && set.distance) {
      const value = convertDistance(set.distance.value, set.distance.unit, distanceUnit);
      distance.value = numberForInput(value, set.distance.unit === distanceUnit);
    }
    remember();
  };

  if (initial) fillFrom(initial);
  if (draft) {
    const values = draft.values;
    if (weight && values.weight) {
      weight.value = numberForInput(convertWeight(Number(values.weight), draft.weightUnit, weightUnit), draft.weightUnit === weightUnit);
    }
    if (reps) reps.value = values.reps ?? '';
    if (time) time.value = values.time ?? '';
    if (distance && values.distance) {
      distance.value = numberForInput(
        convertDistance(Number(values.distance), draft.distanceUnit, distanceUnit), draft.distanceUnit === distanceUnit,
      );
    }
  }
  form.addEventListener('input', remember);
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (submit.disabled) return;
    const values: SetFields = {};
    const load: SetLoad | undefined = weight ? { mode: weightMode, value: weight.valueAsNumber, unit: weightUnit }
      : initial ? initial.load : tracked.length === 1 && reps ? { mode: 'bodyweight' } : undefined;
    if (load) values.load = load;
    if (reps) values.reps = reps.valueAsNumber;
    if (time) values.durationSeconds = parseDuration(time.value);
    if (distance) values.distance = { value: distance.valueAsNumber, unit: distanceUnit };
    submit.disabled = true;
    status.setText('');
    void onSave(values).then(() => {
      status.setText(initial ? 'Set updated.' : 'Set logged.');
      submit.disabled = false;
    }, (error: unknown) => {
      status.setText(errorMessage(error));
      submit.disabled = false;
    });
  });
  return fillFrom;
}

function numberForInput(value: number, unchangedUnit: boolean): string {
  return String(unchangedUnit ? value : Number(value.toPrecision(12)));
}

async function openExerciseNote(app: App, exercise: ExerciseNote): Promise<void> {
  try {
    const file = app.vault.getFileByPath(exercise.path);
    if (!file) {
      new Notice('The exercise note moved or was deleted. Refresh the workout view and try again.');
      return;
    }
    await app.workspace.getLeaf('tab').openFile(file, { active: true });
  } catch (error: unknown) {
    new Notice(`Could not open the exercise note. ${errorMessage(error)}`);
  }
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
      exercise: this.exercise, weightUnit: 'lb', submitText: 'Save changes', initial: this.set,
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
  weightUnit: WeightUnit;
  noteDraft?: NoteDraft;
  setDraft?: SetDraft;
  onNoteDraft: (workoutId: string | null, draft: NoteDraft) => void;
  onSetDraft: (draft: SetDraft) => void;
  onDate: (date: string) => void;
  onToday: () => void;
  onSession: (id: string | null) => void;
  chooseExercise: () => void;
  choosePlan?: () => void;
  openModal: (modal: Modal) => void;
  persist: (change: WorkoutChange, original?: WorkoutFile) => Promise<WorkoutFile>;
  onPersisted: (change: WorkoutChange) => void;
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
  if (options.choosePlan) actionButton(toolbar, 'Start plan', options.choosePlan);
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
  const exerciseActions = logger.createDiv({ cls: 'rep-journal-actions' });
  const selectExercise = actionButton(exerciseActions, exercise?.name ?? 'Choose exercise', options.chooseExercise, !exercise);
  selectExercise.setAttribute('aria-label', exercise ? `Change exercise, ${exercise.name} selected` : 'Choose exercise');
  if (exercise) {
    const openNote = actionButton(exerciseActions, 'Open note', () => { void openExerciseNote(app, exercise); });
    openNote.setAttribute('aria-label', `Open note for ${exercise.name} in a new tab`);
    openNote.title = 'Open exercise note in a new tab';
  }
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
    for (const set of last.sets) list.createEl('li', { text: describeSet(set) });
    const reusable = last.sets[last.sets.length - 1];
    const reusableMeasurements = setMeasurements(reusable);
    if (exercise.measurements.some((measurement) => reusableMeasurements.includes(measurement))) {
      actionButton(previous, 'Use last set', () => fillFrom?.(reusable));
    }
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
      button.createSpan({ text: describeSet(set), cls: 'rep-journal-muted' });
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
    options.onPersisted(change);
  }

  drawPrevious();
  if (exercise) {
    fillFrom = setForm(logger, {
      exercise, weightUnit: options.weightUnit, submitText: 'Log set', draft: options.setDraft, onDraft: options.onSetDraft,
      onSave: async (fields) => {
        const set = validateSet({ id: makeId(), exerciseId: exercise.id, exerciseName: exercise.name, warmup: false, ...fields });
        await persist({ kind: 'add', set });
      },
    });
  }
  drawSets();
}
