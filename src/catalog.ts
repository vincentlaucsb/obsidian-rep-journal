import {
  isRecord, nameKey, readExercise, tagKey,
  type DistanceUnit, type Exercise, type ExerciseChoice, type ExerciseTag, type Measurement, type TagGroup,
} from './model.ts';

interface Starter {
  id: string;
  name: string;
  measurements: Measurement[];
  aliases?: string[];
  distanceUnit?: DistanceUnit;
  tags: Partial<Record<TagGroup, string[]>>;
}

const starters: Starter[] = [
  { id: '00000001-7928-4ede-89bb-09c8eeec466e', name: 'Bench Press', aliases: ['Barbell Bench Press'], measurements: ['weight', 'reps'],
    tags: { region: ['Upper Body'], muscles: ['Chest', 'Triceps'], role: ['Main'], activity: ['Strength'], movement: ['Push'] } },
  { id: '00000002-7928-4ede-89bb-09c8eeec466e', name: 'Overhead Press', aliases: ['Military Press', 'Shoulder Press', 'OHP'], measurements: ['weight', 'reps'],
    tags: { region: ['Upper Body'], muscles: ['Shoulders', 'Triceps'], role: ['Main'], activity: ['Strength'], movement: ['Push'] } },
  { id: '00000003-7928-4ede-89bb-09c8eeec466e', name: 'Face Pull', aliases: ['Face Pulls'], measurements: ['weight', 'reps'],
    tags: { region: ['Upper Body'], muscles: ['Shoulders'], role: ['Auxiliary'], activity: ['Strength'], movement: ['Pull'] } },
  { id: '00000004-7928-4ede-89bb-09c8eeec466e', name: 'Dumbbell Curl', aliases: ['Dumbbell Curls'], measurements: ['weight', 'reps'],
    tags: { region: ['Upper Body'], muscles: ['Biceps'], role: ['Auxiliary'], activity: ['Strength'], movement: ['Pull'] } },
  { id: '00000005-7928-4ede-89bb-09c8eeec466e', name: 'Romanian Deadlift', aliases: ['RDL'], measurements: ['weight', 'reps'],
    tags: { region: ['Lower Body'], muscles: ['Hamstrings', 'Glutes'], role: ['Main'], activity: ['Strength'], movement: ['Hinge'] } },
  { id: '00000006-7928-4ede-89bb-09c8eeec466e', name: 'Barbell Squat', aliases: ['Back Squat', 'Squat'], measurements: ['weight', 'reps'],
    tags: { region: ['Lower Body'], muscles: ['Quads', 'Glutes'], role: ['Main'], activity: ['Strength'], movement: ['Squat'] } },
  { id: '00000007-7928-4ede-89bb-09c8eeec466e', name: 'Pull-up', aliases: ['Pull-ups', 'Pull Up'], measurements: ['reps'],
    tags: { region: ['Upper Body'], muscles: ['Back', 'Biceps'], role: ['Main'], activity: ['Strength'], movement: ['Pull'] } },
  { id: '00000008-7928-4ede-89bb-09c8eeec466e', name: 'Push-up', aliases: ['Push-ups', 'Push Up'], measurements: ['reps'],
    tags: { region: ['Upper Body'], muscles: ['Chest', 'Triceps'], role: ['Auxiliary'], activity: ['Strength'], movement: ['Push'] } },
  { id: '00000009-7928-4ede-89bb-09c8eeec466e', name: 'Plank', measurements: ['time'],
    tags: { region: ['Full Body'], muscles: ['Abs'], role: ['Auxiliary'], activity: ['Strength'] } },
  { id: '0000000a-7928-4ede-89bb-09c8eeec466e', name: 'Farmer’s Carry', aliases: ["Farmer's Carry", 'Farmer Walk'], measurements: ['weight', 'distance'],
    tags: { region: ['Full Body'], role: ['Auxiliary'], activity: ['Strength'], movement: ['Carry'] } },
  { id: '0000000b-7928-4ede-89bb-09c8eeec466e', name: 'Walking Lunge', aliases: ['Walking Lunges'], measurements: ['reps', 'distance'],
    tags: { region: ['Lower Body'], muscles: ['Quads', 'Glutes'], role: ['Auxiliary'], activity: ['Strength'], movement: ['Lunge'] } },
  { id: '0000000c-7928-4ede-89bb-09c8eeec466e', name: 'Rowing', aliases: ['Rowing Machine', 'Erg'], measurements: ['time', 'distance'],
    tags: { region: ['Full Body'], role: ['Main'], activity: ['Cardio'], movement: ['Pull'] } },
  { id: '0000000d-7928-4ede-89bb-09c8eeec466e', name: 'Running', aliases: ['Run', 'Treadmill Run'], measurements: ['time', 'distance'], distanceUnit: 'mi',
    tags: { region: ['Lower Body'], role: ['Main'], activity: ['Cardio'] } },
  { id: '0000000e-7928-4ede-89bb-09c8eeec466e', name: 'Band Pull-apart', aliases: ['Band Pull-aparts'], measurements: ['reps'],
    tags: { region: ['Upper Body'], muscles: ['Shoulders'], role: ['Warm-up'], activity: ['Strength'], movement: ['Pull'] } },
  { id: '0000000f-7928-4ede-89bb-09c8eeec466e', name: 'Hip Flexor Stretch', measurements: ['time'],
    tags: { region: ['Lower Body'], role: ['Warm-up'], activity: ['Mobility'] } },
];

