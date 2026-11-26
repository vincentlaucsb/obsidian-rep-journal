import { journalSettingsFile, parseJournalSettings } from './journal-paths.ts';
import { isRecord } from './model.ts';

export async function writeDesktopJournalSettings(
  fs: Pick<typeof import('node:fs/promises'), 'open' | 'lstat' | 'readFile' | 'rename' | 'unlink'>,
  path: string, changes: Record<string, unknown>, nonce: string,
): Promise<void> {
  const lockPath = `${path}.lock`;
  const lock = await fs.open(lockPath, 'wx').catch((error: unknown) => {
    if (isRecord(error) && error.code === 'EEXIST') {
      throw new Error('Journal settings are being saved. If the error persists after closing Obsidian and stopping the standalone server, ' +
        `remove ${journalSettingsFile}.lock at the vault root and try again.`);
    }
    throw error;
  });
  const temporary = `${path}.${nonce}.tmp`;
  try {
    await lock.close();
    const stat = await fs.lstat(path).catch((error: unknown) => {
      if (isRecord(error) && error.code === 'ENOENT') return;
      throw error;
    });
    if (stat && !stat.isFile()) throw new Error(`Expected a file at ${journalSettingsFile}.`);
    const settings = stat ? parseJournalSettings(await fs.readFile(path, 'utf8')) : {};
    const staging = await fs.open(temporary, 'wx');
    try {
      try {
        await staging.writeFile(`${JSON.stringify({ ...settings, ...changes }, null, 2)}\n`);
      } finally {
        await staging.close();
      }
      await fs.rename(temporary, path);
    } finally {
      await fs.unlink(temporary).catch(() => undefined);
    }
  } finally {
    await fs.unlink(lockPath);
  }
}
