import type { DataAdapter, Vault } from 'obsidian';
import { errorMessage } from '../model.ts';

type Section = 'Exercises' | 'Workouts' | 'Exports';

export type LedgerVault = Pick<Vault, 'cachedRead' | 'create' | 'createFolder' | 'getAbstractFileByPath' |
  'getFileByPath' | 'getFolderByPath' | 'modify' | 'process'> & {
  adapter: Pick<DataAdapter, 'exists' | 'list' | 'process' | 'read' | 'write'>;
};

export function isRecordPath(path: string, root: string, section: Section): boolean {
  return path.startsWith(`${root}/${section}/`);
}

export function uniqueRecords<T extends { path: string }>(records: T[], idFor: (record: T) => string, issues: string[]): T[] {
  const groups = new Map<string, T[]>();
  for (const record of records) {
    const id = idFor(record);
    const group = groups.get(id) ?? [];
    group.push(record);
    groups.set(id, group);
  }
  const result: T[] = [];
  for (const group of groups.values()) {
    if (group.length === 1) {
      result.push(group[0]);
    } else {
      issues.push(`Duplicate record ID in ${group.map((record) => record.path).join(', ')}`);
    }
  }
  return result;
}

export async function readRecords<T>(paths: string[], read: (path: string) => Promise<T | null>, issues: string[]): Promise<T[]> {
  const records: T[] = [];
  for (let start = 0; start < paths.length; start += 24) {
    const batch = paths.slice(start, start + 24);
    const results = await Promise.allSettled(batch.map(read));
    for (const [index, result] of results.entries()) {
      if (result.status === 'rejected') {
        issues.push(`${batch[index]}: ${errorMessage(result.reason)}`);
      } else if (result.value !== null) {
        records.push(result.value);
      }
    }
  }
  return records;
}

export async function ensureFolder(vault: LedgerVault, path: string): Promise<string> {
  let directory = '';
  for (const part of path.split('/')) {
    directory = directory ? `${directory}/${part}` : part;
    if (vault.getFolderByPath(directory)) continue;
    try {
      await vault.createFolder(directory);
    } catch (error: unknown) {
      if (!vault.getFolderByPath(directory)) throw error;
    }
  }
  return path;
}
