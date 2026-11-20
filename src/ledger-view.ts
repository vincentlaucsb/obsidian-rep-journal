import { ItemView, type Modal, type WorkspaceLeaf } from 'obsidian';
import { progressExercises, workoutExercises } from './analytics.ts';
import { WorkoutNoteDrafts } from './drafts.ts';
import { renderExportView } from './export-view.ts';
import { toCsv, toJson, workoutContext } from './exports.ts';
import {
  compareWorkouts, errorMessage, localDate, resolveWorkoutDate, type ExerciseNote, type LedgerData, type WeightUnit,
  type WorkoutFile,
} from './model.ts';
import { renderProgressView } from './progress-view.ts';
import { type LedgerRepository } from './repository.ts';
import { actionButton, ContextDialog, ExerciseDialog, ExercisePicker } from './ui-controls.ts';
import { renderWorkoutView, type SetDraft } from './workout-view.ts';

// Obsidian persists this identifier in layouts from the Set Ledger preview.
export const LEDGER_VIEW = 'set-ledger-workout-view';
export type LedgerScreen = 'workout' | 'progress' | 'export';

const screens: ReadonlyArray<{ value: LedgerScreen; label: string }> = [
  { value: 'workout', label: 'Workout' },
  { value: 'progress', label: 'Progress' },
  { value: 'export', label: 'Export' },
];

export class LedgerView extends ItemView {
  private readonly repository: LedgerRepository;
  private readonly displayName: string;
  private data: LedgerData | undefined;
  private screen: LedgerScreen = 'workout';
  private date = localDate();
  private followsToday = true;
  private sessionId: string | null = null;
  private useNewWorkout = false;
  private workoutExerciseId: string | undefined;
  private progressExerciseId: string | undefined;
  private chartUnit: WeightUnit | undefined;
  private chartCleanup: (() => void) | undefined;
  private body?: HTMLElement;
  private issues?: HTMLElement;
  private status?: HTMLElement;
  private buttons: Array<{ screen?: LedgerScreen; button: HTMLButtonElement }> = [];
  private modal?: Modal;
  private busy = false;
  private closed = true;
  private readonly noteDrafts = new WorkoutNoteDrafts();
  private readonly setDrafts = new Map<string, SetDraft>();

  constructor(leaf: WorkspaceLeaf, repository: LedgerRepository, displayName: string) {
    super(leaf);
    this.repository = repository;
    this.displayName = displayName;
  }

  getViewType(): string { return LEDGER_VIEW; }
  getDisplayText(): string { return this.displayName; }
  getIcon(): string { return 'dumbbell'; }

  async onOpen(): Promise<void> {
    this.closed = false;
    this.contentEl.empty();
    this.contentEl.addClass('rep-journal');
    const header = this.contentEl.createDiv({ cls: 'rep-journal-header' });
    const nav = header.createEl('nav', { cls: 'rep-journal-actions', attr: { 'aria-label': 'Workout log' } });
    this.buttons = screens.map(({ value, label }) => ({
      screen: value, button: actionButton(nav, label, () => this.showScreen(value)),
    }));
    this.buttons.push({ button: actionButton(header, 'Refresh', () => { void this.reload(); }) });
    this.status = this.contentEl.createEl('p', { cls: 'rep-journal-status', attr: { role: 'status' } });
    this.issues = this.contentEl.createDiv();
    this.body = this.contentEl.createDiv({ cls: 'rep-journal-body' });
    const document = this.contentEl.ownerDocument;
    this.registerDomEvent(document, 'visibilitychange', () => {
      if (!this.closed && !this.busy && this.screen === 'workout' && document.visibilityState === 'visible' && this.followCurrentDate()) {
        this.render();
      }
    });
    await this.reload();
  }

  onClose(): Promise<void> {
    this.closed = true;
    this.modal?.close();
    this.modal = undefined;
    this.chartCleanup?.();
    this.chartCleanup = undefined;
    this.contentEl.empty();
    return Promise.resolve();
  }

  showScreen(screen: LedgerScreen): void {
    if (this.busy || this.closed) return;
    const dateChanged = screen === 'workout' && this.followCurrentDate();
    if (this.screen === screen && !dateChanged) return;
    this.screen = screen;
    this.render();
  }

  private async reload(): Promise<void> {
    if (this.busy || this.closed) return;
    this.status?.setText('Loading workout data…');
    try {
      await this.runExclusive(async () => {
        this.data = await this.repository.read();
        this.followCurrentDate();
        this.chooseSessionForDate();
        this.render();
        this.status?.setText('');
      });
    } catch (error: unknown) {
      this.status?.setText(errorMessage(error));
    }
  }

  private async runExclusive<T>(action: () => Promise<T>): Promise<T> {
    if (this.busy || this.closed) throw new Error('The workout log is busy. Try again in a moment.');
    this.busy = true;
    this.updateButtons();
    try {
      return await action();
    } finally {
      this.busy = false;
      this.updateButtons();
    }
  }

  private updateButtons(): void {
    for (const { screen, button } of this.buttons) {
      button.disabled = this.busy || (screen !== undefined && !this.data);
      if (screen) {
        button.toggleClass('mod-cta', this.screen === screen);
        if (this.screen === screen) button.setAttribute('aria-current', 'page');
        else button.removeAttribute('aria-current');
      }
    }
  }

  private chooseSessionForDate(): void {
    const sessions = this.data?.workouts.filter(({ workout }) => workout.date === this.date) ?? [];
    if (!this.useNewWorkout && !sessions.some(({ workout }) => workout.id === this.sessionId)) {
      this.sessionId = sessions[sessions.length - 1]?.workout.id ?? null;
    }
  }

