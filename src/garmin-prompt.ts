type FileSystem = typeof import('node:fs/promises');

const discoveryRoots = ['.agents', '.claude', '.opencode'];
const signature = /\n<!-- rep-journal-garmin sha256: ([a-f0-9]{64}) -->\n$/;

async function digest(text: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}

async function ensureDirectory(fs: FileSystem, path: string): Promise<boolean> {
  try {
    await fs.mkdir(path);
    return true;
  } catch (error: unknown) {
    if (!hasCode(error, 'EEXIST')) throw error;
    return (await fs.lstat(path)).isDirectory();
  }
}

async function installCopy(fs: FileSystem, root: string, agent: string, source: string, content: string): Promise<boolean> {
  let directory = root;
  for (const part of [agent, 'skills', 'rep-journal-garmin']) {
    directory += '/' + part;
    if (!await ensureDirectory(fs, directory)) return false;
  }
  const path = directory + '/SKILL.md';
  try {
    await fs.writeFile(path, content, { flag: 'wx' });
    return true;
  } catch (error: unknown) {
    if (!hasCode(error, 'EEXIST')) throw error;
  }
  if (!(await fs.lstat(path)).isFile()) return false;
  const existing = await fs.readFile(path, 'utf8');
  if (existing === content) return true;
  // Keep the checksum with the prompt so repair also recognizes copies synced to another device.
  const mark = signature.exec(existing);
  if (existing !== source && (!mark || await digest(existing.slice(0, mark.index)) !== mark[1])) return false;
  const temporary = path + '.' + crypto.randomUUID() + '.tmp';
  await fs.writeFile(temporary, content, { flag: 'wx' });
  try {
    if (!(await fs.lstat(path)).isFile() || await fs.readFile(path, 'utf8') !== existing) return false;
    await fs.rename(temporary, path);
    return true;
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

export async function installGarminPrompt(fs: FileSystem, vaultRoot: string, source: string): Promise<string[]> {
  const content = source + '\n<!-- rep-journal-garmin sha256: ' + await digest(source) + ' -->\n';
  const preserved: string[] = [];
  for (const agent of discoveryRoots) {
    if (!await installCopy(fs, vaultRoot, agent, source, content)) preserved.push(agent + '/skills/rep-journal-garmin');
  }
  return preserved;
}
