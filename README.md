# Rep Journal

Log workouts, follow Markdown workout plans, and review exercise history in the standalone app or in Obsidian.

## Standalone app

With Node 22.18 or later, run `npm ci` and use your existing vault folder.

```sh
npm run standalone -- --vault "path/to/vault"
```

Open [Rep Journal](http://127.0.0.1:4317) in a browser on the same computer. Use `--port 4320` for a different port. The legacy `--unit kg` flag selects Metric when the vault has no saved measurement system.

**Today** groups logged sets by exercise. Select **Rep Journal** in the pinned header to return to Today. Use the arrows to step through sessions or open **Calendar** to choose a date. You can log sets and notes on an earlier date, including a day with no existing workout. When a date already has a session, choose **New workout** in the session picker to start another one.

Choose **Log set** to search by exercise name or alias and filter by grouped tags. Picking a starter exercise adds its Markdown note to the vault. You can also create a custom exercise from the picker. **Use last set** fills the compatible fields from the exercise's last session.

Choose **Follow a plan** beside **Log set** on an empty day, or open **Menu → Plans** at any time. Once a plan is active, choose **Start** beside the next exercise in the plan or in the workout log to open its set form. Sets logged this way advance supersets. The regular **Log set** picker suggests the next exercise first, followed by the other exercises in the plan.

Save a plan under your journal folder as `Plans/YYYY/YYYY-MM-DD.md` or `Plans/YYYY/YYYY-MM-DD - Title.md` to show it automatically on that date in the workout log, including dates you open from Calendar. Plans elsewhere are available through **Follow a plan** or **Menu → Plans**.

Use **Edit set** to correct or delete a set in any session, and **Workout notes** to write or update that session's note. **Exercises** manages display names, aliases, measurements, grouped tags, and archived exercises. Edit [workout plans](docs/WORKOUT-PLANS.md) in your Markdown editor.

## Progress and export

In either app, open **Menu → Progress** to chart estimated 1RM by calendar date for sessions with an eligible strength set. It starts with the past year. Use **1W**, **1M**, **3M**, **6M**, **1Y**, or **Max** to change the chart range. Select a point or use **Previous** and **Next** to see the date, estimate and recorded set. Exercise history lists all recorded sets and keeps their logged units. Search by exercise name or alias and filter by grouped tags. **Edit exercise** opens the exercise settings.

The 1RM chart uses [svgplot-wasm](https://www.npmjs.com/package/svgplot-wasm). Obsidian bundles the renderer in the plugin and the standalone app serves it locally.

In **Menu → Export**, **Export CSV** and **Export JSON** save dated copies in the journal folder's `Exports` subfolder. The fixed `rep-journal.csv` updates when you log or edit training data. Use **Refresh automatic CSV** to update it after external changes. **Prepare workout context** previews a date-filtered snapshot for your preferred LLM. You can add a training goal, equipment, days per week, and opt in to including workout notes before copying.

## Obsidian plugin

**Open workout log** and the dumbbell ribbon button open Today inside Obsidian. Today follows the vault’s theme and offers the same editing, calendar, and [workout plan](docs/WORKOUT-PLANS.md) views as the standalone app. From **Exercises**, open an exercise’s Markdown note in a new tab.

Choose **Open exercise note** while logging to open the selected exercise’s Markdown note in a new tab. In **Settings → Rep Journal**, choose pounds or kilograms for new entries and estimated 1RM.

Choose **Menu → Plans** to review and start a plan. Use **Start** on the plan in the workout log to log the next planned exercise.

Use the [command-line JSON importer](docs/IMPORT.md) to bring in workouts from FitNotes or another tracker. The importer validates the file and reports errors in JSON so an LLM can help correct them.

## Data and sync

Choose **Measurement system** in **Obsidian Settings → Rep Journal** or **Menu → Settings** in the standalone app. The two hosts share the saved setting. **Imperial** uses pounds, miles, and feet, and **Metric** uses kilograms, kilometers, and meters. The setting controls new entries and history display. In an exercise editor, choose a specific unit for weight, distance, or elevation gain, or select **Use journal default**. For example, Rowing uses meters by default. Existing sets keep the value and unit originally recorded. The set editor shows those original units, and CSV and JSON exports preserve them.

The plugin, standalone app, and importer use the same journal folder. It defaults to `Rep Journal`. To use a different folder, set **Journal folder** in **Settings → Rep Journal** or edit `.rep-journal.json` at the vault root. Use a vault-relative path such as `Training/Rep Journal`. After editing the file directly, reload the Obsidian plugin. After any folder change, restart the standalone server and reload its browser tab.

Exercise definitions are Markdown notes in `Exercises`. New workouts are JSON files in `Workouts/YYYY`, with the year taken from the workout date. Existing workouts directly under `Workouts` remain available for reading and editing. If your records are under the former `Set Ledger` folder, set the journal folder to `Set Ledger` or move the records to your configured folder yourself.

With Obsidian Sync, enable **Sync all other types** on each device so workouts travel with your exercise notes. Run **Refresh workout log** from Obsidian’s command palette to load changes after sync and update the automatic CSV. Obsidian Sync uses the latest modified version when a JSON file has conflicting edits. Enable **Show all file types** in Files and links to see exports in Obsidian’s file explorer. See [Obsidian Sync settings](https://obsidian.md/help/sync/settings) and the [data format](docs/DATA.md).

## Install a local build

Run `npm ci` and `npm run build` with Node 22.18 or later. Copy `main.js`, `manifest.json`, and `styles.css` into `<vault>/<config-folder>/plugins/rep-journal/` (`.obsidian` is the usual config folder). Reload Obsidian, enable **Rep Journal** under **Community plugins**, and run **Open workout log** from the command palette.

Rep Journal is an early preview. Automated tests cover storage, exports, and calculations. Live testing across desktop and mobile is pending.

## Development

Run `npm run dev` to rebuild the plugin on source changes. Use a separate test vault and run `npm run lint`, `npm test`, and `npm run build` before opening a pull request. Rep Journal is licensed under [MIT](LICENSE).
