import { FileSystemAdapter, MarkdownView, Notice, Platform, Plugin, PluginSettingTab, Setting, TFolder, type SettingDefinitionItem, type TAbstractFile, type TFile, type WorkspaceLeaf } from 'obsidian';
import { journalFolder, journalSettingsFile, normalizeJournalFolder, parseJournalFolder, parseJournalSettings, readMeasurementSystem } from './journal-paths.ts';
import { writeDesktopJournalSettings } from './desktop-journal-settings.ts';
import { errorMessage, isRecord, isUnit, makeId, type ExerciseNote, type WeightUnit } from './model.ts';
import { MODERN_JOURNAL_VIEW, ModernJournalView, type JournalScreen } from './modern-journal-view.ts';
import { createObsidianJournalAdapter } from './obsidian-journal-adapter.ts';
import { drawObsidianStrengthChart } from './obsidian-strength-chart.ts';
import { affectsExerciseNotes } from './repo/exercise-repository.ts';
import { affectsDatedPlanFolder, datedPlanDate } from './repo/plan-repository.ts';
import { LedgerRepository } from './repository.ts';
import { defaultMeasurementSystem, isMeasurementSystem, type MeasurementSystem } from './units.ts';
import { installGarminPrompt } from './garmin-prompt.ts';
import garminPrompt from '../prompts/rep-journal-garmin/SKILL.md';

const legacyView = 'set-ledger-workout-view';
declare const require: (id: 'node:fs/promises') => typeof import('node:fs/promises');

export default class RepJournalPlugin extends Plugin {
  private opening = false;
  private tidyingExerciseNotes = false;
  private preferences: Record<string, unknown> = {};
  private settingsWrites: Promise<unknown> = Promise.resolve();
  private sharedMeasurementSystem?: MeasurementSystem;
  private repository?: LedgerRepository;
  private adapter?: ReturnType<RepJournalPlugin['createAdapter']>;

  get journalFolder(): string {
    return this.repository?.root ?? '';
  }

  get measurementSystem(): MeasurementSystem {
    return this.sharedMeasurementSystem ?? defaultMeasurementSystem(this.weightUnit);
  }

  private get weightUnit(): WeightUnit {
    const unit = this.preferences.weightUnit;
    return isUnit(unit) ? unit : 'lb';
  }

