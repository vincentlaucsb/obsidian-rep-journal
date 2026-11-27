import { createHash, randomUUID } from 'node:crypto';
import { readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build, context } from 'esbuild';
import ts from 'typescript';
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
  loader: { '.md': 'text' },
  plugins: [sveltePlugin],
  // The npm package is also shipped as part of the single-file Obsidian plugin.
  banner: { js: `/*! svgplot, OddBird Popover, Svelte and bundled dependencies\n${[...notices, popoverNotice, ...svelteNotices].join('\n').replaceAll('*/', '* /')}\n*/` },
  // Emscripten probes its module directory even in its single-file build.
  logOverride: { 'empty-import-meta': 'silent' },
  outfile: 'main.js',
};

const devPlugin = new URL('./dev-vault/.obsidian/plugins/rep-journal/', import.meta.url);
const staticAssets = ['manifest.json', 'styles.css'];

async function verifyOfflineBundle() {
  const bundle = await readFile(new URL('main.js', import.meta.url), 'utf8');
  const wasm = await readFile(new URL('line-engine.wasm', svgplot));
  const expected = 'c8776280e50aaef89e4c2e27a5226b68ac8799a4a99ad85ef5324f2758ccafa8';
  if (createHash('sha256').update(wasm).digest('hex') !== expected || !bundle.includes(wasm.toString('base64'))) {
    throw new Error('The plugin must embed the renderer documented in docs/WASM.md.');
  }
  // Inspect executable JS, so licenses, Markdown and embedded binary data cannot match.
  const networkNames = new Set(['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'WebTransport', 'sendBeacon', 'requestUrl']);
  const source = ts.createSourceFile('main.js', bundle, ts.ScriptTarget.Latest, false, ts.ScriptKind.JS);
  function check(node) {
    const name = ts.isIdentifier(node) ? node.text :
      ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression) ? node.argumentExpression.text : undefined;
    // Obsidian also exports request(); distinguish its property from ordinary local request variables.
    const requestMethod = ts.isPropertyAccessExpression(node) && node.name.text === 'request' ||
      ts.isElementAccessExpression(node) && name === 'request';
    if (networkNames.has(name) || requestMethod) {
      const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
      throw new Error(`Network API ${name ?? 'request'} in main.js at line ${line + 1}.`);
    }
    ts.forEachChild(node, check);
  }
  check(source);
}

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
  await verifyOfflineBundle();
  await syncDevPlugin();
}
