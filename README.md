# Rep Journal

Log workouts, follow Markdown workout plans, and review exercise history in the standalone app or in Obsidian.

## Standalone app

With Node 22.18 or later, run `npm ci` and use your existing vault folder.

```sh
npm run standalone -- --vault "path/to/vault"
```

Open [Rep Journal](http://127.0.0.1:4317) in a browser on the same computer. Use `--unit kg` for kilograms or `--port 4320` for a different port.

**Today** groups logged sets by exercise. Use the arrows to step through sessions or open **Calendar** to choose a date. You can log sets and notes on an earlier date, including a day with no existing workout. When a date already has a session, choose **New workout** in the session picker to start another one.

Choose **Log set** to search by exercise name or alias and filter by grouped tags. Picking a starter exercise adds its Markdown note to the vault. You can also create a custom exercise from the picker. **Use last set** fills the compatible fields from the exercise's last session.

**Plans** opens the full Markdown plan. Once you start one, **Resume** and **View plan** are available in the banner at the bottom of Today. Sets saved through **Resume** advance supersets, and the app remembers the active plan and position for that vault.

Use **Edit set** to correct or delete a set in any session, and **Workout notes** to write or update that session's note. **Exercises** manages display names, aliases, measurements, grouped tags, and archived exercises. The app reads and saves the same files in `Rep Journal` and `Set Ledger`. Edit [workout plans](docs/WORKOUT-PLANS.md) in your Markdown editor.

## Progress and export

In either app, **Progress** lists your recorded sets by session and shows an estimated 1RM for sessions with an eligible strength set. Search by exercise name or alias and filter by grouped tags. **Edit exercise** opens the exercise settings. Historical sets keep their logged units.

**Export CSV** and **Export JSON** save dated copies in the vault's `Exports` folder under `Rep Journal` or `Set Ledger`. The fixed `rep-journal.csv` updates when you log or edit training data. Use **Refresh automatic CSV** to update it after external changes. **Prepare workout context** previews a date-filtered snapshot for your preferred LLM. You can add a training goal, equipment, days per week, and opt in to including workout notes before copying.

## Obsidian plugin

**Open workout log** and the dumbbell ribbon button open Today inside Obsidian. Today follows the vault’s theme and offers the same editing, calendar, and [workout plan](docs/WORKOUT-PLANS.md) views as the standalone app. From **Exercises**, open an exercise’s Markdown note in a new tab.

Choose **Open exercise note** while logging to open the selected exercise’s Markdown note in a new tab. In **Settings → Rep Journal**, choose pounds or kilograms for new entries and estimated 1RM.

Choose **Plans** in Today to review and start a plan. Resume it from the banner at the bottom of Today.

Use the [command-line JSON importer](docs/IMPORT.md) to bring in workouts from FitNotes or another tracker. The importer validates the file and reports errors in JSON so an LLM can help correct them.

## Data and sync

Exercise definitions are Markdown notes in `Rep Journal/Exercises`. Workouts are versioned JSON files in `Rep Journal/Workouts`. Vaults that used the Set Ledger preview can keep their existing `Set Ledger` folder. The plugin and standalone app process these files locally.

With Obsidian Sync, enable **Sync all other types** on each device so workouts travel with your exercise notes. Use **Refresh workout log** in Today’s view header to load changes after sync and update the automatic CSV. Obsidian Sync uses the latest modified version when a JSON file has conflicting edits. Enable **Show all file types** in Files and links to see exports in Obsidian’s file explorer. See [Obsidian Sync settings](https://obsidian.md/help/sync/settings) and the [data format](docs/DATA.md).

## Install a local build

Run `npm ci` and `npm run build` with Node 22.18 or later. Copy `main.js`, `manifest.json`, and `styles.css` into `<vault>/<config-folder>/plugins/rep-journal/` (`.obsidian` is the usual config folder). Reload Obsidian, enable **Rep Journal** under **Community plugins**, and run **Open workout log** from the command palette.

Rep Journal is an early preview. Automated tests cover storage, exports, and calculations. Live testing across desktop and mobile is pending.

## Development

Run `npm run dev` to rebuild the plugin on source changes. Use a separate test vault and run `npm run lint`, `npm test`, and `npm run build` before opening a pull request. Rep Journal is licensed under [MIT](LICENSE).
