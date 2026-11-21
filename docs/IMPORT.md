# Import workouts from JSON

Use the command-line importer with Node 22.18 or later. FitNotes and other workout exports can be converted into the same JSON format. The conversion can run in an LLM of your choice, and Rep Journal validates the result locally.

## Import workflow

1. Get the vault’s exercise catalog. It includes existing exercise IDs, searchable aliases, and available starter exercises.

   ```sh
   npm run --silent import -- --vault "path/to/vault" --catalog
   ```

2. Give the source export, the catalog, and the format below to your LLM. Save its JSON as `workouts.json`. Ask it to preserve recorded dates, set order, values, and units. If the source leaves a date or unit unclear, resolve it before importing.
3. Run a dry run. The command prints a JSON result. For each validation error, use its `path`, `code`, and `message` to locate and correct the input. Some exercise errors also include suggestions.

   ```sh
   npm run --silent import -- --vault "path/to/vault" --input workouts.json
   ```

4. Review the result, then apply the same file. Use `--input -` to read JSON from standard input. After applying, open or refresh Rep Journal to load the workouts and update its automatic CSV.

   ```sh
   npm run --silent import -- --vault "path/to/vault" --input workouts.json --apply
   ```

### Prompt for the conversion

> Convert this export to the Rep Journal import format below. Preserve the local workout dates, session boundaries, set order, measured values, and units. Use IDs from the supplied catalog or use exact exercise names and aliases. Include an `exercises` declaration for each genuinely new exercise. If an exercise, date, or unit is ambiguous, flag it for me to resolve before producing the JSON. Once resolved, return only the import JSON.

## Input format

```json
{
  "exercises": [
    { "name": "Jump Rope", "aliases": ["Skipping"], "measurements": ["time"] }
  ],
  "workouts": [
    {
      "date": "2026-11-20",
      "sets": [
        { "exerciseName": "Military Press", "reps": 5, "load": { "value": 135, "unit": "lb" } },
        { "exerciseName": "Rowing", "durationSeconds": 108, "distance": { "value": 500, "unit": "m" } },
        { "exerciseName": "Jump Rope", "durationSeconds": 120 }
      ]
    }
  ]
}
```

- Supply the local calendar `date` as `YYYY-MM-DD`. A workout can also have `notes`, an `id`, and an ISO UTC `createdAt` such as `2026-11-20T08:30:00.000Z`. If `createdAt` is missing, the importer uses midnight UTC on the workout date as the stored timestamp.
- Each set needs an `exerciseName`, an `exerciseId` from the catalog, or both. Names and aliases match without regard to case or repeated spaces. Resolve ambiguous names by choosing an ID. A close match is a suggestion for review.
- Supply the measurements recorded for each set. `reps` is a whole number from 1 to 1000. `durationSeconds` is a positive whole number. `load` takes a `value` and `unit` (`lb` or `kg`) and defaults to `mode: "weight"`. `distance` takes a positive `value` and a `unit` (`m`, `km`, `mi`, `yd`, or `ft`). Use `mode: "assistance"` or `mode: "added"` when the source records assisted or added load.
- Use the optional `exercises` list to declare new exercises by `name`. An exercise can also supply an `id`, `aliases`, `measurements`, and `distanceUnit`. Measurement names are `weight`, `reps`, `time`, and `distance`. A declaration that resolves to an existing exercise uses its existing configuration.
- Workout, set, and new exercise IDs can be omitted. Rep Journal generates stable IDs for retries. A retry skips workouts already imported with the same ID and data. If an ID-less session matches another session’s date and ordered measurements, the importer flags it as `POSSIBLE_DUPLICATE_WORKOUT`. Use a distinct UUID when you intend to keep a separate session.

## Reading the result

A successful dry run includes `plan.workouts`, `plan.exercises`, `plan.resolvedExercises`, and `plan.skippedWorkoutIds`. Review the resolved exercise names and set counts before applying. An apply reports the files it created in `written`.

Each error shows where to look and how to fix it. An invalid weight unit produces an issue like this.

```json
{
  "code": "INVALID_WEIGHT_UNIT",
  "path": "workouts[0].sets[0].load.unit",
  "message": "Enter the original weight unit as lb or kg."
}
```

The exit status is `0` for success, `2` for invalid arguments, JSON, or import data, and `1` for filesystem or vault errors. An apply validates the full import before creating exercise or workout files. If a filesystem error stops it after some writes, review `written` and retry the same JSON after fixing the error.

If an apply returns `VAULT_IMPORT_LOCKED`, let the other apply finish and retry. An interrupted process can leave `.rep-journal-import.lock` at the vault root. Remove that file only after verifying no apply is running.
