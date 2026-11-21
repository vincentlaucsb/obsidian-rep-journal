import { FuzzySuggestModal, MarkdownRenderer, Modal, Notice, type App, type Component, type TFile } from 'obsidian';
import { errorMessage } from './model.ts';
import { actionButton } from './ui-controls.ts';
import { type PlanIssue, type PlanPosition, type WorkoutPlan } from './workout-plan.ts';

export class WorkoutPlanPicker extends FuzzySuggestModal<TFile> {
  constructor(app: App, private readonly start: (file: TFile) => void) {
    super(app);
    this.setPlaceholder('Search for a workout plan note');
  }

  getItems(): TFile[] { return this.app.vault.getMarkdownFiles(); }
  getItemText(file: TFile): string { return file.path; }
  onChooseItem(file: TFile): void { this.start(file); }
}

export class WorkoutPlanIssues extends Modal {
  constructor(app: App, private readonly file: TFile, private readonly issues: PlanIssue[]) {
    super(app);
  }

  onOpen(): void {
    this.setTitle('Could not start workout plan');
    this.contentEl.createEl('p', { text: this.file.path });
    const list = this.contentEl.createEl('ul');
    for (const issue of this.issues) list.createEl('li', { text: `Line ${issue.line}. ${issue.message}` });
    actionButton(this.contentEl, 'Open plan note', () => {
      void this.app.workspace.getLeaf('tab').openFile(this.file, { active: true }).then(() => this.close(), (error: unknown) => {
        new Notice(`Could not open the plan note. ${errorMessage(error)}`);
      });
    }, true);
  }
}

interface PlanViewOptions {
  app: App;
  component: Component;
  plan: WorkoutPlan;
  filename: string;
  sourcePath: string;
  position: PlanPosition;
  selectedExerciseId?: string;
  available: ReadonlySet<string>;
  move: (position: PlanPosition) => void;
  stop: () => void;
}

export function renderWorkoutPlan(parent: HTMLElement, options: PlanViewOptions): void {
  const { plan, position, selectedExerciseId } = options;
  const section = plan.sections[position.sectionIndex];
  const entry = section.exercises[position.exerciseIndex];
  const panel = parent.createEl('section', { cls: 'rep-journal-panel rep-journal-plan', attr: { 'aria-label': 'Workout plan' } });
  const header = panel.createDiv({ cls: 'rep-journal-actions rep-journal-plan-header' });
  header.createEl('h3', { text: plan.title ?? options.filename });
  actionButton(header, 'Stop plan', options.stop);

  if (plan.notes) {
    const details = panel.createEl('details');
    details.createEl('summary', { text: 'Plan notes' });
    renderNotes(details, plan.notes, options);
  }

  const navigation = panel.createDiv({ cls: 'rep-journal-actions' });
  actionButton(navigation, 'Previous section', () => options.move({ sectionIndex: position.sectionIndex - 1, exerciseIndex: 0 }))
    .disabled = position.sectionIndex === 0;
  actionButton(navigation, 'Next section', () => options.move({ sectionIndex: position.sectionIndex + 1, exerciseIndex: 0 }))
    .disabled = position.sectionIndex === plan.sections.length - 1;
  panel.createEl('h3', { text: section.name });
  const mode = section.superset ? ' · Superset' : '';
  panel.createEl('p', { cls: 'rep-journal-muted', text: `Section ${position.sectionIndex + 1} of ${plan.sections.length}${mode}` });
  renderNotes(panel, section.notes, options);

  if (!section.exercises.length) return;
  const choices = panel.createDiv({ cls: 'rep-journal-actions', attr: { role: 'group', 'aria-label': 'Exercises in this section' } });
  for (const [exerciseIndex, exercise] of section.exercises.entries()) {
    const current = exerciseIndex === position.exerciseIndex && exercise.exerciseId === selectedExerciseId;
    const select = actionButton(choices, exercise.name, () => options.move({ ...position, exerciseIndex }), current);
    select.setAttribute('aria-pressed', String(current));
    select.disabled = !options.available.has(exercise.exerciseId);
    if (select.disabled) select.title = 'The exercise is no longer available.';
  }
  if (entry?.exerciseId === selectedExerciseId) renderNotes(panel, entry?.notes ?? '', options);
}

function renderNotes(parent: HTMLElement, notes: string, options: PlanViewOptions): void {
  if (!notes) return;
  const body = parent.createDiv({ cls: 'rep-journal-plan-notes' });
  void MarkdownRenderer.render(options.app, notes, body, options.sourcePath, options.component)
    .catch(() => body.setText(notes));
}
