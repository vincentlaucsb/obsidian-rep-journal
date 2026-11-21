import { Notice, Plugin, PluginSettingTab, Setting, type SettingDefinitionItem } from 'obsidian';
import { LEDGER_VIEW, LedgerView, type LedgerScreen } from './ledger-view.ts';
import { errorMessage, isRecord, isUnit, type WeightUnit } from './model.ts';
import { LedgerRepository } from './repository.ts';

export default class RepJournalPlugin extends Plugin {
  private opening = false;
  private preferences: Record<string, unknown> = {};

  get weightUnit(): WeightUnit {
    const unit = this.preferences.weightUnit;
    return isUnit(unit) ? unit : 'lb';
  }

  async onload(): Promise<void> {
    const stored: unknown = await this.loadData();
    if (isRecord(stored)) this.preferences = stored;
    const repository = new LedgerRepository(this.app.vault);
    this.registerView(LEDGER_VIEW, (leaf) => new LedgerView(leaf, repository, this.manifest.name, this.weightUnit));
    this.addSettingTab(new RepJournalSettings(this));
    this.addRibbonIcon('dumbbell', 'Open workout log', () => { void this.openLedger('workout'); });
    this.addCommand({ id: 'open-workout-log', name: 'Open workout log', callback: () => { void this.openLedger('workout'); } });
    this.addCommand({ id: 'open-exercise-progress', name: 'Open exercise progress', callback: () => { void this.openLedger('progress'); } });
  }

  async updateWeightUnit(weightUnit: WeightUnit): Promise<void> {
    const next = { ...this.preferences, weightUnit };
    await this.saveData(next);
    this.preferences = next;
    for (const leaf of this.app.workspace.getLeavesOfType(LEDGER_VIEW)) {
      if (leaf.view instanceof LedgerView) leaf.view.setWeightUnit(weightUnit);
    }
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
