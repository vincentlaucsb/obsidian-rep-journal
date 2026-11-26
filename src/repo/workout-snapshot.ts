import { compareWorkouts, type LedgerData, type WorkoutFile } from '../model.ts';

export type RecordRevisions = Map<string, string | undefined>;

export interface DiskFileStat {
  dev: bigint;
  ino: bigint;
  ctimeNs: bigint;
  mtimeNs: bigint;
  size: bigint;
  isFile(): boolean;
}

export type StatDiskFile = (path: string) => Promise<DiskFileStat | undefined>;

export function diskFileRevision({ dev, ino, ctimeNs, mtimeNs, size }: DiskFileStat): string {
  return `${dev}:${ino}:${ctimeNs}:${mtimeNs}:${size}`;
}

export interface WorkoutSnapshot {
  data: LedgerData;
  revisions: RecordRevisions;
}

export function ledgerWithCommittedWorkout(data: LedgerData, saved: WorkoutFile): LedgerData | undefined {
  if (data.issues.length) return;
  const workouts = data.workouts.filter(({ path }) => path !== saved.path);
  if (workouts.some(({ workout }) => workout.id === saved.workout.id)) return;
  workouts.push(saved);
  workouts.sort((a, b) => compareWorkouts(a.workout, b.workout));
  return { ...data, workouts };
}

export async function unchangedRecords(
  paths: readonly string[], revisions: RecordRevisions, committedPath: string,
  revision: (path: string) => string | undefined | Promise<string | undefined>,
): Promise<boolean> {
  const expectedCount = revisions.size + Number(!revisions.has(committedPath));
  if (paths.length !== expectedCount || !paths.includes(committedPath)) return false;
  const unchanged = paths.filter((path) => path !== committedPath);
  if (unchanged.some((path) => revisions.get(path) === undefined)) return false;
  for (let start = 0; start < unchanged.length; start += 24) {
    const batch = unchanged.slice(start, start + 24);
    const matches = await Promise.all(batch.map(async (path) => await revision(path) === revisions.get(path)));
    if (matches.includes(false)) return false;
  }
  return true;
}
