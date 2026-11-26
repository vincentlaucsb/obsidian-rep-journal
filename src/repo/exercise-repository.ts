import { getFrontMatterInfo, parseYaml, stringifyYaml, TFile, TFolder, type TAbstractFile } from 'obsidian';
import { readCatalogExercise } from '../catalog.ts';
import { appendExerciseGuides } from '../exercise-guides.ts';
import { exerciseFilename, hasLegacyExerciseFilename } from '../journal-paths.ts';
import {
  combineAliases, errorMessage, exerciseFrontmatter, exerciseUnitFields, isRecord, makeId, nameKey, readExercise,
  type Exercise, type ExerciseDetails, type ExerciseNote,
} from '../model.ts';
import { ensureFolder, isRecordPath, readRecords, uniqueRecords, type LedgerVault } from './vault-records.ts';

export function affectsExerciseNotes(file: TAbstractFile, root: string, path = file.path): boolean {
  if (file instanceof TFile) return isRecordPath(path, root, 'Exercises') && path.endsWith('.md');
  const folder = `${root}/Exercises`;
  return file instanceof TFolder && (path === folder || folder.startsWith(`${path}/`) || path.startsWith(`${folder}/`));
}

function noteProperties(text: string): unknown {
  const info = getFrontMatterInfo(text);
  return info.exists ? parseYaml(info.frontmatter) : null;
}

export class ExerciseRepository {
  private readonly vault: LedgerVault;
  private readonly root: string;

  constructor(vault: LedgerVault, root: string) {
    this.vault = vault;
    this.root = root;
  }

  async saveStarter(starter: Exercise): Promise<ExerciseNote> {
    const names = new Set([starter.name, ...starter.aliases].map(nameKey));
    const exercises = await this.read();
    const existing = exercises.find((exercise) =>
      exercise.id === starter.id || [exercise.name, ...exercise.aliases].some((name) => names.has(nameKey(name))));
    if (existing) return existing;
    try {
      return await this.saveExercise(starter, undefined, starter.id);
    } catch (error: unknown) {
      const updated = await this.read();
      const saved = updated.find((exercise) => exercise.id === starter.id);
      if (saved) return saved;
      throw error;
    }
  }

  async saveExercise(details: ExerciseDetails, original?: ExerciseNote, id = original?.id ?? makeId()): Promise<ExerciseNote> {
    const aliases = combineAliases(details.name, details.aliases, original?.name);
    const properties = exerciseFrontmatter({ ...details, id, aliases });
    const exercise = readExercise(properties);
    if (!exercise) throw new Error('Invalid exercise properties.');
    if (!original) {
      const markdown = appendExerciseGuides(`---\n${stringifyYaml(properties).trimEnd()}\n---\n`, exercise);
      return this.createExerciseNote(exercise, markdown);
    }

    const { path, ...before } = original;
    const file = this.vault.getFileByPath(path);
    if (!file || !isRecordPath(file.path, this.root, 'Exercises')) throw new Error('The exercise note moved. Refresh and try again.');
    await this.vault.process(file, (text) => {
      const info = getFrontMatterInfo(text);
      const current: unknown = parseYaml(info.frontmatter);
      if (!info.exists || !isRecord(current) || JSON.stringify(readCatalogExercise(current)) !== JSON.stringify(before)) {
        throw new Error('The exercise changed. Refresh and try again.');
      }
      const updated = { ...current, ...properties };
      for (const key of exerciseUnitFields) if (!(key in properties)) delete updated[key];
      const yaml = stringifyYaml(updated).trimEnd();
      return `${text.slice(0, info.from)}${yaml}\n${text.slice(info.to)}`;
    });
    return { ...exercise, path: file.path };
  }

