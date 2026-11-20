# Rep Journal data format

The vault contains the source data. Files under `Rep Journal/Exports` are snapshots. The plugin reads records from `Exercises` and `Workouts` under `Rep Journal` and the earlier `Set Ledger` folder. Existing records are edited in place. New files go under `Rep Journal` when it exists or when starting with an empty vault. A vault with only the earlier folder continues writing there.

## Exercise notes

| Property | Value |
| --- | --- |
| `set_ledger_id` | Stable UUID. Sets keep this reference when the exercise name or filename changes. |
| `set_ledger_schema` | `1` |
| `exercise_name` | Display name |
| `aliases` | Optional list of search aliases |
| `equipment` | Optional text |
| `load_mode` | `weight`, `bodyweight`, `added`, or `assistance` |
| `weight_unit` | Default entry unit, `lb` or `kg` |
| `archived` | Boolean. Archived exercises remain available in Progress. |

The note body can hold user notes and links. The exercise editor updates the properties. Keep the ID when changing the name or moving the file within the `Exercises` folder. The schema retains the `set_ledger` property names so existing exercise notes can be read unchanged.

## Workout JSON

Each session has `schemaVersion`, `id`, local `date` (`YYYY-MM-DD`), UTC `createdAt`, `notes`, and an ordered `sets` array. Several sessions can have the same date. Each set stores `id`, `exerciseId`, `exerciseName` (at entry), integer `reps`, `warmup`, and `load`.

`load` is `{ "mode": "bodyweight" }` for bodyweight-only sets. Other modes store `mode`, the recorded numeric `value`, and `unit`. For `added` and `assistance`, the value is the positive amount added or assisted. The type and recorded unit travel with each set when the exercise default changes.

## Analytics and exports

- The chart shows the best eligible estimate per session. Weighted singles use their recorded load. For 2–10 reps, estimates use `weight × (1 + reps / 30)` after converting to the chart unit. Warm-ups, unweighted, assisted, and added-weight sets are excluded. A recorded single does not imply a tested maximum.
- CSV uses one row per set, ordered by session and set order. Load and unit are empty for bodyweight-only sets. Exercise names resolve to the current exercise when available, with the set's recorded name as a fallback. Values that could be interpreted as spreadsheet formulas are escaped. Use JSON for exact text.
- JSON contains the exercise properties and workout records with IDs, units, and workout notes. The Markdown body of an exercise note lives in the vault. Keep the vault files for a complete backup of those notes.
- Workout context includes selected dates, recorded working sets, and exercise summaries. Workout notes are opt-in. Copying contextualizes the selected data for an LLM you use separately.

Unreadable records, unsupported schemas, and duplicate record IDs are listed in the workout tab. Resolve the listed files and refresh before exporting a complete dataset.
