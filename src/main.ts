import { FileSystemAdapter, MarkdownView, Notice, Platform, Plugin, PluginSettingTab, Setting, TFolder, type SettingDefinitionItem, type TAbstractFile, type TFile, type WorkspaceLeaf } from 'obsidian';
import { journalFolder, journalSettingsFile, normalizeJournalFolder, parseJournalFolder } from './journal-paths.ts';
import { errorMessage, isRecord, isUnit, makeId, type ExerciseNote, type WeightUnit } from './model.ts';
import { MODERN_JOURNAL_VIEW, ModernJournalView, type JournalScreen } from './modern-journal-view.ts';
import { createObsidianJournalAdapter } from './obsidian-journal-adapter.ts';
import { drawObsidianStrengthChart } from './obsidian-strength-chart.ts';
import { affectsExerciseNotes } from './repo/exercise-repository.ts';
import { affectsDatedPlanFolder, datedPlanDate } from './repo/plan-repository.ts';
import { LedgerRepository } from './repository.ts';

const legacyView = 'set-ledger-workout-view';
declare const require: (id: 'node:fs/promises') => typeof import('node:fs/promises');

export default class RepJournalPlugin extends Plugin {
  private opening = false;
  private tidyingExerciseNotes = false;
  private preferences: Record<string, unknown> = {};
  private repository?: LedgerRepository;
  private adapter?: ReturnType<RepJournalPlugin['createAdapter']>;

  get journalFolder(): string {
    return this.repository?.root ?? '';
  }

  get weightUnit(): WeightUnit {
    const unit = this.preferences.weightUnit;
    return isUnit(unit) ? unit : 'lb';
  }

  async onload(): Promise<void> {
    const stored: unknown = await this.loadData();
    if (isRecord(stored)) this.preferences = stored;
    const vault = this.app.vault;
    try {
      const folder = await vault.adapter.exists(journalSettingsFile)
        ? parseJournalFolder(await vault.adapter.read(journalSettingsFile))
        : journalFolder;
      this.repository = this.createRepository(folder);
    } catch (error: unknown) {
      new Notice(`Could not read ${journalSettingsFile}. ${errorMessage(error)}`);
    }
    this.adapter = this.createAdapter();
    const createJournalView = (leaf: WorkspaceLeaf): ModernJournalView =>
      new ModernJournalView(leaf, this.adapter, this.manifest.name);
    this.registerView(MODERN_JOURNAL_VIEW, createJournalView);
    // Restore saved layouts from the Set Ledger preview using the shared journal.
    this.registerView(legacyView, createJournalView);
    this.watchJournalNotes();
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
    this.addCommand({ id: 'tidy-exercise-notes', name: 'Tidy exercise notes', callback: () => {
      if (this.repository) void this.tidyExerciseNotes(this.repository);
      else new Notice('Set a valid journal folder in the plugin settings.');
    } });
  }

  private createRepository(root: string): LedgerRepository {
    const vault = this.app.vault;
    const adapter = vault.adapter;
    const statHiddenWorkout = Platform.isDesktop && adapter instanceof FileSystemAdapter
      ? (path: string) => require('node:fs/promises').lstat(adapter.getFullPath(path), { bigint: true })
      : undefined;
    return new LedgerRepository(vault, root, statHiddenWorkout);
  }

  private createAdapter() {
    const repository = this.repository;
    if (!repository) return;
    const vault = this.app.vault;
    const vaultKey = vault.adapter instanceof FileSystemAdapter ? vault.adapter.getBasePath() : vault.getName();
    const adapter = createObsidianJournalAdapter(vault, repository, {
      vaultKey: repository.root === journalFolder ? `obsidian:${vaultKey}` : JSON.stringify(['obsidian', vaultKey, repository.root]),
      weightUnit: () => this.weightUnit,
      reportExportError: (error) => { new Notice(`Could not update the automatic CSV. ${errorMessage(error)}`); },
      openExerciseNote: (exercise) => { void this.openExerciseNote(exercise); },
    });
    return { ...adapter, drawStrengthChart: drawObsidianStrengthChart };
  }

  private journalViews(): ModernJournalView[] {
    const { workspace } = this.app;
    const leaves = new Set([...workspace.getLeavesOfType(MODERN_JOURNAL_VIEW), ...workspace.getLeavesOfType(legacyView)]);
    return [...leaves].map(({ view }) => view).filter((view) => view instanceof ModernJournalView);
  }

  async updateJournalFolder(value: string): Promise<void> {
    const root = normalizeJournalFolder(value);
    const previous = this.journalFolder;
    if (root === previous) return;
    const overlapsExercises = (inner: string, outer: string): boolean =>
      `${inner.toLowerCase()}/`.startsWith(`${outer.toLowerCase()}/exercises/`);
    if (previous && (overlapsExercises(root, previous) || overlapsExercises(previous, root))) {
      throw new Error('Choose a journal folder outside the other journal’s Exercises folder.');
    }
    const repository = this.createRepository(root);
    const settings = await this.readJournalSettings();
    await this.publishJournalSettings({ ...settings, journalFolder: root });
    this.repository = repository;
    const adapter = this.createAdapter();
    this.adapter = adapter;
    await Promise.all(this.journalViews().map((view) => view.setAdapter(adapter)));
  }

