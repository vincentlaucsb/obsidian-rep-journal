# Rep Journal

Log strength workouts in an Obsidian tab, see what you lifted last time, and follow your estimated one-rep max over time. The workout editor and progress view are available on mobile and desktop.

- **Workout** opens today’s session. Pick or create an exercise, enter a set, and tap **Log set**. Tap an existing set to edit or delete it.
- **Progress** shows per-exercise history and a chart based on the best eligible set in each session. Tap a point to see the recorded set behind the estimate.
- **Export** saves CSV and JSON in `Rep Journal/Exports`. **Prepare workout context** lets you preview and copy a date-filtered snapshot for the LLM you choose.

## Data and sync

Exercise definitions are Markdown notes in `Rep Journal/Exercises`. Workouts are versioned JSON files in `Rep Journal/Workouts`. Vaults that used the Set Ledger preview can keep their existing `Set Ledger` folder. All processing stays inside Obsidian, and you can review the workout context before you copy and share it.

With Obsidian Sync, enable **Sync all other types** on each device so workouts travel with your exercise notes. Use **Refresh** in the workout tab to load changes after sync. Obsidian Sync uses the latest modified version when a JSON file has conflicting edits. Enable **Show all file types** in Files and links to see exports in Obsidian’s file explorer. See [Obsidian Sync settings](https://obsidian.md/help/sync/settings) and the [data format](docs/DATA.md).

## Install a local build

Run `npm ci` and `npm run build` with Node 22.18 or later. Copy `main.js`, `manifest.json`, and `styles.css` into `<vault>/<config-folder>/plugins/rep-journal/` (`.obsidian` is the usual config folder). Reload Obsidian, enable **Rep Journal** under **Community plugins**, and run **Open workout log** from the command palette.

Rep Journal is an early preview. Automated tests cover storage, exports, and calculations. Live testing across desktop and mobile is pending.

## Development

Run `npm run dev` to rebuild the plugin on source changes. Use a separate test vault and run `npm run lint`, `npm test`, and `npm run build` before opening a pull request. Rep Journal is licensed under [MIT](LICENSE).
