import { readdir, readFile } from 'node:fs/promises';
import { build, context } from 'esbuild';

const svgplot = new URL('./node_modules/svgplot-wasm/', import.meta.url);
const noticeDir = new URL('licenses/', svgplot);
const noticeFiles = ['LICENSE', ...(await readdir(noticeDir)).sort().map(name => 'licenses/' + name)];
const notices = await Promise.all(noticeFiles.map(async name => `${name}\n${await readFile(new URL(name, svgplot), 'utf8')}`));
const popoverNotice = await readFile(new URL('./node_modules/@oddbird/popover-polyfill/LICENSE', import.meta.url), 'utf8');

const options = {
  entryPoints: ['src/main.ts'],
  bundle: true,
  platform: 'browser',
  format: 'cjs',
  target: 'es2020',
  external: ['obsidian'],
  loader: { '.wasm': 'binary' },
  // The npm package is also shipped as part of the single-file Obsidian plugin.
  banner: { js: `/*! svgplot, OddBird Popover and bundled dependencies\n${[...notices, popoverNotice].join('\n').replaceAll('*/', '* /')}\n*/` },
  // The Obsidian adapter supplies bytes and a local filename before the ESM URL path is needed.
  logOverride: { 'empty-import-meta': 'silent' },
  outfile: 'main.js',
};

if (process.argv.includes('--watch')) {
  const watcher = await context({ ...options, sourcemap: 'inline' });
  await watcher.watch();
} else {
  const { metafile } = await build({ ...options, metafile: true });
  if (Object.keys(metafile.inputs).some(path => path.startsWith('scripts/') || path === 'standalone/bootstrap.ts')) {
    throw new Error('Obsidian bundle must exclude the standalone entry points and Node-only importer.');
  }
  const externalImports = Object.values(metafile.outputs).flatMap(output => output.imports)
    .filter(entry => entry.external && entry.path !== 'obsidian');
  if (externalImports.length) {
    throw new Error(`Obsidian bundle contains unsupported external imports: ${externalImports.map(entry => entry.path).join(', ')}`);
  }
}