  async onload(): Promise<void> {
    const stored: unknown = await this.loadData();
    if (isRecord(stored)) this.preferences = stored;
    const vault = this.app.vault;
    try {
      const text = await vault.adapter.exists(journalSettingsFile) ? await vault.adapter.read(journalSettingsFile) : '{}';
      const folder = parseJournalFolder(text);
      this.sharedMeasurementSystem = readMeasurementSystem(parseJournalSettings(text), defaultMeasurementSystem(this.weightUnit));
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
    return new LedgerRepository(this.app.vault, root, this.desktopVaultStat());
  }

  private desktopVaultStat() {
    const { adapter } = this.app.vault;
    return Platform.isDesktop && adapter instanceof FileSystemAdapter
      ? (path: string) => require('node:fs/promises').lstat(adapter.getFullPath(path), { bigint: true })
      : undefined;
  }

  private createAdapter() {
    const repository = this.repository;
    if (!repository) return;
    const vault = this.app.vault;
    const vaultKey = vault.adapter instanceof FileSystemAdapter ? vault.adapter.getBasePath() : vault.getName();
    const adapter = createObsidianJournalAdapter(vault, repository, {
      vaultKey: repository.root === journalFolder ? `obsidian:${vaultKey}` : JSON.stringify(['obsidian', vaultKey, repository.root]),
      statFile: this.desktopVaultStat(),
      weightUnit: () => this.weightUnit,
      measurementSystem: () => this.refreshMeasurementSystem(),
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
    await this.updateSharedSettings({ journalFolder: root });
    this.repository = repository;
    const adapter = this.createAdapter();
    this.adapter = adapter;
    await Promise.all(this.journalViews().map((view) => view.setAdapter(adapter)));
  }

  private updateSharedSettings(changes: Record<string, unknown>): Promise<void> {
    const pending = this.settingsWrites.catch(() => undefined).then(() => this.publishJournalSettings(changes));
    this.settingsWrites = pending;
    return pending;
  }

  private async publishJournalSettings(changes: Record<string, unknown>): Promise<void> {
    const { adapter } = this.app.vault;
    const content = (settings: Record<string, unknown>) => `${JSON.stringify({ ...settings, ...changes }, null, 2)}\n`;
    if (Platform.isDesktop && adapter instanceof FileSystemAdapter) {
      // The desktop vault adapter's rename refuses an existing destination.
      const hostWindow = window;
      await writeDesktopJournalSettings(require('node:fs/promises'), adapter.getFullPath(journalSettingsFile), changes, makeId(),
        (delay) => new Promise<void>((resolve) => { hostWindow.setTimeout(resolve, delay); }));
      return;
    }
    if (await adapter.exists(journalSettingsFile)) {
      await adapter.process(journalSettingsFile, (text) => content(parseJournalSettings(text)));
    } else await adapter.write(journalSettingsFile, content({}));
  }

  private async readJournalSettings(): Promise<Record<string, unknown>> {
    const { adapter } = this.app.vault;
    if (!await adapter.exists(journalSettingsFile)) return {};
    return parseJournalSettings(await adapter.read(journalSettingsFile));
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
    const onChange = (file: TAbstractFile): void => { if (affects(file)) refresh(); };
    this.registerEvent(vault.on('create', onChange));
    this.registerEvent(vault.on('modify', onChange));
    this.registerEvent(vault.on('delete', onChange));
    this.registerEvent(vault.on('rename', (file, oldPath) => {
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

  async refreshMeasurementSystem(): Promise<MeasurementSystem> {
    const system = readMeasurementSystem(await this.readJournalSettings(), defaultMeasurementSystem(this.weightUnit));
    this.sharedMeasurementSystem = system;
    return system;
  }

  async updateMeasurementSystem(system: MeasurementSystem): Promise<void> {
    await this.updateSharedSettings({ measurementSystem: system });
    this.sharedMeasurementSystem = system;
    for (const view of this.journalViews()) view.setMeasurementSystem(system);
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

const measurementSetting = { name: 'Measurement system', desc: 'Sets default units for new sets, workout history, and estimated 1RM.' };
const folderSetting = { name: 'Journal folder', desc: 'Path relative to the vault. Saving opens that journal in all workout log tabs.' };
const garminSetting = { name: 'Garmin agent integration', desc: 'Install the Garmin sync prompt for local agents in this vault. For regular updates, give your agent access to a Garmin Connect Personal API key.' };

class RepJournalSettings extends PluginSettingTab {
  constructor(private readonly journal: RepJournalPlugin) {
    super(journal.app, journal);
  }

  getSettingDefinitions(): SettingDefinitionItem[] {
    return [
      { ...folderSetting, render: (setting) => { this.addJournalFolderControl(setting); } },
      { ...measurementSetting, render: (setting) => { this.addMeasurementSystemControl(setting); } },
      ...(Platform.isDesktop ? [{ ...garminSetting, render: (setting: Setting) => { this.addGarminControl(setting); } }] : []),
    ];
  }

  display(): void {
    this.containerEl.empty();
    this.addJournalFolderControl(new Setting(this.containerEl).setName(folderSetting.name).setDesc(folderSetting.desc));
    this.addMeasurementSystemControl(new Setting(this.containerEl).setName(measurementSetting.name).setDesc(measurementSetting.desc));
    if (Platform.isDesktop) this.addGarminControl(new Setting(this.containerEl).setName(garminSetting.name).setDesc(garminSetting.desc));
  }

  private addGarminControl(setting: Setting): void {
    setting.addButton((button) => button.setButtonText('Enable or repair').onClick(async () => {
      button.setDisabled(true);
      try {
        const adapter = this.app.vault.adapter;
        if (Platform.isDesktop && adapter instanceof FileSystemAdapter) {
          const preserved = await installGarminPrompt(require('node:fs/promises'), adapter.getBasePath(), garminPrompt);
          if (preserved.length) new Notice('Kept existing files or links at ' + preserved.join(', ') + '. Check these locations before using the Garmin prompt.', 12000);
          else new Notice('Garmin prompt ready. Start a new agent chat at the vault root.');
        } else {
          new Notice('Open a local desktop vault to install the prompt.');
        }
      } catch (error: unknown) {
        new Notice(`Could not install the Garmin prompt. ${errorMessage(error)}`);
      } finally {
        button.setDisabled(false);
      }
    }));
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

  private addMeasurementSystemControl(setting: Setting): void {
    setting.addDropdown((control) => {
      control.addOption('imperial', 'Imperial (lb, mi, ft)').addOption('metric', 'Metric (kg, km, m)').setValue(this.journal.measurementSystem);
      control.selectEl.setAttribute('aria-label', measurementSetting.name);
      control.onChange(async (system) => {
        if (!isMeasurementSystem(system)) return;
        control.setDisabled(true);
        try {
          await this.journal.updateMeasurementSystem(system);
        } catch (error: unknown) {
          control.setValue(this.journal.measurementSystem);
          new Notice(`Could not save the measurement system. ${errorMessage(error)}`);
        } finally {
          control.setDisabled(false);
        }
      });
    });
  }
}
