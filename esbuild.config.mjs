import { build, context } from 'esbuild';

const options = {
  entryPoints: ['src/main.ts'],
  bundle: true,
  platform: 'browser',
  format: 'cjs',
  target: 'es2020',
  external: ['obsidian'],
  outfile: 'main.js',
};

if (process.argv.includes('--watch')) {
  const watcher = await context({ ...options, sourcemap: 'inline' });
  await watcher.watch();
} else {
  await build(options);
}
