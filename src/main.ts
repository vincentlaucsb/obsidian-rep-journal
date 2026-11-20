import { Notice, Plugin } from 'obsidian';
import { LEDGER_VIEW, LedgerView, type LedgerScreen } from './ledger-view.ts';
import { errorMessage } from './model.ts';
import { LedgerRepository } from './repository.ts';

export default class RepJournalPlugin extends Plugin {
  private opening = false;

  onload(): void {
    const repository = new LedgerRepository(this.app.vault);
    this.registerView(LEDGER_VIEW, (leaf) => new LedgerView(leaf, repository, this.manifest.name));
    this.addRibbonIcon('dumbbell', 'Open workout log', () => { void this.openLedger('workout'); });
    this.addCommand({ id: 'open-workout-log', name: 'Open workout log', callback: () => { void this.openLedger('workout'); } });
    this.addCommand({ id: 'open-exercise-progress', name: 'Open exercise progress', callback: () => { void this.openLedger('progress'); } });
  }

  private async openLedger(screen: LedgerScreen): Promise<void> {
    if (this.opening) return;
    this.opening = true;
    try {
      const workspace = this.app.workspace;
      let leaf = workspace.getLeavesOfType(LEDGER_VIEW)[0];
      if (!leaf) {
        leaf = workspace.getLeaf('tab');
        await leaf.setViewState({ type: LEDGER_VIEW, active: true });
      }
      await workspace.revealLeaf(leaf);
      workspace.setActiveLeaf(leaf, { focus: true });
      if (leaf.view instanceof LedgerView) leaf.view.showScreen(screen);
    } catch (error: unknown) {
      new Notice(`Could not open the workout log. ${errorMessage(error)}`);
    } finally {
      this.opening = false;
    }
  }
}
