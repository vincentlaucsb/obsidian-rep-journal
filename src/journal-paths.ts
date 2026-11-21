import { isId, type Exercise } from './model.ts';

export const journalFolder = 'Rep Journal';
export const legacyFolder = 'Set Ledger';
export const journalFolders = [journalFolder, legacyFolder] as const;

export function exerciseFilename(exercise: Pick<Exercise, 'name'>, number = 1): string {
  const name = exercise.name.replace(/[<>:"/\\|?*#[\]\p{Cc}]+/gu, ' ').replace(/\s+/g, ' ')
    .replace(/^[. ]+|[. ]+$/g, '') || 'Exercise';
  const basename = /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(name) ? `Exercise - ${name}` : name;
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
