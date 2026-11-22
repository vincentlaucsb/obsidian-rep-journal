import type { LineChartOptions } from 'svgplot-wasm';
import type { DistanceUnit, ExerciseChoice, ExerciseNote, ExerciseTag, LedgerData, LoadMode, Measurement, TagGroup,
  WeightUnit, Workout, WorkoutFile, WorkoutSet } from '../src/model.ts';
import type { ContextOptions, ExportFormat } from '../src/exports.ts';
import type { exerciseProgress, ExerciseEditInput, LogSetInput, PlanNote, WorkoutEditInput } from '../src/journal-workflow.ts';
import type { parseWorkoutPlan, PlanExercise, PlanSection, WorkoutPlan } from '../src/workout-plan.ts';
import { WorkoutNoteDrafts } from './drafts.js';
import { lucideIcon } from './icons.js';
import { mountStrengthChart } from './strength-chart.js';
import { convertDistance, convertWeight } from './units.js';

export interface JournalAdapter {
  loadJournal(): Promise<LedgerData & { starters: ExerciseChoice[]; today: string; unit: WeightUnit; vaultKey: string }>;
  enablePopover(): Promise<void>;
  listPlans(): Promise<PlanNote[]>;
  readPlan(path: string): Promise<ReturnType<typeof parseWorkoutPlan>>;
  makeSetId(): string;
  saveSet(input: LogSetInput, unit: WeightUnit): Promise<WorkoutFile>;
  editWorkout(input: WorkoutEditInput): Promise<WorkoutFile>;
  saveExercise(input: ExerciseEditInput, unit: WeightUnit): Promise<ExerciseNote>;
  addStarter(id: string): Promise<ExerciseNote>;
  readProgress(exerciseId: string | null): Promise<ReturnType<typeof exerciseProgress>>;
  drawStrengthChart?(host: HTMLElement, options: LineChartOptions): Promise<SVGSVGElement>;
  saveExport(format: ExportFormat): Promise<string>;
  refreshAutomaticCsv(): Promise<void>;
  readAutomaticCsvError?(): Promise<string | undefined>;
  prepareContext(options: ContextOptions): Promise<string>;
  openExerciseNote?(exercise: ExerciseNote): void;
}

export interface MountedJournal {
  ready: Promise<void>;
  showToday(): Promise<void>;
  openProgress(exerciseId?: string): Promise<void>;
  openExport(): Promise<void>;
  openPlan(file: PlanNote, start?: boolean): Promise<void>;
  reload(force?: boolean): Promise<void>;
  setWeightUnit(unit: WeightUnit): void;
  dispose(): void;
}

export type CreateJournalElement = <Tag extends keyof HTMLElementTagNameMap>(tag: Tag) => HTMLElementTagNameMap[Tag];

type Screen = 'log' | 'calendar' | 'plans' | 'plan' | 'entry' | 'edit-set' | 'exercises' | 'edit-exercise' | 'progress' | 'export';
type EditorOrigin = 'exercises' | 'progress' | 'entry';
type JournalData = Awaited<ReturnType<JournalAdapter['loadJournal']>>;
type ProgressReport = Awaited<ReturnType<JournalAdapter['readProgress']>>;
type SetInputs = LogSetInput['values'];
type ExistingWorkoutChange = Extract<WorkoutEditInput, { workoutId: string }>['change'];
type Attributes = Record<string, string | number | undefined>;
type Action = () => void | Promise<void>;
type PlanPosition = PlanNote & { section: number; exercise: number };
type ActivePlan = PlanPosition & { plan: WorkoutPlan };
type ReviewedPlan = PlanNote & { result?: ReturnType<typeof parseWorkoutPlan>; error?: string };
type Picker = { search: string; tags: Set<string> };
type Suggestion = { rank: number; label: string; status: 'next' | 'planned' };

interface Entry {
  exerciseId?: string;
  setId: string;
  planned: boolean;
  unit: WeightUnit;
  date: string;
  selectedDate: boolean;
  workoutId: string | null;
  picker: Picker;
}

interface ContextDraft extends Omit<ContextOptions, 'daysPerWeek'> {
  days: string;
  text: string;
  status: string;
  error: boolean;
  version: number;
  pending?: boolean;
}

interface JournalState {
  journal: JournalData | null;
  date: string | null;
  selected: string | null;
  newSession: boolean;
  screen: Screen;
  active: ActivePlan | null;
  review: ReviewedPlan | null;
  saving: boolean;
  calendarMonth: Date;
  calendarDay: string | null;
  context?: ContextDraft;
  plans?: PlanNote[];
  planError?: string;
  entry?: Entry;
  setEditor?: { session: Workout; set: WorkoutSet; name: string };
  exerciseEditor?: { exercise: ExerciseNote | null; id: string; unit: WeightUnit; from: EditorOrigin; initialName: string };
  exerciseSearch?: string;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error('The journal view is not ready.');
  return value;
}

function findLast<T>(values: readonly T[], matches: (value: T) => boolean): T | undefined {
  for (let index = values.length - 1; index >= 0; index--) {
    const value = values[index];
    if (matches(value)) return value;
  }
}

function isSavedPlan(value: unknown): value is PlanPosition & { signature: string } {
  return !!value && typeof value === 'object' &&
    'path' in value && typeof value.path === 'string' &&
    'title' in value && typeof value.title === 'string' &&
    'section' in value && typeof value.section === 'number' && Number.isInteger(value.section) &&
    'exercise' in value && typeof value.exercise === 'number' && Number.isInteger(value.exercise) &&
    'signature' in value && typeof value.signature === 'string';
}

function inputFor(form: HTMLFormElement, measurement: Measurement): HTMLInputElement {
  const control = form.querySelector<HTMLInputElement>(`input[name="${measurement}"]`);
  if (!control) throw new Error(`Missing measurement field: ${measurement}`);
  return control;
}

