# Rep Journal

Log workouts, follow Markdown workout plans, and review exercise history in the standalone app or in Obsidian.

## Standalone app

With Node 22.18 or later, run `npm ci` and use your existing vault folder.

```sh
npm run standalone -- --vault "path/to/vault"
```

Open [Rep Journal](http://127.0.0.1:4317) in a browser on the same computer. Use `--port 4320` for a different port. The legacy `--unit kg` flag selects Metric when the vault has no saved measurement system.

**Today** groups logged sets by exercise. With **Automatic** selected, your next set starts a new session when at least one hour has passed since the latest session’s last logged set. Editing a set or saving workout notes leaves that time alone. **New workout** starts a session immediately on your next save, then resumes automatic grouping. Choose an existing session to keep adding to it until you select **Automatic** or return to Today using **Rep Journal** in the header.

Use the arrows to step through sessions or open **Calendar** to choose a date. The calendar outlines the selected date and fills today's date. On multi-session days, the calendar lists each session's exercises. The session picker and calendar also show the local times of the first and last sets when both are available. You can also log sets and notes on an earlier date and choose their session manually.

Choose **Log set** to search by exercise name or alias and filter by grouped tags. Picking a starter exercise adds its Markdown note to the vault. You can also create a custom exercise from the picker. After saving a set, the form stays open for the next one. **Use last set** fills the compatible fields from the exercise's last session.

Choose **Follow a plan** beside **Log set** on an empty day, or open **Menu → Plans** at any time. Once a plan is active, choose **Start** beside the next exercise in the plan or in the workout log to open its set form. In a superset, saving a set opens the next exercise's form. The regular **Log set** picker suggests the next exercise first, followed by the other exercises in the plan.

Save a plan under your journal folder as `Plans/YYYY/YYYY-MM-DD.md` or `Plans/YYYY/YYYY-MM-DD - Title.md` to show it automatically on that date in the workout log, including dates you open from Calendar. Plans elsewhere are available through **Follow a plan** or **Menu → Plans**.

Use **Edit set** to correct or delete a set in any session, and **Workout notes** to write or update that session's note. **Exercises** manages display names, aliases, measurements, grouped tags, and archived exercises. Edit [workout plans](docs/WORKOUT-PLANS.md) in your Markdown editor.

## Progress and export

Open Progress from a workout to expand that session's history and select its estimated 1RM when available. **Menu → Progress** starts at the latest session. The chart opens on **1Y**, or **Max** if the selected point is older. Use the range controls, select a point, or use **Previous** and **Next** to see the date, estimate and recorded set. Exercise history lists all recorded sets and keeps their logged units. Trophy badges identify the rep count that earned a record, such as **8-rep PR**. Search by exercise name or alias and filter by grouped tags. **Edit exercise** opens the exercise settings.

The 1RM chart runs locally. Obsidian embeds the svgplot WebAssembly renderer in the plugin. The standalone app serves the renderer from its local HTTP server. See [WASM source, checksum and offline verification](docs/WASM.md).

In **Menu → Export**, **Export CSV** and **Export JSON** save dated copies in the journal folder's `Exports` subfolder. The fixed `rep-journal.csv` updates when you log or edit training data. Use **Refresh automatic CSV** to update it after external changes. **Prepare workout context** previews a date-filtered snapshot for your preferred LLM. You can add a training goal, equipment, days per week, and opt in to including workout notes before copying.

### Query progress from the terminal

The progress command requires desktop Obsidian 1.12.2 or later with the native CLI installed. Enable Rep Journal in the target vault and turn on **Settings → General → Command line interface**. Use the vault's name in place of `dev-vault`. Obsidian opens if needed. [Obsidian CLI setup](https://obsidian.md/help/cli)

```sh
obsidian vault=dev-vault help rep-journal:progress
obsidian vault=dev-vault rep-journal:progress exercise="Bench Press"
obsidian vault=dev-vault rep-journal:progress exercise="Barbell Bench Press" since=2026-10-01 format=json
```

Pass an exercise name, alias, or ID. The report lists sessions newest first, with logged sets, estimated one-rep maxes where available, and the same rep-specific records as the Progress screen. The optional `since` date includes that day's sessions. Records still use the full history, including sessions before that date.

The default output is text. With `format=json`, each session includes its recorded `sets` with their original units. When available, `estimatedMax.value` uses the report's `unit` and `estimatedMax.setIndex` identifies the set behind it. Both that index and the entries in `personalRecordIndices` count from zero within the session. Scripts should check that the response parses as JSON. On Windows, Obsidian can print a plain-text error and exit with status zero.

## Obsidian plugin

**Open workout log** and the dumbbell ribbon button open Today inside Obsidian. Today follows the vault’s theme and offers the same editing, calendar, and [workout plan](docs/WORKOUT-PLANS.md) views as the standalone app. From **Exercises**, open an exercise’s Markdown note in a new tab.

Choose **Open exercise note** while logging to open the selected exercise’s Markdown note in a new tab. In **Settings → Rep Journal**, choose pounds or kilograms for new entries and estimated 1RM.

Choose **Menu → Plans** to review and start a plan. Use **Start** on the plan in the workout log to log the next planned exercise.

Use the [command-line JSON importer](docs/IMPORT.md) to bring in workouts from FitNotes or another tracker. The importer validates the file and reports errors in JSON so an LLM can help correct them.

For Garmin runs and MTB rides, select **Settings → Rep Journal → Garmin agent integration → Enable or repair** on desktop. For regular updates, make a Garmin Connect Personal API key available to your local agent. Start a fresh chat at the vault root and ask “Preview last month's Garmin runs and MTB rides in my journal.” The [freestanding prompt](prompts/rep-journal-garmin/SKILL.md) also accepts a Garmin activities CSV. [Setup and example requests](docs/IMPORT.md#garmin-connect)

## Data and sync

Choose **Measurement system** in **Obsidian Settings → Rep Journal** or **Menu → Settings** in the standalone app. The two hosts share the saved setting. **Imperial** uses pounds, miles, and feet, and **Metric** uses kilograms, kilometers, and meters. The setting controls new entries and history display. In an exercise editor, choose a specific unit for weight, distance, or elevation gain, or select **Use journal default**. For example, Rowing uses meters by default. Existing sets keep the value and unit originally recorded. The set editor shows those original units, and CSV and JSON exports preserve them.

The plugin, standalone app, and importer use the same journal folder. It defaults to `Rep Journal`. To use a different folder, set **Journal folder** in **Settings → Rep Journal** or edit `.rep-journal.json` at the vault root. Use a vault-relative path such as `Training/Rep Journal`. After editing the file directly, reload the Obsidian plugin. After any folder change, restart the standalone server and reload its browser tab.

Exercise definitions are Markdown notes in `Exercises`. New workouts are JSON files in `Workouts/YYYY`, with the year taken from the workout date. Existing workouts directly under `Workouts` remain available for reading and editing. If your records are under the former `Set Ledger` folder, set the journal folder to `Set Ledger` or move the records to your configured folder yourself.

With Obsidian Sync, enable **Sync all other types** on each device so workouts travel with your exercise notes. If a connected vault excludes JSON, Rep Journal shows a cloud warning in the journal header and its plugin settings. An open journal picks up new workout files automatically and preserves an entry you’re editing. Use **Refresh workout log** in Obsidian’s command palette to refresh manually and update the automatic CSV. Obsidian Sync uses the latest modified version when a JSON file has conflicting edits. Enable **Show all file types** in Files and links to see exports in Obsidian’s file explorer. See [Obsidian Sync settings](https://obsidian.md/help/sync/settings) and the [data format](docs/DATA.md).

## Install a local build

Run `npm ci` and `npm run build` with Node 22.18 or later. Copy `main.js`, `manifest.json`, and `styles.css` into `<vault>/<config-folder>/plugins/rep-journal/` (`.obsidian` is the usual config folder). Reload Obsidian, enable **Rep Journal** under **Community plugins**, and run **Open workout log** from the command palette.

Rep Journal is an early preview. Automated tests cover storage, exports, and calculations. Live testing across desktop and mobile is pending.

## Development

Run `npm run dev` to rebuild the plugin on source changes. Use a separate test vault and run `npm run lint`, `npm test`, and `npm run build` before opening a pull request. Rep Journal is licensed under [MIT](LICENSE).