  async tidyExerciseNotes(renameFile: (file: TFile, path: string) => Promise<void>): Promise<{
    renamed: number; guidesAdded: number; issues: string[];
  }> {
    const issues: string[] = [];
    const exercises = await this.read(issues);
    let renamed = 0;
    let guidesAdded = 0;
    for (const exercise of exercises) {
      const file = this.vault.getFileByPath(exercise.path);
      if (!file) {
        issues.push(`${exercise.path}: Exercise note moved while loading.`);
        continue;
      }
      try {
        if (hasLegacyExerciseFilename(file.path, exercise)) {
          const folder = file.path.slice(0, file.path.lastIndexOf('/'));
          const existing = await this.exerciseEntries(folder);
          for (let number = 1; ; number++) {
            const path = `${folder}/${exerciseFilename(exercise, number)}`;
            if (existing.has(path.toLowerCase()) || await this.vault.adapter.exists(path)) continue;
            try {
              await renameFile(file, path);
              renamed++;
              break;
            } catch (error: unknown) {
              if (!await this.vault.adapter.exists(path)) throw error;
            }
          }
        }
        if (await this.addGuideLinks(file, exercise)) guidesAdded++;
      } catch (error: unknown) {
        issues.push(`${file.path}: ${errorMessage(error)}`);
      }
    }
    return { renamed, guidesAdded, issues };
  }

  async read(issues: string[] = [], readText = (file: TFile) => this.vault.cachedRead(file)): Promise<ExerciseNote[]> {
    const paths = this.paths();
    const exercises = await readRecords(paths, async (path) => {
      const file = this.vault.getFileByPath(path);
      if (!file) throw new Error('Exercise note moved while loading.');
      const exercise = readCatalogExercise(noteProperties(await readText(file)));
      return exercise ? { ...exercise, path } : null;
    }, issues);
    return uniqueRecords(exercises, (exercise) => exercise.id, issues).sort((a, b) => a.name.localeCompare(b.name));
  }

  private async exerciseEntries(folder: string): Promise<Map<string, string>> {
    const { files, folders } = await this.vault.adapter.list(folder);
    return new Map([...files, ...folders].map((path) => [path.toLowerCase(), path]));
  }

  private async createExerciseNote(exercise: Exercise, markdown: string): Promise<ExerciseNote> {
    const folder = await ensureFolder(this.vault, `${this.root}/Exercises`);
    const existing = await this.exerciseEntries(folder);
    for (let number = 1; ; number++) {
      const path = `${folder}/${exerciseFilename(exercise, number)}`;
      const occupied = existing.get(path.toLowerCase());
      if (!occupied && !await this.vault.adapter.exists(path)) {
        try {
          await this.vault.create(path, markdown);
          return { ...exercise, path };
        } catch (error: unknown) {
          if (!await this.vault.adapter.exists(path)) throw error;
        }
      }
      const file = this.vault.getFileByPath(occupied ?? path);
      if (!file) continue;
      const properties = noteProperties(await this.vault.cachedRead(file));
      if (!isRecord(properties) || properties.set_ledger_id !== exercise.id) continue;
      const current = readCatalogExercise(properties);
      if (current) return { ...current, path: file.path };
    }
  }

  private async addGuideLinks(file: TFile, exercise: Exercise): Promise<boolean> {
    const withGuides = (text: string): string => {
      const properties = noteProperties(text);
      const current = readCatalogExercise(properties);
      if (!current || current.id !== exercise.id || !isRecord(properties)) {
        throw new Error('The exercise note changed. Retry the cleanup.');
      }
      return appendExerciseGuides(text, current, properties.sources);
    };
    const text = await this.vault.cachedRead(file);
    if (withGuides(text) === text) return false;
    let added = false;
    await this.vault.process(file, (current) => {
      const updated = withGuides(current);
      added = updated !== current;
      return updated;
    });
    return added;
  }

  paths(): string[] {
    const path = `${this.root}/Exercises`;
    const folder = this.vault.getAbstractFileByPath(path);
    if (!folder) return [];
    if (!(folder instanceof TFolder)) throw new Error(`Expected a folder at ${path}.`);
    const paths: string[] = [];
    const pending = [folder];
    while (pending.length) {
      const next = pending.pop();
      for (const item of next?.children ?? []) {
        if (item instanceof TFolder) pending.push(item);
        if (item instanceof TFile && item.extension === 'md') paths.push(item.path);
      }
    }
    return paths.sort();
  }
}