export function mountJournal(root: HTMLElement, adapter: JournalAdapter, createElement: CreateJournalElement): MountedJournal {
  const document = root.ownerDocument;
  const hostWindow = required(document.defaultView);
  const standalone = root.classList.contains('rep-journal-standalone');
  let mounted = true;
  let refreshVersion = 0;
  let progressVersion = 0;
  let disposeStrengthChart: (() => void) | undefined;
  root.classList.add('rep-journal-modern');
  const state: JournalState = {
    journal: null, date: null, selected: null, newSession: false, screen: 'log', active: null, review: null, saving: false,
    calendarMonth: new Date(), calendarDay: null,
  };
  const journalData = () => required(state.journal);
  const drawStrengthChart = adapter.drawStrengthChart?.bind(adapter);
  const progress: Picker & { report: ProgressReport | null; exerciseId: string | null; workout: Workout | null; error: string } =
    { report: null, exerciseId: null, workout: null, search: '', tags: new Set(), error: '' };
  const fileExport = { pending: false, error: false, status: '', automaticError: '' };
  const noteDrafts = new WorkoutNoteDrafts();
  const measurementNames: Record<Measurement, string> = { weight: 'Weight', reps: 'Reps', time: 'Time (seconds or mm:ss)', distance: 'Distance' };
  const exerciseTagGroups: Record<TagGroup, string> = { region: 'Body region', role: 'Training role', muscles: 'Muscle group',
    activity: 'Activity type', movement: 'Movement pattern', custom: 'Ungrouped' };
  const fullDate = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' });
  const shortDate = new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
  const monthTitle = new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' });
  const asDate = (value: string) => new Date(`${value}T00:00:00Z`);
  const normalized = (value: string) => value.trim().replace(/\s+/g, ' ').toLowerCase();
  const tagKey = ({ group, name }: ExerciseTag) => `${group}/${normalized(name)}`;

  function el<Tag extends keyof HTMLElementTagNameMap>(
    tag: Tag, options: Attributes = {}, ...children: Array<Node | string | undefined>
  ): HTMLElementTagNameMap[Tag] {
    const element = createElement(tag);
    for (const [name, value] of Object.entries(options)) {
      if (value !== undefined) element.setAttribute(name, String(value));
    }
    element.append(...children.filter((child) => child !== undefined));
    return element;
  }

  function button(
    label: Node | string, action: Action, options: { className?: string; label?: string; title?: string; disabled?: boolean } = {},
  ): HTMLButtonElement {
    const control = el('button', { type: 'button', class: options.className, 'aria-label': options.label, title: options.title }, label);
    control.disabled = Boolean(options.disabled);
    control.addEventListener('click', () => { if (!state.saving) void action(); });
    return control;
  }

  const overflowId = `rj-navigation-${adapter.makeSetId()}`;
  const calendar = button(lucideIcon(document, 'calendar'), () => navigate(openCalendar), { className: 'nav-icon', label: 'Calendar', title: 'Calendar' });
  const exercises = button(lucideIcon(document, 'dumbbell'), () => navigate(() => view('exercises')),
    { className: 'nav-icon', label: 'Exercises', title: 'Exercises' });
  const overflowToggle = el('button', {
    type: 'button', class: 'nav-icon', 'aria-label': 'Menu', title: 'Menu',
    'aria-expanded': 'false', 'aria-controls': overflowId, popovertarget: overflowId,
  }, lucideIcon(document, 'menu'));
  const menuActions: Array<[Screen[], string, Action]> = [
    [['plans', 'plan'], 'Plans', openPlans],
    [['progress'], 'Progress', () => openProgress(progress.exerciseId, null)],
    [['export'], 'Export', () => view('export')],
  ];
  const menuItems = menuActions.map(([screens, label, action]) => ({
    screens, control: button(label, () => navigate(action)),
  }));
  const overflow = el('div', { id: overflowId, class: 'nav-overflow', popover: 'auto' }, ...menuItems.map(({ control }) => control));
  const navigation = el('nav', { 'aria-label': 'Rep Journal', hidden: '' }, calendar, exercises, overflowToggle, overflow);
  const home = button('Rep Journal', () => { if (state.journal) navigate(goToday); },
    { className: 'wordmark', label: 'Rep Journal, Today', title: 'Today' });
  const header = el('div', { class: 'masthead-content' }, home, navigation);
  const app = el('main', { class: 'rj-workspace', id: standalone ? 'app' : undefined, 'aria-busy': 'true' },
    el('p', { role: 'status' }, 'Loading workouts…'));
  root.replaceChildren(el('header', { class: 'masthead' }, header), app);

  function navigate(action: Action) {
    overflow.hidePopover?.();
    void action();
    root.scrollIntoView({ block: 'start' });
  }

  function positionOverflow() {
    const { bottom, left, right } = overflowToggle.getBoundingClientRect();
    const rtl = hostWindow.getComputedStyle(overflowToggle).direction === 'rtl';
    overflow.style.setProperty('--menu-top', `${bottom + 6}px`);
    overflow.style.setProperty('--menu-inset', `${rtl ? left : document.documentElement.clientWidth - right}px`);
    overflow.style.setProperty('--menu-space', `${header.clientWidth}px`);
  }

  overflow.addEventListener('beforetoggle', (event) => {
    if (event.newState === 'open') positionOverflow();
  });
  overflow.addEventListener('toggle', (event) => {
    overflowToggle.setAttribute('aria-expanded', String(event.newState === 'open'));
  });
  const menuResize = new hostWindow.ResizeObserver(() => {
    if (overflowToggle.getAttribute('aria-expanded') === 'true') positionOverflow();
  });
  menuResize.observe(header);
  if (typeof overflow.hidePopover !== 'function') {
    overflowToggle.disabled = true;
    void adapter.enablePopover().then(() => {
      overflowToggle.disabled = typeof overflow.hidePopover !== 'function';
    }).catch(() => { overflowToggle.title = 'Menu unavailable'; });
  }

  function notes(value?: string) {
    return value ? el('p', { class: 'notes' }, value) : undefined;
  }

  function workouts(): Workout[] {
    return journalData().workouts.map(({ workout }) => workout);
  }

  function workoutDate() {
    return state.date ?? journalData().today;
  }

  function selectedWorkout() {
    const sessions = workouts();
    if (state.newSession) return;
    const day = workoutDate();
    return sessions.find(({ id, date }) => id === state.selected && date === day) ?? findLast(sessions, ({ date }) => date === day);
  }

  function view(screen: Screen) {
    if (state.screen !== screen) overflow.hidePopover?.();
    state.screen = screen;
    render();
  }

  function goToday() {
    goDate(journalData().today);
  }

  function goDate(date: string) {
    state.date = date === journalData().today ? null : date;
    state.selected = null;
    state.newSession = false;
    view('log');
  }

  function goSession(workout?: Workout) {
    if (workout) {
      state.date = workout.date === journalData().today ? null : workout.date;
      state.selected = workout.id;
      state.newSession = false;
      view('log');
    } else goToday();
  }

  function render() {
    disposeStrengthChart?.();
    disposeStrengthChart = undefined;
    if (!mounted) return;
    app.replaceChildren();
    app.setAttribute('aria-busy', 'false');
    if (!state.journal) return;

    navigation.hidden = false;
    const currentMenuItem = menuItems.find(({ screens }) => screens.includes(state.screen));
    const currentControls: Array<[HTMLButtonElement, boolean]> = [
      [home, state.screen === 'log' && !state.date],
      [calendar, state.screen === 'calendar'],
      [exercises, state.screen === 'exercises' || state.screen === 'edit-exercise'],
      ...menuItems.map(({ control }): [HTMLButtonElement, boolean] => [control, control === currentMenuItem?.control]),
    ];
    for (const [control, current] of currentControls) {
      if (current) control.setAttribute('aria-current', 'page');
      else control.removeAttribute('aria-current');
    }
    overflowToggle.toggleAttribute('data-current', Boolean(currentMenuItem));
    if (state.screen === 'log') app.append(renderLog());
    if (state.screen === 'calendar') app.append(renderCalendar());
    if (state.screen === 'plans') app.append(renderPlans());
    if (state.screen === 'plan') app.append(renderPlan());
    if (state.screen === 'entry') app.append(renderEntry());
    if (state.screen === 'edit-set') app.append(renderSetEditor());
    if (state.screen === 'exercises') app.append(renderExercises());
    if (state.screen === 'edit-exercise') app.append(renderExerciseEditor());
    if (state.screen === 'progress') {
      const page = renderProgress();
      app.append(page);
      const chart = page.querySelector<HTMLElement>('.strength-chart');
      if (chart && drawStrengthChart && progress.report) {
        const { trend, unit } = progress.report;
        disposeStrengthChart = mountStrengthChart(chart, trend, unit, journalData().today, drawStrengthChart, createElement);
      }
    }
    if (state.screen === 'export') app.append(renderExport());
  }

  function renderLog() {
    const session = selectedWorkout();
    const { today, issues } = journalData();
    const day = workoutDate();
    const isToday = day === today;
    const ordered = workouts();
    const later = ordered.findIndex(({ date }) => date > day);
    const index = session ? ordered.findIndex(({ id }) => id === session.id) : later < 0 ? ordered.length : later;
    const previous = ordered[index - 1];
    const next = ordered[index + Number(Boolean(session))];
    const header = el('div', { class: 'session-header' },
      button('←', () => goSession(previous), { className: 'arrow', label: 'Previous workout', disabled: !previous }),
      el('div', { class: 'session-title', 'aria-live': 'polite' },
        el('h1', {}, isToday ? 'Today' : shortDate.format(asDate(day))),
        el('p', { class: 'secondary' }, !isToday && session ? sessionLabel(session) : fullDate.format(asDate(day)))),
      button('→', () => goSession(next), { className: 'arrow', label: 'Next workout', disabled: !next && day >= today }));
    const panel = el('section', { class: 'log-screen' }, header);
    const sessions = ordered.filter(({ date }) => date === day);
    const actions = el('div', { class: 'log-actions' });
    if (sessions.length) {
      const select = el('select', { 'aria-label': isToday ? "Today's session" : 'Workout session' });
      for (const workout of sessions) select.append(el('option', { value: workout.id }, sessionLabel(workout)));
      select.append(el('option', { value: '' }, 'New workout'));
      select.value = session?.id ?? '';
      select.addEventListener('change', () => {
        if (state.saving) {
          select.value = session?.id ?? '';
          return;
        }
        state.selected = select.value || null;
        state.newSession = !select.value;
        render();
      });
      actions.append(select);
    }
    actions.append(button('+ Log set', () => openEntry(false), { className: 'primary', disabled: Boolean(issues.length) }));
    if (!sessions.some((workout) => workout.sets.length)) {
      actions.append(button('Follow a plan', () => state.active ? showActivePlan() : openPlans()));
    }
    panel.append(actions);
    if (issues.length) {
      const details = el('details', { class: 'warning' }, el('summary', {}, `${issues.length} vault ${issues.length === 1 ? 'issue' : 'issues'}`));
      details.append(el('ul', {}, ...issues.map((issue) => el('li', {}, issue))));
      panel.append(details);
    }

    const exercises = new Map(journalData().exercises.map((exercise) => [exercise.id, exercise]));
    const grouped = new Map<string, WorkoutSet[]>();
    for (const set of session?.sets ?? []) {
      const sets = grouped.get(set.exerciseId) ?? [];
      sets.push(set);
      grouped.set(set.exerciseId, sets);
    }
    const log = el('div', { class: 'log-groups', 'aria-live': 'polite' });
    if (!grouped.size) log.append(el('p', { class: 'empty' }, 'No sets logged for this session.'));
    for (const [id, sets] of grouped) {
      const exercise = exercises.get(id);
      const name = exercise?.name ?? sets[0].exerciseName;
      const progressLabel = `View progress for ${name}`;
      const logLabel = `Log another set for ${name}`;
      const logUnavailable = !exercise ? 'The exercise note is missing.' : exercise.archived ? 'The exercise is archived.'
        : issues.length ? 'Resolve vault issues before logging a set.' : undefined;
      const controls = el('div', { class: 'exercise-card-actions' },
        button(lucideIcon(document, 'chart-line'), () => openProgress(id, session), {
          className: 'exercise-card-action', label: progressLabel, title: progressLabel,
        }),
        button(lucideIcon(document, 'plus'), () => openEntry(false, id), {
          className: 'exercise-card-action', label: logLabel, title: logUnavailable ?? logLabel, disabled: Boolean(logUnavailable),
        }));
      const rows = sets.map((set, index) => el('li', { class: 'set-row' },
        el('span', { class: 'set-measurements' }, ...setValues(set).map((value) => el('span', {}, value))),
        button('Edit set', () => {
          if (!session) return;
          state.setEditor = { session, set, name };
          view('edit-set');
        }, { className: 'text-button', label: `Edit set ${index + 1} for ${name}` })));
      log.append(el('section', { class: 'exercise-card' },
        el('header', { class: 'exercise-card-header' }, el('h2', {}, name), controls), el('ol', {}, ...rows)));
    }
    panel.append(log);
    panel.append(renderWorkoutNotes(session, day));
    if (isToday && state.active) panel.append(renderBanner());
    return panel;
  }

  function setValues(set: WorkoutSet) {
    const values = [];
    if (set.load && set.load.mode !== 'bodyweight') {
      const suffix = set.load.mode === 'assistance' ? ' assistance' : '';
      values.push(`${set.load.mode === 'added' ? '+' : ''}${set.load.value} ${set.load.unit}${suffix}`);
    }
    if (set.reps !== undefined) values.push(`${set.reps} ${set.reps === 1 ? 'rep' : 'reps'}`);
    if (set.durationSeconds !== undefined) {
      const minutes = Math.floor(set.durationSeconds / 60);
      values.push(minutes ? `${minutes}:${String(set.durationSeconds % 60).padStart(2, '0')} min` : `${set.durationSeconds} sec`);
    }
    if (set.distance) values.push(`${set.distance.value} ${set.distance.unit}`);
    return values;
  }

  function recordWorkout(saved: WorkoutFile) {
    const list = journalData().workouts.filter(({ workout }) => workout.id !== saved.workout.id);
    list.push(saved);
    list.sort((a, b) => a.workout.date.localeCompare(b.workout.date) || a.workout.createdAt.localeCompare(b.workout.createdAt) || a.workout.id.localeCompare(b.workout.id));
    journalData().workouts = list;
  }

  async function saveChange<T>(
    submit: HTMLButtonElement, error: HTMLElement, apply: () => Promise<T>, saved: (value: T) => void,
  ): Promise<void> {
    const form = submit.closest('form');
    if (!form || state.saving) return;
    state.saving = true;
    type FormControl = HTMLButtonElement | HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | HTMLFieldSetElement;
    const controls = [...form.querySelectorAll<FormControl>('button, input, select, textarea, fieldset')].filter(control => !control.disabled);
    const label = [...submit.childNodes];
    for (const control of controls) control.disabled = true;
    submit.textContent = 'Saving…';
    error.hidden = true;
    try {
      const result = await apply();
      if (mounted) saved(result);
    } catch (failure) {
      error.textContent = message(failure);
      error.hidden = false;
      if (mounted) error.scrollIntoView({ block: 'nearest' });
    } finally {
      state.saving = false;
      submit.replaceChildren(...label);
      for (const control of controls) control.disabled = false;
    }
  }

  function renderWorkoutNotes(session: Workout | undefined, date: string) {
    const workoutId = session?.id ?? null;
    const draft = noteDrafts.get(date, workoutId);
    const original = draft?.original ?? session?.notes ?? '';
    const originalValue = original.replace(/\r\n?/g, '\n');
    const field = el('textarea', { name: 'notes', rows: 3 });
    field.value = draft?.value ?? original;
    const details = el('details', { class: 'session-notes', open: session?.notes || draft ? '' : undefined }, el('summary', {}, 'Workout notes'));
    const submit = el('button', { type: 'submit', class: 'primary' }, 'Save notes');
    const error = el('p', { role: 'alert', class: 'warning', hidden: '' });
    const restore = button('Use saved notes', () => {
      noteDrafts.clear(date, workoutId);
      render();
      app.querySelector<HTMLTextAreaElement>('.session-notes textarea')?.focus();
    });
    restore.hidden = !draft || original === (session?.notes ?? '');
    const form = el('form', { class: 'entry-form' }, el('label', {}, 'Notes', field), error, el('div', { class: 'plan-controls' }, submit, restore));
    const update = () => {
      submit.disabled = field.value === originalValue || (!session && !field.value.trim());
    };
    update();
    field.addEventListener('input', () => {
      if (field.value === originalValue) noteDrafts.clear(date, workoutId);
      else noteDrafts.save(date, workoutId, { original, value: field.value,
        newWorkoutId: session ? undefined : noteDrafts.get(date, workoutId)?.newWorkoutId ?? adapter.makeSetId() });
      update();
    });
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      if (submit.disabled) return;
      const change = { kind: 'notes', original, value: field.value } as const;
      const input: WorkoutEditInput = workoutId === null
        ? { date, selectedDate: Boolean(state.date), workoutId, newWorkoutId: noteDrafts.get(date, null)?.newWorkoutId ?? adapter.makeSetId(), change }
        : { date, workoutId, change };
      void saveChange(submit, error, () => adapter.editWorkout(input), (saved) => {
        noteDrafts.clear(date, workoutId);
        recordWorkout(saved);
        goSession(saved.workout);
      });
    });
    details.append(form);
    return details;
  }

  function setFields(measurements: readonly Measurement[], values: SetInputs, weight?: { mode: LoadMode; unit: WeightUnit }, distance?: DistanceUnit) {
    const fields = el('div', { class: 'entry-fields' });
    for (const measurement of measurements) {
      const decimal = measurement === 'weight' || measurement === 'distance';
      const input = measurement === 'time'
        ? el('input', { name: measurement, type: 'text', required: '' })
        : el('input', { name: measurement, type: 'number', inputmode: decimal ? 'decimal' : 'numeric',
          required: '', min: decimal ? 0 : 1, step: decimal ? 'any' : 1,
          max: measurement === 'weight' ? 100000 : measurement === 'reps' ? 1000 : undefined });
      if (values[measurement] !== undefined) input.value = String(values[measurement]);
      const name = weight?.mode === 'assistance' ? 'Assistance' : weight?.mode === 'added' ? 'Added weight' : 'Weight';
      const label = measurement === 'distance' ? `Distance (${distance})`
        : measurement === 'weight' ? `${name} (${weight?.unit ?? journalData().unit})` : measurementNames[measurement];
      fields.append(el('label', {}, label, input));
    }
    return fields;
  }

  function readSetFields(form: HTMLFormElement, measurements: readonly Measurement[]): SetInputs {
    const values: SetInputs = {};
    for (const kind of measurements) {
      const input = inputFor(form, kind);
      if (kind === 'time') values.time = input.value;
      else values[kind] = input.valueAsNumber;
    }
    return values;
  }

  function renderSetEditor() {
    const { session, set, name } = required(state.setEditor);
    const weight = set.load?.mode && set.load.mode !== 'bodyweight' ? set.load : undefined;
    const values = { weight: weight?.value, reps: set.reps, time: set.durationSeconds, distance: set.distance?.value };
    const measurementKeys = (Object.keys(values) as Measurement[]).filter((key) => values[key] !== undefined);
    const fields = setFields(measurementKeys, values, weight, set.distance?.unit);
    const error = el('p', { role: 'alert', class: 'warning', hidden: '' });
    const submit = el('button', { type: 'submit', class: 'primary' }, 'Save set');
    const confirm = el('fieldset', { class: 'delete-confirm', hidden: '' }, el('legend', {}, 'Delete this set?'));
    const deleteButton = button('Delete set', () => {
      confirm.hidden = false;
      deleteButton.hidden = true;
      confirm.querySelector('button')?.focus();
    }, { className: 'text-button warning' });
    const cancel = button('Cancel', () => {
      confirm.hidden = true;
      deleteButton.hidden = false;
      deleteButton.focus();
    });
    const remove = button('Confirm delete', () => {
      void submitChange(remove, { kind: 'remove', original: set });
    }, { className: 'warning' });
    confirm.append(el('div', { class: 'plan-controls' }, cancel, remove));
    const form = el('form', { class: 'entry-form' }, fields, el('div', { class: 'plan-controls' }, submit, deleteButton), confirm, error);
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const changed = readSetFields(form, measurementKeys);
      void submitChange(submit, { kind: 'edit', original: set, values: changed });
    });
    function submitChange(control: HTMLButtonElement, change: ExistingWorkoutChange) {
      return saveChange(control, error, () => adapter.editWorkout({ date: session.date, workoutId: session.id, change }), (saved) => {
        recordWorkout(saved);
        goSession(saved.workout);
      });
    }
    return el('section', { class: 'page' }, button('← Workout log', () => view('log'), { className: 'text-button' }),
      el('h1', {}, 'Edit set'), el('p', { class: 'secondary' }, name), form);
  }

  function recordExercise(exercise: ExerciseNote) {
    journalData().exercises = [...journalData().exercises.filter(({ id }) => id !== exercise.id), exercise]
      .sort((a, b) => a.name.localeCompare(b.name));
    const names = [exercise.name, ...exercise.aliases].map(normalized);
    journalData().starters = journalData().starters.filter((starter) => starter.id !== exercise.id &&
      ![starter.name, ...starter.aliases].some((name) => names.includes(normalized(name))));
  }

  function openExerciseEditor(exercise: ExerciseNote | null = null, from: EditorOrigin = 'exercises', initialName = '') {
    state.exerciseEditor = { exercise, id: exercise?.id ?? adapter.makeSetId(), unit: journalData().unit, from, initialName };
    view('edit-exercise');
  }

  function renderExercises() {
    const search = el('input', { type: 'search', 'aria-label': 'Search exercises', placeholder: 'Search names and aliases' });
    const list = el('div', { class: 'plan-list', 'aria-live': 'polite' });
    search.value = state.exerciseSearch ?? '';
    function renderList() {
      const term = search.value.trim().toLocaleLowerCase();
      const visible = journalData().exercises.filter(({ name, aliases }) => [name, ...aliases].some((value) => value.toLocaleLowerCase().includes(term)));
      visible.sort((a, b) => Number(a.archived) - Number(b.archived) || a.name.localeCompare(b.name));
      list.replaceChildren();
      for (const exercise of visible) {
        const choice = button(exercise.name, () => openExerciseEditor(exercise), { className: 'plan-option' });
        const subtitle = [exercise.archived ? 'Archived' : '', ...exercise.aliases].filter(Boolean).join(' · ');
        if (subtitle) choice.append(el('span', { class: 'secondary' }, subtitle));
        list.append(choice);
      }
      if (!visible.length) list.append(el('p', { class: 'empty' }, 'No matching exercises.'));
    }
    search.addEventListener('input', () => {
      state.exerciseSearch = search.value;
      renderList();
    });
    renderList();
    return el('section', { class: 'page' }, button('← Workout log', () => view('log'), { className: 'text-button' }),
      el('div', { class: 'manage-heading' }, el('h1', {}, 'Exercises'),
        button('New exercise', () => openExerciseEditor(), { className: 'primary' })),
      search, list);
  }

  function renderExerciseEditor() {
    const { exercise, id, unit, from, initialName } = required(state.exerciseEditor);
    function exitEditor(saved?: ExerciseNote) {
      if (from === 'progress') void openProgress(saved?.id ?? id);
      else if (from === 'entry' && saved) selectEntryExercise(saved.id);
      else view(from);
    }
    const name = el('input', { name: 'name', required: 'required', maxlength: 120 });
    name.value = exercise?.name ?? initialName;
    const aliases = el('textarea', { name: 'aliases', rows: 2 });
    aliases.value = exercise?.aliases.join('\n') ?? '';
    const tracked = new Set<Measurement>(exercise?.measurements ?? ['weight', 'reps']);
    const distanceUnits = ['m', 'km', 'mi', 'yd', 'ft'] as const;
    const measurements = el('fieldset', { class: 'exercise-checks' }, el('legend', {}, 'Measurements'));
    const distance = el('select', { name: 'distanceUnit' }, ...distanceUnits.map((unit) => el('option', { value: unit }, unit)));
    distance.value = exercise?.distanceUnit ?? 'm';
    const distanceField = el('label', { hidden: tracked.has('distance') ? undefined : '' }, 'Distance unit', distance);
    for (const [key, label] of Object.entries({ ...measurementNames, time: 'Time' }) as Array<[Measurement, string]>) {
      const input = el('input', { type: 'checkbox', name: 'measurements', value: key });
      input.checked = tracked.has(key);
      input.addEventListener('change', () => {
        if (input.checked) tracked.add(key);
        else tracked.delete(key);
        distanceField.hidden = !tracked.has('distance');
      });
      measurements.append(el('label', { class: 'check-field' }, input, label));
    }
    const tags = el('details', { class: 'exercise-tags' }, el('summary', {}, 'Exercise tags'));
    const tagsFields: Array<[TagGroup, HTMLTextAreaElement]> = [];
    for (const [group, label] of Object.entries(exerciseTagGroups) as Array<[TagGroup, string]>) {
      const field = el('textarea', { name: group, rows: 2 });
      field.value = exercise?.tags.filter((tag) => tag.group === group).map((tag) => tag.name).join('\n') ?? '';
      tagsFields.push([group, field]);
      tags.append(el('label', {}, label, field));
    }
    const archived = el('input', { type: 'checkbox', name: 'archived' });
    archived.checked = exercise?.archived ?? false;
    const submit = el('button', { type: 'submit', class: 'primary' }, 'Save exercise');
    const error = el('p', { role: 'alert', class: 'warning', hidden: '' });
    const form = el('form', { class: 'entry-form' }, el('label', {}, 'Display name', name),
      el('label', {}, 'Search aliases, one per line', aliases), measurements, distanceField, tags,
      el('label', { class: 'check-field' }, archived, 'Archived'), error, el('div', {}, submit));
    const split = (value: string) => value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const values = {
        name: name.value.trim(), aliases: split(aliases.value), archived: archived.checked, measurements: [...tracked],
        distanceUnit: distanceUnits.find(unit => unit === distance.value) ?? 'm', tags: tagsFields.flatMap(([group, field]) => split(field.value).map((name) => ({ group, name }))),
      };
      void saveChange(submit, error, () => adapter.saveExercise({ exerciseId: id, original: exercise, values }, unit), (saved) => {
        recordExercise(saved);
        state.exerciseSearch = '';
        exitEditor(saved);
      });
    });
    const back = from === 'progress' ? '← Progress' : from === 'entry' ? '← Log a set' : '← Exercises';
    return el('section', { class: 'page' }, button(back, () => exitEditor(), { className: 'text-button' }),
      el('h1', {}, exercise ? 'Edit exercise' : 'New exercise'),
      exercise && adapter.openExerciseNote
        ? button('Open exercise note', () => adapter.openExerciseNote?.(exercise), { className: 'text-button' }) : undefined,
      form);
  }

  async function openProgress(exerciseId = progress.exerciseId, workout = progress.workout) {
    const version = ++progressVersion;
    progress.exerciseId = exerciseId;
    progress.workout = workout;
    progress.report = null;
    progress.error = '';
    view('progress');
    try {
      const report = await adapter.readProgress(exerciseId);
      if (version !== progressVersion) return;
      progress.report = report;
      progress.exerciseId = report.selected?.id ?? null;
    } catch (error) {
      if (version !== progressVersion) return;
      progress.error = message(error);
    }
    if (state.screen === 'progress') render();
  }

  function renderProgress() {
    const workout = progress.workout;
    const back = workout ? button('Back to workout', () => {
      progress.workout = null;
      goSession(workout);
    }, { className: 'text-button' }) : undefined;
    const page = el('section', { class: 'page' }, back, el('h1', {}, 'Progress'));
    if (progress.error) {
      page.append(el('p', { role: 'alert', class: 'warning' }, progress.error), button('Try again', () => openProgress()));
    } else if (!progress.report) {
      page.append(el('p', { role: 'status' }, 'Loading exercise history…'));
    } else if (progress.report.selected) {
      const { selected, sessions, trend, unit } = progress.report;
      const note = journalData().exercises.find(({ id }) => id === selected.id);
      const controls = el('div', { class: 'plan-controls' }, button('Choose exercise', () => openProgress(null)));
      if (note) {
        controls.append(button('Edit exercise', () => openExerciseEditor(note, 'progress')));
        if (adapter.openExerciseNote) controls.append(button('Open exercise note', () => adapter.openExerciseNote?.(note)));
      }
      const label = selected.missingNote ? 'Exercise note missing' : (selected.archived ? 'Archived' : '');
      page.append(controls, el('div', { class: 'progress-heading' }, el('h2', {}, selected.name),
        label ? el('p', { class: 'secondary' }, label) : undefined));
      if (trend.length && adapter.drawStrengthChart) {
        page.append(el('section', { class: 'strength-chart', 'aria-label': 'Estimated 1RM chart' },
          el('h3', {}, 'Estimated 1RM')));
      }
      const history = el('section', { class: 'progress-history', 'aria-label': 'Exercise history' }, el('h3', {}, 'Exercise history'));
      if (!sessions.length) history.append(el('p', { class: 'empty' }, 'No sets recorded for this exercise.'));
      for (const [index, { date, number, sets, estimatedMax }] of sessions.entries()) {
        const estimate = estimatedMax === undefined ? undefined : el('span', { class: 'secondary' }, `Estimated 1RM · ${estimatedMax.toFixed(1)} ${unit}`);
        const dateLabel = el('time', { datetime: date }, date);
        const count = `${sets.length} ${sets.length === 1 ? 'set' : 'sets'}`;
        const summary = el('summary', {}, dateLabel, number ? ` · Session ${number}` : '', ` · ${count}`, estimate);
        history.append(el('details', { class: 'exercise-card progress-session', open: index === 0 ? '' : undefined }, summary,
          el('ol', {}, ...sets.map((set, index) => el('li', { class: 'set-row' }, el('span', { class: 'secondary' }, `${index + 1}`),
            el('span', { class: 'set-measurements' }, set))))));
      }
      page.append(history);
    } else {
      page.append(renderExercisePicker(progress.report.exercises, progress, (exercise) => { void openProgress(exercise.id); }, progress.report.tags));
    }
    return page;
  }

  function renderExercisePicker(
    exercises: readonly ExerciseChoice[], picker: Picker, choose: (exercise: ExerciseChoice, control: HTMLButtonElement) => void,
    tags: readonly ExerciseTag[], create?: (name: string) => void, suggestions = new Map<string, Suggestion>(),
  ) {
    const search = el('input', { type: 'search', 'aria-label': 'Search exercises', placeholder: 'Search names and aliases' });
    search.value = picker.search;
    const list = el('div', { class: 'plan-list' });
    const results = el('p', { class: 'secondary', role: 'status' });
    const rank = (exercise: ExerciseChoice) => suggestions.get(exercise.id)?.rank ?? suggestions.size;
    function renderList() {
      const term = normalized(search.value);
      const visible = [];
      for (const exercise of exercises) {
        const keys = new Set(exercise.tags.map(tagKey));
        if ([...picker.tags].some((tag) => !keys.has(tag))) continue;
        const names = [exercise.name, ...exercise.aliases].map(normalized);
        if ([...names, normalized(exercise.equipment)].some((name) => name.includes(term))) {
          visible.push({ exercise, exact: names.includes(term) });
        }
      }
      visible.sort((a, b) => Number(b.exact) - Number(a.exact) || rank(a.exercise) - rank(b.exercise));
      results.textContent = visible.length ? `${visible.length} ${visible.length === 1 ? 'exercise' : 'exercises'}` : 'No matching exercises.';
      list.replaceChildren(...visible.map(({ exercise }) => {
        const suggestion = suggestions.get(exercise.id);
        const choice = button(el('span', {}, exercise.name), () => choose(exercise, choice), { className: 'plan-option' });
        if (suggestion) choice.setAttribute('data-plan-status', suggestion.status);
        const description = [suggestion?.label, exercise.starter ? 'Starter exercise' : '', exercise.archived ? 'Archived' : '',
          exercise.missingNote ? 'Exercise note missing' : '',
          ...exercise.aliases].filter(Boolean).join(' · ');
        if (description) choice.append(el('span', { class: 'secondary' }, description));
        return choice;
      }));
      if (create && (!term || !exercises.some((exercise) => [exercise.name, ...exercise.aliases].some((name) => normalized(name) === term)))) {
        const name = search.value.trim();
        list.append(button(name ? `Create exercise “${name}”` : 'Create an exercise', () => create(name), { className: 'plan-option' }));
      }
    }
    const summary = el('summary', {}, 'Filter by tags');
    const filters = el('details', { class: 'exercise-filters', open: picker.tags.size ? '' : undefined }, summary);
    const update = () => {
      summary.textContent = picker.tags.size ? `Filter by tags (${picker.tags.size})` : 'Filter by tags';
      renderList();
    };
    for (const [group, name] of Object.entries(exerciseTagGroups)) {
      const choices = tags.filter((tag) => tag.group === group);
      if (!choices.length) continue;
      const field = el('fieldset', { class: 'exercise-checks' }, el('legend', {}, name));
      for (const tag of choices) {
        const key = tagKey(tag);
        const checkbox = el('input', { type: 'checkbox' });
        checkbox.checked = picker.tags.has(key);
        checkbox.addEventListener('change', () => {
          if (checkbox.checked) picker.tags.add(key);
          else picker.tags.delete(key);
          update();
        });
        field.append(el('label', { class: 'check-field' }, checkbox, tag.name));
      }
      filters.append(field);
    }
    filters.append(button('Clear tag filters', () => {
      picker.tags.clear();
      for (const input of filters.querySelectorAll('input')) input.checked = false;
      update();
    }, { className: 'text-button' }));
    search.addEventListener('input', () => {
      picker.search = search.value;
      renderList();
    });
    update();
    return el('div', { class: 'page' }, search, tags.length ? filters : undefined, results, list);
  }

  function renderExport() {
    return el('section', { class: 'page' }, el('h1', {}, 'Export'), renderFileExports(), renderWorkoutContext());
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
      fileExport.error = false;
      fileExport.status = 'Saving…';
      const automatic = format === 'automatic-csv';
      if (automatic) fileExport.automaticError = '';
      update();
      try {
        if (automatic) {
          await adapter.refreshAutomaticCsv();
          fileExport.status = 'Automatic CSV refreshed.';
        } else {
          const path = await adapter.saveExport(format);
          fileExport.status = `Saved to ${path}`;
        }
      } catch (error) {
        fileExport.status = message(error);
        fileExport.error = true;
      } finally {
        fileExport.pending = false;
        if (section.isConnected) update();
        else if (state.screen === 'export') render();
      }
    }

    update();
    if (!fileExport.pending && adapter.readAutomaticCsvError) {
      void adapter.readAutomaticCsvError().then((error) => {
        if (!section.isConnected || fileExport.pending) return;
        fileExport.automaticError = error ?? '';
        update();
      }).catch(() => undefined);
    }
    return section;
  }

  function renderWorkoutContext() {
    if (!state.context) {
      const today = journalData().today;
      const start = asDate(today);
      start.setUTCDate(start.getUTCDate() - 41);
      state.context = { from: start.toISOString().slice(0, 10), to: today, goal: '', equipment: '', days: '', includeNotes: false,
        text: '', status: '', error: false, version: 0 };
    }
    const context = state.context;
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
        if (!hostWindow.navigator.clipboard) throw new Error('Clipboard unavailable.');
        await hostWindow.navigator.clipboard.writeText(context.text);
        if (version !== context.version) return;
        context.status = 'Workout context copied.';
      } catch {
        if (version !== context.version) return;
        preview.focus();
        preview.select();
        context.status = 'Copy the selected text manually.';
      }
      status.hidden = false;
      status.textContent = context.status;
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
        const text = await adapter.prepareContext({ from: from.value, to: to.value, goal: goal.value, equipment: equipment.value,
          daysPerWeek: days.value ? days.valueAsNumber : null, includeNotes: includeNotes.checked });
        if (version !== context.version) return;
        context.text = text;
        context.status = '';
      } catch (error) {
        if (version !== context.version) return;
        context.status = message(error);
        context.error = true;
      } finally {
        if (version === context.version) {
          context.pending = false;
          if (form.isConnected) update();
          else if (state.screen === 'export') render();
        }
      }
    }
    update();
    return form;
  }

  function sessionLabel(workout: Workout) {
    const sessions = workouts().filter(({ date }) => date === workout.date);
    const index = sessions.findIndex(({ id }) => id === workout.id);
    return `Session ${index + 1}`;
  }

  function renderBanner() {
    const { plan, section, title } = required(state.active);
    const entry = activeExercise();
    const current = plan.sections[section];
    return el('aside', { class: 'plan-banner', 'aria-label': 'Active plan' },
      el('div', {}, el('strong', {}, plan.title ?? title),
        el('p', { class: 'secondary', 'aria-live': 'polite' }, entry ? `Up next · ${entry.name}` : `Active section · ${current.name}`),
        button('View plan', showActivePlan, { className: 'text-button' })),
      entry ? startExerciseButton(entry) : sectionDoneButton(current));
  }

  function openCalendar() {
    const day = workoutDate();
    state.calendarMonth = asDate(day.slice(0, 7) + '-01');
    state.calendarDay = null;
    view('calendar');
  }

  function moveMonth(delta: number) {
    state.calendarMonth.setUTCMonth(state.calendarMonth.getUTCMonth() + delta);
    state.calendarDay = null;
    render();
  }

  function openCalendarDay(day: string, sessions: Workout[]) {
    if (sessions.length > 1) {
      state.calendarDay = day;
      render();
      app.querySelector<HTMLButtonElement>('.calendar-sessions button')?.focus();
    } else if (!sessions.length) goDate(day);
    else goSession(sessions[0]);
  }

  function renderCalendar() {
    const date = state.calendarMonth;
    const month = date.toISOString().slice(0, 7);
    const endOfMonth = new Date(date);
    endOfMonth.setUTCMonth(date.getUTCMonth() + 1, 0);
    const days = endOfMonth.getUTCDate();
    const sessions = workouts();
    const grid = el('div', { class: 'calendar-grid', 'aria-label': 'Workout dates' },
      ...['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((day) => el('span', { class: 'weekday' }, day)));
    for (let pad = 0; pad < date.getUTCDay(); pad++) grid.append(el('span', { 'aria-hidden': 'true' }));
    for (let number = 1; number <= days; number++) {
      const day = `${month}-${String(number).padStart(2, '0')}`;
      const entries = sessions.filter(({ date: workoutDate }) => workoutDate === day);
      const label = `${fullDate.format(asDate(day))}, ${entries.length} ${entries.length === 1 ? 'workout' : 'workouts'}`;
      const control = button(String(number), () => openCalendarDay(day, entries), { className: 'calendar-day', label });
      if (day === journalData().today) control.setAttribute('aria-current', 'date');
      if (day === state.calendarDay) control.setAttribute('aria-pressed', 'true');
      if (entries.length) {
        control.setAttribute('data-has-workout', '');
        const markers = el('span', { class: 'markers', 'aria-hidden': 'true' });
        for (let index = 0; index < Math.min(entries.length, 3); index++) markers.append(el('i'));
        control.append(markers);
      }
      grid.append(control);
    }
    const choices = state.calendarDay ? el('section', { class: 'calendar-sessions', 'aria-live': 'polite' },
      el('h2', {}, shortDate.format(asDate(state.calendarDay))),
      ...sessions.filter(({ date: day }) => day === state.calendarDay).map((session) =>
        button(`${sessionLabel(session)} · ${session.sets.length} ${session.sets.length === 1 ? 'set' : 'sets'}`, () => goSession(session)))) : undefined;
    const picker = el('input', { type: 'date', min: '0001-01-01', max: '9999-12-31', required: '' });
    const day = workoutDate();
    picker.value = state.calendarDay ?? (day.startsWith(month + '-') ? day : month + '-01');
    const jump = el('form', { class: 'calendar-date-picker' }, el('label', {}, 'Workout date', picker),
      el('button', { type: 'submit' }, 'Go to date'));
    jump.addEventListener('submit', (event) => {
      event.preventDefault();
      if (!state.saving) goDate(picker.value);
    });
    return el('section', { class: 'page' }, button('← Workout log', () => view('log'), { className: 'text-button' }),
      el('h1', {}, 'Workout calendar'),
      el('div', { class: 'session-header calendar-header' },
        button('←', () => moveMonth(-1), { className: 'arrow', label: 'Previous month', disabled: month === '0001-01' }),
        el('strong', { 'aria-live': 'polite' }, monthTitle.format(date)),
        button('→', () => moveMonth(1), { className: 'arrow', label: 'Next month', disabled: month === '9999-12' })),
      grid, el('p', { class: 'legend secondary' }, el('span', { class: 'markers', 'aria-hidden': 'true' }, el('i')), 'Workout logged'), choices, jump);
  }

  async function openPlans() {
    state.plans = undefined;
    state.planError = '';
    view('plans');
    try { state.plans = await adapter.listPlans(); }
    catch (error) { state.planError = message(error); }
    if (state.screen === 'plans') render();
  }

  function renderPlans() {
    const files = state.plans ?? [];
    const list = el('div', { class: 'plan-list', 'aria-live': 'polite' });
    if (state.planError) list.append(el('p', { role: 'alert', class: 'warning' }, state.planError));
    else if (!state.plans) list.append(el('p', { role: 'status' }, 'Finding workout plans…'));
    else if (!files.length) list.append(el('p', { class: 'empty' }, 'No Markdown workout plans found.'));
    for (const file of files) {
      const pick = button(file.title, () => openPlan(file), { className: 'plan-option' });
      pick.append(el('span', { class: 'secondary' }, file.path));
      list.append(pick);
    }
    return el('section', { class: 'page' }, button('← Workout log', () => view('log'), { className: 'text-button' }), el('h1', {}, 'Workout plans'),
      state.active ? button('View active plan', showActivePlan, { className: 'primary' }) : undefined, list);
  }

  async function openPlan(file: PlanNote, start = false) {
    if (!mounted || state.saving) return;
    if (state.active?.path === file.path && !start) { showActivePlan(); return; }
    const current: ReviewedPlan = { ...file };
    state.review = current;
    view('plan');
    try { current.result = await adapter.readPlan(file.path); }
    catch (error) { current.error = message(error); }
    if (!mounted || state.screen !== 'plan' || state.review !== current) return;
    if (start && current.result?.plan) startPlan();
    else render();
  }

  function showActivePlan() {
    const { path, title, plan } = required(state.active);
    state.review = { path, title, result: { plan } };
    view('plan');
  }

  function activeExercise() {
    return state.active?.plan.sections[state.active.section]?.exercises[state.active.exercise];
  }

  function startExerciseButton(exercise: PlanExercise) {
    return button('Start', () => openEntry(true), {
      className: 'primary', label: `Start ${exercise.name}`, disabled: Boolean(journalData().issues.length),
    });
  }

  function storageKey() { return `rep-journal:active-plan:${journalData().vaultKey}`; }

  function rememberPlan() {
    try {
      if (!state.active) { hostWindow.localStorage.removeItem(storageKey()); return; }
      const { plan, ...position } = state.active;
      hostWindow.localStorage.setItem(storageKey(), JSON.stringify({ ...position, signature: JSON.stringify(plan) }));
    } catch { /* This browser may restrict local storage. */ }
  }

  async function restorePlan() {
    try {
      const saved: unknown = JSON.parse(hostWindow.localStorage.getItem(storageKey()) ?? 'null');
      if (!isSavedPlan(saved)) return;
      const { plan } = await adapter.readPlan(saved.path);
      const section = plan?.sections[saved.section];
      if (plan && section && JSON.stringify(plan) === saved.signature && saved.exercise >= 0 &&
        saved.exercise < Math.max(1, section.exercises.length)) {
        state.active = { path: saved.path, title: saved.title, section: saved.section, exercise: saved.exercise, plan };
      } else rememberPlan();
    } catch { rememberPlan(); }
  }

  function startPlan() {
    const { path, title, result } = required(state.review);
    if (!result?.plan) return;
    state.active = { path, title, plan: result.plan, section: 0, exercise: 0 };
    rememberPlan();
    goToday();
  }

  function movePlan(section: number, exercise = 0) {
    const active = required(state.active);
    active.section = section;
    active.exercise = exercise;
    rememberPlan();
    render();
  }

  function stopPlan() {
    state.active = null;
    rememberPlan();
    goToday();
  }

  function sectionDoneButton(section: PlanSection) {
    return button('Done', () => {
      const active = required(state.active);
      const next = active.section + 1;
      if (next === active.plan.sections.length) {
        stopPlan();
        app.querySelector<HTMLButtonElement>('.log-actions .primary')?.focus();
        return;
      }
      movePlan(next);
      app.querySelector<HTMLElement>('.current-section h2, .plan-banner > button')?.focus();
    }, { className: 'plan-done', label: `Done with ${section.name}` });
  }

  function renderPlan() {
    const { result, title, path, error } = required(state.review);
    const active = state.active?.path === path ? state.active : null;
    const plan = result?.plan;
    const page = el('section', { class: 'page' }, button('← Workout log', () => view('log'), { className: 'text-button' }),
      el('h1', {}, plan?.title ?? title));
    if (error) page.append(el('p', { role: 'alert', class: 'warning' }, error));
    else if (!result) page.append(el('p', { role: 'status' }, 'Loading plan…'));
    else if (result.issues) page.append(el('ul', { class: 'warning' }, ...result.issues.map(({ line, message }) => el('li', {}, `Line ${line}. ${message}`))));
    if (!plan) return page;
    const description = notes(plan.notes);
    if (description) page.append(description);
    if (active) {
      const position = active.section;
      page.append(el('div', { class: 'plan-controls' },
        button('Previous section', () => movePlan(position - 1), { disabled: position === 0 }),
        button('Next section', () => movePlan(position + 1), { disabled: position === plan.sections.length - 1 })));
    }
    for (const [index, section] of plan.sections.entries()) {
      const current = index === active?.section;
      const box = el('section', {
        class: current ? 'plan-section current-section' : 'plan-section', 'aria-current': current ? 'step' : undefined,
      }, current ? el('p', { class: 'active-section-label' }, 'Active section') : undefined,
        el('div', { class: 'section-heading' }, el('h2', { tabindex: current ? -1 : undefined }, section.name),
          section.superset ? el('span', { class: 'secondary' }, 'Superset') : undefined), notes(section.notes));
      for (const [exerciseIndex, exercise] of section.exercises.entries()) {
        const selected = current && exerciseIndex === active?.exercise;
        const choice = current ? button(exercise.name, () => movePlan(index, exerciseIndex), { className: 'exercise-choice' }) : el('h3', {}, exercise.name);
        if (current) {
          choice.setAttribute('aria-pressed', String(selected));
          choice.setAttribute('data-plan-status', selected ? 'next' : 'planned');
        }
        box.append(el('div', { class: 'plan-exercise' },
          el('div', { class: 'plan-exercise-heading' }, choice, selected ? startExerciseButton(exercise) : undefined),
          notes(exercise.notes)));
      }
      if (current) box.append(sectionDoneButton(section));
      page.append(box);
    }
    page.append(el('div', { class: 'plan-controls' },
      active ? button('Stop plan', stopPlan)
        : button('Start plan', startPlan, { className: 'primary' })));
    return page;
  }

  function openEntry(planned: boolean, exerciseId = planned ? activeExercise()?.exerciseId : undefined) {
    if (planned && !exerciseId) { showActivePlan(); return; }
    if (planned && state.date) goToday();
    state.entry = { exerciseId, setId: adapter.makeSetId(), planned, unit: journalData().unit, date: workoutDate(),
      selectedDate: Boolean(state.date), workoutId: selectedWorkout()?.id ?? null, picker: { search: '', tags: new Set() } };
    view('entry');
    if (exerciseId) {
      const inputs = [...app.querySelectorAll<HTMLInputElement>('.entry-fields input:not(:disabled):not([readonly])')];
      (inputs.find((input) => input.value === '') ?? inputs[0])?.focus();
    }
  }

  function selectEntryExercise(exerciseId?: string) {
    const entry = required(state.entry);
    entry.exerciseId = exerciseId;
    entry.setId = adapter.makeSetId();
    view('entry');
  }

  function renderEntry() {
    const entry = required(state.entry);
    const exercises = journalData().exercises.filter(({ archived }) => !archived);
    const exercise = exercises.find(({ id }) => id === entry.exerciseId);
    const page = el('section', { class: 'page' }, button('← Workout log', () => view('log'), { className: 'text-button' }),
      el('h1', {}, exercise?.name ?? 'Log a set'));
    if (entry.selectedDate) page.append(el('p', { class: 'secondary' }, fullDate.format(asDate(entry.date))));
    const instructions = entry.planned && exercise ? notes(activeExercise()?.notes) : undefined;
    if (instructions) page.append(instructions);
    const form = el('form', { class: 'entry-form' });
    const error = el('p', { role: 'alert', class: 'warning', hidden: '' });
    if (!exercise) {
      if (entry.planned) {
        page.append(el('p', { class: 'warning' }, 'The planned exercise note is unavailable.'));
        return page;
      }
      const options: ExerciseChoice[] = [...exercises, ...journalData().starters];
      const suggestions = new Map<string, Suggestion>();
      const next = activeExercise() ?? state.active?.plan.sections.slice(state.active.section + 1)
        .find(({ exercises }) => exercises.length)?.exercises[0];
      if (next) suggestions.set(next.exerciseId, { rank: 0, label: 'Up next', status: 'next' });
      for (const section of state.active?.plan.sections ?? []) {
        for (const { exerciseId } of section.exercises) {
          if (!suggestions.has(exerciseId)) {
            suggestions.set(exerciseId, { rank: suggestions.size, label: 'In active plan', status: 'planned' });
          }
        }
      }
      const tags = [...new Map(options.flatMap(({ tags }) => tags.map((tag) => [tagKey(tag), tag]))).values()]
        .sort((a, b) => a.name.localeCompare(b.name));
      const choose = (option: ExerciseChoice, control: HTMLButtonElement) => {
        if (!option.starter) { selectEntryExercise(option.id); return; }
        void saveChange(control, error, () => adapter.addStarter(option.id), (saved) => {
          recordExercise(saved);
          if (!saved.archived) selectEntryExercise(saved.id);
          else render();
        });
      };
      form.addEventListener('submit', (event) => {
        event.preventDefault();
        form.querySelector<HTMLButtonElement>('button.plan-option')?.click();
      });
      form.append(error, renderExercisePicker(options, entry.picker, choose, tags,
        (name) => openExerciseEditor(null, 'entry', name), suggestions));
      page.append(form);
      return page;
    }
    const actions = el('div', { class: 'plan-controls' });
    if (!entry.planned) actions.append(button('Change exercise', () => selectEntryExercise(undefined)));
    if (adapter.openExerciseNote) actions.append(button('Open exercise note', () => adapter.openExerciseNote?.(exercise), { className: 'text-button' }));
    page.append(actions);
    const past = workouts().filter(({ date }) => date <= entry.date);
    const currentIndex = entry.workoutId ? past.findIndex(({ id }) => id === entry.workoutId) : -1;
    const earlier = currentIndex < 0 ? past : past.slice(0, currentIndex);
    const latest = findLast((currentIndex < 0 ? past : past.slice(0, currentIndex + 1)).flatMap(({ sets }) => sets),
      ({ exerciseId }) => exerciseId === exercise.id);
    const last = findLast(earlier, ({ sets }) => sets.some(({ exerciseId }) => exerciseId === exercise.id));
    const fields = setFields(exercise.measurements, { weight: latest?.load && latest.load.mode !== 'bodyweight' && latest.load.unit === entry.unit ? latest.load.value : undefined },
      { mode: exercise.loadMode, unit: entry.unit }, exercise.distanceUnit);
    const submit = el('button', { type: 'submit', class: 'primary' }, 'Log set →');
    if (last) form.append(renderLastSession(last, exercise, entry.unit, form));
    form.append(fields, error, submit);
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      if (state.saving) return;
      void logSet(entry, readSetFields(form, exercise.measurements), submit, error);
    });
    page.append(form);
    return page;
  }

  function renderLastSession(session: Workout, exercise: ExerciseNote, weightUnit: WeightUnit, form: HTMLFormElement) {
    const sets = session.sets.filter(({ exerciseId }) => exerciseId === exercise.id);
    const { load, reps, durationSeconds, distance } = required(sets.at(-1));
    const rounded = (value: number) => Number(value.toFixed(3));
    const values = {
      weight: load && load.mode !== 'bodyweight'
        ? load.unit === weightUnit ? load.value : rounded(convertWeight(load.value, load.unit, weightUnit)) : undefined,
      reps, time: durationSeconds,
      distance: distance && (distance.unit === exercise.distanceUnit
        ? distance.value : rounded(convertDistance(distance.value, distance.unit, exercise.distanceUnit))),
    };
    const usable = exercise.measurements.filter((measurement) => values[measurement] !== undefined);
    const last = el('section', { class: 'last-session plan-section' }, el('h2', {}, 'Last session'),
      el('time', { class: 'secondary', datetime: session.date }, session.date),
      el('ol', {}, ...sets.map((set) => el('li', {}, setValues(set).join(' · ')))));
    if (usable.length) last.append(button('Use last set', () => {
      for (const measurement of usable) inputFor(form, measurement).value = String(values[measurement]);
      inputFor(form, usable[0]).focus();
    }));
    return last;
  }

  function logSet(entry: Entry, values: SetInputs, submit: HTMLButtonElement, error: HTMLElement) {
    const { date, workoutId, selectedDate, exerciseId } = entry;
    if (!exerciseId) return;
    return saveChange(submit, error, () => adapter.saveSet({ date, selectedDate, workoutId, exerciseId, setId: entry.setId, values }, entry.unit), (saved) => {
      recordWorkout(saved);
      if (workoutId === null) noteDrafts.associate(date, saved.workout.id);
      if (entry.planned && state.active && activeExercise()?.exerciseId === entry.exerciseId) {
        const section = state.active.plan.sections[state.active.section];
        if (section.superset) state.active.exercise = (state.active.exercise + 1) % section.exercises.length;
        rememberPlan();
      }
      goSession(saved.workout);
    });
  }

  const editing = () => ['entry', 'edit-set', 'edit-exercise'].includes(state.screen);

  async function reload(force = false) {
    if (!mounted || state.saving || (!force && editing())) return;
    const version = ++refreshVersion;
    try {
      const journal = await adapter.loadJournal();
      if (!mounted || version !== refreshVersion || state.saving || (!force && editing())) return;
      const firstLoad = !state.journal;
      const dateChanged = state.journal && journal.today !== journalData().today;
      state.journal = journal;
      if (dateChanged && !state.date) {
        state.selected = null;
        state.newSession = false;
        if (state.screen === 'entry') state.screen = 'log';
      }
      if (firstLoad) await restorePlan();
      if (version === refreshVersion) {
        if (state.screen === 'progress') await openProgress();
        else render();
      }
    } catch (error) {
      if (!mounted || version !== refreshVersion) return;
      app.setAttribute('aria-busy', 'false');
      app.replaceChildren(el('p', { class: 'warning', role: 'alert' }, message(error)));
    }
  }

  const ready = reload();
  return {
    ready,
    async showToday() {
      await ready;
      if (mounted && state.journal) goToday();
    },
    async openProgress(exerciseId) {
      await ready;
      if (mounted && state.journal) await openProgress(exerciseId, null);
    },
    async openExport() {
      await ready;
      if (mounted && state.journal) view('export');
    },
    async openPlan(file, start = false) {
      await ready;
      if (state.journal) await openPlan(file, start);
    },
    reload,
    setWeightUnit(unit) {
      if (!mounted || !state.journal) return;
      journalData().unit = unit;
      if (state.screen === 'progress') void openProgress();
      else if (!editing()) render();
    },
    dispose() {
      mounted = false;
      disposeStrengthChart?.();
      menuResize.disconnect();
      root.replaceChildren();
      root.classList.remove('rep-journal-modern');
    },
  };
}