  private followCurrentDate(): boolean {
    const current = resolveWorkoutDate(this.date, this.followsToday);
    if (current === this.date) return false;
    this.setDate(current);
    return true;
  }

  private setDate(date: string): void {
    this.date = date;
    this.sessionId = null;
    this.useNewWorkout = false;
    this.chooseSessionForDate();
  }

  private render(): void {
    if (this.closed || !this.body || !this.data) return;
    this.chartCleanup?.();
    this.chartCleanup = undefined;
    this.body.empty();
    this.updateButtons();
    this.renderIssues();
    switch (this.screen) {
      case 'workout': this.renderWorkout(this.body, this.data); break;
      case 'progress': this.renderProgress(this.body, this.data); break;
      case 'export': this.renderExport(this.body); break;
    }
  }

  private renderIssues(): void {
    this.issues?.empty();
    if (!this.issues || !this.data?.issues.length) return;
    const details = this.issues.createEl('details', { cls: 'rep-journal-panel rep-journal-issues' });
    const count = this.data.issues.length;
    details.createEl('summary', { text: `${count} ${count === 1 ? 'record needs' : 'records need'} attention` });
    const list = details.createEl('ul');
    for (const issue of this.data.issues) list.createEl('li', { text: issue });
  }

  private renderWorkout(body: HTMLElement, data: LedgerData): void {
    const date = this.date;
    const session = data.workouts.find(({ workout }) => workout.id === this.sessionId);
    const exercise = data.exercises.find((entry) => entry.id === this.workoutExerciseId && !entry.archived);
    renderWorkoutView(body, {
      app: this.app, date, session, exercise, data,
      noteDraft: this.noteDrafts.get(date, this.sessionId),
      setDraft: exercise ? this.setDrafts.get(exercise.id) : undefined,
      onNoteDraft: (id, draft) => { this.noteDrafts.save(date, id, draft); },
      onSetDraft: (draft) => { if (exercise) this.setDrafts.set(exercise.id, draft); },
      onDate: (value) => {
        this.followsToday = value === localDate();
        this.setDate(value);
        this.render();
      },
      onToday: () => {
        this.followsToday = true;
        if (this.followCurrentDate()) this.render();
      },
      onSession: (id) => {
        this.sessionId = id;
        this.useNewWorkout = id === null;
        this.render();
      },
      chooseExercise: () => this.pickExercise(false),
      openModal: (modal) => this.openModal(modal),
      persist: (change, original) => this.runExclusive(async () => {
        if ((change.kind === 'add' || !original) && resolveWorkoutDate(date, this.followsToday) !== date) {
          throw new Error('The date changed. Tap Today to continue, or pick a date to log an earlier workout.');
        }
        const saved = await this.repository.saveWorkout(date, change, original);
        this.updateWorkout(data, saved);
        if (!original) this.noteDrafts.associate(date, saved.workout.id);
        this.sessionId = saved.workout.id;
        this.useNewWorkout = false;
        return saved;
      }),
    });
  }

  private updateWorkout(data: LedgerData, saved: WorkoutFile): void {
    data.workouts = [...data.workouts.filter(({ workout }) => workout.id !== saved.workout.id), saved]
      .sort((a, b) => compareWorkouts(a.workout, b.workout));
  }

  private renderProgress(body: HTMLElement, data: LedgerData): void {
    const exercise = progressExercises(data).find((entry) => entry.id === this.progressExerciseId);
    const original = data.exercises.find((entry) => entry.id === this.progressExerciseId);
    this.chartCleanup = renderProgressView(body, {
      data, exercise, unit: this.chartUnit ?? exercise?.unit ?? 'lb',
      chooseExercise: () => this.pickExercise(true),
      editExercise: original ? () => this.editExercise(original.name, original) : undefined,
      onUnit: (unit) => { this.chartUnit = unit; this.render(); },
    });
  }

  private renderExport(body: HTMLElement): void {
    renderExportView(body, {
      saveFile: (extension) => this.runExclusive(async () => {
        const data = await this.repository.read();
        return this.repository.writeExport(extension, extension === 'csv' ? toCsv(data) : toJson(data));
      }),
      showContext: (options) => this.runExclusive(async () => {
        const data = await this.repository.read();
        this.openModal(new ContextDialog(this.app, workoutContext(data, options)));
      }),
    });
  }

  private pickExercise(progress: boolean): void {
    if (this.busy || !this.data) return;
    const available = progress ? progressExercises(this.data) : workoutExercises(this.data);
    this.openModal(new ExercisePicker(this.app, available, (exercise) => {
      if (progress) {
        this.progressExerciseId = exercise.id;
        this.chartUnit = undefined;
      } else {
        this.workoutExerciseId = exercise.id;
        this.progressExerciseId = exercise.id;
        this.chartUnit = undefined;
      }
      this.render();
    }, progress ? undefined : (name) => this.editExercise(name)));
  }

  private editExercise(name: string, original?: ExerciseNote): void {
    this.openModal(new ExerciseDialog(this.app, (details) => this.runExclusive(async () => {
      const saved = await this.repository.saveExercise(details, original);
      if (!this.data || this.closed) return;
      this.setDrafts.delete(saved.id);
      this.data.exercises = [...this.data.exercises.filter((exercise) => exercise.id !== saved.id), saved]
        .sort((a, b) => a.name.localeCompare(b.name));
      if (this.screen === 'workout') this.workoutExerciseId = saved.id;
      this.progressExerciseId = saved.id;
      this.chartUnit = undefined;
      this.render();
    }), name, original));
  }

  private openModal(modal: Modal): void {
    if (this.closed) return;
    this.modal = modal;
    modal.open();
  }
}
