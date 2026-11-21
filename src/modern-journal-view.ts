import { ItemView, Notice, type TFile, type WorkspaceLeaf } from 'obsidian';
import { mountJournal, type JournalAdapter, type MountedJournal } from '../standalone/app.js';
import { errorMessage, type WeightUnit } from './model.ts';

export const MODERN_JOURNAL_VIEW = 'rep-journal-today';
export type JournalScreen = 'today' | 'progress' | 'export';

export class ModernJournalView extends ItemView {
  private journal?: MountedJournal;

  constructor(leaf: WorkspaceLeaf, private readonly adapter: JournalAdapter, private readonly name: string) {
    super(leaf);
    this.addAction('refresh-cw', 'Refresh workout log', () => { void this.refresh(); });
  }

  getViewType(): string { return MODERN_JOURNAL_VIEW; }
  getDisplayText(): string { return this.name; }
  getIcon(): string { return 'dumbbell'; }

  async onOpen(): Promise<void> {
    this.contentEl.empty();
    this.contentEl.addClass('rep-journal-modern-content');
    this.journal = mountJournal(this.contentEl.createDiv(), this.adapter);
    await this.journal.ready;
    if (!this.journal) return;
    this.registerEvent(this.app.workspace.on('active-leaf-change', (leaf) => {
      if (leaf === this.leaf) void this.reload();
    }));
    void this.refreshAutomaticCsv();
  }

  onClose(): Promise<void> {
    this.journal?.dispose();
    this.journal = undefined;
    this.contentEl.removeClass('rep-journal-modern-content');
    this.contentEl.empty();
    return Promise.resolve();
  }

  async startPlan(file: TFile): Promise<void> {
    await this.journal?.openPlan({ path: file.path, title: file.basename }, true);
  }

  async showScreen(screen: JournalScreen): Promise<void> {
    if (screen === 'progress') await this.journal?.openProgress();
    else if (screen === 'export') await this.journal?.openExport();
    else await this.journal?.showToday();
  }

  async reload(force = false): Promise<void> {
    await this.journal?.reload(force);
  }

  setWeightUnit(unit: WeightUnit): void { this.journal?.setWeightUnit(unit); }

  private async refresh(): Promise<void> {
    await this.reload(true);
    await this.refreshAutomaticCsv();
  }

  private async refreshAutomaticCsv(): Promise<void> {
    try {
      await this.adapter.refreshAutomaticCsv();
    } catch (error: unknown) {
      new Notice(`Could not update the automatic CSV. ${errorMessage(error)}`);
    }
  }
}