  private async publishJournalSettings(settings: Record<string, unknown>): Promise<void> {
    const { adapter } = this.app.vault;
    const content = `${JSON.stringify(settings, null, 2)}\n`;
    if (Platform.isDesktop && adapter instanceof FileSystemAdapter) {
      // The desktop vault adapter's rename refuses an existing destination.
      const fs = require('node:fs/promises');
      const temporary = `${journalSettingsFile}.${makeId()}.tmp`;
      const stagingPath = adapter.getFullPath(temporary);
      const staging = await fs.open(stagingPath, 'wx');
      try {
        try {
          await staging.writeFile(content);
        } finally {
          await staging.close();
        }
        await fs.rename(stagingPath, adapter.getFullPath(journalSettingsFile));
      } finally {
        await fs.unlink(stagingPath).catch(() => undefined);
      }
      return;
    }
    if (await adapter.exists(journalSettingsFile)) await adapter.process(journalSettingsFile, () => content);
    else await adapter.write(journalSettingsFile, content);
  }

  private async readJournalSettings(): Promise<Record<string, unknown>> {
    const { adapter } = this.app.vault;
    if (!await adapter.exists(journalSettingsFile)) return {};
    const text = await adapter.read(journalSettingsFile);
    try {
      const settings: unknown = JSON.parse(text);
      return isRecord(settings) ? settings : {};
    } catch (error: unknown) {
      if (!(error instanceof SyntaxError)) throw error;
      return {};
    }
  }

  private watchJournalNotes(): void {
    const { vault } = this.app;
    const hostWindow = window;
    let timer: number | undefined;
    const refresh = (): void => {
      hostWindow.clearTimeout(timer);
      timer = hostWindow.setTimeout(() => {
        timer = undefined;
        for (const view of this.journalViews()) void view.refreshVaultNotes();
      }, 100);
    };
    const affects = (file: TAbstractFile, path = file.path): boolean => {
      const root = this.repository?.root;
      return !!root && (affectsExerciseNotes(file, root, path) ||
        (file instanceof TFolder ? affectsDatedPlanFolder(path, root) : !!datedPlanDate(path, root)));
    };
    const invalidate = (file: TAbstractFile, path = file.path): void => {
      const folder = file instanceof TFolder;
      if (folder || /\.md$/i.test(path)) this.adapter?.invalidatePlanPicker(path, folder);
      if (!folder) this.repository?.markRecordChanged(path);
    };
    const onChange = (file: TAbstractFile): void => {
      invalidate(file);
      if (affects(file)) refresh();
    };
    this.registerEvent(vault.on('create', onChange));
    this.registerEvent(vault.on('modify', onChange));
    this.registerEvent(vault.on('delete', onChange));
    this.registerEvent(vault.on('rename', (file, oldPath) => {
      invalidate(file, oldPath);
      invalidate(file);
      if (affects(file) || affects(file, oldPath)) refresh();
    }));
    this.register(() => hostWindow.clearTimeout(timer));
  }

  private async tidyExerciseNotes(repository: LedgerRepository): Promise<void> {
    if (this.tidyingExerciseNotes) return;
    this.tidyingExerciseNotes = true;
    try {
      const result = await repository.tidyExerciseNotes((file, path) => this.app.fileManager.renameFile(file, path));
      const summary = `Exercise notes: ${result.renamed} renamed, ${result.guidesAdded} updated with guide links.`;
      const issues = result.issues.length ? ` ${result.issues.length} need attention. ${result.issues[0]}` : '';
      new Notice(summary + issues, issues ? 10000 : 6000);
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
const folderSetting = { name: 'Journal folder', desc: 'Path relative to the vault. Saving opens that journal in all workout log tabs.' };

class RepJournalSettings extends PluginSettingTab {
  constructor(private readonly journal: RepJournalPlugin) {
    super(journal.app, journal);
  }

  getSettingDefinitions(): SettingDefinitionItem[] {
    return [
      { ...folderSetting, render: (setting) => { this.addJournalFolderControl(setting); } },
      { ...weightSetting, render: (setting) => { this.addWeightUnitControl(setting); } },
    ];
  }

  display(): void {
    this.containerEl.empty();
    this.addJournalFolderControl(new Setting(this.containerEl).setName(folderSetting.name).setDesc(folderSetting.desc));
    this.addWeightUnitControl(new Setting(this.containerEl).setName(weightSetting.name).setDesc(weightSetting.desc));
  }

  private addJournalFolderControl(setting: Setting): void {
    let value = this.journal.journalFolder;
    setting.addText((control) => {
      control.setPlaceholder(journalFolder).setValue(value).onChange((next) => { value = next; });
      control.inputEl.setAttribute('aria-label', folderSetting.name);
      setting.addButton((button) => {
        button.setButtonText('Save folder').onClick(async () => {
          button.setDisabled(true);
          control.setDisabled(true);
          try {
            await this.journal.updateJournalFolder(value);
            value = this.journal.journalFolder;
            control.setValue(value);
          } catch (error: unknown) {
            new Notice(`Could not save the journal folder. ${errorMessage(error)}`);
          } finally {
            control.setDisabled(false);
            button.setDisabled(false);
          }
        });
      });
    });
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
