import { FileSystemAdapter, MarkdownView, Notice, Plugin, PluginSettingTab, Setting, type SettingDefinitionItem, type TFile, type WorkspaceLeaf } from 'obsidian';
import { errorMessage, isRecord, isUnit, type ExerciseNote, type WeightUnit } from './model.ts';
import { MODERN_JOURNAL_VIEW, ModernJournalView, type JournalScreen } from './modern-journal-view.ts';
import { createObsidianJournalAdapter } from './obsidian-journal-adapter.ts';
import { drawObsidianStrengthChart } from './obsidian-strength-chart.ts';
import { LedgerRepository } from './repository.ts';

const legacyView = 'set-ledger-workout-view';

export default class RepJournalPlugin extends Plugin {
  private opening = false;
  private tidyingExerciseNotes = false;
  private preferences: Record<string, unknown> = {};

  get weightUnit(): WeightUnit {
    const unit = this.preferences.weightUnit;
    return isUnit(unit) ? unit : 'lb';
  }

  async onload(): Promise<void> {
    const stored: unknown = await this.loadData();
    if (isRecord(stored)) this.preferences = stored;
    const repository = new LedgerRepository(this.app.vault);
    const vault = this.app.vault;
    const vaultKey = vault.adapter instanceof FileSystemAdapter ? vault.adapter.getBasePath() : vault.getName();
    const adapter = createObsidianJournalAdapter(vault, repository, {
      vaultKey: `obsidian:${vaultKey}`,
      weightUnit: () => this.weightUnit,
      reportExportError: (error) => { new Notice(`Could not update the automatic CSV. ${errorMessage(error)}`); },
      openExerciseNote: (exercise) => { void this.openExerciseNote(exercise); },
    });
    const createJournalView = (leaf: WorkspaceLeaf): ModernJournalView =>
      new ModernJournalView(leaf, { ...adapter, drawStrengthChart: drawObsidianStrengthChart }, this.manifest.name);
    this.registerView(MODERN_JOURNAL_VIEW, createJournalView);
    // Restore saved layouts from the Set Ledger preview using the shared journal.
    this.registerView(legacyView, createJournalView);
    this.addSettingTab(new RepJournalSettings(this));
    this.addRibbonIcon('dumbbell', 'Open workout log', () => { void this.openModern(); });
    this.addCommand({ id: 'open-workout-log', name: 'Open workout log', callback: () => { void this.openModern(); } });
    this.addCommand({
      id: 'refresh-workout-log', name: 'Refresh workout log', callback: () => {
        const view = this.app.workspace.getActiveViewOfType(ModernJournalView);
        if (view) void view.refresh();
        else void this.openView((journal) => journal.refresh());
      },
    });
    this.addCommand({ id: 'open-exercise-progress', name: 'Open exercise progress', callback: () => { void this.openModern('progress'); } });
    this.addCommand({ id: 'open-workout-export', name: 'Open workout export', callback: () => { void this.openModern('export'); } });
    this.addCommand({
      id: 'start-workout-plan', name: 'Start workout plan from current note', checkCallback: (checking) => {
        const file = this.app.workspace.getActiveViewOfType(MarkdownView)?.file;
        if (!file) return false;
        if (!checking) void this.startPlan(file);
        return true;
      },
    });
    this.addCommand({ id: 'tidy-exercise-notes', name: 'Tidy exercise notes', callback: () => { void this.tidyExerciseNotes(repository); } });
  }

  private async tidyExerciseNotes(repository: LedgerRepository): Promise<void> {
    if (this.tidyingExerciseNotes) return;
    this.tidyingExerciseNotes = true;
    try {
      const result = await repository.tidyExerciseNotes((file, path) => this.app.fileManager.renameFile(file, path));
      const summary = `Exercise notes: ${result.renamed} renamed, ${result.guidesAdded} updated with guide links.`;
      const issues = result.issues.length ? ` ${result.issues.length} need attention. ${result.issues[0]}` : '';
      new Notice(summary + issues, issues ? 10000 : 6000);
      for (const { view } of this.app.workspace.getLeavesOfType(MODERN_JOURNAL_VIEW)) {
        if (view instanceof ModernJournalView) await view.reload();
      }
    } catch (error: unknown) {
      new Notice(`Could not tidy exercise notes. ${errorMessage(error)}`);
    } finally {
      this.tidyingExerciseNotes = false;
    }
  }

  async updateWeightUnit(weightUnit: WeightUnit): Promise<void> {
    const next = { ...this.preferences, weightUnit };
    await this.saveData(next);
    this.preferences = next;
    for (const { view } of this.app.workspace.getLeavesOfType(MODERN_JOURNAL_VIEW)) {
      if (view instanceof ModernJournalView) view.setWeightUnit(weightUnit);
    }
  }

  private openModern(screen: JournalScreen = 'today'): Promise<void> {
    return this.openView((view) => { void view.showScreen(screen); });
  }

  private startPlan(file: TFile): Promise<void> {
    return this.openView((view) => view.startPlan(file));
  }

  private async openExerciseNote(exercise: ExerciseNote): Promise<void> {
    try {
      const file = this.app.vault.getFileByPath(exercise.path);
      if (!file) throw new Error('The note may have moved. Refresh the workout log and try again.');
      await this.app.workspace.getLeaf('tab').openFile(file, { active: true });
    } catch (error: unknown) {
      new Notice(`Could not open the exercise note. ${errorMessage(error)}`);
    }
  }

  private async openView(open: (view: ModernJournalView) => void | Promise<void>): Promise<void> {
    if (this.opening) return;
    this.opening = true;
    try {
      const workspace = this.app.workspace;
      let leaf = workspace.getLeavesOfType(MODERN_JOURNAL_VIEW)[0] ?? workspace.getLeavesOfType(legacyView)[0];
      if (!leaf) {
        leaf = workspace.getLeaf('tab');
        await leaf.setViewState({ type: MODERN_JOURNAL_VIEW, active: true });
      }
      await workspace.revealLeaf(leaf);
      workspace.setActiveLeaf(leaf, { focus: true });
      if (leaf.view instanceof ModernJournalView) await open(leaf.view);
    } catch (error: unknown) {
      new Notice(`Could not open the workout log. ${errorMessage(error)}`);
    } finally {
      this.opening = false;
    }
  }
}

const weightSetting = { name: 'Weight unit', desc: 'Used for new sets and estimated 1RM. Logged sets keep their original units.' };

class RepJournalSettings extends PluginSettingTab {
  constructor(private readonly journal: RepJournalPlugin) {
    super(journal.app, journal);
  }

  getSettingDefinitions(): SettingDefinitionItem[] {
    return [{ ...weightSetting, render: (setting) => { this.addWeightUnitControl(setting); } }];
  }

  display(): void {
    this.containerEl.empty();
    this.addWeightUnitControl(new Setting(this.containerEl).setName(weightSetting.name).setDesc(weightSetting.desc));
  }

  private addWeightUnitControl(setting: Setting): void {
    setting.addDropdown((control) => {
      control.addOption('lb', 'Pounds (lb)').addOption('kg', 'Kilograms (kg)').setValue(this.journal.weightUnit);
      control.selectEl.setAttribute('aria-label', weightSetting.name);
      control.onChange(async (unit) => {
        if (!isUnit(unit)) return;
        control.setDisabled(true);
        try {
          await this.journal.updateWeightUnit(unit);
        } catch (error: unknown) {
          control.setValue(this.journal.weightUnit);
          new Notice(`Could not save the weight unit. ${errorMessage(error)}`);
        } finally {
          control.setDisabled(false);
        }
      });
    });
  }
}
