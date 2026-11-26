# Rep Journal data format

The vault contains the source data. `Exercises`, `Workouts`, and `Exports` live under the journal folder, which defaults to `Rep Journal`. Set **Journal folder** in the Obsidian plugin settings or create `.rep-journal.json` at the vault root with a JSON object such as `{"journalFolder":"Training/Rep Journal"}`. The Obsidian plugin, standalone app, and importer all use this setting. Use the same setting on each device.

## Exercise notes

| Property | Value |
| --- | --- |
| `set_ledger_id` | Stable UUID. Sets keep this reference when the exercise name or filename changes. |
| `set_ledger_schema` | `1` |
| `exercise_name` | Display name |
| `aliases` | Search names for the same exercise. Changing the display name in the plugin saves the previous name as an alias. |
| `exercise_measurements` | Nonempty list containing any of `weight`, `reps`, `time`, `distance`, and `elevationGain`. |
| `distance_unit` | Preferred distance entry and display unit, one of `m`, `km`, `mi`, `yd`, or `ft`. |
| `elevation_unit` | Preferred elevation gain entry and display unit, either `m` or `ft`. |
| `exercise_tags` | List of grouped labels such as `region/Upper Body`, `role/Main`, `muscles/Shoulders`, `activity/Strength`, `movement/Push`, and `custom/Home`. |
| `equipment` | Legacy text from older notes. Equipment distinctions in new notes can go in the display name, as in `Dumbbell Curl`. |
| `load_mode` | Legacy load setting. Existing `added` and `assistance` exercises keep their load semantics. Notes without `exercise_measurements` default to reps for `bodyweight` or weight and reps for other modes. |
| `weight_unit` | Legacy exercise-level unit. Rep Journal settings supply the preferred unit for new sets. |
| `archived` | Boolean. Archived exercises remain available in Progress. |

The note body can hold user notes and links. Keep the ID when changing the name or moving the file within the `Exercises` folder. Starter exercise notes are created when you choose them with **Log set**. Tags filter the pickers and work independently of set measurements and estimated 1RM.

New exercise files use readable names such as `Bench Press.md`. If a name is taken, Rep Journal adds a number. The **Tidy exercise notes** command renames the older UUID-based files through Obsidian and adds an **Exercise guides** section when a known guide or note source is available. It keeps the exercise IDs and existing note text.

An older note without `exercise_tags` shows the starter tags if its name or alias matches a single starter exercise. Saving it writes your chosen tags. An explicitly empty list stays empty.

## Workout JSON

Each session has `schemaVersion`, `id`, local `date` (`YYYY-MM-DD`), UTC `createdAt`, `notes`, and an ordered `sets` array. Several sessions can have the same date. Each set stores `id`, `exerciseId`, `exerciseName` at entry, and the measurements recorded for that set.

New sessions go under `Workouts/YYYY` using the workout date, including for backdated sessions. Filenames use `YYYY-MM-DD.json`, followed by `YYYY-MM-DD-2.json`, `YYYY-MM-DD-3.json`, and so on for the same day. Existing files for that date directly under `Workouts` or in year subfolders count toward numbering, including files with UUIDs in their names. Edits keep existing sessions in place. Session IDs stay inside the files. Devices working offline can independently pick the same filename, so sync before starting another session on a different device that day.

| Set field | Value |
| --- | --- |
| `reps` | Whole-number repetitions. |
| `load` | Weight with `mode`, `value`, and original `unit` (`lb` or `kg`). Reps-only records can use `{ "mode": "bodyweight" }`. Assisted and added loads store the positive amount assisted or added. |
| `durationSeconds` | Positive whole seconds. |
| `distance` | Positive `value` with its original `unit`. |
| `elevationGain` | Optional nonnegative `value` with its original `unit` (`m` or `ft`). Blank means absent. Zero records a measured gain of zero. |

The `warmup` flag remains in saved files and exports for compatibility. New sets store `false`, and edits preserve the original value.

Workout files that use only the original reps and load shape retain schema version `1`. Adding time, distance, elevation gain, or a set without both reps and load advances that file to schema version `2`. Version `2` can contain both old and new set shapes. Editing a recorded measurement uses its original unit and precision. Enable **Elevation gain** on an exercise to add it when logging a set or editing a set with no elevation recorded. Clear the field in the set editor to remove the measurement.

The log, last session, and Progress display distance in the exercise's preferred unit to two decimal places at most, and elevation gain to whole units when a preferred unit is set. With no exercise preference, the journal displays the recorded value and unit. New entries default to meters when a preference is absent.

## Analytics and exports

- Rep Journal updates `Exports/rep-journal.csv` in the active journal folder in the background. It refreshes when you open or refresh the journal, add, edit, or delete a set, or save an exercise definition. Manual exports create dated copies. If source records cannot be read, the last complete export stays in place. The journal reports any export error. To retry, run **Refresh workout log** from Obsidian’s command palette or select **Refresh automatic CSV** in the standalone app’s Export view.
- Exercise history and workout context use the best estimate per session from sets of 1–10 reps with a positive external weight. Weighted singles use their recorded load. For 2–10 reps, estimates use `weight × (1 + reps / 30)` after converting to the app's weight unit.
- CSV uses one row per set, ordered by session and set order. Optional measurements have empty cells when absent. After `duration_seconds`, `distance_value`, and `distance_unit`, CSV includes `elevation_gain_value` and `elevation_gain_unit`. All measurements use their recorded values and units. Exercise names resolve to the current exercise when available, with the set's recorded name as a fallback. Values that could be interpreted as spreadsheet formulas are escaped. Use JSON for exact text.
- JSON contains the exercise properties and workout records with IDs, units, and workout notes. The export schema is `2` and includes the original version for each workout record. The Markdown body of an exercise note lives in the vault. Keep the vault files for a complete backup of those notes.
- Workout context includes selected dates, all logged sets on those dates, and exercise summaries. Workout notes are opt-in. Copying contextualizes the selected data for an LLM you use separately.

Unreadable records, unsupported schemas, and duplicate record IDs are listed in the workout tab. Resolve the listed files and refresh before exporting a complete dataset.