export function starterExercises(existing: readonly ExerciseChoice[]): ExerciseChoice[] {
  const ids = new Set(existing.map(({ id }) => id));
  const names = new Set(existing.flatMap((exercise) => [exercise.name, ...exercise.aliases]).map(nameKey));
  return starters
    .filter(({ id, name, aliases = [] }) => !ids.has(id) && ![name, ...aliases].some((value) => names.has(nameKey(value))))
    .map(({ id, name, measurements, aliases = [], distanceUnit = 'm', tags }) => ({
      id, name, measurements, aliases, distanceUnit,
      tags: Object.entries(tags).flatMap(([group, values]) => values.map((value) => ({ group: group as TagGroup, name: value }))),
      archived: false, equipment: '', loadMode: measurements.includes('weight') ? 'weight' : 'bodyweight',
      unit: 'lb', starter: true,
    }));
}

export function readCatalogExercise(value: unknown): Exercise | null {
  const exercise = readExercise(value);
  if (!exercise || !isRecord(value) || Object.prototype.hasOwnProperty.call(value, 'exercise_tags')) return exercise;

  const names = [exercise.name, ...exercise.aliases];
  const matches = starterExercises([]).filter((starter) => names.some((name) => matchesExerciseName(starter, name, true)));
  return matches.length === 1 ? { ...exercise, tags: matches[0].tags } : exercise;
}

export function matchesTags(exercise: ExerciseChoice, selected: ReadonlySet<string>): boolean {
  if (!selected.size) return true;
  const keys = new Set(exercise.tags.map(tagKey));
  return [...selected].every((key) => keys.has(key));
}

export function matchesExerciseName(exercise: ExerciseChoice, query: string, exact = false): boolean {
  const search = nameKey(query);
  const names = [exercise.name, ...exercise.aliases];
  if (exact) return names.some((name) => nameKey(name) === search);
  return [...names, exercise.equipment].some((name) => nameKey(name).includes(search));
}

export function suggestExercises(query: string, exercises: Iterable<ExerciseChoice>): ExerciseChoice[] {
  const key = nameKey(query);
  const limit = Math.max(1, Math.min(3, Math.floor(key.length / 4)));
  const ranked: Array<{ exercise: ExerciseChoice; distance: number }> = [];
  for (const exercise of exercises) {
    let distance = Infinity;
    for (const name of [exercise.name, ...exercise.aliases].map(nameKey)) {
      if (Math.abs(name.length - key.length) <= limit) distance = Math.min(distance, editDistance(key, name));
      if (key.length >= 4 && name.includes(key)) distance = Math.min(distance, limit);
    }
    if (distance <= limit) ranked.push({ exercise, distance });
  }
  return ranked.sort((a, b) => a.distance - b.distance || a.exercise.name.localeCompare(b.exercise.name))
    .slice(0, 5).map(({ exercise }) => exercise);
}

function editDistance(from: string, to: string): number {
  let previous = Array.from({ length: to.length + 1 }, (_, index) => index);
  for (let row = 1; row <= from.length; row++) {
    const next = [row];
    for (let column = 1; column <= to.length; column++) {
      next.push(Math.min(previous[column] + 1, next[column - 1] + 1,
        previous[column - 1] + (from[row - 1] === to[column - 1] ? 0 : 1)));
    }
    previous = next;
  }
  return previous[to.length];
}

export function pickerTags(exercises: readonly ExerciseChoice[]): ExerciseTag[] {
  const tags = new Map<string, ExerciseTag>();
  for (const exercise of exercises) {
    for (const tag of exercise.tags) tags.set(tagKey(tag), tag);
  }
  return [...tags.values()].sort((a, b) => a.name.localeCompare(b.name));
}
