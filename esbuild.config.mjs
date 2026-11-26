import { randomUUID } from 'node:crypto';
import { readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build, context } from 'esbuild';
import { svelteNotices, sveltePlugin } from './scripts/svelte-esbuild.ts';

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
  external: ['obsidian', 'node:fs/promises'],
  loader: { '.wasm': 'binary', '.md': 'text' },
  plugins: [sveltePlugin],
  // The npm package is also shipped as part of the single-file Obsidian plugin.
  banner: { js: `/*! svgplot, OddBird Popover, Svelte and bundled dependencies\n${[...notices, popoverNotice, ...svelteNotices].join('\n').replaceAll('*/', '* /')}\n*/` },
  // The Obsidian adapter supplies bytes and a local filename before the ESM URL path is needed.
  logOverride: { 'empty-import-meta': 'silent' },
  outfile: 'main.js',
};

const devPlugin = new URL('./dev-vault/.obsidian/plugins/rep-journal/', import.meta.url);
const staticAssets = ['manifest.json', 'styles.css'];

async function syncDevPlugin() {
  const directory = await stat(devPlugin).catch(error => {
    if (error.code !== 'ENOENT') throw error;
  });
  if (!directory?.isDirectory()) return;
  for (const name of [...staticAssets, 'main.js']) {
    const destination = new URL(name, devPlugin);
    const contents = await readFile(new URL(name, import.meta.url));
    const previous = await readFile(destination).catch(error => {
      if (error.code !== 'ENOENT') throw error;
    });
    if (previous?.equals(contents)) continue;
    const temporary = new URL('.' + name + '-' + randomUUID() + '.tmp', devPlugin);
    try {
      await writeFile(temporary, contents, { flag: 'wx' });
      await rename(temporary, destination);
    } finally {
      await rm(temporary, { force: true });
    }
  }
}

if (process.argv.includes('--watch')) {
  const watchDevPlugin = {
    name: 'watch-dev-vault',
    setup(build) {
      build.onResolve({ filter: /main\.ts$/ }, args => {
        if (args.kind !== 'entry-point') return;
        return {
          path: fileURLToPath(new URL('./src/main.ts', import.meta.url)),
          watchFiles: staticAssets.map(name => fileURLToPath(new URL(name, import.meta.url))),
        };
      });
      build.onEnd(async result => {
        if (!result.errors.length) await syncDevPlugin();
      });
    },
  };
  const watcher = await context({ ...options, plugins: [...options.plugins, watchDevPlugin], sourcemap: 'inline' });
  await watcher.watch();
} else {
  const { metafile } = await build({ ...options, metafile: true });
  if (Object.keys(metafile.inputs).some(path => path.startsWith('scripts/') || path === 'standalone/bootstrap.ts')) {
    throw new Error('Obsidian bundle must exclude the standalone entry points and Node-only importer.');
  }
  const externalImports = Object.values(metafile.outputs).flatMap(output => output.imports)
    .filter(entry => entry.external && entry.path !== 'obsidian' && entry.path !== 'node:fs/promises');
  if (externalImports.length) {
    throw new Error(`Obsidian bundle contains unsupported external imports: ${externalImports.map(entry => entry.path).join(', ')}`);
  }
  await syncDevPlugin();
}
