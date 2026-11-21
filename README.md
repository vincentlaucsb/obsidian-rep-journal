# Rep Journal

Log workouts in an Obsidian tab, review past sessions, and follow your estimated one-rep max for strength exercises. The workout editor and progress view are available on mobile and desktop.

- **Workout** opens today’s session. Pick a starter exercise or create one, fill its fields, and tap **Log set**. Each exercise can track a combination of weight, reps, time, and distance. Tap an existing set to edit or delete it.
- **Progress** shows per-exercise history and a chart based on the best eligible strength set in each session. Tap a point to see the recorded set behind the estimate. Choose **Edit exercise** to update its measurements, display name, search aliases, or grouped tags.
- **Export** saves dated CSV and JSON copies. Rep Journal keeps `Rep Journal/Exports/rep-journal.csv` current as you log sets. **Prepare workout context** lets you preview and copy a date-filtered snapshot for the LLM you choose.

The Workout and Progress pickers search display names and aliases and can filter by multiple tags. In Obsidian’s **Settings → Rep Journal**, choose pounds or kilograms for new entries and estimated 1RM. Historical sets keep their logged units.

Use the [command-line JSON importer](docs/IMPORT.md) to bring in workouts from FitNotes or another tracker. The importer validates the file and reports errors in JSON so an LLM can help correct them.

## Data and sync

Exercise definitions are Markdown notes in `Rep Journal/Exercises`. Workouts are versioned JSON files in `Rep Journal/Workouts`. Vaults that used the Set Ledger preview can keep their existing `Set Ledger` folder. All processing stays inside Obsidian, and you can review the workout context before you copy and share it.

With Obsidian Sync, enable **Sync all other types** on each device so workouts travel with your exercise notes. Use **Refresh** in the workout tab to load changes after sync and update the automatic CSV. Obsidian Sync uses the latest modified version when a JSON file has conflicting edits. Enable **Show all file types** in Files and links to see exports in Obsidian’s file explorer. See [Obsidian Sync settings](https://obsidian.md/help/sync/settings) and the [data format](docs/DATA.md).

## Install a local build

Run `npm ci` and `npm run build` with Node 22.18 or later. Copy `main.js`, `manifest.json`, and `styles.css` into `<vault>/<config-folder>/plugins/rep-journal/` (`.obsidian` is the usual config folder). Reload Obsidian, enable **Rep Journal** under **Community plugins**, and run **Open workout log** from the command palette.

Rep Journal is an early preview. Automated tests cover storage, exports, and calculations. Live testing across desktop and mobile is pending.

## Development

Run `npm run dev` to rebuild the plugin on source changes. Use a separate test vault and run `npm run lint`, `npm test`, and `npm run build` before opening a pull request. Rep Journal is licensed under [MIT](LICENSE).
