import type { FrontMatterInfo, Vault } from 'obsidian';

class MockAbstractFile {
  declare vault: Vault;
  path: string;
  name: string;
  parent: TFolder | null;

  constructor(path: string, parent: TFolder | null) {
    this.path = path;
    this.name = path.slice(path.lastIndexOf('/') + 1);
    this.parent = parent;
  }
}

export class TFile extends MockAbstractFile {
  stat = { ctime: 0, mtime: 0, size: 0 };
  basename: string;
  extension: string;

  constructor(path: string, parent: TFolder | null) {
    super(path, parent);
    const separator = this.name.lastIndexOf('.');
    this.basename = this.name.slice(0, separator);
    this.extension = this.name.slice(separator + 1);
  }
}

export class TFolder extends MockAbstractFile {
  children: Array<TFile | TFolder> = [];

  isRoot(): boolean { return this.path === '/'; }
}

// JSON objects are valid YAML. Exercise the vault and frontmatter boundaries independently of Obsidian's parser.
export function parseYaml(text: string): unknown { return text ? JSON.parse(text) : null; }
export function stringifyYaml(value: unknown): string { return JSON.stringify(value, null, 2); }

export function getFrontMatterInfo(content: string): FrontMatterInfo {
  const from = content.startsWith('---\n') ? 4 : 0;
  const end = from ? content.indexOf('\n---\n', from) : -1;
  if (end === -1) return { exists: false, frontmatter: '', from: 0, to: 0, contentStart: 0 };
  return { exists: true, frontmatter: content.slice(from, end), from, to: end + 1, contentStart: end + 5 };
}

export class MemoryVault {
  private readonly files = new Map<string, { text: string; file: TFile }>();
  private readonly folders = new Map<string, TFolder>();

  readonly adapter = {
    exists: async (path: string): Promise<boolean> => this.files.has(path) || this.folders.has(path),
    list: async (path: string): Promise<{ files: string[]; folders: string[] }> => {
      if (!this.folders.has(path)) throw new Error('Folder missing');
      return { files: [...this.files.keys()].filter((file) => this.parentPath(file) === path), folders: [] };
    },
    read: async (path: string): Promise<string> => this.entry(path).text,
    write: async (path: string, text: string): Promise<void> => { this.entry(path).text = text; },
    process: async (path: string, transform: (text: string) => string): Promise<string> => {
      const entry = this.entry(path);
      entry.text = transform(entry.text);
      return entry.text;
    },
  };

  getAbstractFileByPath(path: string): TFolder | TFile | null { return this.getFolderByPath(path) ?? this.getFileByPath(path); }
  getFileByPath(path: string): TFile | null { return path.endsWith('.md') ? this.files.get(path)?.file ?? null : null; }
  getFolderByPath(path: string): TFolder | null { return this.folders.get(path) ?? null; }
  getMarkdownFiles(): TFile[] { return [...this.files.values()].map(({ file }) => file).filter(({ extension }) => extension === 'md'); }

  async create(path: string, text: string): Promise<TFile> {
    if (this.files.has(path)) throw new Error('File exists');
    const folder = this.folders.get(this.parentPath(path));
    if (!folder) throw new Error('Folder missing');
    const file = new TFile(path, folder);
    folder.children.push(file);
    this.files.set(path, { text, file });
    return file;
  }

  async createFolder(path: string): Promise<TFolder> {
    if (this.folders.has(path)) throw new Error('Folder exists');
    const parent = this.getFolderByPath(this.parentPath(path));
    const folder = new TFolder(path, parent);
    this.folders.set(path, folder);
    parent?.children.push(folder);
    return folder;
  }

  rename(original: string, path: string): void {
    if (this.files.has(path) || this.folders.has(path)) throw new Error('Path exists');
    if (this.parentPath(original) !== this.parentPath(path)) throw new Error('Folder changed');
    const entry = this.entry(original);
    const { file } = entry;
    this.files.delete(original);
    file.path = path;
    file.name = path.slice(path.lastIndexOf('/') + 1);
    file.basename = file.name.slice(0, file.name.lastIndexOf('.'));
    this.files.set(path, entry);
  }

  cachedRead(file: TFile): Promise<string> { return this.adapter.read(file.path); }
  modify(file: TFile, text: string): Promise<void> { return this.adapter.write(file.path, text); }
  process(file: TFile, transform: (text: string) => string): Promise<string> { return this.adapter.process(file.path, transform); }

  private entry(path: string): { text: string; file: TFile } {
    const entry = this.files.get(path);
    if (!entry) throw new Error('File missing');
    return entry;
  }

  private parentPath(path: string): string { return path.slice(0, Math.max(0, path.lastIndexOf('/'))); }
}
