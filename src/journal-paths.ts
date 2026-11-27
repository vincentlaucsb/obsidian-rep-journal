import { isId, isRecord, type Exercise } from './model.ts';

import { isMeasurementSystem, type MeasurementSystem } from './units.ts';

export const journalFolder = 'Rep Journal';
export const journalSettingsFile = '.rep-journal.json';

export function isWorkoutFilePath(path: string, root: string): boolean {
  const folder = `${root}/Workouts/`;
  return path.startsWith(folder) && /^(?:\d{4}\/)?[^/]+\.json$/.test(path.slice(folder.length));
}

const windowsDevice = /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i;

export function normalizeJournalFolder(value: string): string {
  const path = value.trim().replace(/\\/g, '/');
  if (path.split('/').some((part) => !part || /^[. ]/.test(part) || /[. ]$/.test(part) ||
      /[<>:"|?*#[\]\p{Cc}]/u.test(part) || windowsDevice.test(part))) {
    throw new Error('Enter a vault-relative folder path with valid folder names.');
  }
  return path;
}

export function parseJournalSettings(text: string): Record<string, unknown> {
  const settings: unknown = JSON.parse(text);
  if (!isRecord(settings)) throw new Error('Expected a journal settings object.');
  return settings;
}

export function parseJournalFolder(text: string): string {
  return readJournalFolder(parseJournalSettings(text));
}

export function readJournalFolder(settings: Record<string, unknown>): string {
  const value = settings.journalFolder;
  if (value === undefined) return journalFolder;
  if (typeof value !== 'string') throw new Error('The journal folder setting must be a string.');
  return normalizeJournalFolder(value);
}

export function readMeasurementSystem(settings: Record<string, unknown>, fallback: MeasurementSystem): MeasurementSystem {
  const value = settings.measurementSystem;
  return isMeasurementSystem(value) ? value : fallback;
}

export function exerciseFilename(exercise: Pick<Exercise, 'name'>, number = 1): string {
  const name = exercise.name.replace(/[<>:"/\\|?*#[\]\p{Cc}]+/gu, ' ').replace(/\s+/g, ' ')
    .replace(/^[. ]+|[. ]+$/g, '') || 'Exercise';
  const basename = windowsDevice.test(name) ? `Exercise - ${name}` : name;
  return `${basename}${number > 1 ? ` (${number})` : ''}.md`;
}

export function hasLegacyExerciseFilename(path: string, exercise: Exercise): boolean {
  const filename = path.slice(path.lastIndexOf('/') + 1);
  const suffix = `-${exercise.id}.md`;
  return filename.endsWith(suffix) && /^[\p{L}\p{N}-]+$/u.test(filename.slice(0, -suffix.length));
}

export function workoutFilename(date: string, session: bigint): string {
  return session === 1n ? `${date}.json` : `${date}-${session}.json`;
}

export function nextWorkoutSession(date: string, paths: readonly string[]): bigint {
  let count = 0n;
  let latest = 0n;
  for (const path of paths) {
    const filename = path.slice(path.lastIndexOf('/') + 1);
    if (filename === workoutFilename(date, 1n)) {
      count++;
      continue;
    }
    if (!filename.startsWith(`${date}-`) || !filename.endsWith('.json')) continue;
    const suffix = filename.slice(date.length + 1, -5);
    if (isId(suffix)) {
      count++;
    } else if (/^[1-9]\d*$/.test(suffix)) {
      count++;
      const session = BigInt(suffix);
      if (session > latest) latest = session;
    }
  }
  return (latest > count ? latest : count) + 1n;
}
