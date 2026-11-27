import { Notice, setIcon, type App } from 'obsidian';

export const jsonSyncSetting = {
  name: 'Workout JSON is excluded from Obsidian Sync',
  desc: 'On this device, enable Settings → Sync → Selective sync → Sync all other types, then restart Obsidian.',
};

// The Sync core plugin has no public settings API. Read only the two capabilities
// used by its own settings screen, and stay silent if the host does not expose them.
interface SyncHost {
  internalPlugins?: {
    getEnabledPluginById?(id: 'sync'): {
      getRemoteVaultId?(): unknown;
      filter?: { allowTypes?: ReadonlySet<string> };
    } | null;
  };
}

export function excludesWorkoutJson(app: App): boolean {
  const sync = (app as App & SyncHost).internalPlugins?.getEnabledPluginById?.('sync');
  return Boolean(sync?.getRemoteVaultId?.()) && sync?.filter?.allowTypes?.has?.('unsupported') === false;
}

export function mountSyncIndicator(app: App, nav: HTMLElement): () => void {
  const control = nav.createEl('button', { cls: 'nav-icon sync-warning', attr: {
    type: 'button', 'aria-label': jsonSyncSetting.name, title: jsonSyncSetting.name,
  } });
  nav.prepend(control);
  setIcon(control, 'cloud-off');
  control.addEventListener('click', () => { new Notice(jsonSyncSetting.desc, 10000); });
  const win = nav.win;
  const update = () => { control.hidden = !excludesWorkoutJson(app); };
  update();
  // Sync stores device preferences internally and exposes no settings-change event.
  const timer = win.setInterval(update, 2000);
  return () => { win.clearInterval(timer); control.remove(); };
}
