---
name: rep-journal-garmin
description: Preview or import Garmin Connect runs and mountain bike rides, or fill missing elevation gain on imported rides, in a local Rep Journal vault.
---

# Sync Garmin activities with Rep Journal

Use the requested vault, date range, and source. Run local commands from the Rep Journal checkout with Node 22.18+ and its npm dependencies installed. Ask for the checkout or vault path if the location is unclear. Pass the vault root to the importer even when the journal uses a custom folder.

Check `csvzall --version`, or invoke the executable at a user-supplied path. If it is missing, ask the user to install the csvzall CLI for their platform or provide the path to their installed binary. Resume when the command works. [csvzall build and install instructions](https://github.com/vincentlaucsb/csvzall#building)

## Read the requested activities

For regular updates, default to the Garmin Personal API. Check whether the agent process has access to `GARMIN_PERSONAL_API_KEY` without printing its value. Guide the user through setting it up locally if needed. Reuse the key for future syncs and exchange it for a fresh access token when needed. Honor an explicit CSV request without checking credentials.

- **Garmin Connect.** Use a Personal API key made available locally, for example through `GARMIN_PERSONAL_API_KEY`. If needed, direct the user to **Garmin Connect web → Profile & Account → Settings → Personal API Key → Create Key**. Keep the key and bearer token out of chat, command output, and vault files. Exchange the key for a token using Garmin's documented token endpoint. Use the activity search endpoint with `startDate`, `endDate`, `start`, and `limit`. Page through the entire requested range and deduplicate overlapping pages by activity ID. Report an incomplete fetch before attempting an import. [Authentication](https://developer.garmin.com/gc-developer-program/personal/personal-faq/) · [Activity search](https://developer.garmin.com/gc-developer-program/personal/swagger-docs/)
- **Garmin CSV.** Use the provided activities summary export. To obtain one, open **Activities → All Activities** on Garmin Connect web, load the desired history, and choose **Export CSV**. Inspect its actual headers, activity types, duration format, and distance units with `csvzall head -n 5 "Activities.csv"`. Ask for the Garmin display units if the export omits them. A CSV import works offline. [Garmin export instructions](https://support.garmin.com/en-US/?faq=W1TvTPW8JZ6LfJSfK512Q8)

For API results, flatten the fetched activity list using `csvzall json extract activities.json --map map.json`. For a top-level array a minimal map is `{"rows":"$[*]","columns":{"id":"$.activityId","type":"$.activityType.typeKey","date":"$.startTimeLocal","utc":"$.startTimeGMT","duration":"$.duration","distance":"$.distance"}}`. Inspect the returned shape and units. For either source, use `csvzall sql query --csv activities.csv --sql "SELECT * FROM data"` with a predicate on the actual type column to select running and its subtypes, and rides explicitly recorded as mountain biking. Omit road rides, generic cycling, and unrelated activities. Keep intermediate files in a local temporary directory.

## Prepare the journal import

Read the exercise catalog with `npm run --silent import -- --vault "<vault>" --catalog`. Map each activity to one workout containing one set. Reuse the catalog's Running and Mountain Biking entries or their exact aliases. If Mountain Biking is new, declare it once. A ride with a recorded time, distance, and elevation gain has this import shape.

```json
{
  "exercises": [{"name": "Mountain Biking", "measurements": ["time", "distance", "elevationGain"]}],
  "workouts": [{
    "date": "2026-06-10",
    "sets": [{"exerciseName": "Mountain Biking", "durationSeconds": 3600, "distance": {"value": 18.4, "unit": "km"}, "elevationGain": {"value": 385.5, "unit": "m"}}]
  }]
}
```

Use the activity's local calendar date, recorded timer duration rounded to whole seconds, and positive distance in its recorded unit (`m`, `km`, or `mi`). Preserve a known UTC start in `createdAt` as ISO UTC with milliseconds. Omit unavailable measurements and flag entries with no usable measurements or unresolved units.

For mountain bike rides, look for the activity's recorded elevation gain or total ascent in the actual source fields. Preserve the value and unit (`m` or `ft`), including a recorded zero. Verify elevation units independently of distance units and omit gain when either the value or its unit is unavailable.

When an activity ID is available, add its Garmin activity URL to workout `notes`. Calculate the lowercase workout `id` as UUIDv5 in the standard URL namespace over the exact string `https://connect.garmin.com/modern/activity/<decimal-activity-id>`. This keeps the ID stable across agents and overlapping imports. Omit set IDs. For a CSV row without a Garmin ID, omit the workout ID and let the importer check for duplicates. When combining sources, compare dates, starts, and measurements against existing sessions before assigning explicit IDs. Flag ambiguous matches for review.

## Preview and apply

Save the payload as UTF-8 JSON and run the existing importer with absolute paths.

```sh
npm run --silent import -- --vault "<vault>" --input "<workouts.json>"
```

Report the target vault, date range, run and ride counts, existing workouts skipped, and any excluded or ambiguous rows. A preview request ends here. For an authorized import, add `--apply` to the same command after a successful dry run and report the actual counts from `written` and `plan.skippedWorkoutIds`. Refresh the workout log in Rep Journal to see the sessions and regenerate its CSV.

On `WORKOUT_ID_CONFLICT`, identify the changed Garmin activity and corresponding journal workout for review. A matching ID with changed data requires reconciliation. Preserve the existing session and its ID. On `POSSIBLE_DUPLICATE_WORKOUT`, identify the candidate match before importing that row.

## Fill elevation gain on existing rides

For a backfill, prepare a separate payload using only explicit mountain bike rides with reliable activity IDs and recorded elevation gain. Read IDs from the API or from a Garmin Connect activity URL. Keep the ID as a decimal string and preserve the recorded gain and unit.

```json
{"activities": [{"activityId": "123456789", "elevationGain": {"value": 385.5, "unit": "m"}}]}
```

Run `npm run --silent import -- --vault "<vault>" --backfill-garmin-elevation --input "<garmin-ascent.json>"`. Report each outcome from `plan.activities`, including any missing workouts or sets, ineligible exercises, and conflicts. For an authorized apply, use the same payload with `--apply` and report `written.workouts`. The command fills empty elevation fields on matching Garmin rides and refreshes the automatic CSV. Report rides with missing or unmatched IDs for review.
