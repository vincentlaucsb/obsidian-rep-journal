import { Component, ItemView, Keymap, MarkdownRenderer, Notice, type TFile, type WorkspaceLeaf } from 'obsidian';
import { mountJournal, type JournalAdapter, type MountedJournal } from '../standalone/app.ts';
import { errorMessage, type WeightUnit } from './model.ts';

export const MODERN_JOURNAL_VIEW = 'rep-journal-today';
export type JournalScreen = 'today' | 'progress' | 'export';

export class ModernJournalView extends ItemView {
  private journal?: MountedJournal;

  constructor(leaf: WorkspaceLeaf, private adapter: JournalAdapter | undefined, private readonly name: string) {
    super(leaf);
  }

  getViewType(): string { return MODERN_JOURNAL_VIEW; }
  getDisplayText(): string { return this.name; }
  getIcon(): string { return 'dumbbell'; }

  async onOpen(): Promise<void> {
    this.containerEl.addClass('rep-journal-modern-view');
    this.contentEl.addClass('rep-journal-modern-content');
    this.registerEvent(this.app.workspace.on('active-leaf-change', (leaf) => {
      if (leaf === this.leaf) void this.reload();
    }));
    await this.setAdapter(this.adapter);
  }

  async setAdapter(adapter: JournalAdapter | undefined): Promise<void> {
    this.journal?.dispose();
    this.journal = undefined;
    this.adapter = adapter;
    this.contentEl.empty();
    if (!adapter) {
      this.contentEl.createEl('p', { text: 'Set a valid journal folder in the plugin settings.' });
      return;
    }
    const journalRoot = this.contentEl.createDiv();
    const journalWindow = journalRoot.ownerDocument.defaultView;
    if (!journalWindow) return;
    const journal = mountJournal(journalRoot, {
      ...adapter,
      renderPlanMarkdown: (host, markdown, sourcePath) => this.renderPlanMarkdown(host, markdown, sourcePath),
    }, (tag) => journalWindow.createEl(tag));
    this.journal = journal;
    await journal.ready;
    if (this.journal === journal) void this.refreshAutomaticCsv();
  }

  private renderPlanMarkdown(host: HTMLElement, markdown: string, sourcePath: string): () => void {
    const owner = this.addChild(new Component());
    host.addClass('markdown-rendered');
    const openLink = (event: MouseEvent, link: HTMLElement) => {
      const target = link.dataset.href;
      if (!target || event.defaultPrevented || event.button > 1) return;
      event.preventDefault();
      event.stopPropagation();
      void this.app.workspace.openLinkText(target, sourcePath, Keymap.isModEvent(event) || 'tab')
        .catch((error: unknown) => new Notice(`Could not open the plan link. ${errorMessage(error)}`));
    };
    for (const type of ['click', 'auxclick'] as const) {
      host.on(type, 'a.internal-link', openLink);
      owner.register(() => host.off(type, 'a.internal-link', openLink));
    }
    void MarkdownRenderer.render(this.app, markdown, host, sourcePath, owner).catch(() => host.setText(markdown));
    return () => this.removeChild(owner);
  }

  onClose(): Promise<void> {
    this.journal?.dispose();
    this.journal = undefined;
    this.containerEl.removeClass('rep-journal-modern-view');
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

  async refreshVaultNotes(): Promise<void> {
    await this.journal?.refreshVaultNotes();
  }

  setWeightUnit(unit: WeightUnit): void { this.journal?.setWeightUnit(unit); }

  async refresh(): Promise<void> {
    await this.reload(true);
    await this.refreshAutomaticCsv();
  }

  private async refreshAutomaticCsv(): Promise<void> {
    try {
      await this.adapter?.refreshAutomaticCsv();
    } catch (error: unknown) {
      new Notice(`Could not update the automatic CSV. ${errorMessage(error)}`);
    }
  }
}
