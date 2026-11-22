import { readFile } from 'node:fs/promises';
import type { Plugin } from 'esbuild';
import { compile } from 'svelte/compiler';

const licensePaths = ['svelte/LICENSE.md', 'esm-env/LICENSE'];
export const svelteNotices = await Promise.all(licensePaths.map(async (path) => {
  const license = await readFile(new URL(`../node_modules/${path}`, import.meta.url), 'utf8');
  return `${path}\n${license}`.replace(/\*\//g, '* /');
}));

export const sveltePlugin: Plugin = {
  name: 'svelte',
  setup(build) {
    build.onLoad({ filter: /\.svelte$/ }, async ({ path }) => {
      const source = await readFile(path, 'utf8');
      const { js, warnings } = compile(source, { filename: path, generate: 'client' });
      return {
        contents: js.code,
        warnings: warnings.map(({ message, start }) => ({
          text: message,
          location: start && { file: path, line: start.line, column: start.column },
        })),
        watchFiles: [path],
      };
    });
  },
};
